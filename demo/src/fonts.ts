/**
 * Self-hosted Roboto Slab / Roboto / Roboto Mono, all Apache-2.0.
 *
 * Self-hosted rather than linked: a render that fetches a font at frame
 * 0 and misses draws frame 0 in a fallback face, and nothing about that
 * is reproducible. `delayRender` holds every frame until the faces are
 * in `document.fonts`, so either the whole video has the right type or
 * the render fails loudly.
 *
 * Licences are copied next to the files (public/fonts/LICENSE-*.txt)
 * and listed in CREDITS.md.
 */
import { continueRender, delayRender, staticFile } from 'remotion';

interface Face {
  family: string;
  file: string;
  weight: string;
}

const FACES: Face[] = [
  { family: 'Roboto Slab', file: 'roboto-slab-latin-400-normal.woff2', weight: '400' },
  { family: 'Roboto Slab', file: 'roboto-slab-latin-600-normal.woff2', weight: '600' },
  { family: 'Roboto Slab', file: 'roboto-slab-latin-700-normal.woff2', weight: '700' },
  { family: 'Roboto', file: 'roboto-latin-400-normal.woff2', weight: '400' },
  { family: 'Roboto', file: 'roboto-latin-500-normal.woff2', weight: '500' },
  { family: 'Roboto', file: 'roboto-latin-700-normal.woff2', weight: '700' },
  { family: 'Roboto Mono', file: 'roboto-mono-latin-400-normal.woff2', weight: '400' },
  { family: 'Roboto Mono', file: 'roboto-mono-latin-500-normal.woff2', weight: '500' },
];

let started = false;

export const loadFonts = (): void => {
  if (started || typeof document === 'undefined') return;
  started = true;
  const handle = delayRender('loading self-hosted fonts');
  Promise.all(
    FACES.map(async (face) => {
      const loaded = await new FontFace(
        face.family,
        `url(${staticFile(`fonts/${face.file}`)}) format('woff2')`,
        { weight: face.weight, style: 'normal' },
      ).load();
      document.fonts.add(loaded);
    }),
  )
    .then(() => continueRender(handle))
    .catch((cause: unknown) => {
      // Loud, not silent: a fallback face changes every measurement in
      // the video and would quietly ruin the layout review.
      throw new Error(`font load failed: ${String(cause)}`);
    });
};
