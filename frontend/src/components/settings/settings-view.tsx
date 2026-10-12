'use client';

import { RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NotificationPreferences } from '@/components/alerts/notification-preferences';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { DEMO_CREDENTIALS } from '@/lib/auth/constants';
import { readSession } from '@/lib/auth/session';
import { USERS_KEY, TOKENS_KEY } from '@/lib/auth/store';
import type { User } from '@/types/domain';

/** Keys written by the app. Demo accounts and reset tokens are kept so a reset never signs you out of a registered login. */
const KEEP = new Set([USERS_KEY, TOKENS_KEY]);

export function SettingsView() {
  const [user, setUser] = useState<User | null>(null);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => setUser(readSession()), []);

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
      <PageHeader title="Settings" description="Your profile, notification preferences and demo data." />

      <div className="grid gap-3 xl:grid-cols-3">
        <div className="space-y-3 xl:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Profile</CardTitle>
              <CardDescription>The account you are signed in with (simulated session).</CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-4 sm:grid-cols-3">
                <div><dt className="text-xs text-muted-foreground">Name</dt><dd className="mt-0.5 font-medium">{user?.name ?? '…'}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Email</dt><dd className="mt-0.5 break-all font-medium">{user?.email ?? '…'}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Role</dt><dd className="mt-0.5 font-medium">{user?.role ?? '…'}</dd></div>
              </dl>
              <p className="mt-4 rounded-md border border-dashed bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
                Authentication is simulated and stored only in your browser. The built-in demo account is <code className="rounded bg-muted px-1">{DEMO_CREDENTIALS.email}</code>; accounts you register keep a profile only, never a password.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Demo data</CardTitle>
              <CardDescription>Everything you change here is saved in this browser only.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">Reset anomaly workflow and notes, detection settings, account connections, alert read states and preferences, and simulated alerts back to their defaults. Registered demo accounts are kept.</p>
              <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
                <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Reset demo data
              </Button>
            </CardContent>
          </Card>
        </div>

        <NotificationPreferences />
      </div>

      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Reset demo data?"
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
