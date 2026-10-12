'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useToast } from '@/components/ui/toast';
import { demoNow } from '@/lib/clock';
import { parseConnectionOverrides, summarizeConnections, type ConnectionSummary } from '@/lib/connections';
import { getBaseConnection, getFilterOptions } from '@/lib/services/cost-service';
import type { AccountConnection, Connectivity, ProviderId } from '@/types/domain';

const STORAGE_KEY = 'cloudlens:connections';
const SYNC_DURATION_MS = 1800;

const nowIso = (): string => `${demoNow().toISOString().slice(0, 19)}Z`;

export interface ConnectionView extends AccountConnection {
  syncing: boolean;
}

interface ConnectionsContextValue {
  connectionOf: (accountId: string) => ConnectionView;
  statusOf: (accountId: string) => Connectivity;
  summarize: (accounts: ReadonlyArray<{ id: string; providerId: ProviderId }>) => ConnectionSummary;
  sync: (accountId: string) => void;
  syncAll: (accountIds: readonly string[]) => void;
  disconnect: (accountId: string) => void;
  connect: (accountId: string) => void;
}

const Ctx = createContext<ConnectionsContextValue | null>(null);

/** Simulated cloud connections: connect, disconnect and sync change state locally. Nothing talks to a cloud API. */
export function ConnectionsProvider({ children }: { children: ReactNode }) {
  const { toast } = useToast();
  const [overrides, setOverrides] = useState<Record<string, AccountConnection>>({});
  const [syncing, setSyncing] = useState<ReadonlySet<string>>(new Set());
  const timers = useRef<number[]>([]);
  const names = useMemo(() => new Map(getFilterOptions().accounts.map((a) => [a.id, a.name])), []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? parseConnectionOverrides(JSON.parse(raw)) : null;
      if (parsed) setOverrides(parsed);
    } catch {
      /* ignore corrupt storage */
    }
    const pending = timers.current;
    return () => pending.forEach((t) => window.clearTimeout(t));
  }, []);

  const persist = useCallback((next: Record<string, AccountConnection>) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }, []);

  const base = useCallback((id: string): AccountConnection => overrides[id] ?? getBaseConnection(id), [overrides]);

  const connectionOf = useCallback((id: string): ConnectionView => ({ ...base(id), syncing: syncing.has(id) }), [base, syncing]);
  const statusOf = useCallback((id: string): Connectivity => base(id).status, [base]);

  const summarize = useCallback(
    (accounts: ReadonlyArray<{ id: string; providerId: ProviderId }>) => summarizeConnections(accounts, statusOf),
    [statusOf],
  );

  const write = useCallback(
    (id: string, next: AccountConnection) => {
      setOverrides((prev) => {
        const merged = { ...prev, [id]: next };
        persist(merged);
        return merged;
      });
    },
    [persist],
  );

  const sync = useCallback(
    (id: string) => {
      const current = overrides[id] ?? getBaseConnection(id);
      if (syncing.has(id) || current.status === 'disconnected') return;
      setSyncing((prev) => new Set(prev).add(id));
      timers.current.push(
        window.setTimeout(() => {
          write(id, { status: 'connected', lastSyncedAt: nowIso(), changedAt: current.changedAt });
          setSyncing((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
          toast({ tone: 'success', title: `${names.get(id) ?? 'Account'} synced`, description: 'Simulated sync complete. No cloud API was called.' });
        }, SYNC_DURATION_MS),
      );
    },
    [overrides, syncing, write, toast, names],
  );

  const syncAll = useCallback(
    (ids: readonly string[]) => {
      const eligible = ids.filter((id) => statusOf(id) !== 'disconnected');
      eligible.forEach((id, i) => timers.current.push(window.setTimeout(() => sync(id), i * 220)));
      if (eligible.length > 0) toast({ tone: 'info', title: `Syncing ${eligible.length} account${eligible.length === 1 ? '' : 's'}`, description: 'This is a simulated sync.' });
    },
    [statusOf, sync, toast],
  );

  const disconnect = useCallback(
    (id: string) => {
      const current = overrides[id] ?? getBaseConnection(id);
      write(id, { status: 'disconnected', lastSyncedAt: current.lastSyncedAt, changedAt: nowIso() });
      toast({ tone: 'warning', title: `${names.get(id) ?? 'Account'} disconnected`, description: 'Syncing stopped. Historical data stays visible in this demo.' });
    },
    [overrides, write, toast, names],
  );

  const connect = useCallback(
    (id: string) => {
      const stamp = nowIso();
      write(id, { status: 'connected', lastSyncedAt: stamp, changedAt: stamp });
      toast({ tone: 'success', title: `${names.get(id) ?? 'Account'} connected`, description: 'Simulated connection. No credentials were stored or sent.' });
    },
    [write, toast, names],
  );

  const value = useMemo<ConnectionsContextValue>(
    () => ({ connectionOf, statusOf, summarize, sync, syncAll, disconnect, connect }),
    [connectionOf, statusOf, summarize, sync, syncAll, disconnect, connect],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useConnections(): ConnectionsContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useConnections must be used within <ConnectionsProvider>');
  return ctx;
}
