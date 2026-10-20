// Package gateway is the agent's side of the control-plane protocol
// (PLAN.md §5): enrollment, the mTLS stream, Hello, heartbeats, reconnect with
// backoff, and certificate renewal.
//
// The agent only ever dials out (PLAN.md §1.1 P1). Everything here runs on the
// leader replica only; the caller starts [Manager.Run] from the leader task.
package gateway

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"strings"
	"time"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/keepalive"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/shubhambatra/velero-fe/vfm/agent/internal/identity"
	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
)

// ProtocolVersion is the wire protocol this agent speaks (PLAN.md §5.7).
const ProtocolVersion = 1

const (
	// maxMessageBytes is the gRPC message cap (PLAN.md §5.6).
	maxMessageBytes = 4 * 1024 * 1024
	// helloAckTimeout bounds how long the control plane may take to accept.
	helloAckTimeout = 15 * time.Second
	// stableAfter is how long a stream must last before the backoff resets, so
	// a control plane that accepts and immediately drops us is still backed off.
	stableAfter = 30 * time.Second
	// renewRetry is the gap between failed renewal attempts.
	renewRetry = time.Minute
	// shutdownDrain bounds how long a graceful stop waits for the server to
	// close its end of the stream.
	shutdownDrain = 2 * time.Second
)

// ErrNeedsEnrollment means the agent holds no identity and was given no
// bootstrap token, so it cannot connect until an operator provides one.
var ErrNeedsEnrollment = errors.New("not enrolled and no bootstrap token configured")

// Options configures a [Manager].
type Options struct {
	// Address is host:port of the gateway.
	Address string
	// ServerName is the TLS name to verify; empty means the host of Address.
	ServerName string
	// BootstrapCA pins the control plane before the first enrollment. Once an
	// identity exists, the CA stored with it is used instead.
	BootstrapCA []byte
	// EnrollmentToken is the one-time token; used only when no identity exists.
	EnrollmentToken string

	Store identity.Store

	// Fingerprint returns the kube-system namespace UID (PLAN.md §5.1 step 3).
	Fingerprint func(ctx context.Context) (string, error)
	// Hello builds the first message of every stream. The manager fills in
	// the protocol version and the fingerprint.
	Hello func(ctx context.Context) *pb.Hello

	AgentVersion      string
	HeartbeatInterval time.Duration

	// ActiveLogSessions is reported in every heartbeat.
	ActiveLogSessions func() int
	// OnMessage receives every ServerMessage after the handshake. It runs on
	// the stream's goroutine and must not block.
	OnMessage func(*pb.ServerMessage)
	// OnConnection is called with true once the control plane has accepted the
	// stream and false when it ends.
	OnConnection func(connected bool)

	Backoff Backoff
	Logger  *slog.Logger
	Now     func() time.Time
	// DialOptions are appended to the dial options; tests use them.
	DialOptions []grpc.DialOption
}

// Manager owns the control-plane connection.
type Manager struct {
	opts   Options
	logger *slog.Logger

	outbox chan *pb.AgentMessage

	// refusedToken is the digest of a token the control plane refused to enrol with, so it is not retried.
	refusedToken string
}

