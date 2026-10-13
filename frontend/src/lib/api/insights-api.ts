/**
 * `GET /insights`, typed. The wire layer only -- see docs/16-insights-api.md.
 *
 * WHAT THIS ENDPOINT IS, because the screen must not claim more:
 *
 *  * The FIGURES are computed by the API from the caller's own cost
 *    data, through the same grant scoping as every chart.
 *  * The SENTENCES are written by the API too. A model on Amazon
 *    Bedrock only chooses which wording to show for each card and which
 *    card to lead with. It does not write, and it does not compute.
 *    "Wording selected by AI" is true. "Written by AI" is not.
 *  * `text` CAN BE NULL on any card, for reasons `narration` explains.
 *    A card without a sentence is a complete card. Nothing here may
 *    fill that gap with text generated in the browser -- that is the
 *    exact thing this endpoint replaced.
 *
 * TWO THINGS ABOUT THE WIRE THE TYPES CANNOT SAY:
 *
 *  * `figures`, `display` and `refused` are passed through UN-RENAMED.
 *    Their keys are data: `display.delta_abs` is rendered as a labelled
 *    row, and `refused` is keyed by card id (`top_increase`), which the
 *    camel-caser would otherwise rewrite to `topIncrease` and detach
 *    from the card it describes.
 *  * Money in `figures` is an exact decimal STRING. Nothing on the page
 *    parses it: `display` carries the same values already formatted,
 *    and those are what a reader checks the sentence against.
 */
import { get } from '@/lib/api/client';
import type { CostScope } from '@/lib/api/cost-api';
import { reportAsOf } from '@/lib/services/data-status';

export type InsightCardKind =
  | 'total'
  | 'total_change'
  | 'top_service'
  | 'top_increase'
  | 'top_decrease'
  | 'new_service'
  | 'account_mover'
  | 'anomaly';

export interface InsightCardRow {
  id: string;
  kind: InsightCardKind;
  /** Written by the API. This is where rank is stated. */
  title: string;
  direction: 'up' | 'down' | 'flat' | 'none';
  subject: Record<string, unknown>;
  figures: Record<string, string | number | null>;
  /** The figures as formatted text, keyed by snake_case field name. */
  display: Record<string, string>;
  text: string | null;
}

export type NarrationStatus = 'ok' | 'partial' | 'unavailable' | 'off' | 'no_data';

export interface InsightNarration {
  status: NarrationStatus;
  reason: string | null;
  model: string | null;
  cached: boolean;
  stored: boolean;
  generatedAt: string | null;
  expiresAt: string | null;
  narrated: number;
  withheld: number;
  /** Card id -> why it has no sentence. */
  refused: Record<string, string>;
  /** The card the model would show first. Editorial, not a claim. */
  lead: string | null;
}

export interface InsightComparison {
  comparable: boolean;
  currentDaysWithData: number;
  previousDaysWithData: number;
  daysInPeriod: number;
  accountsChecked: number;
  /** A sentence the API wrote explaining why no change is reported. */
  note: string | null;
}

export interface InsightsResponse {
  data: InsightCardRow[];
  asOf: string | null;
  metric: string | null;
  currency: string;
  partialPeriod: boolean;
  rowCount: number;
  windows: {
    current: { start: string; end: string };
    previous: { start: string; end: string };
  };
  comparison: InsightComparison;
  narration: InsightNarration;
}

export async function fetchInsights(
  args: CostScope & {
    /** Inclusive `yyyy-MM-dd`. Omit both to take the API's default window. */
    start?: string;
    end?: string;
    /** `false` returns the figures and makes no model call. */
    narrate: boolean;
  },
): Promise<InsightsResponse> {
  const response = await get<InsightsResponse>('/insights', {
    query: {
      start: args.start,
      end: args.end,
      provider: args.provider,
      account_id: args.accountId,
      service: args.service,
      narrate: args.narrate,
    },
    opaque: ['figures', 'display', 'refused', 'subject'],
  });
  reportAsOf(response.asOf);
  return response;
}
