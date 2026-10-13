import React from 'react';
import { useCurrentFrame } from 'remotion';
import { Caption, Card, Eyebrow, Headline, Pill, Stage } from '../components/chrome';
import live from '../data/live.json';
import { C, F } from '../theme';
import { enter } from '../anim';

/**
 * Scene 5 -- the short proof that this runs.
 *
 * Cut down from a whole scene about the two-stage probe to the part a
 * viewer can take in at speed: one account answering with its real
 * service names, and one that cannot be read yet saying exactly why.
 * Both come from `ingest_runs` on the deployed database; the second
 * account's name and id are stripped at capture time.
 */
const failed = live.lastFailure;

export const S5Real: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <Stage>
      <Eyebrow frame={frame}>And it is real</Eyebrow>
      <Headline frame={frame} size={68}>
        Connected to a live account.
      </Headline>

      <div style={{ display: 'flex', gap: 34, marginTop: 40 }}>
        <Card style={{ ...enter(frame, 12), flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
            <Pill color={C.success}>reading</Pill>
            <span style={{ fontFamily: F.mono, fontSize: 28, color: C.ink }}>this account</span>
          </div>
          <div style={{ fontSize: 28, color: C.slate, margin: '18px 0 14px' }}>
            Its own services, named the way AWS names them:
          </div>
          {live.services.slice(0, 5).map((s, i) => (
            <div
              key={s.service_name}
              style={{
                ...enter(frame, 18, i, 3),
                fontFamily: F.mono,
                fontSize: 26,
                color: C.ateneo,
                lineHeight: 1.6,
              }}
            >
              {s.service_name}
            </div>
          ))}
        </Card>

        <Card style={{ ...enter(frame, 18), flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
            <Pill color={C.warning}>not yet</Pill>
            <span style={{ fontFamily: F.mono, fontSize: 28, color: C.ink }}>
              a second AWS account
            </span>
          </div>
          <div style={{ fontSize: 28, color: C.slate, margin: '18px 0 14px' }}>
            It does not guess. It says which switch is off:
          </div>
          <div
            style={{
              ...enter(frame, 26),
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
        </Card>
      </div>

      <Caption frame={frame} start={30} tone="live">
        Read from the deployed database on {live.capturedAt.slice(0, 10)}.
      </Caption>
    </Stage>
  );
};
