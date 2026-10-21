package loadtest

import (
	"testing"
	"time"
)

func durations(ms ...int) []time.Duration {
	out := make([]time.Duration, len(ms))
	for i, m := range ms {
		out[i] = time.Duration(m) * time.Millisecond
	}
	return out
}

func TestPercentileIsNearestRank(t *testing.T) {
	ten := durations(10, 20, 30, 40, 50, 60, 70, 80, 90, 100)
	for p, want := range map[float64]int{50: 50, 90: 90, 95: 100, 99: 100, 100: 100, 10: 10, 11: 20} {
		if got := Percentile(ten, p); got != time.Duration(want)*time.Millisecond {
			t.Errorf("p%v = %v, want %dms", p, got, want)
		}
	}
	if Percentile(nil, 95) != 0 {
		t.Error("an empty series has no percentile")
	}
	if got := Percentile(durations(7), 99); got != 7*time.Millisecond {
		t.Errorf("one sample: %v", got)
	}
	// 100 samples: p95 is the 95th value exactly.
	hundred := make([]time.Duration, 100)
	for i := range hundred {
		hundred[i] = time.Duration(i+1) * time.Millisecond
	}
	if got := Percentile(hundred, 95); got != 95*time.Millisecond {
		t.Errorf("p95 of 1..100 = %v", got)
	}
}

func TestSummaryLeavesTheWarmupOutAndKeepsFailuresApart(t *testing.T) {
	var s Series
	start := time.Unix(1000, 0)
	s.Add(start, 5*time.Second) // warm-up: slow, and must not count
	for i := 1; i <= 100; i++ {
		s.Add(start.Add(time.Minute), time.Duration(i)*time.Millisecond)
	}
	s.Fail(500)
	s.Fail(0)
	s.Fail(429)
	s.Fail(429)
	sum := s.Summarize(start.Add(time.Second))
	if sum.Count != 100 || sum.P95 != 95 || sum.P50 != 50 || sum.Max != 100 {
		t.Fatalf("%+v", sum)
	}
	if sum.Errors != 2 || sum.Limited != 2 {
		t.Fatalf("429s are not errors: %+v", sum)
	}
	if sum.Codes[429] != 2 || sum.Codes[500] != 1 {
		t.Fatalf("%+v", sum.Codes)
	}
	all := s.Summarize(time.Time{})
	if all.Count != 101 || all.Max != 5000 {
		t.Fatalf("%+v", all)
	}
}

func TestRegistryGivesOneSeriesPerName(t *testing.T) {
	r := NewRegistry()
	a1 := r.Get("a")
	if a1 != r.Get("a") || a1 == r.Get("b") {
		t.Fatal("series are not shared by name")
	}
	if got := r.Names(); len(got) != 2 || got[0] != "a" {
		t.Fatalf("%v", got)
	}
}

func TestConfigNormalize(t *testing.T) {
	f := &Fixture{Clusters: make([]FixtureCluster, 10), Users: make([]FixtureUser, 5)}
	c := DefaultConfig()
	c.Agents, c.Users = 0, 5
	if err := c.Normalize(f); err != nil {
		t.Fatal(err)
	}
	if c.Agents != 10 || c.Users != 5 || c.StormAt != 3*time.Minute {
		t.Fatalf("%+v", c)
	}
	c = DefaultConfig()
	c.Agents = 11
	if err := c.Normalize(f); err == nil {
		t.Fatal("more agents than clusters must be refused")
	}
	c = DefaultConfig()
	c.Agents, c.Users = 3, 2
	c.Duration, c.Warmup = 20*time.Second, time.Minute
	if err := c.Normalize(f); err != nil || c.Warmup != 5*time.Second {
		t.Fatalf("%v %+v", err, c)
	}
}
