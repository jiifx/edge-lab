// Perf + presets test: drag bursts must not block; account chips; save/delete custom preset.
const puppeteer = require('puppeteer-core');
const path = require('path');
const APP = 'file:///' + path.resolve(__dirname, '../dist/PropEdgeLab2.html').replace(/\\/g, '/');
function fail(m){ console.error('FAIL: ' + m); process.exitCode = 1; }
(async () => {
  const browser = await puppeteer.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: 'new', userDataDir: path.resolve('./pel-test/profile-perf-' + Date.now()), args: ['--no-sandbox','--disable-gpu','--allow-file-access-from-files', '--edge-skip-compat-layer-relaunch'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  page.on('pageerror', e => fail('pageerror: ' + e.message));
  // installed BEFORE the first byte, so the cold-start render is measured too -
  // that is where the 2.11.0 drawdown estimator did its 356ms of un-sliced work,
  // and an observer created after load would have missed exactly that
  await page.evaluateOnNewDocument(() => {
    window.__LONG = [];
    try {
      new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__LONG.push(Math.round(e.duration))))
        .observe({ entryTypes: ['longtask'] });
    } catch (e) { /* unsupported: the budget check below then trivially passes */ }
  });
  await page.goto(APP, { waitUntil: 'load' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 15000 });
  await new Promise(r => setTimeout(r, 9000));
  {
    const L = await page.evaluate(() => window.__LONG || []);
    const worst = L.length ? Math.max(...L) : 0;
    if (worst > 250) fail('cold start blocked the main thread for ' + worst + 'ms - something heavy is not going through runJob');
    else console.log('ok: cold start worst task ' + worst + 'ms (' + L.length + ' long tasks)');
  }
  await page.click('[data-tab="challenge"]');
  await new Promise(r => setTimeout(r, 500));

  // 1) drag burst: 30 rapid inputs on the risk slider - the loop itself must return fast
  const burstMs = await page.evaluate(() => {
    const s = document.getElementById('src');
    const t0 = performance.now();
    for (let i = 0; i < 30; i++) {
      s.value = String(0.5 + (i % 20) * 0.1);
      s.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return performance.now() - t0;
  });
  console.log('30-input drag burst dispatched in ' + burstMs.toFixed(0) + 'ms');
  if (burstMs > 400) fail('drag burst blocked the main thread: ' + burstMs + 'ms'); else console.log('ok: drag stays responsive (renders coalesced)');
  await new Promise(r => setTimeout(r, 600)); // full-quality render lands
  const pass = await page.$eval('#cPass', e => e.textContent);
  if (!/\d+%/.test(pass)) fail('pass% missing after burst'); else console.log('ok: full-quality render landed: ' + pass.slice(0, 12));

  // 2) account chips
  await page.click('#firmToggle');
  await page.click('#accChips .opt[data-acc="25000"]');
  const acc = await page.$eval('#fAccount', e => e.value);
  const sum = await page.$eval('#firmSum', e => e.textContent);
  if (acc !== '25000') fail('chip did not set account: ' + acc);
  else if (!sum.includes('25,000')) fail('firm summary not updated: ' + sum);
  else console.log('ok: $25k account chip works');
  const pressed = await page.$eval('#accChips .opt[data-acc="25000"]', e => e.getAttribute('aria-pressed'));
  if (pressed !== 'true') fail('chip not highlighted'); else console.log('ok: chip highlighted');

  // 3) save custom preset
  await page.click('#fSavePreset');
  await page.waitForFunction('!document.getElementById("askOv").classList.contains("hide")', { timeout: 3000 });
  await page.evaluate(() => { const i = document.getElementById('presetName'); i.value = 'My 25k test'; });
  const btns = await page.$$('#askBtns button');
  await btns[btns.length - 1].click(); // Save
  await new Promise(r => setTimeout(r, 300));
  const selVal = await page.$eval('#fPreset', e => e.value);
  if (selVal !== 'c:My 25k test') fail('preset not selected after save: ' + selVal); else console.log('ok: custom preset saved + selected');

  // persists across reload
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 15000 });
  const opts = await page.$$eval('#fPreset option', els => els.map(e => e.value));
  if (!opts.includes('c:My 25k test')) fail('custom preset lost after reload'); else console.log('ok: custom preset persists');

  // delete
  await page.click('#firmToggle');
  await page.select('#fPreset', 'c:My 25k test');
  await new Promise(r => setTimeout(r, 300));
  const delVisible = await page.$eval('#fDelPreset', e => !e.classList.contains('hide'));
  if (!delVisible) fail('delete button not visible for custom preset');
  await page.click('#fDelPreset');
  await page.waitForFunction('!document.getElementById("askOv").classList.contains("hide")', { timeout: 3000 });
  const btns2 = await page.$$('#askBtns button');
  await btns2[btns2.length - 1].click();
  await new Promise(r => setTimeout(r, 300));
  const opts2 = await page.$$eval('#fPreset option', els => els.map(e => e.value));
  if (opts2.includes('c:My 25k test')) fail('preset not deleted'); else console.log('ok: preset deleted');

  // ---- LONG-TASK BUDGET: nobody may hold the main thread ----
  //
  // This is the guard that was missing when the 2.11.0 drawdown estimator
  // shipped. It was chunked in the sense of "runs from a setTimeout", which is
  // not the same as small: it did ~24 million walk steps in ONE macrotask, and
  // stacked with the edge band and the plan builder the app became unclickable -
  // a user could not press a tab. Chunking is now a shared sliced queue
  // (runJob in util.ts), and this asserts the result rather than the intention.
  //
  // 250ms is deliberately loose: it is well under the 800ms macux already
  // allows, but tight enough that any single un-sliced Monte Carlo trips it.
  const BUDGET = 250;
  for (const tab of ['validate', 'challenge', 'funded', 'decision']) {
    await page.evaluate((t) => {
      window.__LONG = [];
      document.querySelector('[data-tab="' + t + '"]').click();
    }, tab);
    // long enough for every deferred job on the tab to finish
    await new Promise(r => setTimeout(r, 9000));
    const L = await page.evaluate(() => window.__LONG || []);
    const worst = L.length ? Math.max(...L) : 0;
    if (worst > BUDGET) fail(tab + ': a single task blocked the main thread for ' + worst + 'ms (budget ' + BUDGET + 'ms) - something heavy is not going through runJob');
    else console.log('ok: ' + tab + ' worst task ' + worst + 'ms, under the ' + BUDGET + 'ms budget (' + L.length + ' long tasks)');
  }

  await browser.close();
  console.log(process.exitCode ? 'PERF TEST: FAIL' : 'PERF TEST: ALL PASS');
})().catch(e => { console.error('crashed:', e.message); process.exit(1); });
