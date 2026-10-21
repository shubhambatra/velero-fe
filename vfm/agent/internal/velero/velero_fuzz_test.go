package velero

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
	"github.com/shubhambatra/velero-fe/vfm/agent/internal/policy"
)

// FuzzRefusedAddress: any byte string, as an IP, never panics; one that is not 4 or 16
// bytes is refused (it names no destination); an IPv4-mapped IPv6 address is judged
// exactly as the IPv4 address inside it.
func FuzzRefusedAddress(f *testing.F) {
	for _, s := range [][]byte{
		nil, {}, {127, 0, 0, 1}, {169, 254, 169, 254}, {10, 0, 0, 1}, {8, 8, 8, 8}, {1, 2, 3}, {1, 2, 3, 4, 5},
		net.ParseIP("::ffff:127.0.0.1"), net.ParseIP("::ffff:169.254.169.254"), net.ParseIP("::1"), net.ParseIP("fe80::1"),
		net.ParseIP("::"), net.ParseIP("ff02::1"), net.ParseIP("64:ff9b::7f00:1"), net.ParseIP("2002:7f00:1::"),
		make([]byte, 17), make([]byte, 15),
	} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, b []byte) {
		ip := net.IP(b)
		got := refusedAddress(ip)
		if len(b) != 4 && len(b) != 16 && !got {
			t.Fatalf("%d bytes are not an address and must be refused", len(b))
		}
		if len(b) == 16 {
			if v4 := ip.To4(); v4 != nil && refusedAddress(v4) != got {
				t.Fatalf("%v and its IPv4 form %v are judged differently", ip, v4)
			}
		}
		if got == false && (ip.IsLoopback() || ip.IsUnspecified() || ip.IsLinkLocalUnicast() || ip.IsMulticast()) {
			t.Fatalf("%v allowed", ip)
		}
	})
}

// FuzzDownloadURL: whatever address Velero's DownloadRequest names, the agent's own
// client never reaches a listener on the agent's host (here a loopback server).
func FuzzDownloadURL(f *testing.F) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		_, _ = w.Write([]byte("internal"))
	}))
	f.Cleanup(srv.Close)
	port := srv.Listener.Addr().(*net.TCPAddr).Port
	for _, host := range []string{
		"127.0.0.1", "localhost", "[::1]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "0x7f.1", "2130706433", "127.1", "0",
		"0.0.0.0", "[::]", "user@127.0.0.1", "127.0.0.1.", "LOCALHOST", "127。0。0。1", "①②⑦.0.0.1", "127.0.0.1%00",
	} {
		f.Add(host, "/x")
	}
	f.Add("127.0.0.1", "/../../etc/passwd")
	f.Fuzz(func(t *testing.T, host, path string) {
		c, s := newDownloadClient(), &sink{}
		raw := fmt.Sprintf("http://%s:%d%s", host, port, path)
		veleroProcesses(c, 0, raw)
		res := theAgentsOwnClient(c, s).Handle(context.Background(), fetchCmd(backupLog, "b", 0))
		_ = res
		if hits.Load() != 0 {
			t.Fatalf("the agent's own client reached a loopback listener through %q", raw)
		}
	})
}

// FuzzTargetName: a download target that is not a plain Kubernetes name creates nothing.
func FuzzTargetName(f *testing.F) {
	for _, s := range []string{"", "b", "../x", "a/b", "a b", "A", "a\nb", "a\x00", strings.Repeat("a", 254), strings.Repeat("a", 253),
		"-a", "a-", ".a", "a.", "a..b", "ａ", "a;rm -rf /", "$(id)", "a" + string(rune(0x202e)) + "b"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, name string) {
		c, s := newDownloadClient(), &sink{}
		veleroProcesses(c, 0, "http://169.254.169.254/x")
		// A valid name goes on to wait for Velero; only what happens to the invalid ones matters here.
		ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
		defer cancel()
		res := downloader(c, s).Handle(ctx, fetchCmd(backupLog, name, 0))
		created, _ := c.Resource(downloadRequests).Namespace("velero").List(context.Background(), metav1.ListOptions{})
		if !dnsSubdomain.MatchString(name) {
			if res.GetOk() || len(created.Items) != 0 {
				t.Fatalf("name %q was accepted: ok=%v created=%d", name, res.GetOk(), len(created.Items))
			}
		}
		if dnsSubdomain.MatchString(name) && (len(name) > 253 || strings.ContainsAny(name, "/\\ \x00\n\r\t:;$`'\"")) {
			t.Fatalf("regexp accepted %q", name)
		}
	})
}

