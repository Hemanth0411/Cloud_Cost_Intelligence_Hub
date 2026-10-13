/**
 * Capture stills of the RUNNING app for the video.
 *
 * Read-only against a dev server that is already up on port 3000 (the
 * only port in Cognito's callback list; mock mode is the default and
 * needs no backend). It signs in with the public demo credentials from
 * `frontend/src/lib/auth/constants.ts`, because every app route except
 * the auth pages is behind the session cookie.
 *
 * EVERY URL PINS `provider=aws`. The mock estate also carries Azure and
 * Google Cloud accounts; `backend/costhub/ingest/sources.py` has no
 * Google adapter at all, so a frame of this video showing Google Cloud
 * spend would promise something that raises NoAdapter. Filtering is
 * cheaper than cropping and it cannot slip.
 *
 *   node tools/shoot.mjs            # expects http://localhost:3000
 */
import { mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer';

const BASE = process.env.SHOOT_BASE ?? 'http://localhost:3000';
const OUT = new URL('../public/shots/', import.meta.url).pathname.replace(/^\//, '');
const EMAIL = 'admin@costhub.demo';
const PASSWORD = 'CostHub!2026';

const SHOTS = [
  { name: 'login', path: '/login?mock=1', wait: 1200 },
  { name: 'dashboard-aws', path: '/dashboard?mock=1&provider=aws&range=12m', wait: 3200 },
  { name: 'accounts-aws', path: '/accounts?mock=1&provider=aws&range=12m', wait: 2600 },
  { name: 'services-aws', path: '/services?mock=1&provider=aws&range=12m', wait: 2600 },
  { name: 'admin-users', path: '/admin/users?mock=1', wait: 2400 },
  { name: 'admin-audit', path: '/admin/audit?mock=1', wait: 2400 },
  { name: 'admin-connections', path: '/admin/connections?mock=1', wait: 2400 },
];

mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1.5 });

await page.goto(`${BASE}/login?mock=1`, { waitUntil: 'networkidle2' });
// `?mock=1` is read and stored by an effect, and the form only renders
// once the mode has resolved -- so wait for the field, do not assume it.
await page.waitForSelector('input[type="email"]', { timeout: 20000 });

// In mock mode the form arrives PREFILLED with the public demo
// credentials, so typing appends to them and the sign-in fails. Select
// the field first; retype anyway, so a change to those defaults shows
// up here as a failure rather than as a silent pass.
for (const [selector, value] of [
  ['input[type="email"]', EMAIL],
  ['input[type="password"]', PASSWORD],
]) {
  await page.click(selector, { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type(selector, value, { delay: 10 });
}
await page.click('button[type="submit"]');
await page
  .waitForFunction(() => !window.location.pathname.startsWith('/login'), { timeout: 20000 })
  .catch(() => {});
await new Promise((r) => setTimeout(r, 2500));
if (page.url().includes('/login')) {
  const message = await page
    .$eval('[role="alert"]', (el) => el.textContent?.trim())
    .catch(() => 'no alert on the page');
  throw new Error(`sign-in did not leave /login: ${message}`);
}
console.log('signed in at', page.url());

for (const shot of SHOTS) {
  await page.goto(`${BASE}${shot.path}`, { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, shot.wait));
  const file = `${OUT}${shot.name}.png`;
  await page.screenshot({ path: file });
  const title = await page.$eval('h1', (el) => el.textContent?.trim()).catch(() => '(no h1)');
  console.log(`${shot.name.padEnd(20)} ${page.url()}  h1=${title}`);
}

await browser.close();
