'use client';

import { Badge } from '@/components/ui/badge';
import { Dialog } from '@/components/ui/dialog';
import { DetailList } from '@/components/shared/detail-list';
import { formatCurrency, formatPercent, formatSignedPercent } from '@/lib/format';
import {
  BUDGET_BAR_CLASS,
  BUDGET_STATUS_CLASS,
  BUDGET_STATUS_LABEL,
  ENVIRONMENT_LABEL,
  PROVIDER_SHORT_NAME,
} from '@/lib/theme';
import { cn } from '@/lib/utils';
import type { AccountSummary } from '@/types/analytics';

interface AccountDetailDialogProps {
  account: AccountSummary | null;
  periodLabel: string;
  onClose: () => void;
}

export function AccountDetailDialog({ account, periodLabel, onClose }: AccountDetailDialogProps) {
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
            <Badge className={BUDGET_STATUS_CLASS[account.budgetStatus]}>{BUDGET_STATUS_LABEL[account.budgetStatus]}</Badge>
            <Badge variant="outline">{ENVIRONMENT_LABEL[account.environment]}</Badge>
          </div>

          <div>
            <div className="mb-1.5 flex items-baseline justify-between text-sm">
              <span className="font-medium">Monthly budget</span>
              <span className="tabular-nums text-muted-foreground">
                {formatCurrency(account.mtdSpend)} of {formatCurrency(account.monthlyBudget)}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div
                className={cn('h-full rounded-full', BUDGET_BAR_CLASS[account.budgetStatus])}
                style={{ width: `${Math.min(account.mtdPct, 100)}%` }}
              />
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground tabular-nums">
              Projected to finish the month at {formatCurrency(account.projectedSpend)} ({formatPercent(account.projectedPct, 0)} of budget)
            </p>
          </div>

          <DetailList
            items={[
              { label: `Spend (${periodLabel})`, value: formatCurrency(account.cost) },
              {
                label: 'vs previous period',
                value:
                  account.deltaPct === null ? (
                    '–'
                  ) : (
                    <span className={account.deltaPct > 0 ? 'text-destructive' : 'text-success'}>
                      {formatSignedPercent(account.deltaPct)}
                    </span>
                  ),
              },
              { label: 'Team', value: account.team },
              { label: 'Owner', value: account.owner },
              { label: 'Primary region', value: account.region },
              { label: 'Month to date', value: formatCurrency(account.mtdSpend) },
            ]}
          />
        </div>
      )}
    </Dialog>
  );
}
