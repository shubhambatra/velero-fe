package loadtest

import (
	"errors"
	"time"
)

// Config is every knob of a run.
type Config struct {
	Fixture      string
	Duration     time.Duration
	Warmup       time.Duration
	Agents       int
	Users        int
	Pods         int
	BigPods      int
	VeleroObjs   int
	Nodes        int
	Namespaces   int
	EventsPerSec float64
	CommandRate  float64
	UserThink    time.Duration
	StormAt      time.Duration
	Ramp         time.Duration
	PodThreshold int
	Report       string
	ServerPID    int
	Seed         int64
}

// DefaultConfig is PLAN §13's scale.
func DefaultConfig() Config {
	return Config{
		Duration: 5 * time.Minute, Warmup: 45 * time.Second,
		Agents: 200, Users: 100, Pods: 300, BigPods: 5000, VeleroObjs: 250,
		Nodes: 20, Namespaces: 60,
		EventsPerSec: 0.5, CommandRate: 5, UserThink: time.Second,
		StormAt: -1, Ramp: 30 * time.Second, PodThreshold: 20_000, Seed: 1,
	}
}

// Normalize fills derived defaults and checks the values.
func (c *Config) Normalize(f *Fixture) error {
	if c.StormAt < 0 {
		c.StormAt = c.Duration * 6 / 10
	}
	if c.Agents <= 0 || c.Agents > len(f.Clusters) {
		if c.Agents > len(f.Clusters) {
			return errors.New("--agents is more than the fixture has clusters")
		}
		c.Agents = len(f.Clusters)
	}
	if c.Users < 0 || c.Users > len(f.Users) {
		if c.Users > len(f.Users) {
			return errors.New("--users is more than the fixture has users")
		}
		c.Users = len(f.Users)
	}
	if c.Duration <= 0 {
		return errors.New("--duration must be positive")
	}
	if c.Warmup >= c.Duration {
		c.Warmup = c.Duration / 4
	}
	if c.StormAt >= c.Duration {
		c.StormAt = c.Duration / 2
	}
	if c.Pods < 0 || c.BigPods < 0 || c.VeleroObjs < 0 || c.Nodes < 1 || c.Namespaces < 2 {
		return errors.New("pods, big-pods, velero-objects, nodes and namespaces must be sensible")
	}
	return nil
}
