package dispatch

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"

	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
	"github.com/shubhambatra/velero-fe/vfm/agent/internal/policy"
)

// outbox records what the dispatcher sends to the control plane.
type outbox struct {
	mu   sync.Mutex
	msgs []*pb.AgentMessage
}

func (o *outbox) send(m *pb.AgentMessage) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.msgs = append(o.msgs, m)
	return true
}

func (o *outbox) snapshot() []*pb.AgentMessage {
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]*pb.AgentMessage(nil), o.msgs...)
}

func (o *outbox) results() []*pb.CommandResult {
	var out []*pb.CommandResult
	for _, m := range o.snapshot() {
		if r := m.GetResult(); r != nil {
			out = append(out, r)
		}
	}
	return out
}

func (o *outbox) acks() []pb.CommandAckState {
	var out []pb.CommandAckState
	for _, m := range o.snapshot() {
		if a := m.GetAck(); a != nil {
			out = append(out, a.GetState())
		}
	}
	return out
}

type rig struct {
	d     *Dispatcher
	out   *outbox
	cache *Cache
	pol   *policy.Policy
	ids   atomic.Int64
}

func newRig(t *testing.T, mutate func(*Options)) *rig {
	t.Helper()
	r := &rig{out: &outbox{}, cache: NewCache(100)}
	p := policy.Default()
	r.pol = &p
	opts := Options{
		Send:   r.out.send,
		Policy: func() policy.Policy { return *r.pol },
		Cache:  r.cache,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		NewID:  func() string { return fmt.Sprintf("m-%d", r.ids.Add(1)) },
	}
	if mutate != nil {
		mutate(&opts)
	}
	r.d = New(opts)
	return r
}

func refresh(id string) *pb.ServerMessage {
	return &pb.ServerMessage{Payload: &pb.ServerMessage_Command{Command: &pb.Command{
		CommandId: id,
		Deadline:  timestamppb.New(time.Now().Add(time.Minute)),
		Op:        &pb.Command_RefreshStatus{RefreshStatus: &pb.RefreshServerStatus{}},
	}}}
}

func ok() *pb.CommandResult {
	return &pb.CommandResult{Ok: true, Detail: &pb.CommandResult_ServerStatus{ServerStatus: &pb.ServerStatus{
		ServerVersion: "v1.18.4", Plugins: []*pb.PluginInfo{{Name: "velero.io/aws", Kind: "ObjectStore"}},
	}}}
}

func TestRunsACommandAcksFirstAndReportsTheResult(t *testing.T) {
	r := newRig(t, nil)
	r.d.Register("refresh_status", func(context.Context, *pb.Command) *pb.CommandResult { return ok() })

	r.d.Handle(refresh("c1"))
	r.d.Wait()

	got := r.out.acks()
	if len(got) != 2 || got[0] != pb.CommandAckState_COMMAND_ACK_STATE_ACKED || got[1] != pb.CommandAckState_COMMAND_ACK_STATE_RUNNING {
		t.Errorf("acks = %v, want ACKED then RUNNING", got)
	}
	res := r.out.results()
	if len(res) != 1 || !res[0].GetOk() || res[0].GetCommandId() != "c1" || res[0].GetFinishedAt() == nil {
		t.Fatalf("results = %v", res)
	}
	if res[0].GetServerStatus().GetServerVersion() != "v1.18.4" {
		t.Errorf("detail lost: %v", res[0])
	}
}

func TestADuplicateIsAnsweredFromMemoryAndNeverRunsTwice(t *testing.T) {
	r := newRig(t, nil)
	var calls atomic.Int32
	r.d.Register("refresh_status", func(context.Context, *pb.Command) *pb.CommandResult {
		calls.Add(1)
		return ok()
	})

	r.d.Handle(refresh("c1"))
	r.d.Wait()
	r.d.Handle(refresh("c1"))
	r.d.Handle(refresh("c1"))
	r.d.Wait()

	if calls.Load() != 1 {
		t.Fatalf("handler ran %d times for one command id", calls.Load())
	}
	res := r.out.results()
	if len(res) != 3 {
		t.Fatalf("want the original result and two replays, got %d", len(res))
	}
	for _, x := range res {
		if x.GetServerStatus().GetServerVersion() != "v1.18.4" {
			t.Errorf("a replay lost the detail: %v", x)
		}
	}
}

