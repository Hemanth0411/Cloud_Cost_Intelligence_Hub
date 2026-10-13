'use client';

import { CheckCircle2, Info, TriangleAlert, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type ToastTone = 'success' | 'info' | 'warning';

interface ToastItem {
  id: number;
  title: string;
  description?: string;
  tone: ToastTone;
}

interface ToastContextValue {
  toast: (t: { title: string; description?: string; tone?: ToastTone }) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);
const AUTO_DISMISS_MS = 5500;

const ICON = { success: CheckCircle2, info: Info, warning: TriangleAlert } as const;
const TONE_CLASS: Record<ToastTone, string> = { success: 'text-success', info: 'text-ateneo', warning: 'text-warning' };

/** Minimal toast system (no dependency): stacked, auto-dismissing, announced to screen readers. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef<Map<number, number>>(new Map());

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const toast = useCallback(
    ({ title, description, tone = 'info' }: { title: string; description?: string; tone?: ToastTone }) => {
      const id = nextId.current;
      nextId.current += 1;
      setItems((prev) => [...prev.slice(-3), { id, title, description, tone }]);
      timers.current.set(id, window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS));
    },
    [dismiss],
  );

  useEffect(() => {
    const active = timers.current;
    return () => active.forEach((t) => window.clearTimeout(t));
  }, []);

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2" role="region" aria-label="Notifications" aria-live="polite">
        {items.map((t) => {
          const Icon = ICON[t.tone];
          return (
            <div key={t.id} role="status" className="pointer-events-auto flex animate-fade-in items-start gap-3 rounded-lg border bg-card p-3.5 shadow-lg">
              <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', TONE_CLASS[t.tone])} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium leading-snug">{t.title}</p>
                {t.description && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{t.description}</p>}
              </div>
              <button type="button" onClick={() => dismiss(t.id)} aria-label="Dismiss notification" className="rounded p-1 text-muted-foreground hover:bg-muted">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>');
  return ctx;
}
