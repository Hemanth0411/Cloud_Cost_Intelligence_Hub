'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { parseAnomalyConfig } from '@/lib/anomaly-config';
import { DEFAULT_ANOMALY_CONFIG } from '@/lib/selectors/detect-anomalies';
import type { AnomalyConfig } from '@/types/domain';

const STORAGE_KEY = 'cloudlens:detection-config';

interface DetectionConfigContextValue {
  config: AnomalyConfig;
  setConfig: (config: AnomalyConfig) => void;
  reset: () => void;
  isDefault: boolean;
}

const Ctx = createContext<DetectionConfigContextValue | null>(null);

/** Holds the active detection thresholds (persisted locally). The whole app reads anomalies through this config. */
export function DetectionConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfigState] = useState<AnomalyConfig>(DEFAULT_ANOMALY_CONFIG);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = parseAnomalyConfig(JSON.parse(raw));
      if (parsed) setConfigState(parsed);
    } catch {
      /* corrupt or unavailable storage: keep defaults */
    }
  }, []);

  const persist = useCallback((next: AnomalyConfig) => {
    setConfigState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }, []);

  const reset = useCallback(() => persist(DEFAULT_ANOMALY_CONFIG), [persist]);

  const value = useMemo<DetectionConfigContextValue>(
    () => ({ config, setConfig: persist, reset, isDefault: JSON.stringify(config) === JSON.stringify(DEFAULT_ANOMALY_CONFIG) }),
    [config, persist, reset],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDetectionConfig(): DetectionConfigContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useDetectionConfig must be used within <DetectionConfigProvider>');
  return ctx;
}