func TestARestartedAgentStillRecognisesADuplicate(t *testing.T) {
	ctx := context.Background()
	cs := fake.NewClientset()
	store := &Store{Client: cs, Namespace: "vfm-system", Name: "vfm-agent-state"}

	first := newRig(t, nil)
	first.d.Register("refresh_status", func(context.Context, *pb.Command) *pb.CommandResult { return ok() })
	first.d.Handle(refresh("c1"))
	first.d.Wait()
	if err := store.Save(ctx, first.cache); err != nil {
		t.Fatal(err)
	}

	// A new process: empty cache, loaded from the ConfigMap.
	second := newRig(t, nil)
	if err := store.Load(ctx, second.cache); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	second.d.Register("refresh_status", func(context.Context, *pb.Command) *pb.CommandResult {
		calls.Add(1)
		return ok()
	})
	second.d.Handle(refresh("c1"))
	second.d.Wait()

	if calls.Load() != 0 {
		t.Error("a restarted agent executed a command it had already executed")
	}
	if res := second.out.results(); len(res) != 1 || res[0].GetServerStatus().GetServerVersion() != "v1.18.4" {
		t.Errorf("the replay after restart was wrong: %v", res)
	}
}

func TestAnOperationWithoutAHandlerIsRefusedNotIgnored(t *testing.T) {
	r := newRig(t, nil)
	msg := &pb.ServerMessage{Payload: &pb.ServerMessage_Command{Command: &pb.Command{
		CommandId: "c1",
		Op:        &pb.Command_CreateBackup{CreateBackup: &pb.CreateBackup{Name: "b"}},
	}}}
	r.d.Handle(msg)
	r.d.Wait()

	res := r.out.results()
	if len(res) != 1 || res[0].GetOk() || res[0].GetErrorCode() != pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT {
		t.Fatalf("an unregistered operation must be answered with INVALID_ARGUMENT: %v", res)
	}
	if len(r.out.acks()) != 0 {
		t.Error("it acknowledged work it was never going to do")
	}
}

func TestACommandWithNoOperationIsRefused(t *testing.T) {
	r := newRig(t, nil)
	r.d.Handle(&pb.ServerMessage{Payload: &pb.ServerMessage_Command{Command: &pb.Command{CommandId: "c1"}}})
	r.d.Wait()
	if res := r.out.results(); len(res) != 1 || res[0].GetOk() {
		t.Fatalf("an empty command was not refused: %v", res)
	}
}

func TestPolicyIsEnforcedBeforeTheHandlerRuns(t *testing.T) {
	r := newRig(t, nil)
	r.pol.ReadOnly = true
	var calls atomic.Int32
	r.d.Register("create_backup", func(context.Context, *pb.Command) *pb.CommandResult {
		calls.Add(1)
		return ok()
	})
	r.d.Handle(&pb.ServerMessage{Payload: &pb.ServerMessage_Command{Command: &pb.Command{
		CommandId: "c1", Op: &pb.Command_CreateBackup{CreateBackup: &pb.CreateBackup{}},
	}}})
	r.d.Wait()

	if calls.Load() != 0 {
		t.Fatal("the handler ran although policy forbade the command")
	}
	res := r.out.results()
	if len(res) != 1 || res[0].GetErrorCode() != pb.ErrorCode_ERROR_CODE_FORBIDDEN_BY_AGENT_POLICY {
		t.Fatalf("want FORBIDDEN_BY_AGENT_POLICY, got %v", res)
	}
	if len(r.out.acks()) != 0 {
		t.Error("a refused command must not be acknowledged as accepted")
	}
}

