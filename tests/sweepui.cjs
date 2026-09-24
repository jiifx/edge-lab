// The target sweep's two data-entry paths, driven in the app.
//
//   1. BACKFILL. A journal kept in Risk $ and R has no planned target on any
//      trade, and opening thirty of them by hand is not a fix. The panel offers
//      one field and one button, scoped to the ACCOUNT rather than the log
//      filter, and it only ever fills trades that have none.
//   2. THE MISTYPED PLAN. The likeliest wrong entry is the MFE in the target
//      box, because that is the number a trader has been staring at. It has to
//      announce itself rather than inflate every figure underneath.
const puppeteer = require('puppeteer-core');
const path = require('path');
const APP = 'file:///' + path.resolve(__dirname, '../dist/PropEdgeLab2.html').replace(/\\/g, '/');
let bad = 0;
const fail = (m) => { console.error('FAIL: ' + m); bad = 1; };
const ok = (m) => console.log('ok: ' + m);

// an R-first record: Risk $ and a manual R, no prices anywhere
function seed(n, opts) {
  let s = 4242; const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const out = [];
  for (let i = 0; i < n; i++) {
    const won = rnd() < 0.45;
    const R = won ? (opts.winR || 1.5) : -1;
    const day = String(1 + (i % 20)).padStart(2, '0');
    out.push({
      id: 'sw' + i, createdAt: 1750000000000 + i * 1000,
      dateTime: '2026-06-' + day + 'T09:15', exitTime: '2026-06-' + day + 'T10:05',
      instrument: 'NQ', account: 'Main', direction: 'long', session: 'New York',
      setup: 'ORB', entryModel: 'CISD + IFVG',
      entry: null, stop: null, target: null, exit: null, size: null,
      riskAmt: 250, pnl: Math.round(R * 250), fees: null,
      R, Rmanual: true, pnlManual: false,
      tags: { quality: '', mistake: [], condition: [] },
      emotionBefore: 3, emotionAfter: 3, followedPlan: true,
      planText: '', notes: '', imageIds: [],
      mfeR: null, maeR: null, mfe: null, mae: null, mfeD: null, maeD: null,
      rrR: opts.rrR == null ? null : opts.rrR,
      runR: opts.runOnWinners && won ? +(2.2 + rnd() * 3.5).toFixed(2) : null,
    });
  }
  return out;
}