// New validates the options and returns a manager.
func New(opts Options) (*Manager, error) {
	if opts.Address == "" || opts.Store == nil || opts.Fingerprint == nil || opts.Hello == nil {
		return nil, errors.New("gateway: Address, Store, Fingerprint and Hello are required")
	}
	if opts.HeartbeatInterval <= 0 {
		opts.HeartbeatInterval = 15 * time.Second
	}
	if opts.Backoff.Rand == nil {
		opts.Backoff = DefaultBackoff()
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	return &Manager{opts: opts, logger: opts.Logger, outbox: make(chan *pb.AgentMessage, 256)}, nil
}

// Send queues a message for the current stream. It returns false when the
// queue is full, which tells a producer to drop and resync rather than block
// (PLAN.md §5.6).
func (m *Manager) Send(msg *pb.AgentMessage) bool {
	if msg.GetMessageId() == "" {
		msg.MessageId = NewMessageID()
	}
	select {
	case m.outbox <- msg:
		return true
	default:
		return false
	}
}

// SendWait queues a message, waiting for room instead of failing. It is for
// producers that must not drop (the chunks of an inventory snapshot) and returns
// ctx's error if it gives up.
func (m *Manager) SendWait(ctx context.Context, msg *pb.AgentMessage) error {
	if msg.GetMessageId() == "" {
		msg.MessageId = NewMessageID()
	}
	select {
	case m.outbox <- msg:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// dropStaleInventory removes inventory messages left in the queue by an earlier
// stream. A new stream begins with a fresh snapshot that supersedes all of them,
// and a half-sent snapshot from the last stream would only confuse the server.
// Acks and results are kept: those are still owed.
func (m *Manager) dropStaleInventory() {
	var keep []*pb.AgentMessage
	for {
		select {
		case msg := <-m.outbox:
			// A log session does not survive its stream, so what is left of one is noise.
			// The bytes of a download are owed to a command and stay.
			session := msg.GetLogEnded() != nil || msg.GetLogChunk().GetSessionId() != ""
			if msg.GetSnapshot() == nil && msg.GetEvents() == nil && !session {
				keep = append(keep, msg)
			}
			continue
		default:
		}
		break
	}
	for _, msg := range keep {
		select {
		case m.outbox <- msg:
		default:
		}
	}
}

func (m *Manager) activeLogSessions() uint32 {
	if m.opts.ActiveLogSessions == nil {
		return 0
	}
	return uint32(max(0, m.opts.ActiveLogSessions())) //nolint:gosec // bounded by the session limit
}

// NewMessageID is a UUIDv7 message id (PLAN.md §5.2).
func NewMessageID() string {
	id, err := uuid.NewV7()
	if err != nil {
		return uuid.NewString()
	}
	return id.String()
}

// Run connects and stays connected until ctx ends. It returns nil on a
// graceful stop; any error it would return is retried instead, because an
// agent that gives up is an agent nobody can reach.
func (m *Manager) Run(ctx context.Context) error {
	attempt := 0
	for {
		started := m.opts.Now()
		err := m.session(ctx)
		if ctx.Err() != nil {
			// Shutting down: whatever ended the session is the shutdown itself.
			return nil //nolint:nilerr // a cancelled context is a graceful stop, not a failure
		}

		if m.opts.Now().Sub(started) >= stableAfter {
			attempt = 0
		}
		wait := m.opts.Backoff.Delay(attempt)
		attempt++

		m.logSessionEnd(err, wait)
		if status.Code(err) == codes.Unauthenticated {
			m.tryNewToken(ctx)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(wait):
		}
	}
}

// tryNewToken is the way back from a revoked identity. A cluster that was disabled and enabled again
// (or whose certificate was rotated) is refused with the certificate it holds; the operator's answer is
// a NEW bootstrap token in the chart values. Only then does the agent enrol again, and only with a token
// the stored identity was not enrolled with, so a spent token left in the values cannot start a loop. An
// identity that predates the record counts as "not enrolled with this token". A token that the control
// plane refused is not tried again until the process restarts. A working identity is never replaced:
// this runs only after the control plane has refused it.
func (m *Manager) tryNewToken(ctx context.Context) {
	token := m.opts.EnrollmentToken
	if token == "" {
		return
	}
	digest := identity.TokenDigest(token)
	if m.refusedToken == digest {
		return
	}
	if id, err := m.opts.Store.Load(ctx); err == nil && id.EnrolledWith == digest {
		return
	}
	if _, err := m.enroll(ctx); err != nil {
		m.refusedToken = digest
		m.logger.Warn("the stored identity was refused and enrolling with the configured token failed; give the chart a new token (enable or rotate in the UI)",
			"error", err)
	}
}

func (m *Manager) logSessionEnd(err error, wait time.Duration) {
	switch {
	case errors.Is(err, ErrNeedsEnrollment):
		m.logger.Error("not enrolled: set the bootstrap token from the install command",
			"retry_in", wait.String())
	case status.Code(err) == codes.Unauthenticated:
		// A revoked or rotated certificate, or a refused token. Retrying is
		// harmless and picks up a fixed Secret, but the operator must act.
		m.logger.Error("the control plane refused this agent's credentials; it may have been disabled, deleted or rotated",
			"retry_in", wait.String(), "reason", status.Convert(err).Message())
	default:
		m.logger.Warn("control-plane connection ended", "error", err, "retry_in", wait.String())
	}
}

// session runs one connection from enrollment (if needed) to disconnect.
func (m *Manager) session(ctx context.Context) error {
	id, err := m.ensureIdentity(ctx)
	if err != nil {
		return err
	}

	conn, err := m.dial(id)
	if err != nil {
		return err
	}
	defer func() { _ = conn.Close() }()
	m.dropStaleInventory()

	client := pb.NewAgentGatewayClient(conn)
	// Detached from ctx on purpose: cancelling ctx must not abort the RPC
	// before the graceful half-close below has been delivered. The loop watches
	// ctx itself, and the deferred cancel tears the stream down on every exit.
	streamCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	defer cancel()

	stream, err := client.Connect(streamCtx)
	if err != nil {
		return fmt.Errorf("open stream: %w", err)
	}

	fingerprint, err := m.opts.Fingerprint(ctx)
	if err != nil {
		return fmt.Errorf("read cluster fingerprint: %w", err)
	}
	hello := m.opts.Hello(ctx)
	hello.ProtocolVersion = ProtocolVersion
	hello.ClusterFingerprint = fingerprint
	if hello.AgentVersion == "" {
		hello.AgentVersion = m.opts.AgentVersion
	}
	if err := stream.Send(&pb.AgentMessage{
		MessageId: NewMessageID(),
		Payload:   &pb.AgentMessage_Hello{Hello: hello},
	}); err != nil {
		return err
	}

	// Receive on its own goroutine: Recv blocks, and the loop below also has
	// to send heartbeats and watch the renewal timer.
	type received struct {
		msg *pb.ServerMessage
		err error
	}
	incoming := make(chan received, 16)
	go func() {
		for {
			msg, err := stream.Recv()
			select {
			case incoming <- received{msg, err}:
			case <-streamCtx.Done():
				return
			}
			if err != nil {
				return
			}
		}
	}()

	interval := m.opts.HeartbeatInterval
	accepted := false
	ackDeadline := time.NewTimer(helloAckTimeout)
	defer ackDeadline.Stop()

	heartbeat := time.NewTicker(interval)
	defer heartbeat.Stop()
	renew := time.NewTimer(time.Until(id.RenewAt()))
	defer renew.Stop()

	defer func() {
		if accepted && m.opts.OnConnection != nil {
			m.opts.OnConnection(false)
		}
	}()

	for {
		select {
		case <-ctx.Done():
			// Graceful: half-close, then give the server a moment to end the
			// stream itself so it sees a clean close rather than an abort.
			_ = stream.CloseSend()
			drain := time.After(shutdownDrain)
			for {
				select {
				case r := <-incoming:
					if r.err != nil {
						// The server ended the stream, which is the clean close
						// we were waiting for; the error is that end, not a failure.
						return nil
					}
				case <-drain:
					return nil
				}
			}

		case <-ackDeadline.C:
			if !accepted {
				return errors.New("the control plane did not acknowledge Hello in time")
			}

		case r := <-incoming:
			if r.err != nil {
				return r.err
			}
			if ack := r.msg.GetHelloAck(); ack != nil && !accepted {
				accepted = true
				if d := ack.GetConfig().GetHeartbeatInterval().AsDuration(); d > 0 && d != interval {
					interval = d
					heartbeat.Reset(interval)
				}
				m.logger.Info("connected to the control plane",
					"protocol_version", ack.GetAcceptedProtocolVersion(),
					"heartbeat_interval", interval.String())
				if m.opts.OnConnection != nil {
					m.opts.OnConnection(true)
				}
				continue
			}
			if !accepted {
				return errors.New("the control plane sent a message before acknowledging Hello")
			}
			if m.opts.OnMessage != nil {
				m.opts.OnMessage(r.msg)
			}

		case <-heartbeat.C:
			if !accepted {
				continue
			}
			if err := stream.Send(&pb.AgentMessage{
				MessageId: NewMessageID(),
				Payload: &pb.AgentMessage_Heartbeat{Heartbeat: &pb.Heartbeat{
					SentAt:            timestamppb.New(m.opts.Now()),
					BufferedEvents:    uint32(len(m.outbox)), //nolint:gosec // bounded by the channel capacity
					ActiveLogSessions: m.activeLogSessions(),
				}},
			}); err != nil {
				return err
			}

		case msg := <-m.outbox:
			if !accepted {
				// Not connected yet: keep it for the stream that is.
				select {
				case m.outbox <- msg:
				default:
				}
				continue
			}
			if err := stream.Send(msg); err != nil {
				return err
			}

		case <-renew.C:
			renewed, err := m.renew(ctx, client, id)
			if err != nil {
				m.logger.Warn("certificate renewal failed; will retry", "error", err)
				renew.Reset(renewRetry)
				continue
			}
			id = renewed
			m.logger.Info("certificate renewed", "not_after", id.NotAfter.Format(time.RFC3339))
			renew.Reset(time.Until(id.RenewAt()))
		}
	}
}

// ensureIdentity loads the stored identity or, when there is none, enrolls.
func (m *Manager) ensureIdentity(ctx context.Context) (*identity.Identity, error) {
	id, err := m.opts.Store.Load(ctx)
	switch {
	case err == nil:
		if id.Expired(m.opts.Now()) {
			// An expired certificate cannot authenticate and cannot renew. The
			// operator needs a new token (rotate certificate in the UI).
			return nil, errors.New("the stored certificate has expired; enrol again with a new token")
		}
		return id, nil
	case !errors.Is(err, identity.ErrNotFound):
		return nil, err
	}

	if m.opts.EnrollmentToken == "" {
		return nil, ErrNeedsEnrollment
	}
	return m.enroll(ctx)
}

func (m *Manager) enroll(ctx context.Context) (*identity.Identity, error) {
	if len(m.opts.BootstrapCA) == 0 {
		return nil, errors.New("a control-plane CA bundle is required to enrol")
	}
	fingerprint, err := m.opts.Fingerprint(ctx)
	if err != nil {
		return nil, fmt.Errorf("read cluster fingerprint: %w", err)
	}
	keyPEM, csrPEM, err := identity.NewKeyAndCSR()
	if err != nil {
		return nil, err
	}

	conn, err := m.dialWith(m.opts.BootstrapCA, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = conn.Close() }()

	callCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	resp, err := pb.NewAgentGatewayClient(conn).Enroll(callCtx, &pb.EnrollRequest{
		BootstrapToken:     m.opts.EnrollmentToken,
		CsrPem:             csrPEM,
		ClusterFingerprint: fingerprint,
		AgentVersion:       m.opts.AgentVersion,
		ProtocolVersion:    ProtocolVersion,
	})
	if err != nil {
		return nil, fmt.Errorf("enroll: %w", err)
	}

	caPEM := resp.GetCaBundlePem()
	if len(caPEM) == 0 {
		caPEM = m.opts.BootstrapCA
	}
	id, err := identity.Parse(keyPEM, resp.GetCertificatePem(), caPEM)
	if err != nil {
		return nil, fmt.Errorf("the control plane returned an unusable identity: %w", err)
	}
	id.EnrolledWith = identity.TokenDigest(m.opts.EnrollmentToken)
	if err := m.opts.Store.Save(ctx, id); err != nil {
		// The token is spent and the certificate exists only in memory. Say
		// so loudly: an operator has to issue a new token if this process dies.
		return nil, fmt.Errorf("enrolled but could not persist the identity (the bootstrap token is now spent): %w", err)
	}
	m.logger.Info("enrolled", "cluster_id", id.ClusterID, "not_after", id.NotAfter.Format(time.RFC3339))
	return id, nil
}

func (m *Manager) renew(ctx context.Context, client pb.AgentGatewayClient, current *identity.Identity) (*identity.Identity, error) {
	keyPEM, csrPEM, err := identity.NewKeyAndCSR()
	if err != nil {
		return nil, err
	}
	callCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	resp, err := client.RenewCertificate(callCtx, &pb.RenewCertificateRequest{CsrPem: csrPEM})
	if err != nil {
		return nil, err
	}
	caPEM := resp.GetCaBundlePem()
	if len(caPEM) == 0 {
		caPEM = current.CAPEM
	}
	next, err := identity.Parse(keyPEM, resp.GetCertificatePem(), caPEM)
	if err != nil {
		return nil, err
	}
	// Renewing is not enrolling: it keeps the record of the token this cluster was enrolled with.
	next.EnrolledWith = current.EnrolledWith
	if next.ClusterID != current.ClusterID {
		return nil, errors.New("the renewed certificate names a different cluster")
	}
	if err := m.opts.Store.Save(ctx, next); err != nil {
		return nil, err
	}
	return next, nil
}

func (m *Manager) dial(id *identity.Identity) (*grpc.ClientConn, error) {
	cert, err := id.TLSCertificate()
	if err != nil {
		return nil, err
	}
	return m.dialWith(id.CAPEM, &cert)
}

// dialWith opens a channel that trusts only the given CA. A nil client
// certificate is for Enroll, which has none yet.
func (m *Manager) dialWith(caPEM []byte, cert *tls.Certificate) (*grpc.ClientConn, error) {
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		return nil, errors.New("the CA bundle contains no certificate")
	}
	serverName := m.opts.ServerName
	if serverName == "" {
		host, _, err := net.SplitHostPort(m.opts.Address)
		if err != nil {
			host = m.opts.Address
		}
		serverName = strings.Trim(host, "[]")
	}
	cfg := &tls.Config{
		MinVersion: tls.VersionTLS13,
		RootCAs:    pool,
		ServerName: serverName,
	}
	if cert != nil {
		cfg.Certificates = []tls.Certificate{*cert}
	}

	dialOpts := append([]grpc.DialOption{
		grpc.WithTransportCredentials(credentials.NewTLS(cfg)),
		grpc.WithDefaultCallOptions(
			grpc.MaxCallRecvMsgSize(maxMessageBytes),
			grpc.MaxCallSendMsgSize(maxMessageBytes),
		),
		grpc.WithKeepaliveParams(keepalive.ClientParameters{
			Time:                30 * time.Second,
			Timeout:             10 * time.Second,
			PermitWithoutStream: true,
		}),
	}, m.opts.DialOptions...)

	conn, err := grpc.NewClient(m.opts.Address, dialOpts...)
	if err != nil {
		return nil, fmt.Errorf("dial control plane: %w", err)
	}
	return conn, nil
}