// FuzzObjectName: the backup and restore name check accepts only a strict name that fits a label.
func FuzzObjectName(f *testing.F) {
	for _, s := range []string{"", "a", "nightly-1", "A", "a_b", "a b", strings.Repeat("a", 64), strings.Repeat("a", 63), "a\n", "-a", "a-", "..", "a/../b", "é"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, name string) {
		if checkName(name) != "" {
			return
		}
		if len(name) == 0 || len(name) > maxNameLength || !objectName.MatchString(name) {
			t.Fatalf("accepted %q", name)
		}
		if strings.ContainsAny(name, "/\\ \x00\n\r\t_") || strings.ToLower(name) != name {
			t.Fatalf("accepted %q", name)
		}
	})
}

// FuzzValidateCron must never panic or hang on any expression.
func FuzzValidateCron(f *testing.F) {
	for _, s := range []string{"", "* * * * *", "0 0 31 2 *", "@every 1h", "@every -1s", "@every 99999999999999999999h", "*/0 * * * *",
		"1-5/0 * * * *", "- - - - -", "0 0 * * 7", "a b c d e", strings.Repeat("*/1,", 1000), "0 0 1-2-3 * *", "\x00 * * * *", "CRON_TZ=UTC * * * * *", "@yearly extra"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, expr string) { _ = ValidateCron(expr) })
}

// FuzzSpecBuilders: arbitrary protobuf bytes decoded as a spec never panic the builders, and
// what they produce can be marshalled as the JSON the API server will receive.
func FuzzSpecBuilders(f *testing.F) {
	seed := func(m proto.Message) {
		b, _ := proto.Marshal(m)
		f.Add(b)
	}
	seed(&pb.RestoreSpec{BackupName: "b", IncludedNamespaces: []string{"a"}, NamespaceMapping: map[string]string{"a": "b"}})
	seed(&pb.BackupSpec{IncludedNamespaces: []string{"*"}, Hooks: &pb.BackupHooks{}})
	seed(&pb.ScheduleSpec{Schedule: "@every 1h"})
	f.Add([]byte{})
	f.Add([]byte{0xff, 0xff, 0xff, 0xff})
	f.Add([]byte(strings.Repeat("\x0a\x80\x01", 500)))
	f.Fuzz(func(t *testing.T, data []byte) {
		var r pb.RestoreSpec
		if proto.Unmarshal(data, &r) == nil {
			mustMarshal(t, RestoreSpecMap(&r))
		}
		var b pb.BackupSpec
		if proto.Unmarshal(data, &b) == nil {
			mustMarshal(t, BackupSpecMap(&b))
		}
		var s pb.ScheduleSpec
		if proto.Unmarshal(data, &s) == nil {
			mustMarshal(t, ScheduleSpecMap(&s))
			_, _ = buildScheduleSpec(&s, data)
		}
	})
}

func mustMarshal(t *testing.T, v any) {
	t.Helper()
	if _, err := json.Marshal(v); err != nil {
		t.Fatalf("a generated spec cannot be encoded: %v", err)
	}
}

