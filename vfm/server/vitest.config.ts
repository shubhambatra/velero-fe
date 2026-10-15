import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // The e2e suite has its own config: it needs a running dev stack, so it
    // must not be picked up by the fast, dependency-free unit run.
    include: ['src/**/*.test.ts'],
    globals: false,
  },
  plugins: [
    // Nest's decorators need emitDecoratorMetadata, which esbuild (Vitest's
    // default transformer) does not implement.
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2023',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
});
