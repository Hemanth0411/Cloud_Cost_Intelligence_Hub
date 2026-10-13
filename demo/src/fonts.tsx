/**
 * Self-hosted Roboto Slab / Roboto / Roboto Mono, all Apache-2.0.
 *
 * TWO MECHANISMS, deliberately.
 *
 * 1. `@font-face` in a style tag, plus a hidden specimen that uses
 *    every family and weight. That is what actually loads the faces,
 *    and it works whether or not the JavaScript below does.
 * 2. A `delayRender` held until `document.fonts.ready`, so early frames
 *    are not drawn in a fallback face.
 *
 * The second one FAILS OPEN. An earlier version held the render on
 * `FontFace.load()` promises and nothing else: at four concurrent tabs,
 * one tab's promise never settled and the whole render died at frame
 * 904 with "a delayRender() was called but not cleared after 118000ms"
 * -- after six minutes of work. A font that loads a few frames late is
 * a blemish; a render that dies at 40% is a lost afternoon. So the
 * handle is cleared on ready, on error, and on a hard cap, exactly
 * once.
 */
import React from 'react';
import { continueRender, delayRender, staticFile } from 'remotion';

const FACES = [
  { family: 'Roboto Slab', file: 'roboto-slab-latin-400-normal.woff2', weight: 400 },
  { family: 'Roboto Slab', file: 'roboto-slab-latin-600-normal.woff2', weight: 600 },
  { family: 'Roboto Slab', file: 'roboto-slab-latin-700-normal.woff2', weight: 700 },
  { family: 'Roboto', file: 'roboto-latin-400-normal.woff2', weight: 400 },
  { family: 'Roboto', file: 'roboto-latin-500-normal.woff2', weight: 500 },
  { family: 'Roboto', file: 'roboto-latin-700-normal.woff2', weight: 700 },
  { family: 'Roboto Mono', file: 'roboto-mono-latin-400-normal.woff2', weight: 400 },
  { family: 'Roboto Mono', file: 'roboto-mono-latin-500-normal.woff2', weight: 500 },
];

const CSS = FACES.map(
  (f) => `@font-face{font-family:'${f.family}';font-style:normal;font-weight:${f.weight};
src:url('${staticFile(`fonts/${f.file}`)}') format('woff2');font-display:block;}`,
).join('\n');

/** Hold the render until the faces are in, but never past this. */
const CAP_MS = 20_000;

export const Fonts: React.FC = () => {
  const [handle] = React.useState(() => delayRender('fonts', { timeoutInMilliseconds: 60_000 }));
  const done = React.useRef(false);

  React.useEffect(() => {
    const clear = (): void => {
      if (done.current) return;
      done.current = true;
      continueRender(handle);
    };
    const cap = setTimeout(clear, CAP_MS);
    document.fonts.ready.then(clear).catch(clear);
    return () => clearTimeout(cap);
  }, [handle]);

  return (
    <>
      <style>{CSS}</style>
      {/* Declared faces are not fetched until something uses them, so
          `document.fonts.ready` would resolve against an empty queue.
          This specimen is what puts them in it. */}
      <div
        aria-hidden
        style={{ position: 'absolute', opacity: 0, pointerEvents: 'none', top: -9999 }}
      >
        {FACES.map((f) => (
          <span key={`${f.family}${f.weight}`} style={{ fontFamily: f.family, fontWeight: f.weight }}>
            0123456789$ CostHub
          </span>
        ))}
      </div>
    </>
  );
};
