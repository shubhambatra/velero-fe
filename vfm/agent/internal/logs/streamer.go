// Package logs streams a container's log to the control plane on request (PLAN.md §5.6,
// §7.2). A session is `pods/log` with follow, read in chunks of at most 64 KB and sent as
// they arrive. Nothing is kept: not on disk, not in memory beyond the chunk in flight.
//
// The agent enforces its own limits whatever the control plane asks:
//
//   - its policy (log streaming off, or the namespace denied) is checked before anything
//     is read;
//   - at most [Options.MaxSessions] at once, the oldest ending when one more is asked;
//   - a hard timeout per session;
//   - a byte rate per session, applied by waiting rather than dropping, so one chatty
//     container slows its own viewer and not the rest of the stream.
//
// The content of a log is never written to the agent's own log.
package logs

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"regexp"
	"sync"
	"time"

	"golang.org/x/time/rate"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"

	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
	"github.com/shubhambatra/velero-fe/vfm/agent/internal/policy"
)

// Defaults from PLAN.md §5.6.
const (
	DefaultMaxSessions  = 10
	DefaultTimeout      = 30 * time.Minute
	DefaultBytesPerSec  = 2 << 20
	MaxChunkBytes       = 64 * 1024
	maxTailLines        = 10000
	maxSinceSeconds     = 7 * 24 * 3600
	maxMessage          = 200
	unreadableLogReason = "the log could not be read"
	notifyWait          = 5 * time.Second
)

// A DNS-1123 label or subdomain; a container name is a label. Anything else is not a
// Kubernetes name and is refused before it reaches the API server.
var nameRE = regexp.MustCompile(`^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$`)

// Source is where logs come from; [KubeSource] is the real one and tests supply their own.
type Source interface {
	// Open starts reading a container's log.
	Open(ctx context.Context, namespace, pod string, opts *corev1.PodLogOptions) (io.ReadCloser, error)
	// PodExists tells a deleted pod from a container that merely ended.
	PodExists(ctx context.Context, namespace, pod string) (bool, error)
}

// KubeSource reads `pods/log` through the API server.
type KubeSource struct{ Client kubernetes.Interface }

// Open implements [Source].
func (k KubeSource) Open(ctx context.Context, namespace, pod string, opts *corev1.PodLogOptions) (io.ReadCloser, error) {
	return k.Client.CoreV1().Pods(namespace).GetLogs(pod, opts).Stream(ctx)
}

// PodExists implements [Source].
func (k KubeSource) PodExists(ctx context.Context, namespace, pod string) (bool, error) {
	_, err := k.Client.CoreV1().Pods(namespace).Get(ctx, pod, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return false, nil
	}
	return err == nil, err
}

// Options configures a [Streamer].
type Options struct {
	Source Source
	Policy func() policy.Policy
	// SendWait queues a message and waits for room (backpressure to the reader).
	SendWait func(ctx context.Context, m *pb.AgentMessage) error
	NewID    func() string
	Logger   *slog.Logger

	MaxSessions int
	Timeout     time.Duration
	BytesPerSec int
}

// Streamer runs log sessions.
type Streamer struct {
	opts   Options
	logger *slog.Logger

	mu       sync.Mutex
	sessions map[string]*session
	// order lists session ids oldest first.
	order []string
}

type session struct {
	id     string
	cancel context.CancelFunc
	// why is set by whoever ends the session on purpose; read after the goroutine stops.
	why  pb.LogSessionEndReason
	text string
}

// New returns a streamer with defaults filled in.
func New(opts Options) *Streamer {
	if opts.MaxSessions <= 0 {
		opts.MaxSessions = DefaultMaxSessions
	}
	if opts.Timeout <= 0 {
		opts.Timeout = DefaultTimeout
	}
	if opts.BytesPerSec <= 0 {
		opts.BytesPerSec = DefaultBytesPerSec
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	return &Streamer{opts: opts, logger: opts.Logger, sessions: map[string]*session{}}
}

// Active is the number of sessions running now, for the heartbeat.
func (s *Streamer) Active() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.sessions)
}

// HandleServerMessage acts on the session messages and ignores the rest. It never
// blocks: a session runs on its own goroutine.
func (s *Streamer) HandleServerMessage(m *pb.ServerMessage) {
	switch {
	case m.GetStartLogs() != nil:
		s.start(m.GetStartLogs())
	case m.GetStopLogs() != nil:
		s.end(m.GetStopLogs().GetSessionId(), pb.LogSessionEndReason_LOG_SESSION_END_REASON_STOPPED, "")
	}
}

// Disconnected ends every session without telling anyone: the stream they would tell
// is gone, and the control plane ends its side when the agent disconnects.
func (s *Streamer) Disconnected() {
	s.mu.Lock()
	all := make([]*session, 0, len(s.sessions))
	for _, sess := range s.sessions {
		sess.why = pb.LogSessionEndReason_LOG_SESSION_END_REASON_UNSPECIFIED
		all = append(all, sess)
	}
	s.mu.Unlock()
	for _, sess := range all {
		sess.cancel()
	}
}

