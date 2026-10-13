import React from 'react';
import { useCurrentFrame } from 'remotion';
import { Caption, Eyebrow, Headline, Stage } from '../components/chrome';
import { Bars, Columns } from '../components/data';
import mock from '../data/mock.json';
import { C, F } from '../theme';
import { compactUsd, enter } from '../anim';

/**
 * Scene 3 -- what you actually look at.
 *
 * Deliberately fewer figures than the first cut of this video had: the
 * shapes carry the idea, and one total is enough to say what scale this
 * is. The period row is the app's real granularity set
 * (`Granularity` in types/analytics.ts), not a decoration.
 */
const PERIODS = ['Day', 'Month', 'Quarter', 'Year'];

export const S3See: React.FC = () => {
  const frame = useCurrentFrame();
  const accounts = mock.all.accounts;
  const max = Math.max(...accounts.map((a) => a.cost));
  return (
    <Stage>
      <Eyebrow frame={frame}>What you see</Eyebrow>
      <Headline frame={frame} size={70}>
        Spend by account, by service, by period.
      </Headline>

      <div style={{ ...enter(frame, 12), display: 'flex', gap: 14, marginTop: 30 }}>
        {PERIODS.map((p, i) => (
          <span
            key={p}
            style={{
              ...enter(frame, 14, i, 3),
              fontFamily: F.mono,
              fontSize: 24,
              letterSpacing: 1.4,
              color: i === 1 ? C.card : C.slate,
              backgroundColor: i === 1 ? C.ateneo : 'transparent',
              border: `2px solid ${i === 1 ? C.ateneo : C.border}`,
              borderRadius: 999,
              padding: '8px 22px',
            }}
          >
            {p}
          </span>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 48, marginTop: 36 }}>
        <div>
          <SectionLabel frame={frame} start={18}>
            Monthly spend
          </SectionLabel>
          <Columns frame={frame} start={20} points={mock.all.monthly} width={780} height={300} />
        </div>
        <div>
          <SectionLabel frame={frame} start={20}>
            By account
          </SectionLabel>
          <Bars
            frame={frame}
            start={20}
            bars={accounts.map((a) => ({ label: a.name, value: a.cost }))}
            scaleMax={max}
            width={830}
            format={compactUsd}
            rowHeight={60}
            labelWidth={300}
          />
        </div>
      </div>

      <Caption frame={frame} start={12}>
        Sample estate, audited for plausibility. Not live spend &mdash; the real account is two scenes
        from now.
      </Caption>
    </Stage>
  );
};

const SectionLabel: React.FC<{ frame: number; start: number; children: React.ReactNode }> = ({
  frame,
  start,
  children,
}) => (
  <div
    style={{
      ...enter(frame, start),
      fontFamily: F.mono,
      fontSize: 24,
      letterSpacing: 1.8,
      textTransform: 'uppercase',
      color: C.slate,
      marginBottom: 16,
    }}
  >
    {children}
  </div>
);
