import type { ReactNode } from 'react';

export function DetailList({ items }: { items: Array<{ label: string; value: ReactNode }> }) {
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3.5 text-sm">
      {items.map((item) => (
        <div key={item.label}>
          <dt className="text-xs text-muted-foreground">{item.label}</dt>
          <dd className="mt-0.5 font-medium tabular-nums">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
