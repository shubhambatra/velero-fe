package identity

import (
	"context"
	"errors"
	"fmt"
	"sync"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

// Store persists the agent's identity across restarts.
type Store interface {
	// Load returns [ErrNotFound] when the agent has never enrolled.
	Load(ctx context.Context) (*Identity, error)
	Save(ctx context.Context, id *Identity) error
}

// Keys of the credentials Secret. They follow the kubernetes.io/tls
// convention so the Secret is recognisable to anyone inspecting the namespace.
const (
	keyKey  = "tls.key"
	keyCert = "tls.crt"
	keyCA   = "ca.crt"
)

// SecretStore keeps the identity in a Secret in the agent's namespace
// (PLAN.md §5.1 step 3). The agent's RBAC grants it access to this one Secret
// by name and nothing else (PLAN.md §12.2).
type SecretStore struct {
	Client    kubernetes.Interface
	Namespace string
	Name      string
}

var _ Store = (*SecretStore)(nil)

// Load implements [Store].
func (s *SecretStore) Load(ctx context.Context) (*Identity, error) {
	secret, err := s.Client.CoreV1().Secrets(s.Namespace).Get(ctx, s.Name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("read credentials secret: %w", err)
	}
	if len(secret.Data[keyCert]) == 0 || len(secret.Data[keyKey]) == 0 {
		// A Secret created empty by the chart (so RBAC can name it) means
		// "not enrolled yet", not an error.
		return nil, ErrNotFound
	}
	id, err := Parse(secret.Data[keyKey], secret.Data[keyCert], secret.Data[keyCA])
	if err != nil {
		return nil, fmt.Errorf("credentials secret is unusable: %w", err)
	}
	return id, nil
}

// Save implements [Store], creating the Secret when it does not exist.
func (s *SecretStore) Save(ctx context.Context, id *Identity) error {
	secrets := s.Client.CoreV1().Secrets(s.Namespace)
	data := map[string][]byte{keyKey: id.KeyPEM, keyCert: id.CertPEM, keyCA: id.CAPEM}

	existing, err := secrets.Get(ctx, s.Name, metav1.GetOptions{})
	switch {
	case apierrors.IsNotFound(err):
		_, err = secrets.Create(ctx, &corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{Name: s.Name, Namespace: s.Namespace},
			Type:       corev1.SecretTypeTLS,
			Data:       data,
		}, metav1.CreateOptions{})
	case err != nil:
		return fmt.Errorf("read credentials secret: %w", err)
	default:
		existing.Data = data
		_, err = secrets.Update(ctx, existing, metav1.UpdateOptions{})
	}
	if err != nil {
		return fmt.Errorf("write credentials secret: %w", err)
	}
	return nil
}

// MemoryStore is an in-process [Store] for tests and for `-dev` runs where
// writing a Secret would be surprising.
type MemoryStore struct {
	mu sync.Mutex
	id *Identity
}

var _ Store = (*MemoryStore)(nil)

// Load implements [Store].
func (m *MemoryStore) Load(context.Context) (*Identity, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.id == nil {
		return nil, ErrNotFound
	}
	return m.id, nil
}

// Save implements [Store].
func (m *MemoryStore) Save(_ context.Context, id *Identity) error {
	if id == nil {
		return errors.New("nil identity")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.id = id
	return nil
}
