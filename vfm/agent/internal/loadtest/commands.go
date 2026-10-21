package loadtest

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"math/rand/v2"
	"net/http"
	"strings"
	"time"
)

// Issuer sends commands the way the UI does and measures how long they take to reach an
// agent (PLAN §13: under a second at the 95th percentile) and to finish.
type Issuer struct {
	fx     *Fixture
	cfg    Config
	hub    *Hub
	client *http.Client
	agents []*Agent
	rng    *rand.Rand
}

// NewIssuer returns the command issuer.
func NewIssuer(fx *Fixture, cfg Config, hub *Hub, client *http.Client, agents []*Agent) *Issuer {
	return &Issuer{fx: fx, cfg: cfg, hub: hub, client: client, agents: agents,
		rng: rand.New(rand.NewPCG(uint64(cfg.Seed), 77))} //nolint:gosec // a seed
}

// Run issues commands at the configured rate until ctx ends.
func (i *Issuer) Run(ctx context.Context) {
	if i.cfg.CommandRate <= 0 || len(i.agents) == 0 {
		return
	}
	every := time.Duration(float64(time.Second) / i.cfg.CommandRate)
	t := time.NewTicker(every)
	defer t.Stop()
	n := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			n++
			a := i.agents[i.rng.IntN(len(i.agents))]
			if !a.Connected() {
				i.hub.Reg.Get("command skipped (agent offline)").Fail(0)
				continue
			}
			go i.one(ctx, a, n%5 == 0)
		}
	}
}

func (i *Issuer) base() string { return strings.TrimRight(i.fx.APIBase, "/") }

func (i *Issuer) one(ctx context.Context, a *Agent, followToEnd bool) {
	http1 := i.hub.Reg.Get("POST refresh-status")
	toAgent := i.hub.Reg.Get("command to agent")
	rctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	url := i.base() + "/orgs/" + i.fx.OrgID + "/clusters/" + a.ClusterID() + "/refresh-status"
	req, err := http.NewRequestWithContext(rctx, http.MethodPost, url, bytes.NewReader([]byte("{}")))
	if err != nil {
		return
	}
	req.Header.Set("Cookie", i.fx.AdminCookie)
	req.Header.Set("x-csrf-token", i.fx.AdminCSRF)
	req.Header.Set("Content-Type", "application/json")
	t0 := time.Now()
	resp, err := i.client.Do(req)
	if err != nil {
		if ctx.Err() == nil {
			http1.Fail(0)
		}
		return
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		http1.Fail(resp.StatusCode)
		if resp.StatusCode != http.StatusTooManyRequests {
			i.hub.Note("POST refresh-status: HTTP " + http.StatusText(resp.StatusCode))
		}
		return
	}
	http1.Add(t0, time.Since(t0))
	var view struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(body, &view) != nil || view.ID == "" {
		return
	}

	// The agent may have seen the command before the answer came back; if not, wait for it.
	deadline := time.Now().Add(10 * time.Second)
	for {
		if seen, ok := i.hub.CommandSeenAt(view.ID); ok {
			toAgent.Add(t0, seen.Sub(t0))
			break
		}
		if time.Now().After(deadline) || ctx.Err() != nil {
			toAgent.Fail(0)
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	if followToEnd {
		i.untilFinished(ctx, a, view.ID, t0)
	}
}

// untilFinished polls the command until the control plane says it succeeded.
func (i *Issuer) untilFinished(ctx context.Context, a *Agent, id string, t0 time.Time) {
	series := i.hub.Reg.Get("command to succeeded")
	url := i.base() + "/orgs/" + i.fx.OrgID + "/clusters/" + a.ClusterID() + "/commands/" + id
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) && ctx.Err() == nil {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return
		}
		req.Header.Set("Cookie", i.fx.AdminCookie)
		resp, err := i.client.Do(req)
		if err != nil {
			return
		}
		var out struct {
			Status string `json:"status"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&out)
		_ = resp.Body.Close()
		switch out.Status {
		case "SUCCEEDED":
			series.Add(t0, time.Since(t0))
			return
		case "FAILED", "TIMED_OUT", "CANCELLED", "REJECTED":
			series.Fail(0)
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	series.Fail(0)
}
