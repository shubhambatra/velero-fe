import { cva } from 'class-variance-authority';

/**
 * Exported so a link can be styled as a button without being wrapped in one —
 * a link that looks like a button must still be an `<a>` for keyboard and
 * screen-reader users.
 *
 * Only the variants the shell actually uses exist. `destructive` is
 * deliberately absent: every destructive action in this product also needs a
 * typed confirmation and sudo re-auth (PLAN.md §11.2), so that variant lands
 * with the component that enforces them, not before.
 */
export const buttonVariants = cva(
  [
    'inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium',
    'transition-colors',
    // Focus is never invisible (PLAN.md §11.2). globals.css sets a baseline
    // outline; this keeps it clear of the control's edge.
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
    // §11.2 keeps actions the user may not take visible but disabled with a
    // tooltip giving the reason, so a disabled button has to stay readable
    // rather than fade into the background.
    'disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground',
  ],
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:bg-primary-hover',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-muted',
        outline: 'border border-control bg-background text-foreground hover:bg-muted',
        ghost: 'text-foreground hover:bg-muted',
      },
      size: {
        md: 'h-9 px-4',
        icon: 'h-9 w-9 p-0',
      },
    },
    defaultVariants: {
      variant: 'secondary',
      size: 'md',
    },
  },
);
