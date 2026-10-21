import { createContext, useContext } from 'react';

import type { ResolvedTheme, ThemePreference } from '@/lib/theme';

export interface ThemeContextValue {
  /** What the user asked for, including "follow the system". */
  preference: ThemePreference;
  /** What is actually applied right now. */
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
  /** Advances to the next preference in the toggle's cycle. */
  cycle: () => void;
}

/**
 * Kept apart from the provider component so the provider module exports a
 * component and nothing else, which is what keeps it hot-reloadable.
 */
export const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (value === null) {
    throw new Error('useTheme must be used inside <ThemeProvider>');
  }
  return value;
}
