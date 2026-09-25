// The edge band reaching Challenge / Funded / Decision.
//
// Validate spends a whole screen establishing that an edge is real WITHIN A
// RANGE, and every other tab consumed the point estimate. On the reference
// record the end-to-end pass rate is 97% at the point estimate and 77% at the
// low end of the same interval - a one-in-four failure rate presented as
// one-in-thirty-three. This suite pins the fix end to end:
//
//   1. every banded headline shows a range, on all three tabs
//   2. the range BRACKETS the point estimate (it is the same experiment)
//   3. the verdict badges grade on the LOWER bound, not the middle
//   4. a slider edge has no band at all, and says so rather than inventing one
//   5. the band is deterministic - identical inputs, identical range
const puppeteer = require('puppeteer-core');
const path = require('path');
const APP = 'file:///' + path.resolve(__dirname, '../dist/PropEdgeLab2.html').replace(/\\/g, '/');
function fail(m) { console.error('FAIL: ' + m); process.exitCode = 1; }
function ok(m) { console.log('ok - ' + m); }

// 51 wins @ +1.735R, 40 losses @ -1R, 10 scratches: expectancy +0.48R
function seedTrades() {
  const pool = [...Array(51).fill(1.735), ...Array(40).fill(-1), ...Array(10).fill(0)];
  let s = 20260804;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const sh = [];
  while (pool.length) sh.push(pool.splice((rnd() * pool.length) | 0, 1)[0]);
  return sh.map((r, i) => {
    const day = 1 + Math.floor(i / 2);
    const mo = 4 + Math.floor((day - 1) / 25), dom = ((day - 1) % 25) + 1;
    return {
      id: 'b' + i, createdAt: 1750000000000 + i * 60000,
      dateTime: '2026-' + String(mo).padStart(2, '0') + '-' + String(dom).padStart(2, '0') + 'T09:' + String(10 + (i % 45)).padStart(2, '0'),
      instrument: 'ES', account: 'Main', direction: 'long', session: 'New York', setup: 'ORB',
      entry: null, stop: null, target: null, exit: null, size: null,
      riskAmt: 250, pnl: Math.round(r * 250), fees: null, R: r, Rmanual: true, pnlManual: false,
      tags: { quality: 'B setup', mistake: [], condition: [] },
      emotionBefore: 2, emotionAfter: 2, followedPlan: true, planText: '', notes: '', imageIds: [],
    };
  });
}
const pct = (s) => { const m = (s || '').match(/(\d+)%\s*[–\-]\s*(\d+)%/); return m ? [Number(m[1]), Number(m[2])] : null; };
const dol = (s) => {
  const m = (s || '').match(/([-+]?\$[\d,]+)\s*[–\-]\s*([-+]?\$[\d,]+)/);
  const num = (x) => Number(String(x).replace(/[^0-9.-]/g, '')) * (String(x).trim().startsWith('-') ? -1 : 1);
  return m ? [num(m[1]), num(m[2])] : null;
};

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new', userDataDir: path.resolve('./pel-test/profile-bands-' + process.pid),
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--edge-skip-compat-layer-relaunch'],
  });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => { try { if (localStorage.getItem('pel_prop') == null) localStorage.setItem('pel_prop', 'true'); } catch (e) { /* opaque origin */ } });  // these suites exercise prop-firm mode
  await page.setViewport({ width: 1400, height: 1000 });
  page.on('pageerror', (e) => fail('pageerror: ' + e.message));
  await page.goto(APP, { waitUntil: 'load' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 20000 });
  await page.evaluate(async (trades) => {
    localStorage.setItem('pel_jmeta', JSON.stringify({
      startBalance: null, accounts: ['Main'], balances: { Main: 50000 },
      rBasis: { Main: { mode: 'fixed', v: 250 } },
    }));
    const db = await new Promise((res, rej) => {
      const rq = indexedDB.open('propEdgeLab', 1);
      rq.onsuccess = (e) => res(e.target.result); rq.onerror = rej;
    });
    await new Promise((res) => {
      const tx = db.transaction('trades', 'readwrite'), os = tx.objectStore('trades');
      os.clear(); trades.forEach((t) => os.put(t)); tx.oncomplete = res;
    });
  }, seedTrades());
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 20000 });

  const setup = async () => page.evaluate(() => {
    if (!document.getElementById('askOv').classList.contains('hide')) {
      const x = [...document.querySelectorAll('#askBtns button')].find((e) => /later/i.test(e.textContent));
      if (x) x.click();
    }
    document.querySelector('[data-mode="sim"]').click();
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
    if (!document.getElementById('firmEdit').classList.contains('open')) document.getElementById('firmToggle').click();
    set('fType', 'futures'); set('fAccount', '50000'); set('fP1', '6'); set('fMaxdd', '4');
    set('fDdType', 'trailing-eod'); set('fDdLock', '0'); set('fDaily', '2.5'); set('fTpd', '2'); set('fFee', '100');
    const uj = document.getElementById('useJournal');
    if (!uj.checked) { uj.checked = true; uj.dispatchEvent(new Event('change', { bubbles: true })); }
    document.querySelector('[data-tab="challenge"]').click();
  });
  await setup();
  await page.waitForFunction(() => /90% range/.test(document.getElementById('cPassBand').innerText || ''), { timeout: 150000 });
  await new Promise((r) => setTimeout(r, 700));

  // ---------- 1 + 2 + 3: Challenge ----------
  const chal = await page.evaluate(() => ({
    point: document.getElementById('cPass').innerText,
    band: document.getElementById('cPassBand').innerText,
    chip: document.getElementById('cChip').textContent,
    title: document.getElementById('cChip').title,
  }));
  const cb = pct(chal.band);
  const cp = Number((chal.point.match(/(\d+)%/) || [])[1]);
  if (!cb) fail('Challenge shows no pass band: ' + chal.band);
  else if (!(cb[0] <= cp && cp <= cb[1])) fail('the band does not bracket the point estimate: ' + cp + '% vs ' + cb.join('-'));
  else ok('Challenge pass ' + cp + '% sits inside its own 90% range ' + cb[0] + '-' + cb[1] + '%');
  // the badge must be graded on the LOW end - that is the whole point
  const expect = cb[0] >= 85 ? 'Strong' : cb[0] >= 55 ? 'Shaky' : 'Unlikely';
  if (chal.chip !== expect) fail('the badge reads "' + chal.chip + '" but the lower bound ' + cb[0] + '% implies "' + expect + '"');
  else ok('the badge grades on the lower bound: ' + cb[0] + '% -> "' + chal.chip + '"');
  if (!/LOW end/.test(chal.title)) fail('the badge does not disclose that it grades on the low end: ' + chal.title);
  else ok('...and says so on hover');
  // and it must actually DIFFER from the point-estimate grading on this fixture,
  // or the test proves nothing
  const naive = cp >= 85 ? 'Strong' : cp >= 55 ? 'Shaky' : 'Unlikely';
  if (naive === chal.chip) console.log('note - point estimate and lower bound grade the same here (' + naive + ')');
  else ok('and it changes the verdict: point estimate would say "' + naive + '", the band says "' + chal.chip + '"');

  // ---------- Funded ----------
  await page.evaluate(() => document.querySelector('[data-tab="funded"]').click());
  await new Promise((r) => setTimeout(r, 4000));
  const fs = await page.$eval('#fSurv', (e) => e.innerText);
  const fb = pct(fs);
  const fp = Number((fs.match(/(\d+)%/) || [])[1]);
  if (!fb) fail('Funded survival shows no band: ' + fs);
  else if (!(fb[0] <= fp && fp <= fb[1])) fail('survival band does not bracket its point estimate: ' + fs);
  else ok('Funded survival ' + fp + '% inside its 90% range ' + fb[0] + '-' + fb[1] + '%');

  // ---------- Decision ----------
  await page.evaluate(() => document.querySelector('[data-tab="decision"]').click());
  await new Promise((r) => setTimeout(r, 4000));
  const dec = await page.evaluate(() => ({
    ev: document.getElementById('dEV').textContent,
    band: document.getElementById('dEVBand').innerText,
    chip: document.getElementById('dChip').textContent,
    title: document.getElementById('dChip').title,
  }));
  const db2 = dol(dec.band);
  const dp = Number(dec.ev.replace(/[^0-9.-]/g, '')) * (dec.ev.trim().startsWith('-') ? -1 : 1);
  if (!db2) fail('Decision EV shows no band: ' + dec.band);
  else if (!(db2[0] <= dp + 1 && dp - 1 <= db2[1])) fail('EV band does not bracket the mean: ' + dp + ' vs ' + db2.join('-'));
  else ok('Decision EV ' + dec.ev + ' inside its 90% range ' + dec.band.replace(/across.*/, '').trim());
  const wantChip = db2 && db2[0] <= 0 && db2[1] > 0 ? 'Could go either way' : db2 && db2[0] > 0 ? 'Worth it' : 'Not worth it';
  if (dec.chip !== wantChip) fail('the verdict reads "' + dec.chip + '" but the range ' + db2.join(' to ') + ' implies "' + wantChip + '"');
  else ok('the verdict grades on the downside: "' + dec.chip + '"');

  // ---------- 5: determinism ----------
  await page.evaluate(() => {
    document.querySelector('[data-tab="challenge"]').click();
    document.querySelector('[data-tab="decision"]').click();
  });
  await new Promise((r) => setTimeout(r, 1500));
  const again = await page.$eval('#dEVBand', (e) => e.innerText);
  if (again !== dec.band) fail('the band moved without an input changing:\n  ' + dec.band + '\n  ' + again);
  else ok('the band is deterministic across a re-render - a change on screen means a real change');

  // ---------- 4: a slider edge has no band, and does not pretend ----------
  await page.evaluate(() => {
    const uj = document.getElementById('useJournal');
    if (uj.checked) { uj.checked = false; uj.dispatchEvent(new Event('change', { bubbles: true })); }
    document.querySelector('[data-tab="challenge"]').click();
  });
  await new Promise((r) => setTimeout(r, 2500));
  const slider = await page.evaluate(() => ({
    band: document.getElementById('cPassBand').innerText.trim(),
    title: document.getElementById('cChip').title,
  }));
  if (slider.band !== '') fail('a slider edge is showing a band it cannot have: "' + slider.band + '"');
  else ok('a slider edge shows no band - the sliders ARE the assumption, there is nothing to resample');
  if (!/no sample/.test(slider.title)) fail('the badge does not explain why there is no band: ' + slider.title);
  else ok('...and the badge says why');

  if (process.exitCode !== 1) console.log('BANDS: ALL PASS');
  await browser.close();
})().catch((e) => { console.error('BANDS crashed:', e); process.exitCode = 1; });
