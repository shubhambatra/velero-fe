package dispatch

import (
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
)

// FuzzHandleCommand: any Command the control plane could encode — no op, an op this agent
// does not know, an unknown field, a huge payload — is answered or ignored, never run, and
// never panics the dispatcher. With no handler registered, nothing can execute.
func FuzzHandleCommand(f *testing.F) {
	seed := func(c *pb.Command) {
		b, _ := proto.Marshal(c)
		f.Add(b)
	}
	seed(&pb.Command{CommandId: "c1"})
	seed(&pb.Command{CommandId: "c2", Op: &pb.Command_RefreshStatus{RefreshStatus: &pb.RefreshServerStatus{}}})
	seed(&pb.Command{CommandId: "c3", Op: &pb.Command_CreateRestore{CreateRestore: &pb.CreateRestore{
		AdvancedSpecJson: []byte(strings.Repeat("{", 100000))}}})
	seed(&pb.Command{CommandId: strings.Repeat("x", 100000)})
	seed(&pb.Command{Op: &pb.Command_RefreshStatus{}})
	seed(&pb.Command{CommandId: "c4", Deadline: timestamppb.New(time.Unix(1, 0))})
	f.Add([]byte{})
	f.Add([]byte{0x0a, 0xff, 0xff, 0xff, 0xff, 0x0f})
	f.Add([]byte{0xa2, 0x06, 0x00})
	f.Fuzz(func(t *testing.T, data []byte) {
		var cmd pb.Command
		if proto.Unmarshal(data, &cmd) != nil {
			return
		}
		r := newRig(t, nil)
		r.d.Handle(&pb.ServerMessage{Payload: &pb.ServerMessage_Command{Command: &cmd}})
		r.d.Wait()
		results := r.out.results()
		if len(results) > 1 {
			t.Fatalf("%d results for one command", len(results))
		}
		for _, a := range r.out.acks() {
			if a == pb.CommandAckState_COMMAND_ACK_STATE_RUNNING || a == pb.CommandAckState_COMMAND_ACK_STATE_ACKED {
				t.Fatalf("acknowledged work that no handler can do: %v", &cmd)
			}
		}
		if cmd.GetCommandId() == "" && (len(results) != 0 || len(r.out.snapshot()) != 0) {
			t.Fatalf("answered a command with no id")
		}
		// A cancel for anything at all is harmless too.
		r.d.Handle(&pb.ServerMessage{Payload: &pb.ServerMessage_Cancel{Cancel: &pb.CancelCommand{CommandId: cmd.GetCommandId()}}})
	})
}
