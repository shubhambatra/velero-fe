// Package identity holds the agent's cryptographic identity: a locally
// generated ECDSA P-256 key, the certificate the control plane signed for it,
// and the CA the agent pins the control plane to (PLAN.md §5.1).
//
// The private key is generated in the cluster and never leaves it; only a CSR
// is sent. Persisting the identity is the job of a [Store], which in a cluster
// is a Secret in the agent's namespace.
package identity

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"strings"
	"time"
)

// ErrNotFound is returned by [Store.Load] when nothing has been enrolled yet.
var ErrNotFound = errors.New("no agent identity stored")

const spiffePrefix = "spiffe://vfm/cluster/"

// Identity is a parsed, validated agent identity.
type Identity struct {
	KeyPEM  []byte
	CertPEM []byte
	CAPEM   []byte

	// ClusterID, NotBefore and NotAfter are read from the certificate, not
	// trusted from the Secret around it.
	ClusterID string
	NotBefore time.Time
	NotAfter  time.Time
}

// Parse validates the three PEM blocks belong together and extracts the
// cluster identity from the certificate's SPIFFE SAN.
func Parse(keyPEM, certPEM, caPEM []byte) (*Identity, error) {
	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return nil, fmt.Errorf("certificate and key do not match: %w", err)
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		return nil, fmt.Errorf("parse certificate: %w", err)
	}

	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		return nil, errors.New("the CA bundle contains no certificate")
	}

	clusterID := ""
	for _, uri := range leaf.URIs {
		if id, ok := strings.CutPrefix(uri.String(), spiffePrefix); ok {
			clusterID = id
		}
	}
	if clusterID == "" {
		return nil, errors.New("the certificate carries no cluster identity")
	}

	return &Identity{
		KeyPEM:    keyPEM,
		CertPEM:   certPEM,
		CAPEM:     caPEM,
		ClusterID: clusterID,
		NotBefore: leaf.NotBefore,
		NotAfter:  leaf.NotAfter,
	}, nil
}

// TLSCertificate returns the certificate and key for a TLS client handshake.
func (i *Identity) TLSCertificate() (tls.Certificate, error) {
	return tls.X509KeyPair(i.CertPEM, i.KeyPEM)
}

// RenewAt is when the certificate should be renewed: two thirds of the way
// through its lifetime (PLAN.md §5.1 step 5).
func (i *Identity) RenewAt() time.Time {
	lifetime := i.NotAfter.Sub(i.NotBefore)
	return i.NotBefore.Add(lifetime * 2 / 3)
}

// Expired reports whether the certificate is past its validity.
func (i *Identity) Expired(now time.Time) bool { return !now.Before(i.NotAfter) }

// NewKeyAndCSR generates a fresh ECDSA P-256 key and a PEM CSR for it. The CSR
// subject is cosmetic: the control plane ignores everything in it but the
// public key and stamps the identity itself.
func NewKeyAndCSR() (keyPEM, csrPEM []byte, err error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, fmt.Errorf("generate key: %w", err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, nil, fmt.Errorf("marshal key: %w", err)
	}
	csr, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{
		Subject:            pkix.Name{CommonName: "vfm-agent"},
		SignatureAlgorithm: x509.ECDSAWithSHA256,
	}, key)
	if err != nil {
		return nil, nil, fmt.Errorf("create CSR: %w", err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}),
		pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: csr}),
		nil
}
