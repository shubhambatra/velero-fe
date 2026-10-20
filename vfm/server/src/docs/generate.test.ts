import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { renderApi, renderRbac, type OpenApiDocument } from './generate';

const here = (...p: string[]): string => resolve(__dirname, '../../..', ...p);

describe('generated reference documents', () => {
  it('docs/RBAC.md is exactly what the permission matrix says now', () => {
    expect(readFileSync(here('docs/RBAC.md'), 'utf8')).toBe(renderRbac());
  });

  it('docs/API.md is exactly what openapi.yaml says now', () => {
    const spec = parse(readFileSync(here('server/openapi.yaml'), 'utf8')) as OpenApiDocument;
    expect(readFileSync(here('docs/API.md'), 'utf8')).toBe(renderApi(spec));
  });

  it('lists every operation of the contract', () => {
    const spec = parse(readFileSync(here('server/openapi.yaml'), 'utf8')) as OpenApiDocument;
    const operations = Object.values(spec.paths).reduce(
      (n, item) =>
        n +
        Object.keys(item).filter((k) => ['get', 'post', 'put', 'patch', 'delete'].includes(k))
          .length,
      0,
    );
    expect(renderApi(spec)).toContain(`${String(operations)} operations`);
  });
});
