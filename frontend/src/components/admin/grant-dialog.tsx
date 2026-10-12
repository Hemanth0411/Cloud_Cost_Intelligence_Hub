'use client';

import { useEffect, useState } from 'react';
import { useAdmin } from '@/components/admin/admin-context';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { fieldA11y, FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { readServices } from '@/lib/services/admin-service';
import type { ManagedUser } from '@/types/domain';

/** Sentinel for the select only. It becomes `null` on the way out, because
 *  the grant predicate treats a NULL service_name as "every service". */
const ALL_SERVICES = '__all__';

/** Today as yyyy-MM-dd, the floor for an expiry date. */
const todayIso = (): string => new Date().toISOString().slice(0, 10);

export function GrantDialog({ user, onClose }: { user: ManagedUser | null; onClose: () => void }) {
  const { grant, grantsFor, accounts } = useAdmin();

  const [accountKey, setAccountKey] = useState('');
  const [serviceName, setServiceName] = useState<string>(ALL_SERVICES);
  const [validUntil, setValidUntil] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const [services, setServices] = useState<string[]>([]);
  const [servicesError, setServicesError] = useState<string>();

  // (provider, accountId) is the key: an account id is only unique
  // within a provider, and the grant needs both.
  const keyOf = (providerId: string, accountId: string): string => `${providerId}|${accountId}`;
  const account = accounts.find((a) => keyOf(a.providerId, a.accountId) === accountKey);

  const userId = user?.id ?? null;
  useEffect(() => {
    const first = accounts[0];
    setAccountKey(first ? keyOf(first.providerId, first.accountId) : '');
    setServiceName(ALL_SERVICES);
    setValidUntil('');
    setReason('');
    setError(undefined);
  }, [userId, accounts]);

  /**
   * Services come from the API per account, not from a catalogue.
   *
   * Scoped to the account rather than the provider on purpose: offering
   * every service in the estate lets you grant one the account does not
   * run, which is a grant that silently matches nothing. An empty list
   * is a legitimate answer (an account with no spend yet), so it is not
   * treated as a failure -- `servicesError` is only set when the request
   * itself failed, and the dialog still works, because "all services"
   * needs no list.
   */
  useEffect(() => {
    if (!account) {
      setServices([]);
      return;
    }
    let cancelled = false;
    setServicesError(undefined);
    readServices(account.providerId, account.accountId)
      .then((names) => {
        if (!cancelled) setServices(names);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setServices([]);
        setServicesError(
          cause instanceof Error ? cause.message : 'Could not list the services in this account.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [account]);

  const existing = user ? grantsFor(user.id) : [];

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
      (g) => g.accountId === account.accountId && (g.serviceName ?? ALL_SERVICES) === serviceName,
    );
    if (duplicate) {
      setError('This user already has that exact access.');
      return;
    }
    grant({
      userId: target.id,
      // The API keys a grant by email, not by id.
      userEmail: target.email,
      providerId: account.providerId,
      accountId: account.accountId,
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
          <Button onClick={submit} disabled={accounts.length === 0}>
            Grant access
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {accounts.length === 0 ? (
          <p className="rounded-md bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
            There are no accounts to grant yet. Register a cloud account first — a grant has to name
            one that exists.
          </p>
        ) : (
          <FormField id="grant-account" label="Account" error={error}>
            <Select
              id="grant-account"
              value={accountKey}
              onChange={(e) => {
                setAccountKey(e.target.value);
                setServiceName(ALL_SERVICES);
                setError(undefined);
              }}
              {...fieldA11y('grant-account', error)}
            >
              {accounts.map((a) => (
                <option key={keyOf(a.providerId, a.accountId)} value={keyOf(a.providerId, a.accountId)}>
                  {a.name}
                </option>
              ))}
            </Select>
          </FormField>
        )}

        <FormField
          id="grant-service"
          label="Service"
          hint={
            servicesError ??
            'Leave as all services unless they only need one.'
          }
        >
          <Select
            id="grant-service"
            value={serviceName}
            onChange={(e) => setServiceName(e.target.value)}
            {...fieldA11y('grant-service', undefined, true)}
          >
            <option value={ALL_SERVICES}>All services in this account</option>
            {services.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
        </FormField>

        <FormField
          id="grant-until"
          label="Expires"
          hint="Leave empty for indefinite access. An expiring grant stops working silently, so prefer a date for temporary access."
        >
          {/* `min` is not cosmetic. access_grants carries
              CHECK (valid_until IS NULL OR valid_until > valid_from),
              valid_from defaults to now(), and POST /admin/grants
              catches only InvalidEmail -- so a past date reaches
              Postgres, violates the constraint and comes back as an
              unhandled 500. */}
          <Input
            id="grant-until"
            type="date"
            min={todayIso()}
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
