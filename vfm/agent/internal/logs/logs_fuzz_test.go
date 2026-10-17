package logs

import (
	"strings"
	"testing"

	"google.golang.org/protobuf/proto"

	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
	"github.com/shubhambatra/velero-fe/vfm/agent/internal/policy"
)

// FuzzRefusal: whatever a StartLogSession says, the decision never panics, and a session
// that is accepted has a strict namespace, pod and container name, a session id, bounded
// ranges, and a namespace the policy does not forbid.
func FuzzRefusal(f *testing.F) {
	seed := func(r *pb.StartLogSession) {
		b, _ := proto.Marshal(r)
		f.Add(b, "kube-system")
	}
	seed(&pb.StartLogSession{SessionId: "s", Namespace: "shop", Pod: "web-1", Container: "app", TailLines: 100})
	seed(&pb.StartLogSession{SessionId: "s", Namespace: "kube-system", Pod: "x"})
	seed(&pb.StartLogSession{SessionId: "s", Namespace: "../x", Pod: "x"})
	seed(&pb.StartLogSession{SessionId: "s", Namespace: "a", Pod: "b\n--follow"})
	seed(&pb.StartLogSession{SessionId: "s", Namespace: "a", Pod: "b", TailLines: -1})
	seed(&pb.StartLogSession{SessionId: "s", Namespace: "a", Pod: "b", SinceSeconds: 1 << 62})
	seed(&pb.StartLogSession{Namespace: "a", Pod: "b"})
	seed(&pb.StartLogSession{SessionId: "s", Namespace: strings.Repeat("a", 300), Pod: "b"})
	f.Add([]byte{}, "")
	f.Add([]byte{0xff, 0xfe}, "*")
	f.Fuzz(func(t *testing.T, data []byte, denied string) {
		var req pb.StartLogSession
		if proto.Unmarshal(data, &req) != nil {
			return
		}
		p := policy.Default()
		p.LogStreamDeniedNamespaces = []string{denied}
		reason, _ := refusal(&req, p)
		if reason != pb.LogSessionEndReason_LOG_SESSION_END_REASON_UNSPECIFIED {
			return
		}
		for _, n := range []string{req.GetNamespace(), req.GetPod()} {
			if !nameRE.MatchString(n) || len(n) > 253 || strings.ContainsAny(n, "/\\ \x00\n\r\t") {
				t.Fatalf("accepted name %q", n)
			}
		}
		if c := req.GetContainer(); c != "" && !nameRE.MatchString(c) {
			t.Fatalf("accepted container %q", c)
		}
		if req.GetSessionId() == "" || req.GetTailLines() < 0 || req.GetTailLines() > maxTailLines ||
			req.GetSinceSeconds() < 0 || req.GetSinceSeconds() > maxSinceSeconds {
			t.Fatalf("accepted out-of-range request %v", &req)
		}
		if denied == "*" || denied == req.GetNamespace() {
			t.Fatalf("accepted namespace %q although %q is denied", req.GetNamespace(), denied)
		}
	})
}
