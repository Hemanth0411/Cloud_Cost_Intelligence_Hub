import React from 'react';
import { useCurrentFrame } from 'remotion';
import { Caption, Eyebrow, Headline, Stage } from '../components/chrome';
import { Bars, Columns, Counter } from '../components/data';
import mock from '../data/mock.json';
import { C, F } from '../theme';
import { compactUsd, enter, usd } from '../anim';

/**
 * Scene 3 -- what the product shows.
 *
 * Numbers come from `src/data/mock.json`, which was dumped by running
 * the app's own `getDashboardData` (tools/dump-mock.ts). AWS only: the
 * estate also has Azure and Google Cloud accounts, and the ingest side
 * has no Google adapter, so they are filtered out rather than captioned
 * away.
 */
export const S03Product: React.FC = () => {
  const frame = useCurrentFrame();
  const accounts = mock.all.accounts;
  const max = Math.max(...accounts.map((a) => a.cost));
  return (
    <Stage>
      <Eyebrow frame={frame}>One view over every account</Eyebrow>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 54, marginTop: 18 }}>
        <div>
          <div style={{ ...enter(frame, 4), fontSize: 30, color: C.slate }}>
            365 days to {mock.range.to}, five independent AWS accounts
          </div>
          <Counter
            frame={frame}
            start={14}
            value={mock.all.total}
            format={(n) => usd(n)}
            size={124}
          />
        </div>
        <div style={{ ...enter(frame, 14), paddingBottom: 26, fontSize: 30, color: C.slate }}>
          {mock.all.servicesInUse} services &middot; {usd(mock.all.avgDaily)} a day on average
        </div>
      </div>

      <div style={{ display: 'flex', gap: 48, marginTop: 44 }}>
        <div>
          <SectionLabel frame={frame} start={18}>
            Monthly spend, last 12 calendar months
          </SectionLabel>
          <Columns
            frame={frame}
            start={18}
            points={mock.all.monthly}
            width={780}
            height={290}
          />
          <div style={{ ...enter(frame, 30), fontSize: 24, color: C.slate, marginTop: 6 }}>
            The columns are calendar months, so they do not sum to the 365-day total beside
            them. The last one is partial, drawn in khaki so it is not read as a drop.
          </div>
        </div>
        <div>
          <SectionLabel frame={frame} start={24}>
            By account
          </SectionLabel>
          <Bars
            frame={frame}
            start={18}
            bars={accounts.map((a) => ({ label: a.name, value: a.cost }))}
            scaleMax={max}
            width={830}
            format={compactUsd}
            rowHeight={58}
            labelWidth={300}
          />
        </div>
      </div>

      <Caption frame={frame} start={12}>
        Audited mock estate (3,940 plausibility checks). Not live spend &mdash; the real account&rsquo;s
        figures are three scenes from now.
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
