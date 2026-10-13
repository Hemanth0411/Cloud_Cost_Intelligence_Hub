import React from 'react';
import { useCurrentFrame } from 'remotion';
import { Caption, Eyebrow, Headline, Lede, Stage } from '../components/chrome';
import { C, F } from '../theme';
import { enter, sceneFade } from '../anim';

/**
 * Scene 1 -- the hook. Claims: none beyond what the stack is, which is
 * the list in `terraform/`.
 */
export const S01Hook: React.FC<{ duration: number }> = ({ duration }) => {
  const frame = useCurrentFrame();
  const stack = ['Cognito', 'API Gateway', 'Lambda', 'RDS Postgres', 'Amplify', 'Terraform'];
  return (
    <Stage opacity={sceneFade(frame, duration, 6, 6)}>
      <Eyebrow frame={frame}>CostHub &middot; cloud cost intelligence</Eyebrow>
      <Headline frame={frame} size={96}>
        Cost visibility for AWS accounts
        <br />
        that were never an Organization.
      </Headline>
      <Lede frame={frame} start={12}>
        Independent accounts. Sensitive spend. Access granted per account and per service &mdash;
        and enforced in SQL, not in the UI.
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
      <Caption frame={frame} start={30} tone="live">
        Deployed and running in AWS account 997916278551, us-east-1.
      </Caption>
    </Stage>
  );
};
