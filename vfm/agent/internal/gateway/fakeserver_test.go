package gateway

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"io"
	"math/big"
	"net"
	"net/url"
	"sync"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/durationpb"
	"google.golang.org/protobuf/types/known/timestamppb"

	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
)

const testClusterID = "0194f9d2-0000-7000-8000-00000000c001"

// testCA is a throwaway CA standing in for the control plane's.
type testCA struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
	pem  []byte
}

func newTestCA(t *testing.T) *testCA {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "test CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, _ := x509.ParseCertificate(der)
	return &testCA{cert: cert, key: key, pem: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})}
}

func (c *testCA) serverCert(t *testing.T) tls.Certificate {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: "localhost"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		DNSNames:     []string{"localhost"},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		KeyUsage:     x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, c.cert, &key.PublicKey, c.key)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

// signCSR issues a client certificate for the CSR's public key, valid for
// `lifetime`, with the cluster's SPIFFE identity.
func (c *testCA) signCSR(t *testing.T, csrPEM []byte, lifetime time.Duration) []byte {
	t.Helper()
	block, _ := pem.Decode(csrPEM)
	csr, err := x509.ParseCertificateRequest(block.Bytes)
	if err != nil || csr.CheckSignature() != nil {
		t.Fatalf("bad CSR: %v", err)
	}
	id, _ := url.Parse("spiffe://vfm/cluster/" + testClusterID)
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: "agent"},
		NotBefore:    time.Now().Add(-time.Second),
		NotAfter:     time.Now().Add(lifetime),
		URIs:         []*url.URL{id},
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
		KeyUsage:     x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, c.cert, csr.PublicKey, c.key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}

// fakeGateway is an in-process control plane over real gRPC and real TLS.
type fakeGateway struct {
	pb.UnimplementedAgentGatewayServer

	t        *testing.T
	ca       *testCA
	addr     string
	srv      *grpc.Server
	lifetime time.Duration

	mu         sync.Mutex
	token      string
	enrolls    int
	renews     int
	connects   int
	hellos     []*pb.Hello
	heartbeats int
	// dropAfterHello closes the stream right after acknowledging, once.
	dropAfterHello bool
	// refuseConnect answers Connect with this code instead of serving it.
	refuseConnect  codes.Code
	heartbeatEvery time.Duration
	closedByClient chan struct{}
}

func startFakeGateway(t *testing.T, ca *testCA, serverCA *testCA) *fakeGateway {
	t.Helper()
	if serverCA == nil {
		serverCA = ca
	}
	pool := x509.NewCertPool()
	pool.AddCert(ca.cert)
	creds := credentials.NewTLS(&tls.Config{
		MinVersion:   tls.VersionTLS13,
		Certificates: []tls.Certificate{serverCA.serverCert(t)},
		ClientCAs:    pool,
		ClientAuth:   tls.VerifyClientCertIfGiven,
	})
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	g := &fakeGateway{
		t: t, ca: ca, addr: lis.Addr().String(), lifetime: 7 * 24 * time.Hour,
		token: "bootstrap-token", heartbeatEvery: 50 * time.Millisecond,
		closedByClient: make(chan struct{}, 8),
	}
	g.srv = grpc.NewServer(grpc.Creds(creds))
	pb.RegisterAgentGatewayServer(g.srv, g)
	go func() { _ = g.srv.Serve(lis) }()
	t.Cleanup(g.srv.Stop)
	return g
}

func (g *fakeGateway) Enroll(_ context.Context, req *pb.EnrollRequest) (*pb.EnrollResponse, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.enrolls++
	if req.GetBootstrapToken() != g.token {
		return nil, status.Error(codes.Unauthenticated, "invalid or expired bootstrap token")
	}
	cert := g.ca.signCSR(g.t, req.GetCsrPem(), g.lifetime)
	return &pb.EnrollResponse{
		ClusterId:      testClusterID,
		CertificatePem: cert,
		CaBundlePem:    g.ca.pem,
		NotAfter:       timestamppb.New(time.Now().Add(g.lifetime)),
	}, nil
}

func (g *fakeGateway) RenewCertificate(ctx context.Context, req *pb.RenewCertificateRequest) (*pb.RenewCertificateResponse, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.renews++
	return &pb.RenewCertificateResponse{
		CertificatePem: g.ca.signCSR(g.t, req.GetCsrPem(), g.lifetime),
		CaBundlePem:    g.ca.pem,
	}, nil
}

func (g *fakeGateway) Connect(stream grpc.BidiStreamingServer[pb.AgentMessage, pb.ServerMessage]) error {
	g.mu.Lock()
	g.connects++
	refuse := g.refuseConnect
	drop := g.dropAfterHello
	g.dropAfterHello = false
	every := g.heartbeatEvery
	g.mu.Unlock()

	if refuse != codes.OK {
		return status.Error(refuse, "refused")
	}
	first, err := stream.Recv()
	if err != nil {
		return err
	}
	g.mu.Lock()
	g.hellos = append(g.hellos, first.GetHello())
	g.mu.Unlock()

	if err := stream.Send(&pb.ServerMessage{
		MessageId: "ack",
		Payload: &pb.ServerMessage_HelloAck{HelloAck: &pb.HelloAck{
			AcceptedProtocolVersion: ProtocolVersion,
			Config:                  &pb.ServerConfig{HeartbeatInterval: durationpb.New(every)},
		}},
	}); err != nil {
		return err
	}
	if drop {
		return status.Error(codes.Unavailable, "server going away")
	}
	for {
		msg, err := stream.Recv()
		if errors.Is(err, io.EOF) {
			g.closedByClient <- struct{}{}
			return nil
		}
		if err != nil {
			return err
		}
		if msg.GetHeartbeat() != nil {
			g.mu.Lock()
			g.heartbeats++
			g.mu.Unlock()
		}
	}
}

func (g *fakeGateway) snapshot() (enrolls, renews, connects, heartbeats int) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.enrolls, g.renews, g.connects, g.heartbeats
}

// configure changes the fake's behaviour under its lock, so a test that tunes it
// after it started serving does not race with the handlers.
func (g *fakeGateway) configure(change func()) {
	g.mu.Lock()
	defer g.mu.Unlock()
	change()
}
