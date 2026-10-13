/**
 * The composition, and the scene timing table.
 *
 * Durations are whole half-bars at 100 BPM (36 frames), so every cut
 * lands on a beat of the synthesised bed in public/audio. Change a
 * duration and keep it a multiple of 36, or the cuts drift off the grid
 * and the video starts to feel loose for no visible reason.
 */
import React from 'react';
import { Audio, Composition, Sequence, staticFile } from 'remotion';
import { FPS, H, W, bars } from './theme';
import timing from './data/timing.json';
import { Fonts } from './fonts';
import { S01Hook } from './scenes/S01Hook';
import { S02Problem } from './scenes/S02Problem';
import { S03Product } from './scenes/S03Product';
import { S04Rbac } from './scenes/S04Rbac';
import { S05Predicate } from './scenes/S05Predicate';
import { S06Proof } from './scenes/S06Proof';
import { S07Cost } from './scenes/S07Cost';
import { S08Deploy } from './scenes/S08Deploy';
import { S09Scale } from './scenes/S09Scale';
import { S10Close } from './scenes/S10Close';


/**
 * Scene order and components. The LENGTHS live in data/timing.json,
 * which the audio generator reads too -- one file, so a re-timed scene
 * moves the beat grid with it.
 */
const COMPONENTS: Record<string, React.FC<{ duration: number }>> = {
  Hook: S01Hook,
  Problem: S02Problem,
  Product: S03Product,
  Rbac: S04Rbac,
  Predicate: S05Predicate,
  Proof: S06Proof,
  Cost: S07Cost,
  Deploy: S08Deploy,
  Scale: S09Scale,
  Close: S10Close,
};

export const SCENES = timing.scenes.map((s) => {
  const component = COMPONENTS[s.id];
  if (!component) throw new Error(`timing.json names a scene with no component: ${s.id}`);
  return { id: s.id, component, bars: s.bars };
});

const DURATIONS = SCENES.map((s) => bars(s.bars));
export const TOTAL = DURATIONS.reduce((a, b) => a + b, 0);

const Film: React.FC<{ withAudio?: boolean }> = ({ withAudio = true }) => {
  let at = 0;
  return (
    <>
      <Fonts />
      {withAudio ? <Audio src={staticFile('audio/bed.wav')} volume={1} /> : null}
      {SCENES.map((scene, i) => {
        const from = at;
        at += DURATIONS[i]!;
        const Scene = scene.component;
        return (
          <Sequence key={scene.id} from={from} durationInFrames={DURATIONS[i]!} name={scene.id}>
            <Scene duration={DURATIONS[i]!} />
          </Sequence>
        );
      })}
    </>
  );
};

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="Costhub"
      component={Film}
      durationInFrames={TOTAL}
      fps={FPS}
      width={W}
      height={H}
      defaultProps={{ withAudio: true }}
    />
    {/* Silent twin: renders without the audio tag, for frame review. */}
    <Composition
      id="CosthubSilent"
      component={Film}
      durationInFrames={TOTAL}
      fps={FPS}
      width={W}
      height={H}
      defaultProps={{ withAudio: false }}
    />
    {/* Each scene on its own, so one shot can be re-reviewed cheaply. */}
    {SCENES.map((scene) => (
      <Composition
        key={scene.id}
        id={`Scene${scene.id}`}
        component={scene.component}
        durationInFrames={bars(scene.bars)}
        fps={FPS}
        width={W}
        height={H}
        defaultProps={{ duration: bars(scene.bars) }}
      />
    ))}
  </>
);
