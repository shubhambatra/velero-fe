import { describe, expect, it } from 'vitest';

import { formatLabels, grafanaUrl, parseLabels } from './cluster-settings';

const cluster = { id: 'c-1', name: 'prod eu/1' };

describe('grafanaUrl', () => {
  it('fills the cluster name and id, encoded', () => {
    expect(
      grafanaUrl('https://g.example/d/abc?var-cluster={cluster}&id={clusterId}', cluster),
    ).toBe('https://g.example/d/abc?var-cluster=prod%20eu%2F1&id=c-1');
  });
  it('is absent without a template', () => {
    expect(grafanaUrl(null, cluster)).toBeNull();
    expect(grafanaUrl(undefined, cluster)).toBeNull();
    expect(grafanaUrl('   ', cluster)).toBeNull();
  });
  it('never produces a link that is not http(s)', () => {
    expect(grafanaUrl('javascript:alert({cluster})', cluster)).toBeNull();
    expect(grafanaUrl('data:text/html,{cluster}', cluster)).toBeNull();
    expect(grafanaUrl('not a url', cluster)).toBeNull();
  });
});

describe('labels', () => {
  it('round-trips and sorts', () => {
    const parsed = parseLabels('env=prod\nteam = data\n\n');
    expect(parsed).toEqual({ labels: { env: 'prod', team: 'data' } });
    expect(formatLabels({ team: 'data', env: 'prod' })).toBe('env=prod\nteam=data');
  });
  it('keeps = inside a value and reports the line of a bad one', () => {
    expect(parseLabels('url=a=b')).toEqual({ labels: { url: 'a=b' } });
    expect(parseLabels('ok=1\nbroken')).toEqual({ error: 'Line 2 is not key=value.' });
    expect(parseLabels('=x')).toEqual({ error: 'Line 1 is not key=value.' });
  });
  it('allows at most 50', () => {
    const many = Array.from({ length: 51 }, (_, i) => `k${String(i)}=v`).join('\n');
    expect(parseLabels(many)).toEqual({ error: 'At most 50 labels.' });
  });
});
