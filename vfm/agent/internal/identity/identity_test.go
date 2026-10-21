package identity

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"net/url"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

const clusterID = "0194f9d2-0000-7000-8000-00000000c001"

// issue builds a CA and a client certificate for `key`, as the control plane would.
func issue(t *testing.T, keyPEM []byte, spiffe string, notBefore, notAfter time.Time) (certPEM, caPEM []byte) {
	t.Helper()
	caKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	caTmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "ca"},
		NotBefore: notBefore, NotAfter: notAfter.Add(time.Hour), IsCA: true, BasicConstraintsValid: true,
		KeyUsage: x509.KeyUsageCertSign,
	}
	caDER, _ := x509.CreateCertificate(rand.Reader, caTmpl, caTmpl, &caKey.PublicKey, caKey)
	ca, _ := x509.ParseCertificate(caDER)

	block, _ := pem.Decode(keyPEM)
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	pub := &parsed.(*ecdsa.PrivateKey).PublicKey

	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "agent"},
		NotBefore: notBefore, NotAfter: notAfter,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	if spiffe != "" {
		u, _ := url.Parse(spiffe)
		tmpl.URIs = []*url.URL{u}
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca, pub, caKey)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})
}

func TestNewKeyAndCSRIsAVerifiableP256Request(t *testing.T) {
	keyPEM, csrPEM, err := NewKeyAndCSR()
	if err != nil {
		t.Fatal(err)
	}
	block, _ := pem.Decode(csrPEM)
	csr, err := x509.ParseCertificateRequest(block.Bytes)
	if err != nil || csr.CheckSignature() != nil {
		t.Fatalf("CSR does not verify: %v", err)
	}
	pub, ok := csr.PublicKey.(*ecdsa.PublicKey)
	if !ok || pub.Curve != elliptic.P256() {
		t.Fatalf("CSR key is not ECDSA P-256: %T", csr.PublicKey)
	}
	if strings.Contains(string(csrPEM), "PRIVATE") {
		t.Error("the CSR carries private key material")
	}
	if !strings.Contains(string(keyPEM), "PRIVATE KEY") {
		t.Error("key PEM is not a private key")
	}

	other, _, _ := NewKeyAndCSR()
	if string(other) == string(keyPEM) {
		t.Error("two enrollments produced the same key")
	}
}

func TestParseReadsTheClusterFromTheCertificateAndDerivesRenewal(t *testing.T) {
	keyPEM, _, _ := NewKeyAndCSR()
	start := time.Now().Add(-time.Hour).Truncate(time.Second)
	end := start.Add(3 * time.Hour)
	certPEM, caPEM := issue(t, keyPEM, "spiffe://vfm/cluster/"+clusterID, start, end)

	id, err := Parse(keyPEM, certPEM, caPEM)
	if err != nil {
		t.Fatal(err)
	}
	if id.ClusterID != clusterID {
		t.Errorf("cluster id = %q", id.ClusterID)
	}
	if want := start.Add(2 * time.Hour); !id.RenewAt().Equal(want) {
		t.Errorf("renew at %v, want two thirds of the way: %v", id.RenewAt(), want)
	}
	if id.Expired(end.Add(-time.Second)) || !id.Expired(end) {
		t.Error("Expired is off by one")
	}
	if _, err := id.TLSCertificate(); err != nil {
		t.Errorf("TLSCertificate: %v", err)
	}
}

func TestParseRefusesWhatDoesNotBelongTogether(t *testing.T) {
	keyPEM, _, _ := NewKeyAndCSR()
	otherKey, _, _ := NewKeyAndCSR()
	start := time.Now().Add(-time.Hour)
	certPEM, caPEM := issue(t, keyPEM, "spiffe://vfm/cluster/"+clusterID, start, start.Add(time.Hour*24))
	noIdentity, _ := issue(t, keyPEM, "", start, start.Add(time.Hour*24))

	cases := map[string]struct{ key, cert, ca []byte }{
		"a certificate for a different key":      {otherKey, certPEM, caPEM},
		"a certificate with no cluster identity": {keyPEM, noIdentity, caPEM},
		"an empty CA bundle":                     {keyPEM, certPEM, []byte("nothing")},
	}
	for name, c := range cases {
		if _, err := Parse(c.key, c.cert, c.ca); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
}

func TestSecretStoreRoundTripsAndTreatsAnEmptySecretAsNotEnrolled(t *testing.T) {
	ctx := context.Background()
	cs := fake.NewClientset()
	store := &SecretStore{Client: cs, Namespace: "vfm-system", Name: "vfm-agent-credentials"}

	if _, err := store.Load(ctx); !errors.Is(err, ErrNotFound) {
		t.Fatalf("no Secret should be ErrNotFound, got %v", err)
	}

	// The chart pre-creates an empty Secret so RBAC can name it.
	_, _ = cs.CoreV1().Secrets("vfm-system").Create(ctx, &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "vfm-agent-credentials", Namespace: "vfm-system"},
	}, metav1.CreateOptions{})
	if _, err := store.Load(ctx); !errors.Is(err, ErrNotFound) {
		t.Fatalf("an empty Secret should be ErrNotFound, got %v", err)
	}

	keyPEM, _, _ := NewKeyAndCSR()
	start := time.Now().Add(-time.Minute)
	certPEM, caPEM := issue(t, keyPEM, "spiffe://vfm/cluster/"+clusterID, start, start.Add(time.Hour))
	id, _ := Parse(keyPEM, certPEM, caPEM)
	if err := store.Save(ctx, id); err != nil {
		t.Fatal(err)
	}
	got, err := store.Load(ctx)
	if err != nil || got.ClusterID != clusterID {
		t.Fatalf("round trip failed: %v %+v", err, got)
	}

	// Saving again replaces rather than failing on the existing Secret.
	if err := store.Save(ctx, id); err != nil {
		t.Errorf("second save: %v", err)
	}
	secret, _ := cs.CoreV1().Secrets("vfm-system").Get(ctx, "vfm-agent-credentials", metav1.GetOptions{})
	if secret.Type != "" && secret.Type != corev1.SecretTypeTLS {
		t.Errorf("secret type = %q", secret.Type)
	}
}

