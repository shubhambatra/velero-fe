import type { VariantProps } from 'class-variance-authority';
import type { HTMLAttributes, ReactElement } from 'react';

import { cn } from '@/lib/cn';

import { badgeVariants } from './badge-variants';

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>;

export function Badge({ className, tone, ...props }: BadgeProps): ReactElement {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
