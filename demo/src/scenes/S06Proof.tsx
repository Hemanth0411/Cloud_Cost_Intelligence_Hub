import React from 'react';
import { useCurrentFrame } from 'remotion';
import { Caption, Card, Eyebrow, Headline, Pill, Stage } from '../components/chrome';
import live from '../data/live.json';
import { C, F } from '../theme';
import { enter } from '../anim';

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
const failed = live.lastFailure;

/**
 * The failing connection is a REAL second AWS account belonging to
 * someone else, and the row carries both its twelve-digit id and the
 * display name it was registered under. Neither belongs in a video, so
 * both are masked here rather than in the capture: `dump-live.py` keeps
 * the unredacted row, which is what makes the claim checkable, and the
 * only place the value is softened is the one place it is published.
 */
const MASK = 'a second AWS account';

/**
 * The other account's name and 12-digit id are stripped by
 * `tools/dump-live.py` before they are ever written to disk, so there is
 * nothing to redact here and nothing identifying in the committed
 * capture. What is left is the message an operator would act on.
 */

export const S06Proof: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <Stage>
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
            Role assumed, Cost Explorer answered, {live.totals.row_count} daily rows written.
            Every service it has ever billed, named exactly as the API returns them:
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
            <Pill color={C.warning}>cost call refused</Pill>
            <span style={{ fontFamily: F.mono, fontSize: 28, color: C.ink }}>
              aws &middot; {MASK}
            </span>
          </div>
          <div style={{ fontSize: 28, color: C.slate, margin: '20px 0 16px', lineHeight: 1.4 }}>
            The role was assumed, so the trust policy is right. The cost call was still
            refused, and the message says which two things to check:
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
            The billing toggle is root-only; the missing action is not. Either way the fix is in
            that account, and the operator knows which door to knock on today rather than
            tomorrow.&nbsp;
          </div>
        </Card>
      </div>

      <Caption frame={frame} start={44} tone="live">
        ingest_runs on the deployed database, read {live.capturedAt.slice(0, 10)}. Real spend on
        this account is $0.00: nothing ran on it until recently, and these services are free-tier
        eligible.
      </Caption>
    </Stage>
  );
};
