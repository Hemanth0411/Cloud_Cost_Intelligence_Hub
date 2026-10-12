'use client';

import { Loader2, ShieldAlert, TriangleAlert } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

/**
 * The two states every admin screen now has, in one place.
 *
 * Loading and failure are new: the data used to come from a module, so
 * it was simply there. It arrives over HTTP now, and a 403 is NOT a
 * fault -- /admin/* is superadmin-only and the API refusing a normal
 * user is the access control working. It reads differently from a
 * network failure and is presented differently: an explanation, not an
 * error.
 *
 * Renders nothing once the data is in, so callers can place it
 * unconditionally above their content.
 */
export function AdminState({
  loading,
  error,
  subject,
}: {
  loading: boolean;
  error: { message: string; forbidden: boolean } | null;
  /** What was being read, e.g. "users and grants". */
  subject: string;
}) {
  if (error) {
    const Icon = error.forbidden ? ShieldAlert : TriangleAlert;
    return (
      <Card>
        <CardContent
          role={error.forbidden ? undefined : 'alert'}
          className="flex items-start gap-3 py-5"
        >
          <Icon
            className={error.forbidden ? 'mt-0.5 h-5 w-5 shrink-0 text-muted-foreground' : 'mt-0.5 h-5 w-5 shrink-0 text-destructive'}
            aria-hidden
          />
          <div className="space-y-1">
            <p className="text-sm font-medium">
              {error.forbidden ? 'Not available for this account' : `Could not load ${subject}`}
            </p>
            <p className="text-sm text-muted-foreground">{error.message}</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2.5 py-5 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          <span role="status">Loading {subject}…</span>
        </CardContent>
      </Card>
    );
  }

  return null;
}
