'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Reveals text progressively when `animationId` changes (first load, manual refresh) to simulate a
 * model writing. Any other text change shows instantly. Screen readers get the full text at once.
 */
export function TypewriterText({ text, animationId }: { text: string; animationId: number }) {
  const [shown, setShown] = useState(text);
  const lastAnimated = useRef(0);

  useEffect(() => {
    if (animationId === lastAnimated.current) {
      setShown(text);
      return;
    }
    lastAnimated.current = animationId;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(text);
      return;
    }
    let i = 0;
    setShown('');
    const id = window.setInterval(() => {
      i += 3;
      setShown(text.slice(0, i));
      if (i >= text.length) window.clearInterval(id);
    }, 16);
    return () => window.clearInterval(id);
  }, [text, animationId]);

  const typing = shown.length < text.length;
  return (
    <>
      <span className="sr-only">{text}</span>
      <span aria-hidden>
        {shown}
        {typing && <span className="ml-0.5 inline-block h-4 w-0.5 translate-y-0.5 animate-pulse bg-primary" />}
      </span>
    </>
  );
}
