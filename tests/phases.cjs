// The Challenge tab, on a firm with two gates.
//
// What this exists to stop coming back: the tab used to print a PHASE 1 pass
// rate as its headline, a bare Math.round of the end-to-end rate in a "Clear
// both phases" row underneath it (so "100%" could sit above a ">99%" it can
// never exceed), and an outcome chart drawn from phase 1 alone - which painted
// every attempt that cleared phase 1 and then died in phase 2 as a PASS, and
// showed its cause of death nowhere at all.
//
// The three checks below are the three halves of that: the numbers on screen
// must be consistent with each other, the chart must agree with the headline it
// sits beside, and a single-gate firm must show none of it.
const puppeteer = require('puppeteer-core');
const path = require('path');
const APP = 'file:///' + path.resolve(__dirname, '../dist/PropEdgeLab2.html').replace(/\\/g, '/');
function fail(m) { console.error('FAIL: ' + m); process.exitCode = 1; }
function ok(m) { console.log('ok - ' + m); }
const num = (s) => { const m = /(\d+)%/.exec(s || ''); return m ? Number(m[1]) : NaN; };

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new',
    userDataDir: path.resolve('./pel-test/profile-phases-' + process.pid),
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
      [...document.querySelectorAll('.tabs button')].find((b) => /challenge/i.test(b.textContent))?.click();
    }, fields);
    await new Promise((r) => setTimeout(r, 1400));   // the full-quality pass lands 250ms after the last input
    return page.evaluate(() => ({
      head: document.getElementById('cPass').innerText,
      p1: document.getElementById('cP1').innerText,
      p2: document.getElementById('cP2').innerText,
      p1hid: document.getElementById('cRowP1').classList.contains('hide'),
      p2hid: document.getElementById('cRowP2').classList.contains('hide'),
      seghid: document.getElementById('cPhaseSeg').classList.contains('hide'),
      leg: document.getElementById('cOutLeg').classList.contains('hide') ? '' : document.getElementById('cOutLeg').innerText,
      title: document.getElementById('cPathsTitle').textContent,
      read: document.getElementById('cRead').textContent,
    }));
  };

  // A size where all three figures sit well inside 5-95%, so pctEst's ">99%" and
  // "<1%" guards cannot swallow the comparison this test is making.
  const two = { fType: '2step', fP1: 10, fP2: 5, fMaxdd: 10, fDdType: 'static', fDdLock: 1,
    fDaily: 5, fTpd: 5, fAccount: 50000, fFee: 375, src: 1.5 };
  const st = await setup(two);

  // ---------- 1. the headline is END TO END, and says which it is ----------
  if (!/clear both phases/i.test(st.head)) fail('a 2-step headline must name what it is measuring: ' + JSON.stringify(st.head));
  else ok('the headline names the end-to-end question: "' + st.head.replace(/\n/g, ' ') + '"');
  if (st.p1hid || st.p2hid) fail('a 2-step firm must show both phase rows (p1 hidden: ' + st.p1hid + ', p2: ' + st.p2hid + ')');
  else ok('both gates get their own line');

  const H = num(st.head), P1 = num(st.p1), P2 = num(st.p2);
  if (!isFinite(H) || !isFinite(P1) || !isFinite(P2)) fail('a phase figure is missing: ' + JSON.stringify([st.head, st.p1, st.p2]));
  else {
    // the bug in one assertion: the end-to-end number can NEVER exceed phase 1
    if (H > P1) fail('the headline (' + H + '%) reads higher than passing phase 1 alone (' + P1 + '%) - it cannot');
    else ok('the end-to-end figure sits at or below phase 1: ' + H + '% <= ' + P1 + '%');
    // and the two gates must multiply into it, or one of the three is measuring
    // a different population from the other two
    const prod = (P1 / 100) * (P2 / 100) * 100;
    if (Math.abs(prod - H) > 2) fail('phase 1 x phase 2 = ' + prod.toFixed(1) + '% but the headline says ' + H + '%');
    else ok('phase 1 ' + P1 + '% x phase 2 ' + P2 + '% = ' + prod.toFixed(1) + '%, and the headline says ' + H + '%');
  }
  if (!/get there/i.test(st.p2)) fail('the phase-2 row must say it is conditional: ' + JSON.stringify(st.p2));
  else ok('...and phase 2 is labelled as the conditional it is');

  // ---------- 2. the chart agrees with the headline it sits beside ----------
  // "How attempts end" is a canvas, so this reads the pixels: in the pass row the
  // filled share of the bar IS the pass probability the chart is claiming.
  const bars = await page.evaluate(() => {
    const cv = document.getElementById('cOut');
    const ctx = cv.getContext('2d');
    const px = ctx.getImageData(0, 0, cv.width, cv.height).data;
    const hex = getComputedStyle(document.documentElement).getPropertyValue('--go').trim();
    const go = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    // the four bars are evenly spaced; sample the vertical middle of the first two
    const row = (fy) => {
      const y = Math.round(fy * cv.height);
      let bar = 0, filled = 0;
      const tones = new Set();
      for (let x = 0; x < cv.width; x++) {
        const o = (y * cv.width + x) * 4;
        if (px[o + 3] < 200) continue;               // outside the bar: never painted
        if (x > cv.width * 0.75) break;              // the text gutter
        bar++;
        const near = Math.abs(px[o] - go[0]) + Math.abs(px[o + 1] - go[1]) + Math.abs(px[o + 2] - go[2]) < 60;
        if (near) filled++;
        tones.add(px[o] + ',' + px[o + 1] + ',' + px[o + 2]);
      }
      return { share: bar ? filled / bar : 0, tones: tones.size };
    };
    return { pass: row(0.145), dd: row(0.382) };
  });
  const chartPass = Math.round(bars.pass.share * 100);
  if (!isFinite(chartPass) || bars.pass.share <= 0) fail('could not read the outcome chart at all');
  else if (Math.abs(chartPass - H) > 4) {
    fail('the "How attempts end" pass bar says ' + chartPass + '% but the headline says ' + H +
      '% - the chart is drawn from a different population (this is the phase-1-only bug)');
  } else ok('the outcome chart\'s pass bar matches the headline: ' + chartPass + '% vs ' + H + '%');
  // the failure bars carry a phase split, so a drawdown bar must show two tones
  // (phase 1 solid, phase 2 lighter) plus its unfilled track
  if (bars.dd.tones < 3) fail('the drawdown bar shows ' + bars.dd.tones + ' tone(s) - the phase-2 share is not being drawn');
  else ok('the failure bars are split by phase (' + bars.dd.tones + ' tones in the drawdown row)');
  if (!/phase 2/i.test(st.leg)) fail('the two-tone bars have no legend saying what the second tone is: ' + JSON.stringify(st.leg));
  else ok('...and a legend names the split: "' + st.leg.replace(/\s+/g, ' ').trim() + '"');

  // ---------- 3. the phase selector draws a genuinely different picture ----------
  if (st.seghid) fail('a 2-step firm should offer the phase selector');
  else ok('the paths chart offers both phases');
  if (!/phase 1/i.test(st.title)) fail('the paths chart does not say which phase it is drawing: ' + st.title);
  const shots = await page.evaluate(async () => {
    const cv = document.getElementById('cPaths');
    const one = cv.toDataURL();
    [...document.querySelectorAll('button[data-cphase]')].find((b) => b.getAttribute('data-cphase') === '2').click();
    await new Promise((r) => setTimeout(r, 400));
    return { one, two: cv.toDataURL(), title: document.getElementById('cPathsTitle').textContent,
      pressed: [...document.querySelectorAll('button[data-cphase]')].map((b) => b.getAttribute('aria-pressed')).join(',') };
  });
  if (shots.one === shots.two) fail('switching to phase 2 redrew an identical chart - the target never changed');
  else ok('phase 2 draws its own walks against its own target');
  if (!/phase 2/i.test(shots.title) || shots.pressed !== 'false,true') {
    fail('the selector did not follow: title "' + shots.title + '", pressed ' + shots.pressed);
  } else ok('the control states which phase is on screen');

  // ---------- 4. a single-gate firm shows none of it ----------
  const one = await setup({ fType: 'futures', fP1: 6, fP2: 0, fMaxdd: 4, fDdType: 'trailing-eod',
    fDdLock: 1, fDaily: 0, fMinDays: 5, fTpd: 5, fAccount: 50000, fFee: 150, src: 0.75 });
  if (/both phases/i.test(one.head)) fail('a 1-phase firm must not talk about two: ' + JSON.stringify(one.head));
  else ok('a 1-phase firm says "' + one.head.replace(/\n/g, ' ') + '"');
  if (!one.p1hid || !one.p2hid) fail('the phase rows must be hidden on a single-gate firm');
  else ok('no phase ladder where there is only one gate');
  if (!one.seghid) fail('the phase selector must be hidden on a single-gate firm');
  else if (/phase/i.test(one.title)) fail('the paths title should not name a phase on a 1-phase firm: ' + one.title);
  else ok('no phase selector, and the chart title drops the phase');
  if (one.leg !== '') fail('no phase-2 legend can be shown on a firm with no phase 2: ' + one.leg);
  else ok('and no legend for a split that cannot exist');

  if (process.exitCode !== 1) console.log('PHASES: ALL PASS');
  await browser.close();
})().catch((e) => { console.error('PHASES crashed:', e); process.exitCode = 1; });
