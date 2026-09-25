// The dollar layer. R is the unit of record; dollars are derived, opt-in, and
// only appear once an account says what one R is worth.
//
// The bug this pins: stats() used to sum t.pnl alone, so a journal kept in R
// reported a Balance built from whichever trades happened to carry a P&L. On the
// record that prompted it that was 14 of 72 trades - a headline balance ~60% low,
// with nothing on screen saying so. The same silence emptied the rule guard,
// which prices every meter in dollars and simply skipped the trades it could not
// price, reporting near-full drawdown headroom on an account sitting on its floor.
const puppeteer = require('puppeteer-core');
const path = require('path');
const APP = 'file:///' + path.resolve(__dirname, '../dist/PropEdgeLab2.html').replace(/\\/g, '/');
function fail(m){ console.error('FAIL: ' + m); process.exitCode = 1; }
const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: 'new', userDataDir: path.resolve('./pel-test/profile-rvalue-' + Date.now()), args: ['--no-sandbox','--disable-gpu','--allow-file-access-from-files', '--edge-skip-compat-layer-relaunch'] });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => { try { if (localStorage.getItem('pel_prop') == null) localStorage.setItem('pel_prop', 'true'); } catch (e) { /* opaque origin */ } });  // these suites exercise prop-firm mode
  await page.setViewport({ width: 1500, height: 1200 });
  page.on('pageerror', e => fail('pageerror: ' + e.message));
  await page.goto(APP, { waitUntil: 'load' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 15000 });
  await page.click('[data-mode="journal"]');

  // log a trade in R only: a manual R, no P&L, no risk $ - the shape this is about
  async function logR(r) {
    await page.click('#jNew');
    await page.evaluate((v) => {
      const set = (id, val) => { const e = document.getElementById(id); e.value = val; e.dispatchEvent(new Event('input', { bubbles: true })); };
      document.getElementById('edSymSel').value = 'MNQ';
      document.getElementById('edSess').value = 'London';   // required on save
      set('edRisk', ''); set('edPnl', ''); set('edR', String(v));
    }, r);
    await page.click('#edSave');
    await page.waitForFunction('document.getElementById("editorOv").classList.contains("hide")', { timeout: 5000 });
  }
  async function newAccount(name) {
    await page.click('#jNewAcct');
    await page.waitForFunction('!document.getElementById("askOv").classList.contains("hide")', { timeout: 3000 });
    await page.evaluate((n) => { document.getElementById('acctName').value = n; }, name);
    const btns = await page.$$('#askBtns button');
    await btns[btns.length - 1].click();
    await wait(250);
  }
  const summary = () => page.$eval('#jSummary', e => e.textContent);
  const eqPanel = () => page.$eval('#jEqLine', e => e.textContent);

  await newAccount('RUnits');
  // +2R, -1R, +3R = +4R total. At $50/R that is $200 on a $1,000 start.
  await logR(2); await logR(-1); await logR(3);

  // --- 1. an R-only journal shows R, and NO dollars at all -------------------
  const s0 = await summary();
  if (!s0.includes('+4.0')) fail('Total R wrong before any dollar basis: ' + s0.slice(0, 200));
  else console.log('ok: Total R reads +4.0 with no dollar basis set');
  if (/\$/.test(s0)) fail('dollar figures shown with no basis for them: ' + s0.slice(0, 200));
  else console.log('ok: no dollar tile is drawn at all until an R value exists');
  const eq0 = await eqPanel();
  if (!eq0.includes('+4.0R') || !eq0.includes('peak')) fail('equity panel not in R: ' + eq0);
  else console.log('ok: equity panel reads +4.0R with its peak');

  // --- 2. the rule guard refuses to draw meters it cannot price --------------
  await page.click('#rgBind');
  await wait(400);
  const rg0 = await page.$eval('#rgBody', e => e.textContent);
  if (!rg0.includes('No dollar basis')) fail('rule guard drew meters with no dollar basis: ' + rg0.slice(0, 220));
  else console.log('ok: bound rule guard refuses to draw meters off zero dollars');
  const meters0 = await page.$$eval('#rgBody .meter', els => els.length);
  if (meters0 !== 0) fail('rule guard drew ' + meters0 + ' meters from unpriceable trades');
  else console.log('ok: zero meters drawn - headroom is not reported as full');

  // --- 3. set the R value: dollars appear, R does not move -------------------
  await page.evaluate(() => {
    const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); };
    if (document.getElementById('jDollarBox').classList.contains('hide')) document.getElementById('jDollarBtn').click();
    set('jStartBal', '1000'); set('jRVal', '50');
  });
  await wait(700);
  const s1 = await summary();
  if (!s1.includes('+4.0')) fail('Total R moved when the R value was set: ' + s1.slice(0, 200));
  else console.log('ok: Total R is unchanged - the R layer never moves for a dollar setting');
  if (!s1.includes('$200')) fail('Total P&L should be $200 (4R x $50): ' + s1.slice(0, 250));
  else console.log('ok: Total P&L $200 = 4R at $50');
  if (!s1.includes('$1,200')) fail('Balance should be $1,200 (start 1000 + 200): ' + s1.slice(0, 250));
  else console.log('ok: Balance $1,200 = start + every R priced');
  if (!s1.includes('+20.0%')) fail('Return should be +20.0%: ' + s1.slice(0, 250));
  else console.log('ok: Return +20.0%');
  const bal1 = await page.$eval('#jBalLine', e => e.textContent);
  if (!bal1.includes('3 of 3 trades priced')) fail('provenance line wrong: ' + bal1);
  else console.log('ok: provenance line says 3 of 3 priced');

  // --- 4. the meters go live ------------------------------------------------
  const meters1 = await page.$$eval('#rgBody .meter', els => els.length);
  if (meters1 < 2) fail('rule guard still has no meters after the R value was set: ' + meters1);
  else console.log('ok: rule guard drew ' + meters1 + ' live meters once trades could be priced');
  const rg1 = await page.$eval('#rgBody', e => e.textContent);
  if (rg1.includes('not in these meters')) fail('rule guard still reports skipped trades: ' + rg1.slice(0, 200));
  else console.log('ok: no trades skipped by the guard');

  // --- 5. a partly-priced scope names the gap instead of a total ------------
  // one trade resolved by an exit price alone: no P&L, no stop, so no R to price
  await page.click('#jNew');
  await page.evaluate(() => {
    const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); };
    document.getElementById('edSymSel').value = 'MNQ';
    document.getElementById('edSess').value = 'London';   // required on save
    set('edRisk', ''); set('edPnl', ''); set('edR', ''); set('edExit', '21050');
  });
  await page.click('#edSave');
  await page.waitForFunction('document.getElementById("editorOv").classList.contains("hide")', { timeout: 5000 });
  await wait(300);
  const s2 = await summary();
  if (s2.includes('$1,200')) fail('Balance still printed while a trade is unpriced: ' + s2.slice(0, 250));
  else console.log('ok: Balance withdrawn once the record stopped being fully priced');
  if (!s2.includes('1 of 4 unpriced')) fail('gap not named: ' + s2.slice(0, 250));
  else console.log('ok: the tile names the gap - "1 of 4 unpriced"');
  const rg2 = await page.$eval('#rgBody', e => e.textContent);
  if (!rg2.includes('not in these meters') || !rg2.includes('optimistic')) fail('rule guard gap not warned: ' + rg2.slice(0, 300));
  else console.log('ok: rule guard warns the meters are optimistic, not a muted footnote');

  // --- 6. an R value buys dollars, never an edge ----------------------------
  const edge = await page.evaluate(() => {
    const tiles = [...document.querySelectorAll('#jSummary .tile')].map(t => t.textContent);
    return tiles.filter(t => /Expectancy|Win rate/.test(t)).join(' | ');
  });
  await page.evaluate(() => {
    const e = document.getElementById('jRVal');
    e.value = '500'; e.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await wait(600);
  const edge2 = await page.evaluate(() => {
    const tiles = [...document.querySelectorAll('#jSummary .tile')].map(t => t.textContent);
    return tiles.filter(t => /Expectancy|Win rate/.test(t)).join(' | ');
  });
  if (edge !== edge2) fail('changing the R value moved the edge statistics: ' + edge + ' -> ' + edge2);
  else console.log('ok: a 10x R value leaves expectancy and win rate untouched');

  // --- 7. it survives a reload (the accountPhase-class allowlist bug) -------
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 15000 });
  await wait(400);
  const rv = await page.$eval('#jRVal', e => e.value);
  if (rv !== '500') fail('R value lost on reload (check the loadTrades meta allowlist): got "' + rv + '"');
  else console.log('ok: the R value survives a reload');
  const open = await page.$eval('#jDollarBox', e => !e.classList.contains('hide'));
  if (!open) fail('dollar panel collapsed on reload, hiding a configured setting');
  else console.log('ok: the dollar panel stays open for an account that has one');

  // --- 8. a backup carries the R value, and a hostile one cannot poison it ---
  const fs = require('fs');
  const os = require('os');
  const bak = path.join(os.tmpdir(), 'pel-rbasis-import-' + Date.now() + '.json');
  fs.writeFileSync(bak, JSON.stringify({
    app: 'prop-edge-lab', version: 3,
    meta: {
      accounts: ['Imported'], balances: { Imported: 25000 },
      rBasis: {
        Imported: { mode: 'fixed', v: 250 },
        Bad1: { mode: 'nonsense', v: 10 },      // unknown mode -> dropped
        Bad2: { mode: 'fixed', v: -5 },         // non-positive -> dropped
        Bad3: 'not an object',                  // wrong shape -> dropped
        __proto__: { mode: 'fixed', v: 999 },   // prototype pollution -> refused
      },
    },
    trades: [{ id: 'imp1', account: 'Imported', dateTime: '2026-07-20T09:30', instrument: 'ES', direction: 'long', session: '', setup: '',
      entry: null, stop: null, target: null, exit: null, size: null, riskAmt: null, pnl: null, fees: null,
      R: 4, Rmanual: true, followedPlan: true, planText: '', notes: '',
      tags: { quality: '', mistake: [], condition: [] }, emotionBefore: 0, emotionAfter: 0, imageIds: [] }],
    images: [],
  }));
  const imp = await page.$('#jImportFile');
  await imp.uploadFile(bak);
  await wait(900);
  const askOpen = await page.$eval('#askOv', e => !e.classList.contains('hide')).catch(() => false);
  if (askOpen) { const bs = await page.$$('#askBtns button'); await bs[bs.length - 1].click(); }
  await wait(1200);
  await page.select('#jAcct', 'Imported');
  await wait(500);
  const impRv = await page.$eval('#jRVal', e => e.value);
  if (impRv !== '250') fail('imported R value lost (check the import allowlist): got "' + impRv + '"');
  else console.log('ok: an imported backup restores the R value');
  const impSum = await page.$eval('#jSummary', e => e.textContent);
  if (!impSum.includes('$1,000')) fail('imported trade not priced at 4R x $250: ' + impSum.slice(0, 200));
  else console.log('ok: the imported R-only trade prices to $1,000 (4R x $250)');
  const junk = await page.evaluate(() => {
    const b = window.__PEL_JMETA ? window.__PEL_JMETA.rBasis : null;
    return b ? Object.keys(b) : null;
  });
  const polluted = await page.evaluate(() => ({}).mode !== undefined || Object.prototype.mode !== undefined);
  if (polluted) fail('import polluted Object.prototype through rBasis');
  else console.log('ok: a hostile rBasis key cannot reach Object.prototype');
  if (junk && (junk.includes('Bad1') || junk.includes('Bad2') || junk.includes('Bad3')))
    fail('malformed rBasis entries were kept: ' + JSON.stringify(junk));
  else console.log('ok: malformed rBasis entries are dropped at the boundary');
  fs.unlinkSync(bak);

  await browser.close();
  console.log(process.exitCode ? 'RVALUE: FAIL' : 'RVALUE: ALL PASS');
})().catch(e => { console.error('crashed:', e.message); process.exit(1); });
