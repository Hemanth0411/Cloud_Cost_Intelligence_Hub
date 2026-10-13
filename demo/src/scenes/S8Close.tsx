import React from 'react';
import { useCurrentFrame } from 'remotion';
import { Caption, Eyebrow, Headline, Lede, Stage } from '../components/chrome';
import { C, F } from '../theme';
import { enter } from '../anim';

/** Scene 8 -- the close, and where every figure came from. */
export const S8Close: React.FC = () => {
  const frame = useCurrentFrame();
  const facts = ['One dashboard', 'Granted per account', 'Deployed in one command', 'Watches its own bill'];
  return (
    <Stage>
      <Eyebrow frame={frame}>CostHub</Eyebrow>
      <Headline frame={frame} size={92}>
        Cost data people can share
        <br />
        without over-sharing.
      </Headline>
      <Lede frame={frame} start={14}>
        Running on AWS today, on one small database and a handful of functions.
      </Lede>
      <div style={{ position: 'absolute', left: 120, bottom: 230, display: 'flex', gap: 46 }}>
        {facts.map((f, i) => (
          <span
            key={f}
            style={{ ...enter(frame, 20, i, 4), fontFamily: F.mono, fontSize: 25, color: C.ateneo }}
          >
            {f}
          </span>
        ))}
      </div>
      <Caption frame={frame} start={28} tone="live">
        Charts use a sample estate. The account, the connection and the bill are the real deployment,
        read on 2026-10-13.
      </Caption>
    </Stage>
  );
};
