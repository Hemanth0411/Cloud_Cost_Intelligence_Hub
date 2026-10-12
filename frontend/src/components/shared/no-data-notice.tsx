'use client';

import { DatabaseZap, Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import { useDataStatus } from '@/hooks/use-data-status';
import { useMode } from '@/hooks/use-mode';

/**
 * Why this screen is empty.
 *
 * An empty chart has four quite different causes and they need
 * different responses, so guessing is not good enough:
 *
 *   403        the caller holds no grant for any account -- an admin
 *              has to write one. The API answers this deliberately
 *              ("a user with no grants receives zero rows") and it is
 *              NOT an error.
 *   no ingest  `as_of` is null, so nothing has ever been loaded.
 *   no rows    ingest has run but this window has none.
 *   filters    a provider/account/service selection matches nothing.
 *
 * The first two are distinguishable from the data status; the last
 * two are not, so they share a sentence that covers both honestly.
 */
interface NoDataNoticeProps {
  range?: string;
  /**
   * What to say when data HAS been ingested and this selection simply
   * has none. The other two cases (no grants, no ingest yet) are
   * properties of the account, not of the screen, so they are worded
   * here; this one is not. "No spend in this period" is wrong on the
   * anomalies page, where the question is whether anything FIRED.
   */
  emptyTitle?: string;
  emptyMessage?: string;
}

export function NoDataNotice({ range, emptyTitle, emptyMessage }: NoDataNoticeProps) {
  const { asOf, restricted } = useDataStatus();
  const { mock } = useMode();

  if (restricted) {
    return (
      <Notice icon={Lock} title="You do not have access to any accounts yet">
        The API confirmed who you are and returned no rows, which means no access grant covers you. An
        administrator can grant one from Users &amp; grants.
      </Notice>
    );
  }

  if (!mock && asOf === null) {
    return (
      <Notice icon={DatabaseZap} title="No cost data has been ingested yet">
        The database has no cost rows and no ingest run has finished, so every figure on this page is
        empty. This is the expected state until the first billing import completes.
      </Notice>
    );
  }

  return (
    <Notice icon={DatabaseZap} title={emptyTitle ?? 'No spend in this selection'}>
      {emptyMessage ??
        `Nothing was billed in ${range ?? 'this period'} for the filters you have applied, or the filters match no accounts. Widen the date range or clear a filter to check.`}
    </Notice>
  );
}

function Notice({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof Lock;
  title: string;
  children: ReactNode;
}) {
  return (
    <div role="status" className="flex items-start gap-3 rounded-lg border border-dashed bg-muted/40 px-4 py-3 text-sm">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <div>
        <p className="font-medium">{title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{children}</p>
      </div>
    </div>
  );
}
