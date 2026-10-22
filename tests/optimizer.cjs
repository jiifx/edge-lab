// The Funded / Decision optimizer (2.19.0), end to end in the real app on the
// sample record: every optimization is suggested and marked, settings move the
// picks and reset to defaults, the month/year switch changes every money label,
// "Use" and "Apply" set the sliders, and several accounts recommends a setup -
// including when one account cannot reach the goal.
const puppeteer = require('puppeteer-core');
const path = require('path');
const { pathToFileURL } = require('url');

const APP = pathToFileURL(path.resolve(__dirname, '../dist/EdgeLab.html')).href;
const SAMPLE = path.resolve(__dirname, '../samples/sample-1000-trades.json');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => { console.log('FAIL: ' + m); process.exitCode = 1; };
const ok = (m) => console.log('ok: ' + m);

(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new', userDataDir: path.resolve('./pel-test/optimizer-' + process.pid), protocolTimeout: 240000,
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--edge-skip-compat-layer-relaunch'],
  });
  const page = await b.newPage();
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('pel_free_notice_off', 'true'); if (localStorage.getItem('pel_prop') == null) localStorage.setItem('pel_prop', 'true'); } catch (e) { /* opaque origin */ } });
  await page.setViewport({ width: 1360, height: 900 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(APP, { waitUntil: 'load' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 25000 });
  await page.evaluate(() => document.querySelector('[data-mode="journal"]').click());
  await (await page.$('#jImportFile')).uploadFile(SAMPLE);
  await wait(4000);
  await page.evaluate(() => {
    document.querySelector('[data-mode="sim"]').click();
    const u = document.getElementById('useJournal'); if (!u.checked) { u.checked = true; u.dispatchEvent(new Event('change', { bubbles: true })); }
    document.querySelector('[data-tab="funded"]').click();
  });
  const settled = (id) => page.waitForFunction((i) => { const e = document.getElementById(i); return e && !e.querySelector('.skel') && e.querySelector('table'); }, { timeout: 180000, polling: 500 }, id);
  const sugs = () => page.evaluate(() => [...document.querySelectorAll('#optTable tr[data-sug]')].map((r) => ({ key: r.getAttribute('data-sug'), size: parseFloat(r.children[1].textContent) })));
  try { await settled('optTable'); } catch { fail('the suggestions never finished'); }

  // ---------- 1. every optimization is suggested, month is the default unit ----------
  let s = await sugs();
  const keys = s.map((x) => x.key).join(',');
  if (keys !== 'goal,balanced,velocity,maxnet') fail('expected goal,balanced,velocity,maxnet, got ' + keys);
  else ok('suggestions: ' + s.map((x) => x.key + ' ' + x.size + '%').join(' · '));
  const sizes = Object.fromEntries(s.map((x) => [x.key, x.size]));
  if (!(sizes.goal <= sizes.balanced && sizes.balanced <= sizes.velocity && sizes.velocity <= sizes.maxnet)) fail('the picks should run goal <= balanced <= velocity <= max net on this record');
  else ok('ordered from least to most risk');
  const lbl = await page.evaluate(() => [document.getElementById('fProfitLbl').textContent, document.getElementById('lGoalLbl').textContent]);
  if (!/month/.test(lbl[0]) || !/month/.test(lbl[1])) fail('month should be the default unit: ' + lbl.join(' | '));
  else ok('per month by default: ' + lbl.join(' | '));

  // ---------- 2. Use sets the risk slider ----------
  await page.evaluate(() => document.querySelector('#optTable tr[data-sug="balanced"] button[data-use]').click());
  await wait(800);
  const srf = await page.evaluate(() => Number(document.getElementById('srf').value));
  if (Math.abs(srf - sizes.balanced) > 0.001) fail('Use should set the funded risk to ' + sizes.balanced + ', got ' + srf);
  else ok('Use set the funded risk to ' + srf + '%');

  // ---------- 3. settings move the picks; reset restores ----------
  await page.evaluate(() => { const i = document.getElementById('nSurvT'); i.value = '97'; i.dispatchEvent(new Event('change', { bubbles: true })); });
  await wait(2500);
  s = await sugs();
  const bal97 = (s.find((x) => x.key === 'balanced') || {}).size;
  if (!(bal97 < sizes.balanced)) fail('a 97% survival target should pick a smaller balanced size than ' + sizes.balanced + ', got ' + bal97);
  else ok('survival target 97%: balanced ' + sizes.balanced + '% -> ' + bal97 + '%');
  const note = await page.evaluate(() => document.getElementById('optDefNote').textContent);
  if (note !== 'custom settings') fail('should say custom settings, says ' + note);
  await page.evaluate(() => document.getElementById('optReset').click());
  await wait(2500);
  s = await sugs();
  if ((s.find((x) => x.key === 'balanced') || {}).size !== sizes.balanced) fail('reset should restore the default balanced size');
  else ok('Reset to defaults restores ' + sizes.balanced + '%');

  // ---------- 4. the period switch ----------
  await page.evaluate(() => document.querySelector('button[data-goalp="yr"]').click());
  await wait(1500);
  const yr = await page.evaluate(() => [document.getElementById('fProfitLbl').textContent, document.querySelector('#optTable th:nth-child(6)').textContent]);
  if (!/year/.test(yr[0]) || !/\/yr/.test(yr[1])) fail('per year should relabel: ' + yr.join(' | '));
  else ok('per year relabels the tab: ' + yr.join(' | '));
  await page.evaluate(() => document.querySelector('button[data-goalp="mo"]').click());
  await wait(1000);

  // ---------- 5. several accounts: a goal one account cannot reach ----------
  try { await settled('accTable'); } catch { fail('the accounts table never finished'); }
  await page.evaluate(() => { const i = document.getElementById('nGoal'); i.value = '40000'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await wait(1500);
  try { await settled('accTable'); } catch { fail('the accounts table never re-ran for the new goal'); }
  const acc = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('#accTable tbody tr')].map((r) => ({ n: parseInt(r.children[0].textContent.replace(/\D/g, '')), rec: r.classList.contains('rec'), goal: r.children[2].textContent })),
    read: document.getElementById('accRead').innerText,
  }));
  const rec = acc.rows.find((r) => r.rec);
  if (acc.rows.length !== 3) fail('three account counts expected, got ' + acc.rows.length);
  else if (!rec || rec.n < 2) fail('$40,000/mo needs more than one account on this record; recommended ' + JSON.stringify(rec) + ' | ' + acc.read);
  else ok('$40,000/mo: ' + acc.rows.map((r) => r.n + ' acct ' + r.goal).join(' · ') + ' -> ' + acc.read);
  // independent vs copy changes the result
  const before = await page.evaluate(() => document.getElementById('accTable').innerText);
  await page.evaluate(() => document.querySelector('button[data-acm="ind"]').click());
  await wait(1500);
  try { await settled('accTable'); } catch { fail('independent never finished'); }
  const after = await page.evaluate(() => document.getElementById('accTable').innerText);
  if (before === after) fail('switching to independent accounts should change the table');
  else ok('independent accounts re-simulate');
  await page.evaluate(() => { document.querySelector('button[data-acm="copy"]').click(); const i = document.getElementById('nGoal'); i.value = '4500'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await wait(1000);

  // ---------- 6. Decision: plans, and Apply sets both sliders ----------
  await page.evaluate(() => document.querySelector('[data-tab="decision"]').click());
  try { await settled('dPlans'); } catch { fail('the Decision plans never finished'); }
  const plan = await page.evaluate(() => {
    const r = document.querySelector('#dPlans tr[data-plan="velocity"]');
    return r ? { e: parseFloat(r.children[1].textContent), f: parseFloat(r.children[2].textContent) } : null;
  });
  if (!plan) fail('no Velocity plan on the Decision tab');
  else {
    await page.evaluate(() => document.querySelector('#dPlans tr[data-plan="velocity"] button[data-apply]').click());
    await wait(1500);
    const sl = await page.evaluate(() => [Number(document.getElementById('srde').value), Number(document.getElementById('srdf').value)]);
    if (Math.abs(sl[0] - plan.e) > 0.001 || Math.abs(sl[1] - plan.f) > 0.001) fail('Apply should set eval ' + plan.e + ' and funded ' + plan.f + ', got ' + sl.join(' / '));
    else ok('Decision Apply set eval ' + sl[0] + '% and funded ' + sl[1] + '%');
    if (Math.abs(plan.f - sizes.velocity) > 0.001) fail('Decision and Funded must name the same velocity size: ' + plan.f + ' vs ' + sizes.velocity);
    else ok('Decision and Funded agree on every size');
  }

  if (errs.length) fail('page errors: ' + errs.join(' | '));
  await b.close();
  console.log(process.exitCode ? 'OPTIMIZER: FAILURES' : 'OPTIMIZER: ALL PASS');
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
