package loadtest

import (
	"context"
	"io"
	"log/slog"
	"sync"
	"time"
)

// Run executes a whole load test against the fixture's control plane and returns the report.
func Run(ctx context.Context, fx *Fixture, cfg Config, progress io.Writer) (Report, error) {
	if err := cfg.Normalize(fx); err != nil {
		return Report{}, err
	}
	now := time.Now()
	hub := NewHub(now)
	slog.SetDefault(slog.New(countingHandler{hub: hub}))
	say := func(f string, a ...any) {
		if progress != nil {
			pf(progress, "[%6.1fs] "+f+"\n", append([]any{time.Since(now).Seconds()}, a...)...)
		}
	}

	agents := make([]*Agent, 0, cfg.Agents)
	for i := 0; i < cfg.Agents; i++ {
		a, err := NewAgent(i, fx, cfg, hub, now)
		if err != nil {
			return Report{}, err
		}
		agents = append(agents, a)
	}
	say("built %d simulated clusters", len(agents))

	runCtx, stop := context.WithTimeout(ctx, cfg.Duration)
	defer stop()
	client := newHTTP()
	var wg sync.WaitGroup
	spawn := func(f func()) { wg.Add(1); go func() { defer wg.Done(); f() }() }

	proc := NewProcSampler(cfg.ServerPID)
	spawn(func() { proc.Run(runCtx, time.Second) })
	poller := NewPoller(fx, hub, client)
	spawn(func() { poller.Run(runCtx, time.Second) })

	for i, a := range agents {
		delay := time.Duration(0)
		if len(agents) > 1 {
			delay = cfg.Ramp * time.Duration(i) / time.Duration(len(agents))
		}
		spawn(func() { a.Run(runCtx, delay) })
	}

	// Users arrive once the ramp is over, so list latencies are not measured against a
	// server still ingesting every first snapshot.
	rampEnd := now.Add(cfg.Ramp)
	spawn(func() {
		if !sleep(runCtx, time.Until(rampEnd)) {
			return
		}
		say("starting %d browsers", cfg.Users)
		var uw sync.WaitGroup
		for i := 0; i < cfg.Users; i++ {
			u := NewUser(i, fx, cfg, hub, client)
			uw.Add(1)
			go func() { defer uw.Done(); u.Run(runCtx) }()
		}
		uw.Wait()
	})
	issuer := NewIssuer(fx, cfg, hub, client, agents)
	spawn(func() {
		if sleep(runCtx, time.Until(rampEnd)) {
			issuer.Run(runCtx)
		}
	})

	rep := AgentReport{Started: len(agents)}
	var repMu sync.Mutex

	// Ramp: when every agent is connected and its inventory applied by the server.
	spawn(func() {
		c, s := waitAll(runCtx, agents, poller, now, time.Time{})
		repMu.Lock()
		rep.RampConnectS, rep.RampSyncedS = c, s
		repMu.Unlock()
		say("ramp: all connected %.1fs, all synced %.1fs", c, s)
	})

	// Reconnect storm.
	var stormAt time.Time
	spawn(func() {
		if cfg.StormAt <= 0 || !sleep(runCtx, cfg.StormAt) {
			return
		}
		stormAt = time.Now()
		for _, a := range agents {
			a.DropConnections()
		}
		say("storm: cut every agent connection")
		c, s := waitAll(runCtx, agents, poller, stormAt, stormAt)
		var ds []time.Duration
		for _, a := range agents {
			if lc := a.LastConnected(); lc.After(stormAt) {
				ds = append(ds, lc.Sub(stormAt))
			}
		}
		ds = sortedDurations(ds)
		repMu.Lock()
		rep.StormDropped = len(agents)
		rep.StormBackS, rep.StormSyncedS = c, s
		if len(ds) > 0 {
			rep.StormP95S = Percentile(ds, 95).Seconds()
		}
		repMu.Unlock()
		say("storm: all reconnected %.1fs, all synced %.1fs", c, s)
	})

	<-runCtx.Done()
	wg.Wait()
	say("done")

	from := now.Add(cfg.Ramp + cfg.Warmup)
	series := map[string]Summary{}
	for _, n := range hub.Reg.Names() {
		series[n] = hub.Reg.Get(n).Summarize(from)
	}
	repMu.Lock()
	defer repMu.Unlock()
	rep.PeakConnected = hub.peakConnected.Load()
	for _, a := range agents {
		rep.Commands += a.Commands()
	}
	r := Report{
		StartedAt: now,
		Config: map[string]any{
			"agents": cfg.Agents, "users": cfg.Users, "duration": cfg.Duration.String(), "warmup": cfg.Warmup.String(),
			"ramp": cfg.Ramp.String(), "stormAt": cfg.StormAt.String(), "pods": cfg.Pods, "bigPods": cfg.BigPods,
			"velero": cfg.VeleroObjs, "nodes": cfg.Nodes, "namespaces": cfg.Namespaces,
			"eventsPerSecPerCluster": cfg.EventsPerSec, "commandsPerSec": cfg.CommandRate,
			"userThink": cfg.UserThink.String(), "seed": cfg.Seed,
		},
		Agents: rep, Series: series, Server: proc.Stats(), Notes: hub.Notes(),
		EventsEmitted: hub.Events.Total(), SSEReconnects: hub.sseReconnects.Load(),
		AgentErrors: hub.agentErrors.Load(), AgentWarnings: hub.agentWarnings.Load(),
	}
	r.Targets = Evaluate(series, rep, cfg.Agents, cfg.Users)
	return r, nil
}

// waitAll returns seconds after `since` until every agent is connected (again) and until
// the server shows every cluster's inventory applied after `syncedAfter`; 0 means it never was.
func waitAll(ctx context.Context, agents []*Agent, p *Poller, since, syncedAfter time.Time) (connected, synced float64) {
	t := time.NewTicker(100 * time.Millisecond)
	defer t.Stop()
	for {
		allUp, allSynced := true, true
		for _, a := range agents {
			if !a.Connected() || !a.LastConnected().After(since.Add(-time.Nanosecond)) {
				allUp = false
			}
			v, ok := p.View(a.ClusterID())
			if !ok || v.SyncedAt.IsZero() || v.SyncedAt.Before(syncedAfter) {
				allSynced = false
			}
		}
		if allUp && connected == 0 {
			connected = time.Since(since).Seconds()
		}
		if allUp && allSynced {
			return connected, time.Since(since).Seconds()
		}
		select {
		case <-ctx.Done():
			return connected, 0
		case <-t.C:
		}
	}
}
