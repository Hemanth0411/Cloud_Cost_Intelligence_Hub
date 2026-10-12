import { Suspense, type ReactNode } from 'react';
import { AlertsProvider } from '@/components/alerts/alerts-context';
import { DetectionConfigProvider } from '@/components/anomalies/detection-config-context';
import { ConnectionsProvider } from '@/components/connections/connections-context';
import { AnomalyStatusProvider } from '@/components/dashboard/anomaly-status-context';
import { FiltersProvider } from '@/components/filters/filters-context';
import { AppShell } from '@/components/layout/app-shell';
import { ToastProvider } from '@/components/ui/toast';

/**
 * Provider order matters: toasts first (used by everything), then URL filters, detection thresholds and the
 * anomaly workflow, then connections, and finally alerts, which derive from all of the above.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    // useSearchParams (URL-synced filters) requires a Suspense boundary.
    <Suspense fallback={<div className="h-screen bg-background" />}>
      <ToastProvider>
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
      </ToastProvider>
    </Suspense>
  );
}