// FuzzAdvancedSpec: arbitrary JSON merged onto a spec never panics and never smuggles in a
// field Velero's spec does not have (the check that keeps case-variants and typos out).
func FuzzAdvancedSpec(f *testing.F) {
	for _, s := range []string{"", "{}", "null", "[]", `{"includedNamespaces":["kube-system"]}`, `{"INCLUDEDNAMESPACES":["kube-system"]}`,
		`{"includedNamespaces":"kube-system"}`, `{"a":` + strings.Repeat("[", 5000), `{"x":1}{"y":2}`, `{"namespaceMapping":{"a":1}}`,
		`{"ttl":"1e999h"}`, "\x00", `{"includedNamespaces":["a"]} trailing`, `{"__proto__":{}}`, strings.Repeat(" ", 2<<20)} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, raw string) {
		for _, kind := range []specKind{backupKind, restoreKind} {
			out, err := applyAdvanced(kind, map[string]any{}, []byte(raw))
			if err != nil {
				continue
			}
			for key := range out {
				if _, ok := kind.shape[key]; !ok {
					t.Fatalf("accepted unknown field %q in a %s spec", key, kind.label)
				}
			}
		}
	})
}

// FuzzRestoreCreate drives the real handler end to end: whatever the typed spec and the
// advanced JSON say, a Restore that gets created does not write into a protected namespace.
func FuzzRestoreCreate(f *testing.F) {
	f.Add("kube-system", "", `{}`)
	f.Add("", "kube-system", `{}`)
	f.Add("app", "", `{"includedNamespaces":["kube-system"]}`)
	f.Add("app", "", `{"includedNamespaces":["kube-*"]}`)
	f.Add("app", "", `{"namespaceMapping":{"app":"kube-system"}}`)
	f.Add("app", "", `{"namespaceMapping":{"app":"kube-sys*"}}`)
	f.Add("", "", `{"includedNamespaces":["*"]}`)
	f.Add("", "", `{"excludedNamespaces":["kube-*"]}`)
	f.Add("app", "", `{"INCLUDEDNAMESPACES":["kube-system"]}`)
	f.Add("app", "", `{"includedNamespaces":"kube-system"}`)
	f.Add("app", "", `{"includedNamespaces":[null,"kube-system"]}`)
	f.Add("app", "", `{"includedNamespaces":["app\u0000"]}`)
	f.Fuzz(func(t *testing.T, included, mappedTo, advanced string) {
		c := newRestoreClient()
		_, _ = c.Resource(backups).Namespace("velero").Create(context.Background(), &unstructured.Unstructured{Object: map[string]any{
			"apiVersion": "velero.io/v1", "kind": "Backup", "metadata": map[string]any{"name": "b1", "namespace": "velero"},
		}}, metav1.CreateOptions{})
		spec := &pb.RestoreSpec{BackupName: "b1"}
		if included != "" {
			spec.IncludedNamespaces = []string{included}
		}
		if mappedTo != "" {
			spec.NamespaceMapping = map[string]string{"app": mappedTo}
		}
		p := policy.Default()
		res := restoreHandler(c, p).Create(context.Background(), restoreCmd("r1", spec, advanced))
		list, err := c.Resource(restores).Namespace("velero").List(context.Background(), metav1.ListOptions{})
		if err != nil || len(list.Items) == 0 {
			return
		}
		if !res.GetOk() {
			t.Fatalf("an object was created but the command reports %v", res)
		}
		made, _, _ := unstructured.NestedMap(list.Items[0].Object, "spec")
		inc := stringsOf(made["includedNamespaces"])
		exc := stringsOf(made["excludedNamespaces"])
		for _, denied := range p.RestoreDeniedNamespaces {
			for _, in := range inc {
				if in == denied || (in != "*" && !plainNamespace(in)) {
					t.Fatalf("created a restore including %q (denied %q): %v", in, denied, made)
				}
			}
			if (len(inc) == 0 || slices.Contains(inc, "*")) && !slices.Contains(exc, denied) {
				t.Fatalf("created a restore of every namespace without excluding %q: %v", denied, made)
			}
			for _, to := range stringMap(made["namespaceMapping"]) {
				if to == denied || !plainNamespace(to) {
					t.Fatalf("created a restore mapped into %q (denied %q): %v", to, denied, made)
				}
			}
		}
	})
}

// plainNamespace is an independent statement of what a plain namespace name is.
func plainNamespace(s string) bool {
	if s == "" || len(s) > 63 || s[0] == '-' || s[len(s)-1] == '-' {
		return false
	}
	for _, r := range s {
		if (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '-' {
			return false
		}
	}
	return true
}
