import React from 'react';
import { useCurrentFrame } from 'remotion';
import { Caption, Eyebrow, Headline, Stage } from '../components/chrome';
import { Stat } from '../components/data';
import live from '../data/live.json';
import { C, F } from '../theme';
import { enter } from '../anim';

/**
 * Scene 7 -- what the thing costs to run.
 *
 * The first figure is not an estimate: CostHub's first connection is
 * the account it is deployed in, so the bill on screen is its own, read
 * out of its own fact table. It is $0.00 because the account is four
 * months old and these services are free-tier eligible -- which is
 * stated rather than implied, because "$0" with no reason reads as a
 * lie and "$0 forever" would be one.
 */
const t = live.totals;

export const S07Cost: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <Stage>
      <Eyebrow frame={frame}>What it costs to run</Eyebrow>
      <Headline frame={frame} size={68}>
        CostHub&rsquo;s first connected account is its own.
      </Headline>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          columnGap: 90,
          rowGap: 48,
          marginTop: 52,
          maxWidth: 1620,
        }}
      >
        <Stat
          frame={frame}
          start={14}
          index={0}
          label={`Its own bill, ${t.first_day} to ${t.last_day}`}
          value="$0.00"
          note={`${t.row_count} daily rows across ${t.services} services, ingested by the product itself. Free-tier eligible, not free forever.`}
        />
        <Stat
          frame={frame}
          start={14}
          index={1}
          label="The whole estate it runs on"
          value="1 database, 5 functions"
          note="db.t4g.micro + 20 GB gp3, four Lambdas at 512 MB and one at 256, one HTTP API, Amplify hosting. No EC2, no NAT gateway, no cluster."
        />
        <Stat
          frame={frame}
          start={14}
          index={2}
          label="Guard rail, in Terraform"
          value="$80 / month"
          note="AWS Budgets, alerting the owner at 50% of it. Three-day log retention, because CloudWatch is the bill nobody reads."
        />
        <Stat
          frame={frame}
          start={14}
          index={3}
          label="Cost of testing a connection (list price)"
          value="$0.01"
          note="One Cost Explorer GetDimensionValues call — the cheapest call that still returns evidence."
        />
      </div>

      <Caption frame={frame} start={34} tone="live">
        Bill and row counts read from the deployed database on {live.capturedAt.slice(0, 10)}; sizing
        and the budget from <span style={{ fontFamily: F.mono }}>terraform/</span>. The $0.01 is the
        published Cost Explorer price, not a measurement.
      </Caption>
    </Stage>
  );
};
