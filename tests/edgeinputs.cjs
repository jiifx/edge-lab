// The "Your edge" number boxes, typed into in a real browser.
//
// Reported from the field: "i cant input 92 sample size, 0.84 rr or 1.09 profit
// factor". The model read the RANGE slider, which snaps to its step, and on blur
// the box was overwritten with the snapped slider value - 92 -> 90, 0.84 -> 0.85,
// 1.09 -> 1.1. The unit suite (tests/unit/edgeinputs.test.mjs) owns the model;
// this owns what a person sees: type, leave the box, read it back, reload, read
// it back again. And the verdict for that record must not say "promising".
const puppeteer = require('puppeteer-core');
const path = require('path');
const APP = 'file:///' + path.resolve(__dirname, '../dist/EdgeLab.html').replace(/\\/g, '/');
function fail(m) { console.error('FAIL: ' + m); process.exitCode = 1; }
function ok(m) { console.log('ok - ' + m); }

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new',
    userDataDir: path.resolve('./pel-test/profile-edgeinputs-' + process.pid),
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--edge-skip-compat-layer-relaunch'],
  });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('pel_free_notice_off', 'true'); } catch (e) { /* opaque origin */ } });
  await page.setViewport({ width: 1400, height: 1000 });
  page.on('pageerror', (e) => fail('pageerror: ' + e.message));
  await page.goto(APP, { waitUntil: 'load' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 20000 });
  await page.evaluate(() => document.querySelector('[data-mode="sim"]').click());

  // type like a person: focus, select all, type, then Tab out (fires `change`)
  const type = async (id, v) => {
    await page.focus('#' + id);
    await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(v);
    await page.keyboard.press('Tab');
  };
  const read = () => page.evaluate(() => ({
    wr: nwr.value, pay: npay.value, sc: nsc.value, n: nn.value,
    sum: sbSum.textContent, verdict: vVerdict.textContent, chip: vChip.textContent, read: vRead.textContent,
    vN: vN.textContent, vPF: vPF.textContent, thumbN: sn.value,
  }));
  const settle = () => new Promise((r) => setTimeout(r, 700));

  // ---------- 1. the three values from the report, in R:R mode ----------
  await type('nwr', '56'); await type('nsc', '2'); await type('npay', '0.84'); await type('nn', '92');
  await settle();
  let s = await read();
  if (s.n !== '92') fail('typed 92 trades, box reads ' + s.n); else ok('typed 92 trades, box still reads 92 after leaving it');
  if (s.pay !== '0.84') fail('typed 0.84 R, box reads ' + s.pay); else ok('typed 0.84 R, box still reads 0.84');
  if (!/^92/.test(s.vN)) fail('Validate sample shows ' + s.vN + ', not 92'); else ok('Validate uses 92 trades (' + s.vN.slice(0, 2) + ')');
  // 0.56/0.44 * 0.84 = 1.069 -> the summary's PF must be 1.07, not 1.08 (0.85's)
  if (!/PF 1\.07/.test(s.sum)) fail('summary PF should be 1.07 for 0.84R at 56%: ' + s.sum); else ok('the modelled edge is 0.84R (PF 1.07 in the summary)');
  if (s.thumbN === '92') fail('the slider was expected to snap (step 10) - the test is not exercising the bug');
  else ok('the slider snaps to ' + s.thumbN + ' while the box keeps 92 - the box is the input of record');

  // ---------- 2. the verdict for a record whose range spans zero ----------
  if (/promising/i.test(s.verdict + s.chip + s.read)) fail('a range spanning zero still reads promising: ' + s.verdict + ' / ' + s.chip);
  else ok('verdict for 56% / 0.84R / 92 trades: "' + s.verdict + '" / ' + s.chip);
  if (s.verdict !== 'No proven edge') fail('expected "No proven edge", got ' + s.verdict);
  if (!/includes losing/.test(s.read)) fail('the read line should say the range includes losing: ' + s.read);
  else ok('read: ' + s.read);

  // ---------- 3. profit factor 1.09 ----------
  await page.evaluate(() => document.querySelector('[data-pm="pf"]').click());
  await settle();
  s = await read();
  if (s.pay !== '1.0691') fail('0.84R at 56% should show PF 1.0691 after the switch, box reads ' + s.pay);
  else ok('switching to PF converts 0.84R to 1.0691 without rounding the edge');
  await type('npay', '1.09');
  await settle();
  s = await read();
  if (s.pay !== '1.09') fail('typed PF 1.09, box reads ' + s.pay); else ok('typed PF 1.09, box still reads 1.09');
  if (!/PF 1\.09/.test(s.sum)) fail('summary PF should be 1.09: ' + s.sum); else ok('the modelled edge has PF 1.09');
  if (!/^1\.09/.test(s.vPF)) fail('Validate PF should be 1.09: ' + s.vPF); else ok('Validate profit factor reads 1.09');
  // and back: the R:R must be what 1.09 means, not a snapped neighbour
  await page.evaluate(() => document.querySelector('[data-pm="rr"]').click());
  await settle();
  s = await read();
  const want = (1.09 * 0.44 / 0.56);
  if (Math.abs(Number(s.pay) - want) > 1e-4) fail('PF 1.09 back to R:R should be ' + want.toFixed(4) + ', box reads ' + s.pay);
  else ok('PF 1.09 converts back to ' + s.pay + 'R');

  // ---------- 4. survives a reload ----------
  await type('npay', '0.84');
  await settle();
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 20000 });
  await page.evaluate(() => document.querySelector('[data-mode="sim"]').click());
  await settle();
  s = await read();
  if (s.n !== '92' || s.pay !== '0.84' || s.wr !== '56' || s.sc !== '2') fail('after reload the boxes read ' + JSON.stringify(s));
  else ok('after a reload the boxes still read 56 / 0.84 / 2 / 92');
  if (!/PF 1\.07/.test(s.sum)) fail('after reload the model is not 0.84R: ' + s.sum); else ok('...and the model is still 0.84R');

  // ---------- 5. a drag writes the slider into the box ----------
  await page.evaluate(() => { sn.value = '300'; sn.dispatchEvent(new Event('input', { bubbles: true })); });
  await settle();
  s = await read();
  if (s.n !== '300' || !/^300/.test(s.vN)) fail('dragging to 300 left the box at ' + s.n + ' / Validate at ' + s.vN);
  else ok('dragging the slider writes 300 into the box and the model');

  // ---------- 6. the domain holds on a typed entry (Trap #22) ----------
  const t0 = Date.now();
  await type('nn', '10000000');
  await settle();
  s = await read();
  if (s.n !== '1500') fail('10,000,000 trades should clamp to 1500 on blur, box reads ' + s.n);
  else ok('10,000,000 trades clamps to 1500 on blur, in ' + (Date.now() - t0) + 'ms');
  await type('nn', '');
  await settle();
  s = await read();
  if (s.n === '' || !isFinite(Number(s.n))) fail('an emptied box was left empty: "' + s.n + '"'); else ok('an emptied box gets the slider value back (' + s.n + ')');

  await browser.close();
})();
