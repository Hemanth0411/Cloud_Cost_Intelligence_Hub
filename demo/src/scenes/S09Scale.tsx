import React from 'react';
import { useCurrentFrame } from 'remotion';
import { Caption, Card, Eyebrow, Headline, Stage } from '../components/chrome';
import { C, F } from '../theme';
import { enter } from '../anim';

/**
 * Scene 9 -- how it grows, and what it cannot do yet.
 *
 * The last card is deliberate. The mock estate shows Google Cloud
 * accounts and `ingest/sources.py` has adapters for AWS and Azure only
 * -- a GCP connection raises NoAdapter. Saying so on screen costs four
 * seconds and is the difference between a demo and a promise.
 */
const CARDS: { head: string; value: string; body: string; tone?: 'open' }[] = [
  {
    head: 'Adding an account',
    value: 'A row, not a deploy',
    body: 'One connection row, one IAM role in the target account. The grant already covers any account id, so nothing on this side changes.',
  },
  {
    head: 'Adding a provider',
    value: 'An entry and a module',
    body: 'sources.py maps provider to adapter; the adapter itself is a module to write. The runner, the CLI and the Lambda handler never learn the difference.',
  },
  {
    head: 'Re-running ingest',
    value: 'Idempotent by key',
    body: 'Cost data gets restated, so days are re-fetched and land via ON CONFLICT on the natural key. Two indexes are shaped like the grant predicate.',
  },
  {
    head: 'Not built yet',
    value: 'Google Cloud',
    body: 'The mock estate shows GCP accounts; the ingest side raises NoAdapter. Azure is written and unit-tested but has never spoken to Azure.',
    tone: 'open',
  },
];

export const S09Scale: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <Stage>
      <Eyebrow frame={frame}>Scaling it</Eyebrow>
      <Headline frame={frame} size={68}>
        Accounts are independent, so growth is addition.
      </Headline>

      <div style={{ display: 'flex', gap: 26, marginTop: 48 }}>
        {CARDS.map((c, i) => (
          <Card
            key={c.head}
            style={{
              ...enter(frame, 14, i, 6),
              flex: 1,
              padding: 32,
              borderColor: c.tone === 'open' ? C.warning : C.border,
            }}
          >
            <div
              style={{
                fontFamily: F.mono,
                fontSize: 22,
                letterSpacing: 1.6,
                textTransform: 'uppercase',
                color: c.tone === 'open' ? C.warning : C.slate,
              }}
            >
              {c.head}
            </div>
            <div
              style={{
                fontFamily: F.slab,
                fontWeight: 600,
                fontSize: 38,
                color: c.tone === 'open' ? C.warning : C.ateneo,
                lineHeight: 1.15,
                margin: '12px 0 16px',
              }}
            >
              {c.value}
            </div>
            <div style={{ fontSize: 26, lineHeight: 1.42, color: C.slate }}>{c.body}</div>
          </Card>
        ))}
      </div>

      <Caption frame={frame} start={34}>
        On 2026-10-13 one account's ingest failed and the other still wrote its rows — that part
        is measured. Lambda concurrency on this account is capped at 10, so none of this is a load
        test.
      </Caption>
    </Stage>
  );
};
