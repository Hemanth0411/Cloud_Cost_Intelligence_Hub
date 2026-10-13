/**
 * Remotion render config.
 *
 * No GPU on this machine, so the compositions are rendered with
 * `--gl=swangle` from the CLI (see package.json). JPEG frames keep the
 * software-rendered pass cheap; nothing here has a transparent pixel.
 */
import { Config } from '@remotion/cli/config';

Config.setVideoImageFormat('jpeg');
Config.setJpegQuality(92);
Config.setOverwriteOutput(true);
Config.setChromiumOpenGlRenderer('swangle');
