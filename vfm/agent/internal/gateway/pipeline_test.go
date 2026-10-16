package gateway

import (
	"context"
	"io"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/shubhambatra/velero-fe/vfm/agent/internal/dispatch"
	"github.com/shubhambatra/velero-fe/vfm/agent/internal/identity"
	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
	"github.com/shubhambatra/velero-fe/vfm/agent/internal/policy"
)

// pipeline wires the real manager to the real dispatcher against the in-process
// control plane: a command pushed from the server travels the whole agent path.
func pipeline(t *testing.T, handler dispatch.Handler) (*fakeGateway, *dispatch.Dispatcher, func()) {
	t.Helper()
	ca := newTestCA(t)
	gw := startFakeGateway(t, ca, nil)

	var manager *Manager
	dispatcher := dispatch.New(dispatch.Options{
		Send:   func(m *pb.AgentMessage) bool { return manager.Send(m) },
		Policy: policy.Default,
		Cache:  dispatch.NewCache(100),
		NewID:  NewMessageID,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	dispatcher.Register("refresh_status", handler)

	var up atomic.Bool
	var err error
	manager, err = New(Options{
		Address: gw.addr, BootstrapCA: ca.pem, EnrollmentToken: "bootstrap-token",
		Store:             &identity.MemoryStore{},
		Fingerprint:       func(context.Context) (string, error) { return fingerprint, nil },
		Hello:             func(context.Context) *pb.Hello { return &pb.Hello{} },
		HeartbeatInterval: 50 * time.Millisecond,
		OnMessage:         dispatcher.Handle,
		OnConnection:      func(c bool) { up.Store(c) },
		Backoff:           Backoff{Min: 10 * time.Millisecond, Max: 40 * time.Millisecond, Factor: 2, Rand: func() float64 { return 1 }},
		Logger:            slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = manager.Run(ctx); close(done) }()
	eventually(t, "connection", up.Load)
	return gw, dispatcher, func() { cancel(); dispatcher.Stop(); <-done }
}

func command(id string) *pb.ServerMessage {
	return &pb.ServerMessage{MessageId: "s-" + id, Payload: &pb.ServerMessage_Command{Command: &pb.Command{
		CommandId: id,
		Deadline:  timestamppb.New(time.Now().Add(time.Minute)),
		Op:        &pb.Command_RefreshStatus{RefreshStatus: &pb.RefreshServerStatus{}},
	}}}
}

func TestACommandPushedFromTheControlPlaneIsExecutedAndAnswered(t *testing.T) {
	gw, _, stop := pipeline(t, func(context.Context, *pb.Command) *pb.CommandResult {
		return &pb.CommandResult{Ok: true, Detail: &pb.CommandResult_ServerStatus{ServerStatus: &pb.ServerStatus{ServerVersion: "v1.18.4"}}}
	})
	defer stop()

	gw.push(command("c1"))

	eventually(t, "the result", func() bool {
		for _, m := range gw.messages() {
			if m.GetResult() != nil {
				return true
			}
		}
		return false
	})
	var acks []pb.CommandAckState
	var result *pb.CommandResult
	for _, m := range gw.messages() {
		if a := m.GetAck(); a != nil {
			acks = append(acks, a.GetState())
		}
		if r := m.GetResult(); r != nil {
			result = r
		}
	}
	if len(acks) != 2 || acks[0] != pb.CommandAckState_COMMAND_ACK_STATE_ACKED || acks[1] != pb.CommandAckState_COMMAND_ACK_STATE_RUNNING {
		t.Errorf("acks = %v", acks)
	}
	if result.GetCommandId() != "c1" || !result.GetOk() || result.GetServerStatus().GetServerVersion() != "v1.18.4" {
		t.Errorf("result = %v", result)
	}
}

func TestARedeliveredCommandIsAnsweredWithoutRunningAgain(t *testing.T) {
	var runs atomic.Int32
	gw, _, stop := pipeline(t, func(context.Context, *pb.Command) *pb.CommandResult {
		runs.Add(1)
		return &pb.CommandResult{Ok: true}
	})
	defer stop()

	count := func() int {
		n := 0
		for _, m := range gw.messages() {
			if m.GetResult() != nil {
				n++
			}
		}
		return n
	}
	gw.push(command("c1"))
	eventually(t, "the first result", func() bool { return count() == 1 })

	// The control plane did not see the result (say, a reconnect) and sends it again.
	gw.push(command("c1"))
	eventually(t, "the replayed result", func() bool { return count() == 2 })

	if runs.Load() != 1 {
		t.Errorf("the operation ran %d times for one command id", runs.Load())
	}
}

func TestACancelFromTheControlPlaneReachesARunningCommand(t *testing.T) {
	started := make(chan struct{})
	gw, _, stop := pipeline(t, func(ctx context.Context, _ *pb.Command) *pb.CommandResult {
		close(started)
		<-ctx.Done()
		return dispatch.ContextFailure(ctx)
	})
	defer stop()

	gw.push(command("c1"))
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("the command never started")
	}
	gw.push(&pb.ServerMessage{Payload: &pb.ServerMessage_Cancel{Cancel: &pb.CancelCommand{CommandId: "c1"}}})

	eventually(t, "the cancelled result", func() bool {
		for _, m := range gw.messages() {
			if r := m.GetResult(); r != nil && !r.GetOk() && r.GetErrorMessage() == "cancelled by the control plane" {
				return true
			}
		}
		return false
	})
}

func TestAKilledControlPlaneReplicaIsReconnectedToAndWorkResumes(t *testing.T) {
	var runs atomic.Int32
	gw, _, stop := pipeline(t, func(context.Context, *pb.Command) *pb.CommandResult {
		runs.Add(1)
		return &pb.CommandResult{Ok: true}
	})
	defer stop()

	results := func() int {
		n := 0
		for _, m := range gw.messages() {
			if m.GetResult() != nil {
				n++
			}
		}
		return n
	}
	gw.push(command("before"))
	eventually(t, "the first result", func() bool { return results() == 1 })
	_, _, connectsBefore, _ := gw.snapshot()

	// The replica dies without a word, and another comes up where it was.
	gw.kill()
	gw.restart()

	eventually(t, "a reconnect", func() bool { _, _, c, _ := gw.snapshot(); return c > connectsBefore })
	gw.push(command("after"))
	eventually(t, "the result of a command sent after the restart", func() bool { return results() == 2 })

	if runs.Load() != 2 {
		t.Errorf("handler ran %d times, want 2", runs.Load())
	}
	if enrolls, _, _, _ := gw.snapshot(); enrolls != 1 {
		t.Errorf("the agent enrolled %d times; a replica restart must reuse its identity", enrolls)
	}
}
