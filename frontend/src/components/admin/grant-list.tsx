'use client';

import { ShieldOff } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatDate } from '@/lib/format';
import type { Grant } from '@/types/domain';

/** Days until a grant lapses, or null if it never does. */
function daysLeft(grant: Grant, now: Date): number | null {
  if (!grant.validUntil) return null;
  return Math.ceil((new Date(grant.validUntil).getTime() - now.getTime()) / 86_400_000);
}

/**
 * The grants held by one user.
 *
 * Shared by the users table and the user detail panel rather than being
 * written twice, since "what can this person see" is the question both
 * are answering.
 *
 * Expiry is surfaced, not just stored: a grant that lapses takes the
 * user's dashboard to empty and stops their alerts, with no error
 * anywhere. Saying "3 days left" beforehand is the only warning there is.
 */
export function GrantList({
  grants,
  now,
  onRevoke,
}: {
  grants: Grant[];
  now: Date;
  onRevoke?: (grant: Grant) => void;
}) {
  if (grants.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No access. This user can sign in and will see an empty dashboard.
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {grants.map((grant) => {
        const left = daysLeft(grant, now);
        const expiring = left !== null && left <= 7;
        return (
          <li
            key={grant.id}
            className="flex items-start justify-between gap-3 rounded-md border border-border/60 px-3 py-2"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{grant.accountName}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {grant.serviceName ?? 'All services'}
                {grant.reason ? ` · ${grant.reason}` : ''}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Granted {formatDate(grant.grantedAt)} by {grant.grantedBy}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {grant.serviceName && (
                <Badge variant="outline" title="Narrowed to one service">
                  Service-scoped
                </Badge>
              )}
              {left !== null && (
                <Badge variant={expiring ? 'warning' : 'outline'}>
                  {left <= 0 ? 'Expired' : `${left}d left`}
                </Badge>
              )}
              {onRevoke && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onRevoke(grant)}
                  aria-label={`Revoke access to ${grant.accountName}`}
                >
                  <ShieldOff className="h-4 w-4" aria-hidden />
                </Button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
