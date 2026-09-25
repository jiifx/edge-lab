// Hostile trades, every screen: a backup full of the values a real journal ends
// up with by accident (stop equal to entry, zero and negative risk, absurd
// magnitudes, impossible or missing dates, exits before entries, strings where
// numbers belong) is imported beside the sample, then every tab is visited in
// both prop and personal mode and its visible text is scanned for the words a
// broken computation leaves behind: NaN, Infinity, undefined, null, [object.
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const APP = pathToFileURL(path.resolve(__dirname, '../dist/PropEdgeLab2.html')).href;
const SAMPLE = path.resolve(__dirname, '../samples/sample-1000-trades.json');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => { console.log('FAIL: ' + m); process.exitCode = 1; };
const ok = (m) => console.log('ok: ' + m);

const base = { account: 'Sample 50k', instrument: 'MNQ', direction: 'long', session: 'New York', setup: 'Fuzz', entryModel: 'Fuzz', tags: { quality: 'B setup', mistake: [], condition: [] } };
const hostile = [
  { entry: 100, stop: 100, exit: 105 },                       // stop == entry: R divides by zero
  { riskAmt: 0, pnl: 250 },                                    // zero risk
  { riskAmt: -200, pnl: 400 },                                 // negative risk
  { R: 1e308, Rmanual: true },                                 // absurd magnitude
  { R: -1e308, Rmanual: true },
  { R: 'abc', Rmanual: true },                                 // text where a number belongs
  { pnl: 1e15 },                                               // P&L only, huge
  { R: 2, Rmanual: true, exitTime: '2025-01-01T08:00' },       // exit before entry
  { R: 1, Rmanual: true, dateTime: '' },                       // no date
  { R: -1, Rmanual: true, dateTime: '2025-02-30T10:00' },      // impossible date
  { R: 0, Rmanual: true, dateTime: 'garbage' },
  { R: 1.5, Rmanual: true, mfeR: -5, maeR: 99, runR: -3, rrR: 0 },
  { R: -1, Rmanual: true, rrR: -2, mfe: 'x', mae: null },
  { R: 3, Rmanual: true, size: 0, entry: 0, stop: 0, target: 0, exit: 0 },
  { R: 999, Rmanual: true },                                   // extreme but inside R_MAX:
  { R: -999, Rmanual: true },                                  // the simulator must still finish
  { entry: 100, stop: 99.99999, exit: 105 },                   // a stop a hair off the entry (R ~ 500,000)
];
const trades = hostile.map((h, i) => ({ id: 'fz' + i, dateTime: '2025-06-0' + ((i % 9) + 1) + 'T10:' + String(10 + i).padStart(2, '0'), ...base, ...h }));

(async () => {
  const work = path.resolve('./pel-test/fuzz-' + process.pid);
  fs.mkdirSync(work, { recursive: true });
  const fuzz = path.join(work, 'fuzz.json');
  fs.writeFileSync(fuzz, JSON.stringify({ trades }));
  const b = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new', userDataDir: path.join(work, 'profile'),
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--edge-skip-compat-layer-relaunch', '--window-size=1360,900'],
  });
  const page = await b.newPage();
  await page.setViewport({ width: 1360, height: 900 });
  await page.evaluateOnNewDocument(() => { if (localStorage.getItem('pel_prop') == null) localStorage.setItem('pel_prop', 'true'); });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(APP, { waitUntil: 'load' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 25000 });
  await page.evaluate(() => document.querySelector('[data-mode="journal"]').click());
  const inp = await page.$('#jImportFile');
  await inp.uploadFile(SAMPLE);
  await wait(4000);
  await inp.uploadFile(fuzz);
  await wait(600);
  await page.evaluate(() => { const x = [...document.querySelectorAll('#askBtns button')].find((e) => /merge/i.test(e.textContent)); if (x) x.click(); });
  await wait(2500);
  const n = await page.evaluate(() => document.querySelector('#jSummary .tile .v').textContent.trim());
  ok('journal holds ' + n + ' trades (1000 sample + hostile rows that survived the sanitizer)');

  const BAD = /\bNaN\b|\bInfinity\b|\bundefined\b|\bnull\b|\[object /;
  const scan = async (where) => {
    await wait(900);
    const hits = await page.evaluate((src) => {
      const re = new RegExp(src);
      const out = [];
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let t;
      while ((t = w.nextNode())) {
        const el = t.parentElement;
        if (!el || el.closest('script,style,.hide,[hidden]')) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || !el.getClientRects().length) continue;
        if (re.test(t.textContent)) out.push(t.textContent.trim().slice(0, 80));
      }
      return out;
    }, BAD.source);
    if (hits.length) fail(where + ': ' + [...new Set(hits)].slice(0, 5).join(' | '));
    else ok(where + ': clean');
  };
  const click = (sel) => page.evaluate((s) => { const e = document.querySelector(s); if (e) e.click(); return !!e; }, sel);

  for (const prop of [true, false]) {
    const tag = prop ? '[prop] ' : '[personal] ';
    await page.evaluate((p) => { const c = document.getElementById('propMode'); if (c.checked !== p) { c.checked = p; c.dispatchEvent(new Event('change', { bubbles: true })); } }, prop);
    // journal: log, then every stats sub-tab, in all accounts and in one account
    await click('[data-mode="journal"]');
    for (const scope of ['', 'Sample 50k']) {
      await page.evaluate((v) => { const s = document.getElementById('jAcct'); const o = [...s.options].find((x) => (v ? x.textContent.includes(v) : x.value === '')); if (o) { s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); } }, scope);
      await click('[data-jview="log"]');
      await scan(tag + 'log ' + (scope || 'all'));
      await click('[data-jview="stats"]');
      await wait(500);
      for (const s of ['perf', 'edge', 'time', 'cal']) { await click('[data-stat="' + s + '"]'); await wait(s === 'time' ? 2500 : 300); await scan(tag + 'stats/' + s + ' ' + (scope || 'all')); }
    }
    // simulator driven by the journal, every tab
    await click('[data-mode="sim"]');
    await page.evaluate(() => { const c = document.getElementById('useJournal'); if (!c.checked) { c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); } });
    await wait(1500);
    for (const t of ['validate', 'challenge', 'funded', 'decision']) {
      const shown = await page.evaluate((v) => { const e = document.querySelector('.tabs button[data-tab="' + v + '"]'); if (!e || getComputedStyle(e).display === 'none') return false; e.click(); return true; }, t);
      if (!shown) continue;
      await wait(2500);
      await scan(tag + 'sim/' + t);
    }
    // a trade's detail view, for the hostile rows
    await click('[data-mode="journal"]');
    await click('[data-jview="log"]');
  }
  if (errs.length) fail('page errors: ' + [...new Set(errs)].join(' | '));
  await b.close();
  console.log(process.exitCode ? 'FUZZSCREENS: FAILURES' : 'FUZZSCREENS: ALL PASS');
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
