// A stranger's first five minutes, end to end:
// - an empty journal offers the sample, and one click loads all 1,000 trades
// - a CSV from a spreadsheet imports, and re-importing it with Merge adds nothing
// - a CSV whose dates could be either order asks instead of guessing
// - Validate's "Save as image" produces a real PNG of the right size
// - the footer names the version and offers the releases page
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const APP = pathToFileURL(path.resolve(__dirname, '../dist/PropEdgeLab2.html')).href;
const VERSION = require('../package.json').version;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => { console.log('FAIL: ' + m); process.exitCode = 1; };
const ok = (m) => console.log('ok: ' + m);

(async () => {
  const work = path.resolve('./pel-test/newuser-' + process.pid);
  const dl = path.join(work, 'dl');
  fs.mkdirSync(dl, { recursive: true });
  const b = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new', userDataDir: path.join(work, 'profile'),
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--edge-skip-compat-layer-relaunch'],
  });
  const page = await b.newPage();
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(APP, { waitUntil: 'load' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 25000 });
  const count = () => page.evaluate(() => { const t = document.querySelector('#jSummary .tile .v'); return t ? t.textContent.trim() : ''; });
  const clickAsk = (re) => page.evaluate((src) => { const x = [...document.querySelectorAll('#askBtns button')].find((e) => new RegExp(src, 'i').test(e.textContent)); if (x) x.click(); return !!x; }, re.source);

  // ---------- 0. the footer names the version and offers updates ----------
  const foot = await page.evaluate(() => ({ v: document.getElementById('appVer').textContent, u: !!document.getElementById('updBtn') }));
  if (foot.v !== VERSION || !foot.u) fail('footer version/update link: ' + JSON.stringify(foot));
  else ok('footer reads version ' + foot.v + ' with Check for updates');

  // ---------- 1. empty journal -> Load sample journal ----------
  await page.evaluate(() => document.querySelector('[data-mode="journal"]').click());
  await wait(400);
  const hasBtn = await page.evaluate(() => !!document.getElementById('emptySample'));
  if (!hasBtn) fail('an empty journal must offer Load sample journal');
  else {
    await page.evaluate(() => document.getElementById('emptySample').click());
    await wait(4000);
    if ((await count()) !== '1000') fail('the sample did not load 1000 trades: ' + (await count()));
    else ok('Load sample journal: 1000 trades in one click');
    const acct = await page.evaluate(() => [...document.getElementById('jAcct').options].map((o) => o.textContent).join('|'));
    if (!/Sample 50k/.test(acct)) fail('the sample account is missing from Account scope: ' + acct);
    else ok('the sample lands on its own account (Sample 50k)');
  }

  // ---------- 2. CSV import, then the same file again ----------
  const csv = path.join(work, 'trades.csv');
  fs.writeFileSync(csv, 'Date,Symbol,Side,Setup,R,Notes\n2025-02-03 09:31,MNQ,Long,ORB,2,"first, with a comma"\n2025-02-03 10:05,MES,Short,ORB,-1,\n2025-02-04 09:40,MNQ,Sell,VWAP,1.5,\n');
  const inp = await page.$('#jImportFile');
  await inp.uploadFile(csv);
  await wait(600);
  await clickAsk(/merge/);
  await wait(1500);
  if ((await count()) !== '1003') fail('CSV merge should give 1003 trades, got ' + (await count()));
  else ok('a 3-row CSV merged: 1003 trades');
  await inp.uploadFile(csv);
  await wait(600);
  await clickAsk(/merge/);
  await wait(1500);
  if ((await count()) !== '1003') fail('re-importing the same CSV must add nothing, got ' + (await count()));
  else ok('the same CSV merged again adds nothing (stable ids)');

  // ---------- 3. ambiguous dates are asked about ----------
  const amb = path.join(work, 'amb.csv');
  fs.writeFileSync(amb, 'Date;R\n01/02/2025;1\n03/04/2025;-1\n');
  await inp.uploadFile(amb);
  await wait(600);
  const q = await page.evaluate(() => { const m = document.getElementById('askMsg') || document.querySelector('#askOv, .ask'); return m ? m.textContent : ''; });
  if (!/either way/.test(q)) fail('ambiguous dates must ask the order, the dialog read: ' + q.slice(0, 120));
  else ok('ambiguous day/month dates: the app asks');
  await clickAsk(/day \/ month/);
  await wait(600);
  await clickAsk(/merge/);
  await wait(1500);
  if ((await count()) !== '1005') fail('after choosing Day/Month the 2 rows should import, got ' + (await count()));
  else ok('after the answer, both rows import: 1005 trades');

  // ---------- 4. Save as image ----------
  await page.evaluate(() => document.querySelector('[data-mode="sim"]').click());
  await wait(2500);
  await page.evaluate(() => document.getElementById('vReport').click());
  let png = null;
  for (let i = 0; i < 20 && !png; i++) { await wait(300); png = fs.readdirSync(dl).find((f) => /^edge-lab-report-.*\.png$/.test(f)); }
  if (!png) fail('Save as image downloaded nothing');
  else {
    const buf = fs.readFileSync(path.join(dl, png));
    const sig = buf.slice(0, 8).toString('hex'), w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    if (sig !== '89504e470d0a1a0a' || w !== 2400 || h !== 1350) fail('the report is not a 2400x1350 PNG: ' + sig + ' ' + w + 'x' + h);
    else ok('Save as image: ' + png + ', 2400x1350 PNG, ' + Math.round(buf.length / 1024) + ' KB');
  }

  if (errs.length) fail('page errors: ' + errs.join(' | '));
  await b.close();
  console.log(process.exitCode ? 'NEWUSER: FAILURES' : 'NEWUSER: ALL PASS');
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
