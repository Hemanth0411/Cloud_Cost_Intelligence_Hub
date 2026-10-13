import React from 'react';
import { useCurrentFrame } from 'remotion';
import { Caption, Card, Eyebrow, Headline, Stage } from '../components/chrome';
import { C, F } from '../theme';
import { enter } from '../anim';

/**
 * Scene 7 -- the roadmap, and the only scene allowed to name things
 * that do not exist.
 *
 * It is marked as a roadmap three times over -- the eyebrow, the card
 * label on every card, and the caption -- because this is exactly the
 * slide where a demo starts promising. The Azure wording is precise:
 * the adapter is written and unit-tested against a recorded response,
 * and has never spoken to Azure. Google Cloud has no adapter at all.
 */
const NEXT = [
  {
    head: 'Azure',
    body: 'The reader is written and tested against a recorded response. It has never spoken to Azure.',
  },
  {
    head: 'Google Cloud',
    body: 'Not built. Today a Google connection is refused rather than half-read.',
  },
  {
    head: 'Beyond the cloud bill',
    body: 'The same shape fits anything that bills per account and per service — Databricks, Snowflake, a SaaS seat count.',
  },
  {
    head: 'Alerts to people',
    body: 'A spike should reach the person who owns that account, by mail or chat, not sit on a dashboard nobody opened.',
  },
];

export const S7Next: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <Stage>
      <Eyebrow frame={frame}>Roadmap &mdash; not built yet</Eyebrow>
      <Headline frame={frame} size={70}>
        One reader per source. That is the whole extension point.
      </Headline>

      <div style={{ display: 'flex', gap: 26, marginTop: 48 }}>
        {NEXT.map((card, i) => (
          <Card
            key={card.head}
            style={{
              ...enter(frame, 14, i, 6),
              flex: 1,
              padding: 32,
              borderColor: C.warning,
              backgroundColor: 'transparent',
            }}
          >
            <div
              style={{
                fontFamily: F.mono,
                fontSize: 21,
                letterSpacing: 1.6,
                textTransform: 'uppercase',
                color: C.warning,
              }}
            >
              Planned
            </div>
            <div
              style={{
                fontFamily: F.slab,
                fontWeight: 600,
                fontSize: 40,
                color: C.ateneo,
                lineHeight: 1.15,
                margin: '12px 0 16px',
              }}
            >
              {card.head}
            </div>
            <div style={{ fontSize: 27, lineHeight: 1.42, color: C.slate }}>{card.body}</div>
          </Card>
        ))}
      </div>

      <Caption frame={frame} start={32}>
        None of this is in the product today. Adding a source is one entry in the reader table and
        one module to write.
      </Caption>
    </Stage>
  );
};
