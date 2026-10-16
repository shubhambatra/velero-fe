package dispatch

import (
	"context"
	"sync/atomic"
	"testing"

	"k8s.io/client-go/kubernetes/fake"

	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
)

// These cover "agent killed mid-command" (PLAN.md §16 day 15). A kill is simulated
// by abandoning one dispatcher and building a second from what survived: the
// persisted cache. What survives decides whether the control plane's re-delivery is
// run or replayed, and both answers must be right.

func TestAgentKilledWhileExecutingRunsTheRedeliveredCommandExactlyOnceMore(t *testing.T) {
	ctx := context.Background()
	cs := fake.NewClientset()
	store := &Store{Client: cs, Namespace: "vfm-system", Name: "vfm-agent-state"}

	// Instance 1 takes the command and is killed before it finishes. Nothing was
	// recorded, so nothing is persisted.
	first := newRig(t, nil)
	hold := make(chan struct{})
	started := make(chan struct{})
	first.d.Register("refresh_status", func(context.Context, *pb.Command) *pb.CommandResult {
		close(started)
		<-hold
		return ok()
	})
	first.d.Handle(refresh("c1"))
	<-started
	if err := store.Save(ctx, first.cache); err != nil {
		t.Fatal(err)
	}
	defer close(hold)

	// Instance 2 starts from the persisted state; the control plane re-delivers.
	second := newRig(t, nil)
	if err := store.Load(ctx, second.cache); err != nil {
		t.Fatal(err)
	}
	var runs atomic.Int32
	second.d.Register("refresh_status", func(context.Context, *pb.Command) *pb.CommandResult {
		runs.Add(1)
		return ok()
	})
	second.d.Handle(refresh("c1"))
	second.d.Wait()
	// And again: a second re-delivery after it finished must replay, not run.
	second.d.Handle(refresh("c1"))
	second.d.Wait()

	if runs.Load() != 1 {
		t.Fatalf("the re-delivered command ran %d times, want exactly once", runs.Load())
	}
	if res := second.out.results(); len(res) != 2 || !res[0].GetOk() || !res[1].GetOk() {
		t.Fatalf("results = %v", res)
	}
}

func TestAgentKilledAfterRecordingButBeforeSendingReplaysInsteadOfRunningAgain(t *testing.T) {
	ctx := context.Background()
	cs := fake.NewClientset()
	store := &Store{Client: cs, Namespace: "vfm-system", Name: "vfm-agent-state"}

	// Instance 1 finishes the work and records the outcome, but dies before the
	// result reaches the control plane (its Send goes nowhere).
	first := newRig(t, func(o *Options) { o.Send = func(*pb.AgentMessage) bool { return true } })
	var firstRuns atomic.Int32
	first.d.Register("refresh_status", func(context.Context, *pb.Command) *pb.CommandResult {
		firstRuns.Add(1)
		return ok()
	})
	first.d.Handle(refresh("c1"))
	first.d.Wait()
	if err := store.Save(ctx, first.cache); err != nil {
		t.Fatal(err)
	}

	second := newRig(t, nil)
	if err := store.Load(ctx, second.cache); err != nil {
		t.Fatal(err)
	}
	var secondRuns atomic.Int32
	second.d.Register("refresh_status", func(context.Context, *pb.Command) *pb.CommandResult {
		secondRuns.Add(1)
		return ok()
	})
	second.d.Handle(refresh("c1"))
	second.d.Wait()

	if firstRuns.Load() != 1 || secondRuns.Load() != 0 {
		t.Fatalf("ran %d then %d times; the second instance must replay, not repeat the work",
			firstRuns.Load(), secondRuns.Load())
	}
	res := second.out.results()
	if len(res) != 1 || !res[0].GetOk() || res[0].GetServerStatus().GetServerVersion() != "v1.18.4" {
		t.Fatalf("the replay must carry the original result: %v", res)
	}
}

func TestAnAgentKilledBeforeItEverSavedStateStartsCleanAndRunsWhatItIsGiven(t *testing.T) {
	// No ConfigMap at all: a brand-new or wiped agent. It must not refuse work.
	fresh := newRig(t, nil)
	store := &Store{Client: fake.NewClientset(), Namespace: "vfm-system", Name: "vfm-agent-state"}
	if err := store.Load(context.Background(), fresh.cache); err != nil {
		t.Fatalf("a missing state ConfigMap is not an error: %v", err)
	}
	var runs atomic.Int32
	fresh.d.Register("refresh_status", func(context.Context, *pb.Command) *pb.CommandResult {
		runs.Add(1)
		return ok()
	})
	fresh.d.Handle(refresh("c1"))
	fresh.d.Wait()
	if runs.Load() != 1 {
		t.Fatalf("a fresh agent ran the command %d times", runs.Load())
	}
}
