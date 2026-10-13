/**
 * The frame every scene sits in: background, type, the honesty caption.
 *
 * The caption is not decoration. A viewer cannot tell audited mock data
 * from live spend by looking, so anything on screen that is not live
 * says so in the same place every time, bottom left, for the whole
 * shot.
 */
import React from 'react';
import { AbsoluteFill } from 'remotion';
import { C, F } from '../theme';
import { enter } from '../anim';

export const Stage: React.FC<{ children: React.ReactNode; opacity?: number }> = ({
  children,
  opacity = 1,
}) => (
  <AbsoluteFill
    style={{
      backgroundColor: C.cream,
      color: C.ink,
      fontFamily: F.sans,
      padding: '96px 120px',
      opacity,
    }}
  >
    {children}
  </AbsoluteFill>
);

/** Small bronze-ruled eyebrow. Same role as a section label in the app. */
export const Eyebrow: React.FC<{ frame: number; start?: number; children: React.ReactNode }> = ({
  frame,
  start = 0,
  children,
}) => (
  <div
    style={{
      ...enter(frame, start),
      display: 'flex',
      alignItems: 'center',
      gap: 18,
      fontFamily: F.mono,
      fontSize: 26,
      letterSpacing: 2.4,
      textTransform: 'uppercase',
      color: C.slate,
    }}
  >
    <span style={{ width: 54, height: 4, backgroundColor: C.bronze, display: 'inline-block' }} />
    {children}
  </div>
);

export const Headline: React.FC<{
  frame: number;
  start?: number;
  size?: number;
  color?: string;
  children: React.ReactNode;
}> = ({ frame, start = 4, size = 84, color = C.ateneo, children }) => (
  <h1
    style={{
      ...enter(frame, start),
      fontFamily: F.slab,
      fontWeight: 700,
      fontSize: size,
      lineHeight: 1.08,
      letterSpacing: -1.5,
      color,
      margin: '26px 0 0 0',
      maxWidth: 1500,
    }}
  >
    {children}
  </h1>
);

export const Lede: React.FC<{
  frame: number;
  start?: number;
  size?: number;
  children: React.ReactNode;
}> = ({ frame, start = 10, size = 38, children }) => (
  <p
    style={{
      ...enter(frame, start),
      fontSize: size,
      lineHeight: 1.45,
      color: C.slate,
      margin: '24px 0 0 0',
      maxWidth: 1340,
    }}
  >
    {children}
  </p>
);

/**
 * Provenance, pinned bottom-left. `tone` only changes the rule colour:
 * bronze for "this is mock", ateneo for "this is live".
 */
export const Caption: React.FC<{
  frame: number;
  start?: number;
  tone?: 'mock' | 'live';
  children: React.ReactNode;
}> = ({ frame, start = 14, tone = 'mock', children }) => (
  <div
    style={{
      ...enter(frame, start),
      position: 'absolute',
      left: 120,
      bottom: 64,
      display: 'flex',
      alignItems: 'center',
      gap: 16,
      maxWidth: 1600,
    }}
  >
    <span
      style={{
        width: 5,
        alignSelf: 'stretch',
        backgroundColor: tone === 'live' ? C.ateneo : C.bronze,
        borderRadius: 3,
      }}
    />
    <span style={{ fontFamily: F.mono, fontSize: 24, lineHeight: 1.4, color: C.slate }}>
      {children}
    </span>
  </div>
);

/** A flat card. No shadow, no gradient -- the app has neither. */
export const Card: React.FC<{
  style?: React.CSSProperties;
  children: React.ReactNode;
}> = ({ style, children }) => (
  <div
    style={{
      backgroundColor: C.card,
      border: `2px solid ${C.border}`,
      borderRadius: 18,
      padding: 34,
      ...style,
    }}
  >
    {children}
  </div>
);

export const Pill: React.FC<{ color?: string; children: React.ReactNode }> = ({
  color = C.ateneo,
  children,
}) => (
  <span
    style={{
      fontFamily: F.mono,
      fontSize: 22,
      letterSpacing: 1.2,
      textTransform: 'uppercase',
      color,
      border: `2px solid ${color}`,
      borderRadius: 999,
      padding: '6px 18px',
      whiteSpace: 'nowrap',
    }}
  >
    {children}
  </span>
);
