import { cva } from 'class-variance-authority';

/**
 * Small status pill.
 *
 * Tone is carried by text colour on a muted surface rather than by a
 * saturated fill: the status token on `--muted` clears 4.5:1 in both themes
 * (measured in styles/globals.css), which a white-on-colour pill would not do
 * for the amber "warn" tone. Colour is never the only signal — every use
 * pairs the tone with a word.
 */
export const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium',
  {
    variants: {
      tone: {
        neutral: 'text-muted-foreground',
        ok: 'text-ok',
        warn: 'text-warn',
        error: 'text-error',
      },
    },
    defaultVariants: {
      tone: 'neutral',
    },
  },
);
