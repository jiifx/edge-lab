// A 10,000-trade journal (the sample, ten times over, spread back in time):
// every screen must finish drawing, and none may block the page for long.
// Reports the time each step takes; fails past a generous per-step budget.
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const APP = pathToFileURL(path.resolve(__dirname, '../dist/PropEdgeLab2.html')).href;
const SAMPLE = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../samples/sample-1000-trades.json'), 'utf-8'));
const COPIES = 10, BUDGET_MS = 6000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => { console.log('FAIL: ' + m); process.exitCode = 1; };
const ok = (m) => console.log('ok: ' + m);

// shift a "YYYY-MM-DDTHH:MM" string back by whole weeks
const back = (s, weeks) => { if (!s) return s; const d = new Date(s + ':00Z'); d.setUTCDate(d.getUTCDate() - 7 * weeks); return d.toISOString().slice(0, 16); };

(async () => {
  const work = path.resolve('./pel-test/scale-' + process.pid);
  fs.mkdirSync(work, { recursive: true });
  const trades = [];
  for (let c = 0; c < COPIES; c++) SAMPLE.trades.forEach((t) => trades.push({ ...t, id: t.id + 'c' + c, dateTime: back(t.dateTime, 96 * c), exitTime: back(t.exitTime, 96 * c) }));
  const big = path.join(work, 'big.json');
  fs.writeFileSync(big, JSON.stringify({ ...SAMPLE, trades }));

  const b = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new', userDataDir: path.join(work, 'profile'), protocolTimeout: 120000,
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--edge-skip-compat-layer-relaunch'],
  });
  const page = await b.newPage();
  await page.setViewport({ width: 1360, height: 900 });
  await page.evaluateOnNewDocument(() => { if (localStorage.getItem('pel_prop') == null) localStorage.setItem('pel_prop', 'true'); });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(APP, { waitUntil: 'load' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 25000 });

  // a step = an action, then wait until `done` holds; the page must also answer
  // a trivial evaluate promptly afterwards (i.e. it is not still frozen)
  const step = async (name, act, done) => {
    const t0 = Date.now();
    await page.evaluate(act);
    try { await page.waitForFunction(done, { timeout: 60000, polling: 100 }); }
    catch { fail(name + ': did not finish within 60 s'); return; }
    const ms = Date.now() - t0;
    const p0 = Date.now(); await page.evaluate(() => 1); const lag = Date.now() - p0;
    (ms > BUDGET_MS ? fail : ok)(name + ': ' + ms + ' ms' + (lag > 200 ? ' (then ' + lag + ' ms to respond)' : ''));
  };

  await page.evaluate(() => document.querySelector('[data-mode="journal"]').click());
  const inp = await page.$('#jImportFile');
  const t0 = Date.now();
  await inp.uploadFile(big);
  try { await page.waitForFunction(() => (document.querySelector('#jSummary .tile .v') || {}).textContent === String(10000), { timeout: 90000, polling: 200 }); }
  catch { fail('import of 10,000 trades did not finish'); }
  const imp = Date.now() - t0;
  (imp > 15000 ? fail : ok)('import 10,000 trades: ' + imp + ' ms');

  const statDone = (k) => new Function('return !!document.querySelector(\'[data-stat="' + k + '"][aria-pressed="true"]\') && !document.querySelector("#st-body .skel")');
  await step('Stats > Performance', () => document.querySelector('[data-jview="stats"]').click(), statDone('perf'));
  await step('Stats > Edge report', () => document.querySelector('[data-stat="edge"]').click(), statDone('edge'));
  await step('Stats > Timing (verdict filled)', () => document.querySelector('[data-stat="time"]').click(),
    () => { const s = document.getElementById('sepBox'); return !!s && !s.querySelector('.skel') && s.textContent.trim().length > 0; });
  await step('Stats > Calendar', () => document.querySelector('[data-stat="cal"]').click(), statDone('cal'));
  await step('Trade log', () => document.querySelector('[data-jview="log"]').click(), () => document.querySelectorAll('.tradecard').length > 0);
  await step('Filter by text', () => { const i = document.querySelector('#fText, #jfText, input[placeholder*="earch"]'); if (i) { i.value = 'VWAP'; i.dispatchEvent(new Event('input', { bubbles: true })); } }, () => true);
  await step('Simulator: Use my journal', () => { document.querySelector('[data-mode="sim"]').click(); const c = document.getElementById('useJournal'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); },
    () => { const v = document.getElementById('vVerdict'); return !!v && v.textContent.trim().length > 0 && !/Simulating/.test(document.getElementById('ddLadder').textContent); });
  for (const t of ['challenge', 'funded', 'decision']) {
    await step('Simulator: ' + t, () => 0, () => true);
    const t1 = Date.now();
    await page.evaluate((v) => document.querySelector('.tabs button[data-tab="' + v + '"]').click(), t);
    await wait(300);
    try {
      await page.waitForFunction(() => ![...document.querySelectorAll('.panel:not(.hide) .skel')].some((s) => s.getClientRects().length), { timeout: 60000, polling: 200 });
      const ms = Date.now() - t1; (ms > BUDGET_MS ? fail : ok)('  ' + t + ' settled: ' + ms + ' ms');
    } catch { fail(t + ': still loading after 60 s'); }
  }
  if (errs.length) fail('page errors: ' + [...new Set(errs)].join(' | '));
  await b.close();
  console.log(process.exitCode ? 'SCALE: FAILURES' : 'SCALE: ALL PASS');
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
