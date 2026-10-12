'use client';

import { Activity, CloudOff, FlaskConical, Gauge, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ACTION_LABELS, availableActions, type AlertAction } from '@/lib/alerts/actions';
import { formatDateTime, formatRelative } from '@/lib/format';
import { dashboardLink } from '@/lib/links';
import { ALERT_CATEGORY_LABEL, ALERT_STATUS_CLASS, ALERT_STATUS_LABEL, SEVERITY_CLASS, SEVERITY_LABEL } from '@/lib/theme';
import { cn } from '@/lib/utils';
import type { AlertCategory, AlertItem } from '@/types/domain';

const ICON: Record<AlertCategory, LucideIcon> = { anomaly: Activity, budget: Gauge, connection: CloudOff, simulated: FlaskConical };

interface AlertRowProps {
  alert: AlertItem;
  read: boolean;
  now: Date;
  /** Channels this alert would be delivered through (always simulated). */
  channels: string[];
  onToggleRead: () => void;
  onAction: (action: AlertAction) => void;
  onInvestigate?: () => void;
}

export function AlertRow({ alert, read, now, channels, onToggleRead, onAction, onInvestigate }: AlertRowProps) {
  const Icon = ICON[alert.category];
  const actions = availableActions(alert.status);
  const detailHref =
    alert.category === 'budget' && alert.accountId ? dashboardLink({ accountId: alert.accountId })
      : alert.category === 'connection' && alert.accountId ? '/accounts'
        : null;

  return (
    <li className={cn('flex gap-3 border-b px-4 py-2.5 last:border-0 sm:px-3', !read && 'bg-accent/30')}>
      <span className="mt-2 flex w-2 shrink-0 justify-center" aria-hidden>
        {!read && <span className="h-2 w-2 rounded-full bg-primary" />}
      </span>
      <span className={cn('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md', SEVERITY_CLASS[alert.severity])}>
        <Icon className="h-4 w-4" aria-hidden />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className={cn('text-sm leading-snug', read ? 'font-medium' : 'font-semibold')}>
            {!read && <span className="sr-only">Unread: </span>}
            {alert.title}
          </p>
          <Badge className={SEVERITY_CLASS[alert.severity]}>{SEVERITY_LABEL[alert.severity]}</Badge>
          <Badge className={ALERT_STATUS_CLASS[alert.status]}>{ALERT_STATUS_LABEL[alert.status]}</Badge>
          <Badge variant="outline">{ALERT_CATEGORY_LABEL[alert.category]}</Badge>
        </div>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{alert.message}</p>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <time dateTime={alert.timestamp} title={formatDateTime(alert.timestamp)} className="tabular-nums">{formatRelative(alert.timestamp, now)} · {formatDateTime(alert.timestamp)}</time>
          {channels.length > 0 && <span>· Notified via {channels.join(', ')}</span>}
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {actions.map((action) => (
            <Button key={action} size="sm" variant={action === 'resolve' ? 'default' : action === 'acknowledge' ? 'outline' : 'ghost'} onClick={() => onAction(action)}>
              {ACTION_LABELS[action]}
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={onToggleRead}>{read ? 'Mark unread' : 'Mark read'}</Button>
          {onInvestigate && <Button size="sm" variant="outline" onClick={onInvestigate}>Investigate</Button>}
          {detailHref && <Link href={detailHref} className="text-xs font-medium text-primary hover:underline">{alert.category === 'connection' ? 'Manage account' : 'View account'}</Link>}
        </div>
      </div>
    </li>
  );
}