func TestPolicyReloadsApplyToTheNextCommand(t *testing.T) {
	r := newRig(t, nil)
	r.d.Register("create_backup", func(context.Context, *pb.Command) *pb.CommandResult { return ok() })
	backup := func(id string) *pb.ServerMessage {
		return &pb.ServerMessage{Payload: &pb.ServerMessage_Command{Command: &pb.Command{
			CommandId: id, Op: &pb.Command_CreateBackup{CreateBackup: &pb.CreateBackup{}},
		}}}
	}
	r.d.Handle(backup("c1"))
	r.d.Wait()
	r.pol.ReadOnly = true
	r.d.Handle(backup("c2"))
	r.d.Wait()

	res := r.out.results()
	if len(res) != 2 || !res[0].GetOk() || res[1].GetOk() {
		t.Fatalf("results = %v", res)
	}
}

func TestACommandThatArrivesAlreadyExpiredIsNotRun(t *testing.T) {
	r := newRig(t, nil)
	var calls atomic.Int32
	r.d.Register("refresh_status", func(context.Context, *pb.Command) *pb.CommandResult {
		calls.Add(1)
		return ok()
	})
	msg := refresh("c1")
	msg.GetCommand().Deadline = timestamppb.New(time.Now().Add(-time.Second))
	r.d.Handle(msg)
	r.d.Wait()

	if calls.Load() != 0 {
		t.Fatal("an expired command was executed")
	}
	if res := r.out.results(); len(res) != 1 || res[0].GetErrorCode() != pb.ErrorCode_ERROR_CODE_TIMEOUT {
		t.Fatalf("want TIMEOUT, got %v", res)
	}
}

func TestADeadlineStopsARunningHandler(t *testing.T) {
	r := newRig(t, nil)
	r.d.Register("refresh_status", func(ctx context.Context, _ *pb.Command) *pb.CommandResult {
		<-ctx.Done()
		return ContextFailure(ctx)
	})
	msg := refresh("c1")
	msg.GetCommand().Deadline = timestamppb.New(time.Now().Add(80 * time.Millisecond))
	r.d.Handle(msg)
	r.d.Wait()

	if res := r.out.results(); len(res) != 1 || res[0].GetErrorCode() != pb.ErrorCode_ERROR_CODE_TIMEOUT {
		t.Fatalf("want TIMEOUT, got %v", res)
	}
}

func TestCancelStopsARunningCommand(t *testing.T) {
	r := newRig(t, nil)
	started := make(chan struct{})
	r.d.Register("refresh_status", func(ctx context.Context, _ *pb.Command) *pb.CommandResult {
		close(started)
		<-ctx.Done()
		return ContextFailure(ctx)
	})
	r.d.Handle(refresh("c1"))
	<-started
	r.d.Handle(&pb.ServerMessage{Payload: &pb.ServerMessage_Cancel{Cancel: &pb.CancelCommand{CommandId: "c1"}}})
	r.d.Wait()

	res := r.out.results()
	if len(res) != 1 || res[0].GetOk() || res[0].GetErrorMessage() != "cancelled by the control plane" {
		t.Fatalf("a cancelled command must report the cancellation: %v", res)
	}
}

func TestCancelOfAnUnknownCommandIsHarmless(t *testing.T) {
	r := newRig(t, nil)
	r.d.Handle(&pb.ServerMessage{Payload: &pb.ServerMessage_Cancel{Cancel: &pb.CancelCommand{CommandId: "nope"}}})
	if len(r.out.snapshot()) != 0 {
		t.Error("cancelling nothing produced output")
	}
}

func TestAPanickingHandlerIsAnInternalErrorNotACrash(t *testing.T) {
	r := newRig(t, nil)
	r.d.Register("refresh_status", func(context.Context, *pb.Command) *pb.CommandResult { panic("boom") })
	r.d.Handle(refresh("c1"))
	r.d.Wait()

	res := r.out.results()
	if len(res) != 1 || res[0].GetErrorCode() != pb.ErrorCode_ERROR_CODE_INTERNAL {
		t.Fatalf("want INTERNAL, got %v", res)
	}
	if res[0].GetErrorMessage() == "boom" {
		t.Error("the panic value leaked into the result")
	}
}

