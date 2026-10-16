package velero

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	clienttesting "k8s.io/client-go/testing"

	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
)

func newDownloadClient() *dynamicfake.FakeDynamicClient {
	return dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(),
		map[schema.GroupVersionResource]string{downloadRequests: "DownloadRequestList"})
}

func gz(t *testing.T, data []byte) []byte {
	t.Helper()
	var b bytes.Buffer
	w := gzip.NewWriter(&b)
	if _, err := w.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// store is a fake object store serving one body, standing in for S3 or MinIO.
func store(t *testing.T, status int, body []byte) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(status)
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// veleroProcesses makes the fake behave like Velero: after `gets` reads the
// request is Processed and carries the signed URL.
func veleroProcesses(c *dynamicfake.FakeDynamicClient, gets int32, signed string) {
	var n atomic.Int32
	c.PrependReactor("get", "downloadrequests", func(action clienttesting.Action) (bool, runtime.Object, error) {
		ga := action.(clienttesting.GetAction)
		obj, err := c.Tracker().Get(downloadRequests, ga.GetNamespace(), ga.GetName())
		if err != nil {
			return true, nil, err
		}
		u := obj.(*unstructured.Unstructured).DeepCopy()
		if n.Add(1) > gets {
			_ = unstructured.SetNestedField(u.Object, "Processed", "status", "phase")
			if signed != "" {
				_ = unstructured.SetNestedField(u.Object, signed, "status", "downloadURL")
			}
		}
		return true, u, nil
	})
}

type sink struct {
	mu     sync.Mutex
	chunks []*pb.LogChunk
	refuse atomic.Int32
}

func (s *sink) send(msg *pb.AgentMessage) bool {
	if s.refuse.Add(-1) >= 0 {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if c := msg.GetLogChunk(); c != nil {
		s.chunks = append(s.chunks, c)
	}
	return true
}

func (s *sink) data() []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []byte
	for _, c := range s.chunks {
		out = append(out, c.GetData()...)
	}
	return out
}

func fetchCmd(kind pb.DownloadTargetKind, name string, max int64) *pb.Command {
	return &pb.Command{CommandId: cmdID, RequestedBy: "0194f9d2-0000-7000-8000-0000000000aa",
		Op: &pb.Command_FetchDownload{FetchDownload: &pb.FetchDownload{TargetKind: kind, TargetName: name, MaxBytes: max}}}
}

func downloader(c *dynamicfake.FakeDynamicClient, s *sink) *DownloadHandler {
	return &DownloadHandler{Dynamic: c, Namespace: "velero", Send: s.send, NewID: func() string { return "m" },
		PollInterval: 5 * time.Millisecond, SendTimeout: time.Second}
}

const backupLog = pb.DownloadTargetKind_DOWNLOAD_TARGET_KIND_BACKUP_LOG

func TestStreamsTheDecompressedFileInOrderAndSealsItWithAChecksum(t *testing.T) {
	body := []byte(strings.Repeat("time=\"2026-10-16T01:00:00Z\" level=info msg=\"backed up\"\n", 5000)) // > 4 chunks
	srv := store(t, 200, gz(t, body))
	c, s := newDownloadClient(), &sink{}
	veleroProcesses(c, 2, srv.URL+"/log.gz?X-Amz-Signature=secret")

	res := downloader(c, s).Handle(context.Background(), fetchCmd(backupLog, "nightly-1", 0))

	if !res.GetOk() {
		t.Fatalf("not ok: %v %s", res.GetErrorCode(), res.GetErrorMessage())
	}
	if !bytes.Equal(s.data(), body) {
		t.Fatalf("reassembled %d bytes, want %d", len(s.data()), len(body))
	}
	sum := sha256.Sum256(body)
	if got := res.GetDownload(); got.GetBytesSent() != int64(len(body)) || got.GetSha256Hex() != hex.EncodeToString(sum[:]) {
		t.Fatalf("summary %v", got)
	}
	for i, ch := range s.chunks {
		if ch.GetCommandId() != cmdID || ch.GetSequence() != uint64(i) || len(ch.GetData()) > ChunkSize {
			t.Fatalf("chunk %d: %v", i, ch)
		}
		if ch.GetEof() != (i == len(s.chunks)-1) {
			t.Fatalf("only the last chunk may be eof (chunk %d)", i)
		}
	}
}

func TestAnExactMultipleOfTheChunkSizeStillEndsCleanly(t *testing.T) {
	body := bytes.Repeat([]byte("a"), 2*ChunkSize)
	srv := store(t, 200, gz(t, body))
	c, s := newDownloadClient(), &sink{}
	veleroProcesses(c, 0, srv.URL)

	res := downloader(c, s).Handle(context.Background(), fetchCmd(backupLog, "b", 0))

	if !res.GetOk() || !bytes.Equal(s.data(), body) || !s.chunks[len(s.chunks)-1].GetEof() {
		t.Fatalf("%v %d", res, len(s.chunks))
	}
}

func TestAFileThatIsNotGzipIsPassedThrough(t *testing.T) {
	srv := store(t, 200, []byte("plain text\n"))
	c, s := newDownloadClient(), &sink{}
	veleroProcesses(c, 0, srv.URL)

	res := downloader(c, s).Handle(context.Background(), fetchCmd(backupLog, "b", 0))

	if !res.GetOk() || string(s.data()) != "plain text\n" {
		t.Fatalf("%v %q", res, s.data())
	}
}

func TestRefusesAFileOverTheLimitWithoutSendingTheEndMarker(t *testing.T) {
	srv := store(t, 200, gz(t, bytes.Repeat([]byte("x"), 3*ChunkSize)))
	c, s := newDownloadClient(), &sink{}
	veleroProcesses(c, 0, srv.URL)

	res := downloader(c, s).Handle(context.Background(), fetchCmd(backupLog, "b", ChunkSize))

	if res.GetOk() || res.GetErrorCode() != pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT {
		t.Fatalf("%v", res)
	}
	for _, ch := range s.chunks {
		if ch.GetEof() {
			t.Fatal("an aborted download must not look finished")
		}
	}
}

func TestACompressionBombIsStoppedAtTheLimit(t *testing.T) {
	// 20 MiB of zeros compresses to ~20 KiB.
	srv := store(t, 200, gz(t, make([]byte, 20<<20)))
	c, s := newDownloadClient(), &sink{}
	veleroProcesses(c, 0, srv.URL)

	res := downloader(c, s).Handle(context.Background(), fetchCmd(backupLog, "b", 1<<20))

	if res.GetOk() || len(s.data()) > 1<<20 {
		t.Fatalf("ok=%v sent=%d", res.GetOk(), len(s.data()))
	}
}

func TestBackupContentsAreNeverProxiedAndNamesAreChecked(t *testing.T) {
	c, s := newDownloadClient(), &sink{}
	h := downloader(c, s)
	for name, cmd := range map[string]*pb.Command{
		"contents":    fetchCmd(pb.DownloadTargetKind_DOWNLOAD_TARGET_KIND_BACKUP_CONTENTS, "b", 0),
		"unspecified": fetchCmd(pb.DownloadTargetKind_DOWNLOAD_TARGET_KIND_UNSPECIFIED, "b", 0),
		"upper case":  fetchCmd(backupLog, "Not-A-Name", 0),
		"traversal":   fetchCmd(backupLog, "../x", 0),
		"empty":       fetchCmd(backupLog, "", 0),
	} {
		if res := h.Handle(context.Background(), cmd); res.GetOk() || res.GetErrorCode() != pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT {
			t.Errorf("%s: %v", name, res)
		}
	}
	if len(c.Actions()) != 0 {
		t.Fatalf("a refused request must not touch the cluster: %v", c.Actions())
	}
}

func TestAnObjectStoreFailureNeverRevealsTheSignedURL(t *testing.T) {
	for status, want := range map[int]pb.ErrorCode{404: pb.ErrorCode_ERROR_CODE_NOT_FOUND, 403: pb.ErrorCode_ERROR_CODE_KUBE_API_ERROR} {
		srv := store(t, status, nil)
		c, s := newDownloadClient(), &sink{}
		veleroProcesses(c, 0, srv.URL+"/x?X-Amz-Signature=topsecret")

		res := downloader(c, s).Handle(context.Background(), fetchCmd(backupLog, "b", 0))

		if res.GetOk() || res.GetErrorCode() != want || strings.Contains(res.GetErrorMessage(), "topsecret") || strings.Contains(res.GetErrorMessage(), srv.URL) {
			t.Errorf("%d: %v", status, res)
		}
	}
	// Unreachable store: the transport error contains the URL.
	c, s := newDownloadClient(), &sink{}
	veleroProcesses(c, 0, "http://127.0.0.1:1/x?X-Amz-Signature=topsecret")
	res := downloader(c, s).Handle(context.Background(), fetchCmd(backupLog, "b", 0))
	if res.GetOk() || strings.Contains(res.GetErrorMessage(), "topsecret") || strings.Contains(res.GetErrorMessage(), "127.0.0.1") {
		t.Fatalf("%v", res)
	}
}

func TestOnlyHTTPAddressesAreFetched(t *testing.T) {
	c, s := newDownloadClient(), &sink{}
	veleroProcesses(c, 0, "file:///etc/passwd")
	if res := downloader(c, s).Handle(context.Background(), fetchCmd(backupLog, "b", 0)); res.GetOk() || len(s.data()) != 0 {
		t.Fatalf("%v", res)
	}
}

func TestProcessedWithoutAFileIsNotFound(t *testing.T) {
	c, s := newDownloadClient(), &sink{}
	veleroProcesses(c, 0, "")
	res := downloader(c, s).Handle(context.Background(), fetchCmd(backupLog, "b", 0))
	if res.GetErrorCode() != pb.ErrorCode_ERROR_CODE_NOT_FOUND {
		t.Fatalf("%v", res)
	}
}

func TestLeavesNoRequestBehindAndLabelsItWithTheCommand(t *testing.T) {
	srv := store(t, 200, gz(t, []byte("hello")))
	c, s := newDownloadClient(), &sink{}
	veleroProcesses(c, 0, srv.URL)

	downloader(c, s).Handle(context.Background(), fetchCmd(backupLog, "nightly-1", 0))

	var created, deleted bool
	for _, a := range c.Actions() {
		switch a.GetVerb() {
		case "create":
			obj := a.(clienttesting.CreateAction).GetObject().(*unstructured.Unstructured)
			kind, _, _ := unstructured.NestedString(obj.Object, "spec", "target", "kind")
			name, _, _ := unstructured.NestedString(obj.Object, "spec", "target", "name")
			created = kind == "BackupLog" && name == "nightly-1" && obj.GetLabels()[LabelCommandID] == cmdID && obj.GetAnnotations()[AnnotationManaged] == "true"
		case "delete":
			deleted = true
		}
	}
	if !created || !deleted {
		t.Fatalf("created=%v deleted=%v", created, deleted)
	}
	left, _ := c.Resource(downloadRequests).Namespace("velero").List(context.Background(), metav1.ListOptions{})
	if len(left.Items) != 0 {
		t.Fatalf("left behind: %d", len(left.Items))
	}
}

func TestARetryReusesTheRequestItAlreadyCreated(t *testing.T) {
	srv := store(t, 200, gz(t, []byte("hello")))
	c, s := newDownloadClient(), &sink{}
	veleroProcesses(c, 0, srv.URL)
	existing := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "velero.io/v1", "kind": "DownloadRequest",
		"metadata": map[string]any{"name": "vfm-earlier", "namespace": "velero", "labels": map[string]any{LabelCommandID: cmdID}},
		"spec":     map[string]any{"target": map[string]any{"kind": "BackupLog", "name": "nightly-1"}},
	}}
	if _, err := c.Resource(downloadRequests).Namespace("velero").Create(context.Background(), existing, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}

	res := downloader(c, s).Handle(context.Background(), fetchCmd(backupLog, "nightly-1", 0))

	for _, a := range c.Actions() {
		if a.GetVerb() == "create" && a.GetResource().Resource == "downloadrequests" {
			if obj := a.(clienttesting.CreateAction).GetObject().(*unstructured.Unstructured); obj.GetName() != "vfm-earlier" {
				t.Fatalf("created a second request %s", obj.GetName())
			}
		}
	}
	if !res.GetOk() {
		t.Fatalf("%v", res)
	}
}

