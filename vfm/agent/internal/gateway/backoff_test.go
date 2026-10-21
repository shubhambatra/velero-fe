package gateway

import (
	"testing"
	"time"
)

func TestBackoffGrowsCapsAndKeepsAFloor(t *testing.T) {
	max := func() float64 { return 0.999999 }
	min := func() float64 { return 0 }
	b := Backoff{Min: time.Second, Max: time.Minute, Factor: 2, Rand: max}

	prev := time.Duration(0)
	for attempt := range 10 {
		d := b.Delay(attempt)
		if d > time.Minute {
			t.Errorf("attempt %d: %v exceeds the cap", attempt, d)
		}
		if d < prev {
			t.Errorf("attempt %d: %v shrank from %v at the ceiling", attempt, d, prev)
		}
		prev = d
	}
	if prev < 59*time.Second {
		t.Errorf("never reached the cap: %v", prev)
	}

	b.Rand = min
	if d := b.Delay(5); d != 500*time.Millisecond {
		t.Errorf("a zero jitter draw must still wait Min/2, got %v", d)
	}
}

func TestBackoffSpreadsAgentsOut(t *testing.T) {
	b := DefaultBackoff()
	seen := map[time.Duration]bool{}
	for range 50 {
		seen[b.Delay(6)] = true
	}
	if len(seen) < 10 {
		t.Errorf("only %d distinct delays across 50 draws: agents would reconnect in lockstep", len(seen))
	}
}
