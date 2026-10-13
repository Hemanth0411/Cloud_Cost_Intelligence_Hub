import React from 'react';
import { useCurrentFrame } from 'remotion';
import { Caption, Eyebrow, Headline, Lede, Stage } from '../components/chrome';
import { C, F } from '../theme';
import { enter } from '../anim';

/** Scene 1 -- what the thing is, in one sentence. */
export const S1What: React.FC = () => {
  const frame = useCurrentFrame();
  const stack = ['Cognito', 'API Gateway', 'Lambda', 'RDS Postgres', 'Amplify', 'Terraform'];
  return (
    <Stage>
      <Eyebrow frame={frame}>CostHub</Eyebrow>
      <Headline frame={frame} size={92}>
        One dashboard for cloud spend
        <br />
        across accounts that were never
        <br />
        an Organization.
      </Headline>
      <Lede frame={frame} start={14}>
        Sign in, and see every account you are allowed to see.
      </Lede>
      <div style={{ position: 'absolute', left: 120, bottom: 150, display: 'flex', gap: 14 }}>
        {stack.map((item, i) => (
          <span
            key={item}
            style={{
              ...enter(frame, 22, i, 3),
              fontFamily: F.mono,
              fontSize: 24,
              color: C.slate,
              border: `2px solid ${C.border}`,
              borderRadius: 999,
              padding: '8px 20px',
              backgroundColor: C.card,
            }}
          >
            {item}
          </span>
        ))}
      </div>
      <Caption frame={frame} start={28} tone="live">
        Deployed and running in AWS, us-east-1.
      </Caption>
    </Stage>
  );
};