// refusal is why a request was not run, for the closing notice.
func refusal(req *pb.StartLogSession, p policy.Policy) (pb.LogSessionEndReason, string) {
	if d := p.CheckLogSession(req.GetNamespace()); d != nil {
		return pb.LogSessionEndReason_LOG_SESSION_END_REASON_DENIED_BY_POLICY, d.Reason
	}
	switch {
	case req.GetSessionId() == "":
		return pb.LogSessionEndReason_LOG_SESSION_END_REASON_ERROR, "the request has no session id"
	case !nameRE.MatchString(req.GetNamespace()), !nameRE.MatchString(req.GetPod()):
		return pb.LogSessionEndReason_LOG_SESSION_END_REASON_ERROR, "the namespace or pod name is not valid"
	case req.GetContainer() != "" && !nameRE.MatchString(req.GetContainer()):
		return pb.LogSessionEndReason_LOG_SESSION_END_REASON_ERROR, "the container name is not valid"
	case req.GetTailLines() < 0 || req.GetTailLines() > maxTailLines:
		return pb.LogSessionEndReason_LOG_SESSION_END_REASON_ERROR, "tail lines is out of range"
	case req.GetSinceSeconds() < 0 || req.GetSinceSeconds() > maxSinceSeconds:
		return pb.LogSessionEndReason_LOG_SESSION_END_REASON_ERROR, "since seconds is out of range"
	}
	return pb.LogSessionEndReason_LOG_SESSION_END_REASON_UNSPECIFIED, ""
}

func (s *Streamer) start(req *pb.StartLogSession) {
	if reason, text := refusal(req, s.opts.Policy()); reason != pb.LogSessionEndReason_LOG_SESSION_END_REASON_UNSPECIFIED {
		s.logger.Warn("log session refused",
			"session_id", req.GetSessionId(), "namespace", req.GetNamespace(), "reason", text)
		if req.GetSessionId() != "" {
			s.notifyEnded(req.GetSessionId(), reason, text)
		}
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), s.opts.Timeout)
	sess := &session{id: req.GetSessionId(), cancel: cancel}

	s.mu.Lock()
	if _, dup := s.sessions[sess.id]; dup {
		s.mu.Unlock()
		cancel()
		return
	}
	// Sessions already being closed do not count; the oldest of the rest go first.
	var live []*session
	for _, id := range s.order {
		if old := s.sessions[id]; old != nil && old.why == pb.LogSessionEndReason_LOG_SESSION_END_REASON_UNSPECIFIED {
			live = append(live, old)
		}
	}
	var evict []*session
	for len(live)-len(evict) >= s.opts.MaxSessions {
		oldest := live[len(evict)]
		oldest.why = pb.LogSessionEndReason_LOG_SESSION_END_REASON_EVICTED_BY_LIMIT
		oldest.text = "closed because this cluster has too many log sessions open"
		evict = append(evict, oldest)
	}
	s.sessions[sess.id] = sess
	s.order = append(s.order, sess.id)
	s.mu.Unlock()
	for _, old := range evict {
		old.cancel()
	}

	s.logger.Info("log session started",
		"session_id", sess.id, "namespace", req.GetNamespace(), "pod", req.GetPod(),
		"container", req.GetContainer(), "previous", req.GetPrevious())
	go s.run(ctx, sess, req)
}

// end ends a session on purpose; a session that is already gone is not an error.
func (s *Streamer) end(id string, reason pb.LogSessionEndReason, text string) {
	s.mu.Lock()
	sess := s.sessions[id]
	if sess != nil {
		sess.why, sess.text = reason, text
	}
	s.mu.Unlock()
	if sess != nil {
		sess.cancel()
	}
}

func (s *Streamer) forget(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessions, id)
	for i, v := range s.order {
		if v == id {
			s.order = append(s.order[:i], s.order[i+1:]...)
			break
		}
	}
}

func (s *Streamer) notifyEnded(id string, reason pb.LogSessionEndReason, text string) {
	if len(text) > maxMessage {
		text = text[:maxMessage]
	}
	// Waits briefly for room: the end is what lets the control plane tell the viewer.
	ctx, cancel := context.WithTimeout(context.Background(), notifyWait)
	defer cancel()
	_ = s.opts.SendWait(ctx, &pb.AgentMessage{
		MessageId: s.opts.NewID(),
		Payload: &pb.AgentMessage_LogEnded{LogEnded: &pb.LogSessionEnded{
			SessionId: id, Reason: reason, Message: text,
		}},
	})
}

