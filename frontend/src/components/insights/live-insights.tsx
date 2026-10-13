'use client';

import { CircleSlash, Info, Loader2, RotateCcw, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';
import { FilterBar } from '@/components/filters/filter-bar';
import { useFilters } from '@/components/filters/filters-context';
import { PageHeader } from '@/components/layout/page-header';
import { ErrorState } from '@/components/shared/error-state';
import { NoDataNotice } from '@/components/shared/no-data-notice';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useInsights, type InsightsQuery } from '@/hooks/use-insights';
import { ApiError } from '@/lib/api/client';
import type { InsightCardRow, InsightNarration, InsightsResponse } from '@/lib/api/insights-api';
import { addDays, toISO } from '@/lib/dates';
import { formatDateRange } from '@/lib/format';
import { scopeOf } from '@/lib/live/dashboard';
import { resolveRange } from '@/lib/selectors/range';
import { getFilterOptions } from '@/lib/services/cost-service';
import { cn } from '@/lib/utils';

/**
 * THE LIVE INSIGHTS PAGE: figures from the API, wording chosen by a model.
 *
 * Three rules this component exists to keep, all from
 * docs/16-insights-api.md:
 *
 *  * FIGURES ARE ALWAYS SHOWN; A SENTENCE IS OPTIONAL. A card whose
 *    `text` is null is complete. It gets its figures and a plain "no
 *    sentence" line -- never text made up here. Browser-generated prose
 *    is exactly what this page used to be, and why it was labelled a
 *    concept.
 *  * SAY WHAT THE MODEL DOES. The API writes every sentence; a model on
 *    Amazon Bedrock picks which wording to show and which card to lead
 *    with. So the label is "Wording selected by AI", and the page says
 *    in words that the figures are not the model's.
 *  * THE FIGURES SIT BESIDE THE SENTENCE. Every card lists the values
 *    its sentence was built from, so a reader can check the claim
 *    without leaving the card.
 */

/**
 * Days before today whose cost is still being restated by the provider.
 * Mirrors `FINAL_LAG_DAYS` in backend/costhub/insights/coverage.py. If
 * the two ever disagree nothing breaks: the API decides, and answers a
 * too-recent window with a note instead of a comparison.
 */
const FINAL_LAG_DAYS = 2;

/** The order figures are listed in, and what each is called on screen. */
const FIGURE_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['service', 'Service'],
  ['account', 'Account'],
  ['date', 'Finding dated'],
  ['kind', "Detector's label"],
  ['current', 'Current period'],
  ['previous', 'Previous period'],
  ['delta_abs', 'Change'],
  ['delta_pct', 'Change (%)'],
  ['total', 'Total in view'],
  ['share', 'Share of total'],
  ['observed', 'Highest daily cost'],
  ['baseline', 'Baseline'],
];

/** `narration.reason`, in words. Anything unlisted falls back to a generic line. */
const REASONS: Record<string, string> = {
  timeout: 'the model did not answer in time',
  throttled: 'the model service is rate-limiting requests',
  access_denied: 'the API is not permitted to call the model',
  model_unavailable: 'the configured model is not available in this account',
  bedrock_error: 'the model service returned an error',
  bedrock_unreachable: 'the model service could not be reached',
  no_valid_choice: 'the model gave no usable answer',
  in_progress: 'another request is preparing them right now',
  budget: "today's allowance of model calls has been used",
  cache_unavailable: 'the store that records model calls is unavailable, so none was made',
  internal_error: 'of an internal error, which has been logged',
  disabled: 'they are switched off on the server',
};

