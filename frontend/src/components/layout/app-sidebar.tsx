'use client';

import { ChevronsLeft, ChevronsRight, Cloud } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAlerts } from '@/components/alerts/alerts-context';
import { useMode } from '@/hooks/use-mode';
import { useSession } from '@/hooks/use-session';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { navGroupsFor } from './nav-config';

interface SidebarContentProps {
  collapsed: boolean;
  onNavigate?: () => void;
  onToggleCollapse?: () => void;
}

export function SidebarContent({ collapsed, onNavigate, onToggleCollapse }: SidebarContentProps) {
  const pathname = usePathname();
  const { unread } = useAlerts();
  const { isSuperadmin } = useSession();
  // Some pages are a concept only on mock data and real against the API.
  const { mock } = useMode();
  // Admin links appear only for a superadmin. Until the session cookie
  // has been read they are hidden, which is the safe default.
  const groups = navGroupsFor(isSuperadmin);

  return (
    <div className="flex h-full flex-col">
      <div className={cn('flex items-center border-b border-sidebar-border', collapsed ? 'flex-col gap-1 px-1.5 py-2' : 'h-12 gap-2 px-3')}>
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-bronze text-foreground">
          <Cloud className="h-4 w-4" aria-hidden />
        </div>
        {!collapsed && (
          <div className="min-w-0 flex-1 leading-tight">
            <p className="font-slab text-sm font-semibold tracking-tight text-sidebar-foreground">CostHub</p>
            <p className="font-slab text-[11px] text-khaki">Cost Intelligence</p>
          </div>
        )}
        {onToggleCollapse && (
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-sidebar-muted transition-colors hover:bg-white/10 hover:text-sidebar-foreground"
          >
            {collapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
          </button>
        )}
      </div>

      <nav aria-label="Primary" className="flex-1 space-y-4 overflow-y-auto py-3">
        {groups.map((group) => (
          <div key={group.label}>
            {!collapsed && (
              <p className="mb-1 px-4 text-[11px] font-medium text-sidebar-muted">
                {group.label}
              </p>
            )}
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                const Icon = item.icon;
                const concept = item.concept === true || (item.concept === 'mock' && mock);
                return (
                  <li key={item.href} className="relative">
                    {active && (
                      <span className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-bronze" aria-hidden />
                    )}
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      aria-current={active ? 'page' : undefined}
                      // Collapsed, the badge has nowhere to go, so the
                      // label carries it: the point of the tag is that
                      // nobody reaches the page without having been
                      // told, and a collapsed sidebar is still a way in.
                      title={collapsed ? (concept ? `${item.label} (concept — not wired)` : item.label) : undefined}
                      className={cn(
                        'relative mx-2 flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors',
                        collapsed && 'mx-1.5 justify-center px-0',
                        active
                          ? 'bg-white/10 text-sidebar-foreground'
                          : 'text-sidebar-muted hover:bg-white/5 hover:text-sidebar-foreground',
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" aria-hidden />
                      {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
                      {item.badge === 'alerts' && unread > 0 && (
                        <span
                          className={cn('flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1.5 text-[10px] font-semibold leading-none text-destructive-foreground', collapsed && 'absolute right-1 top-1 h-4 min-w-4 px-1')}
                          aria-label={`${unread} unread alerts`}
                        >
                          {unread > 99 ? '99+' : unread}
                        </span>
                      )}
                      {!collapsed && !item.ready && (
                        <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                          Soon
                        </Badge>
                      )}
                      {!collapsed && item.ready && concept && (
                        // `warning`, not `secondary`: secondary is
                        // byte-identical to the "Soon" tag two lines
                        // up, and these mean opposite things. "Soon"
                        // is a promise; this is "there is no backend
                        // and there is not going to be one soon".
                        <Badge
                          variant="warning"
                          className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold"
                          title="A design. Nothing on this page is computed from your data."
                        >
                          Concept
                        </Badge>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

    </div>
  );
}
