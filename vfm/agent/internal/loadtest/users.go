package loadtest

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"strings"
	"sync"
	"time"
)

// newHTTP is the client the virtual browsers and the command issuer share.
func newHTTP() *http.Client {
	return &http.Client{Transport: &http.Transport{
		MaxIdleConns: 1024, MaxIdleConnsPerHost: 1024, MaxConnsPerHost: 0,
		IdleConnTimeout: 90 * time.Second, DisableCompression: false,
	}}
}

// Listing endpoints a browser loops over, with the weight a person's clicks give them.
// {o} is the org and {c} a cluster the user happens to be looking at.
var listEndpoints = []struct {
	name   string
	path   string
	weight int
}{
	{"GET clusters", "/orgs/{o}/clusters", 3},
	{"GET fleet", "/orgs/{o}/fleet", 3},
	{"GET cluster overview", "/orgs/{o}/clusters/{c}/overview", 4},
	{"GET backups", "/orgs/{o}/clusters/{c}/backups?limit=50", 5},
	{"GET restores", "/orgs/{o}/clusters/{c}/restores?limit=50", 2},
	{"GET schedules", "/orgs/{o}/clusters/{c}/schedules?limit=50", 2},
	{"GET namespaces", "/orgs/{o}/clusters/{c}/inventory/namespaces?limit=100", 2},
	{"GET pods", "/orgs/{o}/clusters/{c}/inventory/pods?limit=100", 3},
	{"GET audit", "/orgs/{o}/audit?limit=50", 1},
}

// reportEndpoints are limited to 30 a minute per person across all three; a browser
// pages through them slowly.
var reportEndpoints = []struct{ name, path string }{
	{"GET report success-rate", "/orgs/{o}/reports/success-rate"},
	{"GET report coverage", "/orgs/{o}/reports/coverage"},
	{"GET report rpo", "/orgs/{o}/reports/rpo"},
}

const reportEvery = 4 * time.Second

// ListEndpointNames are the series the 300 ms target applies to.
func ListEndpointNames() []string {
	out := make([]string, 0, len(listEndpoints))
	for _, e := range listEndpoints {
		out = append(out, e.name)
	}
	return out
}

// ReportEndpointNames are the heavier report series, reported but not held to the list target.
func ReportEndpointNames() []string {
	out := make([]string, 0, len(reportEndpoints))
	for _, e := range reportEndpoints {
		out = append(out, e.name)
	}
	return out
}

// User is one virtual browser: an event stream held open, and a person clicking about.
type User struct {
	fx       *Fixture
	cfg      Config
	hub      *Hub
	http     *http.Client
	login    FixtureUser
	clusters []string
	rng      *rand.Rand
	matcher  *Matcher
}

// NewUser builds the virtual browser of one fixture user.
func NewUser(i int, fx *Fixture, cfg Config, hub *Hub, client *http.Client) *User {
	ids := make([]string, 0, len(fx.Clusters))
	for _, c := range fx.Clusters[:min(len(fx.Clusters), max(1, cfg.Agents))] {
		ids = append(ids, c.ID)
	}
	return &User{
		fx: fx, cfg: cfg, hub: hub, http: client, login: fx.Users[i], clusters: ids,
		rng:     rand.New(rand.NewPCG(uint64(cfg.Seed), uint64(i)+500)), //nolint:gosec // a seed
		matcher: NewMatcher(hub.Events),
	}
}

func (u *User) url(path, cluster string) string {
	p := strings.NewReplacer("{o}", u.fx.OrgID, "{c}", cluster).Replace(path)
	return strings.TrimRight(u.fx.APIBase, "/") + p
}

// Run holds the stream and the clicking until ctx ends.
func (u *User) Run(ctx context.Context) {
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); u.stream(ctx) }()
	go func() { defer wg.Done(); u.browse(ctx) }()
	wg.Wait()
}

