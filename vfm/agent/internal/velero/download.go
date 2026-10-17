package velero

import (
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"syscall"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"

	"github.com/shubhambatra/velero-fe/vfm/agent/internal/dispatch"
	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
)

var downloadRequests = schema.GroupVersionResource{
	Group: "velero.io", Version: "v1", Resource: "downloadrequests",
}

// ChunkSize is the most data one LogChunk carries (PLAN.md §6, logs.proto).
const ChunkSize = 64 * 1024

// DefaultMaxBytes bounds a download when the command names no limit, and
// HardMaxBytes bounds it whatever the command says: the control plane is not
// trusted to protect the agent's memory or the customer's bandwidth.
const (
	DefaultMaxBytes int64 = 16 << 20
	HardMaxBytes    int64 = 64 << 20
)

// dnsSubdomain is what Kubernetes accepts as an object name.
var dnsSubdomain = regexp.MustCompile(`^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$`)

// downloadKinds maps the protocol's kinds to Velero's DownloadRequest target
// kinds. BackupContents is absent on purpose: backup data is not proxied through
// the control plane (PLAN.md §7.3, P2).
var downloadKinds = map[pb.DownloadTargetKind]string{
	pb.DownloadTargetKind_DOWNLOAD_TARGET_KIND_BACKUP_LOG:                          "BackupLog",
	pb.DownloadTargetKind_DOWNLOAD_TARGET_KIND_BACKUP_VOLUME_SNAPSHOTS:             "BackupVolumeSnapshots",
	pb.DownloadTargetKind_DOWNLOAD_TARGET_KIND_BACKUP_ITEM_OPERATIONS:              "BackupItemOperations",
	pb.DownloadTargetKind_DOWNLOAD_TARGET_KIND_BACKUP_RESOURCE_LIST:                "BackupResourceList",
	pb.DownloadTargetKind_DOWNLOAD_TARGET_KIND_BACKUP_RESULTS:                      "BackupResults",
	pb.DownloadTargetKind_DOWNLOAD_TARGET_KIND_RESTORE_LOG:                         "RestoreLog",
	pb.DownloadTargetKind_DOWNLOAD_TARGET_KIND_RESTORE_RESULTS:                     "RestoreResults",
	pb.DownloadTargetKind_DOWNLOAD_TARGET_KIND_RESTORE_RESOURCE_LIST:               "RestoreResourceList",
	pb.DownloadTargetKind_DOWNLOAD_TARGET_KIND_RESTORE_ITEM_OPERATIONS:             "RestoreItemOperations",
	pb.DownloadTargetKind_DOWNLOAD_TARGET_KIND_CSI_BACKUP_VOLUME_SNAPSHOTS:         "CSIBackupVolumeSnapshots",
	pb.DownloadTargetKind_DOWNLOAD_TARGET_KIND_CSI_BACKUP_VOLUME_SNAPSHOT_CONTENTS: "CSIBackupVolumeSnapshotContents",
	pb.DownloadTargetKind_DOWNLOAD_TARGET_KIND_BACKUP_VOLUME_INFOS:                 "BackupVolumeInfos",
	pb.DownloadTargetKind_DOWNLOAD_TARGET_KIND_RESTORE_VOLUME_INFO:                 "RestoreVolumeInfo",
}

// DownloadHandler implements `FetchDownload`: it creates a DownloadRequest, waits
// for Velero to sign a URL, fetches the (gzip) file **from inside the cluster**,
// where object storage is usually reachable, decompresses it and streams it to
// the control plane as LogChunks keyed by the command id.
type DownloadHandler struct {
	Dynamic   dynamic.Interface
	Namespace string
	// HTTP fetches the signed URL. Its transport must not decompress for us.
	HTTP *http.Client
	// Send queues a message for the control plane; false means the queue is full.
	Send  func(*pb.AgentMessage) bool
	NewID func() string

	PollInterval time.Duration
	// SendTimeout is how long a chunk may wait for room in the outbound queue.
	SendTimeout time.Duration
}

