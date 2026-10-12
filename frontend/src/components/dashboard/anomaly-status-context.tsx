'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { z } from 'zod';
import type { StatusOverrides } from '@/types/analytics';
import type { AnomalyStatus } from '@/types/domain';

const STORAGE_KEY = 'cloudlens:anomaly-workflow';
const stateSchema = z.object({
  statuses: z.record(z.enum(['open', 'investigating', 'acknowledged', 'resolved', 'dismissed'])),
  notes: z.record(z.string().max(2000)),
});

type Notes = Readonly<Record<string, string>>;

interface AnomalyWorkflowContextValue {
  overrides: StatusOverrides;
  notes: Notes;
  setStatus: (id: string, status: AnomalyStatus) => void;
  setNote: (id: string, note: string) => void;
}

const Ctx = createContext<AnomalyWorkflowContextValue | null>(null);

/** Holds user-driven anomaly workflow state (status changes and notes), persisted locally. No backend. */
export function AnomalyStatusProvider({ children }: { children: ReactNode }) {
  const [overrides, setOverrides] = useState<StatusOverrides>({});
  const [notes, setNotes] = useState<Notes>({});

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = stateSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        setOverrides(parsed.data.statuses);
        setNotes(parsed.data.notes);
      }
    } catch {
      /* storage unavailable or corrupt: start clean */
    }
  }, []);

  const persist = useCallback((statuses: StatusOverrides, nextNotes: Notes) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ statuses, notes: nextNotes }));
    } catch {
      /* ignore */
    }
  }, []);

  const setStatus = useCallback(
    (id: string, status: AnomalyStatus) => {
      setOverrides((prev) => {
        const next: StatusOverrides = { ...prev, [id]: status };
        persist(next, notes);
        return next;
      });
    },
    [notes, persist],
  );

  const setNote = useCallback(
    (id: string, note: string) => {
      setNotes((prev) => {
        const next: Notes = { ...prev, [id]: note };
        persist(overrides, next);
        return next;
      });
    },
    [overrides, persist],
  );

  const value = useMemo(() => ({ overrides, notes, setStatus, setNote }), [overrides, notes, setStatus, setNote]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAnomalyStatus(): AnomalyWorkflowContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAnomalyStatus must be used within <AnomalyStatusProvider>');
  return ctx;
}
