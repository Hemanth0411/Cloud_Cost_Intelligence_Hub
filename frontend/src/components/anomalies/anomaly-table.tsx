'use client';

import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, MoreHorizontal, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { buttonVariants, Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { workflowActions } from '@/lib/anomaly-workflow';
import { formatCurrency, formatDate, formatSignedPercent } from '@/lib/format';
import { isIncrease, KIND_LABELS } from '@/lib/selectors/detect-anomalies';
import { SEVERITY_ORDER } from '@/lib/selectors/anomaly-views';
import {
  ABSENT,
  ANOMALY_KIND_CLASS,
  ANOMALY_STATUS_CLASS,
  ANOMALY_STATUS_LABEL,
  PROVIDER_COLOR,
  PROVIDER_SHORT_NAME,
  severityClass,
  severityLabel,
} from '@/lib/theme';
import { cn } from '@/lib/utils';
import type { AnomalyView } from '@/types/analytics';
import type { AnomalyStatus } from '@/types/domain';

type SortKey = 'date' | 'severity' | 'observed' | 'difference' | 'change' | 'status';
type SortDir = 'asc' | 'desc';

const PAGE_SIZE = 10;
const STATUS_RANK: Record<AnomalyStatus, number> = { open: 0, investigating: 1, acknowledged: 2, resolved: 3, dismissed: 4 };

const COLUMNS: Array<{ key: SortKey | null; label: string; align?: 'right' }> = [
  { key: 'date', label: 'Detected' },
  { key: 'severity', label: 'Severity' },
  { key: null, label: 'Type' },
  { key: null, label: 'Account · Service' },
  { key: 'observed', label: 'Observed', align: 'right' },
  { key: null, label: 'Expected', align: 'right' },
  { key: 'difference', label: 'Difference', align: 'right' },
  { key: 'change', label: 'Change', align: 'right' },
  { key: 'status', label: 'Status' },
];

function compare(a: AnomalyView, b: AnomalyView, key: SortKey): number {
  switch (key) {
    case 'date':
      return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    case 'severity':
      return SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity);
    case 'observed':
      return a.observedCost - b.observedCost;
    case 'difference':
      return Math.abs(a.differenceCost) - Math.abs(b.differenceCost);
    case 'change':
      // A finding with no comparable baseline sorts below every
      // measured one rather than as a 0% change.
      return Math.abs(a.changePct ?? -Infinity) - Math.abs(b.changePct ?? -Infinity);
    case 'status':
      return STATUS_RANK[b.status] - STATUS_RANK[a.status];
  }
}

const signedUsd = (v: number): string => `${v >= 0 ? '+' : '−'}${formatCurrency(Math.abs(v))}`;

interface AnomalyTableProps {
  anomalies: AnomalyView[];
  onOpen: (anomaly: AnomalyView) => void;
  onSetStatus: (anomaly: AnomalyView, status: AnomalyStatus) => void;
}

