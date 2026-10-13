'use client';

import { ChevronsLeft, ChevronsRight, Cloud } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAlerts } from '@/components/alerts/alerts-context';
import { useSession } from '@/hooks/use-session';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { DataSourceBadge } from './data-source-badge';
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
  // Admin links appear only for a superadmin. Until the session cookie
  // has been read they are hidden, which is the safe default.
  const groups = navGroupsFor(isSuperadmin);

  return (
    <div className="flex h-full flex-col">
      <div className={cn('flex items-center border-b border-sidebar-border', collapsed ? 'flex-col gap-1.5 px-1.5 py-2' : 'h-12 gap-2 px-2.5')}>
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-bronze text-cream shadow-sm">
          <Cloud className="h-5 w-5" aria-hidden />
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

      <nav aria-label="Primary" className="flex-1 space-y-3 overflow-y-auto px-2 py-2">
        {groups.map((group) => (
          <div key={group.label}>
            {!collapsed && (
              <p className="mb-1.5 px-2 font-slab text-[11px] font-medium uppercase tracking-wider text-khaki">
                {group.label}
              </p>
            )}
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      aria-current={active ? 'page' : undefined}
                      // Collapsed, the badge has nowhere to go, so the
                      // label carries it: the point of the tag is that
                      // nobody reaches the page without having been
                      // told, and a collapsed sidebar is still a way in.
                      title={collapsed ? (item.concept ? `${item.label} (concept — not wired)` : item.label) : undefined}
                      className={cn(
                        'group relative flex items-center gap-3 rounded-md px-2.5 py-2 text-sm font-medium transition-colors',
                        collapsed && 'justify-center px-0',
                        active
                          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                          : 'text-sidebar-muted hover:bg-white/10 hover:text-sidebar-foreground',
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
                      {!collapsed && item.ready && item.concept && (
                        // `warning`, not `secondary`: secondary is
                        // byte-identical to the "Soon" tag two lines
                        // up, and these mean opposite things. "Soon"
                        // is a promise; this is "there is no backend
                        // and there is not going to be one soon".
                        <Badge
                          variant="warning"
                          className="px-1.5 py-0 text-[10px]"
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

      {!collapsed && (
        <div className="border-t border-sidebar-border p-2 pb-12">
          <DataSourceBadge variant="sidebar" />
        </div>
      )}
    </div>
  );
}
