import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

import {
  applyTheme,
  detectSystemTheme,
  nextPreference,
  readStoredPreference,
  resolveTheme,
  storePreference,
  systemThemeQuery,
  type ResolvedTheme,
  type ThemePreference,
} from '@/lib/theme';

import { ThemeContext, type ThemeContextValue } from './theme-context';

/**
 * Owns the theme for the whole app (PLAN.md §11.2).
 *
 * The initial value is read synchronously during the first render, so the app
 * never paints the wrong theme and then corrects itself. A storage failure is
 * absorbed by `readStoredPreference`, which is the only reason this provider
 * cannot refuse to mount.
 */
export function ThemeProvider({ children }: { children: ReactNode }): ReactElement {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredPreference);
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(detectSystemTheme);

  const resolved = resolveTheme(preference, systemTheme);

  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  useEffect(() => {
    const media = systemThemeQuery();
    if (media === undefined) {
      return undefined;
    }

    // Keeps following the OS while the preference is `system`: a user who
    // switches their desktop to dark at sunset expects this to follow.
    const onChange = (event: MediaQueryListEvent): void => {
      setSystemTheme(event.matches ? 'dark' : 'light');
    };

    media.addEventListener('change', onChange);
    return () => {
      media.removeEventListener('change', onChange);
    };
  }, []);

  const setPreference = useCallback((next: ThemePreference): void => {
    setPreferenceState(next);
    storePreference(next);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      preference,
      resolved,
      setPreference,
      cycle: () => {
        setPreference(nextPreference(preference));
      },
    }),
    [preference, resolved, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
