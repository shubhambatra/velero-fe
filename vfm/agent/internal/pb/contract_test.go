package pb_test

import (
	"testing"

	"google.golang.org/protobuf/proto"

	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
)

// The generated Go stubs are the agent's half of the contract in
// proto/vfm/agent/v1; these pin the properties M2 relies on.

func roundTrip[T proto.Message](t *testing.T, in T, out T) T {
	t.Helper()
	b, err := proto.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	if err := proto.Unmarshal(b, out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestOptionalBoolKeepsUnsetDistinctFromFalse(t *testing.T) {
	off := false
	unset := roundTrip(t, &pb.BackupSpec{}, &pb.BackupSpec{})
	set := roundTrip(t, &pb.BackupSpec{SnapshotVolumes: &off}, &pb.BackupSpec{})
	if unset.SnapshotVolumes != nil {
		t.Fatal("unset snapshot_volumes decoded as set")
	}
	if set.SnapshotVolumes == nil || *set.SnapshotVolumes {
		t.Fatal("explicit false was lost")
	}
}

func TestCommandCarriesOneOp(t *testing.T) {
	in := &pb.ServerMessage{Payload: &pb.ServerMessage_Command{Command: &pb.Command{
		CommandId: "c",
		Op:        &pb.Command_RefreshStatus{RefreshStatus: &pb.RefreshServerStatus{}},
	}}}
	out := roundTrip(t, in, &pb.ServerMessage{})
	if out.GetCommand().GetRefreshStatus() == nil || out.GetCommand().GetCreateBackup() != nil {
		t.Fatal("op did not round-trip as exactly refresh_status")
	}
}

func TestResourceKindHasNoSecret(t *testing.T) {
	for _, name := range pb.ResourceKind_name {
		if len(name) >= 6 && name[len(name)-6:] == "SECRET" {
			t.Fatalf("ResourceKind %s could carry a Secret", name)
		}
	}
}
