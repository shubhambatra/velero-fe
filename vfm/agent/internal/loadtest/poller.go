package loadtest

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// ClusterView is what the control plane says of one cluster.
type ClusterView struct {
	Status   string
	SyncedAt time.Time
	SeenAt   time.Time // when the poller read it
}

// Poller watches the fleet as an administrator would, to learn from the server's side
// when each cluster is connected and when its inventory has been applied.
type Poller struct {
	fx     *Fixture
	hub    *Hub
	client *http.Client

	mu    sync.Mutex
	views map[string]ClusterView
}

// NewPoller returns a poller of the fleet.
func NewPoller(fx *Fixture, hub *Hub, client *http.Client) *Poller {
	return &Poller{fx: fx, hub: hub, client: client, views: map[string]ClusterView{}}
}

// Run polls until ctx ends.
func (p *Poller) Run(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		p.once(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (p *Poller) once(ctx context.Context) {
	rctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(rctx, http.MethodGet, strings.TrimRight(p.fx.APIBase, "/")+"/orgs/"+p.fx.OrgID+"/fleet", nil)
	if err != nil {
		return
	}
	req.Header.Set("Cookie", p.fx.AdminCookie)
	start := time.Now()
	resp, err := p.client.Do(req)
	series := p.hub.Reg.Get("admin fleet poll")
	if err != nil {
		if ctx.Err() == nil {
			series.Fail(0)
		}
		return
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		series.Fail(resp.StatusCode)
		return
	}
	series.Add(start, time.Since(start))
	var out struct {
		Clusters []struct {
			ID       string  `json:"id"`
			Status   string  `json:"status"`
			SyncedAt *string `json:"syncedAt"`
		} `json:"clusters"`
	}
	if json.Unmarshal(body, &out) != nil {
		return
	}
	now := time.Now()
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, c := range out.Clusters {
		v := ClusterView{Status: c.Status, SeenAt: now}
		if c.SyncedAt != nil {
			if t, err := time.Parse(time.RFC3339Nano, *c.SyncedAt); err == nil {
				v.SyncedAt = t
			}
		}
		p.views[c.ID] = v
	}
}

// View is the latest reading of a cluster.
func (p *Poller) View(id string) (ClusterView, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	v, ok := p.views[id]
	return v, ok
}
