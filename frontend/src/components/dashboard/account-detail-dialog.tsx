'use client';

import { Badge } from '@/components/ui/badge';
import { Dialog } from '@/components/ui/dialog';
import { DetailList } from '@/components/shared/detail-list';
import { formatCurrency, formatPercent, formatSignedPercent } from '@/lib/format';
import {
  ABSENT,
  BUDGET_BAR_CLASS,
  budgetStatusClass,
  budgetStatusLabel,
  environmentLabel,
  PROVIDER_SHORT_NAME,
} from '@/lib/theme';
import { cn } from '@/lib/utils';
import type { AccountSummary } from '@/types/analytics';

interface AccountDetailDialogProps {
  account: AccountSummary | null;
  periodLabel: string;
  onClose: () => void;
}

/**
 * Budget and ownership are shown only when the source has them.
 *
 * A $0 budget bar would read as "no headroom left", which is the
 * opposite of what "we have no budget figure" means, so the whole
 * block is omitted and replaced with one line saying why.
 */
export function AccountDetailDialog({ account, periodLabel, onClose }: AccountDetailDialogProps) {
  const hasBudget =
    account !== null &&
    account.monthlyBudget !== null &&
    account.mtdSpend !== null &&
    account.mtdPct !== null &&
    account.projectedSpend !== null &&
    account.projectedPct !== null;

  return (
    <Dialog
      open={account !== null}
      onOpenChange={(open) => !open && onClose()}
      title={account?.name ?? 'Account'}
      description={account ? `${PROVIDER_SHORT_NAME[account.providerId]} · ${account.externalId}` : undefined}
    >
      {account && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={budgetStatusClass(account.budgetStatus)}>{budgetStatusLabel(account.budgetStatus)}</Badge>
            {account.environment !== null && (
              <Badge variant="outline">{environmentLabel(account.environment)}</Badge>
            )}
          </div>

          {hasBudget ? (
            <div>
              <div className="mb-1.5 flex items-baseline justify-between text-sm">
                <span className="font-medium">Monthly budget</span>
                <span className="tabular-nums text-muted-foreground">
                  {formatCurrency(account.mtdSpend ?? 0)} of {formatCurrency(account.monthlyBudget ?? 0)}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn('h-full rounded-full', account.budgetStatus ? BUDGET_BAR_CLASS[account.budgetStatus] : 'bg-muted')}
                  style={{ width: `${Math.min(account.mtdPct ?? 0, 100)}%` }}
                />
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground tabular-nums">
                Projected to finish the month at {formatCurrency(account.projectedSpend ?? 0)} ({formatPercent(account.projectedPct ?? 0, 0)} of budget)
              </p>
            </div>
          ) : (
            <p className="rounded-md border border-dashed bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
              No monthly budget is recorded for this account, so there is nothing to measure month-to-date
              spend against.
            </p>
          )}

          <DetailList
            items={[
              { label: `Spend (${periodLabel})`, value: formatCurrency(account.cost) },
              {
                label: 'vs previous period',
                value:
                  account.deltaPct === null ? (
                    ABSENT
                  ) : (
                    <span className={account.deltaPct > 0 ? 'text-destructive' : 'text-success'}>
                      {formatSignedPercent(account.deltaPct)}
                    </span>
                  ),
              },
              { label: 'Team', value: account.team ?? ABSENT },
              { label: 'Owner', value: account.owner ?? ABSENT },
              { label: 'Primary region', value: account.region ?? ABSENT },
              {
                label: 'Month to date',
                value: account.mtdSpend === null ? ABSENT : formatCurrency(account.mtdSpend),
              },
            ]}
          />
        </div>
      )}
    </Dialog>
  );
}
