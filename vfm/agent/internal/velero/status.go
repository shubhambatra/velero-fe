// Package velero holds the agent's operations on Velero's own resources.
//
// It talks to Velero through the dynamic client, so the agent does not link
// Velero's API types until the inventory work of M3 needs them. Every object the
// agent creates carries the labels and annotation of PLAN.md §5.4, which is what
// makes creation idempotent across a restart and every object traceable to the
// command and user that caused it.
package velero

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"

	"github.com/shubhambatra/velero-fe/vfm/agent/internal/dispatch"
	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
)

// Labels and annotation stamped on everything the agent creates (PLAN.md §5.4).
const (
	LabelCommandID    = "vfm.io/command-id"
	LabelRequestedBy  = "vfm.io/requested-by"
	AnnotationManaged = "vfm.io/managed"
)

// ServerStatusRequests is Velero's resource for asking the server about itself.
var serverStatusRequests = schema.GroupVersionResource{
	Group: "velero.io", Version: "v1", Resource: "serverstatusrequests",
}

const maxPlugins = 100

// labelValue is what Kubernetes accepts as a label value.
var labelValue = regexp.MustCompile(`^([A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?)?$`)

// StatusHandler implements `RefreshServerStatus`: it creates a
// ServerStatusRequest, waits for Velero to process it, reads the server version
// and plugins, and removes the request.
type StatusHandler struct {
	Dynamic   dynamic.Interface
	Namespace string
	// PollInterval is how often the request is re-read while waiting.
	PollInterval time.Duration
	Now          func() time.Time
}

// Handle is a [dispatch.Handler].
func (h *StatusHandler) Handle(ctx context.Context, cmd *pb.Command) *pb.CommandResult {
	resource := h.Dynamic.Resource(serverStatusRequests).Namespace(h.Namespace)

	obj, err := h.ensureRequest(ctx, resource, cmd)
	if err != nil {
		return h.describe(ctx, err)
	}
	// Cleanup uses its own context: ctx may already have ended, and leaving
	// objects behind in the customer's cluster is the worse failure.
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = resource.Delete(cleanup, obj.GetName(), metav1.DeleteOptions{})
	}()

	interval := h.PollInterval
	if interval <= 0 {
		interval = 500 * time.Millisecond
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		current, err := resource.Get(ctx, obj.GetName(), metav1.GetOptions{})
		if err != nil {
			return h.describe(ctx, err)
		}
		if phase, _, _ := unstructured.NestedString(current.Object, "status", "phase"); phase == "Processed" {
			return h.result(current)
		}
		select {
		case <-ctx.Done():
			return dispatch.ContextFailure(ctx)
		case <-ticker.C:
		}
	}
}

// ensureRequest returns the request for this command, creating it unless one
// already exists. Looking first by label is what makes a re-run after an agent
// restart not create a second object (PLAN.md §5.4).
func (h *StatusHandler) ensureRequest(ctx context.Context, resource dynamic.ResourceInterface, cmd *pb.Command) (*unstructured.Unstructured, error) {
	selector := LabelCommandID + "=" + cmd.GetCommandId()
	existing, err := resource.List(ctx, metav1.ListOptions{LabelSelector: selector})
	if err != nil {
		return nil, err
	}
	if len(existing.Items) > 0 {
		return &existing.Items[0], nil
	}

	labels := map[string]string{LabelCommandID: cmd.GetCommandId()}
	if by := cmd.GetRequestedBy(); by != "" && labelValue.MatchString(by) {
		labels[LabelRequestedBy] = by
	}
	obj := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "velero.io/v1",
		"kind":       "ServerStatusRequest",
		"metadata": map[string]any{
			"name":        "vfm-" + strings.ReplaceAll(cmd.GetCommandId(), "-", "")[:min(12, len(strings.ReplaceAll(cmd.GetCommandId(), "-", "")))],
			"namespace":   h.Namespace,
			"labels":      toAny(labels),
			"annotations": map[string]any{AnnotationManaged: "true"},
		},
		"spec": map[string]any{},
	}}
	created, err := resource.Create(ctx, obj, metav1.CreateOptions{})
	if apierrors.IsAlreadyExists(err) {
		// Another replica or an earlier attempt won the race.
		return resource.Get(ctx, obj.GetName(), metav1.GetOptions{})
	}
	return created, err
}

func toAny(in map[string]string) map[string]any {
	out := make(map[string]any, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

func (h *StatusHandler) result(obj *unstructured.Unstructured) *pb.CommandResult {
	version, _, _ := unstructured.NestedString(obj.Object, "status", "serverVersion")
	items, _, _ := unstructured.NestedSlice(obj.Object, "status", "plugins")

	status := &pb.ServerStatus{ServerVersion: version, ProcessedAt: timestamppb.New(h.now())}
	if processed, _, _ := unstructured.NestedString(obj.Object, "status", "processedTimestamp"); processed != "" {
		if t, err := time.Parse(time.RFC3339, processed); err == nil {
			status.ProcessedAt = timestamppb.New(t)
		}
	}
	for _, item := range items {
		if len(status.Plugins) >= maxPlugins {
			break
		}
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		name, _ := m["name"].(string)
		kind, _ := m["kind"].(string)
		status.Plugins = append(status.Plugins, &pb.PluginInfo{Name: name, Kind: kind})
	}
	return &pb.CommandResult{Ok: true, Detail: &pb.CommandResult_ServerStatus{ServerStatus: status}}
}

func (h *StatusHandler) now() time.Time {
	if h.Now != nil {
		return h.Now()
	}
	return time.Now()
}

// describe turns a Kubernetes error into a typed result, without the raw API
// body: it can name objects or contain details the control plane has no use for.
func (h *StatusHandler) describe(ctx context.Context, err error) *pb.CommandResult {
	switch {
	case ctx.Err() != nil:
		return dispatch.ContextFailure(ctx)
	case apierrors.IsNotFound(err), meta.IsNoMatchError(err):
		return &pb.CommandResult{ErrorCode: pb.ErrorCode_ERROR_CODE_NOT_FOUND,
			ErrorMessage: fmt.Sprintf("Velero's ServerStatusRequest resource was not found; is Velero installed in namespace %q?", h.Namespace)}
	case apierrors.IsForbidden(err):
		return &pb.CommandResult{ErrorCode: pb.ErrorCode_ERROR_CODE_KUBE_API_ERROR,
			ErrorMessage: "the agent is not permitted to manage ServerStatusRequests in the Velero namespace"}
	case errors.Is(err, context.DeadlineExceeded):
		return &pb.CommandResult{ErrorCode: pb.ErrorCode_ERROR_CODE_TIMEOUT, ErrorMessage: "the Kubernetes API did not answer in time"}
	default:
		return &pb.CommandResult{ErrorCode: pb.ErrorCode_ERROR_CODE_KUBE_API_ERROR,
			ErrorMessage: "the Kubernetes API returned an error"}
	}
}
