'use client';

import { cn } from '@/lib/utils';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  title?: string;
}

interface SegmentedControlProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
  size?: 'md' | 'sm';
}

/** Compact single-select toggle group (date presets, chart granularity, tabs). */
export function SegmentedControl<T extends string>({ options, value, onChange, ariaLabel, className, size = 'md' }: SegmentedControlProps<T>) {
  return (
    <div role="group" aria-label={ariaLabel} className={cn('inline-flex shrink-0 flex-nowrap rounded-md bg-muted p-0.5', className)}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            title={option.title}
            onClick={() => onChange(option.value)}
            className={cn(
              'rounded font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              size === 'sm' ? 'h-6 px-1.5 text-xs' : 'h-7 px-1.5 text-xs',
              active ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
