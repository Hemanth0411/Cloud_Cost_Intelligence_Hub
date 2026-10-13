import React from 'react';
import { useCurrentFrame } from 'remotion';
import { Caption, Eyebrow, Headline, Stage } from '../components/chrome';
import { Code, Stat } from '../components/data';
import { C, F } from '../theme';
import { enter } from '../anim';

/**
 * Scene 8 -- deploying and keeping it alive.
 *
 * The step list is the body of `cmd_up` in `do.sh`, in order. The
 * resource count is `terraform state list | wc -l` on 2026-10-13. The
 * test claim is the specific one that can be checked: an AST walk that
 * fails if any module other than scoped.py reads the fact table.
 */
const STEPS = [
  '$ export AWS_PROFILE=costhub',
  '$ ./do.sh up dev',
  '  -> build      package the Lambda zip',
  '  -> apply      terraform apply -var-file=env/dev.tfvars',
  '  -> branding   style the Cognito login page',
  '  -> migrate    apply 7 numbered SQL files',
  '  -> outputs    write frontend/.env.local',
];

export const S08Deploy: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <Stage>
      <Eyebrow frame={frame}>Deploy and maintain</Eyebrow>
      <Headline frame={frame} size={68}>
        One command stands the whole thing up.
      </Headline>

      <div style={{ display: 'flex', gap: 50, marginTop: 44, alignItems: 'flex-start' }}>
        <Code frame={frame} start={12} lines={STEPS} size={23} width={860} />
        <div style={{ display: 'grid', rowGap: 36, flex: 1 }}>
          <Stat
            frame={frame}
            start={22}
            index={0}
            label="In state, one environment"
            value="57 resources"
            note="14 Terraform files, no modules to chase. One more environment is one more tfvars file."
          />
          <Stat
            frame={frame}
            start={22}
            index={1}
            label="The guard that matters"
            value="A test reads the SQL"
            note="It parses every module and fails if a SELECT from fact_cost_daily turns up outside query/scoped.py and the ingest writer. The RBAC claim cannot rot quietly."
          />
          <Stat
            frame={frame}
            start={22}
            index={2}
            label="Nothing to patch"
            value="No servers"
            note="Lambda, EventBridge schedules, RDS, Amplify. The scheduled jobs are three cron rules, independently retryable."
          />
        </div>
      </div>

      <Caption frame={frame} start={38} tone="live">
        <span style={{ fontFamily: F.mono }}>terraform state list</span> on 2026-10-13: 57 resources.
        Backend suite that day, run locally: 174 passed, 2 failed &mdash; a dropped database
        connection, and two files over the 300-line limit.
      </Caption>
    </Stage>
  );
};
