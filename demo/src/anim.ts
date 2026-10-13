/**
 * Motion primitives. Every one is a pure function of the frame.
 *
 * WHY THAT MATTERS HERE: a renderer may draw frame 900 before frame 10,
 * and it draws each frame exactly once. A stateful tween -- "move 4% of
 * the way to the target each tick" -- has no defined value under those
 * conditions, which is how a value ends up jumping mid-shot. So nothing
 * in this video integrates: `at(frame)` is the whole animation.
 *
 * `springs()` is the one worth reading. A value whose target changes is
 * the SUM of one spring per change, each started at its own frame,
 * rather than a new spring from wherever the last one happened to be.
 * That makes a mid-flight target change continuous in value and in
 * velocity -- no jump, no restart.
 */
import { interpolate, spring } from 'remotion';
import { FPS } from './theme';

export type SpringConfig = Parameters<typeof spring>[0]['config'];

/** Soft and heavy: the app is flat and calm, so nothing should ring. */
export const SOFT: SpringConfig = { damping: 200, mass: 0.9, stiffness: 110 };
/** For entrances that need a little life. Still no visible overshoot. */
export const LIVELY: SpringConfig = { damping: 26, mass: 0.6, stiffness: 160 };

/** 0 before `start`, then a spring to 1. Clamped, so it never goes negative. */
export const ease = (frame: number, start: number, config: SpringConfig = SOFT): number => {
  const f = frame - start;
  if (f <= 0) return 0;
  return spring({ frame: f, fps: FPS, config });
};

export interface Keyframe {
  /** Frame at which this value becomes the target. */
  at: number;
  value: number;
}

/**
 * Sum of one spring per target change.
 *
 * value(f) = v0 + SUM_i (v_i - v_{i-1}) * spring(f - at_i)
 */
export const springs = (frame: number, keys: Keyframe[], config: SpringConfig = SOFT): number => {
  if (keys.length === 0) return 0;
  let value = keys[0]!.value;
  for (let i = 1; i < keys.length; i += 1) {
    const delta = keys[i]!.value - keys[i - 1]!.value;
    value += delta * ease(frame, keys[i]!.at, config);
  }
  return value;
};

/** Staggered entrance: opacity + a short rise, driven by one spring. */
export const enter = (
  frame: number,
  start: number,
  index = 0,
  step = 4,
  config: SpringConfig = LIVELY,
): { opacity: number; transform: string } => {
  const p = ease(frame, start + index * step, config);
  return {
    opacity: p,
    transform: `translateY(${((1 - p) * 18).toFixed(3)}px)`,
  };
};

/** Fade in at the head of a scene and out at its tail. No motion. */
export const sceneFade = (frame: number, duration: number, head = 8, tail = 8): number =>
  interpolate(frame, [0, head, duration - tail, duration], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

/** Money, the way the product formats it. */
export const usd = (n: number, digits = 0): string =>
  n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

export const compactUsd = (n: number): string =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `$${Math.round(n / 1_000)}k` : usd(n, 2);

/**
 * Shorten a cost-API service name for a chart axis.
 *
 * This is `compactServiceLabel` from `frontend/src/lib/format.ts`,
 * transcribed: same prefix strip, same suffix strip, same ellipsis. The
 * labels in the data are exactly what the cost APIs return ("Amazon
 * Elastic Compute Cloud - Compute"), so a chart that invents friendly
 * names would be showing something the product never shows.
 */
export const shortService = (label: string, max = 24): string => {
  const trimmed = label
    .replace(/^(Amazon|AWS|Azure|Microsoft|Google Cloud|Google)\s+/, '')
    .replace(/\s+-\s+(Compute|Storage|Service)$/i, '')
    .trim();
  const short = trimmed === '' ? label : trimmed;
  return short.length <= max ? short : `${short.slice(0, max - 1).trimEnd()}…`;
};
