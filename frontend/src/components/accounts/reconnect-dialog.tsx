'use client';

import { Check, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useConnections } from '@/components/connections/connections-context';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { fieldA11y, FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { CONNECTION_FIELDS, sampleConnectionDetails, validateConnectionDetails } from '@/lib/connections';
import { PROVIDER_SHORT_NAME } from '@/lib/theme';
import { cn } from '@/lib/utils';
import type { Account } from '@/types/domain';

const STEPS = ['Validating permissions', 'Importing cost data', 'Finishing setup'] as const;
const STEP_MS = 650;

/**
 * Reconnect a DEMO account. Mock mode only, and a simulation throughout.
 *
 * NOT the same thing as registering a cloud account, which is
 * `connect-dialog.tsx` and writes a real `cloud_connections` row. The
 * two were briefly merged and should not be: this one re-connects an
 * account that already exists in the mock estate, across all three
 * providers, and the mock estate is not shaped like anything the real
 * API accepts -- its AWS ids are dashed (`4821-7730-1159`) and its
 * Azure ids are GUIDs, so feeding them to a registration form that
 * requires twelve digits produces a validation error on a button whose
 * whole job is to look effortless in a demo.
 *
 * Values are format-checked only; nothing is stored or sent anywhere.
 */
export function ReconnectDialog({ account, onClose }: { account: Account | null; onClose: () => void }) {
  const { connect } = useConnections();
  const [details, setDetails] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [step, setStep] = useState<number | null>(null);
  const timers = useRef<number[]>([]);

  const accountId = account?.id ?? null;
  useEffect(() => {
    setDetails({});
    setErrors({});
    setStep(null);
    const pending = timers.current;
    return () => pending.forEach((t) => window.clearTimeout(t));
  }, [accountId]);

  if (!account) return <Dialog open={false} onOpenChange={() => undefined} title="Connect account">{null}</Dialog>;

  const fields = CONNECTION_FIELDS[account.providerId];
  const working = step !== null;

  function submit(): void {
    if (!account) return;
    const found = validateConnectionDetails(account.providerId, details);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setStep(0);
    STEPS.forEach((_, i) => {
      timers.current.push(window.setTimeout(() => setStep(i + 1), (i + 1) * STEP_MS));
    });
    timers.current.push(
      window.setTimeout(() => {
        connect(account.id);
        onClose();
      }, STEPS.length * STEP_MS + 250),
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !working && onClose()}
      title={`Connect ${account.name}`}
      description={`${PROVIDER_SHORT_NAME[account.providerId]} · ${account.externalId}`}
      footer={
        <>
          <Button variant="ghost" size="sm" className="mr-auto" disabled={working} onClick={() => { setDetails(sampleConnectionDetails(account)); setErrors({}); }}>
            Use example values
          </Button>
          <Button variant="outline" size="sm" disabled={working} onClick={onClose}>Cancel</Button>
          <Button size="sm" disabled={working} onClick={submit}>
            {working && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
            {working ? 'Connecting…' : 'Connect account'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="rounded-md border border-dashed bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
          Simulated connection. The values are checked for format only. No credentials are stored or sent, and no cloud API is called.
        </p>

        {working ? (
          <ol className="space-y-2.5" aria-live="polite" aria-label="Connection progress">
            {STEPS.map((label, i) => {
              const done = (step ?? 0) > i;
              const current = step === i;
              return (
                <li key={label} className={cn('flex items-center gap-2.5 text-sm', !done && !current && 'text-muted-foreground/60')}>
                  {done ? <Check className="h-4 w-4 text-success" aria-hidden /> : current ? <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden /> : <span className="h-4 w-4 rounded-full border" aria-hidden />}
                  {label}
                </li>
              );
            })}
          </ol>
        ) : (
          <div className="space-y-4">
            {fields.map((f) => (
              <FormField key={f.key} id={`conn-${f.key}`} label={f.label} error={errors[f.key]} hint={f.help}>
                <Input
                  id={`conn-${f.key}`}
                  value={details[f.key] ?? ''}
                  placeholder={f.placeholder}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setDetails((prev) => ({ ...prev, [f.key]: e.target.value }))}
                  {...fieldA11y(`conn-${f.key}`, errors[f.key], true)}
                />
              </FormField>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}
