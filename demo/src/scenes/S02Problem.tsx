import React from 'react';
import { useCurrentFrame } from 'remotion';
import { Card, Eyebrow, Headline, Stage } from '../components/chrome';
import { C, F } from '../theme';
import { enter, sceneFade } from '../anim';

/**
 * Scene 2 -- why the off-the-shelf answer does not apply.
 *
 * Every line here is a requirement from `docs/01-requirements.md`, not
 * a marketing claim about a competitor.
 */
const POINTS: { head: string; body: string }[] = [
  {
    head: 'No AWS Organization',
    body: 'Independent accounts with no payer. No org-wide CUR export, no rollup to inherit.',
  },
  {
    head: 'Cost data is sensitive',
    body: 'Not everyone may see every account. Finance sees one; an engineer sees one service inside another.',
  },
  {
    head: 'So the ready-made dashboards do not fit',
    body: 'AWS Cloud Intelligence Dashboards start from a payer account and an org-wide export. Neither exists here.',
  },
];

export const S02Problem: React.FC<{ duration: number }> = ({ duration }) => {
  const frame = useCurrentFrame();
  return (
    <Stage opacity={sceneFade(frame, duration, 6, 6)}>
      <Eyebrow frame={frame}>The constraint</Eyebrow>
      <Headline frame={frame} size={72}>
        Two facts ruled out every shortcut.
      </Headline>
      <div style={{ display: 'flex', gap: 28, marginTop: 56 }}>
        {POINTS.map((p, i) => (
          <Card key={p.head} style={{ ...enter(frame, 16, i, 7), flex: 1, padding: 38 }}>
            <div
              style={{
                fontFamily: F.mono,
                fontSize: 24,
                color: C.bronze,
                letterSpacing: 1.4,
              }}
            >
              0{i + 1}
            </div>
            <div
              style={{
                fontFamily: F.slab,
                fontWeight: 600,
                fontSize: 42,
                color: C.ateneo,
                lineHeight: 1.18,
                margin: '14px 0 18px',
              }}
            >
              {p.head}
            </div>
            <div style={{ fontSize: 30, lineHeight: 1.45, color: C.slate }}>{p.body}</div>
          </Card>
        ))}
      </div>
    </Stage>
  );
};
