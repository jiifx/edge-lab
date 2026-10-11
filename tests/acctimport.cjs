// Import and export follow the ACCOUNT IN SCOPE. The bug this pins: a file
// imported while looking at "Validating Setups" landed in the account named
// inside the file, Replace erased every account, and importing the same file
// into a second account skipped every trade as a duplicate.
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const APP = pathToFileURL(path.resolve(__dirname, '../dist/PropEdgeLab2.html')).href;
const SAMPLE = path.resolve(__dirname, '../samples/sample-1000-trades.json');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => { console.log('FAIL: ' + m); process.exitCode = 1; };
const ok = (m) => console.log('ok: ' + m);
// a 1x1 PNG, as a screenshot
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

(async () => {
  const work = path.resolve('./pel-test/acctimport-' + process.pid);
  const dl = path.join(work, 'dl');
  fs.mkdirSync(dl, { recursive: true });
  const b = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new', userDataDir: path.join(work, 'profile'),
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--edge-skip-compat-layer-relaunch'],
  });
  const page = await b.newPage();
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('pel_free_notice_off', 'true'); } catch (e) { /* opaque origin */ } });
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(APP, { waitUntil: 'load' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 25000 });
  await page.evaluate(() => document.querySelector('[data-mode="journal"]').click());
  await wait(400);

  const dialog = () => page.evaluate(() => { const o = document.getElementById('askOv'); return o && !o.classList.contains('hide') ? document.getElementById('askMsg').innerText : ''; });
  const buttons = () => page.evaluate(() => [...document.querySelectorAll('#askBtns button')].map((e) => e.textContent));
  const clickAsk = (re) => page.evaluate((src) => { const x = [...document.querySelectorAll('#askBtns button')].find((e) => new RegExp(src, 'i').test(e.textContent)); if (x) x.click(); return !!x; }, re.source);
  const scope = async (name) => { await page.evaluate((v) => { const s = document.getElementById('jAcct'); const o = [...s.options].find((x) => (v ? x.textContent.trim().startsWith(v) : x.value === '')); s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); }, name); await wait(400); };
  const count = () => page.evaluate(() => { const t = document.querySelector('#jSummary .tile .v'); return t ? Number(t.textContent.trim()) : 0; });
  const countIn = async (name) => { await scope(name); return count(); };
  const newAccount = async (name) => {
    await page.evaluate(() => document.getElementById('jNewAcct').click());
    await wait(300);
    await page.evaluate((n) => { document.getElementById('acctName').value = n; }, name);
    await clickAsk(/create/);
    await wait(400);
  };
  const upload = async (file) => { await (await page.$('#jImportFile')).uploadFile(file); await wait(700); };
  const toastText = () => page.evaluate(() => document.getElementById('toast').textContent);
  const rValue = () => page.evaluate(() => { const i = document.getElementById('jRVal') || document.querySelector('input[id*="RVal"], input[id*="rVal"]'); return i ? i.value : null; });
  const exportsNow = () => fs.readdirSync(dl).filter((f) => f.endsWith('.json'));
  const newestExport = async (before) => { for (let i = 0; i < 30; i++) { const f = exportsNow().filter((x) => before.indexOf(x) < 0); if (f.length) return JSON.parse(fs.readFileSync(path.join(dl, f[0]), 'utf-8')); await wait(200); } return null; };

  // ---------- setup: the sample, plus the user's own account with its own R value ----------
  await page.evaluate(() => document.getElementById('emptySample').click());
  await wait(4000);
  await newAccount('Validating Setups');
  await page.evaluate(() => { const i = document.getElementById('jStartBal'); if (i) { i.value = '50000'; i.dispatchEvent(new Event('change', { bubbles: true })); } });
  ok('setup: Sample 50k has ' + (await countIn('Sample 50k')) + ' trades; Validating Setups created');

  // ---------- 1. THE BUG: import while looking at Validating Setups ----------
  await scope('Validating Setups');
  await upload(SAMPLE);
  const d1 = await dialog();
  if (!/into Validating Setups/.test(d1) || !/under Sample 50k/.test(d1) || !/other accounts are not touched/i.test(d1)) fail('the dialog must name the target account and say others are untouched: ' + d1.slice(0, 200));
  else ok('dialog: "Import 1000 trades into Validating Setups … under Sample 50k … other accounts are not touched"');
  await clickAsk(/import into/);
  await wait(2500);
  const vs = await countIn('Validating Setups'), s50 = await countIn('Sample 50k');
  if (vs !== 1000 || s50 !== 1000) fail('scoped import: Validating Setups ' + vs + ', Sample 50k ' + s50 + ' (expected 1000 and 1000)');
  else ok('the file went into Validating Setups (1000); Sample 50k untouched (1000)');

  // ---------- 2. the same file into the same account again adds nothing ----------
  await scope('Validating Setups');
  await upload(SAMPLE);
  const btn2 = await buttons();
  await clickAsk(/merge/);
  await wait(2000);
  const t2 = await toastText();
  if ((await count()) !== 1000 || !/1000 already in Validating Setups/.test(t2)) fail('re-import into the same account: count ' + (await count()) + ', toast "' + t2 + '"');
  else ok('re-import into the same account: 0 added, toast says "1000 already in Validating Setups (skipped)"; buttons ' + JSON.stringify(btn2));

  // ---------- 3. Replace only replaces the scoped account ----------
  const three = path.join(work, 'three.csv');
  fs.writeFileSync(three, 'Date,R\n2025-01-02 09:30,1\n2025-01-03 09:30,-1\n2025-01-06 09:30,2\n');
  await upload(three);
  const d3 = await dialog();
  if (!/Replace removes those 1000 trades/.test(d3)) fail('scoped Replace must say it removes only the account\'s trades: ' + d3.slice(0, 220));
  await clickAsk(/replace validating/);
  await wait(2500);
  const undo3 = await page.$('#toast .toastbtn');
  const vs3 = await countIn('Validating Setups'), s3 = await countIn('Sample 50k');
  if (vs3 !== 3 || s3 !== 1000) fail('scoped Replace: Validating Setups ' + vs3 + ', Sample 50k ' + s3 + ' (expected 3 and 1000)');
  else ok('Replace in Validating Setups: it now holds 3; Sample 50k still 1000');
  if (!undo3) fail('no Undo after a scoped Replace');
  else {
    await undo3.click();
    await wait(2000);
    if ((await countIn('Validating Setups')) !== 1000) fail('Undo did not restore Validating Setups');
    else ok('Undo restored Validating Setups to 1000');
  }

  // ---------- 4. settings: the file fills only what the target has not set ----------
  await newAccount('Fresh');
  await scope('Fresh');
  await upload(SAMPLE);
  await clickAsk(/import into/);
  await wait(2500);
  await scope('Fresh');
  const rvFresh = await rValue();
  await scope('Validating Setups');
  const balVS = await page.evaluate(() => document.getElementById('jStartBal').value);
  if (rvFresh !== '200') fail('an account with no R value should take the file\'s (200), got ' + rvFresh);
  else ok('a new account takes the file\'s settings where it had none (R value 200)');
  if (balVS !== '50000') fail('Validating Setups\' own starting balance changed to ' + balVS);

  // ---------- 5. the two copies do not share screenshot files ----------
  const shot = path.join(work, 'shot.json');
  fs.writeFileSync(shot, JSON.stringify({ meta: { accounts: ['Src'] }, trades: [{ id: 'shot1', account: 'Src', dateTime: '2025-02-03T10:00', R: 1, Rmanual: true, imageIds: ['img1'] }], images: [{ id: 'img1', w: 1, h: 1, dataUrl: PNG }] }));
  for (const a of ['Validating Setups', 'Fresh']) { await scope(a); await upload(shot); await clickAsk(/merge|import into/); await wait(1800); }
  await scope('');
  let before = exportsNow();
  await page.evaluate(() => document.getElementById('jExport').click());
  await wait(300);
  const all = await newestExport(before);
  const shotTrades = all ? all.trades.filter((t) => /^shot1/.test(t.id)) : [];
  const imgIds = shotTrades.map((t) => t.imageIds[0]);
  if (shotTrades.length !== 2 || new Set(imgIds).size !== 2 || !imgIds.every((i) => all.images.some((im) => im.id === i))) fail('two accounts\' copies of a trade must have their own screenshots: ' + JSON.stringify(imgIds));
  else ok('the same trade imported into two accounts: separate ids and separate screenshot files ' + JSON.stringify(imgIds));
  // delete Fresh, let its Undo window close: Validating Setups' screenshot must survive
  await scope('Fresh');
  await page.evaluate(() => document.getElementById('jDelAcct').click());
  await wait(300);
  await clickAsk(/delete account/);
  await wait(10500);
  await scope('');
  before = exportsNow();
  await page.evaluate(() => document.getElementById('jExport').click());
  await wait(300);
  const after = await newestExport(before);
  const vsShot = after && after.trades.find((t) => /^shot1/.test(t.id) && t.account === 'Validating Setups');
  if (!vsShot || !after.images.some((im) => im.id === vsShot.imageIds[0])) fail('deleting Fresh took Validating Setups\' screenshot with it');
  else ok('deleting the other account left this account\'s screenshot intact');

  // ---------- 6. export one account ----------
  await scope('Validating Setups');
  before = exportsNow();
  await page.evaluate(() => document.getElementById('jExport').click());
  await wait(300);
  const d6 = await dialog();
  if (!/Validating Setups/.test(d6) || !/all your accounts/.test(d6)) fail('scoped export must ask which: ' + d6);
  await clickAsk(/only/);
  const one = await newestExport(before);
  const name = exportsNow().filter((x) => before.indexOf(x) < 0)[0] || '';
  const accts = one ? [...new Set(one.trades.map((t) => t.account))] : [];
  if (!one || accts.join() !== 'Validating Setups' || one.meta.accounts.join() !== 'Validating Setups' || !/Validating-Setups/.test(name)) fail('one-account export: accounts ' + JSON.stringify(accts) + ', meta ' + JSON.stringify(one && one.meta.accounts) + ', file ' + name);
  else ok('export of one account: ' + one.trades.length + ' trades, only Validating Setups, file ' + name);

  // ---------- 7. All accounts in scope: the file keeps its accounts, Replace says "everything" ----------
  await scope('');
  const multi = path.join(work, 'multi.csv');
  fs.writeFileSync(multi, 'Date,Account,R\n2025-03-03 09:30,Alpha,1\n2025-03-04 09:30,Beta,-1\n');
  await upload(multi);
  const d7 = await dialog();
  const b7 = await buttons();
  if (!/Replace removes all \d+ trades in all \d+ accounts/.test(d7) || !b7.some((x) => /Replace everything/.test(x))) fail('All-accounts Replace must say it removes everything: ' + d7.slice(0, 220) + ' ' + JSON.stringify(b7));
  else ok('All accounts: the dialog says Replace removes all trades in all accounts; button "Replace everything"');
  await clickAsk(/merge/);
  await wait(1800);
  if ((await countIn('Alpha')) !== 1 || (await countIn('Beta')) !== 1) fail('with All accounts in scope a CSV\'s own accounts must be kept');
  else ok('with All accounts in scope, the file\'s own accounts are kept (Alpha, Beta)');

  if (errs.length) fail('page errors: ' + errs.join(' | '));
  await b.close();
  console.log(process.exitCode ? 'ACCTIMPORT: FAILURES' : 'ACCTIMPORT: ALL PASS');
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