// Handle is a [dispatch.Handler].
func (h *DownloadHandler) Handle(ctx context.Context, cmd *pb.Command) *pb.CommandResult {
	req := cmd.GetFetchDownload()
	kind, ok := downloadKinds[req.GetTargetKind()]
	switch {
	case !ok:
		return invalid("this kind of download is not available through the control plane")
	case !dnsSubdomain.MatchString(req.GetTargetName()):
		return invalid("the target name is not a valid Kubernetes object name")
	}
	limit := req.GetMaxBytes()
	if limit <= 0 {
		limit = DefaultMaxBytes
	}
	limit = min(limit, HardMaxBytes)

	resource := h.Dynamic.Resource(downloadRequests).Namespace(h.Namespace)
	obj, err := h.ensureRequest(ctx, resource, cmd, kind, req.GetTargetName())
	if err != nil {
		return h.describe(ctx, err)
	}
	// Own context: ctx may have ended, and a stale request left in the customer's
	// cluster is the worse failure.
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = resource.Delete(cleanup, obj.GetName(), metav1.DeleteOptions{})
	}()

	signed, failure := h.waitForURL(ctx, resource, obj.GetName())
	if failure != nil {
		return failure
	}
	return h.stream(ctx, cmd.GetCommandId(), signed, limit)
}

func invalid(message string) *pb.CommandResult {
	return &pb.CommandResult{ErrorCode: pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT, ErrorMessage: message}
}

func (h *DownloadHandler) ensureRequest(ctx context.Context, resource dynamic.ResourceInterface, cmd *pb.Command, kind, target string) (*unstructured.Unstructured, error) {
	existing, err := resource.List(ctx, metav1.ListOptions{LabelSelector: LabelCommandID + "=" + cmd.GetCommandId()})
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
	id := strings.ReplaceAll(cmd.GetCommandId(), "-", "")
	obj := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "velero.io/v1",
		"kind":       "DownloadRequest",
		"metadata": map[string]any{
			"name":        "vfm-" + id[:min(12, len(id))],
			"namespace":   h.Namespace,
			"labels":      toAny(labels),
			"annotations": map[string]any{AnnotationManaged: "true"},
		},
		"spec": map[string]any{"target": map[string]any{"kind": kind, "name": target}},
	}}
	created, err := resource.Create(ctx, obj, metav1.CreateOptions{})
	if apierrors.IsAlreadyExists(err) {
		return resource.Get(ctx, obj.GetName(), metav1.GetOptions{})
	}
	return created, err
}

func (h *DownloadHandler) waitForURL(ctx context.Context, resource dynamic.ResourceInterface, name string) (string, *pb.CommandResult) {
	interval := h.PollInterval
	if interval <= 0 {
		interval = 500 * time.Millisecond
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		current, err := resource.Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return "", h.describe(ctx, err)
		}
		if phase, _, _ := unstructured.NestedString(current.Object, "status", "phase"); phase == "Processed" {
			signed, _, _ := unstructured.NestedString(current.Object, "status", "downloadURL")
			if signed == "" {
				return "", &pb.CommandResult{ErrorCode: pb.ErrorCode_ERROR_CODE_NOT_FOUND,
					ErrorMessage: "Velero processed the request but produced no file; the backup or restore may not have one yet"}
			}
			return signed, nil
		}
		select {
		case <-ctx.Done():
			return "", dispatch.ContextFailure(ctx)
		case <-ticker.C:
		}
	}
}

// refusedAddress is true for the addresses a signed URL must never lead to: the agent's own
// host, link-local space (which is where cloud metadata services live) and addresses that are
// not a destination at all. Private ranges stay allowed, because object storage inside a
// customer's network (MinIO, Ceph) is a legitimate place for a backup location.
func refusedAddress(ip net.IP) bool {
	// Something that is not an address names no destination.
	if len(ip) != net.IPv4len && len(ip) != net.IPv6len {
		return true
	}
	if v4 := ip.To4(); v4 != nil {
		ip = v4
	}
	return ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsMulticast() || ip.IsUnspecified() || ip.Equal(net.IPv4bcast)
}