// browse requests lists, one at a time, with think time between them.
func (u *User) browse(ctx context.Context) {
	total := 0
	for _, e := range listEndpoints {
		total += e.weight
	}
	var lastReport time.Time
	// Not all users start in the same instant.
	if !sleep(ctx, time.Duration(u.rng.Float64()*float64(u.cfg.UserThink))) {
		return
	}
	for ctx.Err() == nil {
		cluster := u.clusters[u.rng.IntN(len(u.clusters))]
		if time.Since(lastReport) > reportEvery && u.rng.Float64() < 0.15 {
			r := reportEndpoints[u.rng.IntN(len(reportEndpoints))]
			lastReport = time.Now()
			u.get(ctx, r.name, u.url(r.path, cluster))
		} else {
			pick := u.rng.IntN(total)
			for _, e := range listEndpoints {
				if pick -= e.weight; pick < 0 {
					u.get(ctx, e.name, u.url(e.path, cluster))
					break
				}
			}
		}
		think := time.Duration((0.5 + u.rng.Float64()) * float64(u.cfg.UserThink))
		if !sleep(ctx, think) {
			return
		}
	}
}

func sleep(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

// get times one GET until its body has been read.
func (u *User) get(ctx context.Context, name, url string) {
	series := u.hub.Reg.Get(name)
	rctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(rctx, http.MethodGet, url, nil)
	if err != nil {
		series.Fail(0)
		return
	}
	cookie := u.login.Cookie
	if name == "GET audit" {
		// The audit log is for owners and admins; the members this test creates would be refused.
		cookie = u.fx.AdminCookie
	}
	req.Header.Set("Cookie", cookie)
	start := time.Now()
	resp, err := u.http.Do(req)
	if err != nil {
		if ctx.Err() == nil {
			series.Fail(0)
			u.hub.Note(name + ": " + shorten(err.Error()))
		}
		return
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	elapsed := time.Since(start)
	if resp.StatusCode/100 == 2 {
		series.Add(start, elapsed)
		return
	}
	series.Fail(resp.StatusCode)
	if resp.StatusCode != http.StatusTooManyRequests {
		u.hub.Note(fmt.Sprintf("%s: HTTP %d", name, resp.StatusCode))
	}
}

func shorten(s string) string {
	if len(s) > 120 {
		return s[:120]
	}
	return s
}

type sseEvent struct {
	ClusterID string   `json:"clusterId"`
	Kinds     []string `json:"kinds"`
}

// stream holds the browser's event stream, reopening it when it drops, and turns each
// "inventory" event into the latencies it settles.
func (u *User) stream(ctx context.Context) {
	series := u.hub.Reg.Get("event to browser")
	for ctx.Err() == nil {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(u.fx.APIBase, "/")+"/stream", nil)
		if err != nil {
			return
		}
		req.Header.Set("Cookie", u.login.Cookie)
		req.Header.Set("Accept", "text/event-stream")
		resp, err := u.http.Do(req)
		if err != nil || resp.StatusCode != http.StatusOK {
			code := 0
			if resp != nil {
				code = resp.StatusCode
				_ = resp.Body.Close()
			}
			if ctx.Err() == nil {
				u.hub.Reg.Get("sse connect").Fail(code)
				u.hub.sseReconnects.Add(1)
			}
			if !sleep(ctx, 3*time.Second) {
				return
			}
			continue
		}
		u.hub.Streams(1)
		u.readEvents(ctx, resp.Body, series)
		u.hub.Streams(-1)
		_ = resp.Body.Close()
		if ctx.Err() == nil {
			u.hub.sseReconnects.Add(1)
			if !sleep(ctx, time.Second) {
				return
			}
		}
	}
}

func (u *User) readEvents(ctx context.Context, body io.Reader, series *Series) {
	sc := bufio.NewScanner(body)
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	event := ""
	for sc.Scan() {
		line := sc.Text()
		switch {
		case strings.HasPrefix(line, "event: "):
			event = strings.TrimPrefix(line, "event: ")
		case strings.HasPrefix(line, "data: "):
			if event != "inventory" {
				continue
			}
			arrived := time.Now()
			var e sseEvent
			if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &e) != nil {
				continue
			}
			for _, d := range u.matcher.Arrived(e.ClusterID, arrived) {
				series.Add(arrived, d)
			}
		case line == "":
			event = ""
		}
	}
	_ = ctx
}
