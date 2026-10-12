'use client';

/**
 * before/after as a readable diff, not raw JSON.
 *
 * The audit rows carry arbitrary jsonb, so this walks the union of both
 * key sets and shows what changed. Dumping `JSON.stringify` would be
 * less work and useless to the person who actually needs to read it
 * during an access review.
 */
function label(key: string): string {
  return key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function render(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function AuditDiff({
  before,
  after,
}: {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}) {
  const keys = Array.from(
    new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]),
  ).sort();

  if (keys.length === 0) {
    return <p className="text-xs text-muted-foreground">No detail recorded for this entry.</p>;
  }

  const created = !before;
  const removed = !after;

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {created ? 'Created' : removed ? 'Removed' : 'Changed'}
      </p>
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {keys.map((key) => {
          const from = before?.[key];
          const to = after?.[key];
          const changed = !created && !removed && render(from) !== render(to);
          return (
            <div key={key} className="text-sm">
              <dt className="text-xs text-muted-foreground">{label(key)}</dt>
              <dd className="mt-0.5 font-medium">
                {changed ? (
                  <>
                    <span className="text-muted-foreground line-through">{render(from)}</span>
                    <span aria-hidden className="mx-1.5 text-muted-foreground">
                      →
                    </span>
                    <span>{render(to)}</span>
                  </>
                ) : (
                  render(created ? to : removed ? from : to)
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}
