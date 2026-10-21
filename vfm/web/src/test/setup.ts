import '@testing-library/jest-dom/vitest';

import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// The default of one second is too tight for a cold render of a whole page when the suite runs
// in parallel; a slow machine must not look like a failing page.
configure({ asyncUtilTimeout: 4_000 });

/**
 * Vitest runs with `globals: false`, so Testing Library's automatic cleanup —
 * which hooks a global `afterEach` — never installs itself. Doing it here
 * keeps every test file from having to remember.
 */
afterEach(() => {
  cleanup();

  // The theme lives as a class on <html>, outside the React tree that
  // `cleanup` unmounts; leaking it would make tests order-dependent.
  document.documentElement.className = '';

  try {
    window.localStorage.clear();
  } catch {
    // A test may have replaced localStorage with one that throws.
  }
});
