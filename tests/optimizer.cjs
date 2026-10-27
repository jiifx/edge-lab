// The Funded / Decision optimizer (2.22.0), end to end in the real app on the
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
  // rows carry their first optimization's key; a merged row ("90% survival = Max EV") names both
  const sugs = () => page.evaluate(() => [...document.querySelectorAll('#optTable tr[data-sug]')].map((r) => ({ key: r.getAttribute('data-sug'), name: r.querySelector('b').textContent, size: parseFloat(r.children[1].textContent) })));
  const sizeOf = (list, prefix) => (list.find((x) => x.name.split(' = ').some((p) => p.startsWith(prefix))) || {}).size;
  try { await settled('optTable'); } catch { fail('the suggestions never finished'); }

  // ---------- 1. survival presets and Max EV; no Most income ----------
  let s = await sugs();
  const sizes = { s99: sizeOf(s, '99%'), s95: sizeOf(s, '95%'), s90: sizeOf(s, '90%'), s80: sizeOf(s, '80%'), ev: sizeOf(s, 'Max EV') };
  if (!Object.values(sizes).every((v) => v > 0)) fail('99/95/90/80% survival and Max EV should all be named: ' + JSON.stringify(s));
  else ok('suggestions: ' + s.map((x) => x.name + ' ' + x.size + '%').join(' / '));
  if (s.some((x) => /Most income|Best ROI|Balanced/.test(x.name))) fail('2.22.0 removed Most income, Best ROI and Balanced: ' + s.map((x) => x.name).join(', '));
  if (!(sizes.s99 <= sizes.s95 && sizes.s95 <= sizes.s90 && sizes.s90 <= sizes.s80 && sizes.s80 <= sizes.ev)) fail('safer presets should be smaller, Max EV the largest: ' + JSON.stringify(sizes));
  else ok('ordered: 99% <= 95% <= 90% <= 80% <= Max EV');
  const star = s.find((x) => x.name.includes('★'));
  if (!star || !star.name.startsWith('90%')) fail('the default target (90%) should carry the star: ' + JSON.stringify(star));
  else ok('your target is starred: ' + star.name);
  const lbl = await page.evaluate(() => [document.getElementById('fProfitLbl').textContent, document.getElementById('fChartTitle').textContent, document.querySelector('#optTable th:nth-child(3)').textContent, document.getElementById('fPeak').previousElementSibling.textContent, parseFloat(document.getElementById('fPeak').textContent)]);
  if (!/month/.test(lbl[0]) || !/Return on fees/.test(lbl[1]) || !/Not breached/.test(lbl[2])) fail('month default / ROI chart / not-breached column: ' + lbl.join(' | '));
  else ok('per month by default; chart: ' + lbl[1] + '; column: ' + lbl[2]);
  if (lbl[3] !== 'Size at your target' || Math.abs(lbl[4] - sizes.s90) > 0.001) fail('the tile should show the size at your target (' + sizes.s90 + '): ' + lbl[3] + ' ' + lbl[4]);
  else ok('tile: ' + lbl[3] + ' ' + lbl[4] + '%');

  // ---------- 2. Use sets the risk slider ----------
  await page.evaluate(() => document.querySelector('#optTable tr[data-sug="ev"] button[data-use]').click());
  await wait(800);
  const srf = await page.evaluate(() => Number(document.getElementById('srf').value));
  if (Math.abs(srf - sizes.ev) > 0.001) fail('Use should set the funded risk to ' + sizes.ev + ', got ' + srf);
  else ok('Use set the funded risk to ' + srf + '%');

  // ---------- 3. the target moves the star and the tile; reset restores ----------
  await page.evaluate(() => { const i = document.getElementById('nSurvT'); i.value = '95'; i.dispatchEvent(new Event('change', { bubbles: true })); });
  await wait(800);
  try { await settled('optTable'); } catch { fail('the 95% target never settled'); }
  s = await sugs();
  const star95 = s.find((x) => x.name.includes('★'));
  const tile95 = await page.evaluate(() => parseFloat(document.getElementById('fPeak').textContent));
  if (!star95 || !star95.name.startsWith('95%') || Math.abs(tile95 - sizes.s95) > 0.001) fail('a 95% target should star 95% and show ' + sizes.s95 + ' on the tile: ' + JSON.stringify(star95) + ' ' + tile95);
  else ok('target 95%: star and tile move to ' + tile95 + '%');
  if (await page.evaluate(() => document.getElementById('optDefNote').textContent) !== 'custom settings') fail('should say custom settings');
  await page.evaluate(() => { const i = document.getElementById('nSurvT'); i.value = '85'; i.dispatchEvent(new Event('change', { bubbles: true })); });
  await wait(800);
  try { await settled('optTable'); } catch { fail('the 85% target never settled'); }
  s = await sugs();
  // its own starred row - or merged into a preset's when both land on the same size
  if (!s.some((x) => x.name.split(' = ').includes('85% survival ★'))) fail('a target outside the presets gets its own starred entry: ' + s.map((x) => x.name).join(', '));
  else ok('target 85% (not a preset) is starred: ' + s.find((x) => x.name.includes('85%')).name);
  await page.evaluate(() => document.getElementById('optReset').click());
  await wait(800);
  try { await settled('optTable'); } catch { fail('reset never settled'); }
  s = await sugs();
  if (sizeOf(s, '90%') !== sizes.s90 || s.some((x) => x.name.startsWith('85%'))) fail('reset should restore the defaults');
  else ok('Reset to defaults restores the 90% target');

  // ---------- 4. the other sizing rule is compared; cushion relabels the risk ----------
  try { await page.waitForFunction(() => { const e = document.getElementById('optRuleCmp'); return e && /sizing returns/.test(e.textContent); }, { timeout: 120000, polling: 500 }); } catch { fail('the sizing-rule comparison never finished'); }
  const cmpTxt = (await page.evaluate(() => document.getElementById('optRuleCmp').innerText)).replace(/\s+/g, ' ');
  if (!/At your measured edge and survival target/.test(cmpTxt)) fail('the sizing-rule comparison must say it is like for like: ' + cmpTxt);
  else ok('rule comparison: ' + cmpTxt);
  await page.evaluate(() => document.querySelector('button[data-sizer="cushion"]').click());
  await wait(1500);
  const lab = await page.evaluate(() => document.getElementById('lrfSub').textContent);
  if (!/full cushion/.test(lab)) fail('cushion sizing should relabel the risk as the risk at a full cushion: ' + lab);
  else ok('cushion sizing relabels the risk: ' + lab);
  await page.evaluate(() => document.querySelector('button[data-sizer="fixed"]').click());
  await wait(1000);

  // ---------- 5. several accounts: yours is starred ----------
  try { await settled('optTable'); await settled('accTable'); } catch { fail('the accounts table never finished'); }
  const accRows = () => page.evaluate(() => [...document.querySelectorAll('#accTable tbody tr')].map((r) => ({ n: parseInt(r.children[0].textContent.replace(/\D/g, '')), mine: r.classList.contains('rec'), size: parseFloat(r.children[1].textContent), down: r.children[6].textContent })));
  const same = await accRows();
  if (same.map((r) => r.n).join(',') !== '1,2,3,5') fail('counts 1, 2, 3, 5 by default, got ' + same.map((r) => r.n).join(','));
  else if (!same[0].mine) fail('one account (the default) should be starred');
  else if (new Set(same.map((r) => r.size)).size !== 1) fail('copy-traded same-day accounts should all run one size: ' + JSON.stringify(same));
  else ok('copy-trade, same day: ' + same[0].size + '% at every count, 1 starred');
  const read1 = await page.evaluate(() => document.getElementById('accRead').innerText);
  if (!/rise and fall together/.test(read1)) fail('the read should say why the size does not move: ' + read1);
  await page.evaluate(() => { const i = document.getElementById('nAcc'); i.value = '50'; i.dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('button[data-acm="ind"]').click(); });
  await wait(1500);
  try { await settled('accTable'); } catch { fail('50 accounts never finished'); }
  const fifty = await accRows();
  if (fifty.map((r) => r.n).join(',') !== '1,2,3,5,10,20,30,50' || !fifty[fifty.length - 1].mine) fail('50 accounts should show 1..50 with 50 starred, got ' + JSON.stringify(fifty.map((r) => [r.n, r.mine])));
  else ok('50 independent accounts: ' + fifty.map((r) => r.n + '@' + r.size + '%').join(' / '));
  if (!(fifty[fifty.length - 1].size >= fifty[0].size)) fail('more independent accounts should allow at least the one-account size');
  // staggered purchases re-simulate
  await page.evaluate(() => { const i = document.getElementById('nAcc'); i.value = '5'; i.dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('button[data-acm="copy"]').click(); });
  await wait(1500);
  try { await settled('accTable'); } catch { fail('back to 5 never finished'); }
  const five = await accRows();
  await page.evaluate(() => { const i = document.getElementById('nStag'); i.value = '15'; i.dispatchEvent(new Event('change', { bubbles: true })); });
  await wait(1500);
  try { await settled('accTable'); } catch { fail('staggered never finished'); }
  const st = await accRows();
  if (JSON.stringify(st) === JSON.stringify(five)) fail('staggering the purchases should change the table');
  else ok('staggered 15 days: ' + st.map((r) => r.n + '@' + r.size + '% (all down ' + r.down + ')').join(' · '));
  await page.evaluate(() => { const i = document.getElementById('nStag'); i.value = '0'; i.dispatchEvent(new Event('change', { bubbles: true })); });
  await wait(1000);

  // ---------- 6. Decision plans for YOUR accounts; Apply sets both sliders ----------
  await page.evaluate(() => document.querySelector('[data-tab="decision"]').click());
  try { await settled('dPlans'); } catch { fail('the Decision plans never finished'); }
  const dec = await page.evaluate(() => ({ n: document.getElementById('nAccD').value, head: document.getElementById('dPlansHead').textContent, bud: document.getElementById('dBudgetHead').textContent,
    budget: document.getElementById('dBudget').innerText, cols: document.querySelector('#dPlans thead').innerText }));
  if (dec.n !== '5' || !/your 5 accounts/.test(dec.head) || !/5 accounts funded/.test(dec.bud) || !/5 ACCTS|5 accts/i.test(dec.cols)) fail('Decision should plan and budget for your 5 accounts: ' + JSON.stringify(dec));
  else ok('Decision plans for ' + dec.n + ' accounts: ' + dec.bud + ' | ' + dec.budget.replace(/\s+/g, ' ').slice(0, 90));
  const pickRow = (prefix) => page.evaluate((p) => { const r = [...document.querySelectorAll('#dPlans tr[data-plan]')].find((x) => x.querySelector('b').textContent.split(' = ').some((n) => n.startsWith(p)));
    return r ? { e: parseFloat(r.children[1].textContent), f: parseFloat(r.children[2].textContent), key: r.getAttribute('data-plan') } : null; }, prefix);
  const plan = await pickRow('90%');
  if (!plan) fail('no 90% survival plan on the Decision tab');
  else {
    await page.evaluate((k) => document.querySelector('#dPlans tr[data-plan="' + k + '"] button[data-apply]').click(), plan.key);
    await wait(1500);
    const sl = await page.evaluate(() => [Number(document.getElementById('srde').value), Number(document.getElementById('srdf').value)]);
    if (Math.abs(sl[0] - plan.e) > 0.001 || Math.abs(sl[1] - plan.f) > 0.001) fail('Apply should set eval ' + plan.e + ' and funded ' + plan.f + ', got ' + sl.join(' / '));
    else ok('Decision Apply set eval ' + sl[0] + '% and funded ' + sl[1] + '%');
    if (Math.abs(plan.f - sizes.s90) > 0.001) fail('Decision and Funded must name the same 90% size: ' + plan.f + ' vs ' + sizes.s90);
    else ok('Decision and Funded agree on every size');
  }
  // independent accounts: a "Best for 5" plan, and a budget that diversifies
  await page.evaluate(() => { document.querySelector('button[data-acm="ind"]').click(); });
  await wait(1500);
  try { await page.waitForFunction(() => /Best for 5/.test(document.getElementById('dPlans').textContent) && !document.querySelector('#dPlans .skel'), { timeout: 240000, polling: 500 }); } catch { fail('no Best for 5 accounts plan with independent accounts'); }
  const bestN = await pickRow('Best for 5');
  if (bestN) ok('independent: Best for 5 accounts runs ' + bestN.f + '% funded each');
  const budInd = await page.evaluate(() => document.getElementById('dBudget').innerText);
  if (!/independent accounts/.test(budInd)) fail('independent accounts should be budgeted as separate streaks: ' + budInd);
  // ---------- 7. the eval size for YOUR accounts (2.24.0) ----------
  try { await page.waitForFunction(() => !document.querySelector('#dEvalBatch .skel') && document.querySelector('#dEvalBatch tr[data-batch]'), { timeout: 240000, polling: 500 }); } catch { fail('the eval size table never finished'); }
  const batch = await page.evaluate(() => ({ head: document.getElementById('dEvalBatchHead').textContent,
    rows: [...document.querySelectorAll('#dEvalBatch tr[data-batch]')].map((r) => ({ name: r.getAttribute('data-batch'), size: parseFloat(r.children[1].textContent), b95: r.children[4].textContent, d95: r.children[6].textContent })),
    note: document.getElementById('dEvalBatchNote').textContent, plans: [...document.querySelectorAll('#dPlans tr[data-plan]')].map((r) => parseFloat(r.children[1].textContent)) }));
  const low = batch.rows.find((r) => /Lowest bad-case budget/.test(r.name)), fast = batch.rows.find((r) => /Fastest to funded/.test(r.name));
  if (!/your 5 accounts/.test(batch.head) || !low || !fast) fail('the eval size table should name both picks for 5 accounts: ' + JSON.stringify(batch));
  else ok('eval size for 5 independent accounts: lowest budget ' + low.size + '% (' + low.b95 + ', ' + low.d95 + ') · fastest ' + fast.size + '% (' + fast.b95 + ', ' + fast.d95 + ')');
  if (!/fail on their own/.test(batch.note)) fail('the note should explain independent evaluations: ' + batch.note);
  if (low && !batch.plans.every((e) => Math.abs(e - low.size) < 1e-9)) fail('every plan should use the lowest bad-case eval size ' + low.size + ': ' + batch.plans.join(','));
  else ok('every plan uses the batch eval size');
  if (fast) {
    await page.evaluate((n) => document.querySelector('#dEvalBatch tr[data-batch="' + n + '"] button[data-evaluse]').click(), fast.name);
    await wait(800);
    const se = await page.evaluate(() => Number(document.getElementById('srde').value));
    if (Math.abs(se - fast.size) > 0.001) fail('Use should set the eval slider to ' + fast.size + ', got ' + se); else ok('Use set the eval slider to ' + se + '%');
  }
  // a cap nothing fits: the fastest row says so instead of naming a size
  await page.evaluate(() => { const i = document.getElementById('nEvalCap'); i.value = '1'; i.dispatchEvent(new Event('change', { bubbles: true })); });
  await wait(1200);
  const capped = await page.evaluate(() => document.getElementById('dEvalBatch').innerText);
  if (!/no size fits/.test(capped)) fail('a $1 cap should leave no fastest size: ' + capped.slice(0, 200)); else ok('a cap nothing fits: no fastest size named');
  await page.evaluate(() => { const i = document.getElementById('nEvalCap'); i.value = ''; i.dispatchEvent(new Event('change', { bubbles: true })); });
  await wait(600);
  await page.evaluate(() => { document.querySelector('button[data-acm="copy"]').click(); const i = document.getElementById('nAccD'); i.value = '1'; i.dispatchEvent(new Event('change', { bubbles: true })); });


  if (errs.length) fail('page errors: ' + errs.join(' | '));
  await b.close();
  console.log(process.exitCode ? 'OPTIMIZER: FAILURES' : 'OPTIMIZER: ALL PASS');
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
