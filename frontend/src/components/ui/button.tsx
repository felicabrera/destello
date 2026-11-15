import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/cn';

export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium select-none transition-colors duration-(--duration-fast) disabled:pointer-events-none disabled:text-disabled aria-disabled:text-disabled min-h-[var(--hit-min)] px-3 text-label-13',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:bg-glint-hover active:bg-glint-press',
        secondary: 'border border-border-strong bg-surface-2 text-text hover:bg-border',
        ghost: 'bg-transparent text-muted hover:bg-surface-2 hover:text-text',
        danger: 'border border-danger bg-transparent text-danger hover:bg-surface-2',
      },
      size: { md: 'h-10', sm: 'h-8' },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type = 'button', ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        ref={ref}
        type={asChild ? undefined : type}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';
