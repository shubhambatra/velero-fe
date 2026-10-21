package loadtest

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ProcStats is the control-plane process's resource use over a run.
type ProcStats struct {
	PID        int     `json:"pid"`
	CPUAvgPct  float64 `json:"cpuAvgPercent"`
	CPUPeakPct float64 `json:"cpuPeakPercent"`
	RSSStartMB float64 `json:"rssStartMB"`
	RSSPeakMB  float64 `json:"rssPeakMB"`
	RSSEndMB   float64 `json:"rssEndMB"`
	Samples    int     `json:"samples"`
}

// ProcSampler reads /proc/<pid>/{stat,statm} on an interval.
type ProcSampler struct {
	pid   int
	mu    sync.Mutex
	stats ProcStats
	// cpu accounting
	lastTicks float64
	lastAt    time.Time
	sumPct    float64
}

// NewProcSampler returns a sampler of pid; a pid of 0 samples nothing.
func NewProcSampler(pid int) *ProcSampler { return &ProcSampler{pid: pid, stats: ProcStats{PID: pid}} }

const clockTicks = 100 // USER_HZ on Linux

func readProc(pid int) (ticks float64, rssMB float64, err error) {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return 0, 0, err
	}
	s := string(b)
	// comm may hold spaces; fields resume after the last ')'.
	i := strings.LastIndexByte(s, ')')
	if i < 0 {
		return 0, 0, fmt.Errorf("unexpected /proc stat")
	}
	f := strings.Fields(s[i+1:])
	if len(f) < 13 {
		return 0, 0, fmt.Errorf("short /proc stat")
	}
	ut, _ := strconv.ParseFloat(f[11], 64)
	st, _ := strconv.ParseFloat(f[12], 64)
	m, err := os.ReadFile(fmt.Sprintf("/proc/%d/statm", pid))
	if err != nil {
		return 0, 0, err
	}
	mf := strings.Fields(string(m))
	if len(mf) < 2 {
		return 0, 0, fmt.Errorf("short /proc statm")
	}
	pages, _ := strconv.ParseFloat(mf[1], 64)
	return ut + st, pages * float64(os.Getpagesize()) / (1 << 20), nil
}

// Run samples until ctx ends.
func (p *ProcSampler) Run(ctx context.Context, every time.Duration) {
	if p.pid <= 0 {
		return
	}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		p.sample()
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (p *ProcSampler) sample() {
	ticks, rss, err := readProc(p.pid)
	if err != nil {
		return
	}
	now := time.Now()
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.stats.Samples == 0 {
		p.stats.RSSStartMB = rss
	} else if dt := now.Sub(p.lastAt).Seconds(); dt > 0 {
		pct := (ticks - p.lastTicks) / clockTicks / dt * 100
		p.sumPct += pct
		if pct > p.stats.CPUPeakPct {
			p.stats.CPUPeakPct = pct
		}
	}
	if rss > p.stats.RSSPeakMB {
		p.stats.RSSPeakMB = rss
	}
	p.stats.RSSEndMB = rss
	p.stats.Samples++
	p.lastTicks, p.lastAt = ticks, now
}

// Stats is the readings so far.
func (p *ProcSampler) Stats() ProcStats {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := p.stats
	if out.Samples > 1 {
		out.CPUAvgPct = p.sumPct / float64(out.Samples-1)
	}
	round := func(f float64) float64 { return float64(int(f*10+0.5)) / 10 }
	out.CPUAvgPct, out.CPUPeakPct = round(out.CPUAvgPct), round(out.CPUPeakPct)
	out.RSSStartMB, out.RSSPeakMB, out.RSSEndMB = round(out.RSSStartMB), round(out.RSSPeakMB), round(out.RSSEndMB)
	return out
}
