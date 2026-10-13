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

/**
 * Use an installed Chrome instead of Remotion's own download.
 *
 * WHY: on this machine `remotion render` downloads
 * chrome-headless-shell-win64.zip (108 MB), reports "Got Headless
 * Shell", extracts exactly two of its 290 entries (ABOUT and
 * LICENSE.headless_shell -- no .exe), and then exits 0 having rendered
 * nothing. Re-running re-downloads and wipes a manual extraction, so
 * unzipping it by hand does not stick either. Pointing at the installed
 * browser skips the whole path.
 *
 * Override with REMOTION_BROWSER if Chrome lives somewhere else; the
 * CLI flag is --browser-executable.
 */
// Unzipping the downloaded shell by hand does NOT stick: the next
// render re-downloads and overwrites it with the same two files. So the
// installed Chrome is the only working path here.
//
// It has one failure mode worth knowing: if the browser is busy, the
// launch hands off to the running instance instead of opening a
// debugging port, and the render dies with "Timed out after 25000 ms
// while trying to connect to the browser" and an EMPTY Chrome log.
// Re-run; it is not a code failure.
Config.setBrowserExecutable(
  process.env.REMOTION_BROWSER ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
);