func TestAFullOutboundQueueSlowsTheDownloadButLosesNothing(t *testing.T) {
	body := []byte(strings.Repeat("0123456789", 20000))
	srv := store(t, 200, gz(t, body))
	c, s := newDownloadClient(), &sink{}
	s.refuse.Store(25)
	veleroProcesses(c, 0, srv.URL)

	res := downloader(c, s).Handle(context.Background(), fetchCmd(backupLog, "b", 0))

	if !res.GetOk() || !bytes.Equal(s.data(), body) {
		t.Fatalf("%v", res)
	}
	for i, ch := range s.chunks {
		if ch.GetSequence() != uint64(i) {
			t.Fatalf("gap at %d", i)
		}
	}
}

func TestAQueueThatNeverDrainsFailsInsteadOfHanging(t *testing.T) {
	srv := store(t, 200, gz(t, []byte("hello")))
	c, s := newDownloadClient(), &sink{}
	s.refuse.Store(1 << 30)
	veleroProcesses(c, 0, srv.URL)
	h := downloader(c, s)
	h.SendTimeout = 50 * time.Millisecond

	res := h.Handle(context.Background(), fetchCmd(backupLog, "b", 0))

	if res.GetOk() || res.GetErrorCode() != pb.ErrorCode_ERROR_CODE_TIMEOUT {
		t.Fatalf("%v", res)
	}
}

func TestStopsWaitingForVeleroWhenCancelled(t *testing.T) {
	c, s := newDownloadClient(), &sink{}
	veleroProcesses(c, 1<<30, "http://example.invalid")
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()

	res := downloader(c, s).Handle(ctx, fetchCmd(backupLog, "b", 0))

	if res.GetOk() || res.GetErrorCode() != pb.ErrorCode_ERROR_CODE_TIMEOUT {
		t.Fatalf("%v", res)
	}
	left, _ := c.Resource(downloadRequests).Namespace("velero").List(context.Background(), metav1.ListOptions{})
	if len(left.Items) != 0 {
		t.Fatal("a cancelled download must still clean up")
	}
}
