'use client';

import { Activity, Cloud, ShieldCheck, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { useMode } from '@/hooks/use-mode';

const HIGHLIGHTS = [
  { icon: Activity, title: 'Anomaly detection', text: 'Catch runaway spend the day it happens.' },
  { icon: Sparkles, title: 'AI-powered insights', text: 'Ranked savings opportunities across clouds.' },
  { icon: ShieldCheck, title: 'Budget guardrails', text: 'Projected burn and alerts per account.' },
];

/** Split-screen frame shared by every authentication page. */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <aside className="relative hidden overflow-hidden bg-ateneo p-8 text-cream lg:flex lg:flex-col lg:justify-between">
        <div className="surface-grid absolute inset-0 opacity-[0.07]" aria-hidden />
        <div className="absolute -left-24 top-1/3 h-96 w-96 rounded-full bg-bronze/25 blur-3xl" aria-hidden />
        <div className="absolute -bottom-24 right-0 h-80 w-80 rounded-full bg-khaki/20 blur-3xl" aria-hidden />

        <div className="relative flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-bronze text-cream">
            <Cloud className="h-5 w-5" aria-hidden />
          </div>
          <span className="font-slab text-lg font-semibold tracking-tight">CloudLens</span>
        </div>

        <div className="relative max-w-md space-y-8">
          <div className="space-y-3">
            <p className="font-slab text-4xl font-semibold leading-tight tracking-tight text-khaki">
              See every cloud dollar. <span className="text-cream">Before it surprises you.</span>
            </p>
            <p className="text-cream/75">One intelligent view of AWS, Azure, and Google Cloud spend, with forecasts, anomalies, and AI-guided savings.</p>
          </div>
          <ul className="space-y-4">
            {HIGHLIGHTS.map(({ icon: Icon, title, text }) => (
              <li key={title} className="flex gap-3">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-white/10"><Icon className="h-4 w-4" aria-hidden /></span>
                <div>
                  <p className="font-slab text-sm font-medium text-cream">{title}</p>
                  <p className="text-sm text-cream/65">{text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* Rendered behind the Cognito hand-off too, where every
            word of the old version was wrong. */}
        <AuthFooterNote />
      </aside>

      <main className="flex items-center justify-center bg-background p-3">
        <div className="w-full max-w-sm space-y-3">{children}</div>
      </main>
    </div>
  );
}

/** Reminder shown on every auth page: nothing here is real. */
export function DemoNotice({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">{children}</div>
  );
}

/**
 * What this sign-in actually is.
 *
 * Mock mode checks a password against `localStorage`; live mode hands
 * off to Cognito Managed Login and comes back with a real OIDC token.
 * The footer said "mock data only · simulated authentication" in both.
 */
function AuthFooterNote() {
  const { mock, resolved } = useMode();
  if (!resolved) return <p className="relative text-xs text-cream/50">&nbsp;</p>;
  return (
    <p className="relative text-xs text-cream/50">
      {mock
        ? 'Mock mode · generated data · sign-in simulated in your browser'
        : 'Live mode · sign-in handled by Amazon Cognito'}
    </p>
  );
}
