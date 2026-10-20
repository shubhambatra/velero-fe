import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'yaml';

import { renderApi, renderRbac, type OpenApiDocument } from '../src/docs/generate';

const docs = resolve(__dirname, '../../docs');
const spec = parse(readFileSync(resolve(__dirname, '../openapi.yaml'), 'utf8')) as OpenApiDocument;
writeFileSync(resolve(docs, 'API.md'), renderApi(spec));
writeFileSync(resolve(docs, 'RBAC.md'), renderRbac());
console.log('wrote docs/API.md and docs/RBAC.md');
