'use client';

import { Loader2, Play } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { useSession } from '@/hooks/use-session';
import { runDetection } from '@/lib/api/cost-api';

/**
 * "Run detection now" -- `POST /anomalies/scan`.
 *
 * Detection otherwise runs once a night (06:30 UTC), so after an import
 * the only ways to see new findings were to wait or to invoke the Lambda
 * by hand. This runs the same server-side pass inline and then asks the
 * page to refetch.
 *
 * Superadmin only, on the server; hiding it for everyone else here is a
 * convenience, not the control. Live mode only: in mock mode detection
 * already runs in the browser on every load, so the button would do
 * nothing.
 */
export function RunDetectionButton({ onDone }: { onDone: () => void }) {
  const { isSuperadmin } = useSession();
  const { toast } = useToast();
  const [running, setRunning] = useState(false);

  if (!isSuperadmin) return null;

  function run(): void {
    setRunning(true);
    runDetection()
      .then((r) => {
        toast({
          tone: 'success',
          title: r.findings === 0 ? 'Detection ran: nothing unusual' : `Detection ran: ${r.findings} finding(s)`,
          description:
            `Scanned ${r.seriesScanned} account × service series. ` +
            (r.findings === 0 ? 'No findings in the detection window.' : `${r.created} new, ${r.updated} already on file and refreshed.`),
        });
      })
      .catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        toast({ tone: 'warning', title: 'Could not run detection', description: message });
      })
      .finally(() => {
        setRunning(false);
        onDone();
      });
  }

  return (
    <Button variant="outline" size="sm" onClick={run} disabled={running} aria-busy={running}>
      {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}
      {running ? 'Running detection…' : 'Run detection now'}
    </Button>
  );
}
