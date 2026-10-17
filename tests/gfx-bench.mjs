// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in the real Settings
// overlay, starts Journey stage 1 and dives with the visible hold control (Space on desktop, the Hold
// button on mobile) following the on-screen hint bar, so segments shatter, shards burst, motes rise and
// the post chain runs; from the results overlay it retries the stage.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

export async function setPreset(page, preset) {
  await page.waitForSelector('#screen-title:visible', { timeout: 20000 });
  await page.click('#btn-settings');
  await page.waitForSelector('#overlay-settings:visible');
  await page.locator('#gfx-section').scrollIntoViewIfNeeded();
  await page.selectOption('#set-quality', preset);
  await page.waitForFunction((p) => document.body.dataset.gfxPreset === p, preset);
  await page.click('#btn-settings-close');
}

export async function start(page, { mobile } = {}) {
  await page.click('#btn-journey');
  await page.waitForSelector('#screen-journey:visible');
  await page.locator('#journey-grid button').first().click();
  await page.waitForSelector('#overlay-intro:visible');
  await page.click('#btn-intro-start');
  await page.waitForSelector('#hud:visible');
  let held = false;
  const down = async () => {
    if (held) return;
    if (mobile) {
      const box = await page.locator('#btn-hold').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
    } else await page.keyboard.down('Space');
    held = true;
  };
  const up = async () => { if (!held) return; if (mobile) await page.mouse.up(); else await page.keyboard.up('Space'); held = false; };
  let open = true;
  page.once('close', () => { open = false; });
  (async () => {
    while (open) {
      try {
        if (await page.locator('#overlay-results:visible').count()) {
          await up();
          await page.click(await page.locator('#btn-retry:visible').count() ? '#btn-retry' : '#btn-next', { timeout: 5000 });
          if (await page.locator('#overlay-intro:visible').count()) await page.click('#btn-intro-start', { timeout: 5000 });
        } else {
          const hint = (await page.locator('#hintbar').textContent()) || '';
          if (/ARMOR — release/.test(hint)) await up();
          else if (/safe crystal|SAFE \(bright\)|gap — fall through|OVERDRIVE READY/.test(hint)) await down();
        }
        await page.waitForTimeout(50);
      } catch (e) { if (!open) return; if (process.env.BENCH_DEBUG) console.error(e.message); }
    }
  })();
  await page.waitForTimeout(3500); // countdown
}
