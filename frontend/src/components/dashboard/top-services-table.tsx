import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatCurrency, formatPercent, formatSignedPercent } from '@/lib/format';
import { PROVIDER_COLOR, PROVIDER_SHORT_NAME } from '@/lib/theme';
import { cn } from '@/lib/utils';
import type { BreakdownItem } from '@/types/analytics';

const TOP_N = 8;

export function TopServicesTable({ services }: { services: BreakdownItem[] }) {
  const top = services.slice(0, TOP_N);
  const max = Math.max(1, ...top.map((s) => s.cost));

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Top expensive services</CardTitle>
        <CardDescription>Highest-cost services in the selected period</CardDescription>
      </CardHeader>
      <CardContent className="px-0 pb-2">
        <Table className="min-w-[440px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-10">#</TableHead>
              <TableHead>Service</TableHead>
              <TableHead className="text-right">Spend</TableHead>
              <TableHead className="text-right">vs prev</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {top.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={4} className="py-10 text-center text-muted-foreground">No spend for this selection.</TableCell>
              </TableRow>
            )}
            {top.map((s, index) => (
              <TableRow key={s.id}>
                <TableCell className="text-xs text-muted-foreground tabular-nums">{index + 1}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2.5">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: PROVIDER_COLOR[s.providerId] }} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{s.label}</p>
                      <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full" style={{ width: `${(s.cost / max) * 100}%`, backgroundColor: PROVIDER_COLOR[s.providerId] }} />
                      </div>
                    </div>
                  </div>
                  <p className="mt-0.5 pl-[18px] text-[11px] capitalize text-muted-foreground">
                    {PROVIDER_SHORT_NAME[s.providerId]} · {s.category?.replace('-', '/')} · {formatPercent(s.sharePct)} of spend
                  </p>
                </TableCell>
                <TableCell className="text-right font-medium tabular-nums">{formatCurrency(s.cost)}</TableCell>
                <TableCell className={cn('text-right text-sm tabular-nums', s.deltaPct === null ? 'text-muted-foreground' : s.deltaPct > 0 ? 'text-destructive' : 'text-success')}>
                  {s.deltaPct === null ? '–' : formatSignedPercent(s.deltaPct)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
