'use client';

import { useEffect, useState } from 'react';
import { demoInstant, demoNow } from '@/lib/clock';
import { isMock } from '@/lib/mode';

/**
 * "Now", for the relative timestamps on screen.
 *
 * MOCK MODE runs on a demo clock anchored to the dataset's last day,
 * so "2 hours ago" lines up with data generated for 12 Oct 2026.
 *
 * LIVE MODE MUST NOT. The anchor is a fixed instant in the past, and
 * every day that passes adds a day of error to "fired 3 hours ago"
 * computed against a REAL `alert_events.fired_at`. The drift is
 * silent and unbounded, which is the worst kind.
 *
 * Either way the first paint uses the anchor, so the server HTML and
 * the hydrated tree agree; the real value arrives in the effect.
 */
export function useDemoNow(): Date {
  const [now, setNow] = useState(demoInstant);

  useEffect(() => {
    const read = (): Date => (isMock() ? demoNow() : new Date());
    setNow(read());
    const id = window.setInterval(() => setNow(read()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  return now;
}
