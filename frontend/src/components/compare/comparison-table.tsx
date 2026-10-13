'use client';

import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatCurrency, formatPercent, formatSignedPercent } from '@/lib/format';
import { PROVIDER_COLOR, PROVIDER_SHORT_NAME } from '@/lib/theme';
import { cn } from '@/lib/utils';
import type { ComparisonDimension, ComparisonEntity } from '@/types/analytics';

type SortKey = 'label' | 'current' | 'baseline' | 'diff' | 'diffPct' | 'contribution';
type SortDir = 'asc' | 'desc';

const signedUsd = (v: number): string => `${v >= 0 ? '+' : '−'}${formatCurrency(Math.abs(v))}`;

const COLUMNS: Array<{ key: SortKey; label: string; right?: boolean }> = [
  { key: 'label', label: 'Name' },
  { key: 'current', label: 'This period', right: true },
  { key: 'baseline', label: 'Baseline', right: true },
  { key: 'diff', label: 'Difference', right: true },
  { key: 'diffPct', label: 'Change', right: true },
  { key: 'contribution', label: 'Share of change' },
];

function valueOf(e: ComparisonEntity, key: SortKey): string | number {
  switch (key) {
    case 'label': return e.label.toLowerCase();
    case 'current': return e.current;
    case 'baseline': return e.baseline;
    case 'diff': return e.diff;
    case 'diffPct': return e.diffPct ?? Number.NEGATIVE_INFINITY;
    case 'contribution': return Math.abs(e.contributionPct ?? 0);
  }
}

interface ComparisonTableProps {
  entities: ComparisonEntity[];
  dimension: ComparisonDimension;
  hasBaseline: boolean;
  baselineLabel: string;
  displayName: (entity: ComparisonEntity) => string;
  hrefFor: (entity: ComparisonEntity) => string;
}

export function ComparisonTable({ entities, dimension, hasBaseline, baselineLabel, displayName, hrefFor }: ComparisonTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('current');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...entities].sort((a, b) => {
      const av = valueOf(a, sortKey);
      const bv = valueOf(b, sortKey);
      return (av < bv ? -1 : av > bv ? 1 : 0) * dir;
    });
  }, [entities, sortKey, sortDir]);

  const maxContribution = Math.max(1, ...entities.map((e) => Math.abs(e.contributionPct ?? 0)));

  function onSort(key: SortKey): void {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir(key === 'label' ? 'asc' : 'desc');
    }
  }

  return (
    <Table className="min-w-[760px]">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          {COLUMNS.map((col) => {
            const active = sortKey === col.key;
            const Icon = !active ? ArrowUpDown : sortDir === 'asc' ? ArrowUp : ArrowDown;
            return (
              <TableHead key={col.key} className={col.right ? 'text-right' : undefined} aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}>
                <button type="button" onClick={() => onSort(col.key)} className="inline-flex items-center gap-1 uppercase tracking-wide text-inherit">
                  {col.key === 'baseline' ? `Baseline` : col.label}
                  <Icon className="h-3 w-3" aria-hidden />
                </button>
              </TableHead>
            );
          })}
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.length === 0 && (
          <TableRow className="hover:bg-transparent"><TableCell colSpan={6} className="py-12 text-center text-sm text-muted-foreground">No spend to compare for this selection.</TableCell></TableRow>
        )}
        {sorted.map((e) => {
          const up = e.diff > 0;
          const tone = !hasBaseline || e.diff === 0 ? 'text-muted-foreground' : up ? 'text-destructive' : 'text-success';
          const contribution = e.contributionPct;
          return (
            <TableRow key={e.id}>
              <TableCell>
                <div className="flex items-center gap-2.5">
                  <span className="h-8 w-1 shrink-0 rounded-full" style={{ backgroundColor: PROVIDER_COLOR[e.providerId] }} aria-hidden />
                  <div className="min-w-0">
                    <Link href={hrefFor(e)} className="truncate font-medium hover:text-ateneo hover:underline" title="Open in dashboard">{displayName(e)}</Link>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {dimension === 'provider' ? 'Top: ' : dimension === 'account' ? `${PROVIDER_SHORT_NAME[e.providerId]} · top: ` : `${PROVIDER_SHORT_NAME[e.providerId]} · ${e.category?.replace('-', '/')} · top: `}
                      {e.topChild?.label ?? 'n/a'} · {formatPercent(e.sharePct)} of spend
                    </p>
                  </div>
                </div>
              </TableCell>
              <TableCell className="text-right font-medium tabular-nums">{formatCurrency(e.current)}</TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground" title={baselineLabel}>{hasBaseline ? formatCurrency(e.baseline) : '–'}</TableCell>
              <TableCell className={cn('text-right font-medium tabular-nums', tone)}>{hasBaseline ? signedUsd(e.diff) : '–'}</TableCell>
              <TableCell className={cn('text-right tabular-nums', tone)}>{!hasBaseline ? '–' : e.diffPct === null ? 'new' : formatSignedPercent(e.diffPct)}</TableCell>
              <TableCell className="min-w-[140px]">
                {contribution === null ? (
                  <span className="text-muted-foreground">–</span>
                ) : (
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
                      <div className={cn('h-full rounded-full', contribution >= 0 ? 'bg-destructive/70' : 'bg-success/70')} style={{ width: `${Math.min(100, (Math.abs(contribution) / maxContribution) * 100)}%` }} />
                    </div>
                    <span className="w-14 text-right text-xs tabular-nums text-muted-foreground">{formatSignedPercent(contribution, 0)}</span>
                  </div>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