function queryFor(filters: ReturnType<typeof useFilters>['filters']): {
  query: InsightsQuery;
  trimmedTo: string | null;
} {
  const scope = scopeOf(filters);
  const { dataStart, dataEnd } = getFilterOptions();
  // Before the filter options have loaded there is no range to resolve;
  // leaving the dates off takes the API's own default window.
  if (!dataStart || !dataEnd) return { query: scope, trimmedTo: null };

  const range = resolveRange(filters, { start: dataStart, end: dataEnd });
  const lastFinal = addDays(toISO(new Date()), -(FINAL_LAG_DAYS + 1));
  const end = range.to <= lastFinal ? range.to : lastFinal;
  if (range.from > end) return { query: scope, trimmedTo: null };
  return {
    query: { ...scope, start: range.from, end },
    trimmedTo: end < range.to ? end : null,
  };
}

function CardsSkeleton() {
  return (
    <div className="grid gap-3 lg:grid-cols-2" aria-hidden>
      {Array.from({ length: 4 }, (_, i) => (
        <Card key={i} className="space-y-3 p-4">
          <Skeleton className="h-3 w-1/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-16 w-full" />
        </Card>
      ))}
    </div>
  );
}

function Notice({ icon: Icon, children }: { icon: typeof Info; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border bg-muted/40 px-4 py-3 text-sm text-muted-foreground" role="status">
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="space-y-1">{children}</div>
    </div>
  );
}

