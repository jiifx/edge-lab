// The Validate tab's drawdown panel, driven end to end in a real browser.
//
// The unit tests in tests/unit/dd.test.mjs own the ESTIMATOR - that the numbers
// are right. This owns the CONTRACT the brief states, which is about what may
// reach a screen:
//
//   "No screen may display a drawdown figure without (1) a horizon and (2) a
//    percentile label."
//
// That one cannot be checked by reading the code, because the failure mode is a
// number rendered next to the wrong words. So it is checked by scraping every
// drawdown figure the tab actually paints and requiring both labels beside it.
// The rest: the horizon really moves the answer, the multiplicity banner really
// appears and really widens the intervals, and a cut record never replaces its
// own baseline silently.
const puppeteer = require('puppeteer-core');
const path = require('path');
const APP = 'file:///' + path.resolve(__dirname, '../dist/PropEdgeLab2.html').replace(/\\/g, '/');
function fail(m) { console.error('FAIL: ' + m); process.exitCode = 1; }
function ok(m) { console.log('ok - ' + m); }

// The brief's reference record: 51 wins at +1.735R, 40 losses at -1R, 10
// scratches. Expectancy +0.48R, per-trade SD ~1.31R. Dealt two a day so the
// record carries dates, and with a clear long/short split so the Leave-out
// control has a segment worth testing.
function seedTrades() {
  const pool = [...Array(51).fill(1.735), ...Array(40).fill(-1), ...Array(10).fill(0)];
  let s = 20260804;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const shuffled = [];
  while (pool.length) shuffled.push(pool.splice((rnd() * pool.length) | 0, 1)[0]);
  return shuffled.map((r, i) => {
    const day = 1 + Math.floor(i / 2);
    const mo = 4 + Math.floor((day - 1) / 25), dom = ((day - 1) % 25) + 1;
    return {
      id: 'v' + i, createdAt: 1750000000000 + i * 60000,
      dateTime: '2026-' + String(mo).padStart(2, '0') + '-' + String(dom).padStart(2, '0') + 'T09:' + String(10 + (i % 45)).padStart(2, '0'),
      instrument: 'ES', account: 'Main', direction: i % 3 === 0 ? 'short' : 'long',
      session: ['Asia', 'London', 'New York'][i % 3], setup: 'ORB',
      entry: null, stop: null, target: null, exit: null, size: null,
      riskAmt: 250, pnl: Math.round(r * 250), fees: null, R: r, Rmanual: true, pnlManual: false,
      tags: { quality: 'B setup', mistake: [], condition: ['Trend day'] },
      emotionBefore: 2, emotionAfter: 2, followedPlan: true,
      planText: '', notes: '', imageIds: [],
    };
  });
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new',
    userDataDir: path.resolve('./pel-test/profile-validate-' + process.pid),
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--edge-skip-compat-layer-relaunch'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1100 });
  page.on('pageerror', (e) => fail('pageerror: ' + e.message));
  await page.goto(APP, { waitUntil: 'load' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 20000 });
  await page.evaluate(async (trades) => {
    localStorage.setItem('pel_jmeta', JSON.stringify({
      startBalance: null, accounts: ['Main'], balances: { Main: 50000 },
      rBasis: { Main: { mode: 'fixed', v: 250 } },
    }));
    localStorage.removeItem('pel_edge_looks');
    localStorage.removeItem('pel_dd_horizon');
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
  await page.evaluate(() => {
    if (!document.getElementById('askOv').classList.contains('hide')) {
      const b = [...document.querySelectorAll('#askBtns button')].find((x) => /later/i.test(x.textContent));
      if (b) b.click();
    }
    document.querySelector('[data-mode="sim"]').click();
    document.querySelector('[data-tab="validate"]').click();
    const uj = document.getElementById('useJournal');
    if (!uj.checked) { uj.checked = true; uj.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  const settle = (ms = 2200) => new Promise((r) => setTimeout(r, ms));
  await page.waitForFunction(() => /R$/.test((document.querySelector('#ddLadder .tile .v') || {}).textContent || ''), { timeout: 30000 });
  await settle();

  // ---------- 1. THE CONTRACT ----------
  // Every drawdown figure the tab paints, with the label it was painted beside.
  const figures = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('#ddLadder .tile').forEach((t) => {
      const v = (t.querySelector('.v') || {}).textContent || '';
      if (!/\d/.test(v)) return;
      out.push({ where: 'ladder', value: v.trim(), label: (t.querySelector('.k') || {}).textContent || '', pct: (t.querySelector('.pl') || {}).textContent || '' });
    });
    const risk = document.querySelector('#ddRisk .ddrisk');
    if (risk) out.push({ where: 'risk', value: (risk.querySelector('.rv') || {}).textContent || '', label: (risk.querySelector('.rk') || {}).textContent || '', pct: (risk.querySelector('.rs') || {}).textContent || '' });
    return out;
  });
  if (!figures.length) fail('the drawdown panel painted nothing at all');
  let contractOk = true;
  for (const f of figures) {
    const text = (f.label + ' ' + f.pct).toLowerCase();
    const hasPct = /p\d{2}|percentile|coin flip/.test(text);
    const hasHz = /over \d+|next \d+ trades|\d+ trades/.test(text);
    if (!hasPct) { fail('a drawdown figure carries no percentile label: ' + JSON.stringify(f)); contractOk = false; }
    if (!hasHz) { fail('a drawdown figure carries no horizon: ' + JSON.stringify(f)); contractOk = false; }
  }
  if (contractOk) ok('all ' + figures.length + ' drawdown figures carry BOTH a horizon and a percentile');
  // and the words the old build used are gone
  const body = await page.$eval('#p-validate', (e) => e.innerText.toLowerCase());
  if (/~\d+r typical/.test(body) || /r rough/.test(body)) fail('"typical"/"rough" drawdown wording survived');
  else ok('the median is no longer sold as "typical", nor the 90th as "rough"');
  if (!/coin flip/.test(body)) fail('p50 is not labelled as the coin flip it is');
  else ok('p50 is labelled "coin flip - NOT a plan"');

  // ---------- 2. THE HORIZON MOVES THE ANSWER ----------
  const ladderAt = async (h) => {
    await page.evaluate((hz) => {
      const s = document.getElementById('sHz');
      s.value = String(hz); s.dispatchEvent(new Event('input', { bubbles: true }));
    }, h);
    await settle(2600);
    return page.evaluate(() => [...document.querySelectorAll('#ddLadder .tile')].map((t) => ({
      k: t.querySelector('.k').textContent, v: parseFloat(t.querySelector('.v').textContent),
    })));
  };
  const at100 = await ladderAt(100);
  const at1000 = await ladderAt(1000);
  if (!at100.every((x) => /over 100$/.test(x.k))) fail('the ladder labels did not follow the horizon to 100: ' + JSON.stringify(at100.map((x) => x.k)));
  if (!at1000.every((x) => /over 1000$/.test(x.k))) fail('the ladder labels did not follow the horizon to 1000');
  else ok('every tile restates the horizon it was computed at');
  let grew = true;
  at100.forEach((a, i) => { if (!(at1000[i].v > a.v)) grew = false; });
  if (!grew) fail('drawdown did not grow from a 100-trade to a 1,000-trade horizon: ' + JSON.stringify([at100, at1000]));
  else ok('drawdown grows with the horizon (p50 ' + at100[0].v + 'R -> ' + at1000[0].v + 'R, p99 ' + at100[3].v + 'R -> ' + at1000[3].v + 'R)');
  // the acceptance numbers, loosely: the double bootstrap at 1,000 must be well
  // clear of the plug-in figure the old panel would have shown for 101 trades
  if (!(at100[0].v >= 4.4 && at100[0].v <= 6.6)) fail('p50 at T=100 out of range: ' + at100[0].v);
  else ok('p50 at 100 trades sits where the reference record says it should (' + at100[0].v + 'R)');

  // ---------- 3. UNCERTAINTY REACHES THE DRAWDOWN ----------
  // The panel must not be quoting the point estimate: the double bootstrap's
  // upper tail is materially above what a plug-in run gives. Checked through the
  // ONE lever the UI exposes on the same paths - block vs independent are the
  // same here (a shuffled record), so this instead checks the tail is wide
  // relative to the median, which a plug-in run at this edge is not.
  const spread = at1000[3].v / at1000[0].v;
  if (!(spread > 1.9)) fail('p99/p50 at T=1000 is only ' + spread.toFixed(2) + 'x - too tight to be carrying parameter uncertainty');
  else ok('the p99/p50 spread is ' + spread.toFixed(2) + 'x, the shape of a predictive rather than a plug-in distribution');

  // ---------- 4. EFFECTIVE SAMPLE SIZE ----------
  const nTxt = await page.$eval('#vN', (e) => e.innerText);
  const nNote = await page.$eval('#vNNote', (e) => e.innerText);
  if (!/\b101\b/.test(nTxt)) fail('the raw trade count went missing: ' + nTxt);
  else if (!/effective/.test(nTxt)) fail('n_eff is not displayed beside n: ' + nTxt);
  else if (!/independent · .+/.test(nNote)) fail('nothing says WHY the sample was discounted: ' + nNote);
  else ok('the sample row shows both counts ("' + nTxt.replace(/\n/g, ' / ') + '") and names the reason');

  // ---------- 5. BREAK-EVEN IS ALWAYS IN FRAME ----------
  // The old caption promised a dashed break-even line that could not render:
  // with 1.74R winners break-even is a 36% win rate and the plotted range was
  // the CI around 56%. The chart now plots EXPECTANCY, where break-even is zero
  // and the axis is built to include it - so the line must be on the canvas.
  const bell = await page.evaluate(() => {
    const c = document.getElementById('cBell');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    // the dashed zero line is drawn in --stop; count strongly red-dominant pixels
    let red = 0, painted = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      painted++;
      if (d[i] > d[i + 1] + 40 && d[i] > d[i + 2] + 40) red++;
    }
    return { red, painted, w: c.clientWidth };
  });
  if (!bell.painted) fail('the expectancy chart is blank');
  else if (bell.red < 20) fail('no break-even line on the expectancy chart (' + bell.red + ' red pixels) - it is off the axis again');
  else ok('break-even is drawn on the expectancy chart (' + bell.red + ' pixels of it) and cannot leave the frame');

  // ---------- 6. ONE WIN-RATE DEFINITION ----------
  const wr = await page.$eval('#vWR', (e) => e.textContent);
  const wrLabel = await page.$eval('#p-validate .kv .r .k', (e) => e.textContent);
  if (!/decided/i.test(wrLabel)) fail('the win-rate label does not state its definition: ' + wrLabel);
  else ok('the win-rate row states its definition ("' + wrLabel.trim() + '")');
  const m = wr.match(/(\d+)%/);
  const jWr = await page.evaluate(() => {
    document.querySelector('[data-mode="journal"]').click();
    return null;
  });
  await settle(900);
  const jTxt = await page.$eval('#jSummary', (e) => e.innerText);
  await page.evaluate(() => { document.querySelector('[data-mode="sim"]').click(); });
  await settle(1400);
  const jm = jTxt.match(/Win rate\s*\n?\s*(\d+)%/i);
  if (m && jm && m[1] !== jm[1]) fail('the Validate tab says ' + m[1] + '% and the journal says ' + jm[1] + '% for the same trades');
  else if (m && jm) ok('Validate and the journal agree on the win rate (' + m[1] + '% of decided trades)');
  void jWr;

  // ---------- 7. MULTIPLE COMPARISONS ----------
  const before = await page.$eval('#vEV', (e) => e.textContent);
  const hiddenBefore = await page.$eval('#vLooks', (e) => e.classList.contains('hide'));
  if (!hiddenBefore) fail('the multiplicity banner is showing before any subset was tested');
  else ok('no banner on a record nobody has sliced');
  // test two subsets through the Leave-out control
  const picked = await page.evaluate(() => {
    const sel = document.getElementById('jEdgeCut');
    const opts = [...sel.options].filter((o) => o.value && o.value !== '');
    const out = [];
    for (const o of opts.slice(0, 2)) out.push(o.value);
    return out;
  });
  for (const v of picked) {
    await page.evaluate((val) => {
      const sel = document.getElementById('jEdgeCut');
      sel.value = val; sel.dispatchEvent(new Event('change', { bubbles: true }));
    }, v);
    await settle(1600);
  }
  await settle(2400);
  const after = await page.evaluate(() => ({
    ev: document.getElementById('vEV').textContent,
    hidden: document.getElementById('vLooks').classList.contains('hide'),
    msg: document.getElementById('vLooksMsg').innerText,
    baseHidden: document.getElementById('vBaseline').classList.contains('hide'),
    baseMsg: document.getElementById('vBaselineMsg').innerText,
  }));
  if (picked.length < 2) {
    console.log('skip - fewer than two segments offered on this fixture');
  } else if (after.hidden) {
    fail('two subsets tested and the multiplicity banner never appeared');
  } else if (!/no longer|not a 95%|widened|Bonferroni/i.test(after.msg)) {
    fail('the banner does not say the 95% label stopped meaning 95%: ' + after.msg);
  } else {
    ok('after ' + (picked.length + 1) + ' looks the banner says so: "' + after.msg.slice(0, 90).replace(/\n/g, ' ') + '..."');
  }
  // ...and the widening has to be the MULTIPLICITY, not just a smaller record.
  // Clearing the cut puts the identical 101 trades back in force; the looks
  // already happened, so the same record must now read wider than it did before
  // anybody went looking. Comparing a cut record to a full one would have proved
  // nothing - the sample size moved too.
  {
    await page.evaluate(() => {
      const sel = document.getElementById('jEdgeCut');
      sel.value = ''; sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle(2400);
    const back = await page.evaluate(() => ({
      ev: document.getElementById('vEV').textContent,
      n: document.getElementById('vN').innerText,
      hidden: document.getElementById('vLooks').classList.contains('hide'),
    }));
    // the row reads "+0.48R" on the face and "+0.20 to +0.76R" underneath, so
    // the interval is the SUB-line - anchoring on the first number would measure
    // the point estimate against itself
    const w = (s) => { const p = s.match(/([-+][\d.]+) to ([-+][\d.]+)R/); return p ? parseFloat(p[2]) - parseFloat(p[1]) : 0; };
    if (!/\b101\b/.test(back.n)) fail('clearing the cut did not restore the full record: ' + back.n);
    else if (back.hidden) fail('clearing the cut hid the banner - the looks already happened and cannot be undone');
    else if (!(w(back.ev) > w(before) + 0.005)) fail('the SAME 101 trades did not widen after 3 looks: ' + before + ' -> ' + back.ev);
    else ok('the same 101 trades read wider after 3 looks than before any (' + before + ' -> ' + back.ev + ')');
  }
  // ---------- 8. THE BASELINE IS NEVER REPLACED SILENTLY ----------
  if (after.baseHidden) fail('a cut is applied and the full-record result is not shown beside it');
  else if (!/Without .+ removed: \d+ trades/i.test(after.baseMsg)) fail('the baseline box does not describe the full record: ' + after.baseMsg);
  else ok('the full record stays on screen beside the cut ("' + after.baseMsg.slice(0, 80).replace(/\n/g, ' ') + '...")');

  // ---------- 9. n_eff REALLY REACHES THE INTERVALS ----------
  // The panel can print "effective n ~ 83" and still divide by 101, and nothing
  // above would notice. So: the SAME 101 R multiples, the same multiset, the
  // same mean and the same standard deviation - only the ORDER and the day each
  // trade was taken on are changed, so that every trading day is homogeneous.
  // n cannot move, sd cannot move, and the only thing left that can widen the
  // interval is the effective sample size. If it does not widen, n_eff is
  // decoration.
  {
    const clustered = (() => {
      const wins = Array(51).fill(1.735), losses = Array(40).fill(-1), scr = Array(10).fill(0);
      const order = [];
      // deal whole DAYS of one kind: 4 wins, then 4 losses, then a scratch day
      while (wins.length || losses.length || scr.length) {
        for (let i = 0; i < 4 && wins.length; i++) order.push(wins.pop());
        for (let i = 0; i < 4 && losses.length; i++) order.push(losses.pop());
        for (let i = 0; i < 2 && scr.length; i++) order.push(scr.pop());
      }
      return order.map((r, i) => {
        const day = 1 + Math.floor(i / 4);           // 4 trades a day, all alike
        const mo = 4 + Math.floor((day - 1) / 25), dom = ((day - 1) % 25) + 1;
        return {
          id: 'c' + i, createdAt: 1750000000000 + i * 60000,
          dateTime: '2026-' + String(mo).padStart(2, '0') + '-' + String(dom).padStart(2, '0') + 'T09:' + String(10 + (i % 45)).padStart(2, '0'),
          instrument: 'ES', account: 'Main', direction: 'long', session: 'New York', setup: 'ORB',
          entry: null, stop: null, target: null, exit: null, size: null,
          riskAmt: 250, pnl: Math.round(r * 250), fees: null, R: r, Rmanual: true, pnlManual: false,
          tags: { quality: 'B setup', mistake: [], condition: [] },
          emotionBefore: 2, emotionAfter: 2, followedPlan: true, planText: '', notes: '', imageIds: [],
        };
      });
    })();
    await page.evaluate(async (trades) => {
      // the looks counter must start level, or multiplicity would explain the gap
      localStorage.removeItem('pel_edge_looks');
      const db = await new Promise((res, rej) => {
        const rq = indexedDB.open('propEdgeLab', 1);
        rq.onsuccess = (e) => res(e.target.result); rq.onerror = rej;
      });
      await new Promise((res) => {
        const tx = db.transaction('trades', 'readwrite'), os = tx.objectStore('trades');
        os.clear(); trades.forEach((t) => os.put(t)); tx.oncomplete = res;
      });
    }, clustered);
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction('window.__PEL_READY === true', { timeout: 20000 });
    await page.evaluate(() => {
      if (!document.getElementById('askOv').classList.contains('hide')) {
        const b = [...document.querySelectorAll('#askBtns button')].find((x) => /later/i.test(x.textContent));
        if (b) b.click();
      }
      document.querySelector('[data-mode="sim"]').click();
      document.querySelector('[data-tab="validate"]').click();
      const uj = document.getElementById('useJournal');
      if (!uj.checked) { uj.checked = true; uj.dispatchEvent(new Event('change', { bubbles: true })); }
    });
    await settle(2600);
    const cl = await page.evaluate(() => ({
      ev: document.getElementById('vEV').textContent,
      n: document.getElementById('vN').innerText,
      note: document.getElementById('vNNote').innerText,
      looks: document.getElementById('vLooks').classList.contains('hide'),
    }));
    const w = (s) => { const p = s.match(/([-+][\d.]+) to ([-+][\d.]+)R/); return p ? parseFloat(p[2]) - parseFloat(p[1]) : 0; };
    if (!cl.looks) fail('the looks counter did not reset with the record, so this comparison is contaminated');
    else if (!/\b101\b/.test(cl.n)) fail('the clustered fixture did not load 101 trades: ' + cl.n);
    // either bound may bind - effectiveN takes the SMALLER of the serial and the
    // clustering estimate on purpose - but one of them has to notice, and the
    // note has to say which, or the reader cannot argue with it
    else if (!/(cluster by day|runs of similar trades)/.test(cl.note)) fail('no dependence detected on a record of homogeneous days: ' + cl.note);
    else if (!(w(cl.ev) > w(before) * 1.1)) {
      fail('the same 101 R multiples, reordered into homogeneous days, produced the same interval (' +
        w(before).toFixed(3) + 'R vs ' + w(cl.ev).toFixed(3) + 'R) - n_eff is displayed but not used');
    } else {
      ok('the same multiset dealt into homogeneous days widens the interval ' +
        w(before).toFixed(2) + 'R -> ' + w(cl.ev).toFixed(2) + 'R (' + cl.n.replace(/\n/g, ' / ') + ')');
    }
  }

  if (process.exitCode !== 1) console.log('VALIDATE: ALL PASS');
  await browser.close();
})().catch((e) => { console.error('VALIDATE crashed:', e); process.exitCode = 1; });
