import type { Metadata } from 'next';
import { DashboardView } from '@/components/dashboard/dashboard-view';
import { PageHeader } from '@/components/layout/page-header';

export const metadata: Metadata = { title: 'Dashboard' };

export default function DashboardPage() {
  return (
    <>
      <PageHeader
        title="Cost overview"
        description="Multi-cloud spend, forecast, budget health, and anomalies in one place."
      />
      <DashboardView />
    </>
  );
}
