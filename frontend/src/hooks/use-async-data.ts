'use client';

import { useEffect, useRef, useState } from 'react';
import { NetworkError } from '@/lib/api/client';

export type AsyncState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T; isRefreshing: boolean }
  | { status: 'error'; error: Error; message: string };

/**
 * Load something that can change when the filters do.
 *
 * THREE BEHAVIOURS THAT ARE NOT OPTIONAL HERE:
 *
 *  * A REFETCH KEEPS THE OLD DATA ON SCREEN, dimmed, instead of
 *    dropping back to a skeleton. Changing a date range otherwise
 *    makes the whole page blink, and on a fast response the skeleton
 *    appears for one frame, which reads as a glitch.
 *  * A LATE RESPONSE IS DISCARDED. Clicking three ranges quickly
 *    starts three requests, and without the guard the slowest one
 *    wins and the page shows a range nobody selected.
 *  * THE ERROR IS A STATE, NOT A THROW. Throwing reaches the nearest
 *    error boundary and replaces the whole route, so a single failed
 *    panel takes the navigation with it. The caller renders an
 *    `ErrorState` in place and the rest of the shell survives.
 *
 * `key` is what decides a reload: pass a string that changes exactly
 * when the inputs do. Identity on the inputs themselves is not
 * reliable -- `filters` is memoised per URL but `overrides` is rebuilt
 * whenever the anomaly workflow writes.
 */
export function useAsyncData<T>(key: string, load: () => Promise<T>): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' });
  // The loader closes over props, so it is a new function every
  // render. Holding it in a ref keeps it out of the dependency list
  // without lying to the linter about what the effect reads.
  const loader = useRef(load);
  loader.current = load;
  const run = useRef(0);

  useEffect(() => {
    const ticket = (run.current += 1);
    setState((prev) => (prev.status === 'ready' ? { ...prev, isRefreshing: true } : { status: 'loading' }));

    loader
      .current()
      .then((data) => {
        if (run.current !== ticket) return;
        setState({ status: 'ready', data, isRefreshing: false });
      })
      .catch((cause: unknown) => {
        if (run.current !== ticket) return;
        const error = cause instanceof Error ? cause : new Error(String(cause));
        setState({ status: 'error', error, message: messageFor(error) });
      });
  }, [key]);

  return state;
}

/**
 * What to put on the screen.
 *
 * A `NetworkError` already carries the three-way explanation the
 * browser refuses to disambiguate (unreachable / CORS / server-side
 * 500), so it is passed through. Anything else gets its own message
 * only if it has one; an empty message would render a blank error
 * panel, which is worse than a generic sentence.
 */
function messageFor(error: Error): string {
  if (error instanceof NetworkError) return error.message;
  return error.message || 'Something went wrong loading this data.';
}
