'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAdmin } from '@/components/admin/admin-context';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { fieldA11y, FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { getFilterOptions } from '@/lib/services/cost-service';
import type { ManagedUser } from '@/types/domain';

/** Sentinel for the select only. It becomes `null` on the way out, because
 *  the grant predicate treats a NULL service_name as "every service". */
const ALL_SERVICES = '__all__';

export function GrantDialog({ user, onClose }: { user: ManagedUser | null; onClose: () => void }) {
  const { grant, grantsFor } = useAdmin();
  const options = useMemo(() => getFilterOptions(), []);

  const [accountId, setAccountId] = useState('');
  const [serviceName, setServiceName] = useState<string>(ALL_SERVICES);
  const [validUntil, setValidUntil] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();

  const userId = user?.id ?? null;
  useEffect(() => {
    setAccountId(options.accounts[0]?.id ?? '');
    setServiceName(ALL_SERVICES);
    setValidUntil('');
    setReason('');
    setError(undefined);
  }, [userId, options.accounts]);

  const existing = user ? grantsFor(user.id) : [];
  const account = options.accounts.find((a) => a.id === accountId);

  // Services actually present in the chosen account, from
  // serviceIdsByAccount rather than filtering by provider. Filtering by
  // provider would offer every AWS service in the estate, letting you
  // grant a service that account does not run -- a grant that silently
  // matches nothing.
  const services = useMemo(() => {
    if (!account) return [];
    const ids = new Set(options.serviceIdsByAccount[account.id] ?? []);
    return options.services.filter((s) => ids.has(s.id));
  }, [options.services, options.serviceIdsByAccount, account]);

  if (!user) {
    return (
      <Dialog open={false} onOpenChange={() => undefined} title="Grant access">
        {null}
      </Dialog>
    );
  }

  function submit(): void {
    // Captured locally: the `if (!user) return` above narrows the render
    // path, but TypeScript cannot carry that into this closure.
    const target = user;
    if (!target) return;
    if (!account) {
      setError('Choose an account.');
      return;
    }
    const duplicate = existing.some(
      (g) =>
        g.accountId === account.id &&
        (g.serviceName ?? ALL_SERVICES) === serviceName,
    );
    if (duplicate) {
      setError('This user already has that exact access.');
      return;
    }
    grant({
      userId: target.id,
      providerId: account.providerId,
      accountId: account.id,
      accountName: account.name,
      serviceName: serviceName === ALL_SERVICES ? null : serviceName,
      validUntil: validUntil ? new Date(`${validUntil}T23:59:59Z`).toISOString() : null,
      reason: reason.trim() || null,
    });
    onClose();
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={`Grant access — ${user.displayName ?? user.email}`}
      description="One account per grant, optionally narrowed to a single service."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit}>Grant access</Button>
        </>
      }
    >
      <div className="space-y-4">
        <FormField id="grant-account" label="Account" error={error}>
          <Select
            id="grant-account"
            value={accountId}
            onChange={(e) => {
              setAccountId(e.target.value);
              setServiceName(ALL_SERVICES);
              setError(undefined);
            }}
            {...fieldA11y('grant-account', error)}
          >
            {options.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </FormField>

        <FormField
          id="grant-service"
          label="Service"
          hint="Leave as all services unless they only need one."
        >
          <Select
            id="grant-service"
            value={serviceName}
            onChange={(e) => setServiceName(e.target.value)}
            {...fieldA11y('grant-service', undefined, true)}
          >
            <option value={ALL_SERVICES}>All services in this account</option>
            {services.map((s) => (
              <option key={s.id} value={s.name}>
                {s.name}
              </option>
            ))}
          </Select>
        </FormField>

        <FormField
          id="grant-until"
          label="Expires"
          hint="Leave empty for indefinite access. An expiring grant stops working silently, so prefer a date for temporary access."
        >
          <Input
            id="grant-until"
            type="date"
            value={validUntil}
            onChange={(e) => setValidUntil(e.target.value)}
            {...fieldA11y('grant-until', undefined, true)}
          />
        </FormField>

        <FormField id="grant-reason" label="Reason" hint="Recorded in the audit log.">
          <Input
            id="grant-reason"
            value={reason}
            placeholder="Why do they need this?"
            onChange={(e) => setReason(e.target.value)}
            {...fieldA11y('grant-reason', undefined, true)}
          />
        </FormField>

        {existing.length > 0 && (
          <div className="rounded-md bg-muted/50 px-3 py-2">
            <p className="text-xs font-medium">Already has access to</p>
            <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
              {existing.map((g) => (
                <li key={g.id}>
                  {g.accountName}
                  {g.serviceName ? ` / ${g.serviceName}` : ' — all services'}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Dialog>
  );
}
