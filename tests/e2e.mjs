/**
 * Core Breaker — end-to-end QA playthrough (dev only, not shipped).
 *
 * Drives the REAL visible UI in headless Chrome (playwright-core + system
 * Chrome): title → settings/help → journey grid → stage 1 win via held
 * Space / held HOLD button → results with server-validated score →
 * next stage with pause/settings/resume → practice round with hint-driven
 * hold/release dodging + undo → daily & score screens. Runs the whole flow
 * twice: desktop 1280×800 and a fresh mobile context 390×844 (hasTouch).
 *
 * The game is fully offline-capable; this test serves it with the repo's
 * own server.js (static files + /api/v1 score API) on an ephemeral port,
 * with the score store redirected to a temp file (CB_SCORES_FILE).
 *
 * Synchronization reads only what a player sees (HUD/hintbar DOM) plus
 * localStorage progress; every action goes through real UI interaction.
 * Exits non-zero on any failure or non-benign console/page error.
 */
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';

const require = createRequire(import.meta.url);
process.env.CB_SCORES_FILE = `/tmp/cb-e2e-scores-${process.pid}.json`;
const { server } = require('../server.js');

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const BASE = `http://127.0.0.1:${server.address().port}/`;

// benign GPU/swiftshader noise, same regex as tools/production_game_audit.mjs
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions/i;

const SHOT = (stage, tag) => `/tmp/core-breaker-e2e-${stage}-${tag}.png`;

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
});

