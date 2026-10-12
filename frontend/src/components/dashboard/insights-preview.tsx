import { ArrowRight, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { KIND_META } from '@/components/insights/insight-card';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import type { InsightReport } from '@/lib/insights/generate';
import { cn } from '@/lib/utils';
import type { InsightPriority } from '@/types/domain';

const DOT: Record<InsightPriority, string> = { high: 'bg-destructive', medium: 'bg-warning', low: 'bg-muted-foreground' };

/** Dashboard teaser for the AI insights page: the executive summary plus the top findings. */
export function InsightsPreview({ report }: { report: InsightReport }) {
  const top = report.insights.slice(0, 3);
  return (
    <Card className="relative overflow-hidden">
      <div className="pointer-events-none absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-ateneo to-bronze" aria-hidden />
      <div className="grid gap-3 p-3 pl-4 lg:grid-cols-5">
        <div className="space-y-3 lg:col-span-3">
          <div className="flex flex-wrap items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" aria-hidden />
            <h2 className="text-sm font-semibold">AI summary</h2>
            <Badge variant="outline">Simulated · rule-based</Badge>
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">{report.headline}</p>
          <Link href="/insights" className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
            See all insights and optimization ideas <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </div>
        <ul className="space-y-2.5 lg:col-span-2" aria-label="Top insights">
          {top.map((i) => {
            const Icon = KIND_META[i.kind].icon;
            return (
              <li key={i.id} className="flex items-start gap-2.5 text-sm">
                <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', DOT[i.priority])} aria-hidden />
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="leading-snug">{i.title}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </Card>
  );
}
