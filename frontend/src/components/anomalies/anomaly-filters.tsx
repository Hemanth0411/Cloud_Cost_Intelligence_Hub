'use client';

import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { DEFAULT_ANOMALY_FILTER, type AnomalyFilter } from '@/lib/selectors/anomaly-views';
import { KIND_LABELS } from '@/lib/selectors/detect-anomalies';
import { SEVERITY_LABEL } from '@/lib/theme';
import type { AnomalyKind, AnomalyStatus, Severity } from '@/types/domain';

interface AnomalyFiltersProps {
  value: AnomalyFilter;
  onChange: (value: AnomalyFilter) => void;
  shown: number;
  total: number;
}

const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low'];
const KINDS: readonly AnomalyKind[] = ['spike', 'sustained-increase', 'drop', 'sustained-decrease'];
const STATUSES: ReadonlyArray<{ value: AnomalyStatus | 'active'; label: string }> = [
  { value: 'active', label: 'Active (not resolved)' },
  { value: 'open', label: 'Open' },
  { value: 'investigating', label: 'Investigating' },
  { value: 'acknowledged', label: 'Acknowledged' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'dismissed', label: 'Dismissed' },
];

export function AnomalyFilters({ value, onChange, shown, total }: AnomalyFiltersProps) {
  const isDefault = JSON.stringify(value) === JSON.stringify(DEFAULT_ANOMALY_FILTER);
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <label className="sr-only" htmlFor="af-severity">Severity</label>
      <Select id="af-severity" className="sm:w-40" value={value.severity} onChange={(e) => onChange({ ...value, severity: e.target.value as Severity | 'all' })}>
        <option value="all">All severities</option>
        {SEVERITIES.map((s) => <option key={s} value={s}>{SEVERITY_LABEL[s]}</option>)}
      </Select>

      <label className="sr-only" htmlFor="af-status">Status</label>
      <Select id="af-status" className="sm:w-48" value={value.status} onChange={(e) => onChange({ ...value, status: e.target.value as AnomalyFilter['status'] })}>
        <option value="all">All statuses</option>
        {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
      </Select>

      <label className="sr-only" htmlFor="af-kind">Type</label>
      <Select id="af-kind" className="sm:w-48" value={value.kind} onChange={(e) => onChange({ ...value, kind: e.target.value as AnomalyKind | 'all' })}>
        <option value="all">All types</option>
        {KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
      </Select>

      <Button variant="ghost" size="sm" onClick={() => onChange(DEFAULT_ANOMALY_FILTER)} disabled={isDefault}>
        <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Clear
      </Button>
      <p className="text-xs text-muted-foreground tabular-nums sm:ml-auto" aria-live="polite">Showing {shown} of {total}</p>
    </div>
  );
}
