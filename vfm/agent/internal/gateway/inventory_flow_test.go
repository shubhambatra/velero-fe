package gateway

import (
	"context"
	"io"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	fakediscovery "k8s.io/client-go/discovery/fake"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	clienttesting "k8s.io/client-go/testing"

	"github.com/shubhambatra/velero-fe/vfm/agent/internal/identity"
	"github.com/shubhambatra/velero-fe/vfm/agent/internal/inventory"
	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
)

var backupsGVR = schema.GroupVersionResource{Group: "velero.io", Version: "v1", Resource: "backups"}

func backupObject(name string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "velero.io/v1", "kind": "Backup",
		"metadata": map[string]any{"name": name, "namespace": "velero", "uid": "uid-" + name, "resourceVersion": "1"},
		"spec":     map[string]any{},
	}}
}

// The real manager and the real syncer against the in-process control plane: what
// the server receives is what the day 17 ingest will have to handle.
func TestInventoryFlowsOverTheStreamAndIsReplacedAfterAServerRestart(t *testing.T) {
	ca := newTestCA(t)
	gw := startFakeGateway(t, ca, nil)

	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(),
		map[schema.GroupVersionResource]string{backupsGVR: "BackupList"})
	disc := &fakediscovery.FakeDiscovery{Fake: &clienttesting.Fake{}}
	disc.Resources = []*metav1.APIResourceList{{
		GroupVersion: "velero.io/v1", APIResources: []metav1.APIResource{{Name: "backups", Namespaced: true}},
	}}
	if _, err := dyn.Resource(backupsGVR).Namespace("velero").Create(context.Background(), backupObject("b1"), metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}

	var manager *Manager
	syncer := inventory.New(inventory.Options{
		Dynamic: dyn, Discovery: disc, Namespace: "velero",
		Kinds:    []inventory.Kind{{Proto: pb.ResourceKind_RESOURCE_KIND_BACKUP, GVR: backupsGVR}},
		SendWait: func(ctx context.Context, m *pb.AgentMessage) error { return manager.SendWait(ctx, m) },
		TrySend:  func(m *pb.AgentMessage) bool { return manager.Send(m) },
		NewID:    NewMessageID, BatchWait: 40 * time.Millisecond,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})

	var up atomic.Int32
	var err error
	manager, err = New(Options{
		Address: gw.addr, BootstrapCA: ca.pem, EnrollmentToken: "bootstrap-token",
		Store:             &identity.MemoryStore{},
		Fingerprint:       func(context.Context) (string, error) { return fingerprint, nil },
		Hello:             func(context.Context) *pb.Hello { return &pb.Hello{} },
		HeartbeatInterval: 50 * time.Millisecond,
		OnMessage:         syncer.HandleServerMessage,
		OnConnection: func(c bool) {
			if c {
				up.Add(1)
			}
			syncer.SetConnected(c)
		},
		Backoff: Backoff{Min: 10 * time.Millisecond, Max: 40 * time.Millisecond, Factor: 2, Rand: func() float64 { return 1 }},
		Logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = manager.Run(ctx); close(done) }()
	go syncer.Run(ctx)
	defer func() { cancel(); <-done }()

	snapshotIDs := func() []string {
		var ids []string
		seen := map[string]bool{}
		for _, m := range gw.messages() {
			if s := m.GetSnapshot(); s != nil && s.GetLast() && !seen[s.GetSnapshotId()] {
				seen[s.GetSnapshotId()] = true
				ids = append(ids, s.GetSnapshotId())
			}
		}
		return ids
	}

	eventually(t, "a complete snapshot after connecting", func() bool { return len(snapshotIDs()) == 1 })
	first := snapshotIDs()[0]

	if _, err := dyn.Resource(backupsGVR).Namespace("velero").Create(context.Background(), backupObject("b2"), metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	eventually(t, "a delta naming that snapshot", func() bool {
		for _, m := range gw.messages() {
			if e := m.GetEvents(); e != nil && e.GetSnapshotId() == first {
				for _, ev := range e.GetEvents() {
					if ev.GetItem().GetName() == "b2" {
						return true
					}
				}
			}
		}
		return false
	})

	// The control plane's replica dies and a new one comes up: the new stream must
	// start from a complete snapshot of everything, not from where the last one ended.
	gw.kill()
	gw.restart()
	eventually(t, "a new snapshot on the new stream", func() bool { return len(snapshotIDs()) == 2 })

	second := snapshotIDs()[1]
	if second == first {
		t.Fatal("the new stream reused the old snapshot id")
	}
	names := map[string]bool{}
	for _, m := range gw.messages() {
		if s := m.GetSnapshot(); s != nil && s.GetSnapshotId() == second {
			for _, it := range s.GetItems() {
				names[it.GetName()] = true
			}
		}
	}
	if !names["b1"] || !names["b2"] {
		t.Errorf("the replacement snapshot has %v; it must contain everything", names)
	}
}
