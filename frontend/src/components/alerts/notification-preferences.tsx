'use client';

import { Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { SEVERITIES } from '@/lib/alerts/preferences';
import { SEVERITY_LABEL } from '@/lib/theme';
import type { NotificationPreferences as Prefs, Severity } from '@/types/domain';
import { useAlerts } from './alerts-context';

function Row({ id, label, help, checked, onChange, disabled }: { id: string; label: string; help?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <label htmlFor={id} className="min-w-0 cursor-pointer">
        <span className="block text-sm font-medium">{label}</span>
        {help && <span className="block text-xs text-muted-foreground">{help}</span>}
      </label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

export function NotificationPreferences() {
  const { prefs, setPrefs, sendTest, hiddenCount } = useAlerts();
  const patch = (update: Partial<Prefs>): void => setPrefs({ ...prefs, ...update });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Notification preferences</CardTitle>
        <CardDescription>Saved in this browser. Delivery is simulated: nothing is emailed or posted.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <section aria-labelledby="pref-channels">
          <h3 id="pref-channels" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Channels</h3>
          <div className="divide-y">
            <Row id="pref-inapp" label="In-app" help="Always on" checked disabled onChange={() => undefined} />
            <Row id="pref-email" label="Email (simulated)" help="Shown as delivered, never sent" checked={prefs.channels.email} onChange={(v) => patch({ channels: { ...prefs.channels, email: v } })} />
            <Row id="pref-slack" label="Slack (simulated)" help="Shown as delivered, never sent" checked={prefs.channels.slack} onChange={(v) => patch({ channels: { ...prefs.channels, slack: v } })} />
          </div>
        </section>

        <section aria-labelledby="pref-categories">
          <h3 id="pref-categories" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Notify me about</h3>
          <div className="divide-y">
            <Row id="pref-anomaly" label="Cost anomalies" checked={prefs.categories.anomaly} onChange={(v) => patch({ categories: { ...prefs.categories, anomaly: v } })} />
            <Row id="pref-budget" label="Budget risk" checked={prefs.categories.budget} onChange={(v) => patch({ categories: { ...prefs.categories, budget: v } })} />
            <Row id="pref-connection" label="Account connection issues" checked={prefs.categories.connection} onChange={(v) => patch({ categories: { ...prefs.categories, connection: v } })} />
          </div>
        </section>

        <div>
          <label htmlFor="pref-severity" className="text-sm font-medium">Minimum severity</label>
          <p className="mb-2 text-xs text-muted-foreground">Quieter alerts are hidden and not counted as unread.</p>
          <Select id="pref-severity" value={prefs.minSeverity} onChange={(e) => patch({ minSeverity: e.target.value as Severity })}>
            {SEVERITIES.map((s) => <option key={s} value={s}>{SEVERITY_LABEL[s]} and above</option>)}
          </Select>
          {hiddenCount > 0 && <p className="mt-2 text-xs text-muted-foreground" role="status">{hiddenCount} alert{hiddenCount === 1 ? ' is' : 's are'} hidden by these preferences.</p>}
        </div>

        <Button variant="outline" size="sm" className="w-full" onClick={sendTest}>
          <Send className="h-3.5 w-3.5" aria-hidden /> Send test notification (simulated)
        </Button>
      </CardContent>
    </Card>
  );
}
