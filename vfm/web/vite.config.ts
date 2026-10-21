import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * Vite + Vitest configuration for the web UI (PLAN.md §4.3).
 *
 * Everything is bundled from this workspace: there is no CDN, no external
 * font and no remote asset anywhere in the app (PLAN.md §1.1 P6). The
 * `no-external-assets` test enforces that rather than trusting review.
 */
export default defineConfig(({ mode }) => {
  // Third argument '' loads every variable, not only the VITE_ prefixed ones,
  // because the dev proxy target is build-tooling config and must not be
  // inlined into the client bundle.
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), '');
  const devProxyTarget = env.VFM_DEV_PROXY_TARGET ?? 'http://127.0.0.1:3000';

  return {
    plugins: [react(), tailwindcss()],

    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },

    server: {
      port: 5173,
      // Failing loudly beats silently moving to another port, because the
      // control plane's CORS/CSP configuration names this origin.
      strictPort: true,
      proxy: {
        // Same-origin in production, so the dev server mirrors that shape:
        // the app only ever talks to its own origin (PLAN.md §12.1 CSP).
        '/api': { target: devProxyTarget, changeOrigin: false },
        // The probes sit at the root because orchestrators expect them there
        // (the control plane excludes them from the /api/v1 prefix).
        '/healthz': { target: devProxyTarget, changeOrigin: false },
        '/readyz': { target: devProxyTarget, changeOrigin: false },
      },
    },

    build: {
      outDir: 'dist',
      sourcemap: true,
    },

    test: {
      environment: 'jsdom',
      // Matching the server and shared packages: assertions are imported, not
      // injected, so a test file's dependencies are visible in its imports.
      globals: false,
      // Multi-step wizards type into several fields; on a busy CI runner the default 5 s is a coin flip.
      testTimeout: 20_000,
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
      // Tailwind's output is irrelevant to behaviour assertions and compiling
      // it per test file is slow.
      css: false,
      clearMocks: true,
      restoreMocks: true,
      unstubGlobals: true,
    },
  };
});
