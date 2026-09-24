// share/edge-check.html — the simplified, shareable Validate + Challenge page.
//
// The contract that matters is not "it renders". It is that the numbers it
// prints are the APP'S numbers. A companion page quoting a different pass rate
// for the same edge and the same rules would be worse than no companion page:
// two answers, one of them wrong, and nothing on screen saying which.
//
// So this suite runs the page's own simulator in the browser and the real
// engine's challengeStats() in Node over the identical firm and edge, and
// requires them to agree EXACTLY. They share mulberry(12345), the same draw
// order and the same walk, so "close enough" is not the bar - any drift means
// the port stopped being a port.
const puppeteer = require('puppeteer-core');
const path = require('path');
const PAGE = 'file:///' + path.resolve(__dirname, '../share/edge-check.html').replace(/\\/g, '/');
let bad = 0;
const fail = (m) => { console.error('FAIL: ' + m); bad = 1; };
const ok = (m) => console.log('ok: ' + m);

(async () => {
  // ORDER MATTERS: the modules read window/navigator at import time, so the DOM
  // shim has to be installed before the bundle is imported, not after.
  const { buildOnce } = await import('file:///' + path.resolve('./tests/unit/build.mjs').replace(/\\/g, '/'));
  const { installDom } = await import('file:///' + path.resolve('./tests/unit/env.mjs').replace(/\\/g, '/'));
  installDom();
  const eng = await import(await buildOnce('share'));

  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new',
    userDataDir: path.resolve('./pel-test/profile-share-' + process.pid),
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--edge-skip-compat-layer-relaunch'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 1400 });
  page.on('pageerror', e => fail('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') fail('console: ' + m.text()); });
  await page.goto(PAGE, { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 400));

  // ---------- 1. it renders and wires up ----------
  const first = await page.evaluate(() => ({
    chip: document.getElementById('vChip').textContent,
    cchip: document.getElementById('cChip').textContent,
    pass: document.getElementById('kPass').textContent,
    exp: document.getElementById('rExp').textContent,
  }));
  if (!first.chip || first.chip === '—') fail('the validate verdict never rendered');
  else ok('validate verdict renders: "' + first.chip + '"');
  if (!first.pass || first.pass === '—') fail('the challenge simulation never ran');
  else ok('challenge ran: ' + first.pass + ' of 1000 passed at the defaults');

  // ---------- 2. the outcome ribbon accounts for every attempt ----------
  const sums = await page.evaluate(() => {
    const n = (id) => parseInt(document.getElementById(id).textContent, 10);
    return n('kPass') + n('kDd') + n('kDl') + n('kTo');
  });
  if (sums !== 1000) fail('the four outcomes sum to ' + sums + ', not 1000 - an attempt ended somewhere unnamed');
  else ok('all 1000 attempts land in exactly one of the four outcomes');

  // ---------- 3. THE ONE THAT MATTERS: same answer as the real engine ----------
  const CASES = [
    { wr: 50, rr: 1.5, p1: 8,  p2: 5, dd: 10, dl: 5, risk: 1.0, tpd: 3, md: 0, tl: 30, ddType: 'static' },
    { wr: 42, rr: 2.4, p1: 10, p2: 0, dd: 6,  dl: 0, risk: 0.5, tpd: 5, md: 4, tl: 60, ddType: 'static' },
    { wr: 45, rr: 2.0, p1: 8,  p2: 0, dd: 6,  dl: 4, risk: 1.0, tpd: 3, md: 0, tl: 60, ddType: 'trailing-eod' },
    { wr: 45, rr: 2.0, p1: 8,  p2: 0, dd: 6,  dl: 4, risk: 1.0, tpd: 3, md: 0, tl: 60, ddType: 'trailing' },
    { wr: 61, rr: 1.0, p1: 6,  p2: 0, dd: 4,  dl: 2, risk: 2.0, tpd: 2, md: 0, tl: 0, ddType: 'trailing' },
  ];
  for (const c of CASES) {
    const mine = await page.evaluate(async (cc) => {
      const set = (id, v) => {
        const e = document.getElementById(id);
        e.value = String(v);
        e.dispatchEvent(new Event('input', { bubbles: true }));
      };
      Object.keys(cc).forEach(k => { if (k !== 'ddType') set(k, cc[k]); });
      const b = document.querySelector('#ddSeg button[data-dd="' + cc.ddType + '"]');
      if (!b) throw new Error('no drawdown button for ' + cc.ddType);
      b.click();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const n = (id) => parseInt(document.getElementById(id).textContent, 10);
      return { pass: n('kPass'), dd: n('kDd'), dl: n('kDl'), to: n('kTo') };
    }, c);

    eng.setFirm({
      type: c.p2 > 0 ? '2step' : '1phase',
      account: 50000, p1: c.p1, p2: c.p2, maxdd: c.dd, daily: c.dl, minDays: c.md, cons: 0, tpd: c.tpd, split: 90, fee: 0, feeMode: 'once',
      timeLimit: c.tl, ddType: c.ddType, ddLock: 0,
    });
    eng.S.trades = null; eng.S.p = c.wr / 100; eng.S.b = c.rr; eng.S.s = 0;
    const st = eng.challengeStats(c.risk, 1000);
    const real = {
      pass: Math.round(eng.evalPass(st) * 1000),
      dd: Math.round((st.dd + st.dd2) * 1000),
      dl: Math.round((st.dl + st.dl2) * 1000),
      to: Math.round((st.to + st.to2) * 1000),
    };
    const tag = c.wr + '% / ' + c.rr + 'R @ ' + c.risk + '% risk, ' + (c.p2 > 0 ? '2-step' : '1-phase') + ', ' + (c.tl ? c.tl + 'd' : 'no limit') + ', ' + c.ddType;
    if (mine.pass !== real.pass || mine.dd !== real.dd || mine.dl !== real.dl || mine.to !== real.to) {
      fail('the page and the app disagree on ' + tag +
        '\n      page: ' + JSON.stringify(mine) + '\n      app : ' + JSON.stringify(real));
    } else {
      ok('matches the real engine exactly on ' + tag + ' — ' + real.pass + '/1000 pass');
    }
  }

  // ---------- 4. the honesty rails hold ----------
  const rails = await page.evaluate(async () => {
    const set = (id, v) => { const e = document.getElementById(id); e.value = String(v); e.dispatchEvent(new Event('input', { bubbles: true })); };
    const out = {};
    // a negative edge must be called out before anything else
    set('wr', 30); set('rr', 1.0); set('n', 400);
    await new Promise(r => requestAnimationFrame(r));
    out.negative = document.getElementById('vChip').textContent;
    // a real edge on a thin record must refuse on sample size, not endorse it
    set('wr', 60); set('rr', 2.0); set('n', 12);
    await new Promise(r => requestAnimationFrame(r));
    out.thin = document.getElementById('vChip').textContent;
    // ...and the same edge with enough trades must clear
    set('n', 400);
    await new Promise(r => requestAnimationFrame(r));
    out.fat = document.getElementById('vChip').textContent;
    // a perfect-looking win rate must not produce a zero-width interval
    set('wr', 90); set('rr', 3); set('n', 20);
    await new Promise(r => requestAnimationFrame(r));
    out.wr20 = document.getElementById('rWr').textContent;
    return out;
  });
  if (!/no edge/i.test(rails.negative)) fail('a losing edge was not called out: "' + rails.negative + '"');
  else ok('a negative expectancy is named before anything else');
  if (!/too few/i.test(rails.thin)) fail('12 trades did not trip the sample-size bar: "' + rails.thin + '"');
  else ok('12 trades refuses on sample size rather than endorsing the edge');
  if (!/real/i.test(rails.fat)) fail('a strong edge on 400 trades was not called real: "' + rails.fat + '"');
  else ok('the same edge on 400 trades reads as real');
  if (/^100–100/.test(rails.wr20)) fail('the win-rate interval collapsed to zero width');
  else ok('a 90% win rate on 20 trades still prints a real interval (' + rails.wr20 + ')');

  // ---------- 4b. the charts actually painted ----------
  // A canvas that exists and is blank is the failure mode a DOM check misses:
  // it leaves a clean rectangle of nothing and no error anywhere.
  await page.evaluate(() => {
    const set = (id, v) => { const e = document.getElementById(id); e.value = String(v); e.dispatchEvent(new Event('input', { bubbles: true })); };
    set('wr', 50); set('rr', 1.5); set('n', 40); set('risk', 1);
    set('p1', 8); set('p2', 5); set('dd', 10); set('dl', 5); set('tpd', 3); set('md', 0); set('tl', 30);
  });
  await new Promise(r => setTimeout(r, 1200));
  for (const id of ['cBe', 'cFan', 'cRisk']) {
    const m = await page.evaluate((cid) => {
      const c = document.getElementById(cid);
      if (!c || !c.width) return { missing: true };
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let painted = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) painted++;
      return { w: c.clientWidth, h: c.clientHeight, share: painted / (d.length / 4), label: c.getAttribute('aria-label') };
    }, id);
    if (m.missing) fail(id + ': canvas never sized');
    else if (m.share < 0.01) fail(id + ': canvas is blank (' + (m.share * 100).toFixed(2) + '% painted)');
    else if (!m.label || m.label.length < 12) fail(id + ': no descriptive aria-label, so the chart is color-only');
    else ok(id + ' painted ' + Math.round(m.share * 100) + '% at ' + m.w + 'x' + m.h + ' — "' + m.label.slice(0, 58) + '…"');
  }
  const rn = await page.evaluate(() => document.getElementById('riskNote').textContent);
  const peak = parseFloat((rn.match(/flat top<\/b> — <b>([\d.]+)/) || rn.match(/([\d.]+)–[\d.]+%/) || [])[1]);
  if (!(peak > 0.15)) {
    fail('the pass-rate flat top starts at ' + peak + '% - pinned to the left edge, so the chart is ' +
         'recommending "risk almost nothing". That is what happens when no deadline binds.');
  } else ok('the risk curve has a real interior flat top starting at ' + peak + '%, not a degenerate one at the axis');

  // the break-even curve is arithmetic, not simulation, so it can be checked exactly
  const be = await page.evaluate(() => document.getElementById('beNote').textContent);
  if (!/1\.00R/.test(be)) fail('break-even at a 50% win rate should need 1.00R; note reads: ' + be);
  else ok('break-even note is arithmetically right at the current win rate');

  // ---------- 4c. the pairing nobody actually runs ----------
  const pairing = await page.evaluate(async () => {
    const set = (id, v) => { const e = document.getElementById(id); e.value = String(v); e.dispatchEvent(new Event('input', { bubbles: true })); };
    const pick = (t) => document.querySelector('#ddSeg button[data-dd="' + t + '"]').click();
    const shown = () => !document.getElementById('ddWarn').hidden;
    const out = {};
    set('p2', 5); pick('trailing');      await new Promise(r => setTimeout(r, 60)); out.trail2step = shown();
    set('p2', 0);                        await new Promise(r => setTimeout(r, 60)); out.trail1phase = shown();
    set('p2', 5); pick('static');        await new Promise(r => setTimeout(r, 60)); out.static2step = shown();
    pick('trailing-eod');                await new Promise(r => setTimeout(r, 60)); out.eod2step = shown();
    pick('static'); set('p2', 5);
    return out;
  });
  if (!pairing.trail2step) fail('trailing + 2-step should be flagged; no two-step firm uses a trailing floor');
  else if (!pairing.eod2step) fail('trailing-EOD + 2-step should be flagged too');
  else if (pairing.trail1phase) fail('trailing + ONE phase is the normal case and must not be flagged');
  else if (pairing.static2step) fail('static + 2-step is the normal case and must not be flagged');
  else ok('flags trailing + 2-step, and stays quiet on the two pairings that actually exist');

  // ---------- 5. both themes, and no sideways scroll ----------
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme === 'dark' ? 'light' : 'dark' }]);
    await new Promise(r => setTimeout(r, 250));
    const m = await page.evaluate(() => {
      const cs = getComputedStyle(document.body);
      return {
        bg: cs.backgroundColor, fg: cs.color,
        over: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      };
    });
    if (m.over) fail(theme + ': the page scrolls sideways');
    else ok(theme + ' theme: ' + m.bg + ' on ' + m.fg + ', no horizontal overflow (data-theme beats the media query)');
    await page.screenshot({ path: 'pel-test/share-' + theme + '.png', fullPage: true });
  }

  for (const w of [1200, 900, 420]) {
    await page.setViewport({ width: w, height: 1000 });
    await new Promise(r => setTimeout(r, 200));
    const over = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    if (over) fail('sideways scroll at ' + w + 'px'); else ok('no sideways scroll at ' + w + 'px');
  }

  await browser.close();
  console.log(bad ? 'SHARE HTML: FAILURES' : 'SHARE HTML: ALL PASS');
  process.exitCode = bad;
})();
