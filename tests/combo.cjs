// The setup / entry-model combobox.
//
// These two fields were <input list=...> + <datalist>. A datalist popup is drawn
// by the BROWSER - proportional font, its own row height, its own background -
// and no author CSS reaches any of it, so beside the themed <select>s for
// session, account and direction it read as a different application.
//
// The contract this pins is not "it looks nice". It is:
//   1. no <datalist> survives anywhere, or the browser draws its own popup again;
//   2. the rows are in the app's OWN mono, which is the whole point;
//   3. IT IS STILL A TEXT INPUT - a value that is not in the list is kept
//      exactly as typed, because a setup you have never used is the normal case
//      for a trader trying something new;
//   4. Escape closes the LIST, not the editor, so a half-typed trade is never
//      thrown away by reaching for the suggestion list;
//   5. the popup never pushes the page sideways.
const puppeteer = require('puppeteer-core');
const path = require('path');
const APP = 'file:///' + path.resolve(__dirname, '../dist/PropEdgeLab2.html').replace(/\\/g, '/');
const DIR = 'pel-test/';
let bad = 0;
const fail = (m) => { console.error('FAIL: ' + m); bad = 1; };
const ok = (m) => console.log('ok: ' + m);

const SETUPS = ['9:30 Candle Continuation', 'CISD + IFVG', 'IFVG + Displacement', 'VWAP Pullback Continuation'];
function seed() {
  return SETUPS.map((s, i) => ({
    id: 'cb' + i, createdAt: 1750000000000 + i * 1000,
    dateTime: '2026-06-0' + (i + 1) + 'T09:15', exitTime: '2026-06-0' + (i + 1) + 'T10:05',
    instrument: 'ES', account: 'Main', direction: 'long', session: 'New York',
    setup: s, entryModel: s,
    entry: null, stop: null, target: null, exit: null, size: null,
    riskAmt: 250, pnl: 250, fees: null, R: 1, Rmanual: true, pnlManual: false,
    tags: { quality: '', mistake: [], condition: [] },
    emotionBefore: 2, emotionAfter: 2, followedPlan: true,
    planText: '', notes: '', imageIds: [], mfeR: null, maeR: null, mfe: null, mae: null, mfeD: null, maeD: null,
  }));
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new',
    userDataDir: path.resolve('./pel-test/profile-combo-' + process.pid),
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--edge-skip-compat-layer-relaunch'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 1000 });
  page.on('pageerror', e => fail('pageerror: ' + e.message));
  await page.goto(APP, { waitUntil: 'load' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 20000 });
  await page.evaluate(async (trades) => {
    localStorage.setItem('pel_acct', JSON.stringify('Main'));
    localStorage.setItem('pel_jmeta', JSON.stringify({ accounts: ['Main'], balances: { Main: 50000 }, rBasis: { Main: { mode: 'fixed', v: 250 } } }));
    const db = await new Promise((res, rej) => { const rq = indexedDB.open('propEdgeLab', 1); rq.onsuccess = e => res(e.target.result); rq.onerror = rej; });
    await new Promise((res) => { const tx = db.transaction('trades', 'readwrite'), os = tx.objectStore('trades'); os.clear(); trades.forEach(t => os.put(t)); tx.oncomplete = res; });
  }, seed());
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 20000 });

  // open the trade editor
  await page.evaluate(() => { document.querySelector('[data-mode="journal"]').click(); });
  await page.evaluate(() => document.getElementById('jNew').click());
  await new Promise(r => setTimeout(r, 500));

  // 1. no datalist survives anywhere
  const dl = await page.evaluate(() => document.querySelectorAll('datalist').length);
  if (dl) fail(dl + ' <datalist> still in the DOM - the browser will draw its own popup'); else ok('no datalist left');

  // 2. focusing the field opens a themed popup with every past value
  await page.focus('#edModel');
  await new Promise(r => setTimeout(r, 250));
  const opened = await page.evaluate(() => {
    const p = document.getElementById('cbModelPop');
    const opts = [...p.querySelectorAll('.cbopt')].map(b => b.textContent);
    const cs = getComputedStyle(p.querySelector('.cbopt'));
    return { hidden: p.hidden, opts, font: cs.fontFamily, size: cs.fontSize, expanded: document.getElementById('edModel').getAttribute('aria-expanded') };
  });
  if (opened.hidden) fail('popup did not open on focus');
  else if (opened.opts.length !== 4) fail('expected 4 past models, got ' + JSON.stringify(opened.opts));
  else ok('opens on focus with ' + opened.opts.length + ' past values');
  if (!/mono|consolas|courier/i.test(opened.font)) fail('popup is not in the app mono: ' + opened.font);
  else ok('rows use the app mono at ' + opened.size + ' (' + opened.font.split(',')[0] + ')');
  if (opened.expanded !== 'true') fail('aria-expanded not set');

  await page.screenshot({ path: DIR + 'combo-open.png', clip: { x: 0, y: 0, width: 900, height: 460 } });

  // 3. typing filters, and free text survives
  await page.type('#edModel', 'ifvg');
  await new Promise(r => setTimeout(r, 250));
  const filtered = await page.evaluate(() => [...document.querySelectorAll('#cbModelPop .cbopt')].map(b => b.textContent));
  if (filtered.length !== 2) fail('substring filter expected 2 rows for "ifvg", got ' + JSON.stringify(filtered));
  else ok('typing filters by substring, not prefix: ' + JSON.stringify(filtered));

  await page.screenshot({ path: DIR + 'combo-filtered.png', clip: { x: 0, y: 0, width: 900, height: 460 } });

  // 4. keyboard: down to the first row, Enter picks it
  await page.keyboard.press('ArrowDown');
  await new Promise(r => setTimeout(r, 120));
  await page.keyboard.press('Enter');
  await new Promise(r => setTimeout(r, 200));
  const picked = await page.evaluate(() => ({ v: document.getElementById('edModel').value, hidden: document.getElementById('cbModelPop').hidden }));
  if (picked.v !== 'CISD + IFVG') fail('Enter picked "' + picked.v + '"');
  else ok('ArrowDown + Enter picks the highlighted row');
  if (!picked.hidden) fail('popup stayed open after picking');

  // 5. a value that is NOT in the list must survive - this is still a text input
  await page.evaluate(() => { const e = document.getElementById('edModel'); e.value = ''; e.focus(); });
  await page.type('#edModel', 'Brand new model nobody has used');
  await new Promise(r => setTimeout(r, 250));
  const freeText = await page.evaluate(() => ({
    v: document.getElementById('edModel').value,
    none: !!document.querySelector('#cbModelPop .cbnone'),
  }));
  if (freeText.v !== 'Brand new model nobody has used') fail('free text was mangled: ' + freeText.v);
  else ok('a value not in the list is kept exactly as typed');
  if (!freeText.none) fail('no "nothing matches" line shown');

  // 6. Escape closes the list, and does NOT close the editor
  await page.keyboard.press('Escape');
  await new Promise(r => setTimeout(r, 250));
  const esc = await page.evaluate(() => ({
    pop: document.getElementById('cbModelPop').hidden,
    editorOpen: !document.getElementById('editorOv').classList.contains('hide'),
  }));
  if (!esc.pop) fail('Escape did not close the list');
  else if (!esc.editorOpen) fail('Escape closed the whole editor and threw the trade away');
  else ok('Escape closes the list first, editor second');

  // 7. clicking the chevron opens it too
  await page.evaluate(() => document.getElementById('edSetup').blur());
  await new Promise(r => setTimeout(r, 250));
  await page.click('#cbSetupTog');
  await new Promise(r => setTimeout(r, 250));
  const viaTog = await page.evaluate(() => !document.getElementById('cbSetupPop').hidden);
  if (!viaTog) fail('the chevron did not open the setup list'); else ok('the chevron opens it');

  // 8. and the popup does not push the page sideways
  const over = await page.evaluate(() => document.body.scrollWidth > document.documentElement.clientWidth + 1);
  if (over) fail('the open popup makes the page scroll sideways'); else ok('no page overflow with the popup open');

  await page.screenshot({ path: DIR + 'combo-setup.png', clip: { x: 0, y: 0, width: 900, height: 460 } });
  await browser.close();
  console.log(bad ? 'COMBO: FAILURES' : 'COMBO: ALL PASS');
  process.exitCode = bad;
})();
