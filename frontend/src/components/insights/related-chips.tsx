import Link from 'next/link';
import { dashboardLink } from '@/lib/links';
import { getFilterOptions } from '@/lib/services/cost-service';
import { PROVIDER_COLOR } from '@/lib/theme';

/** Account and service chips that jump to the dashboard filtered to that account/service. */
export function RelatedChips({ accountIds, serviceIds }: { accountIds: string[]; serviceIds: string[] }) {
  const { accounts, services } = getFilterOptions();
  const accountChips = accountIds.flatMap((id) => {
    const a = accounts.find((x) => x.id === id);
    return a ? [{ key: `a-${id}`, label: a.name, providerId: a.providerId, href: dashboardLink({ accountId: id }) }] : [];
  });
  const serviceChips = serviceIds.flatMap((id) => {
    const s = services.find((x) => x.id === id);
    return s ? [{ key: `s-${id}`, label: s.name, providerId: s.providerId, href: dashboardLink({ serviceId: id }) }] : [];
  });
  const chips = [...accountChips, ...serviceChips];
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-muted-foreground">Related:</span>
      {chips.map((c) => (
        <Link key={c.key} href={c.href} title="Open in dashboard" className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: PROVIDER_COLOR[c.providerId] }} aria-hidden />
          {c.label}
        </Link>
      ))}
    </div>
  );
}
