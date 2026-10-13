import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

function ChartCardSkeleton({ height }: { height: number }) {
  return (
    <Card className="space-y-3 p-3">
      <Skeleton className="h-4 w-40" />
      <Skeleton className="w-full" style={{ height }} />
    </Card>
  );
}

export function DashboardSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading dashboard">
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <Card key={i} className="space-y-3 p-3">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-8 w-32" />
            <Skeleton className="h-8 w-full" />
          </Card>
        ))}
      </section>
      <div className="grid gap-3 xl:grid-cols-3">
        <div className="xl:col-span-2"><ChartCardSkeleton height={340} /></div>
        <ChartCardSkeleton height={340} />
      </div>
      <div className="grid gap-3 xl:grid-cols-3">
        <div className="xl:col-span-2"><ChartCardSkeleton height={340} /></div>
        <ChartCardSkeleton height={340} />
      </div>
    </div>
  );
}
