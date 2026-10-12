'use client';

import { useEffect, useState } from 'react';
import { BUILD_DEFAULT_IS_MOCK, isMock } from '@/lib/mode';

/**
 * The current mode, safe to branch on during render.
 *
 * `isMock()` reads `localStorage`, which does not exist on the
 * server, so the first render has to assume the build default or the
 * server HTML and the hydrated tree disagree -- React then discards
 * the server markup and logs a hydration error. `resolved` says
 * whether the answer is final yet; components that would otherwise
 * print a claim about the data source wait for it.
 *
 * Data loading does NOT need this: it happens in effects, which only
 * run in the browser, where `isMock()` is already correct.
 */
export function useMode(): { mock: boolean; resolved: boolean } {
  const [mock, setMock] = useState(BUILD_DEFAULT_IS_MOCK);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    setMock(isMock());
    setResolved(true);
  }, []);

  return { mock, resolved };
}
