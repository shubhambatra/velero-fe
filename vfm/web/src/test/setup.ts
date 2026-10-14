import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

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
