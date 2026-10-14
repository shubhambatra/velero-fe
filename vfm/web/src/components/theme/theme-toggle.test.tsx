import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ThemeProvider } from '@/components/theme/theme-provider';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { THEME_STORAGE_KEY } from '@/lib/theme';

/**
 * Replaces `matchMedia` with a minimal implementation.
 *
 * jsdom's own answer to `(prefers-color-scheme: dark)` is always "no", which
 * would leave the system-preference path (PLAN.md §11.2) untested.
 */
function stubPrefersColorScheme(prefersDark: boolean): void {
  const matchMedia = (query: string): MediaQueryList =>
    ({
      matches: query.includes('dark') && prefersDark,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
      // Only the members the provider touches are real; the rest exist to
      // satisfy the DOM interface.
    }) as MediaQueryList;

  vi.stubGlobal('matchMedia', matchMedia);
}

function renderToggle(): HTMLElement {
  render(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>,
  );
  return screen.getByRole('button', { name: /^Theme:/ });
}

const isDark = (): boolean => document.documentElement.classList.contains('dark');

describe('theme toggle', () => {
  it('follows the OS preference until the user chooses, storing nothing', () => {
    stubPrefersColorScheme(true);

    const toggle = renderToggle();

    expect(isDark()).toBe(true);
    expect(toggle.getAttribute('aria-label') ?? '').toContain('following the system (dark)');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it('cycles system → dark → light → system and persists each explicit choice', async () => {
    stubPrefersColorScheme(false);
    const user = userEvent.setup();

    const toggle = renderToggle();
    expect(isDark()).toBe(false);

    await user.click(toggle);
    expect(isDark()).toBe(true);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(toggle).toHaveAttribute('data-theme-preference', 'dark');

    await user.click(toggle);
    expect(isDark()).toBe(false);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');

    await user.click(toggle);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('system');
    expect(toggle).toHaveAttribute('data-theme-preference', 'system');
  });

  it('restores a stored preference on mount', () => {
    stubPrefersColorScheme(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');

    renderToggle();

    expect(isDark()).toBe(true);
  });

  it('still switches the theme when localStorage throws on read and write', async () => {
    stubPrefersColorScheme(false);
    // Safari in private mode and "block all site data" both throw here, so
    // the UI must not depend on storage being usable at all.
    const denied = (): never => {
      throw new Error('storage is not available');
    };
    // Spied on the prototype, not on `window.localStorage`: jsdom's storage
    // object is proxy-backed, so an instance-level spy is silently dropped and
    // the test would pass without ever exercising the failure path.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(denied);
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(denied);
    const user = userEvent.setup();

    const toggle = renderToggle();
    expect(isDark()).toBe(false);

    await user.click(toggle);

    expect(isDark()).toBe(true);
    expect(setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, 'dark');
  });
});
