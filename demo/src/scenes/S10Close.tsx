import React from 'react';
import { useCurrentFrame } from 'remotion';
import { Caption, Eyebrow, Headline, Lede, Stage } from '../components/chrome';
import { C, F } from '../theme';
import { enter, sceneFade } from '../anim';

/** Scene 10 -- the close, and the provenance of everything shown. */
export const S10Close: React.FC<{ duration: number }> = ({ duration }) => {
  const frame = useCurrentFrame();
  const facts = [
    'Per-account, per-service grants',
    'Every superadmin read audited',
    'One reader, one predicate',
    'Terraform up in one command',
  ];
  return (
    <Stage opacity={sceneFade(frame, duration, 6, 10)}>
      <Eyebrow frame={frame}>CostHub</Eyebrow>
      <Headline frame={frame} size={92}>
        Cost data people can share
        <br />
        without over-sharing.
      </Headline>
      <Lede frame={frame} start={14}>
        Deployed on Cognito, API Gateway, Lambda, RDS and Amplify &mdash; and it bills itself.
      </Lede>
      <div style={{ position: 'absolute', left: 120, bottom: 170, display: 'flex', gap: 46 }}>
        {facts.map((f, i) => (
          <span
            key={f}
            style={{
              ...enter(frame, 22, i, 4),
              fontFamily: F.mono,
              fontSize: 25,
              color: C.ateneo,
            }}
          >
            {f}
          </span>
        ))}
      </div>
      <Caption frame={frame} start={32} tone="live">
        Charts: audited mock estate. Every measured figure in this video was read from the deployed
        stack on 2026-10-13.
      </Caption>
    </Stage>
  );
};
