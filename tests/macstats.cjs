// The new journal-stats panels under macOS conditions, exercised from Windows.
//
// macux.cjs already brackets the Consolas -> SF Mono jump for the Firms table.
// That jump is the single most common source of a Mac-only visual bug in this
// app: --mono resolves to SF Mono there, which is materially wider per glyph, so
// a row that fits exactly on a Windows dev box can push the whole PAGE sideways
// on a Mac. Everything added to Performance and Edge report - the headline
// cards, the long/short panel, the session radar, the MFE-by-session table - is
// dense, and none of it was covered.
//
// The contract is not "it always fits". It is:
//   1. the PAGE never scrolls sideways, at any shipped window width;
//   2. anything too wide scrolls inside its own .scroll box;
//   3. the SVG dials and the radar canvas actually render at a real size
//      (a viewBox'd SVG collapsing to zero height in a flex column is a
//      WebKit-specific failure that leaves a blank gap, not an error).
const puppeteer = require('puppeteer-core');
const path = require('path');
const APP = 'file:///' + path.resolve(__dirname, '../dist/PropEdgeLab2.html').replace(/\\/g, '/');
function fail(m) { console.error('FAIL: ' + m); process.exitCode = 1; }

// one trade set covering every panel: both directions, three sessions, R-unit
// excursions (so Exit management and MFE-by-session both populate)
function seedTrades() {
  let s = 24680;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const SESS = ['Asia', 'London', 'New York'];
  const out = [];
  for (let i = 0; i < 40; i++) {
    const long = rnd() > 0.45;
    const r = rnd() < (long ? 0.58 : 0.4) ? +(0.8 + rnd() * 2.4).toFixed(2) : -(0.6 + rnd() * 0.4).toFixed(2);
    const sess = SESS[i % 3];
    const day = 1 + (i % 27);
    // Entry hour and holding time VARY, so the Timing tab has more than one
    // bucket on every axis and its widest tables actually render. Only the clock
    // moves - R, session, direction and the excursions are untouched, so every
    // assertion above about heroes, dials and MFE-by-session sees what it did.
    const h = 8 + (i % 6);
    const em = h * 60 + 15 + (12 + (i % 5) * 45);
    const p2 = (v) => String(v).padStart(2, '0');
    out.push({
      id: 'ms' + i, createdAt: 1750000000000 + i * 1000,
      dateTime: '2026-06-' + p2(day) + 'T' + p2(h) + ':15',
      exitTime: '2026-06-' + p2(day) + 'T' + p2(Math.floor(em / 60) % 24) + ':' + p2(em % 60),
      instrument: long ? 'ES' : 'NQ', account: 'Main',
      direction: long ? 'long' : 'short', session: sess,
      setup: 'ORB', entryModel: 'Liq sweep + CHOCH',
      entry: null, stop: null, target: null, exit: null, size: null,
      riskAmt: 250, pnl: Math.round(r * 250), fees: null,
      R: r, Rmanual: true, pnlManual: false,
      tags: { quality: 'A+ setup', mistake: [], condition: ['Trend day'] },
      emotionBefore: 2, emotionAfter: 2, followedPlan: true,
      planText: '', notes: '', imageIds: [],
      mfeR: +(Math.max(r, 0) + 0.5 + rnd() * 1.6).toFixed(2), maeR: +(rnd() * 0.7).toFixed(2),
      mfe: null, mae: null, mfeD: null, maeD: null,
    });
  }
  return out;
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new',
    userDataDir: path.resolve('./pel-test/profile-macstats-' + process.pid),
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--edge-skip-compat-layer-relaunch'],
  });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => { try { if (localStorage.getItem('pel_prop') == null) localStorage.setItem('pel_prop', 'true'); } catch (e) { /* opaque origin */ } });  // these suites exercise prop-firm mode
  await page.setViewport({ width: 1360, height: 950 });
  page.on('pageerror', e => fail('pageerror: ' + e.message));
  // must land before the bundle evaluates IS_MAC at import time
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
    Object.defineProperty(navigator, 'userAgent', {
      get: () => 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    });
  });
  await page.goto(APP, { waitUntil: 'load' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 20000 });

  await page.evaluate(async (trades) => {
    localStorage.setItem('pel_jmeta', JSON.stringify({
      startBalance: null, accounts: ['Main'], balances: { Main: 50000 },
      rBasis: { Main: { mode: 'fixed', v: 250 } },
    }));
    const db = await new Promise((res, rej) => {
      const rq = indexedDB.open('propEdgeLab', 1);
      rq.onsuccess = e => res(e.target.result); rq.onerror = rej;
    });
    await new Promise((res) => {
      const tx = db.transaction('trades', 'readwrite'), os = tx.objectStore('trades');
      os.clear(); trades.forEach(t => os.put(t)); tx.oncomplete = res;
    });
  }, seedTrades());
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 20000 });

  const goto = async (statTab) => {
    await page.evaluate((tab) => {
      document.querySelector('[data-mode="journal"]').click();
      document.querySelector('.subnav button[data-jview="stats"]').click();
      const b = document.querySelector('[data-stat="' + tab + '"]');
      if (b) b.click();
    }, statTab);
    await new Promise(r => setTimeout(r, 900));
  };

  // ---------- the panels exist at all ----------
  await goto('perf');
  const built = await page.evaluate(() => ({
    heroes: document.querySelectorAll('.hero').length,
    dials: document.querySelectorAll('svg.gauge').length,
    tips: document.querySelectorAll('.tinfo').length,
    exitTiles: document.querySelectorAll('#exitEff .tile').length,
    mfeSession: document.querySelectorAll('#exitEff table.breakdown tbody tr').length,
  }));
  if (built.heroes !== 4) fail('expected 4 headline cards, got ' + built.heroes);
  else console.log('ok: 4 headline cards render under a Mac UA');
  if (!built.dials) fail('no profit-factor dial rendered');
  if (built.exitTiles < 4) fail('exit management tiles missing: ' + built.exitTiles);
  if (built.mfeSession < 3) fail('MFE-by-session table has ' + built.mfeSession + ' rows, expected one per session');
  else console.log('ok: exit management + MFE-by-session render (' + built.mfeSession + ' session rows)');

  // ---------- a viewBox'd SVG must not collapse in a flex column ----------
  // WebKit has historically sized these to zero height, which shows as a blank
  // hole rather than a broken image - invisible to any test that only checks
  // the element exists.
  const dial = await page.evaluate(() => {
    const s = document.querySelector('svg.gauge');
    const r = s.getBoundingClientRect();
    const arc = s.querySelector('.arc.a-win');
    return { w: Math.round(r.width), h: Math.round(r.height), stroke: getComputedStyle(arc).stroke };
  });
  if (dial.w < 60 || dial.h < 30) fail('the dial collapsed: ' + JSON.stringify(dial));
  else console.log('ok: dial renders at ' + dial.w + 'x' + dial.h + ' with a themed stroke (' + dial.stroke + ')');

  // ---------- the radar canvas actually painted ----------
  const radar = await page.evaluate(async () => {
    document.querySelector('[data-stat="edge"]').click();
    await new Promise(r => setTimeout(r, 900));
    const c = document.getElementById('cSess');
    if (!c) return { missing: true };
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let painted = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) painted++;
    return { w: c.clientWidth, h: c.clientHeight, painted, total: d.length / 4 };
  });
  if (radar.missing) fail('session radar canvas missing');
  else if (radar.painted / radar.total < 0.01) fail('session radar canvas is blank: ' + JSON.stringify(radar));
  else console.log('ok: session radar painted ' + Math.round((radar.painted / radar.total) * 100) + '% of its pixels');

  // ---------- the width contract, in a Mac-width mono ----------
  // Courier New is ~9% wider per character than Consolas, which brackets the
  // Consolas -> SF Mono jump a Mac actually makes.
  for (const wide of [false, true]) {
    if (wide) {
      await page.evaluate(() => document.documentElement.style.setProperty('--mono', '"Courier New",monospace'));
    }
    // 'plan' = My firm. Its gate rows are prose beside a mono cost figure in a
    // flex row, which is exactly the shape that fits on a Windows dev box and
    // pushes the page sideways in SF Mono - three drafts of the "Breached banks"
    // row died the same way.
    // 'time' = Timing. Its tables carry up to eleven columns - more than
    // anything else in the app - so it is the single most likely thing here to
    // push the page sideways in a wide mono. They live in .scroll boxes; this is
    // what proves the boxes are actually doing their job.
    for (const tab of ['perf', 'plan', 'edge', 'time']) {
      await goto(tab);
      for (const w of [1360, 1180, 980]) {
        await page.setViewport({ width: w, height: 900 });
        await new Promise(r => setTimeout(r, 350));
        const m = await page.evaluate(() => {
          const over = document.body.scrollWidth > document.documentElement.clientWidth + 1;
          // every table in the stats body must either fit or sit in a .scroll box
          const bad = [...document.querySelectorAll('#jv-stats table')].filter((t) => {
            const box = t.closest('.scroll');
            if (box) return false;
            return t.scrollWidth > t.parentElement.clientWidth + 1;
          }).length;
          // and nothing may stick out past the panel that contains it
          const panel = document.querySelector('#jv-stats');
          const pr = panel.getBoundingClientRect();
          const spill = [...panel.querySelectorAll('.hero,.lswrap,.tile,canvas')].filter((e) => {
            const r = e.getBoundingClientRect();
            return r.right > pr.right + 2 || r.left < pr.left - 2;
          }).length;
          return { over, bad, spill };
        });
        const tag = tab + ' @' + w + (wide ? ' (wide mono)' : '');
        if (m.over) fail(tag + ': the PAGE scrolls sideways');
        else if (m.bad) fail(tag + ': ' + m.bad + ' table(s) overflow without a .scroll box');
        else if (m.spill) fail(tag + ': ' + m.spill + ' element(s) spill outside the panel');
        else console.log('ok: ' + tag + ' - no page overflow, no unscrollable table, nothing spilling');
      }
    }
  }

  // ---------- the Funded and Validate tabs, same width contract ----------
  // Funded's KV list grew from three rows to six (payout odds, payouts/year,
  // profit, survival, best size, goal) in a fixed 300px controls column, and SF
  // Mono is wider than Consolas - so the labels are exactly the kind of thing
  // that fits on a Windows dev box and wraps or overflows on a Mac. Validate
  // gained the whole drawdown panel - four percentile tiles, a horizon control
  // and a second canvas - into the same 300px column, so it is covered here too.
  for (const wide of [false, true]) {
   for (const tabName of ['funded', 'validate']) {
    await page.evaluate((w, tab) => {
      document.documentElement.style.setProperty('--mono', w ? '"Courier New",monospace' : '');
      document.querySelector('[data-mode="sim"]').click();
      document.querySelector('[data-tab="' + tab + '"]').click();
    }, wide, tabName);
    await new Promise(r => setTimeout(r, 2400));
    for (const w of [1360, 1180, 980]) {
      await page.setViewport({ width: w, height: 900 });
      await new Promise(r => setTimeout(r, 700));
      const m = await page.evaluate((tab) => {
        const panel = document.getElementById('p-' + tab);
        const pr = panel.getBoundingClientRect();
        const spill = [...panel.querySelectorAll('.kv .r, canvas, .ctrl')].filter((e) => {
          const r = e.getBoundingClientRect();
          // a display:none element measures 0x0 at the origin, which is outside
          // every panel - skip what is not laid out rather than flagging it
          if (r.width === 0 && r.height === 0) return false;
          return r.right > pr.right + 2 || r.left < pr.left - 2;
        }).length;
        // a readout that wraps to three lines has outgrown its 150px label column
        const tall = [...panel.querySelectorAll('.kv .r .v')].filter(e => e.getBoundingClientRect().height > 60).length;
        return { over: document.body.scrollWidth > document.documentElement.clientWidth + 1, spill, tall };
      }, tabName);
      const tag = tabName + ' @' + w + (wide ? ' (wide mono)' : '');
      if (m.over) fail(tag + ': the PAGE scrolls sideways');
      else if (m.spill) fail(tag + ': ' + m.spill + ' element(s) spill outside the panel');
      else if (m.tall) fail(tag + ': ' + m.tall + ' readout(s) blew past two lines');
      else console.log('ok: ' + tag + ' - nothing overflows, spills or over-wraps');
    }
   }
  }
  await page.evaluate(() => document.documentElement.style.setProperty('--mono', ''));
  await page.setViewport({ width: 1360, height: 950 });
  await page.evaluate(() => document.querySelector('[data-mode="journal"]').click());
  await new Promise(r => setTimeout(r, 400));

  // ---------- the required-field marker keeps the select's chevron ----------
  // On macOS the chevron IS a background-image (appearance is reset there, so
  // WebKit draws no arrow of its own). Flagging with the `background` shorthand
  // silently erased it and left a select with no dropdown affordance at all.
  await page.setViewport({ width: 1360, height: 950 });
  const chev = await page.evaluate(async () => {
    document.getElementById('jNew').click();
    await new Promise(r => setTimeout(r, 300));
    document.getElementById('edSave').click();
    await new Promise(r => setTimeout(r, 250));
    const sel = document.getElementById('edSymSel');
    const cs = getComputedStyle(sel);
    return { flagged: sel.classList.contains('needs'), img: cs.backgroundImage, bg: cs.backgroundColor };
  });
  if (!chev.flagged) fail('save was not refused for a missing instrument');
  else if (!chev.img || chev.img === 'none') fail('the required-field marker erased the select chevron: ' + JSON.stringify(chev));
  else console.log('ok: a flagged select keeps its chevron (macOS draws no arrow of its own)');

  if (process.exitCode !== 1) console.log('MACSTATS: ALL PASS');
  await browser.close();
})().catch(e => { console.error('MACSTATS crashed:', e); process.exitCode = 1; });