async function load(page, trades) {
  await page.goto(APP, { waitUntil: 'load' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 20000 });
  await page.evaluate(async (ts) => {
    localStorage.setItem('pel_acct', JSON.stringify('Main'));
    localStorage.setItem('pel_stats_tab', JSON.stringify('perf'));
    localStorage.setItem('pel_jmeta', JSON.stringify({
      accounts: ['Main'], balances: { Main: 50000 }, rBasis: { Main: { mode: 'fixed', v: 250 } },
    }));
    const db = await new Promise((res, rej) => { const rq = indexedDB.open('propEdgeLab', 1); rq.onsuccess = e => res(e.target.result); rq.onerror = rej; });
    await new Promise((res) => { const tx = db.transaction('trades', 'readwrite'), os = tx.objectStore('trades'); os.clear(); ts.forEach(t => os.put(t)); tx.oncomplete = res; });
  }, trades);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 20000 });
  await page.evaluate(() => {
    document.querySelector('[data-mode="journal"]').click();
    document.querySelector('.subnav button[data-jview="stats"]').click();
    document.querySelector('[data-stat="perf"]').click();
  });
  await new Promise(r => setTimeout(r, 1600));
}
const sweepText = (page) => page.evaluate(() => document.getElementById('tgtSweep').innerText);

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new',
    userDataDir: path.resolve('./pel-test/sweepui-' + process.pid),
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--edge-skip-compat-layer-relaunch'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1100 });
  page.on('pageerror', e => fail('pageerror: ' + e.message));

  // ---------- 1. an R-first record offers the backfill ----------
  await load(page, seed(40, { rrR: null, runOnWinners: true }));
  let t = await sweepText(page);
  if (!/Nothing to sweep yet/i.test(t)) fail('a record with no planned target should say so; got: ' + t.slice(0, 90));
  else ok('an R-first record still reports "nothing to sweep"');
  const hasFill = await page.evaluate(() => !!document.getElementById('rrFill') && !!document.getElementById('rrFillV'));
  if (!hasFill) fail('the backfill control is missing on the very record that needs it');
  else ok('the backfill control is offered alongside the refusal');

  // ---------- 2. it fills, and the panel moves on ----------
  await page.evaluate(() => { document.getElementById('rrFillV').value = '1.5'; document.getElementById('rrFill').click(); });
  await new Promise(r => setTimeout(r, 400));
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#askBtns button')].find(x => /^Set on/.test(x.textContent));
    if (b) b.click();
  });
  await new Promise(r => setTimeout(r, 2200));
  t = await sweepText(page);
  if (/Nothing to sweep yet/i.test(t)) fail('after the backfill the panel still says nothing to sweep');
  else ok('one field and one button moved a 40-trade record past the gate');
  const stored = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const rq = indexedDB.open('propEdgeLab', 1); rq.onsuccess = e => res(e.target.result); rq.onerror = rej; });
    const all = await new Promise((res) => { const rq = db.transaction('trades').objectStore('trades').getAll(); rq.onsuccess = e => res(e.target.result); });
    return { total: all.length, withRr: all.filter(x => x.rrR === 1.5).length };
  });
  if (stored.withRr !== stored.total) fail('backfill wrote ' + stored.withRr + ' of ' + stored.total + ' trades');
  else ok('all ' + stored.total + ' trades persisted with the typed R:R');

  // ---------- 3. nothing left to fill, but a wrong value must still be fixable ----------
  const after = await page.evaluate(() => ({
    fill: !!document.getElementById('rrFill'),
    replace: !!document.getElementById('rrReplace'),
  }));
  if (after.fill) fail('the safe "set on those with none" button is still offered when nothing is missing');
  else if (!after.replace) fail('no way to CORRECT a planned R:R once every trade has one - the exact corner the user got stuck in');
  else ok('the fill button retires and the replace button takes over');

  // ---------- 3b. replace actually overwrites ----------
  await page.evaluate(() => { document.getElementById('rrFillV').value = '2.5'; document.getElementById('rrReplace').click(); });
  await new Promise(r => setTimeout(r, 400));
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#askBtns button')].find(x => /^Replace on/.test(x.textContent));
    if (b) b.click();
  });
  await new Promise(r => setTimeout(r, 2000));
  const rep = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const rq = indexedDB.open('propEdgeLab', 1); rq.onsuccess = e => res(e.target.result); rq.onerror = rej; });
    const all = await new Promise((res) => { const rq = db.transaction('trades').objectStore('trades').getAll(); rq.onsuccess = e => res(e.target.result); });
    return { total: all.length, at25: all.filter(x => x.rrR === 2.5).length };
  });
  if (rep.at25 !== rep.total) fail('replace wrote ' + rep.at25 + ' of ' + rep.total);
  else ok('replace overwrote all ' + rep.total + ' trades, so a mistyped plan is recoverable');

  // ---------- 4. the MFE in the target box announces itself ----------
  await load(page, seed(40, { rrR: 4, winR: 1.5, runOnWinners: false }));
  t = await sweepText(page);
  if (!/does not match how these trades ended/i.test(t)) {
    fail('a 4R plan on a record that exits at 1.5R must be flagged, not priced. Got: ' + t.slice(0, 160));
  } else if (!/MFE/.test(t)) {
    fail('the warning should name the likely mix-up (the MFE in the target box)');
  } else {
    ok('a planned R:R most winners never reached is called out before any number is drawn');
  }
  if (/FLAT TOP|WHERE IT PEAKS/i.test(t)) fail('it drew a sweep anyway on a record whose plan is wrong');
  else ok('and no curve is drawn from it');

  // ---------- 5. a mixed book sweeps from the LOWEST target ----------
  // big enough to clear the 20-logged-run gate; the point of this case is the
  // FLOOR, and a fixture that trips an earlier gate tests nothing about it
  const mixed = seed(80, { rrR: 1.5, winR: 1.5, runOnWinners: true })
    .concat(seed(16, { rrR: 4, winR: 4, runOnWinners: true }).map((t, i) => ({ ...t, id: 'mx' + i })));
  await load(page, mixed);
  t = await sweepText(page);
  if (!/1\.50R/.test(t)) fail('a book whose habit is 1.5R must sweep from 1.5R even with bigger targets in it. Got: ' + t.slice(0, 200));
  else ok('a mixed book starts at its lowest target, not its highest');
  if (!/Mixed targets/i.test(t)) fail('a changing population has to be declared');
  else ok('and it says the population moves as the target rises');

  await browser.close();
  console.log(bad ? 'SWEEP UI: FAILURES' : 'SWEEP UI: ALL PASS');
  process.exitCode = bad;
})();
