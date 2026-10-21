// Command loadtest drives a VFM control plane with simulated agents and browsers and
// measures it against the targets of PLAN.md §13.
//
//	loadtest --fixture fixture.json --agents 200 --users 100 --duration 5m --report out.json
//
// The fixture comes from server/scripts/loadtest-provision.ts: it holds the API and
// gateway addresses, one single-use bootstrap token per cluster and a session per user.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/shubhambatra/velero-fe/vfm/agent/internal/loadtest"
)

func main() { os.Exit(run()) }

func run() int {
	cfg := loadtest.DefaultConfig()
	fs := flag.NewFlagSet("loadtest", flag.ContinueOnError)
	fs.StringVar(&cfg.Fixture, "fixture", "", "fixture JSON written by loadtest-provision.ts (required)")
	fs.DurationVar(&cfg.Duration, "duration", cfg.Duration, "length of the whole run, ramp included")
	fs.DurationVar(&cfg.Warmup, "warmup", cfg.Warmup, "after the ramp, samples are dropped for this long")
	fs.IntVar(&cfg.Agents, "agents", cfg.Agents, "simulated clusters (0 = every cluster in the fixture)")
	fs.IntVar(&cfg.Users, "users", cfg.Users, "virtual browsers (0 = none)")
	fs.IntVar(&cfg.Pods, "pods", cfg.Pods, "pods per cluster")
	fs.IntVar(&cfg.BigPods, "big-pods", cfg.BigPods, "pods in the clusters that are made large")
	fs.IntVar(&cfg.VeleroObjs, "velero-objects", cfg.VeleroObjs, "Velero objects per cluster")
	fs.IntVar(&cfg.Nodes, "nodes", cfg.Nodes, "nodes per cluster")
	fs.IntVar(&cfg.Namespaces, "namespaces", cfg.Namespaces, "namespaces per cluster")
	fs.Float64Var(&cfg.EventsPerSec, "events-per-sec", cfg.EventsPerSec, "inventory changes per cluster per second")
	fs.Float64Var(&cfg.CommandRate, "commands-per-sec", cfg.CommandRate, "commands issued per second across the fleet")
	fs.DurationVar(&cfg.UserThink, "user-think", cfg.UserThink, "mean pause between a browser's requests")
	fs.DurationVar(&cfg.StormAt, "storm-at", cfg.StormAt, "when to cut every agent connection (negative = 60% in, 0 = never)")
	fs.DurationVar(&cfg.Ramp, "ramp", cfg.Ramp, "agents start evenly over this long")
	fs.IntVar(&cfg.PodThreshold, "pod-threshold", cfg.PodThreshold, "pod count past which an agent scopes its pods")
	fs.StringVar(&cfg.Report, "report", "", "write the report as JSON here")
	fs.IntVar(&cfg.ServerPID, "server-pid", 0, "control-plane pid, to sample its cpu and memory")
	fs.Int64Var(&cfg.Seed, "seed", cfg.Seed, "seed for the generated inventories")
	if err := fs.Parse(os.Args[1:]); err != nil {
		return 2
	}
	if cfg.Fixture == "" {
		fmt.Fprintln(os.Stderr, "loadtest: --fixture is required")
		return 2
	}
	fx, err := loadtest.LoadFixture(cfg.Fixture)
	if err != nil {
		fmt.Fprintln(os.Stderr, "loadtest:", err)
		return 2
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	rep, err := loadtest.Run(ctx, fx, cfg, os.Stderr)
	if err != nil {
		fmt.Fprintln(os.Stderr, "loadtest:", err)
		return 2
	}
	rep.Text(os.Stdout)
	if cfg.Report != "" {
		b, _ := json.MarshalIndent(rep, "", "  ")
		if err := os.WriteFile(cfg.Report, append(b, '\n'), 0o600); err != nil {
			fmt.Fprintln(os.Stderr, "loadtest:", err)
			return 2
		}
	}
	if !rep.AllPass() {
		return 1
	}
	return 0
}
