'use client';

import { useEffect, useState } from 'react';
import { readSession } from '@/lib/auth/session';
import type { User } from '@/types/domain';

export interface SessionState {
  /** null until the effect has run, so server and first client render agree. */
  user: User | null;
  /** False while loading. Never gate anything that matters on this alone. */
  isSuperadmin: boolean;
  /** Distinguishes "no session" from "not read yet". */
  loaded: boolean;
}

/**
 * The signed-in user.
 *
 * `readSession` reads a cookie, so it cannot run during SSR -- it has to
 * happen in an effect or the server and client markup disagree and React
 * discards the tree. That effect was copy-pasted into user-menu and
 * settings-view; adding role-aware navigation would have made three, so
 * it lives here once.
 *
 * This is NOT a security boundary. The cookie is a mock session marker
 * and the real check is server-side: the API applies the grant predicate
 * in SQL and returns 403 regardless of what the UI chooses to render.
 * Hiding admin navigation is a convenience, not a control.
 */
export function useSession(): SessionState {
  const [user, setUser] = useState<User | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setUser(readSession());
    setLoaded(true);
  }, []);

  return { user, isSuperadmin: user?.role === 'superadmin', loaded };
}
