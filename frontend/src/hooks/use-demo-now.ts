'use client';

import { useEffect, useState } from 'react';
import { demoInstant, demoNow } from '@/lib/clock';

/** Demo "now" that matches the server on the first paint, then follows the live clock. */
export function useDemoNow(): Date {
  const [now, setNow] = useState(demoInstant);

  useEffect(() => {
    setNow(demoNow());
    const id = window.setInterval(() => setNow(demoNow()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  return now;
}
