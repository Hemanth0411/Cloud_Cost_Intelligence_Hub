import React from 'react';
import { useCurrentFrame } from 'remotion';
import { Caption, Eyebrow, Headline, Pill, Stage } from '../components/chrome';
import { BarsKeyed } from '../components/data';
import mock from '../data/mock.json';
import { C, F } from '../theme';
import { compactUsd, COUNT, ease, enter, LIVELY, springs, usd } from '../anim';

/**
 * Scene 4 -- the differentiator, shown rather than described.
 *
 * ONE panel, not two side by side, and the grant is applied mid-shot:
 * the four accounts the user was not granted collapse to zero and the
 * total follows them down. Two static panels would let a viewer assume
 * two different screens; one panel changing makes it the same screen
 * under a different identity.
 *
 * The collapse is the sum-of-springs case from anim.ts -- the bars are
 * still settling from their entrance when the target changes, and they
 * have to bend, not jump.
 */
const GRANT_AT = 108;

export const S4Who: React.FC = () => {
  const frame = useCurrentFrame();
  const accounts = mock.all.accounts;
  const grantedId = mock.granted.accountId;
  const max = Math.max(...accounts.map((a) => a.cost));

  const bars = accounts.map((a, i) => {
    const kept = a.id === grantedId;
    const appear = 18 + i * 3;
    return {
      label: a.name,
      keys: [
        { at: appear, value: 0 },
        { at: appear, value: a.cost },
        ...(kept ? [] : [{ at: GRANT_AT + i * 2, value: 0 }]),
      ],
      dimAt: kept ? undefined : GRANT_AT + i * 2,
      dimNote: 'not granted',
    };
  });

  // The swap is a value, not a branch: the two identity lines cross-fade
  // and slide past each other, so the CAUSE is visible and not just its
  // effect on the numbers.
  const swap = ease(frame, GRANT_AT, LIVELY);
  return (
    <Stage>
      <Eyebrow frame={frame}>Who sees what</Eyebrow>
      <Headline frame={frame} size={70}>
        The same screen. A different identity.
      </Headline>

      <div style={{ position: 'relative', height: 64, marginTop: 38, ...enter(frame, 12) }}>
        <Identity
          frame={frame}
          shown={1 - swap}
          offset={-swap * 26}
          email="hemanth.reddy@chryselys.com"
          pill="superadmin"
          pillColor={C.ateneo}
          note="every account, and the bypass is logged"
        />
        <Identity
          frame={frame}
          shown={swap}
          offset={(1 - swap) * 26}
          email="finance.lead@chryselys.com"
          pill={`1 grant: ${mock.granted.accountName}`}
          pillColor={C.bronze}
          note="one account, every service in it"
        />
      </div>

      <div style={{ display: 'flex', gap: 70, marginTop: 36, alignItems: 'flex-start' }}>
        <BarsKeyed
          frame={frame}
          bars={bars}
          scaleMax={max}
          width={1080}
          format={compactUsd}
          rowHeight={62}
          labelWidth={330}
        />
        <div style={{ paddingTop: 10 }}>
          <div
            style={{
              fontFamily: F.mono,
              fontSize: 24,
              letterSpacing: 1.8,
              textTransform: 'uppercase',
              color: C.slate,
            }}
          >
            Visible spend
          </div>
          <VisibleSpend frame={frame} />
        </div>
      </div>

      <Caption frame={frame} start={16}>
        Sample estate. The narrowing is done in the database query itself, not in the screen —
        a user with no grant gets an empty dashboard by design.
      </Caption>
    </Stage>
  );
};

/**
 * Visible spend and the account count, both keyframed.
 *
 * Conditional values would CUT when the grant lands, and a cut in a
 * number is indistinguishable from a glitch. Keyframed, they fall --
 * which is also the honest picture of what a grant does.
 */
const VisibleSpend: React.FC<{ frame: number }> = ({ frame }) => {
  const shownTotal = springs(
    frame,
    [
      { at: 18, value: 0 },
      { at: 18, value: mock.all.total },
      { at: GRANT_AT, value: mock.granted.total },
    ],
    COUNT,
  );
  // Counted DOWN only. An earlier version sprang this up from zero with
  // the money, so for half a second the superadmin panel read "3 of 5
  // accounts visible" -- a sentence the scene exists to contradict.
  const shownAccounts = springs(frame, [
    { at: 0, value: mock.all.accounts.length },
    { at: GRANT_AT, value: 1 },
  ]);
  return (
    <>
      <div
        style={{
          fontFamily: F.slab,
          fontWeight: 700,
          fontSize: 76,
          color: C.ateneo,
          letterSpacing: -1.5,
          lineHeight: 1.1,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {usd(shownTotal)}
      </div>
      <div style={{ fontSize: 30, color: C.slate, paddingTop: 10 }}>
        {Math.round(shownAccounts)} of {mock.all.accounts.length} accounts visible
      </div>
      <div
        style={{
          fontSize: 28,
          color: C.slate,
          paddingTop: 22,
          maxWidth: 420,
          lineHeight: 1.4,
          opacity: ease(frame, GRANT_AT + 14),
        }}
      >
        Four accounts did not disappear from the UI. The database never returned them.
      </div>
    </>
  );
};

/** One identity line. Two of these cross-fade when the grant lands. */
const Identity: React.FC<{
  frame: number;
  shown: number;
  offset: number;
  email: string;
  pill: string;
  pillColor: string;
  note: string;
}> = ({ shown, offset, email, pill, pillColor, note }) => (
  <div
    style={{
      position: 'absolute',
      inset: 0,
      display: 'flex',
      alignItems: 'center',
      gap: 24,
      opacity: shown,
      transform: `translateY(${offset.toFixed(2)}px)`,
    }}
  >
    <span style={{ fontFamily: F.mono, fontSize: 32, color: C.ateneo }}>{email}</span>
    <Pill color={pillColor}>{pill}</Pill>
    <span style={{ fontSize: 28, color: C.slate }}>{note}</span>
  </div>
);
