// The eval-size curve on the Decision tab.
//
// Three screens used to end on "lower the eval risk" with no number behind it,
// and on a firm with a time limit that instruction is backwards: a smaller size
// is slower, so more attempts run out of room before they reach the target and
// the expected cost to fund goes UP. This drives the real app and checks that
// what reaches the screen is the measured answer rather than the assumed one.
const puppeteer = require('puppeteer-core');
const path = require('path');
const APP = 'file:///' + path.resolve(__dirname, '../dist/PropEdgeLab2.html').replace(/\\/g, '/');
function fail(m) { console.error('FAIL: ' + m); process.exitCode = 1; }
function ok(m) { console.log('ok - ' + m); }

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new',
    userDataDir: path.resolve('./pel-test/profile-evalsize-' + process.pid),
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--edge-skip-compat-layer-relaunch'],
  });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => { try { if (localStorage.getItem('pel_prop') == null) localStorage.setItem('pel_prop', 'true'); } catch (e) { /* opaque origin */ } });  // these suites exercise prop-firm mode
  await page.setViewport({ width: 1400, height: 950 });
  page.on('pageerror', (e) => fail('pageerror: ' + e.message));
  await page.goto(APP, { waitUntil: 'load' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 20000 });
  await page.evaluate(() => {
    if (!document.getElementById('askOv').classList.contains('hide')) {
      const b = [...document.querySelectorAll('#askBtns button')].find((x) => /later/i.test(x.textContent));
      if (b) b.click();
    }
  });

  // put a real edge on the sliders and open the Decision tab
  const setup = async (fields) => {
    await page.evaluate((f) => {
      const set = (id, v) => {
        const el = document.getElementById(id);
        if (!el) throw new Error('missing #' + id);
        el.value = String(v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      set('swr', 50); set('spay', 1.6); set('ssc', 0);
      Object.entries(f).forEach(([k, v]) => set(k, v));
      [...document.querySelectorAll('.tabs button')].find((b) => /decision/i.test(b.textContent))?.click();
    }, fields);
    // the full-quality pass lands 250ms after the last input; give it room
    await new Promise((r) => setTimeout(r, 1400));
    return page.evaluate(() => ({
      size: document.getElementById('dEvalSize').innerText.replace(/\s+/g, ' ').trim(),
      title: document.getElementById('dEvalSize').title,
      cls: document.getElementById('dEvalSize').className,
      read: document.getElementById('dRead').textContent,
      fees: document.getElementById('dFees').textContent,
    }));
  };

  // ---------- 1. a firm with a clock: the cheapest size is NOT the floor ----------
  // 2-step, 30-day limit, and the user standing at the bottom of the slider
  const clocked = await setup({ fType: '2step', fP1: 10, fP2: 5, fMaxdd: 10, fDdType: 'static',
    fDaily: 5, fMinDays: 4, fTimeLimit: 30, fFee: 375, fFeeMode: 'once', fAccount: 50000, srde: 0.1 });
  const pct = /(\d+\.\d+)%/.exec(clocked.size);
  if (!pct) fail('no eval size on screen: ' + JSON.stringify(clocked.size));
  else if (Number(pct[1]) <= 0.15) fail('under a 30-day limit the cheapest size must not be the slider floor, got ' + pct[1] + '%');
  else ok('30-day limit -> cheapest eval size ' + pct[1] + '% (not the floor): ' + clocked.size);

  if (!/costs MORE, not less/i.test(clocked.title)) {
    fail('standing below the band should say a smaller size costs more; title was: ' + clocked.title);
  } else ok('the tooltip names the direction the old copy got wrong');

  if (/cell-go/.test(clocked.cls)) fail('sitting at 0.1% under a clock must not read as green: ' + clocked.cls);
  else ok('and it is not coloured as though the user were already right');

  // The tile is coloured by that gap, so it has to print the gap: a red number
  // that IS the recommendation reads as "this size is bad" with nothing beside
  // it saying otherwise.
  if (!/yours:\s*0\.1\d%/i.test(clocked.size)) fail("the tile must name the user's own size and cost: " + clocked.size);
  else ok('and it prints what the user is actually paying: ' + /yours:[^]*/i.exec(clocked.size)[0]);

  // ---------- 2. no clock: the old advice was right, and it still says so ----------
  // The cost curve bottoms out at the slider floor and stays flat for a long
  // way, so the band is wide and the pick has to come off the clock, not the
  // cash: 0.10% funds in ~100 trading days, the top of the same band in ~15.
  const free = await setup({ fTimeLimit: 0, srde: 1.5 });
  const pct2 = /^(\d+\.\d+)%/.exec(free.size);
  const days2 = /~(\d+)D/i.exec(free.size);
  if (!pct2 || !days2) fail('no eval size / days on screen without a time limit: ' + free.size);
  else if (Number(pct2[1]) <= 0.15) fail('a wide flat band must not settle on the slider floor and its 100-day wait: ' + free.size);
  else if (Number(days2[1]) > 40) fail('the pick inside a flat-cost band should be the quick end, got ~' + days2[1] + ' days');
  else ok('no time limit -> ' + pct2[1] + '% at ~' + days2[1] + 'd, the quick end of a flat band: ' + free.size);
  if (!/what separates them is the clock/i.test(free.title)) fail('the tooltip should say why the clock decided it: ' + free.title);
  else ok('and the tooltip says the money was a tie');

  // ---------- 3. the verdict paragraph stops asserting a direction ----------
  // a thin edge on an expensive firm: not worth it, so dRead takes the branch
  // that used to read "Lower the eval size"
  const thin = await setup({ swr: 44, spay: 1.4, fFee: 40000, fTimeLimit: 0, srde: 1.5 });
  const chip = await page.evaluate(() => document.getElementById('dChip').textContent);
  if (!/not worth it/i.test(chip)) fail('the fixture did not reach the not-worth-it branch (chip: ' + chip + ')');
  if (/Lower the eval size/i.test(thin.read)) fail('the unmeasured instruction is still on screen: ' + thin.read);
  else ok('no bare "lower the eval size" instruction: ' + thin.read.slice(0, 120));
  if (!/(Try [\d.]+% eval risk|at any eval size|doesn't cover the cost)/i.test(thin.read)) {
    fail('the not-worth-it verdict should say whether sizing is the lever; got: ' + thin.read);
  } else ok('it says which of the two it is');

  // ---------- 3b. a monthly fee makes the band wide, and speed alone unsafe ----------
  // Cost is quantised to whole billing months, so a huge range of sizes prices
  // identically while the single-attempt pass rate falls away underneath it.
  // The pick has to come off the 85% bar, not off the clock.
  const monthly = await setup({ swr: 50, spay: 1.6, fType: 'futures', fP1: 6, fP2: 0, fMaxdd: 4,
    fDdType: 'trailing-eod', fDdLock: 1, fDaily: 0, fMinDays: 0, fTimeLimit: 0,
    fFeeMode: 'monthly', fFee: 165, fAccount: 50000, srde: 0.75 });
  const mp = /(\d+\.\d+)%/.exec(monthly.size);
  const mBand = /flattest between (\d+\.\d+)% and (\d+\.\d+)%/i.exec(monthly.title);
  const mPass = /([\d.]+)% per attempt/i.exec(monthly.title);
  if (!mp || !mBand || !mPass) fail('monthly firm: no size / band / pass rate: ' + monthly.size + ' | ' + monthly.title);
  else if (Number(mBand[2]) - Number(mBand[1]) < 1) fail('expected a wide flat band on a monthly fee, got ' + mBand[1] + '-' + mBand[2] + '%');
  else if (Number(mPass[1]) < 85) fail('the named size gave up the 85% bar for speed: ' + monthly.title);
  else if (Number(mp[1]) >= Number(mBand[2]) - 1e-9)
    fail('on a wide flat band the pick ran to the top rather than stopping at the bar: ' + monthly.size);
  else ok('monthly fee -> ' + mp[1] + '% at ' + mPass[1] + '% an attempt, band ' + mBand[1] + '-' + mBand[2] + '%');
  // this fixture stands the user ON the flat bottom, so there is no gap to draw
  // and the tile must not invent one
  if (/yours:/i.test(monthly.size)) fail('a user already on the band should not be shown a gap: ' + monthly.size);
  else if (!/cell-go/.test(monthly.cls)) fail('a user already on the band should read green: ' + monthly.cls);
  else ok('and a user already on the band gets no gap line and reads green');

  // ---------- 4. an instant firm has no eval to size ----------
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.tabs button')];
    rows.find((b) => /firms/i.test(b.textContent))?.click();
  });
  await new Promise((r) => setTimeout(r, 6000));
  const inst = await page.evaluate(() => {
    const tr = [...document.querySelectorAll('tr.sgrow')].find((t) => /instant/i.test(t.innerText));
    if (!tr) return null;
    tr.click();
    [...document.querySelectorAll('.tabs button')].find((b) => /decision/i.test(b.textContent))?.click();
    return true;
  });
  if (!inst) console.log('skip - no instant firm in the visible catalogue rows');
  else {
    await new Promise((r) => setTimeout(r, 1400));
    const v = await page.evaluate(() => ({
      size: document.getElementById('dEvalSize').innerText.trim(),
      title: document.getElementById('dEvalSize').title,
    }));
    if (!/no evaluation/i.test(v.size)) fail('an instant firm must not be quoted an eval size: ' + v.size);
    else ok('instant firm -> "' + v.size + '"');
  }

  // ---------- 5. dragging the eval slider must not recompute the curve ----------
  // the curve does not depend on where the user is standing on it; if it did,
  // every drag would pay for a 25-point sweep
  await setup({ fType: '2step', fTimeLimit: 30, fFee: 375, srde: 0.5 });
  const drag = await page.evaluate(async () => {
    const el = document.getElementById('srde');
    const t0 = performance.now();
    for (const v of [0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3]) {
      el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => requestAnimationFrame(r));
    }
    return performance.now() - t0;
  });
  if (drag > 800) fail('an 8-step drag of the eval slider took ' + Math.round(drag) + 'ms');
  else ok('8-step eval-risk drag in ' + Math.round(drag) + 'ms (curve cache survives it)');

  await browser.close();
  if (!process.exitCode) console.log('\nALL EVAL-SIZE CHECKS PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