// safeDownloadClient is the only HTTP client that fetches a signed URL.
//
// The URL comes from a DownloadRequest that Velero fills in from a BackupStorageLocation,
// and who may write one is a control-plane decision, so the address it names is not trusted.
// The check is made in the dialer on the address actually connected to, which also defeats a
// name that resolves to something harmless first and something else later. Redirects are not
// followed: a redirect is a second destination that nothing checked.
func safeDownloadClient(refuse func(net.IP) bool) *http.Client {
	dialer := &net.Dialer{
		Timeout: 30 * time.Second,
		Control: func(_, address string, _ syscall.RawConn) error {
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return errRefusedAddress
			}
			if ip := net.ParseIP(host); ip == nil || refuse(ip) {
				return errRefusedAddress
			}
			return nil
		},
	}
	return &http.Client{
		Transport: &http.Transport{
			DisableCompression: true,
			// A proxy is chosen by the cluster's owner (the environment), not by the control plane.
			Proxy:       http.ProxyFromEnvironment,
			DialContext: dialer.DialContext,
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

var errRefusedAddress = errors.New("the download address is not allowed")

// stream fetches signedURL, decompresses it and sends it in chunks. The URL is
// never logged or reported: it is a credential until it expires.
func (h *DownloadHandler) stream(ctx context.Context, commandID, signedURL string, limit int64) *pb.CommandResult {
	parsed, err := url.Parse(signedURL)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Host == "" {
		return &pb.CommandResult{ErrorCode: pb.ErrorCode_ERROR_CODE_INTERNAL, ErrorMessage: "Velero returned a download address that is not an http(s) URL"}
	}
	client := h.HTTP
	if client == nil {
		client = safeDownloadClient(refusedAddress)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, signedURL, nil)
	if err != nil {
		return &pb.CommandResult{ErrorCode: pb.ErrorCode_ERROR_CODE_INTERNAL, ErrorMessage: "could not prepare the download"}
	}
	resp, err := client.Do(httpReq)
	if err != nil {
		if ctx.Err() != nil {
			return dispatch.ContextFailure(ctx)
		}
		// The error text contains the signed URL: say only that it failed.
		return &pb.CommandResult{ErrorCode: pb.ErrorCode_ERROR_CODE_KUBE_API_ERROR, ErrorMessage: "the agent could not reach the object storage to fetch the file"}
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusNotFound {
		return &pb.CommandResult{ErrorCode: pb.ErrorCode_ERROR_CODE_NOT_FOUND, ErrorMessage: "the file is not in the object storage"}
	}
	if resp.StatusCode != http.StatusOK {
		return &pb.CommandResult{ErrorCode: pb.ErrorCode_ERROR_CODE_KUBE_API_ERROR,
			ErrorMessage: fmt.Sprintf("the object storage refused the download (HTTP %d)", resp.StatusCode)}
	}

	body, closeBody, err := decompress(resp.Body)
	if err != nil {
		return &pb.CommandResult{ErrorCode: pb.ErrorCode_ERROR_CODE_INTERNAL, ErrorMessage: "the downloaded file is not valid gzip"}
	}
	defer closeBody()

	sum := sha256.New()
	var sent int64
	var sequence uint64
	buf := make([]byte, ChunkSize)
	// One byte beyond the limit is enough to know it was exceeded.
	limited := io.LimitReader(body, limit+1)
	for {
		n, readErr := io.ReadFull(limited, buf)
		if n > 0 {
			sent += int64(n)
			if sent > limit {
				return invalid(fmt.Sprintf("the file is larger than the %d byte limit", limit))
			}
			sum.Write(buf[:n])
			if !h.sendChunk(ctx, commandID, sequence, buf[:n], false) {
				return h.sendFailure(ctx)
			}
			sequence++
		}
		if readErr == nil {
			continue
		}
		if errors.Is(readErr, io.EOF) || errors.Is(readErr, io.ErrUnexpectedEOF) {
			break
		}
		if ctx.Err() != nil {
			return dispatch.ContextFailure(ctx)
		}
		return &pb.CommandResult{ErrorCode: pb.ErrorCode_ERROR_CODE_KUBE_API_ERROR, ErrorMessage: "the download was interrupted"}
	}
	// The end marker is its own empty chunk so that an exact multiple of the chunk size needs no special case.
	if !h.sendChunk(ctx, commandID, sequence, nil, true) {
		return h.sendFailure(ctx)
	}
	return &pb.CommandResult{Ok: true, Detail: &pb.CommandResult_Download{Download: &pb.DownloadSummary{
		BytesSent: sent,
		Sha256Hex: hex.EncodeToString(sum.Sum(nil)),
	}}}
}

// decompress returns the uncompressed body. Velero stores these files gzipped; a
// body without the gzip signature is passed through, so a store that already
// decoded it on the way out still works.
func decompress(r io.Reader) (io.Reader, func(), error) {
	peek := make([]byte, 2)
	n, err := io.ReadFull(r, peek)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return nil, nil, err
	}
	joined := io.MultiReader(strings.NewReader(string(peek[:n])), r)
	if n == 2 && peek[0] == 0x1f && peek[1] == 0x8b {
		zr, err := gzip.NewReader(joined)
		if err != nil {
			return nil, nil, err
		}
		return zr, func() { _ = zr.Close() }, nil
	}
	return joined, func() {}, nil
}

func (h *DownloadHandler) sendChunk(ctx context.Context, commandID string, sequence uint64, data []byte, eof bool) bool {
	msg := &pb.AgentMessage{
		MessageId: h.NewID(),
		Payload: &pb.AgentMessage_LogChunk{LogChunk: &pb.LogChunk{
			Origin:   &pb.LogChunk_CommandId{CommandId: commandID},
			Sequence: sequence,
			Data:     append([]byte(nil), data...),
			Eof:      eof,
		}},
	}
	timeout := h.SendTimeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	deadline := time.Now().Add(timeout)
	for !h.Send(msg) {
		// The queue is full: wait for the connection to drain it rather than lose a chunk.
		if ctx.Err() != nil || time.Now().After(deadline) {
			return false
		}
		time.Sleep(10 * time.Millisecond)
	}
	return true
}

func (h *DownloadHandler) sendFailure(ctx context.Context) *pb.CommandResult {
	if ctx.Err() != nil {
		return dispatch.ContextFailure(ctx)
	}
	return &pb.CommandResult{ErrorCode: pb.ErrorCode_ERROR_CODE_TIMEOUT, ErrorMessage: "the connection to the control plane was too slow to carry the file"}
}

func (h *DownloadHandler) describe(ctx context.Context, err error) *pb.CommandResult {
	switch {
	case ctx.Err() != nil:
		return dispatch.ContextFailure(ctx)
	case apierrors.IsNotFound(err), meta.IsNoMatchError(err):
		return &pb.CommandResult{ErrorCode: pb.ErrorCode_ERROR_CODE_NOT_FOUND,
			ErrorMessage: fmt.Sprintf("Velero's DownloadRequest resource was not found; is Velero installed in namespace %q?", h.Namespace)}
	case apierrors.IsForbidden(err):
		return &pb.CommandResult{ErrorCode: pb.ErrorCode_ERROR_CODE_KUBE_API_ERROR,
			ErrorMessage: "the agent is not permitted to manage DownloadRequests in the Velero namespace"}
	default:
		return &pb.CommandResult{ErrorCode: pb.ErrorCode_ERROR_CODE_KUBE_API_ERROR,
			ErrorMessage: "the Kubernetes API returned an error"}
	}
}
