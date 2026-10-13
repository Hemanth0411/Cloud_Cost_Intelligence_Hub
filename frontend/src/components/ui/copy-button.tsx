'use client';

import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Copy a block of text, and say whether it worked.
 *
 * `navigator.clipboard.writeText` is NOT always available, and the two
 * cases it fails in are both reachable here: it needs a secure context
 * (absent on plain http, which is how a colleague might open a dev
 * server by IP) and it can be refused by permissions policy. The
 * fallback is `document.execCommand('copy')`, deprecated but still
 * universally implemented.
 *
 * If BOTH fail the button says so rather than flashing a tick, because
 * the one thing worse than no copy button is one that reports success
 * and leaves the clipboard untouched -- the user pastes whatever was
 * there before into a message to another team.
 */
export function CopyButton({
  value,
  label = 'Copy',
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  function flash(next: 'done' | 'failed'): void {
    setState(next);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 2000);
  }

  async function copy(): Promise<void> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        flash('done');
        return;
      }
    } catch {
      // Fall through to the legacy path rather than giving up: a
      // rejected permission does not mean execCommand is blocked too.
    }
    flash(legacyCopy(value) ? 'done' : 'failed');
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={cn('shrink-0', className)}
      onClick={() => void copy()}
      aria-live="polite"
    >
      {state === 'done' ? (
        <Check className="h-3.5 w-3.5 text-success" aria-hidden />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden />
      )}
      {state === 'done' ? 'Copied' : state === 'failed' ? 'Copy failed — select it' : label}
    </Button>
  );
}

/**
 * Returns whether the copy actually happened.
 *
 * Restores focus afterwards, which is not cosmetic: `select()` moves
 * focus to the temporary textarea, and removing it leaves
 * `document.activeElement` on `<body>`. This button lives inside a
 * modal whose focus trap only redirects from the first/last focusable
 * or the panel itself, so from `body` the next Tab walks into the page
 * BEHIND the dialog.
 */
function legacyCopy(value: string): boolean {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  try {
    const area = document.createElement('textarea');
    area.value = value;
    // Off-screen but focusable: `display:none` cannot be selected, and
    // a visible element scrolls the dialog as it is focused.
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    previous?.focus();
    return ok;
  } catch {
    previous?.focus();
    return false;
  }
}
