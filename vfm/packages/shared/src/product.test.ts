import { describe, expect, it } from 'vitest';

import {
  AGENT_NAMESPACE,
  API_TOKEN_PREFIX,
  PRODUCT_NAME,
  PRODUCT_SHORT_NAME,
  PRODUCT_SLUG,
  RESOURCE_DOMAIN,
} from './product';

describe('product identity', () => {
  it('exposes the working name from PLAN.md', () => {
    expect(PRODUCT_NAME).toBe('Velero Fleet Manager');
    expect(PRODUCT_SHORT_NAME).toBe('VFM');
  });

  it('derives every technical identifier from the slug, so a rename stays a one-line change', () => {
    expect(AGENT_NAMESPACE).toBe(`${PRODUCT_SLUG}-system`);
    expect(RESOURCE_DOMAIN).toBe(`${PRODUCT_SLUG}.io`);
    expect(API_TOKEN_PREFIX).toBe(`${PRODUCT_SLUG}_`);
  });

  it('keeps the slug a valid Kubernetes name component', () => {
    expect(PRODUCT_SLUG).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
    expect(AGENT_NAMESPACE).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
    expect(AGENT_NAMESPACE.length).toBeLessThanOrEqual(63);
  });
});
