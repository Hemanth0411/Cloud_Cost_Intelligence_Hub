'use client';

import { Bell } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { DropdownMenu, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { useDemoNow } from '@/hooks/use-demo-now';
import { formatRelative } from '@/lib/format';
import { SEVERITY_LABEL } from '@/lib/theme';
import { useAlerts } from './alerts-context';

/** Header bell with the unread count and the latest unread alerts. */
export function NotificationBell() {
  const router = useRouter();
  const { alerts, unread, isRead, setRead, markAllRead } = useAlerts();
  const recent = alerts.filter((a) => !isRead(a)).slice(0, 5);
  const now = useDemoNow();

  return (
    <DropdownMenu
      label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications, none unread'}
      triggerClassName="relative inline-flex h-9 w-9 items-center justify-center rounded-md transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      menuClassName="w-80"
      trigger={
        <>
          <Bell className="h-4 w-4" aria-hidden />
          {unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-destructive-foreground" aria-hidden>
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </>
      }
    >
      <DropdownMenuLabel>
        <span className="text-sm font-medium text-foreground">Notifications</span> · {unread} unread
      </DropdownMenuLabel>
      <DropdownMenuSeparator />
      {recent.length === 0 && <DropdownMenuLabel>You are all caught up.</DropdownMenuLabel>}
      {recent.map((a) => (
        <DropdownMenuItem
          key={a.id}
          onSelect={() => {
            setRead(a.id, true);
            router.push('/alerts');
          }}
        >
          <span className="block min-w-0">
            <span className="block truncate text-sm font-medium">{a.title}</span>
            <span className="block text-xs text-muted-foreground">{SEVERITY_LABEL[a.severity]} · {formatRelative(a.timestamp, now)}</span>
          </span>
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={markAllRead} disabled={unread === 0}>Mark all as read</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => router.push('/alerts')}>View all alerts</DropdownMenuItem>
    </DropdownMenu>
  );
}
