import { Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { CONNECTION_CLASS, CONNECTION_LABEL } from '@/lib/theme';
import type { Connectivity } from '@/types/domain';

export function ConnectionBadge({ status, syncing }: { status: Connectivity; syncing?: boolean }) {
  const key = syncing ? 'syncing' : status;
  return (
    <Badge className={CONNECTION_CLASS[key]}>
      {syncing && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
      {CONNECTION_LABEL[key]}
    </Badge>
  );
}
