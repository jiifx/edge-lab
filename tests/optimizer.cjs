// The Funded / Decision optimizer (2.20.0), end to end in the real app on the
// sample record: every optimization is suggested and marked, settings move the
// picks and reset to defaults, the other sizing rule is compared, "Use" and
// "Apply" set the sliders, and several accounts size per count - the same size
// when copy-traded on one day, re-simulated when independent or staggered.
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
  if (keys !== 'best,balanced,income') fail('expected best,balanced,income on this record (no dollar cap, so no max-payout pick), got ' + keys);
  else ok('suggestions: ' + s.map((x) => x.key + ' ' + x.size + '%').join(' · '));
  const sizes = Object.fromEntries(s.map((x) => [x.key, x.size]));
  if (!(sizes.balanced <= sizes.best && sizes.best < sizes.income)) fail('on this record balanced <= best ROI < most income');
  else ok('ordered: balanced <= best ROI < most income');
  const roiOf = (k) => page.evaluate((key) => { const r = document.querySelector('#optTable tr[data-sug="' + key + '"]'); return r ? parseFloat(r.children[3].textContent.replace(/[$,]/g, '')) : NaN; }, k);
  const bestRoi = await roiOf('best'), incRoi = await roiOf('income');
  if (!(bestRoi > incRoi)) fail('most income should return less per fee dollar than best ROI: ' + incRoi + ' vs ' + bestRoi);
  else ok('most income leans on re-buys: $' + incRoi + ' vs $' + bestRoi + ' per $1');
  const lbl = await page.evaluate(() => [document.getElementById('fProfitLbl').textContent, document.getElementById('fChartTitle').textContent]);
  if (!/month/.test(lbl[0]) || !/Return on fees/.test(lbl[1])) fail('month default / ROI chart: ' + lbl.join(' | '));
  else ok('per month by default; chart: ' + lbl[1]);

  // ---------- 2. Use sets the risk slider ----------
  await page.evaluate(() => document.querySelector('#optTable tr[data-sug="best"] button[data-use]').click());
  await wait(800);
  const srf = await page.evaluate(() => Number(document.getElementById('srf').value));
  if (Math.abs(srf - sizes.best) > 0.001) fail('Use should set the funded risk to ' + sizes.best + ', got ' + srf);
  else ok('Use set the funded risk to ' + srf + '%');

  // ---------- 3. settings move the picks; reset restores ----------
  await page.evaluate(() => { const i = document.getElementById('nSurvT'); i.value = '97'; i.dispatchEvent(new Event('change', { bubbles: true })); });
  await wait(2500);
  s = await sugs();
  const bal97 = (s.find((x) => x.key === 'balanced') || {}).size;
  if (!(bal97 < sizes.balanced)) fail('a 97% survival target should pick a smaller balanced size than ' + sizes.balanced + ', got ' + bal97);
  else ok('survival target 97%: balanced ' + sizes.balanced + '% -> ' + bal97 + '%');
  if (await page.evaluate(() => document.getElementById('optDefNote').textContent) !== 'custom settings') fail('should say custom settings');
  await page.evaluate(() => document.getElementById('optReset').click());
  await wait(2500);
  s = await sugs();
  if ((s.find((x) => x.key === 'balanced') || {}).size !== sizes.balanced) fail('reset should restore the default balanced size');
  else ok('Reset to defaults restores ' + sizes.balanced + '%');

  // ---------- 4. the other sizing rule is compared; cushion relabels the risk ----------
  try { await page.waitForFunction(() => { const e = document.getElementById('optRuleCmp'); return e && /would return/.test(e.textContent); }, { timeout: 120000, polling: 500 }); } catch { fail('the sizing-rule comparison never finished'); }
  ok('rule comparison: ' + (await page.evaluate(() => document.getElementById('optRuleCmp').innerText)).replace(/\s+/g, ' '));
  await page.evaluate(() => document.querySelector('button[data-sizer="cushion"]').click());
  await wait(1500);
  const lab = await page.evaluate(() => document.getElementById('lrfSub').textContent);
  if (!/full cushion/.test(lab)) fail('cushion sizing should relabel the risk as the risk at a full cushion: ' + lab);
  else ok('cushion sizing relabels the risk: ' + lab);
  await page.evaluate(() => document.querySelector('button[data-sizer="fixed"]').click());
  await wait(1000);

  // ---------- 5. several accounts ----------
  try { await settled('optTable'); await settled('accTable'); } catch { fail('the accounts table never finished'); }
  const accRows = () => page.evaluate(() => [...document.querySelectorAll('#accTable tbody tr')].map((r) => ({ n: +r.children[0].textContent, size: parseFloat(r.children[1].textContent), down: r.children[6].textContent })));
  const same = await accRows();
  if (same.length !== 5) fail('five account counts by default, got ' + same.length);
  else if (new Set(same.map((r) => r.size)).size !== 1) fail('copy-traded same-day accounts should all run one size: ' + JSON.stringify(same));
  else ok('copy-trade, same day: ' + same[0].size + '% at every count');
  const read1 = await page.evaluate(() => document.getElementById('accRead').innerText);
  if (!/rise and fall together/.test(read1)) fail('the read should say why the size does not move: ' + read1);
  // independent accounts cover for each other
  await page.evaluate(() => document.querySelector('button[data-acm="ind"]').click());
  await wait(1500);
  try { await settled('accTable'); } catch { fail('independent never finished'); }
  const ind = await accRows();
  if (!(ind[ind.length - 1].size >= ind[0].size)) fail('more independent accounts should allow at least the one-account size: ' + JSON.stringify(ind));
  else ok('independent: ' + ind.map((r) => r.n + '@' + r.size + '% (all down ' + r.down + ')').join(' · '));
  await page.evaluate(() => document.querySelector('button[data-acm="copy"]').click());
  // staggered purchases re-simulate
  await page.evaluate(() => { const i = document.getElementById('nStag'); i.value = '15'; i.dispatchEvent(new Event('change', { bubbles: true })); });
  await wait(1500);
  try { await settled('accTable'); } catch { fail('staggered never finished'); }
  const st = await accRows();
  if (JSON.stringify(st) === JSON.stringify(same)) fail('staggering the purchases should change the table');
  else ok('staggered 15 days: ' + st.map((r) => r.n + '@' + r.size + '% (all down ' + r.down + ')').join(' · '));
  await page.evaluate(() => { const i = document.getElementById('nStag'); i.value = '0'; i.dispatchEvent(new Event('change', { bubbles: true })); });
  await wait(1000);

  // ---------- 6. Decision: plans, and Apply sets both sliders ----------
  await page.evaluate(() => document.querySelector('[data-tab="decision"]').click());
  try { await settled('dPlans'); } catch { fail('the Decision plans never finished'); }
  const plan = await page.evaluate(() => {
    const r = document.querySelector('#dPlans tr[data-plan="balanced"]');
    return r ? { e: parseFloat(r.children[1].textContent), f: parseFloat(r.children[2].textContent) } : null;
  });
  if (!plan) fail('no Balanced plan on the Decision tab');
  else {
    await page.evaluate(() => document.querySelector('#dPlans tr[data-plan="balanced"] button[data-apply]').click());
    await wait(1500);
    const sl = await page.evaluate(() => [Number(document.getElementById('srde').value), Number(document.getElementById('srdf').value)]);
    if (Math.abs(sl[0] - plan.e) > 0.001 || Math.abs(sl[1] - plan.f) > 0.001) fail('Apply should set eval ' + plan.e + ' and funded ' + plan.f + ', got ' + sl.join(' / '));
    else ok('Decision Apply set eval ' + sl[0] + '% and funded ' + sl[1] + '%');
    if (Math.abs(plan.f - sizes.balanced) > 0.001) fail('Decision and Funded must name the same balanced size: ' + plan.f + ' vs ' + sizes.balanced);
    else ok('Decision and Funded agree on every size');
  }

  if (errs.length) fail('page errors: ' + errs.join(' | '));
  await b.close();
  console.log(process.exitCode ? 'OPTIMIZER: FAILURES' : 'OPTIMIZER: ALL PASS');
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
