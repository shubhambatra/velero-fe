/**
 * Emits `server/openapi.yaml` from the Nest decorators (PLAN.md §10).
 *
 * The committed file is a contract (PLAN.md §0 rule 5): the web client's types
 * are generated from it, and the security test suite in M7 day 37 enumerates
 * its operations to prove every one of them enforces org isolation. `make gen`
 * regenerates it and CI fails if the result differs from what is committed.
 *
 * Run with `pnpm --filter @vfm/server gen`.
 */
import 'reflect-metadata';

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { stringify } from 'yaml';

import { PRODUCT_NAME } from '@vfm/shared';

import { AppModule } from './app.module';

// __dirname rather than import.meta: the server compiles to CommonJS.
const OUTPUT = resolve(__dirname, '..', 'openapi.yaml');

async function generate(): Promise<void> {
  // The app is created but never listens: generation must not need Postgres,
  // Redis or a port, so it can run in CI and in a pre-commit hook.
  const app = await NestFactory.create(AppModule, { logger: false, preview: true });

  const config = new DocumentBuilder()
    .setTitle(`${PRODUCT_NAME} API`)
    .setDescription(
      'Control-plane REST API. Errors use RFC 9457 application/problem+json and every ' +
        'response carries an X-Request-Id header.',
    )
    .setVersion('v1')
    // PLAN.md §10 specifies OpenAPI 3.1; @nestjs/swagger still defaults to 3.0.
    .setOpenAPIVersion('3.1.0')
    .addServer('/api/v1')
    .addCookieAuth('vfm_session', { type: 'apiKey', in: 'cookie' }, 'session')
    .addBearerAuth({ type: 'http', scheme: 'bearer' }, 'apiToken')
    .build();

  const document = SwaggerModule.createDocument(app, config);

  // aliasDuplicateObjects: false keeps repeated values (shared `tags` arrays,
  // for one) written out in full rather than as YAML anchors. Anchors are
  // valid but make the committed contract hard to diff and trip some
  // client generators.
  writeFileSync(
    OUTPUT,
    stringify(document, { lineWidth: 100, aliasDuplicateObjects: false }),
    'utf8',
  );
  await app.close();

  process.stdout.write(`wrote ${OUTPUT}\n`);
}

generate().catch((error: unknown) => {
  process.stderr.write(`openapi generation failed: ${String(error)}\n`);
  process.exitCode = 1;
});
