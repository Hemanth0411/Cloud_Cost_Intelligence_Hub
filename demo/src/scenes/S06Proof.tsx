import React from 'react';
import { useCurrentFrame } from 'remotion';
import { Caption, Card, Eyebrow, Headline, Pill, Stage } from '../components/chrome';
import live from '../data/live.json';
import { C, F } from '../theme';
import { enter, sceneFade } from '../anim';

/**
 * Scene 6 -- the one scene with no mock data in it.
 *
 * Two real connections to two real AWS accounts, with the two verdicts
 * the two-stage probe exists to distinguish. Both the success and the
 * failure text are read from `ingest_runs` on the deployed database
 * (tools/dump-live.py), including the error string, which is why it
 * reads like an operator's message rather than a slogan.
 *
 * Cross-account cost access needs three things and the role is only
 * one: the role, the root-only billing toggle, and Cost Explorer. The
 * probe says WHICH is missing -- before this existed you found out at
 * 06:00 the next day when the scheduled ingest wrote `failed`.
 */
const ok = live.ingestRuns.find((r) => r.status === 'success');
const failed = live.ingestRuns.find((r) => r.status === 'failed');

export const S06Proof: React.FC<{ duration: number }> = ({ duration }) => {
  const frame = useCurrentFrame();
  return (
    <Stage opacity={sceneFade(frame, duration, 6, 6)}>
      <Eyebrow frame={frame}>Real accounts, real verdicts</Eyebrow>
      <Headline frame={frame} size={66}>
        &ldquo;Access denied&rdquo; is two different problems.
      </Headline>

      <div style={{ display: 'flex', gap: 34, marginTop: 42 }}>
        <Card style={{ ...enter(frame, 14), flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
            <Pill color={C.success}>ok</Pill>
            <span style={{ fontFamily: F.mono, fontSize: 28, color: C.ink }}>
              aws &middot; this account
            </span>
          </div>
          <div style={{ fontSize: 28, color: C.slate, margin: '20px 0 16px', lineHeight: 1.4 }}>
            Role assumed, Cost Explorer answered, {ok?.rows_written} daily rows written.
            Service names exactly as the API returns them:
          </div>
          <div>
            {live.services.map((s, i) => (
              <div
                key={s.service_name}
                style={{
                  ...enter(frame, 22, i, 3),
                  fontFamily: F.mono,
                  fontSize: 26,
                  color: C.ateneo,
                  lineHeight: 1.6,
                }}
              >
                {s.service_name}
              </div>
            ))}
          </div>
        </Card>

        <Card style={{ ...enter(frame, 20), flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
            <Pill color={C.warning}>stage 2</Pill>
            <span style={{ fontFamily: F.mono, fontSize: 28, color: C.ink }}>
              aws &middot; {failed?.account_id}
            </span>
          </div>
          <div style={{ fontSize: 28, color: C.slate, margin: '20px 0 16px', lineHeight: 1.4 }}>
            The role was assumed. The cost call was refused &mdash; so the problem is not IAM:
          </div>
          <div
            style={{
              ...enter(frame, 30),
              fontFamily: F.mono,
              fontSize: 25,
              lineHeight: 1.5,
              color: C.ink,
              borderLeft: `5px solid ${C.warning}`,
              paddingLeft: 20,
            }}
          >
            {failed?.error}
          </div>
          <div style={{ ...enter(frame, 38), fontSize: 27, color: C.slate, marginTop: 20 }}>
            Only the target account&rsquo;s root user can fix that, and now the e-mail says so.
          </div>
        </Card>
      </div>

      <Caption frame={frame} start={44} tone="live">
        ingest_runs on the deployed database, read {live.capturedAt.slice(0, 10)}. Real spend on this
        account is $0.00 &mdash; it is four months old and free-tier eligible.
      </Caption>
    </Stage>
  );
};
