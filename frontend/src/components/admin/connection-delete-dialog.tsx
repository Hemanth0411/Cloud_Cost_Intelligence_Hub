'use client';

import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { FailureNotice } from '@/components/accounts/connection-form';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { ApiError } from '@/lib/api/client';
import {
  deleteConnection,
  isMissingConnection,
  type ConnectionRow,
} from '@/lib/services/connection-service';

/**
 * Confirm removing a connection, and correct what "remove" implies.
 *
 * THE WORD IS MISLEADING AND THE DIALOG HAS TO SAY SO. `DELETE
 * /admin/connections/{id}` answers `cost_data_kept: true`, and that is
 * not a courtesy flag -- `fact_cost_daily` is keyed by
 * (provider, account_id) and not by connection, so every imported row
 * survives, every chart is unchanged, and the grants that reference the
 * account id still resolve. What stops is importing. Someone who reads
 * "Delete" as "delete the data" will either not press it when they
 * should, or press it believing they have just complied with a deletion
 * request they have not.
 *
 * AND IT IS REVERSIBLE, which is the other thing nobody would guess.
 * The row is soft-deleted (`deleted_at` stamped, `enabled` turned off)
 * and `store.upsert` is `ON CONFLICT (provider, account_id) DO UPDATE`
 * with `deleted_at = NULL, enabled = true` -- so registering the same
 * provider and account id again revives this very row rather than
 * creating a second one, and picks the history back up.
 *
 * THE ACCOUNT LEAVES THE PICKERS, and the dialog says so. The delete
 * marks `dim_account.is_active = false` (never deletes it -- cost rows
 * must stay joinable), which drops it from `/meta/accounts` and so from
 * the account list and every filter; registering again re-activates it
 * (`connections/account_dim.py`). Before that, a deleted account stayed
 * in every dropdown with nothing behind it. The caveat is
 * worth stating too: registering it again is an UPSERT, so it rewrites
 * the credential columns and issues a new ExternalId.
 *
 * WHY A DIALOG AND NOT A `confirm()`: the browser's confirm is a modal
 * dialog that blocks the event loop and cannot carry three sentences of
 * consequence, and this project's own guidance is not to trigger one.
 */

interface Props {
  connection: ConnectionRow;
  onClose: () => void;
  onDeleted: (costDataKept: boolean) => void;
  /** 404 -- already gone. The list on screen is stale. */
  onVanished: () => void;
}

export function ConnectionDeleteDialog({ connection, onClose, onDeleted, onVanished }: Props) {
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  function remove(): void {
    setWorking(true);
    setFailure(null);
    deleteConnection(connection.id)
      .then((outcome) => onDeleted(outcome.costDataKept))
      .catch((cause: unknown) => {
        setWorking(false);
        if (isMissingConnection(cause)) {
          onVanished();
          return;
        }
        const error = cause instanceof Error ? cause : new Error(String(cause));
        setFailure(
          error instanceof ApiError && error.forbidden
            ? 'Removing a cloud account is restricted to superadmins, and this account is not one. Nothing was removed.'
            : error.message || 'The connection could not be removed.',
        );
      });
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && !working && onClose()}
      title={`Stop importing from ${connection.displayName}?`}
      description="This removes the connection, not the cost data."
      footer={
        <>
          <Button variant="outline" size="sm" disabled={working} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" disabled={working} onClick={remove}>
            {working && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
            {working ? 'Removing…' : 'Remove connection'}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-xs">
        <p>
          <code className="font-mono">
            {connection.provider}/{connection.accountId}
          </code>{' '}
          will stop being imported. Scheduled runs skip it from the next one onwards, and its
          credentials &mdash;{' '}
          {connection.credentialMode === 'assume_role'
            ? 'the role ARN and ExternalId'
            : 'whatever it holds'}{' '}
          &mdash; stop being used.
        </p>

        <div className="space-y-1.5 rounded-md border bg-muted/30 px-3 py-2.5">
          <p className="font-medium">What is kept</p>
          <p className="text-muted-foreground">
            Every cost row already imported from this account.{' '}
            <code className="font-mono">fact_cost_daily</code> is keyed by provider and account id
            rather than by connection, so its spend stays in the totals. Nothing on this screen
            deletes spend history, and there is no control here that does.
          </p>
        </div>

        <div className="space-y-1.5 rounded-md border bg-muted/30 px-3 py-2.5">
          <p className="font-medium">What is hidden</p>
          <p className="text-muted-foreground">
            The account itself, from the account list and every account filter. An account nobody
            imports from any more would otherwise sit in those dropdowns with nothing new behind
            it. It is marked inactive, not deleted, so its history still reads under its name.
          </p>
        </div>

        <div className="space-y-1.5 rounded-md border bg-muted/30 px-3 py-2.5">
          <p className="font-medium">It can be undone</p>
          <p className="text-muted-foreground">
            Registering <code className="font-mono">{connection.accountId}</code> again revives this
            same row, puts the account back in the lists straight away, and resumes importing
            against the history that is still there. That path is an
            upsert, though, so it rewrites the credential fields and issues a new ExternalId &mdash;
            which the target account&rsquo;s trust policy then has to be updated with. If the ARN or
            the ExternalId is all that is wrong, Edit fixes it without any of that.
          </p>
        </div>

        {failure !== null && <FailureNotice message={failure} />}
      </div>
    </Dialog>
  );
}
