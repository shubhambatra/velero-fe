// Package loadtest is the fake-agent load simulator of PLAN.md §13 and §16 day 38.
//
// It runs many real agent connections (the production gateway.Manager over real mTLS,
// against a real control plane), a crowd of virtual browsers, and a command issuer, and
// measures the latencies PLAN §13 sets targets for.
package loadtest

import (
	"math"
	"sort"
	"sync"
	"time"
)

// Sample is one measurement, with when it was taken so the warm-up can be left out.
type Sample struct {
	At time.Time
	D  time.Duration
}

// Series collects latency samples and error counts for one named thing.
// Memory is bounded by the run's length and rate, which a five-minute run keeps small.
type Series struct {
	mu      sync.Mutex
	samples []Sample
	errors  int
	limited int // 429: reported apart, never a failure
	byCode  map[int]int
}

// Add records a successful measurement.
func (s *Series) Add(at time.Time, d time.Duration) {
	s.mu.Lock()
	s.samples = append(s.samples, Sample{At: at, D: d})
	s.mu.Unlock()
}

// Fail records a failure with its HTTP status (0 for a transport error).
func (s *Series) Fail(status int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.byCode == nil {
		s.byCode = map[int]int{}
	}
	s.byCode[status]++
	if status == 429 {
		s.limited++
		return
	}
	s.errors++
}

// Summary is the percentiles of a series, in milliseconds.
type Summary struct {
	Count   int         `json:"count"`
	P50     float64     `json:"p50Ms"`
	P95     float64     `json:"p95Ms"`
	P99     float64     `json:"p99Ms"`
	Max     float64     `json:"maxMs"`
	Mean    float64     `json:"meanMs"`
	Errors  int         `json:"errors"`
	Limited int         `json:"rateLimited"`
	Codes   map[int]int `json:"statusCodes,omitempty"`
}

// Summarize computes the summary of the samples taken at or after `from`.
func (s *Series) Summarize(from time.Time) Summary {
	s.mu.Lock()
	ds := make([]time.Duration, 0, len(s.samples))
	for _, x := range s.samples {
		if !x.At.Before(from) {
			ds = append(ds, x.D)
		}
	}
	out := Summary{Errors: s.errors, Limited: s.limited}
	if len(s.byCode) > 0 {
		out.Codes = map[int]int{}
		for k, v := range s.byCode {
			out.Codes[k] = v
		}
	}
	s.mu.Unlock()
	return summarize(ds, out)
}

func summarize(ds []time.Duration, base Summary) Summary {
	base.Count = len(ds)
	if len(ds) == 0 {
		return base
	}
	sort.Slice(ds, func(i, j int) bool { return ds[i] < ds[j] })
	var sum time.Duration
	for _, d := range ds {
		sum += d
	}
	base.P50 = ms(Percentile(ds, 50))
	base.P95 = ms(Percentile(ds, 95))
	base.P99 = ms(Percentile(ds, 99))
	base.Max = ms(ds[len(ds)-1])
	base.Mean = ms(sum / time.Duration(len(ds)))
	return base
}

// Percentile is the nearest-rank percentile of an ascending slice: the smallest value
// such that at least p percent of the values are at or below it. p is in (0, 100].
func Percentile(sorted []time.Duration, p float64) time.Duration {
	if len(sorted) == 0 {
		return 0
	}
	rank := int(math.Ceil(p / 100 * float64(len(sorted))))
	return sorted[min(max(rank, 1), len(sorted))-1]
}

func ms(d time.Duration) float64 { return math.Round(float64(d)/float64(time.Microsecond)) / 1000 }

// Registry holds the named series of a run.
type Registry struct {
	mu     sync.Mutex
	series map[string]*Series
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry { return &Registry{series: map[string]*Series{}} }

// Get returns the series with this name, creating it.
func (r *Registry) Get(name string) *Series {
	r.mu.Lock()
	defer r.mu.Unlock()
	s, ok := r.series[name]
	if !ok {
		s = &Series{}
		r.series[name] = s
	}
	return s
}

// Names returns the series names, sorted.
func (r *Registry) Names() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, 0, len(r.series))
	for k := range r.series {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
