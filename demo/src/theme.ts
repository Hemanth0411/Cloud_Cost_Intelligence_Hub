/**
 * The app's tokens, not a new palette.
 *
 * Copied from `frontend/src/app/globals.css` :root -- same HSL triples,
 * so a frame of this video and a screenshot of the product are the same
 * colours. If the app's tokens change, these are wrong; that is a
 * deliberate trade for not importing Tailwind into a video renderer.
 */
export const C = {
  cream: 'hsl(43.8 36.1% 85.9%)',
  card: 'hsl(43 40% 96%)',
  ink: 'hsl(233 22% 16%)',
  slate: 'hsl(233.7 17.1% 43.5%)',
  ateneo: 'hsl(199.8 100% 20.2%)',
  bronze: 'hsl(37 67.5% 47.1%)',
  khaki: 'hsl(45 34.5% 65.9%)',
  border: 'hsl(43 18% 74%)',
  muted: 'hsl(43 24% 80%)',
  success: 'hsl(152 42% 28%)',
  warning: 'hsl(32 72% 36%)',
  destructive: 'hsl(0 72% 42%)',
} as const;

export const F = {
  slab: '"Roboto Slab", Georgia, serif',
  sans: '"Roboto", system-ui, sans-serif',
  mono: '"Roboto Mono", "Consolas", monospace',
} as const;

/** 1920x1080, 30fps. 30 because software rendering pays per frame. */
export const FPS = 30;
export const W = 1920;
export const H = 1080;

/**
 * 100 BPM -> 0.6s a beat -> 18 frames a beat, 72 a bar. Every scene
 * boundary in Root.tsx is a whole number of bars, and the audio bed is
 * synthesised at the same tempo (tools/make-audio.py), so cuts land on
 * the beat by construction rather than by ear.
 */
export const BPM = 100;
export const BEAT = (60 / BPM) * FPS;
export const BAR = BEAT * 4;
export const bars = (n: number) => Math.round(n * BAR);
