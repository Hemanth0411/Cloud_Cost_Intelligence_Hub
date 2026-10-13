import React from 'react';
import { useCurrentFrame } from 'remotion';
import { Caption, Eyebrow, Headline, Stage } from '../components/chrome';
import { Code, Stat } from '../components/data';
import { C, F } from '../theme';
import { enter } from '../anim';

/**
 * Scene 6 -- cost and upkeep, in words rather than a spreadsheet.
 *
 * NO DOLLAR FIGURE. An earlier version led with "$0", which is true
 * (the account is new and these services are free-tier eligible) and
 * reads as a toy rather than as a cheap system. The durable point is
 * the shape: it reports its own spend in the same dashboard as
 * everything else, so the running cost cannot quietly become somebody
 * else's problem.
 */
const STEPS = ['$ ./do.sh up dev', '  build  ->  apply  ->  migrate  ->  done'];

export const S6Run: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <Stage>
      <Eyebrow frame={frame}>Running it</Eyebrow>
      <Headline frame={frame} size={70}>
        One command up. Nothing to patch.
      </Headline>

      <div style={{ marginTop: 40 }}>
        <Code frame={frame} start={12} lines={STEPS} size={30} width={980} />
      </div>

      <div style={{ display: 'flex', gap: 90, marginTop: 48, maxWidth: 1640 }}>
        <Stat
          frame={frame}
          start={20}
          index={0}
          label="Its own running cost"
          value="On the same screen"
          note="The first account CostHub reads is the one it runs in, so what it costs to operate shows up beside everything else, with a budget alarm on it."
        />
        <Stat
          frame={frame}
          start={20}
          index={1}
          label="Small on purpose"
          value="No servers"
          note="One small database and a handful of functions that wake on a schedule. Nothing to keep patched between demos."
        />
        <Stat
          frame={frame}
          start={20}
          index={2}
          label="Another environment"
          value="One more file"
          note="Everything is Terraform, so a second environment is a variables file rather than an afternoon."
        />
      </div>

      <Caption frame={frame} start={32} tone="live">
        <span style={{ fontFamily: F.mono }}>do.sh</span> builds, applies, migrates and writes the
        app&rsquo;s configuration in one run.
      </Caption>
    </Stage>
  );
};
