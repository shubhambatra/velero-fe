import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Conditional class names with Tailwind conflict resolution.
 *
 * `twMerge` is what makes the primitives in `components/ui` overridable: a
 * caller passing `className="bg-destructive"` must win over the variant's own
 * background instead of producing two competing classes.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
