package identity

import (
	"bytes"
	"testing"
)

// FuzzParse: arbitrary key, certificate and CA bytes never panic, and nothing that is not
// a matching key and certificate with a cluster identity is ever accepted.
func FuzzParse(f *testing.F) {
	key, csr, err := NewKeyAndCSR()
	if err != nil {
		f.Fatal(err)
	}
	f.Add(key, csr, csr)
	f.Add([]byte{}, []byte{}, []byte{})
	f.Add([]byte("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n"), []byte("-----BEGIN PRIVATE KEY-----\n"), []byte("x"))
	f.Add(bytes.Repeat([]byte("-----BEGIN CERTIFICATE-----\n"), 2000), key, key)
	f.Add([]byte("\x00\xff"), []byte("\x30\x82\xff\xff"), []byte("-----BEGIN-----"))
	f.Fuzz(func(t *testing.T, keyPEM, certPEM, caPEM []byte) {
		id, err := Parse(keyPEM, certPEM, caPEM)
		if err != nil {
			if id != nil {
				t.Fatal("an error with an identity")
			}
			return
		}
		if id.ClusterID == "" {
			t.Fatal("accepted an identity with no cluster id")
		}
		if !id.NotAfter.After(id.NotBefore) && !id.NotAfter.Equal(id.NotBefore) {
			t.Fatal("a certificate that ends before it starts")
		}
		if _, err := id.TLSCertificate(); err != nil {
			t.Fatalf("accepted an identity that cannot make a TLS certificate: %v", err)
		}
	})
}
