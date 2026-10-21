package velero

import (
	"context"
	"fmt"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"

	"github.com/shubhambatra/velero-fe/vfm/agent/internal/dispatch"
	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
)

// MaxNamespacesChecked bounds one request: each name costs one API call.
const MaxNamespacesChecked = 100

var namespaceName = dnsLabel()

// NamespaceChecker implements `CheckNamespaces`: for each name asked about, does that
// namespace exist now? It reads one namespace at a time and returns **only** the names
// it was given, so a caller who may touch some namespaces learns nothing about the others.
type NamespaceChecker struct {
	Client kubernetes.Interface
}

// Check is a [dispatch.Handler].
func (h *NamespaceChecker) Check(ctx context.Context, cmd *pb.Command) *pb.CommandResult {
	names := cmd.GetCheckNamespaces().GetNames()
	if len(names) > MaxNamespacesChecked {
		return invalid(fmt.Sprintf("at most %d namespaces can be checked at once", MaxNamespacesChecked))
	}
	seen := map[string]bool{}
	report := &pb.NamespaceReport{}
	for _, name := range names {
		if !namespaceName.MatchString(name) {
			return invalid("a namespace name is not valid")
		}
		if seen[name] {
			continue
		}
		seen[name] = true

		ns, err := h.Client.CoreV1().Namespaces().Get(ctx, name, metav1.GetOptions{})
		switch {
		case err == nil:
			report.Namespaces = append(report.Namespaces, &pb.NamespaceState{
				Name: name, Exists: true, Terminating: ns.Status.Phase == corev1.NamespaceTerminating,
			})
		case apierrors.IsNotFound(err):
			report.Namespaces = append(report.Namespaces, &pb.NamespaceState{Name: name})
		case ctx.Err() != nil:
			return dispatch.ContextFailure(ctx)
		case apierrors.IsForbidden(err):
			return &pb.CommandResult{ErrorCode: pb.ErrorCode_ERROR_CODE_KUBE_API_ERROR, ErrorMessage: "the agent is not permitted to read namespaces"}
		default:
			return &pb.CommandResult{ErrorCode: pb.ErrorCode_ERROR_CODE_KUBE_API_ERROR, ErrorMessage: "the Kubernetes API returned an error"}
		}
	}
	return &pb.CommandResult{Ok: true, Detail: &pb.CommandResult_Namespaces{Namespaces: report}}
}