/** What happened to the sentences, said once, above the cards. */
function NarrationLine({
  narration,
  pending,
  failed,
  onRetry,
}: {
  narration: InsightNarration | null;
  pending: boolean;
  failed: string | null;
  onRetry: () => void;
}) {
  if (pending) {
    return (
      <Notice icon={Loader2}>
        <p>Figures are shown below. Choosing the wording for each card…</p>
      </Notice>
    );
  }
  const retry = (
    <button type="button" onClick={onRetry} className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-2">
      <RotateCcw className="h-3 w-3" aria-hidden /> Try again
    </button>
  );
  if (failed) {
    return (
      <Notice icon={CircleSlash}>
        <p>The figures below are complete. The sentences could not be loaded: {failed} {retry}</p>
      </Notice>
    );
  }
  if (!narration || narration.status === 'no_data' || narration.status === 'off') return null;
  if (narration.status === 'unavailable') {
    const why = REASONS[narration.reason ?? ''] ?? 'they are not available right now';
    return (
      <Notice icon={CircleSlash}>
        <p>
          The figures below are complete. The sentences are missing because {why}. Nothing has been
          filled in to replace them. {retry}
        </p>
      </Notice>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <Badge variant="default"><Sparkles className="h-3 w-3" aria-hidden /> Wording selected by AI</Badge>
      <span>
        The figures and every sentence come from CostHub. A model{narration.model ? ` (${narration.model})` : ''} only
        chose which wording to show and which card to lead with.
      </span>
      {narration.status === 'partial' && (
        <span>{narration.withheld} of {narration.narrated + narration.withheld} cards have no sentence.</span>
      )}
    </div>
  );
}

/** An anomaly's delta is a gap above its baseline, not a change between periods. */
const ANOMALY_LABELS: Record<string, string> = {
  delta_abs: 'Above baseline',
  delta_pct: 'Above baseline (%)',
};

function InsightCardView({ card, lead, sentencesExpected }: { card: InsightCardRow; lead: boolean; sentencesExpected: boolean }) {
  const figures = FIGURE_LABELS.filter(([key]) => card.display[key] !== undefined).map(
    ([key, label]) => [key, (card.kind === 'anomaly' && ANOMALY_LABELS[key]) || label] as const,
  );
  return (
    <Card className={cn('flex flex-col gap-3 p-4', lead && 'border-primary/50 lg:col-span-2')}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{card.title}</h3>
        {lead && (
          <Badge variant="default" title="The model's choice of which card to look at first. A suggestion about order, not a finding.">
            Look here first
          </Badge>
        )}
      </div>

      {card.text ? (
        <p className="text-sm leading-relaxed">{card.text}</p>
      ) : (
        sentencesExpected && <p className="text-sm italic text-muted-foreground">No sentence for this card. Its figures are below.</p>
      )}

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md bg-muted/40 px-3 py-2 text-xs">
        {figures.map(([key, label]) => (
          <div key={key} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="break-words text-right font-medium tabular-nums">{card.display[key]}</dd>
          </div>
        ))}
      </dl>

      {card.kind === 'anomaly' && (
        <Link href="/anomalies" className="self-start text-xs font-medium text-primary underline-offset-2 hover:underline">
          Open on the Anomalies page
        </Link>
      )}
    </Card>
  );
}

function errorMessage(error: Error, fallback: string): string {
  if (error instanceof ApiError && error.status === 404) {
    return 'This API does not serve /insights yet. The endpoint exists in the code and has not been deployed here.';
  }
  return fallback;
}

export function LiveInsights() {
  const { filters } = useFilters();
  const [attempt, setAttempt] = useState(0);
  const { query, trimmedTo } = useMemo(() => queryFor(filters), [filters]);
  const { figures, narrated } = useInsights(query, attempt);
  const retry = () => setAttempt((n) => n + 1);

  // The narrated response supersedes the figures-only one as soon as it
  // is in. Until then -- or if it never comes -- the figures stand.
  const shown: InsightsResponse | null =
    narrated.status === 'ready' ? narrated.data : figures.status === 'ready' ? figures.data : null;
  const loadError = figures.status === 'error' && narrated.status !== 'ready' ? figures : null;
  const refreshing =
    (figures.status === 'ready' && figures.isRefreshing) || (narrated.status === 'ready' && narrated.isRefreshing);

  const cards = useMemo(() => {
    if (!shown) return [];
    const lead = shown.narration.lead;
    // Stable order, with the lead card moved to the front.
    return [...shown.data].sort((a, b) => Number(b.id === lead) - Number(a.id === lead));
  }, [shown]);

  const forbidden = loadError?.error instanceof ApiError && loadError.error.forbidden;

  return (
    <>
      <PageHeader
        title="AI insights"
        description="What changed in your spend, in plain sentences, with the figures each sentence is built from. Computed by CostHub from your cost data; a model only chooses the wording."
      />
      <FilterBar />

      {loadError && !forbidden ? (
        <ErrorState title="Could not load insights" message={errorMessage(loadError.error, loadError.message)} onRetry={retry} />
      ) : forbidden ? (
        <NoDataNotice />
      ) : !shown ? (
        <CardsSkeleton />
      ) : (
        <div className={cn('animate-fade-in space-y-3 transition-opacity duration-150', refreshing && 'opacity-60')} aria-busy={refreshing}>
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{formatDateRange(shown.windows.current.start, shown.windows.current.end)}</span>
            {' compared with '}
            {formatDateRange(shown.windows.previous.start, shown.windows.previous.end)}
            {trimmedTo && ' · the most recent days are left out because their cost is still being finalised'}
            {shown.metric === 'effective_cost' ? ' · amortised cost' : shown.metric === 'billed_cost' ? ' · billed cost' : ''}
          </p>

          {shown.comparison.note && (
            <Notice icon={Info}>
              <p>{shown.comparison.note}</p>
            </Notice>
          )}

          {cards.length === 0 ? (
            !shown.comparison.note && (
              <NoDataNotice range={formatDateRange(shown.windows.current.start, shown.windows.current.end)} />
            )
          ) : (
            <>
              <NarrationLine
                narration={narrated.status === 'ready' ? narrated.data.narration : null}
                pending={narrated.status === 'loading'}
                failed={narrated.status === 'error' ? errorMessage(narrated.error, narrated.message) : null}
                onRetry={retry}
              />
              <div className="grid gap-3 lg:grid-cols-2">
                {cards.map((card) => (
                  <InsightCardView
                    key={card.id}
                    card={card}
                    lead={card.id === shown.narration.lead}
                    sentencesExpected={narrated.status === 'ready' && narrated.data.narration.status !== 'off'}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
