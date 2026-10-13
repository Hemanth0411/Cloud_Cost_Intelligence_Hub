import React from 'react';
import { useCurrentFrame } from 'remotion';
import { Caption, Eyebrow, Headline, Stage } from '../components/chrome';
import { Code } from '../components/data';
import rbac from '../data/rbac.json';
import { C, F } from '../theme';
import { ease, enter, sceneFade, springs } from '../anim';

/**
 * Scene 5 -- the narrowing, measured.
 *
 * Left: GRANT_PREDICATE, copied out of `costhub/query/scoped.py` by
 * `tools/rbac-proof.py` rather than retyped, so the SQL on screen is
 * the SQL that ships.
 *
 * Right: that predicate run against the DEPLOYED database as five
 * principals. The row counts are measured, not illustrative. The two
 * test principals were created inside a transaction that was rolled
 * back, which is why the caption can say the database is unchanged.
 */
/**
 * The predicate text itself, as captured from the module -- not
 * retyped. `tools/rbac-proof.py` writes `GRANT_PREDICATE` into
 * rbac.json, so if the shipped SQL changes, this scene changes with it.
 */
const LINES = rbac.predicate.trim().split(/\r?\n/);
const HIGHLIGHT = LINES.map((l, i) => (/revoked_at|service_name|valid_until/.test(l) ? i : -1)).filter(
  (i) => i >= 0,
);

export const S05Predicate: React.FC<{ duration: number }> = ({ duration }) => {
  const frame = useCurrentFrame();
  const cases = rbac.cases;
  const maxRows = Math.max(...cases.map((c) => c.rows));
  return (
    <Stage opacity={sceneFade(frame, duration, 6, 6)}>
      <Eyebrow frame={frame}>Enforced in SQL</Eyebrow>
      <Headline frame={frame} size={66}>
        One module reads the cost table. It always adds this.
      </Headline>

      <div style={{ display: 'flex', gap: 48, marginTop: 40 }}>
        <div style={{ width: 820 }}>
          <Code frame={frame} start={14} lines={LINES} highlight={HIGHLIGHT} size={22} />
          <div style={{ ...enter(frame, 34), fontSize: 26, color: C.slate, marginTop: 20 }}>
            <span style={{ fontFamily: F.mono }}>costhub/query/scoped.py</span> &mdash; a test walks
            the AST and fails if anything else touches{' '}
            <span style={{ fontFamily: F.mono }}>fact_cost_daily</span>.
          </div>
        </div>

        <div style={{ flex: 1 }}>
          <div
            style={{
              ...enter(frame, 30),
              fontFamily: F.mono,
              fontSize: 24,
              letterSpacing: 1.6,
              textTransform: 'uppercase',
              color: C.slate,
              marginBottom: 18,
            }}
          >
            Rows returned, deployed database
          </div>
          {cases.map((c, i) => {
            const start = 36 + i * 7;
            const width = springs(frame, [
              { at: start, value: 0 },
              { at: start, value: (c.rows / maxRows) * 300 },
            ]);
            const shown = Math.round(
              springs(frame, [
                { at: start, value: 0 },
                { at: start, value: c.rows },
              ]),
            );
            return (
              <div
                key={c.label}
                style={{
                  ...enter(frame, start, 0, 0),
                  display: 'flex',
                  alignItems: 'center',
                  gap: 20,
                  marginBottom: 18,
                }}
              >
                <span style={{ width: 340, fontSize: 25, color: C.ink, lineHeight: 1.25 }}>
                  {c.label}
                </span>
                <span
                  style={{
                    width: 300,
                    height: 22,
                    backgroundColor: C.muted,
                    borderRadius: 4,
                    overflow: 'hidden',
                  }}
                >
                  <span
                    style={{
                      display: 'block',
                      height: '100%',
                      width,
                      backgroundColor: c.rows === 0 ? C.destructive : C.bronze,
                    }}
                  />
                </span>
                <span
                  style={{
                    width: 140,
                    fontFamily: F.mono,
                    fontSize: 26,
                    color: c.rows === 0 ? C.destructive : C.ateneo,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {shown} {shown === 1 ? 'row' : 'rows'}
                </span>
              </div>
            );
          })}
          <div
            style={{
              opacity: ease(frame, 82),
              fontSize: 28,
              color: C.ateneo,
              fontFamily: F.slab,
              fontWeight: 600,
              marginTop: 10,
            }}
          >
            Revoke takes effect on the next query. No grant means no rows.
          </div>
        </div>
      </div>

      <Caption frame={frame} start={40} tone="live">
        Measured {rbac.capturedAt.slice(0, 10)} against RDS. The two test principals were created in
        a transaction that was rolled back &mdash; users {rbac.rolledBack.usersBefore} before,{' '}
        {rbac.rolledBack.usersAfter} after.
      </Caption>
    </Stage>
  );
};
