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
import { S1What } from './scenes/S1What';
import { S2Why } from './scenes/S2Why';
import { S3See } from './scenes/S3See';
import { S4Who } from './scenes/S4Who';
import { S5Real } from './scenes/S5Real';
import { S6Run } from './scenes/S6Run';
import { S7Next } from './scenes/S7Next';
import { S8Close } from './scenes/S8Close';

/**
 * Scene order and components. The LENGTHS live in data/timing.json,
 * which the audio generator reads too -- one file, so a re-timed scene
 * moves the beat grid with it.
 */
const COMPONENTS: Record<string, React.FC> = {
  What: S1What,
  Why: S2Why,
  See: S3See,
  Who: S4Who,
  Real: S5Real,
  Run: S6Run,
  Next: S7Next,
  Close: S8Close,
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
            <Scene />
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
      />
    ))}
  </>
);
