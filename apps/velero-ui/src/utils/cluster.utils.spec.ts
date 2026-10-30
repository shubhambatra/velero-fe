import { beforeEach, describe, expect, it } from 'vitest';

import {
  getSelectedCluster,
  selectedCluster,
  setSelectedCluster,
} from './cluster.utils';

describe('cluster selection', () => {
  beforeEach(() => setSelectedCluster(null));

  it('is empty until a cluster is chosen', () => {
    expect(getSelectedCluster()).toBeNull();
    expect(selectedCluster.value).toBeNull();
  });

  it('keeps the choice in storage and in the reactive ref', () => {
    setSelectedCluster('prod');
    expect(getSelectedCluster()).toBe('prod');
    expect(selectedCluster.value).toBe('prod');
  });

  it('clears both when the selection is dropped', () => {
    setSelectedCluster('prod');
    setSelectedCluster(null);
    expect(getSelectedCluster()).toBeNull();
    expect(selectedCluster.value).toBeNull();
  });
});
