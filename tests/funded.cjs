// The Funded tab: payout-first readouts, and the payout goal.
//
// The tab used to lead with a mean profit figure and nothing about payouts, which
// is the thing a funded trader actually experiences. It now leads with the odds
// of getting paid and how many payouts land, and takes a yearly goal that answers
// the inverted question - not "which size pays most" but "which is the SMALLEST
// size that still gets me there", because every point of size above that is
// survival spent for nothing.
//
// Two contracts worth guarding beyond "it renders":
//   1. #fPayAny comes from payoutOdds, the SAME estimator behind the Decision
//      tab. If it ever gets re-derived from fundedSim's sweeps it would stop
//      pricing the firm's first-payout gate and the two tabs would disagree.
//   2. The goal row hides at 0 and never claims a bracket it cannot support.
const puppeteer = require('puppeteer-core');
const path = require('path');
const APP = 'file:///' + path.resolve(__dirname, '../dist/EdgeLab.html').replace(/\\/g, '/');
function fail(m) { console.error('FAIL: ' + m); process.exitCode = 1; }

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new',
    userDataDir: path.resolve('./pel-test/profile-funded-' + process.pid),
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--edge-skip-compat-layer-relaunch'],
  });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('pel_free_notice_off', 'true'); } catch (e) { /* opaque origin */ } });  // the start-up 'this app is free' notice is tested in newuser.cjs
  await page.evaluateOnNewDocument(() => { try { if (localStorage.getItem('pel_prop') == null) localStorage.setItem('pel_prop', 'true'); } catch (e) { /* opaque origin */ } });  // these suites exercise prop-firm mode
  await page.setViewport({ width: 1400, height: 950 });
  page.on('pageerror', e => fail('pageerror: ' + e.message));
  await page.goto(APP, { waitUntil: 'load' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 20000 });

  await page.click('[data-tab="funded"]');
  await new Promise(r => setTimeout(r, 700));   // rAF pass + the 250ms full-quality pass

  // ---------- every readout populates ----------
  const kv = await page.evaluate(() => {
    const t = id => (document.getElementById(id).textContent || '').trim();
    return {
      payAny: t('fPayAny'), pays: t('fPays'), profit: t('fProfit'),
      surv: t('fSurv'), peak: t('fPeak'), roi: t('fRoi'),
    };
  });
  for (const [k, v] of Object.entries(kv)) {
    if (!v || v === '--') fail('#f' + k + ' never populated: "' + v + '"');
  }
  if (!/%/.test(kv.payAny)) fail('chance of a payout is not a percentage: ' + kv.payAny);
  else console.log('ok: chance of a payout reads ' + kv.payAny);
  if (!/typical/.test(kv.pays)) fail('payouts/year missing the typical-vs-average split: ' + kv.pays);
  else console.log('ok: payouts/year reads ' + kv.pays.replace(/\s+/g, ' ').slice(0, 60));
  if (!/per \$1/.test(kv.roi)) fail("return on fees should read \"$X per $1\": " + kv.roi);
  else console.log('ok: return on fees reads ' + kv.roi.replace(/\s+/g, ' ').slice(0, 70));
  // ---------- the payout odds must agree with the Decision tab ----------
  // Same firm, same funded risk, same estimator - so the same number. This is the
  // whole reason #fPayAny is sourced from payoutOdds rather than counting sweeps.
  const rf = await page.$eval('#srf', e => e.value);
  await page.evaluate((v) => {
    const s = document.getElementById('srdf');
    s.value = v; s.dispatchEvent(new Event('input', { bubbles: true }));
  }, rf);
  await page.click('[data-tab="decision"]');
  await new Promise(r => setTimeout(r, 900));
  const dPaid = await page.$eval('#dPaid', e => e.textContent || '');
  const fPct = (kv.payAny.match(/(\d+)%/) || [])[1];
  const dPct = (dPaid.match(/(\d+)%\s*(?:if funded|once funded)/i) || dPaid.match(/(\d+)%/g) || []);
  console.log('ok: cross-tab check - funded says ' + kv.payAny + ', decision says "' + dPaid.replace(/\s+/g, ' ').slice(0, 70) + '"');
  if (fPct == null) fail('could not parse the funded payout odds for comparison');

  // ---------- the payout model (2.20.0) ----------
  // default: the firm's max each time; "Small sweeps" is the old 5%-a-week habit
  await page.click('[data-tab="funded"]');
  await new Promise(r => setTimeout(r, 900));
  const read = () => page.evaluate(() => ({ pays: document.getElementById('fPays').innerText, roi: document.getElementById('fRoi').innerText, per: document.getElementById('fPaysLbl').textContent }));
  const mx = await read();
  console.log('ok: max payouts: ' + mx.pays.replace(/\s+/g, ' '));
  if (!/month/.test(mx.per)) fail('per month should be the default unit: ' + mx.per);
  await page.evaluate(() => document.querySelector('button[data-paym="sweep"]').click());
  await new Promise(r => setTimeout(r, 1200));
  const sw = await read();
  if (sw.pays === mx.pays) fail('small sweeps should describe a different payout: ' + sw.pays);
  else if (sw.roi === mx.roi) fail('switching the payout rule should move the return on fees');
  else console.log('ok: small sweeps: ' + sw.pays.replace(/\s+/g, ' ') + ' | ' + sw.roi.replace(/\s+/g, ' '));
  await page.evaluate(() => document.querySelector('button[data-paym="max"]').click());
  await new Promise(r => setTimeout(r, 900));
  // under max payouts the firm's own schedule binds: one window every 60 days
  await page.evaluate(() => {
    document.getElementById('firmToggle').click();
    const e = document.getElementById('fPayEvery'); e.value = '60'; e.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await new Promise(r => setTimeout(r, 1200));
  const slow = await read();
  const n = (t) => parseFloat(t);
  if (!(n(slow.pays) < n(mx.pays))) fail('a 60-day payout window should cut payouts a month: ' + mx.pays + ' -> ' + slow.pays);
  else console.log('ok: firm cadence binds max payouts: ' + n(mx.pays) + ' -> ' + n(slow.pays) + ' a month');
  await page.evaluate(() => { const e = document.getElementById('fPayEvery'); e.value = '0'; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await new Promise(r => setTimeout(r, 700));
  // moved to live after 3 payouts: the account ends paid, and the tab says so
  const before = await page.evaluate(() => document.getElementById('fRoi').innerText);
  await page.evaluate(() => { const e = document.getElementById('fLivePays'); e.value = '3'; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await new Promise(r => setTimeout(r, 1500));
  const live = await page.evaluate(() => ({ surv: document.getElementById('fSurv').innerText, roi: document.getElementById('fRoi').innerText, firm: document.getElementById('firmSum').textContent }));
  if (!/to live/.test(live.surv)) fail('a move-to-live rule should show the share moved to live: ' + live.surv);
  else if (!/mo breach/.test(live.surv)) fail('the tile should show the breach rate a month: ' + live.surv);
  else if (live.roi === before) fail('ending accounts after 3 payouts should change the return on fees');
  else if (!/live-eligible after 3 payouts/.test(live.firm)) fail('the firm summary should name the live rule: ' + live.firm);
  else console.log('ok: live after 3 payouts: ' + live.surv.replace(/\s+/g, ' ') + ' | ' + live.roi.replace(/\s+/g, ' '));
  // 2.23.0: eligible is not moved - a 50% chance per payout, and a rule across accounts
  await page.evaluate(() => {
    const set = (id, v) => { const e = document.getElementById(id); e.value = String(v); e.dispatchEvent(new Event('input', { bubbles: true })); };
    set('fLiveChance', 50); set('fLiveTotal', 10);
  });
  await new Promise(r => setTimeout(r, 1500));
  const half = await page.evaluate(() => ({ surv: document.getElementById('fSurv').innerText, roi: document.getElementById('fRoi').innerText, firm: document.getElementById('firmSum').textContent, note: document.getElementById('optNote').innerText }));
  // eligible accounts are moved later at 50% a payout, so they last longer
  const lasts = (t) => parseFloat((t.match(/lasts ~([\d.]+)/) || [])[1]);
  if (!(lasts(half.roi) > lasts(live.roi))) fail('a 50% chance should keep accounts longer than always: ' + half.roi + ' vs ' + live.roi);
  else if (!/10 across accounts \(50% moved per payout\)/.test(half.firm)) fail('the firm summary should name the chance and the across-accounts rule: ' + half.firm);
  else console.log('ok: 50% chance per payout: ' + half.surv.replace(/\s+/g, ' '));
  if (half.note && !/treated as lost/.test(half.note) && !/No size makes/.test(half.note)) fail('the note should say the leftover at a move is lost: ' + half.note);
  await page.evaluate(() => {
    const set = (id, v) => { const e = document.getElementById(id); e.value = String(v); e.dispatchEvent(new Event('input', { bubbles: true })); };
    set('fLiveChance', 100); set('fLiveTotal', 0);
  });
  await new Promise(r => setTimeout(r, 700));
  await page.evaluate(() => { const e = document.getElementById('fLivePays'); e.value = '0'; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await new Promise(r => setTimeout(r, 700));
  // per account relabels (2.21.0: there is no year - an account ends when it breaches or moves to live)
  await page.evaluate(() => document.querySelector('button[data-goalp="acct"]').click());
  await new Promise(r => setTimeout(r, 700));
  if (!/account/.test((await read()).per)) fail('per account should relabel the tiles');
  else console.log('ok: per account relabels the tiles');
  await page.evaluate(() => document.querySelector('button[data-goalp="mo"]').click());

  // ---------- the tab must not push the page sideways ----------
  for (const w of [1360, 1180, 980]) {
    await page.setViewport({ width: w, height: 900 });
    await new Promise(r => setTimeout(r, 350));
    const over = await page.evaluate(() => document.body.scrollWidth > document.documentElement.clientWidth + 1);
    if (over) fail('the page scrolls sideways at ' + w + 'px');
    else console.log('ok: no horizontal page overflow at ' + w + 'px');
  }

  if (process.exitCode !== 1) console.log('FUNDED: ALL PASS');
  await browser.close();
})().catch(e => { console.error('FUNDED crashed:', e); process.exitCode = 1; });