export function AnomalyTable({ anomalies, onOpen, onSetStatus }: AnomalyTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [page, setPage] = useState(0);

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...anomalies].sort((a, b) => compare(a, b, sortKey) * dir || (a.id < b.id ? -1 : 1));
  }, [anomalies, sortKey, sortDir]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const visible = sorted.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  // A new filter result starts from the first page.
  useEffect(() => setPage(0), [anomalies.length]);

  function onSort(key: SortKey): void {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir('desc');
    }
  }

  return (
    <div>
      <Table className="min-w-[1000px]">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {COLUMNS.map((col) => {
              const active = col.key !== null && sortKey === col.key;
              const Icon = !active ? ArrowUpDown : sortDir === 'asc' ? ArrowUp : ArrowDown;
              return (
                <TableHead key={col.label} className={col.align === 'right' ? 'text-right' : undefined} aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}>
                  {col.key === null ? (
                    col.label
                  ) : (
                    <button type="button" onClick={() => onSort(col.key as SortKey)} className={cn('inline-flex items-center gap-1 uppercase tracking-wide text-inherit hover:text-foreground', active && 'text-foreground')}>
                      {col.label}
                      <Icon className="h-3 w-3" aria-hidden />
                    </button>
                  )}
                </TableHead>
              );
            })}
            <TableHead className="w-12"><span className="sr-only">Actions</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.length === 0 && (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={COLUMNS.length + 1} className="py-8 text-center text-sm text-muted-foreground">
                No anomalies match these filters.
              </TableCell>
            </TableRow>
          )}
          {visible.map((a) => {
            const increase = isIncrease(a.kind);
            const actions = workflowActions(a.status);
            return (
              <TableRow key={a.id} className="cursor-pointer" onClick={() => onOpen(a)}>
                <TableCell className="whitespace-nowrap tabular-nums">{formatDate(a.date, 'medium')}</TableCell>
                <TableCell><Badge className={severityClass(a.severity)}>{severityLabel(a.severity)}</Badge></TableCell>
                <TableCell><Badge className={ANOMALY_KIND_CLASS[a.kind]}>{KIND_LABELS[a.kind]}</Badge></TableCell>
                <TableCell>
                  <div className="flex items-center gap-2.5">
                    <span className="h-8 w-1 shrink-0 rounded-full" style={{ backgroundColor: PROVIDER_COLOR[a.providerId] }} aria-hidden />
                    <div className="min-w-0">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpen(a);
                        }}
                        className="truncate rounded text-left font-medium hover:text-ateneo focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {a.serviceName}
                      </button>
                      <p className="truncate text-xs text-muted-foreground">{PROVIDER_SHORT_NAME[a.providerId]} · {a.accountName}</p>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <p className="font-medium">{formatCurrency(a.observedCost)}</p>
                  {(a.windowDays ?? 1) > 1 && <p className="text-[11px] text-muted-foreground">daily median</p>}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{formatCurrency(a.expectedCost)}</TableCell>
                <TableCell className={cn('text-right font-medium tabular-nums', increase ? 'text-destructive' : 'text-ateneo')}>{signedUsd(a.differenceCost)}</TableCell>
                <TableCell
                  className={cn('text-right tabular-nums', a.changePct === null ? 'text-muted-foreground' : increase ? 'text-destructive' : 'text-ateneo')}
                  title={a.changePct === null ? 'No prior spend, so there is no percentage to compare against.' : undefined}
                >
                  {a.changePct === null ? ABSENT : formatSignedPercent(a.changePct, 0)}
                </TableCell>
                <TableCell><Badge className={ANOMALY_STATUS_CLASS[a.status]}>{ANOMALY_STATUS_LABEL[a.status]}</Badge></TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <DropdownMenu
                    label={`Actions for ${a.serviceName} anomaly on ${a.date}`}
                    triggerClassName={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), 'h-8 w-8')}
                    trigger={<MoreHorizontal className="h-4 w-4" aria-hidden />}
                  >
                    <DropdownMenuItem icon={<Search className="h-4 w-4" />} onSelect={() => {
                      if (a.status === 'open' || a.status === 'acknowledged') onSetStatus(a, 'investigating');
                      onOpen(a);
                    }}>
                      Investigate
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    {actions
                      .filter((action) => !(action.to === 'investigating'))
                      .map((action) => (
                        <DropdownMenuItem key={action.to} onSelect={() => onSetStatus(a, action.to)} destructive={action.to === 'dismissed'}>
                          {action.label}
                        </DropdownMenuItem>
                      ))}
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      <div className="flex items-center justify-between border-t px-4 py-3 text-xs text-muted-foreground">
        <span className="tabular-nums">
          {sorted.length === 0 ? '0 results' : `${safePage * PAGE_SIZE + 1}–${Math.min((safePage + 1) * PAGE_SIZE, sorted.length)} of ${sorted.length}`}
        </span>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" onClick={() => setPage(safePage - 1)} disabled={safePage === 0} aria-label="Previous page">
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
          </Button>
          <span className="px-2 tabular-nums">Page {safePage + 1} of {pageCount}</span>
          <Button variant="outline" size="sm" onClick={() => setPage(safePage + 1)} disabled={safePage >= pageCount - 1} aria-label="Next page">
            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </div>
      </div>
    </div>
  );
}
