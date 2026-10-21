import type { HTMLAttributes, ReactElement } from 'react';

import { cn } from '@/lib/cn';

/**
 * Panel primitive. The fleet overview, cluster detail tabs and every empty
 * state (PLAN.md §11.1, §11.2) are built from these, so the border and
 * surface colour live here once.
 */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>): ReactElement {
  return (
    <div
      className={cn('rounded-lg border border-border bg-card text-card-foreground', className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>): ReactElement {
  return <div className={cn('flex flex-col gap-1 p-4 pb-2', className)} {...props} />;
}

export interface CardTitleProps extends HTMLAttributes<HTMLHeadingElement> {
  /**
   * Heading level, so a card can sit under an `h1` page title without
   * breaking the document outline for screen-reader users (PLAN.md §11.2).
   */
  level?: 2 | 3 | undefined;
}

export function CardTitle({ level = 2, className, ...props }: CardTitleProps): ReactElement {
  const Heading = level === 2 ? 'h2' : 'h3';
  return <Heading className={cn('text-base font-semibold', className)} {...props} />;
}

export function CardDescription({
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>): ReactElement {
  return <p className={cn('text-sm text-muted-foreground', className)} {...props} />;
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>): ReactElement {
  return <div className={cn('p-4 pt-2 text-sm', className)} {...props} />;
}
