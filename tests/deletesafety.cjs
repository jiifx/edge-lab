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

  // ---------- 3. Import -> Replace downloads a copy first, and Undo restores ----------
  const fs = require('fs');
  const dl = path.resolve('./pel-test/delsafe-dl-' + process.pid);
  fs.mkdirSync(dl, { recursive: true });
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl });
  const three = path.join(dl, 'three.csv');
  fs.writeFileSync(three, 'Date,R\n2025-01-02 09:30,1\n2025-01-03 09:30,-1\n2025-01-06 09:30,2\n');
  const clickAsk = (re) => page.evaluate((src) => { const x = [...document.querySelectorAll('#askBtns button')].find((e) => new RegExp(src, 'i').test(e.textContent)); if (x) x.click(); return !!x; }, re.source);
  await (await page.$('#jImportFile')).uploadFile(three);
  await wait(600);
  await clickAsk(/replace/);
  await wait(2500);
  let snap = null;
  for (let i = 0; i < 20 && !snap; i++) { snap = fs.readdirSync(dl).find((f) => /^edge-lab-before-replace-.*\.json$/.test(f)); if (!snap) await wait(250); }
  if (!snap) fail('Replace did not download a copy of the journal first');
  else {
    const n = JSON.parse(fs.readFileSync(path.join(dl, snap), 'utf-8')).trades.length;
    if (n !== 1000) fail('the copy saved before Replace holds ' + n + ' trades');
    else ok('Replace downloaded the old journal first (' + n + ' trades)');
  }
  if ((await count()) !== '3') fail('after Replace the journal holds ' + (await count()));
  const u3 = await page.$('#toast .toastbtn');
  if (!u3) fail('no Undo after Replace');
  else { await u3.click(); await wait(1500); if ((await count()) !== '1000') fail('Undo after Replace restored ' + (await count())); else ok('Undo after Replace restored all 1000'); }

  // ---------- 4. deleting an account can be undone ----------
  await page.evaluate(() => { const s = document.getElementById('jAcct'); s.value = [...s.options].find((o) => /Sample 50k/.test(o.textContent)).value; s.dispatchEvent(new Event('change', { bubbles: true })); });
  await wait(500);
  await page.evaluate(() => document.getElementById('jDelAcct').click());
  await wait(300);
  await clickAsk(/delete account/);
  await wait(1500);
  const u4 = await page.$('#toast .toastbtn');
  if (!u4) fail('no Undo after deleting an account');
  else { await u4.click(); await wait(1500); if ((await count()) !== '1000') fail('account Undo restored ' + (await count())); else ok('deleting an account can be undone'); }

  // ---------- 5. Merge never rewrites an existing account's settings ----------
  const other = path.join(dl, 'other.json');
  fs.writeFileSync(other, JSON.stringify({ meta: { accounts: ['Sample 50k'], balances: { 'Sample 50k': 1 }, rBasis: { 'Sample 50k': { mode: 'fixed', v: 7 } } },
    trades: [{ id: 'mergeprobe1', account: 'Sample 50k', dateTime: '2025-01-02T09:30', R: 1, Rmanual: true }] }));
  await (await page.$('#jImportFile')).uploadFile(other);
  await wait(600);
  await clickAsk(/merge/);
  await wait(1500);
  const bal = await page.evaluate(() => { const i = document.querySelector('#jStartBal, #jBal, input[id*="Bal"]'); return i ? i.value : null; });
  if (bal === '1') fail('Merge overwrote the account starting balance with the backup\'s');
  else ok('Merge kept the existing starting balance (' + bal + ')');

  if (errs.length) fail('page errors: ' + errs.join(' | '));
  await b.close();
  console.log(process.exitCode ? 'DELETESAFETY: FAILURES' : 'DELETESAFETY: ALL PASS');
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
