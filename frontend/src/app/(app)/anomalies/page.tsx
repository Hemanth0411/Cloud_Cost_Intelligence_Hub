import type { Metadata } from 'next';
import { AnomaliesView } from '@/components/anomalies/anomalies-view';

export const metadata: Metadata = { title: 'Anomalies' };

export default function AnomaliesPage() {
  return <AnomaliesView />;
}
