import { Suspense, type ReactNode } from 'react';
import { AlertsProvider } from '@/components/alerts/alerts-context';
import { DetectionConfigProvider } from '@/components/anomalies/detection-config-context';
import { ConnectionsProvider } from '@/components/connections/connections-context';
import { AnomalyStatusProvider } from '@/components/dashboard/anomaly-status-context';
import { FiltersProvider } from '@/components/filters/filters-context';
import { AppDataGate } from '@/components/layout/app-data-gate';
import { AppShell } from '@/components/layout/app-shell';
import { ToastProvider } from '@/components/ui/toast';

/**
 * Provider order matters: toasts first (used by everything), then URL filters, detection thresholds and the
 * anomaly workflow, then connections, and finally alerts, which derive from all of the above.
 *
 * AppDataGate is OUTSIDE FiltersProvider on purpose: the filter
 * parser validates `?account=` against the accounts the caller can
 * see, so the options have to exist before it runs. See the note in
 * app-data-gate.tsx.
 *
 * AdminProvider is NOT here. It reads four endpoints on mount and only
 * the /admin/* screens consume it, so it lives in admin/layout.tsx --
 * see the note there.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    // useSearchParams (URL-synced filters) requires a Suspense boundary.
    <Suspense fallback={<div className="h-screen bg-background" />}>
      <ToastProvider>
        <AppDataGate>
          <FiltersProvider>
            <DetectionConfigProvider>
              <AnomalyStatusProvider>
                <ConnectionsProvider>
                  <AlertsProvider>
                    <AppShell>{children}</AppShell>
                  </AlertsProvider>
                </ConnectionsProvider>
              </AnomalyStatusProvider>
            </DetectionConfigProvider>
          </FiltersProvider>
        </AppDataGate>
      </ToastProvider>
    </Suspense>
  );
}