async function runPass(tag, contextOpts, inputMode) {
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();
  // hold controls routed through the real UI: Space key, or pointer hold
  // on the on-screen HOLD TO DIVE button
  const drive = inputMode === 'keyboard'
    ? { down: () => page.keyboard.down('Space'), up: () => page.keyboard.up('Space') }
    : {
        down: async () => {
          const box = await page.locator('#btn-hold').boundingBox();
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.down();
        },
        up: () => page.mouse.up(),
      };
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !browserNoise.test(m.text())) errors.push(`console: ${m.text()}`);
  });

  const step = async (name, fn) => {
    await fn();
    console.log(`ok - [${tag}] ${name}`);
  };
  const visible = (sel) => page.waitForSelector(`${sel}:visible`, { timeout: 10000 });
  const click = (sel) => (contextOpts.hasTouch ? page.tap(sel) : page.click(sel));

  let held = false;
  const holdDown = async () => { if (!held) { await drive.down(); held = true; } };
  const holdUp = async () => { if (held) { await drive.up(); held = false; } };

  // Play a round until the results overlay, dodging armor per the hintbar.
  // The hintbar is the on-screen hint UI (hints enabled in these modes).
  async function playUntilResults(maxMs) {
    await page.waitForFunction(() => {
      const t = document.getElementById('hintbar').textContent;
      return t !== '3' && t !== '2' && t !== '1';
    }, null, { timeout: 8000 });
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      if (await page.locator('#overlay-results:visible').count()) {
        await drive.up(); held = false; // physically release for the next round
        return;
      }
      const hint = (await page.locator('#hintbar').textContent()) || '';
      if (/ARMOR — release/.test(hint)) await holdUp();
      else if (/safe crystal|SAFE \(bright\)|gap — fall through|OVERDRIVE READY/.test(hint)) await holdDown();
      await page.waitForTimeout(50);
    }
    throw new Error(`round did not reach results within ${maxMs}ms`);
  }

  async function resultsInfo() {
    await visible('#overlay-results');
    const headline = (await page.textContent('#res-headline')).trim();
    const rows = await page.locator('#res-breakdown tr').count();
    return { headline, rows };
  }

  try {
    await step('load + title visible, WebGL available', async () => {
      await page.goto(BASE, { waitUntil: 'load' });
      await visible('#screen-title');
      const compat = await page.textContent('#title-compat');
      if (compat.trim()) throw new Error('compat banner shown: ' + compat);
      await page.screenshot({ path: SHOT('title', tag) });
    });

    await step('settings open/apply/close', async () => {
      await click('#btn-settings');
      await visible('#overlay-settings');
      await page.check('#set-contrast');
      await page.check('#set-motion');
      await page.selectOption('#set-quality', 'high');
      await page.waitForFunction(() => document.body.classList.contains('high-contrast'));
      await page.screenshot({ path: SHOT('settings', tag) });
      await click('#btn-settings-close');
      await page.waitForSelector('#overlay-settings', { state: 'hidden' });
    });

    await step('help open/close', async () => {
      await click('#btn-help');
      await visible('#overlay-help');
      if (await page.locator('#help-cards p').count() < 3) throw new Error('help cards missing');
      await click('#btn-help-close');
      await page.waitForSelector('#overlay-help', { state: 'hidden' });
    });

    await step('learn: title button opens the next lesson', async () => {
      await click('#btn-learn');
      await visible('#overlay-intro');
      if (!/Hold to smash/.test(await page.textContent('#intro-h'))) {
        throw new Error('learn did not open the first lesson');
      }
      await click('#btn-intro-cancel');
      await page.waitForSelector('#overlay-intro', { state: 'hidden' });
    });

    await step('journey grid: 40 stages, only stage 1 unlocked', async () => {
      await click('#btn-journey');
      await visible('#screen-journey');
      const cells = await page.locator('#journey-grid button').count();
      if (cells !== 40) throw new Error(`expected 40 stages, got ${cells}`);
      const unlocked = await page.locator('#journey-grid button:not([disabled])').count();
      if (unlocked !== 1) throw new Error(`expected 1 unlocked stage, got ${unlocked}`);
      await page.screenshot({ path: SHOT('journey', tag) });
    });

    await step('stage 1: intro → countdown → hold to core → results', async () => {
      await page.locator('#journey-grid button').first().click();
      await visible('#overlay-intro');
      if (!/First Descent/.test(await page.textContent('#intro-h'))) throw new Error('wrong intro');
      await click('#btn-intro-start');
      await visible('#hud');
      await playUntilResults(30000);
      const { headline, rows } = await resultsInfo();
      console.log(`  headline: ${headline} (${rows} breakdown rows)`);
      if (headline !== 'Core Reached!') throw new Error('stage 1 not won: ' + headline);
      if (rows < 6) throw new Error(`expected win breakdown rows, got ${rows}`);
      await page.waitForFunction(
        () => /server validated/.test(document.getElementById('res-replay').textContent),
        null, { timeout: 5000 });
      await page.screenshot({ path: SHOT('results', tag) });
    });

    await step('progression persisted (j01 stars in localStorage)', async () => {
      const wrap = await page.evaluate(() => JSON.parse(localStorage.getItem('corebreaker.progress.v1')));
      const stars = wrap?.data?.journey?.j01?.stars || 0;
      if (stars < 1) throw new Error('j01 stars not persisted');
      console.log(`  j01 stars: ${stars}, rounds: ${wrap.data.totals.rounds}`);
    });

    await step('next stage → undo rewind → pause → settings → resume → win', async () => {
      await click('#btn-next');
      await visible('#overlay-intro');
      if (!/Crystal Veins/.test(await page.textContent('#intro-h'))) throw new Error('wrong next stage');
      await click('#btn-intro-start');
      await visible('#hud');
      await page.waitForFunction(() => {
        const t = document.getElementById('hintbar').textContent;
        return t !== '3' && t !== '2' && t !== '1';
      }, null, { timeout: 8000 });
      // stage 2 has no armor: dive, release (banks a rewind point), dive on,
      // then rewind via the on-screen Undo button and verify the HUD reverts
      await page.waitForFunction( // fresh HUD for this round (stage 1 text is stale)
        () => document.getElementById('hud-depth').textContent === '0/7', null, { timeout: 8000 });
      await holdDown();
      await page.waitForFunction(() => {
        return document.getElementById('hud-depth').textContent !== '0/7';
      }, null, { timeout: 10000 });
      await holdUp(); // release banks the rewind point here
      const relDepth = await page.textContent('#hud-depth');
      await holdDown();
      await page.waitForFunction(
        (d) => document.getElementById('hud-depth').textContent !== d, relDepth, { timeout: 8000 });
      const grewDepth = await page.textContent('#hud-depth');
      await click('#btn-hud-undo'); // undo while still diving
      await drive.up(); held = false; // undo rewinds to a non-holding state
      await page.waitForSelector('#btn-hud-undo[disabled]', { timeout: 3000 });
      const undoneDepth = await page.textContent('#hud-depth');
      console.log(`  undo: release at ${relDepth}, grew to ${grewDepth}, rewound to ${undoneDepth}`);
      if (undoneDepth !== relDepth) throw new Error(`undo did not rewind to release: ${undoneDepth} != ${relDepth}`);
      await page.screenshot({ path: SHOT('undo', tag) });
      // The achievement toast sits over the top-center strip (z-index 60) but
      // is pointer-events:none and re-hides after fading, so the HUD pause
      // button stays tappable underneath it on mobile too.
      await click('#btn-hud-pause');
      await visible('#overlay-pause');
      await page.screenshot({ path: SHOT('pause', tag) });
      await click('#btn-pause-settings');
      await visible('#overlay-settings');
      await click('#btn-settings-close');
      await visible('#overlay-pause');
      await click('#btn-resume');
      await page.waitForSelector('#overlay-pause', { state: 'hidden' });
      await playUntilResults(30000);
      const { headline } = await resultsInfo();
      console.log(`  stage 2 headline: ${headline}`);
      if (headline !== 'Core Reached!') throw new Error('stage 2 not won: ' + headline);
      await click('#btn-res-exit');
      await visible('#screen-title');
    });

    await step('practice Calm: hint-driven armor dodging to terminal results', async () => {
      await click('#btn-practice');
      await visible('#screen-practice');
      await page.locator('#practice-list button').first().click();
      await visible('#overlay-intro');
      await click('#btn-intro-start');
      await visible('#hud');
      await playUntilResults(90000);
      const { headline, rows } = await resultsInfo();
      console.log(`  practice headline: ${headline} (${rows} rows)`);
      if (rows < 4) throw new Error(`expected breakdown rows, got ${rows}`);
      await page.screenshot({ path: SHOT('practice-results', tag) });
      await click('#btn-res-exit');
      await visible('#screen-title');
    });

    await step('daily + score-chase screens reachable', async () => {
      await click('#btn-daily');
      await visible('#screen-daily');
      if (!/\d{4}-\d{2}-\d{2}/.test(await page.textContent('#daily-info'))) {
        throw new Error('daily info missing date');
      }
      await page.screenshot({ path: SHOT('daily', tag) });
      await page.locator('#screen-daily [data-back]').click();
      await click('#btn-score');
      await visible('#screen-score');
      if (!/Endless/.test(await page.textContent('#score-h'))) throw new Error('score screen wrong');
      await page.locator('#screen-score [data-back]').click();
      await visible('#screen-title');
    });

    await step('hold button usable size', async () => {
      await click('#btn-journey');
      await page.locator('#journey-grid button:not([disabled])').first().click();
      await visible('#overlay-intro');
      await click('#btn-intro-start');
      await visible('#btn-hold');
      const box = await page.locator('#btn-hold').boundingBox();
      if (box.width < 44 || box.height < 44) {
        throw new Error(`hold target too small: ${box.width}x${box.height}`);
      }
      console.log(`  hold button: ${Math.round(box.width)}x${Math.round(box.height)}`);
      await page.screenshot({ path: SHOT('play', tag) });
      await holdUp();
      await click('#btn-hud-pause');
      await visible('#overlay-pause');
      await click('#btn-quit');
      await visible('#screen-title');
    });

    if (errors.length) throw new Error('page errors:\n' + errors.join('\n'));
  } finally {
    await holdUp().catch(() => {});
    await context.close();
  }
}

try {
  await runPass('desktop', { viewport: { width: 1280, height: 800 } }, 'keyboard');
  console.log('ok - desktop pass complete');
  await runPass('mobile', { viewport: { width: 390, height: 844 }, hasTouch: true }, 'touch');
  console.log('ok - mobile pass complete');
  console.log('\nE2E PASS — core-breaker playable end-to-end on desktop and mobile, no page errors');
} finally {
  await browser.close();
  server.close();
}
