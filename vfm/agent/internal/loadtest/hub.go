package loadtest

import (
	"context"
	"log/slog"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// Hub is what the parts of a run share: the series, the record of when each cluster
// emitted a change, and when each command reached an agent.
type Hub struct {
	Start time.Time
	Reg   *Registry

	Events *EmissionLog
	// cmdRecv is when an agent first saw each command id.
	cmdRecv sync.Map

	connected     atomic.Int64
	peakConnected atomic.Int64
	agentErrors   atomic.Int64
	agentWarnings atomic.Int64
	userStreams   atomic.Int64
	peakStreams   atomic.Int64
	sseReconnects atomic.Int64

	noteMu sync.Mutex
	notes  []string // the first few distinct error messages, for the report
}

// NewHub starts the clock of a run.
func NewHub(now time.Time) *Hub {
	return &Hub{Start: now, Reg: NewRegistry(), Events: NewEmissionLog()}
}

// Connected adjusts the number of connected agents and tracks the peak.
func (h *Hub) Connected(delta int64) {
	n := h.connected.Add(delta)
	for {
		p := h.peakConnected.Load()
		if n <= p || h.peakConnected.CompareAndSwap(p, n) {
			return
		}
	}
}

// Streams adjusts the number of open browser event streams and tracks the peak.
func (h *Hub) Streams(delta int64) {
	n := h.userStreams.Add(delta)
	for {
		p := h.peakStreams.Load()
		if n <= p || h.peakStreams.CompareAndSwap(p, n) {
			return
		}
	}
}

// Note keeps an error message for the report, at most a handful of distinct ones.
func (h *Hub) Note(msg string) {
	h.noteMu.Lock()
	defer h.noteMu.Unlock()
	if len(h.notes) >= 8 {
		return
	}
	for _, n := range h.notes {
		if n == msg {
			return
		}
	}
	h.notes = append(h.notes, msg)
}

// Notes returns the kept messages.
func (h *Hub) Notes() []string {
	h.noteMu.Lock()
	defer h.noteMu.Unlock()
	return append([]string(nil), h.notes...)
}

// CommandSeen records the first time an agent saw a command.
func (h *Hub) CommandSeen(id string, at time.Time) { h.cmdRecv.LoadOrStore(id, at) }

// CommandSeenAt returns when an agent first saw it.
func (h *Hub) CommandSeenAt(id string) (time.Time, bool) {
	v, ok := h.cmdRecv.Load(id)
	if !ok {
		return time.Time{}, false
	}
	t, _ := v.(time.Time)
	return t, true
}

// EmissionLog records when each cluster sent a batch of changes, so the time a browser
// took to hear of each can be measured.
type EmissionLog struct {
	mu   sync.Mutex
	byID map[string][]time.Time
}

// NewEmissionLog returns an empty log.
func NewEmissionLog() *EmissionLog { return &EmissionLog{byID: map[string][]time.Time{}} }

// Emitted records a batch sent now by this cluster.
func (e *EmissionLog) Emitted(cluster string, at time.Time) {
	e.mu.Lock()
	e.byID[cluster] = append(e.byID[cluster], at)
	e.mu.Unlock()
}

// Times returns the emissions of a cluster from index `from`, oldest first, and how many
// there are in all.
func (e *EmissionLog) Times(cluster string, from int) ([]time.Time, int) {
	e.mu.Lock()
	defer e.mu.Unlock()
	all := e.byID[cluster]
	if from >= len(all) {
		return nil, len(all)
	}
	return append([]time.Time(nil), all[from:]...), len(all)
}

// Total is the number of emissions of every cluster.
func (e *EmissionLog) Total() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	n := 0
	for _, v := range e.byID {
		n += len(v)
	}
	return n
}

// Matcher turns the arrivals of one browser's event stream into latencies.
//
// The control plane tells a browser only that "something changed on cluster X", and it may
// fold several changes into one message. So an arrival at time t is credited to every
// emission of that cluster not yet credited that happened before t: each of them reached
// the browser, at the latest, then. That is the honest upper bound of how long each took.
type Matcher struct {
	log  *EmissionLog
	next map[string]int // per cluster: the first emission not yet credited
}

// NewMatcher returns a matcher for one browser.
func NewMatcher(log *EmissionLog) *Matcher { return &Matcher{log: log, next: map[string]int{}} }

// Arrived credits an arrival and returns the latencies it settles.
func (m *Matcher) Arrived(cluster string, at time.Time) []time.Duration {
	times, total := m.log.Times(cluster, m.next[cluster])
	var out []time.Duration
	used := 0
	for _, t := range times {
		if t.After(at) {
			break
		}
		out = append(out, at.Sub(t))
		used++
	}
	m.next[cluster] += used
	_ = total
	return out
}

// countingHandler is the agents' logger: it keeps no log, only counts what went wrong.
type countingHandler struct{ hub *Hub }

func (h countingHandler) Enabled(_ context.Context, l slog.Level) bool { return l >= slog.LevelWarn }
func (h countingHandler) Handle(_ context.Context, r slog.Record) error {
	if r.Level >= slog.LevelError {
		h.hub.agentErrors.Add(1)
		h.hub.Note("agent: " + r.Message)
	} else {
		h.hub.agentWarnings.Add(1)
	}
	return nil
}
func (h countingHandler) WithAttrs([]slog.Attr) slog.Handler { return h }
func (h countingHandler) WithGroup(string) slog.Handler      { return h }

// sortedDurations is a sorted copy.
func sortedDurations(in []time.Duration) []time.Duration {
	out := append([]time.Duration(nil), in...)
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}
