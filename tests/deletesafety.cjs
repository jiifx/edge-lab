// Deleting is bounded by what is on screen and can be undone:
// - Select All picks only trades drawn in the log (folded days are not drawn)
// - a bulk delete offers Undo, and Undo restores every trade
const puppeteer = require('puppeteer-core');
const path = require('path');
const { pathToFileURL } = require('url');

const APP = pathToFileURL(path.resolve(__dirname, '../dist/PropEdgeLab2.html')).href;
const SAMPLE = path.resolve(__dirname, '../samples/sample-1000-trades.json');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => { console.log('FAIL: ' + m); process.exitCode = 1; };
const ok = (m) => console.log('ok: ' + m);

(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new', userDataDir: path.resolve('./pel-test/delsafe-' + process.pid),
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--edge-skip-compat-layer-relaunch'],
  });
  const page = await b.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(APP, { waitUntil: 'load' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 25000 });
  await page.evaluate(() => document.querySelector('[data-mode="journal"]').click());
  const inp = await page.$('#jImportFile');
  await inp.uploadFile(SAMPLE);
  await wait(5000);
  const count = () => page.evaluate(() => document.getElementById('jSummary').querySelector('.tile .v').textContent.trim());
  if ((await count()) !== '1000') fail('the sample did not import 1000 trades: ' + (await count()));

  // ---------- 1. Select All = what is drawn ----------
  await page.evaluate(() => { document.getElementById('jSelMode').click(); document.getElementById('jSelAll').click(); });
  await wait(400);
  const sel = await page.evaluate(() => ({ drawn: document.querySelectorAll('.tradecard').length, btn: document.getElementById('jDelSel').textContent }));
  const n = Number((sel.btn.match(/\d+/) || [])[0]);
  if (n !== sel.drawn) fail('Select All picked ' + n + ' but only ' + sel.drawn + ' trades are drawn (folded days must not be selectable)');
  else ok('Select All picked the ' + n + ' drawn trades, not the 1000 in the journal');

  // ---------- 2. delete, then Undo ----------
  await page.evaluate(() => document.getElementById('jDelSel').click());
  await wait(300);
  await page.evaluate(() => { const x = [...document.querySelectorAll('#askBtns button')].find((e) => /delete/i.test(e.textContent)); x.click(); });
  await wait(1500);
  const after = await count();
  if (Number(after) !== 1000 - n) fail('after deleting ' + n + ' the journal holds ' + after);
  else ok('deleted ' + n + ', ' + after + ' remain');
  const undo = await page.$('#toast .toastbtn');
  if (!undo) { fail('no Undo offered after a delete'); }
  else {
    await undo.click();
    await wait(1500);
    const back = await count();
    if (back !== '1000') fail('Undo restored to ' + back + ', not 1000');
    else ok('Undo restored all 1000 trades');
  }
  // and the restore survives a reload (it was persisted, not just drawn)
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 25000 });
  await page.evaluate(() => document.querySelector('[data-mode="journal"]').click());
  await wait(1500);
  if ((await count()) !== '1000') fail('the undone delete did not survive a reload: ' + (await count()));
  else ok('the restored trades survive a reload');

  if (errs.length) fail('page errors: ' + errs.join(' | '));
  await b.close();
  console.log(process.exitCode ? 'DELETESAFETY: FAILURES' : 'DELETESAFETY: ALL PASS');
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
