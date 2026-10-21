package gateway

import (
	"math/rand/v2"
	"time"
)

// Backoff computes reconnect delays: exponential growth with full jitter, so a
// control plane restart does not bring every agent back in the same instant.
type Backoff struct {
	Min, Max time.Duration
	Factor   float64
	// Rand returns a value in [0, 1). Injected so tests are deterministic.
	Rand func() float64
}

// DefaultBackoff is 1 s growing to 60 s.
func DefaultBackoff() Backoff {
	return Backoff{Min: time.Second, Max: time.Minute, Factor: 2, Rand: rand.Float64} //nolint:gosec // jitter, not a secret
}

// Delay is the wait before attempt number `attempt` (0 for the first retry).
// It is uniform in (0, ceiling] where the ceiling doubles each attempt up to
// Max, and is never below Min/2 so a hot loop cannot form.
func (b Backoff) Delay(attempt int) time.Duration {
	ceiling := float64(b.Min)
	for range attempt {
		ceiling *= b.Factor
		if ceiling >= float64(b.Max) {
			ceiling = float64(b.Max)
			break
		}
	}
	jittered := time.Duration(ceiling * b.Rand())
	if floor := b.Min / 2; jittered < floor {
		return floor
	}
	return jittered
}
