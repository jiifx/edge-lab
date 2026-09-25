// Regression: editing the exit price must move R after a trade has been saved.
// Every saved P&L used to be flagged hand-typed on reopen, which froze autoPnl()
// and pinned R to the stored pnl/risk forever.
const puppeteer = require('puppeteer-core');
const path = require('path');
const APP = 'file:///' + path.resolve(__dirname, '../dist/PropEdgeLab2.html').replace(/\\/g, '/');
function fail(m){ console.error('FAIL: ' + m); process.exitCode = 1; }

// the numbers from the reported trade
const ENTRY = 29131.8, STOP = 29120.62, TARGET = 29180.36, RISK = 12;
const NEW_EXIT = 29137.8;                       // +0.537R once per = 11.18
const EXPECTED_R = (NEW_EXIT - ENTRY) / (ENTRY - STOP);

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new',
    userDataDir: path.resolve('./pel-test/profile-pnl-' + Date.now()),
    args: ['--no-sandbox','--disable-gpu','--allow-file-access-from-files', '--edge-skip-compat-layer-relaunch'],
  });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => { try { if (localStorage.getItem('pel_prop') == null) localStorage.setItem('pel_prop', 'true'); } catch (e) { /* opaque origin */ } });  // these suites exercise prop-firm mode
  await page.setViewport({ width: 1400, height: 1000 });
  page.on('pageerror', e => fail('pageerror: ' + e.message));
  await page.goto(APP, { waitUntil: 'load' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 20000 });
  await page.click('.modenav button[data-mode="journal"]');

  const set = (id, v) => page.evaluate((id, v) => {
    const el = document.getElementById(id);
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, id, v);
  const chipR = () => page.$eval('#edRchip', e => parseFloat(e.textContent));
  const pnl = () => page.$eval('#edPnl', e => e.value);

  // --- log a losing trade: exit at the stop, P&L auto-fills to -1R ---
  await page.click('#jNew');
  await page.waitForSelector('#editorOv:not(.hide)', { timeout: 5000 });
  await page.select('#edSymSel', 'US100');
  await page.select('#edSess', 'London');    // session is required on save
  await set('edEntry', ENTRY); await set('edStop', STOP); await set('edTarget', TARGET);
  await set('edExit', STOP);   await set('edRisk', RISK);
  const rAtStop = await chipR();
  if (Math.abs(rAtStop + 1) > 0.02) fail('expected -1.00R with the exit at the stop, got ' + rAtStop);
  else console.log('ok: exit at stop -> ' + rAtStop.toFixed(2) + 'R, P&L auto ' + (await pnl()));
  await page.click('#edSave');
  await page.waitForSelector('#editorOv.hide', { timeout: 5000 });
  await page.waitForSelector('.tradecard', { timeout: 5000 });

  // --- reopen and correct the exit: R must follow ---
  await page.click('.tradecard');
  await page.waitForSelector('#detailOv:not(.hide)', { timeout: 5000 });
  await page.click('#dtEdit');
  await page.waitForSelector('#editorOv:not(.hide)', { timeout: 5000 });
  await set('edExit', NEW_EXIT);
  const rAfter = await chipR();
  if (Math.abs(rAfter - EXPECTED_R) > 0.02) fail('R did not follow the corrected exit: got ' + rAfter + ', expected ' + EXPECTED_R.toFixed(2));
  else console.log('ok: corrected exit -> ' + rAfter.toFixed(2) + 'R (P&L recomputed to ' + (await pnl()) + ')');

  // and it survives the save
  await page.click('#edSave');
  await page.waitForSelector('#editorOv.hide', { timeout: 5000 });
  await new Promise(r => setTimeout(r, 400));
  const cardR = await page.$eval('.tradecard .rpill', e => parseFloat(e.textContent));
  if (Math.abs(cardR - EXPECTED_R) > 0.02) fail('saved card shows ' + cardR + 'R, expected ' + EXPECTED_R.toFixed(2));
  else console.log('ok: saved trade card reads ' + cardR.toFixed(2) + 'R');

  // --- a hand-typed P&L still wins, and offers the way back ---
  await page.click('.tradecard');
  await page.waitForSelector('#detailOv:not(.hide)', { timeout: 5000 });
  await page.click('#dtEdit');
  await page.waitForSelector('#editorOv:not(.hide)', { timeout: 5000 });
  await set('edPnl', -30);                       // deliberate override
  const rTyped = await chipR();
  if (Math.abs(rTyped - (-30 / RISK)) > 0.02) fail('typed P&L ignored: chip reads ' + rTyped);
  else console.log('ok: typed P&L overrides the prices (' + rTyped.toFixed(2) + 'R)');
  const noteShown = await page.$eval('#edPnlNote', e => !e.classList.contains('hide') && e.textContent.trim().length > 0);
  if (!noteShown) fail('no mismatch notice shown while the typed P&L disagrees with the prices');
  else console.log('ok: mismatch notice surfaced');
  await page.click('#edPnlFix');
  await new Promise(r => setTimeout(r, 200));
  const rFixed = await chipR();
  if (Math.abs(rFixed - EXPECTED_R) > 0.02) fail('"Use the prices" did not restore price-derived R: ' + rFixed);
  else console.log('ok: "Use the prices" restores ' + rFixed.toFixed(2) + 'R');

  // a typed P&L must persist across save/reopen (not silently recomputed)
  await set('edPnl', -30);
  await page.click('#edSave');
  await page.waitForSelector('#editorOv.hide', { timeout: 5000 });
  await new Promise(r => setTimeout(r, 400));
  await page.click('.tradecard');
  await page.waitForSelector('#detailOv:not(.hide)', { timeout: 5000 });
  await page.click('#dtEdit');
  await page.waitForSelector('#editorOv:not(.hide)', { timeout: 5000 });
  const rReopened = await chipR();
  if (Math.abs(rReopened - (-30 / RISK)) > 0.02) fail('typed P&L lost across save: chip reads ' + rReopened);
  else console.log('ok: typed P&L survives save/reopen (' + rReopened.toFixed(2) + 'R)');

  if (process.exitCode !== 1) console.log('PNLRECALC: ALL PASS');
  await browser.close();
})().catch(e => { console.error('PNLRECALC crashed:', e); process.exitCode = 1; });