func TestSecretStoreReportsACorruptSecretInsteadOfTreatingItAsEmpty(t *testing.T) {
	ctx := context.Background()
	cs := fake.NewClientset(&corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "c", Namespace: "n"},
		Data:       map[string][]byte{keyKey: []byte("garbage"), keyCert: []byte("garbage")},
	})
	_, err := (&SecretStore{Client: cs, Namespace: "n", Name: "c"}).Load(ctx)
	if err == nil || errors.Is(err, ErrNotFound) {
		t.Fatalf("a corrupt Secret must be an error (re-enrolling would burn a token), got %v", err)
	}
}

func TestMemoryStore(t *testing.T) {
	m := &MemoryStore{}
	if _, err := m.Load(context.Background()); !errors.Is(err, ErrNotFound) {
		t.Fatal("empty store should be ErrNotFound")
	}
	if err := m.Save(context.Background(), nil); err == nil {
		t.Error("saving nil succeeded")
	}
}

// A CA rotation hands the agent a bundle of two CAs with its next certificate. The agent must keep the
// whole bundle through a restart and trust a certificate from either CA, or it would drop off the
// moment the control plane promotes the new one.
func TestACaBundleOfTwoAuthoritiesIsKeptAndTrustsBoth(t *testing.T) {
	keyPEM, _, _ := NewKeyAndCSR()
	start := time.Now().Add(-time.Minute)
	spiffe := "spiffe://vfm/cluster/" + clusterID
	certA, caA := issue(t, keyPEM, spiffe, start, start.Add(time.Hour))
	certB, caB := issue(t, keyPEM, spiffe, start, start.Add(time.Hour))
	bundle := append(append([]byte{}, caA...), caB...)

	id, err := Parse(keyPEM, certA, bundle)
	if err != nil {
		t.Fatalf("a two-CA bundle was refused: %v", err)
	}
	store := &SecretStore{Client: fake.NewClientset(), Namespace: "vfm-system", Name: "vfm-agent-credentials"}
	if err := store.Save(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	loaded, err := store.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if string(loaded.CAPEM) != string(bundle) {
		t.Fatal("the stored identity lost part of the CA bundle")
	}

	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(loaded.CAPEM) {
		t.Fatal("the bundle did not load as a pool")
	}
	for name, certPEM := range map[string][]byte{"first CA": certA, "second CA": certB} {
		block, _ := pem.Decode(certPEM)
		leaf, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := leaf.Verify(x509.VerifyOptions{Roots: pool, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}); err != nil {
			t.Errorf("a certificate from the %s is not trusted: %v", name, err)
		}
	}
}

func TestTheTokenDigestSurvivesTheSecretAndLeavesNoTokenBehind(t *testing.T) {
	ctx := context.Background()
	cs := fake.NewClientset()
	store := &SecretStore{Client: cs, Namespace: "vfm-system", Name: "vfm-agent-credentials"}
	keyPEM, _, _ := NewKeyAndCSR()
	start := time.Now().Add(-time.Minute)
	certPEM, caPEM := issue(t, keyPEM, "spiffe://vfm/cluster/"+clusterID, start, start.Add(time.Hour))
	id, _ := Parse(keyPEM, certPEM, caPEM)
	id.EnrolledWith = TokenDigest("the-secret-bootstrap-token")
	if err := store.Save(ctx, id); err != nil {
		t.Fatal(err)
	}
	got, err := store.Load(ctx)
	if err != nil || got.EnrolledWith != id.EnrolledWith {
		t.Fatalf("the digest did not survive the Secret: %v %q", err, got.EnrolledWith)
	}
	secret, _ := cs.CoreV1().Secrets("vfm-system").Get(ctx, "vfm-agent-credentials", metav1.GetOptions{})
	for k, v := range secret.Data {
		if strings.Contains(string(v), "the-secret-bootstrap-token") {
			t.Errorf("the token itself is in the Secret under %q; only its digest may be", k)
		}
	}
	first := TokenDigest("a")
	if first == TokenDigest("b") || first != TokenDigest("a") {
		t.Error("the digest is not a stable function of the token")
	}
}
