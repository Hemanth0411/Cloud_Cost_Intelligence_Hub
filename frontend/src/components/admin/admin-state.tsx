'use client';

import { Loader2, RotateCcw, ShieldAlert, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
  onRetry,
}: {
  loading: boolean;
  error: { message: string; forbidden: boolean } | null;
  /** What was being read, e.g. "users and grants". */
  subject: string;
  /** Re-runs the read. Offered for a failure, never for a 403. */
  onRetry?: () => void;
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
            {/* No retry on a 403. The answer will not change, and a
                button that re-asks a settled question reads as a fault
                the user can fix. A transport failure is the opposite:
                retrying is exactly the right move, and without this the
                card was a dead end. */}
            {!error.forbidden && onRetry && (
              <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}>
                <RotateCcw className="mr-2 h-3.5 w-3.5" aria-hidden />
                Try again
              </Button>
            )}
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