func TestADuplicateOfARunningCommandReAcknowledgesAndDoesNotRunAgain(t *testing.T) {
	r := newRig(t, nil)
	release := make(chan struct{})
	var calls atomic.Int32
	started := make(chan struct{}, 2)
	r.d.Register("refresh_status", func(context.Context, *pb.Command) *pb.CommandResult {
		calls.Add(1)
		started <- struct{}{}
		<-release
		return ok()
	})
	r.d.Handle(refresh("c1"))
	<-started
	r.d.Handle(refresh("c1"))
	close(release)
	r.d.Wait()

	if calls.Load() != 1 {
		t.Fatalf("handler ran %d times", calls.Load())
	}
	if len(r.out.results()) != 1 {
		t.Errorf("want exactly one result, got %d", len(r.out.results()))
	}
}

func TestConcurrencyIsBounded(t *testing.T) {
	r := newRig(t, func(o *Options) { o.MaxConcurrent = 1 })
	var active, peak atomic.Int32
	r.d.Register("refresh_status", func(context.Context, *pb.Command) *pb.CommandResult {
		n := active.Add(1)
		for {
			p := peak.Load()
			if n <= p || peak.CompareAndSwap(p, n) {
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
		active.Add(-1)
		return ok()
	})
	for i := range 4 {
		r.d.Handle(refresh(fmt.Sprintf("c%d", i)))
	}
	r.d.Wait()

	if peak.Load() != 1 {
		t.Errorf("%d commands ran at once with MaxConcurrent=1", peak.Load())
	}
	if len(r.out.results()) != 4 {
		t.Errorf("results = %d, want 4", len(r.out.results()))
	}
}

func TestACommandWithoutAnIdIsDroppedBecauseThereIsNothingToAnswerTo(t *testing.T) {
	r := newRig(t, nil)
	r.d.Register("refresh_status", func(context.Context, *pb.Command) *pb.CommandResult { return ok() })
	r.d.Handle(&pb.ServerMessage{Payload: &pb.ServerMessage_Command{Command: &pb.Command{
		Op: &pb.Command_RefreshStatus{},
	}}})
	r.d.Wait()
	if len(r.out.snapshot()) != 0 {
		t.Error("it answered a command that had no id")
	}
}

func TestOpOfNamesEverySixteenOperations(t *testing.T) {
	cmds := []*pb.Command{
		{Op: &pb.Command_CreateBackup{}}, {Op: &pb.Command_DeleteBackup{}},
		{Op: &pb.Command_CreateRestore{}}, {Op: &pb.Command_DeleteRestore{}},
		{Op: &pb.Command_CreateSchedule{}}, {Op: &pb.Command_UpdateSchedule{}},
		{Op: &pb.Command_SetSchedulePaused{}}, {Op: &pb.Command_DeleteSchedule{}},
		{Op: &pb.Command_TriggerSchedule{}}, {Op: &pb.Command_UpsertBsl{}},
		{Op: &pb.Command_SetDefaultBsl{}}, {Op: &pb.Command_DeleteBsl{}},
		{Op: &pb.Command_UpsertVsl{}}, {Op: &pb.Command_DeleteVsl{}},
		{Op: &pb.Command_FetchDownload{}}, {Op: &pb.Command_RefreshStatus{}},
	}
	seen := map[Op]bool{}
	for _, c := range cmds {
		op := OpOf(c)
		if op == "" || seen[op] {
			t.Errorf("operation %T mapped to %q (empty or duplicate)", c.GetOp(), op)
		}
		seen[op] = true
	}
	if OpOf(&pb.Command{}) != "" {
		t.Error("a command with no operation must have no name")
	}
}

func TestCacheEvictsTheLeastRecentlyUsed(t *testing.T) {
	c := NewCache(3)
	for _, id := range []string{"a", "b", "c"} {
		c.Put(id, Outcome{OK: true})
	}
	c.Get("a") // a is now the most recent
	c.Put("d", Outcome{OK: true})

	if _, ok := c.Get("b"); ok {
		t.Error("the least recently used entry survived")
	}
	for _, id := range []string{"a", "c", "d"} {
		if _, ok := c.Get(id); !ok {
			t.Errorf("%s was evicted", id)
		}
	}
	if c.Len() != 3 {
		t.Errorf("len = %d", c.Len())
	}
}

func TestPersistingTheCacheRoundTripsAndOnlyWhenChanged(t *testing.T) {
	ctx := context.Background()
	cs := fake.NewClientset()
	store := &Store{Client: cs, Namespace: "n", Name: "state"}
	c := NewCache(CacheSize)
	for i := range 50 {
		c.Put(fmt.Sprintf("id-%d", i), Outcome{OK: i%2 == 0, ErrorMessage: "m", FinishedAt: time.Unix(int64(i), 0).UTC()})
	}
	if err := store.Save(ctx, c); err != nil {
		t.Fatal(err)
	}

	loaded := NewCache(CacheSize)
	if err := store.Load(ctx, loaded); err != nil {
		t.Fatal(err)
	}
	if loaded.Len() != 50 {
		t.Fatalf("loaded %d entries, want 50", loaded.Len())
	}
	if o, _ := loaded.Get("id-7"); o.OK || o.FinishedAt.Unix() != 7 {
		t.Errorf("entry did not round-trip: %+v", o)
	}

	// Nothing changed: no write.
	before, _ := cs.CoreV1().ConfigMaps("n").Get(ctx, "state", metav1.GetOptions{})
	cs.ClearActions()
	if err := store.Save(ctx, c); err != nil {
		t.Fatal(err)
	}
	for _, a := range cs.Actions() {
		if a.GetVerb() == "update" || a.GetVerb() == "create" {
			t.Errorf("an unchanged cache was written: %v", a)
		}
	}
	_ = before
}

func TestAFullCacheStillFitsInAConfigMap(t *testing.T) {
	c := NewCache(CacheSize)
	for i := range CacheSize * 2 {
		c.Put(fmt.Sprintf("0194f9d2-0000-7000-8000-%012d", i), Outcome{
			OK: false, ErrorCode: 6, FinishedAt: time.Unix(int64(i), 0).UTC(),
			ErrorMessage: fmt.Sprintf("the Kubernetes API refused request number %d with a long message to make it hard to compress", i),
		})
	}
	data, err := c.encode()
	if err != nil {
		t.Fatal(err)
	}
	if len(data) > maxPersistedBytes {
		t.Fatalf("persisted state is %d bytes; a ConfigMap holds 1 MiB", len(data))
	}
	loaded := NewCache(CacheSize)
	if err := loaded.decode(data); err != nil {
		t.Fatal(err)
	}
	// The newest entries are the ones worth keeping.
	if _, ok := loaded.Get(fmt.Sprintf("0194f9d2-0000-7000-8000-%012d", CacheSize*2-1)); !ok {
		t.Error("the newest entry was dropped to make room")
	}
}

func TestACorruptStateConfigMapIsReportedAndLeavesTheCacheEmpty(t *testing.T) {
	ctx := context.Background()
	cs := fake.NewClientset(&corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Name: "state", Namespace: "n"},
		BinaryData: map[string][]byte{stateKey: []byte("not gzip")},
	})
	c := NewCache(10)
	if err := (&Store{Client: cs, Namespace: "n", Name: "state"}).Load(ctx, c); err == nil {
		t.Error("corrupt state was accepted silently")
	}
	if c.Len() != 0 {
		t.Error("corrupt state partially loaded")
	}
	// A missing ConfigMap is simply a fresh agent.
	if err := (&Store{Client: fake.NewClientset(), Namespace: "n", Name: "state"}).Load(ctx, c); err != nil {
		t.Errorf("a missing state ConfigMap is not an error: %v", err)
	}
}
