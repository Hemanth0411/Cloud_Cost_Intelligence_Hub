'use client';

import { Unplug } from 'lucide-react';
import { useConnections } from '@/components/connections/connections-context';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import type { Account } from '@/types/domain';

export function DisconnectDialog({ account, onClose }: { account: Account | null; onClose: () => void }) {
  const { disconnect } = useConnections();
  return (
    <Dialog
      open={account !== null}
      onOpenChange={(open) => !open && onClose()}
      title={account ? `Disconnect ${account.name}?` : 'Disconnect account'}
      description="You can reconnect it at any time."
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              if (account) disconnect(account.id);
              onClose();
            }}
          >
            <Unplug className="h-3.5 w-3.5" aria-hidden /> Disconnect
          </Button>
        </>
      }
    >
      <ul className="space-y-2 text-sm text-muted-foreground">
        <li>New cost data will stop syncing for this account.</li>
        <li>Historical cost data stays visible in this demo.</li>
        <li>A high-severity alert is raised so the owner can follow up.</li>
      </ul>
    </Dialog>
  );
}
