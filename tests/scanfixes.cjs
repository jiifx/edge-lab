// Pins for the 2026-08 audit-scan fixes that touch money or destroy data.
//
// Four behaviours, each of which previously did the WRONG thing silently:
//  1. bulk delete acted on hidden rows - "Delete (12)" over a screen showing 0
//  2. $ per R -> % of start reinterpreted the digits instead of converting
//  3. CSV import wrote session:"" - a field the editor refuses to save without
//  4. instant was an invisible sticky firm state with no control
const puppeteer = require('puppeteer-core');
const path = require('path');
const APP = 'file:///' + path.resolve(__dirname, '../dist/PropEdgeLab2.html').replace(/\\/g, '/');
function fail(m) { console.error('FAIL: ' + m); process.exitCode = 1; }
function ok(m) { console.log('ok - ' + m); }

function seedTrades() {
  const out = [];
  for (let i = 0; i < 12; i++) {
    out.push({
      id: 'sf' + i, createdAt: 1750000000000 + i * 1000,
      dateTime: '2026-07-' + String(1 + i).padStart(2, '0') + 'T09:15',
      instrument: 'ES', account: 'Main', direction: 'long', session: 'New York',
      setup: 'ORB', entryModel: '', entry: null, stop: null, target: null, exit: null,
      size: null, riskAmt: 100, pnl: (i % 2 ? 1 : -1) * 100, fees: null,
      R: (i % 2 ? 1 : -1), Rmanual: true, pnlManual: false, followedPlan: true,
      tags: { quality: '', mistake: [], condition: [] }, emotionBefore: 2, emotionAfter: 2,
      planText: '', notes: '', imageIds: [], exitTime: null, mfe: null, mae: null,
    });
  }
  return out;
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new',
    userDataDir: path.resolve('./pel-test/profile-scanfixes-' + process.pid),
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--edge-skip-compat-layer-relaunch'],
  });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => { try { if (localStorage.getItem('pel_prop') == null) localStorage.setItem('pel_prop', 'true'); } catch (e) { /* opaque origin */ } });  // these suites exercise prop-firm mode
  await page.setViewport({ width: 1400, height: 950 });
  page.on('pageerror', (e) => fail('pageerror: ' + e.message));
  page.on('dialog', (d) => d.dismiss());
  await page.goto(APP, { waitUntil: 'load' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 20000 });
  await page.evaluate(async (trades) => {
    localStorage.setItem('pel_jmeta', JSON.stringify({
      startBalance: null, accounts: ['Main'], balances: { Main: 50000 },
    }));
    localStorage.setItem('pel_acct', JSON.stringify('Main'));
    const db = await new Promise((res, rej) => {
      const rq = indexedDB.open('propEdgeLab', 1);
      rq.onsuccess = (e) => res(e.target.result); rq.onerror = rej;
    });
    await new Promise((res) => {
      const tx = db.transaction('trades', 'readwrite'), os = tx.objectStore('trades');
      os.clear(); trades.forEach((t) => os.put(t)); tx.oncomplete = res;
    });
  }, seedTrades());
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 20000 });
  await page.evaluate(() => {
    if (!document.getElementById('askOv').classList.contains('hide')) {
      const b = [...document.querySelectorAll('#askBtns button')].find((x) => /later/i.test(x.textContent));
      if (b) b.click();
    }
    document.querySelector('[data-mode="journal"]').click();
  });
  const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms));
  await settle(800);

  // ---------- 1. bulk delete counts only the selection it can show ----------
  await page.evaluate(() => {
    document.getElementById('jSelMode').click();       // Select mode
    document.getElementById('jSelAll').click();        // tick all 12
  });
  await settle();
  let del = await page.$eval('#jDelSel', (e) => ({ text: e.textContent, hidden: e.classList.contains('hide') }));
  if (del.text !== 'Delete (12)') fail('select-all should arm 12: ' + del.text);
  else ok('select-all arms all 12 visible trades');
  // filter to a session with no trades: every ticked row is now hidden
  await page.evaluate(() => {
    const s = document.getElementById('fltSess');
    s.value = 'Asia';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
  del = await page.$eval('#jDelSel', (e) => ({ text: e.textContent, hidden: e.classList.contains('hide') }));
  if (!del.hidden) fail('12 hidden rows must not stay armed: ' + JSON.stringify(del));
  else ok('a filter that hides every ticked row disarms the delete button');
  const emptyMsg = await page.$eval('#jv-log', (e) => e.innerText);
  if (!/No trades match/i.test(emptyMsg)) fail('a session-only filter must read as a filter, not an empty account: ' + emptyMsg.slice(0, 90));
  else ok('and the empty state blames the filter, not the account');
  // clear the filter: the parked selection comes back, nothing was lost
  await page.evaluate(() => {
    const s = document.getElementById('fltSess');
    s.value = '';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
  del = await page.$eval('#jDelSel', (e) => ({ text: e.textContent, hidden: e.classList.contains('hide') }));
  if (del.text !== 'Delete (12)' || del.hidden) fail('lifting the filter should re-arm the parked selection: ' + JSON.stringify(del));
  else ok('lifting the filter re-arms the parked ticks');
  await page.evaluate(() => document.getElementById('jSelMode').click());   // leave select mode

  // ---------- 2. $ per R <-> % of start converts, never reinterprets ----------
  await page.evaluate(() => document.getElementById('jDollarBtn').click());
  await settle();
  await page.evaluate(() => {
    const v = document.getElementById('jRVal');
    v.value = '500';
    v.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle(600);   // the input handler debounces 350ms
  await page.evaluate(() => document.getElementById('jRModePct').click());
  await settle(600);
  const pct = await page.$eval('#jRVal', (e) => e.value);
  if (pct !== '1') fail('$500 on a $50,000 start must convert to 1%: got "' + pct + '"');
  else ok('$500 per R converts to 1% of start (not 500%)');
  await page.evaluate(() => document.getElementById('jRModeFixed').click());
  await settle(600);
  const back = await page.$eval('#jRVal', (e) => e.value);
  if (back !== '500') fail('converting back must round-trip: got "' + back + '"');
  else ok('and converts back to $500 exactly');

  // ---------- 4. instant is visible and escapable ----------
  await page.evaluate(() => { document.querySelector('[data-mode="sim"]').click(); });
  await settle();
  const inst = await page.evaluate(() => {
    const el = document.getElementById('fInstant');
    if (!el) return null;
    el.value = '1';
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { sum: document.getElementById('firmSum').innerText, val: el.value };
  });
  if (!inst) fail('#fInstant control is missing from the firm form');
  else if (!/instant funding/i.test(inst.sum)) fail('firmSum must disclose instant: ' + inst.sum);
  else ok('instant funding is a visible form control and the firm summary names it');
  await page.evaluate(() => {
    const el = document.getElementById('fInstant');
    el.value = '0';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
  const off = await page.evaluate(() => ({
    sum: document.getElementById('firmSum').innerText,
    saved: (JSON.parse(localStorage.getItem('pel_sim') || '{}').F || {}).instant,
  }));
  if (/instant funding/i.test(off.sum) || off.saved === true) fail('instant must be escapable: ' + JSON.stringify(off));
  else ok('and switching it off actually clears it, including in the save');

  await browser.close();
  if (!process.exitCode) console.log('\nAll scan-fix checks passed.');
})().catch((e) => { fail(e.stack || e.message); process.exit(1); });
