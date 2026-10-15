/**
 * Dual build for @vfm/shared.
 *
 * Two consumers with incompatible expectations:
 *   - the control plane compiles to CommonJS and cannot `require()` ESM,
 *   - the web app is bundled by Rollup, which cannot see named exports
 *     through a CommonJS entry point.
 *
 * So both are emitted, and each `dist` half carries a one-line package.json
 * declaring its module type — without that marker Node reads `.js` files
 * according to the *package's* type field and gets it wrong for one of them.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Resolved rather than taken from PATH, so this works both under `pnpm run`
// (which adds node_modules/.bin) and when invoked directly as `node build.mjs`.
const require = createRequire(import.meta.url);
const tscBin = require.resolve('typescript/bin/tsc');

const tsc = (project) =>
  execFileSync(process.execPath, [tscBin, '-p', project], { stdio: 'inherit' });

tsc('tsconfig.build.cjs.json');
tsc('tsconfig.build.esm.json');

writeFileSync('dist/cjs/package.json', JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');
writeFileSync('dist/esm/package.json', JSON.stringify({ type: 'module' }, null, 2) + '\n');
