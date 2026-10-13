import React from 'react';
import { useCurrentFrame } from 'remotion';
import { Card, Eyebrow, Headline, Stage } from '../components/chrome';
import { C, F } from '../theme';
import { enter } from '../anim';

/**
 * Scene 2 -- the before and after, in plain words.
 *
 * The left column is the situation the project was started from, as
 * described in docs/01-requirements.md: separate accounts, each with its
 * own budget alarms, and no way to grant somebody a view of one of them.
 */
const BEFORE = [
  'Every account reported on its own',
  'No single view of what was spent',
  'Access was all of it, or none of it',
];

const NOW = [
  'One place for all of them',
  'By account, by service, by period',
  'Granted per account, per service',
];

export const S2Why: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <Stage>
      <Eyebrow frame={frame}>Why it exists</Eyebrow>
      <Headline frame={frame} size={74}>
        The accounts were never the problem. The view was.
      </Headline>
      <div style={{ display: 'flex', gap: 40, marginTop: 56 }}>
        <Column frame={frame} start={16} title="Before" items={BEFORE} tone="before" />
        <Column frame={frame} start={24} title="Now" items={NOW} tone="now" />
      </div>
    </Stage>
  );
};

const Column: React.FC<{
  frame: number;
  start: number;
  title: string;
  items: string[];
  tone: 'before' | 'now';
}> = ({ frame, start, title, items, tone }) => {
  const accent = tone === 'now' ? C.ateneo : C.slate;
  return (
    <Card
      style={{
        ...enter(frame, start),
        flex: 1,
        padding: 40,
        borderColor: tone === 'now' ? C.bronze : C.border,
        backgroundColor: tone === 'now' ? C.card : 'transparent',
      }}
    >
      <div
        style={{
          fontFamily: F.mono,
          fontSize: 24,
          letterSpacing: 1.8,
          textTransform: 'uppercase',
          color: tone === 'now' ? C.bronze : C.slate,
          marginBottom: 26,
        }}
      >
        {title}
      </div>
      {items.map((item, i) => (
        <div
          key={item}
          style={{
            ...enter(frame, start + 4, i, 5),
            display: 'flex',
            gap: 18,
            alignItems: 'baseline',
            marginBottom: 22,
          }}
        >
          <span style={{ color: tone === 'now' ? C.bronze : C.muted, fontSize: 30 }}>
            {tone === 'now' ? '→' : '·'}
          </span>
          <span
            style={{
              fontFamily: F.slab,
              fontWeight: tone === 'now' ? 600 : 400,
              fontSize: 40,
              lineHeight: 1.25,
              color: accent,
            }}
          >
            {item}
          </span>
        </div>
      ))}
    </Card>
  );
};
