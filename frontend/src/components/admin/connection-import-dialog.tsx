'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { Dialog } from '@/components/ui/dialog';
import { SegmentedControl } from '@/components/ui/segmented-control';
import {
  BACKFILL_MONTHS,
  CE_USD_PER_CALL,
  IMPORT_DAY_OPTIONS,
  MAX_IMPORT_DAYS,
  backfillCommand,
  formatUsd,
  importWindow,
  type ImportDays,
} from '@/lib/import-window';
import type { ConnectionRow } from '@/lib/services/connection-service';

/**
 * Choose how far back "Import now" reaches.
 *
 * WHY THIS EXISTS. The button used to call the route with no `days`, so
 * every manual import fetched the server default of 7. A newly connected
 * account then showed the SAME total for last-30-days, month-to-date and
 * year-to-date -- all three windows held the only week that existed --
 * and that became a support question.
 *
 * THE CAP IS THE ROUTE'S, AND IT STAYS. `days <= 31` keeps one request
 * to at most three Cost Explorer calls inside API Gateway's 29-second
 * limit. So the longest choice here is 31 days, and anything older is
 * the CLI's job; the command is on screen, copyable, at exactly the
 * point someone goes looking for "14 months".
 *
 * COST IS SHOWN BECAUSE IT IS REAL. Cost Explorer bills each request,
 * and the number of requests is the number of calendar months touched,
 * so the choice is informed rather than free-looking. Only for AWS: the
 * Cost Explorer price says nothing about any other provider's API.
 *
 * AND IT SAYS THAT RE-IMPORTING IS SAFE, because "import 31 days" over
 * days already imported looks like it might duplicate or overwrite.
 * It does neither: `fact_cost_daily` upserts on its natural key.
 */

interface Props {
  connection: ConnectionRow;
  onClose: () => void;
  onImport: (days: ImportDays) => void;
}

const OPTIONS = IMPORT_DAY_OPTIONS.map((days) => ({
  value: String(days) as `${ImportDays}`,
  label: `${days} days`,
}));

export function ConnectionImportDialog({ connection, onClose, onImport }: Props) {
  const [days, setDays] = useState<ImportDays>(7);
  // Read once, in the browser, when the dialog opens -- it is mounted
  // only on click, so this never runs during the server render.
  const [now] = useState(() => new Date());
  const range = importWindow(days, now);
  const isAws = connection.provider === 'aws';
  const command = backfillCommand(connection.accountId);

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={`Import from ${connection.displayName}`}
      description="Fetch this account's daily cost now, rather than waiting for 06:00 UTC."
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => onImport(days)}>
            Import {days} days
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-xs">
        <div className="space-y-1.5">
          <p className="font-medium">How far back</p>
          <SegmentedControl
            ariaLabel="Import window"
            options={OPTIONS}
            value={String(days) as `${ImportDays}`}
            onChange={(v) => setDays(Number(v) as ImportDays)}
          />
          <p className="text-muted-foreground">
            <span className="font-mono">{range.start}</span> to{' '}
            <span className="font-mono">{range.end}</span> (UTC) &mdash; {range.dates} days,
            today included, because recent cost is restated as the provider finalises it.
          </p>
          {isAws && (
            <p className="text-muted-foreground">
              At least{' '}
              <strong className="font-medium text-foreground">
                {range.calls} Cost Explorer call{range.calls === 1 ? '' : 's'} (
                {formatUsd(range.calls * CE_USD_PER_CALL)})
              </strong>
              : AWS charges {formatUsd(CE_USD_PER_CALL)} per request, and an import makes one per
              calendar month the window touches, so a longer window costs more.
            </p>
          )}
        </div>

        <div className="space-y-1.5 rounded-md border bg-muted/30 px-3 py-2.5">
          <p className="font-medium">Safe to repeat</p>
          <p className="text-muted-foreground">
            Days already imported are updated in place, not duplicated or removed. Each cost row is
            keyed by provider, account, service, region, charge category, date and currency, so importing
            the same day twice leaves one row holding the latest figure.
          </p>
        </div>

        <div className="space-y-1.5 rounded-md border bg-muted/30 px-3 py-2.5">
          <p className="font-medium">Need more than {MAX_IMPORT_DAYS} days?</p>
          <p className="text-muted-foreground">
            This button is capped at {MAX_IMPORT_DAYS}: it runs inside a web request that is cut
            off after 29 seconds. A longer history is a backfill, run from a machine with deploy
            access and the <code className="font-mono">costhub</code> AWS profile:
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 select-all break-all rounded bg-background px-2 py-1.5 font-mono text-[11px]">
              {command}
            </code>
            <CopyButton value={command} />
          </div>
          {isAws && (
            <p className="text-muted-foreground">
              {BACKFILL_MONTHS} months is about {BACKFILL_MONTHS} Cost Explorer calls (
              {formatUsd(BACKFILL_MONTHS * CE_USD_PER_CALL)}) for this account, and re-running it is
              as safe as re-importing.
            </p>
          )}
        </div>
      </div>
    </Dialog>
  );
}
