import { PRODUCT_SLUG } from '@vfm/shared';

/**
 * Theme resolution and persistence (PLAN.md §11.2 requires a dark/light
 * theme).
 *
 * The default is the operating system preference, so a user who has already
 * told their OS which they want is not asked again. An explicit choice is
 * remembered, including the explicit choice to follow the system again.
 */
export type ThemePreference = 'light' | 'dark' | 'system';

/** What is actually applied to the document once `system` is resolved. */
export type ResolvedTheme = 'light' | 'dark';

/** Namespaced with the product slug, which is rename-stable (PLAN.md §0). */
export const THEME_STORAGE_KEY = `${PRODUCT_SLUG}.theme`;

/** The class the CSS `dark` variant keys off (see styles/globals.css). */
export const DARK_CLASS = 'dark';

export const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)';

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

/**
 * Reads the stored preference, falling back to `system`.
 *
 * Storage access throws, not just returns null: Safari in private mode and
 * browsers configured to block site data both raise on access. A UI that
 * cannot render because the theme could not be read would be a poor trade.
 */
export function readStoredPreference(): ThemePreference {
  try {
    const stored: unknown = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

/** Persists the preference. A failure costs persistence, nothing else. */
export function storePreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Storage unavailable or full: the preference still applies for this
    // session, so there is nothing useful to tell the user.
  }
}

/**
 * The live media query, or `undefined` where `matchMedia` is unavailable
 * (older browsers, some test environments). Callers must handle `undefined`
 * rather than assume the API exists.
 */
export function systemThemeQuery(): MediaQueryList | undefined {
  try {
    return window.matchMedia(SYSTEM_DARK_QUERY);
  } catch {
    return undefined;
  }
}

export function detectSystemTheme(): ResolvedTheme {
  // Light is the safer fallback: it matches the pre-script paint.
  return systemThemeQuery()?.matches === true ? 'dark' : 'light';
}

export function resolveTheme(
  preference: ThemePreference,
  systemTheme: ResolvedTheme,
): ResolvedTheme {
  return preference === 'system' ? systemTheme : preference;
}

/** Applies the theme to the document. `color-scheme` follows via CSS. */
export function applyTheme(theme: ResolvedTheme): void {
  document.documentElement.classList.toggle(DARK_CLASS, theme === 'dark');
}

/**
 * Cycle order for the single toggle control: following the system is a
 * reachable state, not a hidden default, so a user who overrode it can get
 * back without clearing site data.
 */
export function nextPreference(current: ThemePreference): ThemePreference {
  switch (current) {
    case 'system':
      return 'dark';
    case 'dark':
      return 'light';
    case 'light':
      return 'system';
  }
}
