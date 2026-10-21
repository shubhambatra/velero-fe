import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import './metrics';
import { metricsRegistry } from './metrics.server';

const dir = resolve(__dirname, '../../../deploy/observability');

/** Every `vfm_…` identifier in a PromQL expression, with histogram suffixes folded onto the metric. */
function names(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\bvfm_[a-z0-9_]+/g)) {
    out.add(m[0].replace(/_(bucket|count|sum)$/, ''));
  }
  return out;
}

describe('shipped observability assets', () => {
  const registered = new Set(metricsRegistry.getMetricsAsArray().map((metric) => metric.name));

  it('the dashboard is valid JSON and only queries metrics the control plane exposes', () => {
    const dashboard = JSON.parse(
      readFileSync(resolve(dir, 'vfm-control-plane.dashboard.json'), 'utf8'),
    ) as {
      panels: { title: string; targets: { expr: string }[] }[];
    };
    expect(dashboard.panels.length).toBeGreaterThanOrEqual(10);
    const used = names(dashboard.panels.flatMap((p) => p.targets.map((t) => t.expr)).join('\n'));
    expect([...used].filter((n) => !registered.has(n))).toEqual([]);
    // The §13 list: connected agents, commands, stream reconnects, SSE, HTTP latency, queue depth.
    for (const must of [
      'vfm_agents_connected',
      'vfm_commands_total',
      'vfm_command_duration_seconds',
      'vfm_agent_stream_connects_total',
      'vfm_sse_subscribers',
      'vfm_http_request_duration_seconds',
      'vfm_commands_unfinished',
    ]) {
      expect(used.has(must), must).toBe(true);
    }
  });

  it('the alert rules are valid and only use metrics the control plane exposes', () => {
    const text = readFileSync(resolve(dir, 'vfm-alerts.rules.yaml'), 'utf8');
    const doc = parse(text) as {
      groups: { rules: { alert: string; expr: string; for: string }[] }[];
    };
    const rules = doc.groups.flatMap((g) => g.rules);
    expect(rules.length).toBeGreaterThanOrEqual(6);
    for (const rule of rules) {
      expect(rule.expr, rule.alert).toBeTruthy();
      expect(rule.for, rule.alert).toBeTruthy();
    }
    expect([...names(text)].filter((n) => !registered.has(n))).toEqual([]);
  });

  it('no metric label can grow with the data', () => {
    const allowed = new Set([
      'method',
      'route',
      'status_class',
      'kind',
      'reason',
      'op',
      'status',
      'ok',
      'name',
      'service',
    ]);
    for (const metric of metricsRegistry.getMetricsAsArray()) {
      // The runtime's own metrics (vfm_nodejs_*, vfm_process_*) have labels of their own, bounded by Node.
      if (!metric.name.startsWith('vfm_') || /^vfm_(nodejs|process)_/.test(metric.name)) continue;
      const labels = (metric as unknown as { labelNames?: string[] }).labelNames ?? [];
      expect(
        labels.filter((l) => !allowed.has(l)),
        metric.name,
      ).toEqual([]);
    }
  });
});
