// Package dispatch executes the typed commands the control plane sends
// (PLAN.md §5.2, §5.4, §5.5).
//
// The agent is not a remote shell. It runs **only** operations that have a
// registered handler, only after the owner's policy allows them, at most once per
// command id, and it answers every command — including refusals — with a typed
// result so the control plane never waits on silence.
package dispatch

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
	"github.com/shubhambatra/velero-fe/vfm/agent/internal/policy"
)

// Handler runs one operation. It returns the result to report; it must respect
// ctx, which carries the command's deadline and is cancelled by CancelCommand.
type Handler func(ctx context.Context, cmd *pb.Command) *pb.CommandResult

// Op names an operation, taken from the command's oneof arm.
type Op string

// OpOf returns the operation of a command, or "" when none is set.
func OpOf(cmd *pb.Command) Op {
	switch cmd.GetOp().(type) {
	case *pb.Command_CreateBackup:
		return "create_backup"
	case *pb.Command_DeleteBackup:
		return "delete_backup"
	case *pb.Command_CreateRestore:
		return "create_restore"
	case *pb.Command_DeleteRestore:
		return "delete_restore"
	case *pb.Command_CreateSchedule:
		return "create_schedule"
	case *pb.Command_UpdateSchedule:
		return "update_schedule"
	case *pb.Command_SetSchedulePaused:
		return "set_schedule_paused"
	case *pb.Command_DeleteSchedule:
		return "delete_schedule"
	case *pb.Command_TriggerSchedule:
		return "trigger_schedule"
	case *pb.Command_UpsertBsl:
		return "upsert_bsl"
	case *pb.Command_SetDefaultBsl:
		return "set_default_bsl"
	case *pb.Command_DeleteBsl:
		return "delete_bsl"
	case *pb.Command_UpsertVsl:
		return "upsert_vsl"
	case *pb.Command_DeleteVsl:
		return "delete_vsl"
	case *pb.Command_FetchDownload:
		return "fetch_download"
	case *pb.Command_RefreshStatus:
		return "refresh_status"
	case *pb.Command_CheckNamespaces:
		return "check_namespaces"
	default:
		return ""
	}
}

// Options configures a [Dispatcher].
type Options struct {
	// Send queues a message for the control plane; false means the queue is full.
	Send func(*pb.AgentMessage) bool
	// Policy returns the current policy. Called per command so a reload applies at once.
	Policy func() policy.Policy
	Cache  *Cache
	// MaxConcurrent bounds commands executing at once.
	MaxConcurrent int
	Logger        *slog.Logger
	Now           func() time.Time
	// NewID makes a message id.
	NewID func() string
}

// Dispatcher routes commands to handlers.
type Dispatcher struct {
	opts     Options
	handlers map[Op]Handler
	slots    chan struct{}

	mu      sync.Mutex
	running map[string]context.CancelCauseFunc
	wg      sync.WaitGroup
}

