package loadtest

import (
	"bytes"
	"strings"
	"testing"
)

func TestEvaluateTargets(t *testing.T) {
	series := map[string]Summary{
		"command to agent": {Count: 10, P95: 400},
		"event to browser": {Count: 10, P95: 3500},
		"GET backups":      {Count: 10, P95: 120},
		"GET clusters":     {Count: 10, P95: 310},
		"GET fleet":        {Count: 10, P95: 50, Errors: 1},
		"GET pods":         {Count: 0},
	}
	ag := AgentReport{PeakConnected: 200, StormDropped: 200, StormBackS: 12}
	got := map[string]Target{}
	for _, tg := range Evaluate(series, ag, 200, 100) {
		got[tg.Name] = tg
	}
	want := map[string]bool{
		"command reaches agent":            true,
		"inventory change reaches browser": false,
		"GET backups":                      true,
		"GET clusters":                     false,
		"GET fleet":                        false, // errors fail it
		"GET pods":                         false, // no samples
		"agents connected":                 true,
		"reconnect storm recovers":         true,
	}
	for name, pass := range want {
		tg, ok := got[name]
		if !ok || tg.Pass != pass {
			t.Errorf("%s: got %+v, want pass=%v", name, tg, pass)
		}
	}
	ag.StormBackS = 75
	for _, tg := range Evaluate(series, ag, 200, 100) {
		if tg.Name == "reconnect storm recovers" && tg.Pass {
			t.Error("a 75 s recovery passed")
		}
	}
}

func TestReportText(t *testing.T) {
	r := Report{
		Series:  map[string]Summary{"GET fleet": {Count: 3, P50: 1, P95: 2, P99: 3, Max: 4}},
		Targets: []Target{{Name: "x", Limit: "l", Measured: "m", Pass: false}},
		Notes:   []string{"boom"},
	}
	var b bytes.Buffer
	r.Text(&b)
	for _, s := range []string{"GET fleet", "[FAIL]", "boom"} {
		if !strings.Contains(b.String(), s) {
			t.Errorf("report lacks %q:\n%s", s, b.String())
		}
	}
	if r.AllPass() {
		t.Error("AllPass with a failing target")
	}
}
