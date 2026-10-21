package loadtest

import (
	"fmt"
	"io"
	"sort"
	"strings"
	"time"
)

// Target is one PLAN §13 line checked against a measurement.
type Target struct {
	Name     string  `json:"name"`
	Limit    string  `json:"limit"`
	Measured string  `json:"measured"`
	Pass     bool    `json:"pass"`
	Note     string  `json:"note,omitempty"`
	value    float64 // for tests
}

// Report is everything a run produced.
type Report struct {
	StartedAt     time.Time          `json:"startedAt"`
	Config        map[string]any     `json:"config"`
	Agents        AgentReport        `json:"agents"`
	Series        map[string]Summary `json:"series"`
	Targets       []Target           `json:"targets"`
	Server        ProcStats          `json:"server"`
	Notes         []string           `json:"notes,omitempty"`
	EventsEmitted int                `json:"eventsEmitted"`
	SSEReconnects int64              `json:"sseReconnects"`
	AgentErrors   int64              `json:"agentErrors"`
	AgentWarnings int64              `json:"agentWarnings"`
}

// AgentReport is the fleet-side picture: connection, ramp and storm.
type AgentReport struct {
	Started       int     `json:"started"`
	PeakConnected int64   `json:"peakConnected"`
	RampConnectS  float64 `json:"rampAllConnectedSeconds"`
	RampSyncedS   float64 `json:"rampAllSyncedSeconds"`
	StormDropped  int     `json:"stormDropped"`
	StormBackS    float64 `json:"stormAllReconnectedSeconds"`
	StormP95S     float64 `json:"stormReconnectP95Seconds"`
	StormSyncedS  float64 `json:"stormAllSyncedSeconds"`
	Commands      int64   `json:"commandsExecuted"`
}

// Thresholds are PLAN §13 in milliseconds/seconds.
const (
	ListP95Ms      = 300.0
	CommandP95Ms   = 1000.0
	EventP95Ms     = 3000.0
	ReconnectLimit = 60.0
)

// Evaluate applies the targets to the series and the storm.
func Evaluate(series map[string]Summary, ag AgentReport, wantAgents, wantUsers int) []Target {
	var out []Target
	for _, n := range ListEndpointNames() {
		s, ok := series[n]
		if !ok || s.Count == 0 {
			out = append(out, Target{Name: n, Limit: "p95 < 300 ms", Measured: "no samples", Pass: false})
			continue
		}
		note := ""
		if s.Errors > 0 {
			note = fmt.Sprintf("%d errors", s.Errors)
		}
		out = append(out, Target{Name: n, Limit: "p95 < 300 ms", Measured: fmt.Sprintf("p95 %.1f ms (n=%d)", s.P95, s.Count),
			Pass: s.P95 < ListP95Ms && s.Errors == 0, Note: note, value: s.P95})
	}
	one := func(name, series_ string, limit float64) {
		s, ok := series[series_]
		if !ok || s.Count == 0 {
			out = append(out, Target{Name: name, Limit: fmt.Sprintf("p95 < %.0f ms", limit), Measured: "no samples"})
			return
		}
		out = append(out, Target{Name: name, Limit: fmt.Sprintf("p95 < %.0f ms", limit),
			Measured: fmt.Sprintf("p95 %.1f ms (n=%d)", s.P95, s.Count), Pass: s.P95 < limit, value: s.P95})
	}
	one("command reaches agent", "command to agent", CommandP95Ms)
	one("inventory change reaches browser", "event to browser", EventP95Ms)

	out = append(out, Target{Name: "agents connected", Limit: fmt.Sprintf("%d agents", wantAgents),
		Measured: fmt.Sprintf("peak %d", ag.PeakConnected), Pass: int(ag.PeakConnected) >= wantAgents})
	if ag.StormDropped > 0 {
		out = append(out, Target{Name: "reconnect storm recovers", Limit: "all back within 60 s",
			Measured: fmt.Sprintf("%.1f s", ag.StormBackS), Pass: ag.StormBackS > 0 && ag.StormBackS <= ReconnectLimit, value: ag.StormBackS})
	}
	_ = wantUsers
	return out
}

// Text writes the report for people.
func (r Report) Text(w io.Writer) {
	pf(w, "VFM load test, started %s\n\n", r.StartedAt.Format(time.RFC3339))
	a := r.Agents
	pf(w, "agents: %d started, peak %d connected; ramp: all connected %.1f s, all synced %.1f s\n",
		a.Started, a.PeakConnected, a.RampConnectS, a.RampSyncedS)
	if a.StormDropped > 0 {
		pf(w, "storm: %d connections cut; all reconnected %.1f s (p95 %.1f s), all synced %.1f s\n",
			a.StormDropped, a.StormBackS, a.StormP95S, a.StormSyncedS)
	}
	pf(w, "commands executed by agents: %d; inventory changes emitted: %d; browser stream reconnects: %d\n",
		a.Commands, r.EventsEmitted, r.SSEReconnects)
	if r.Server.PID > 0 {
		pf(w, "server pid %d: cpu avg %.1f%% peak %.1f%%; rss %.0f -> peak %.0f -> %.0f MB (%d samples)\n",
			r.Server.PID, r.Server.CPUAvgPct, r.Server.CPUPeakPct, r.Server.RSSStartMB, r.Server.RSSPeakMB, r.Server.RSSEndMB, r.Server.Samples)
	}
	pf(w, "\n%-34s %7s %8s %8s %8s %8s %6s %6s\n", "series", "n", "p50 ms", "p95 ms", "p99 ms", "max ms", "err", "429")
	names := make([]string, 0, len(r.Series))
	for n := range r.Series {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		s := r.Series[n]
		pf(w, "%-34s %7d %8.1f %8.1f %8.1f %8.1f %6d %6d\n", n, s.Count, s.P50, s.P95, s.P99, s.Max, s.Errors, s.Limited)
	}
	pf(w, "\ntargets (PLAN §13):\n")
	for _, t := range r.Targets {
		mark := "PASS"
		if !t.Pass {
			mark = "FAIL"
		}
		pf(w, "  [%s] %-34s %-22s %s %s\n", mark, t.Name, t.Limit, t.Measured, t.Note)
	}
	if len(r.Notes) > 0 {
		pf(w, "\nfirst distinct problems seen:\n  %s\n", strings.Join(r.Notes, "\n  "))
	}
}

// AllPass is whether every target held.
func (r Report) AllPass() bool {
	for _, t := range r.Targets {
		if !t.Pass {
			return false
		}
	}
	return true
}

// pf is Fprintf for a report: a failed write to the terminal has nowhere to be reported.
func pf(w io.Writer, format string, a ...any) { _, _ = fmt.Fprintf(w, format, a...) }
