'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { useToast } from '@/components/ui/toast';
import { COST_CAPABILITIES, setAnomalyStatus as persistStatus } from '@/lib/services/cost-service';
import type { StatusOverrides } from '@/types/analytics';
import type { AnomalyStatus } from '@/types/domain';

const STORAGE_KEY = 'costhub:anomaly-workflow';
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
  /**
   * Does a status change survive a reload?
   *
   * False in mock mode, where it lives in localStorage. The screens
   * use it to decide whether to offer the two states the API cannot
   * store, and the notes field to say where notes are kept.
   */
  persists: boolean;
}

const Ctx = createContext<AnomalyWorkflowContextValue | null>(null);

const EMPTY_SAVED: { statuses: StatusOverrides; notes: Notes } = { statuses: {}, notes: {} };

function readSavedState(): { statuses: StatusOverrides; notes: Notes } {
  if (typeof window === 'undefined') return EMPTY_SAVED;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_SAVED;
    const parsed = stateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? { statuses: parsed.data.statuses, notes: parsed.data.notes } : EMPTY_SAVED;
  } catch {
    return EMPTY_SAVED; // storage unavailable or corrupt: start clean
  }
}

/**
 * Anomaly workflow state.
 *
 * MOCK MODE: entirely local. There is nothing to write to.
 *
 * LIVE MODE: the status is written to `POST /anomalies/{id}/ack` AND
 * kept locally. The local copy is not redundant -- the list is not
 * refetched after a write, so without it the row would snap back to
 * its old badge until the next load. On a failed write the override
 * is rolled back, so the UI never shows a state the server refused.
 *
 * NOTES ARE ALWAYS LOCAL. No column stores them.
 */
export function AnomalyStatusProvider({ children }: { children: ReactNode }) {
  // READ SYNCHRONOUSLY, not in an effect.
  //
  // Hydrating in an effect changed `overrides` one tick after mount,
  // which changed the cache key of every `useAsyncData` on the page
  // and fired a second full round of requests -- five on the
  // dashboard -- before the first had landed. A lazy initializer is
  // safe here precisely because this provider lives inside
  // <AppDataGate>, which renders nothing at all until its own effect
  // has run: the subtree never exists during the server render, so
  // there is no server HTML for it to disagree with.
  const [saved] = useState(readSavedState);
  const [overrides, setOverrides] = useState<StatusOverrides>(saved.statuses);
  const [notes, setNotes] = useState<Notes>(saved.notes);
  const { toast } = useToast();

  /**
   * STATUSES ARE PERSISTED IN MOCK MODE ONLY.
   *
   * Live mode writes them to the server, so the browser copy exists
   * purely to keep the row from snapping back before the next load.
   * Persisting it made the local answer win FOREVER: a finding
   * acknowledged on another device, or re-opened by a detector
   * re-run, kept showing this browser's stale badge, and the map grew
   * without bound because nothing ever pruned it. Notes have no
   * column anywhere, so they are saved in both modes.
   */
  const persist = useCallback((statuses: StatusOverrides, nextNotes: Notes) => {
    try {
      const saved = COST_CAPABILITIES.detectionSettings ? statuses : {};
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ statuses: saved, notes: nextNotes }));
    } catch {
      /* ignore */
    }
  }, []);

  const setStatus = useCallback(
    (id: string, status: AnomalyStatus) => {
      let previous: AnomalyStatus | undefined;
      setOverrides((prev) => {
        previous = prev[id];
        const next: StatusOverrides = { ...prev, [id]: status };
        persist(next, notes);
        return next;
      });

      if (COST_CAPABILITIES.detectionSettings) return; // mock: nothing to write

      void persistStatus(id, status).catch((cause: unknown) => {
        setOverrides((prev) => {
          const next = { ...prev };
          if (previous === undefined) delete next[id];
          else next[id] = previous;
          persist(next, notes);
          return next;
        });
        toast({
          tone: 'warning',
          title: 'Could not save that change',
          description: cause instanceof Error ? cause.message : 'The API rejected the update.',
        });
      });
    },
    [notes, persist, toast],
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

  const value = useMemo(
    () => ({ overrides, notes, setStatus, setNote, persists: !COST_CAPABILITIES.detectionSettings }),
    [overrides, notes, setStatus, setNote],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAnomalyStatus(): AnomalyWorkflowContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAnomalyStatus must be used within <AnomalyStatusProvider>');
  return ctx;
}