// New returns a dispatcher with no handlers: nothing runs until one is registered.
func New(opts Options) *Dispatcher {
	if opts.MaxConcurrent <= 0 {
		opts.MaxConcurrent = 8
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	return &Dispatcher{
		opts:     opts,
		handlers: map[Op]Handler{},
		slots:    make(chan struct{}, opts.MaxConcurrent),
		running:  map[string]context.CancelCauseFunc{},
	}
}

// Register adds the handler for an operation. This is the allowlist: an operation
// without a handler is refused.
func (d *Dispatcher) Register(op Op, h Handler) { d.handlers[op] = h }

// errCancelled is the cause set by CancelCommand.
var errCancelled = errors.New("cancelled by the control plane")

// errShuttingDown is the cause set when the agent stops.
var errShuttingDown = errors.New("the agent is shutting down")

// Handle processes one message from the control plane. It never blocks: commands
// run on their own goroutines.
func (d *Dispatcher) Handle(msg *pb.ServerMessage) {
	switch {
	case msg.GetCommand() != nil:
		d.handleCommand(msg.GetCommand())
	case msg.GetCancel() != nil:
		d.cancel(msg.GetCancel().GetCommandId())
	}
}

// Stop cancels every running command and waits for them to report. It is for
// shutdown: a command abandoned mid-flight would otherwise answer to nobody.
func (d *Dispatcher) Stop() {
	d.mu.Lock()
	for _, cancel := range d.running {
		cancel(errShuttingDown)
	}
	d.mu.Unlock()
	d.wg.Wait()
}

// Wait blocks until every running command has finished.
func (d *Dispatcher) Wait() { d.wg.Wait() }

func (d *Dispatcher) handleCommand(cmd *pb.Command) {
	id := cmd.GetCommandId()
	log := d.opts.Logger.With("command_id", id, "op", string(OpOf(cmd)))

	if id == "" {
		// Nothing to answer to: there is no id to put on a result.
		log.Warn("refused a command with no id")
		return
	}

	// A duplicate: answer from memory, never execute twice (PLAN.md §5.4).
	if outcome, ok := d.opts.Cache.Get(id); ok {
		log.Info("replaying the cached result of an already executed command")
		d.send(resultMessage(id, outcome))
		return
	}
	d.mu.Lock()
	_, inFlight := d.running[id]
	d.mu.Unlock()
	if inFlight {
		// Still executing: the result will follow. Re-acknowledge so a control
		// plane that lost the first ack moves on.
		d.send(ackMessage(d.opts.NewID, id, pb.CommandAckState_COMMAND_ACK_STATE_RUNNING))
		return
	}

	if deadline := cmd.GetDeadline(); deadline != nil && !deadline.AsTime().After(d.opts.Now()) {
		d.finish(id, failure(pb.ErrorCode_ERROR_CODE_TIMEOUT, "the command's deadline had already passed when it arrived"))
		return
	}

	op := OpOf(cmd)
	handler, ok := d.handlers[op]
	if !ok {
		d.finish(id, failure(pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT,
			"this operation is not supported by this agent version"))
		return
	}
	if denial := d.opts.Policy().Check(cmd); denial != nil {
		log.Warn("refused by agent policy", "reason", denial.Reason)
		d.finish(id, failure(pb.ErrorCode_ERROR_CODE_FORBIDDEN_BY_AGENT_POLICY, denial.Reason))
		return
	}

	// Taken: tell the control plane before doing anything slow.
	d.send(ackMessage(d.opts.NewID, id, pb.CommandAckState_COMMAND_ACK_STATE_ACKED))

	ctx, cancel := context.WithCancelCause(context.Background())
	d.mu.Lock()
	d.running[id] = cancel
	d.mu.Unlock()

	d.wg.Add(1)
	go func() {
		defer d.wg.Done()
		defer func() {
			d.mu.Lock()
			delete(d.running, id)
			d.mu.Unlock()
			cancel(nil)
		}()

		// Bounded concurrency: wait for a slot, but give up if cancelled first.
		select {
		case d.slots <- struct{}{}:
			defer func() { <-d.slots }()
		case <-ctx.Done():
			d.finish(id, failure(pb.ErrorCode_ERROR_CODE_INTERNAL, context.Cause(ctx).Error()))
			return
		}

		runCtx := ctx
		if deadline := cmd.GetDeadline(); deadline != nil {
			var stop context.CancelFunc
			runCtx, stop = context.WithDeadline(ctx, deadline.AsTime())
			defer stop()
		}

		d.send(ackMessage(d.opts.NewID, id, pb.CommandAckState_COMMAND_ACK_STATE_RUNNING))
		log.Info("executing")
		d.finish(id, d.run(runCtx, handler, cmd))
	}()
}

// run calls the handler and turns a panic or a context end into a typed result:
// a bug in one operation must not take the agent down or leave a command silent.
func (d *Dispatcher) run(ctx context.Context, h Handler, cmd *pb.Command) (result *pb.CommandResult) {
	defer func() {
		if r := recover(); r != nil {
			d.opts.Logger.Error("a command handler panicked", "command_id", cmd.GetCommandId(), "panic", fmt.Sprint(r))
			result = failure(pb.ErrorCode_ERROR_CODE_INTERNAL, "internal error while executing the command")
		}
	}()
	result = h(ctx, cmd)
	if result == nil {
		return failure(pb.ErrorCode_ERROR_CODE_INTERNAL, "the operation returned no result")
	}
	return result
}

// ContextFailure is the typed result for an operation that stopped because its
// context ended: a missed deadline is a TIMEOUT, anything else was a cancellation
// by the control plane. Handlers return it from their ctx.Done paths.
func ContextFailure(ctx context.Context) *pb.CommandResult {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return failure(pb.ErrorCode_ERROR_CODE_TIMEOUT, "the command did not finish before its deadline")
	}
	cause := context.Cause(ctx)
	if cause == nil {
		cause = errCancelled
	}
	return failure(pb.ErrorCode_ERROR_CODE_INTERNAL, cause.Error())
}

// finish records the outcome and sends it. Recording first matters: if sending
// fails or the process dies, the re-delivered command is answered from the cache.
func (d *Dispatcher) finish(id string, result *pb.CommandResult) {
	result.CommandId = id
	if result.FinishedAt == nil {
		result.FinishedAt = timestamppb.New(d.opts.Now())
	}
	outcome := outcomeOf(result)
	d.opts.Cache.Put(id, outcome)
	d.send(&pb.AgentMessage{
		MessageId: d.opts.NewID(),
		Payload:   &pb.AgentMessage_Result{Result: result},
	})
}

func (d *Dispatcher) cancel(id string) {
	d.mu.Lock()
	cancel, ok := d.running[id]
	d.mu.Unlock()
	if ok {
		cancel(errCancelled)
	}
}

func (d *Dispatcher) send(msg *pb.AgentMessage) {
	if !d.opts.Send(msg) {
		// The queue is full. The result is cached, and the control plane re-delivers
		// an unfinished command on reconnect, so this is a delay, not a loss.
		d.opts.Logger.Warn("outbound queue full; a message was dropped")
	}
}

func ackMessage(newID func() string, id string, state pb.CommandAckState) *pb.AgentMessage {
	return &pb.AgentMessage{
		MessageId: newID(),
		Payload:   &pb.AgentMessage_Ack{Ack: &pb.CommandAck{CommandId: id, State: state}},
	}
}

func failure(code pb.ErrorCode, message string) *pb.CommandResult {
	return &pb.CommandResult{Ok: false, ErrorCode: code, ErrorMessage: message}
}
