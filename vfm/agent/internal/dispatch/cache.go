package dispatch

import (
	"bytes"
	"compress/gzip"
	"container/list"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

// CacheSize is how many executed command ids the agent remembers (PLAN.md §5.4).
const CacheSize = 10_000

// maxPersistedBytes keeps the persisted cache under a ConfigMap's 1 MiB limit with
// room for the object's own metadata.
const maxPersistedBytes = 900 * 1024

const stateKey = "results.json.gz"

// Outcome is what is remembered about a finished command: enough to answer a
// re-delivery with the same result without running it again. It is deliberately
// small — it is persisted, and it never contains anything an agent must not keep.
type Outcome struct {
	OK           bool      `json:"ok"`
	ErrorCode    int32     `json:"code,omitempty"`
	ErrorMessage string    `json:"msg,omitempty"`
	FinishedAt   time.Time `json:"at"`
	// Detail is the op-specific result, already encoded as a protobuf `Any`-free
	// JSON blob by the handler.
	Detail json.RawMessage `json:"detail,omitempty"`
}

type entry struct {
	id      string
	outcome Outcome
}

// Cache is a fixed-size LRU of command outcomes, safe for concurrent use.
type Cache struct {
	mu    sync.Mutex
	max   int
	order *list.List
	items map[string]*list.Element
	dirty bool
}

// NewCache returns a cache holding at most max entries.
func NewCache(max int) *Cache {
	return &Cache{max: max, order: list.New(), items: make(map[string]*list.Element, max)}
}

// Get returns the remembered outcome and refreshes its recency.
func (c *Cache) Get(id string) (Outcome, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	el, ok := c.items[id]
	if !ok {
		return Outcome{}, false
	}
	c.order.MoveToFront(el)
	entry, _ := el.Value.(*entry)
	return entry.outcome, true
}

// Put records an outcome, evicting the least recently used when full.
func (c *Cache) Put(id string, outcome Outcome) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.dirty = true
	if el, ok := c.items[id]; ok {
		el.Value = &entry{id: id, outcome: outcome}
		c.order.MoveToFront(el)
		return
	}
	c.items[id] = c.order.PushFront(&entry{id: id, outcome: outcome})
	for c.order.Len() > c.max {
		oldest := c.order.Back()
		old, _ := oldest.Value.(*entry)
		delete(c.items, old.id)
		c.order.Remove(oldest)
	}
}

// Len is the number of remembered commands.
func (c *Cache) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.order.Len()
}

type persisted struct {
	// Newest first, so truncating to fit drops the oldest.
	Entries []persistedEntry `json:"entries"`
}

type persistedEntry struct {
	ID string `json:"id"`
	Outcome
}

// encode serialises the cache newest-first and gzips it, dropping the oldest
// entries until it fits in a ConfigMap.
func (c *Cache) encode() ([]byte, error) {
	c.mu.Lock()
	all := make([]persistedEntry, 0, c.order.Len())
	for el := c.order.Front(); el != nil; el = el.Next() {
		e, _ := el.Value.(*entry)
		all = append(all, persistedEntry{ID: e.id, Outcome: e.outcome})
	}
	c.mu.Unlock()

	for {
		raw, err := json.Marshal(persisted{Entries: all})
		if err != nil {
			return nil, err
		}
		var buf bytes.Buffer
		zw := gzip.NewWriter(&buf)
		if _, err := zw.Write(raw); err != nil {
			return nil, err
		}
		if err := zw.Close(); err != nil {
			return nil, err
		}
		if buf.Len() <= maxPersistedBytes || len(all) == 0 {
			return buf.Bytes(), nil
		}
		all = all[:len(all)*9/10]
	}
}

func (c *Cache) decode(data []byte) error {
	zr, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return fmt.Errorf("decompress: %w", err)
	}
	defer func() { _ = zr.Close() }()
	// Bounded: a corrupt or hostile ConfigMap must not exhaust memory.
	raw, err := io.ReadAll(io.LimitReader(zr, 16<<20))
	if err != nil {
		return fmt.Errorf("decompress: %w", err)
	}
	var p persisted
	if err := json.Unmarshal(raw, &p); err != nil {
		return fmt.Errorf("decode: %w", err)
	}
	// Oldest first, so the newest ends up most recent.
	for i := len(p.Entries) - 1; i >= 0; i-- {
		c.Put(p.Entries[i].ID, p.Entries[i].Outcome)
	}
	c.mu.Lock()
	c.dirty = false
	c.mu.Unlock()
	return nil
}

// Store persists the cache to a ConfigMap, so a restarted agent still recognises a
// command the control plane re-delivers (PLAN.md §5.4).
type Store struct {
	Client    kubernetes.Interface
	Namespace string
	Name      string
}

// Load fills cache from the ConfigMap. A missing one is an empty cache; a corrupt
// one is reported but never blocks startup — the worst case is that a duplicate is
// executed again, which creation by label (idempotent objects) already tolerates.
func (s *Store) Load(ctx context.Context, cache *Cache) error {
	cm, err := s.Client.CoreV1().ConfigMaps(s.Namespace).Get(ctx, s.Name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read state ConfigMap: %w", err)
	}
	data, ok := cm.BinaryData[stateKey]
	if !ok {
		return nil
	}
	return cache.decode(data)
}

// Save writes the cache if anything changed since the last save.
func (s *Store) Save(ctx context.Context, cache *Cache) error {
	cache.mu.Lock()
	dirty := cache.dirty
	cache.mu.Unlock()
	if !dirty {
		return nil
	}
	data, err := cache.encode()
	if err != nil {
		return err
	}

	cms := s.Client.CoreV1().ConfigMaps(s.Namespace)
	existing, err := cms.Get(ctx, s.Name, metav1.GetOptions{})
	switch {
	case apierrors.IsNotFound(err):
		_, err = cms.Create(ctx, &corev1.ConfigMap{
			ObjectMeta: metav1.ObjectMeta{Name: s.Name, Namespace: s.Namespace},
			BinaryData: map[string][]byte{stateKey: data},
		}, metav1.CreateOptions{})
	case err != nil:
		return fmt.Errorf("read state ConfigMap: %w", err)
	default:
		existing.BinaryData = map[string][]byte{stateKey: data}
		_, err = cms.Update(ctx, existing, metav1.UpdateOptions{})
	}
	if err != nil {
		return fmt.Errorf("write state ConfigMap: %w", err)
	}
	cache.mu.Lock()
	cache.dirty = false
	cache.mu.Unlock()
	return nil
}

// Run saves the cache every interval until ctx ends, then once more.
func (s *Store) Run(ctx context.Context, cache *Cache, interval time.Duration, onError func(error)) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			// A fresh context: ctx is already cancelled.
			flush, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			if err := s.Save(flush, cache); err != nil && !errors.Is(err, context.Canceled) {
				onError(err)
			}
			cancel()
			return
		case <-ticker.C:
			if err := s.Save(ctx, cache); err != nil {
				onError(err)
			}
		}
	}
}
