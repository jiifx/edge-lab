// Prop-firm mode is opt-in: a new user gets a plain edge tool (Validate only, no
// rule guard, no prop odds); an existing install keeps prop mode on; the switch
// persists across reloads.
const puppeteer = require('puppeteer-core');
const path = require('path');
const { pathToFileURL } = require('url');

const APP = pathToFileURL(path.resolve(__dirname, '../dist/PropEdgeLab2.html')).href;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => { console.log('FAIL: ' + m); process.exitCode = 1; };
const ok = (m) => console.log('ok: ' + m);

(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new', userDataDir: path.resolve('./pel-test/propmode-' + process.pid),
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--edge-skip-compat-layer-relaunch'],
  });
  const page = await b.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  const load = async () => {
    await page.goto(APP, { waitUntil: 'load' });
    await page.waitForFunction('window.__PEL_READY === true', { timeout: 25000 });
    await wait(600);
  };
  const state = () => page.evaluate(() => {
    const vis = (sel) => { const e = document.querySelector(sel); return !!e && getComputedStyle(e).display !== 'none'; };
    return {
      noprop: document.body.classList.contains('noprop'),
      title: document.getElementById('firmTitle').textContent,
      challengeTab: vis('.tabs button[data-tab="challenge"]'),
      decisionTab: vis('.tabs button[data-tab="decision"]'),
      checked: document.getElementById('propMode').checked,
      sum: document.getElementById('firmSum').textContent,
    };
  });

  // ---------- 1. a brand-new install starts in personal mode ----------
  await load();
  await page.evaluate(() => { localStorage.clear(); });
  await load();
  let s = await state();
  if (!s.noprop || s.challengeTab || s.decisionTab || s.checked) fail('a fresh install must start with prop mode off: ' + JSON.stringify(s));
  else ok('fresh install: prop mode off, Challenge/Decision hidden');
  if (s.title !== 'Your account' || !/account/.test(s.sum) || /target/.test(s.sum)) fail('personal mode must summarise an account, not a firm: ' + s.title + ' / ' + s.sum);
  else ok('the panel reads "' + s.title + '": ' + s.sum);

  // ---------- 2. the switch turns it on, and it persists ----------
  await page.evaluate(() => { const c = document.getElementById('propMode'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); });
  await wait(400);
  s = await state();
  if (s.noprop || !s.challengeTab) fail('switching prop mode on must show the prop tabs: ' + JSON.stringify(s));
  else ok('switch on: prop tabs appear, panel reads "' + s.title + '"');
  await load();
  s = await state();
  if (s.noprop || !s.checked) fail('prop mode did not persist across a reload');
  else ok('prop mode persists across a reload');

  // ---------- 3. an existing install (saved sim state, no flag) keeps prop mode ----------
  await page.evaluate(() => { localStorage.removeItem('pel_prop'); localStorage.setItem('pel_sim', JSON.stringify({ tab: 'funded' })); });
  await load();
  s = await state();
  if (s.noprop) fail('an existing install must keep prop mode on');
  else ok('an install with saved simulator state keeps prop mode on');

  // ---------- 4. switching off while on a prop tab lands on Validate ----------
  await page.evaluate(() => document.querySelector('[data-tab="decision"]').click());
  await page.evaluate(() => { const c = document.getElementById('propMode'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); });
  await wait(400);
  const shown = await page.evaluate(() => ['validate', 'challenge', 'funded', 'decision'].filter((t) => !document.getElementById('p-' + t).classList.contains('hide')));
  if (shown.join() !== 'validate') fail('turning prop mode off on a prop tab must land on Validate, shown: ' + shown.join());
  else ok('turning prop mode off from Decision lands on Validate');

  if (errs.length) fail('page errors: ' + errs.join(' | '));
  await b.close();
  console.log(process.exitCode ? 'PROPMODE: FAILURES' : 'PROPMODE: ALL PASS');
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
