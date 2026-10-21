import type { ReactElement } from 'react';

import { MonitorIcon, MoonIcon, SunIcon } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { nextPreference, type ThemePreference } from '@/lib/theme';

import { useTheme } from './theme-context';

/** How the current preference is described to the user. */
const CURRENT: Record<ThemePreference, string> = {
  system: 'following the system',
  light: 'light',
  dark: 'dark',
};

/** What activating the control will do next. */
const NEXT_ACTION: Record<ThemePreference, string> = {
  system: 'follow the system',
  light: 'switch to the light theme',
  dark: 'switch to the dark theme',
};

/**
 * One button cycling system → dark → light → system (PLAN.md §11.2).
 *
 * It is a real `<button>`, so it is reachable and operable by keyboard with no
 * extra handlers, and its accessible name states both the current theme and
 * what activation will do — an icon alone cannot say that.
 */
export function ThemeToggle({ className }: { className?: string | undefined }): ReactElement {
  const { preference, resolved, cycle } = useTheme();

  const next = nextPreference(preference);
  const current = preference === 'system' ? `${CURRENT.system} (${resolved})` : CURRENT[preference];
  const label = `Theme: ${current}. Activate to ${NEXT_ACTION[next]}.`;

  const Icon = preference === 'system' ? MonitorIcon : preference === 'dark' ? MoonIcon : SunIcon;

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={cycle}
      aria-label={label}
      title={label}
      // Lets a test (and a debugging human) read the stored preference without
      // reaching into React internals.
      data-theme-preference={preference}
      className={className}
    >
      <Icon className="h-4 w-4" aria-hidden="true" focusable="false" />
    </Button>
  );
}
