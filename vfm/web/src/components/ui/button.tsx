import type { VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes, ReactElement } from 'react';

import { cn } from '@/lib/cn';

import { buttonVariants } from './button-variants';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, type, ...props }: ButtonProps): ReactElement {
  return (
    <button
      // Defaulting to "button" avoids the classic accidental form submit.
      type={type ?? 'button'}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
