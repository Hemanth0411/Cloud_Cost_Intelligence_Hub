'use client';

import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatCompactCurrency, formatCurrency, formatPercent, formatSignedPercent } from '@/lib/format';
import {
  BUDGET_BAR_CLASS,
  BUDGET_STATUS_CLASS,
  BUDGET_STATUS_LABEL,
  ENVIRONMENT_LABEL,
  PROVIDER_COLOR,
  PROVIDER_SHORT_NAME,
} from '@/lib/theme';
import { cn } from '@/lib/utils';
import type { AccountSummary } from '@/types/analytics';

type SortKey = 'name' | 'cost' | 'deltaPct' | 'projectedPct';
type SortDir = 'asc' | 'desc';

const COLUMNS: Array<{ key: SortKey; label: string; align?: 'right' }> = [
  { key: 'name', label: 'Account' },
  { key: 'cost', label: 'Spend', align: 'right' },
  { key: 'deltaPct', label: 'vs previous', align: 'right' },
  { key: 'projectedPct', label: 'Budget (month)' },
];

function sortValue(a: AccountSummary, key: SortKey): string | number {
  if (key === 'name') return a.name.toLowerCase();
  if (key === 'deltaPct') return a.deltaPct ?? Number.NEGATIVE_INFINITY;
  return a[key];
}

interface AccountsTableProps {
  accounts: AccountSummary[];
  /** False when a single service is selected: account budgets are not comparable. */
  budgetApplicable: boolean;
  onSelect: (account: AccountSummary) => void;
}

export function AccountsTable({ accounts, budgetApplicable, onSelect }: AccountsTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('cost');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...accounts].sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      return (av < bv ? -1 : av > bv ? 1 : 0) * dir;
    });
  }, [accounts, sortKey, sortDir]);

  function onSort(key: SortKey): void {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir(key === 'name' ? 'asc' : 'desc');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Accounts</CardTitle>
        <CardDescription>Spend for the period and month-to-date budget burn. Select a row for details</CardDescription>
      </CardHeader>
      <CardContent className="px-0 pb-2">
        <Table className="min-w-[780px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {COLUMNS.map((col) => {
                const active = sortKey === col.key;
                const Icon = !active ? ArrowUpDown : sortDir === 'asc' ? ArrowUp : ArrowDown;
                return (
                  <TableHead
                    key={col.key}
                    className={col.align === 'right' ? 'text-right' : undefined}
                    aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  >
                    <button
                      type="button"
                      onClick={() => onSort(col.key)}
                      className={cn(
                        'inline-flex items-center gap-1 uppercase tracking-wide hover:text-foreground',
                        active && 'text-foreground',
                      )}
                    >
                      {col.label}
                      <Icon className="h-3 w-3" aria-hidden />
                    </button>
                  </TableHead>
                );
              })}
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((a) => (
              <TableRow key={a.accountId} className="cursor-pointer" onClick={() => onSelect(a)}>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <span className="h-8 w-1 rounded-full" style={{ backgroundColor: PROVIDER_COLOR[a.providerId] }} aria-hidden />
                    <div className="min-w-0">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelect(a);
                        }}
                        className="truncate rounded text-left font-medium hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {a.name}
                      </button>
                      <p className="text-xs text-muted-foreground">
                        {PROVIDER_SHORT_NAME[a.providerId]} · {ENVIRONMENT_LABEL[a.environment]} · {a.team}
                      </p>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <p className="font-medium">{formatCurrency(a.cost)}</p>
                  <p className="text-[11px] text-muted-foreground">{formatPercent(a.sharePct)} of total</p>
                </TableCell>
                <TableCell
                  className={cn(
                    'text-right tabular-nums',
                    a.deltaPct === null ? 'text-muted-foreground' : a.deltaPct > 0 ? 'text-destructive' : 'text-success',
                  )}
                >
                  {a.deltaPct === null ? '–' : formatSignedPercent(a.deltaPct)}
                </TableCell>
                {budgetApplicable ? (
                  <>
                    <TableCell className="min-w-[210px]">
                      <div className="flex items-center gap-3">
                        <div
                          className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
                          role="progressbar"
                          aria-label={`${a.name} budget used`}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={Math.min(Math.round(a.mtdPct), 100)}
                        >
                          <div className={cn('h-full rounded-full', BUDGET_BAR_CLASS[a.budgetStatus])} style={{ width: `${Math.min(a.mtdPct, 100)}%` }} />
                        </div>
                        <span className="w-24 text-right text-xs tabular-nums text-muted-foreground">
                          {formatCompactCurrency(a.mtdSpend)} / {formatCompactCurrency(a.monthlyBudget)}
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] text-muted-foreground tabular-nums">
                        Projected {formatPercent(a.projectedPct, 0)} of budget
                      </p>
                    </TableCell>
                    <TableCell>
                      <Badge className={BUDGET_STATUS_CLASS[a.budgetStatus]}>{BUDGET_STATUS_LABEL[a.budgetStatus]}</Badge>
                    </TableCell>
                  </>
                ) : (
                  <TableCell colSpan={2} className="text-xs text-muted-foreground">
                    Budget not shown while filtering by service
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