func (s *Streamer) run(ctx context.Context, sess *session, req *pb.StartLogSession) {
	defer sess.cancel()
	reason, text := s.stream(ctx, sess, req)
	s.forget(sess.id)

	s.mu.Lock()
	chosen, chosenText := sess.why, sess.text
	s.mu.Unlock()
	switch {
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		reason, text = pb.LogSessionEndReason_LOG_SESSION_END_REASON_TIMEOUT, "the session reached its time limit"
	case chosen == pb.LogSessionEndReason_LOG_SESSION_END_REASON_UNSPECIFIED && ctx.Err() != nil:
		// Ended by a disconnect: nobody to tell.
		s.logger.Info("log session ended", "session_id", sess.id, "reason", "disconnected")
		return
	case chosen != pb.LogSessionEndReason_LOG_SESSION_END_REASON_UNSPECIFIED:
		reason, text = chosen, chosenText
	}
	s.logger.Info("log session ended", "session_id", sess.id, "reason", reason.String())
	s.notifyEnded(sess.id, reason, text)
}

// stream reads the log until it ends and says how it ended when that was not asked for.
func (s *Streamer) stream(ctx context.Context, sess *session, req *pb.StartLogSession) (pb.LogSessionEndReason, string) {
	opts := &corev1.PodLogOptions{
		Container:  req.GetContainer(),
		Follow:     req.GetFollow() && !req.GetPrevious(),
		Previous:   req.GetPrevious(),
		Timestamps: req.GetTimestamps(),
	}
	if n := req.GetTailLines(); n > 0 {
		opts.TailLines = &n
	}
	if n := req.GetSinceSeconds(); n > 0 {
		opts.SinceSeconds = &n
	}
	body, err := s.opts.Source.Open(ctx, req.GetNamespace(), req.GetPod(), opts)
	if err != nil {
		return s.classify(ctx, req, err)
	}
	// A Read that is waiting for the next line does not return when the session is
	// cancelled unless the body is closed under it.
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			_ = body.Close()
		case <-done:
		}
	}()
	defer func() { _ = body.Close() }()

	limiter := rate.NewLimiter(rate.Limit(s.opts.BytesPerSec), MaxChunkBytes)
	buf := make([]byte, MaxChunkBytes)
	var seq uint64
	for {
		n, readErr := body.Read(buf)
		if n > 0 {
			if err := limiter.WaitN(ctx, n); err != nil {
				return 0, ""
			}
			chunk := &pb.AgentMessage{
				MessageId: s.opts.NewID(),
				Payload: &pb.AgentMessage_LogChunk{LogChunk: &pb.LogChunk{
					Origin:   &pb.LogChunk_SessionId{SessionId: sess.id},
					Sequence: seq,
					Data:     append([]byte(nil), buf[:n]...),
				}},
			}
			seq++
			if err := s.opts.SendWait(ctx, chunk); err != nil {
				return 0, ""
			}
		}
		if readErr != nil {
			if ctx.Err() != nil {
				return 0, ""
			}
			if errors.Is(readErr, io.EOF) {
				return s.finished(ctx, req)
			}
			return s.classify(ctx, req, readErr)
		}
	}
}

// finished says why a log that reached its end ended: the pod being deleted or the
// container having exited.
func (s *Streamer) finished(ctx context.Context, req *pb.StartLogSession) (pb.LogSessionEndReason, string) {
	exists, err := s.opts.Source.PodExists(ctx, req.GetNamespace(), req.GetPod())
	if err == nil && !exists {
		return pb.LogSessionEndReason_LOG_SESSION_END_REASON_POD_GONE, "the pod no longer exists"
	}
	return pb.LogSessionEndReason_LOG_SESSION_END_REASON_COMPLETED, "the container's log ended"
}

// classify turns an API error into an end reason. The API server's own message is
// kept only for the cases where it helps the person (a container that has not started);
// anything else gets a fixed sentence, because an error can quote a URL or a token.
func (s *Streamer) classify(ctx context.Context, req *pb.StartLogSession, err error) (pb.LogSessionEndReason, string) {
	if ctx.Err() != nil {
		return 0, ""
	}
	switch {
	case apierrors.IsNotFound(err):
		return pb.LogSessionEndReason_LOG_SESSION_END_REASON_POD_GONE, "the pod or container was not found"
	case apierrors.IsForbidden(err):
		return pb.LogSessionEndReason_LOG_SESSION_END_REASON_ERROR, "the agent is not permitted to read this pod's log"
	case apierrors.IsBadRequest(err):
		// "container ... is waiting to start", "previous terminated container not found".
		var status apierrors.APIStatus
		if errors.As(err, &status) {
			return pb.LogSessionEndReason_LOG_SESSION_END_REASON_ERROR, status.Status().Message
		}
	}
	s.logger.Warn("log session failed", "session_id", req.GetSessionId(), "error", err)
	return pb.LogSessionEndReason_LOG_SESSION_END_REASON_ERROR, unreadableLogReason
}
