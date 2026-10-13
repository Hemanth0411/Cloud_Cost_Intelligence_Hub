/**
 * Chart and readout components. All geometry is `f(frame)`.
 *
 * Numbers come from `src/data/*.json`, which is dumped from the app's
 * own selectors and from the deployed database -- nothing here is
 * typed in by hand.
 */
import React from 'react';
import { C, F } from '../theme';
import { ease, enter, springs, type Keyframe } from '../anim';

/** A number that animates to its value and is never interpolated past it. */
export const Counter: React.FC<{
  frame: number;
  start: number;
  value: number;
  format: (n: number) => string;
  size?: number;
  color?: string;
}> = ({ frame, start, value, format, size = 108, color = C.ateneo }) => {
  const shown = springs(frame, [
    { at: start, value: 0 },
    { at: start, value },
  ]);
  return (
    <span
      style={{
        fontFamily: F.slab,
        fontWeight: 700,
        fontSize: size,
        letterSpacing: -2,
        color,
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {format(shown)}
    </span>
  );
};

export interface Bar {
  label: string;
  value: number;
  note?: string;
  dim?: boolean;
}

/**
 * Horizontal bars. `scaleMax` is passed in, not derived, so two charts
 * side by side share an axis -- the RBAC scene depends on that: a
 * narrowed view has to look smaller, not rescale to fill the space.
 */
export const Bars: React.FC<{
  frame: number;
  start: number;
  bars: Bar[];
  scaleMax: number;
  width: number;
  format: (n: number) => string;
  rowHeight?: number;
  labelWidth?: number;
}> = ({ frame, start, bars, scaleMax, width, format, rowHeight = 62, labelWidth = 330 }) => (
  <div style={{ width }}>
    {bars.map((b, i) => {
      const p = ease(frame, start + i * 3);
      const track = width - labelWidth - 210;
      return (
        <div
          key={b.label}
          style={{
            height: rowHeight,
            display: 'flex',
            alignItems: 'center',
            gap: 20,
            opacity: b.dim ? 0.34 : 1,
          }}
        >
          <span
            style={{
              width: labelWidth,
              fontSize: 28,
              color: C.ink,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {b.label}
          </span>
          <span
            style={{
              width: track,
              height: 26,
              backgroundColor: C.muted,
              borderRadius: 4,
              overflow: 'hidden',
            }}
          >
            <span
              style={{
                display: 'block',
                height: '100%',
                width: `${(Math.min(b.value / scaleMax, 1) * 100 * p).toFixed(3)}%`,
                backgroundColor: b.dim ? C.khaki : C.bronze,
              }}
            />
          </span>
          <span
            style={{
              width: 190,
              textAlign: 'right',
              fontFamily: F.mono,
              fontSize: 26,
              color: C.slate,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {b.note ?? format(b.value * p)}
          </span>
        </div>
      );
    })}
  </div>
);

/**
 * Twelve monthly columns, drawn with one spring per column.
 *
 * Columns rather than a line: the data is monthly totals, and a line
 * between month-start points implies daily values that were never
 * measured.
 */
export const Columns: React.FC<{
  frame: number;
  start: number;
  points: { start: string; total: number; partial: boolean }[];
  width: number;
  height: number;
}> = ({ frame, start, points, width, height }) => {
  const max = Math.max(...points.map((p) => p.total));
  const gap = 14;
  const colWidth = (width - gap * (points.length - 1)) / points.length;
  return (
    <div style={{ width, height, display: 'flex', alignItems: 'flex-end', gap }}>
      {points.map((p, i) => {
        const grow = ease(frame, start + i * 2);
        const h = (p.total / max) * (height - 46) * grow;
        const month = new Date(`${p.start}T00:00:00Z`).toLocaleString('en-US', {
          month: 'short',
          timeZone: 'UTC',
        });
        return (
          <div key={p.start} style={{ width: colWidth, textAlign: 'center' }}>
            <div
              style={{
                height: h,
                backgroundColor: p.partial ? C.khaki : C.bronze,
                borderRadius: '4px 4px 0 0',
              }}
            />
            <div style={{ fontFamily: F.mono, fontSize: 20, color: C.slate, paddingTop: 10 }}>
              {month}
            </div>
          </div>
        );
      })}
    </div>
  );
};

/** Monospaced source, line by line, with one line highlighted. */
export const Code: React.FC<{
  frame: number;
  start: number;
  lines: string[];
  highlight?: number[];
  size?: number;
  width?: number | string;
}> = ({ frame, start, lines, highlight = [], size = 27, width = '100%' }) => (
  <div
    style={{
      width,
      backgroundColor: C.card,
      border: `2px solid ${C.border}`,
      borderRadius: 16,
      padding: '26px 32px',
      fontFamily: F.mono,
      fontSize: size,
      lineHeight: 1.52,
      color: C.ink,
      whiteSpace: 'pre',
    }}
  >
    {lines.map((line, i) => (
      <div
        key={`${i}-${line}`}
        style={{
          ...enter(frame, start, i, 2),
          color: highlight.includes(i) ? C.ateneo : C.slate,
          fontWeight: highlight.includes(i) ? 500 : 400,
          backgroundColor: highlight.includes(i) ? 'hsl(37 42% 88%)' : 'transparent',
          borderRadius: 4,
          padding: '0 6px',
          margin: '0 -6px',
        }}
      >
        {line === '' ? ' ' : line}
      </div>
    ))}
  </div>
);

/** Label over value. Used for the cost, deploy and scale scenes. */
export const Stat: React.FC<{
  frame: number;
  start: number;
  index?: number;
  label: string;
  value: string;
  note?: string;
  valueColor?: string;
}> = ({ frame, start, index = 0, label, value, note, valueColor = C.ateneo }) => (
  <div style={{ ...enter(frame, start, index, 5) }}>
    <div
      style={{
        fontFamily: F.mono,
        fontSize: 22,
        letterSpacing: 1.6,
        textTransform: 'uppercase',
        color: C.slate,
      }}
    >
      {label}
    </div>
    <div
      style={{
        fontFamily: F.slab,
        fontWeight: 700,
        fontSize: 60,
        color: valueColor,
        lineHeight: 1.18,
        letterSpacing: -1,
      }}
    >
      {value}
    </div>
    {note ? <div style={{ fontSize: 26, color: C.slate, lineHeight: 1.35 }}>{note}</div> : null}
  </div>
);

export interface KeyedBar {
  label: string;
  /** Value over time. The sum-of-springs rule applies: see anim.ts. */
  keys: Keyframe[];
  /** Spring to 0.34 opacity at this frame; omitted means never dimmed. */
  dimAt?: number;
  /** Replaces the value on the right once `dimAt` has passed. */
  dimNote?: string;
}

/**
 * Bars whose values CHANGE mid-shot, e.g. an access grant being
 * applied. Each bar is the sum of one spring per target change, so a
 * row that is already moving when the target changes keeps its velocity
 * instead of restarting from wherever it had got to.
 */
export const BarsKeyed: React.FC<{
  frame: number;
  bars: KeyedBar[];
  scaleMax: number;
  width: number;
  format: (n: number) => string;
  rowHeight?: number;
  labelWidth?: number;
}> = ({ frame, bars, scaleMax, width, format, rowHeight = 62, labelWidth = 330 }) => (
  <div style={{ width }}>
    {bars.map((b) => {
      const value = springs(frame, b.keys);
      const dim = b.dimAt === undefined ? 0 : ease(frame, b.dimAt);
      const track = width - labelWidth - 260;
      return (
        <div
          key={b.label}
          style={{
            height: rowHeight,
            display: 'flex',
            alignItems: 'center',
            gap: 20,
            opacity: 1 - dim * 0.62,
          }}
        >
          <span style={{ width: labelWidth, fontSize: 28, color: C.ink, whiteSpace: 'nowrap' }}>
            {b.label}
          </span>
          <span
            style={{
              width: track,
              height: 26,
              backgroundColor: C.muted,
              borderRadius: 4,
              overflow: 'hidden',
            }}
          >
            <span
              style={{
                display: 'block',
                height: '100%',
                width: `${(Math.max(0, Math.min(value / scaleMax, 1)) * 100).toFixed(3)}%`,
                backgroundColor: C.bronze,
              }}
            />
          </span>
          <span
            style={{
              width: 240,
              textAlign: 'right',
              fontFamily: F.mono,
              fontSize: 26,
              color: C.slate,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {b.dimNote && dim > 0.5 ? b.dimNote : format(value)}
          </span>
        </div>
      );
    })}
  </div>
);
