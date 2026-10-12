'use client';

import { RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { NotificationPreferences } from '@/components/alerts/notification-preferences';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { DEMO_CREDENTIALS } from '@/lib/auth/constants';
import { useMode } from '@/hooks/use-mode';
import { useSession } from '@/hooks/use-session';
import { MOCK_OVERRIDE_KEY } from '@/lib/mode';
import { USERS_KEY, TOKENS_KEY } from '@/lib/auth/store';
import { DataSourceCard } from './data-source-card';

/**
 * Keys a reset must NOT remove.
 *
 * Demo accounts and reset tokens, so a reset never signs you out of a
 * registered login -- and the data-source override, because clearing
 * it would silently flip the app back to the build default. Someone
 * resetting their demo state is not asking to change which API they
 * are pointed at.
 */
const KEEP = new Set([USERS_KEY, TOKENS_KEY, MOCK_OVERRIDE_KEY]);

export function SettingsView() {
  const { user } = useSession();
  const { mock, resolved } = useMode();
  const [confirming, setConfirming] = useState(false);

  function resetDemoData(): void {
    try {
      const keys: string[] = [];
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const key = window.localStorage.key(i);
        if (key?.startsWith('cloudlens:') && !KEEP.has(key)) keys.push(key);
      }
      keys.forEach((k) => window.localStorage.removeItem(k));
    } catch {
      /* storage unavailable: nothing to reset */
    }
    window.location.reload();
  }

  return (
    <>
      <PageHeader title="Settings" description="Your profile, your data source and the state this browser keeps." />

      <div className="grid gap-3 xl:grid-cols-3">
        <div className="space-y-3 xl:col-span-2">
          <DataSourceCard />

          <Card>
            <CardHeader>
              <CardTitle>Profile</CardTitle>
              <CardDescription>
                {!resolved ? '\u00a0' : mock ? 'The account you are signed in with (simulated session).' : 'The account you are signed in with, as the API sees you.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-4 sm:grid-cols-3">
                <div><dt className="text-xs text-muted-foreground">Name</dt><dd className="mt-0.5 font-medium">{user?.name ?? '…'}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Email</dt><dd className="mt-0.5 break-all font-medium">{user?.email ?? '…'}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Role</dt><dd className="mt-0.5 font-medium">{user?.role ?? '…'}</dd></div>
              </dl>
              {/* WAS unconditional: "Authentication is simulated and
                  stored only in your browser." Live mode signs in
                  through Cognito Managed Login and holds a real OIDC
                  token, so that was simply false. */}
              <p className="mt-4 rounded-md border border-dashed bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
                {!resolved ? (
                  '\u00a0'
                ) : mock ? (
                  <>
                    Authentication is simulated and stored only in your browser. The built-in demo account is{' '}
                    <code className="rounded bg-muted px-1">{DEMO_CREDENTIALS.email}</code>; accounts you register keep a
                    profile only, never a password.
                  </>
                ) : (
                  <>
                    You are signed in through Amazon Cognito. The ID token is held in this tab only and is sent as a
                    bearer token on every API request; your role and the accounts you can see are decided by the server,
                    not by this page.
                  </>
                )}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Browser state</CardTitle>
              <CardDescription>Preferences and notes this browser keeps. Nothing here is on the server.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Reset investigation notes, detection settings, simulated connections, alert read states and
                preferences, and simulated alerts back to their defaults. Registered demo accounts and your data-source
                choice are kept.
              </p>
              <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
                <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Reset browser state
              </Button>
            </CardContent>
          </Card>
        </div>

        {resolved && mock && <NotificationPreferences />}
      </div>

      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Reset browser state?"
        description="The page will reload with default settings."
        footer={
          <>
            <Button variant="outline" size="sm" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button size="sm" onClick={resetDemoData}>Reset</Button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">Your workflow changes, notes, connection changes and notification settings will be cleared.</p>
      </Dialog>
    </>
  );
}
