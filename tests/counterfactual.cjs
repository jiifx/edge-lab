// The join: a journal segment reaching the engine.
//
// Before this, the edge report could say "shorts are a -0.58R leak" and the
// odds panel could compute pass odds, but nothing connected them - the engine
// was fed by account scope only, and a trader could not ask "what happens to my
// odds if I stop taking shorts?". This drives the real app end to end: the cut
// must move the numbers on the tabs, it must never be answered without its
// survival cost, and below 30 kept trades it must refuse rather than answer
// smaller.
const puppeteer = require('puppeteer-core');
const path = require('path');
const APP = 'file:///' + path.resolve(__dirname, '../dist/PropEdgeLab2.html').replace(/\\/g, '/');
function fail(m) { console.error('FAIL: ' + m); process.exitCode = 1; }
function ok(m) { console.log('ok - ' + m); }

// Main: 200 trades where the shorts really are a leak - longs about +0.54R,
// shorts about -0.63R, which is a five-sigma split and clears the multiplicity
// floor with room. (A borderline one is deliberately not the fixture here: the
// unit tests own where the bars sit, this owns that the wire works.) Small: 40
// trades with 13 shorts, so cutting them leaves 27 and the app has to decline.
function seedTrades() {
  let s = 20260803;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const out = [];
  const mk = (id, acct, i, long, r, sess) => ({
    id, createdAt: 1750000000000 + out.length * 1000,
    dateTime: '2026-0' + (1 + (i % 5)) + '-' + String(1 + (i % 27)).padStart(2, '0') + 'T09:15',
    exitTime: '2026-0' + (1 + (i % 5)) + '-' + String(1 + (i % 27)).padStart(2, '0') + 'T10:05',
    instrument: 'ES', account: acct, direction: long ? 'long' : 'short',
    session: sess, setup: 'ORB', entryModel: 'Liq sweep',
    entry: null, stop: null, target: null, exit: null, size: null,
    riskAmt: 250, pnl: Math.round(r * 250), fees: null,
    R: +r.toFixed(2), Rmanual: true, pnlManual: false,
    tags: { quality: 'B setup', mistake: [], condition: ['Trend day'] },
    emotionBefore: 2, emotionAfter: 2, followedPlan: true,
    planText: '', notes: '', imageIds: [], mfeR: null, maeR: null,
    mfe: null, mae: null, mfeD: null, maeD: null,
  });
  const SESS = ['Asia', 'London', 'New York'];
  for (let i = 0; i < 150; i++) out.push(mk('L' + i, 'Main', i, true, rnd() < 0.55 ? 1.8 : -1, SESS[i % 3]));
  for (let i = 0; i < 50; i++) out.push(mk('S' + i, 'Main', i, false, rnd() < 0.15 ? 1.5 : -1, SESS[i % 3]));
  for (let i = 0; i < 27; i++) out.push(mk('sl' + i, 'Small', i, true, rnd() < 0.5 ? 1.8 : -1, SESS[i % 3]));
  for (let i = 0; i < 13; i++) out.push(mk('ss' + i, 'Small', i, false, rnd() < 0.2 ? 1.5 : -1, SESS[i % 3]));
  return out;
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new',
    userDataDir: path.resolve('./pel-test/profile-counterfactual-' + process.pid),
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--edge-skip-compat-layer-relaunch'],
  });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => { try { if (localStorage.getItem('pel_prop') == null) localStorage.setItem('pel_prop', 'true'); } catch (e) { /* opaque origin */ } });  // these suites exercise prop-firm mode
  await page.setViewport({ width: 1400, height: 950 });
  page.on('pageerror', (e) => fail('pageerror: ' + e.message));
  await page.goto(APP, { waitUntil: 'load' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 20000 });

  await page.evaluate(async (trades) => {
    localStorage.setItem('pel_jmeta', JSON.stringify({
      startBalance: null, accounts: ['Main', 'Small'], balances: { Main: 50000, Small: 50000 },
      rBasis: { Main: { mode: 'fixed', v: 250 }, Small: { mode: 'fixed', v: 250 } },
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
  await page.evaluate(() => {
    if (!document.getElementById('askOv').classList.contains('hide')) {
      const b = [...document.querySelectorAll('#askBtns button')].find((x) => /later/i.test(x.textContent));
      if (b) b.click();
    }
  });

  const settle = (ms = 1500) => new Promise((r) => setTimeout(r, ms));
  const pick = async (id, value) => page.evaluate((a) => {
    const el = document.getElementById(a.id);
    if (!el) throw new Error('missing #' + a.id);
    el.value = a.value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, { id, value });
  const read = () => page.evaluate(() => {
    const box = document.getElementById('jedgeCut');
    const sel = document.getElementById('jEdgeCut');
    return {
      desc: document.getElementById('jedgeDesc').innerText.replace(/\s+/g, ' ').trim(),
      hidden: box.classList.contains('hide'),
      cls: box.className,
      cut: box.innerText.replace(/\s+/g, ' ').trim(),
      opts: [...sel.options].map((o) => o.textContent),
      selValue: sel.value,
      cPass: (document.getElementById('cPass') || {}).innerText || '',
    };
  });
  const cutValue = (group, label) => JSON.stringify({ group, label });

  // switch to the Simulator and turn the journal edge on
  await page.evaluate(() => {
    document.querySelector('[data-mode="sim"]').click();
    [...document.querySelectorAll('.tabs button')].find((b) => /challenge/i.test(b.textContent))?.click();
    const u = document.getElementById('useJournal');
    if (!u.checked) { u.checked = true; u.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await settle();
  // scope the edge to Main: "all accounts" would pool the small account in and
  // the counts under test would be the sum of two records
  await pick('jEdgeAcct', 'Main');
  await settle();

  // ---------- 1. the control exists, is populated, and is quiet when unset ----------
  let st = await read();
  if (!/200 trades from/i.test(st.desc)) fail('expected the full 200-trade record first: ' + st.desc);
  else ok('journal edge on, engine running the full record: ' + st.desc.slice(0, 70));

  const shortOpt = st.opts.find((o) => /^Direction · Short/.test(o));
  if (!shortOpt) fail('the cut list must offer the segments the edge report names, got: ' + JSON.stringify(st.opts.slice(0, 8)));
  else if (!/\(50\)/.test(shortOpt)) fail('the option must carry the count the cut will actually remove: ' + shortOpt);
  else ok('the cut list offers ' + st.opts.length + ' segments, including "' + shortOpt + '"');

  if (!st.hidden) fail('with nothing cut the readout must not be on screen: ' + st.cut);
  else ok('nothing cut -> no readout, no claim');

  const passBefore = st.cPass;

  // ---------- 2. the cut reaches the engine ----------
  await pick('jEdgeCut', cutValue('Direction', 'Short'));
  await settle(2200);
  st = await read();

  if (!/without Direction · Short/i.test(st.desc)) fail('the edge line must say what it is leaving out: ' + st.desc);
  else if (!/150 trades from/i.test(st.desc)) fail('the engine must be on the 150 kept trades: ' + st.desc);
  else ok('the engine is now running 150 trades, not 200: ' + st.desc.slice(0, 90));

  if (st.hidden) fail('the readout must appear when a cut is applied');
  else ok('the readout is on screen');

  if (st.cPass === passBefore) fail('the Challenge tab did not move - the cut never reached the engine (' + passBefore + ')');
  else ok('and the tab moved with it: pass ' + passBefore.replace(/\n/g, ' ') + ' -> ' + st.cPass.replace(/\n/g, ' '));

  // ---------- 3. no recommendation without its survival cost ----------
  if (!/stay funded 1yr/i.test(st.cut)) fail('the survival row is not optional: ' + st.cut);
  else ok('the readout carries survival beside pass odds');
  if (!/pass the eval/i.test(st.cut)) fail('missing the pass row: ' + st.cut);
  if (!/expectancy/i.test(st.cut)) fail('missing the expectancy row: ' + st.cut);
  if (!/90% band/i.test(st.cut)) fail('a change with no band is a claim with no cost: ' + st.cut);
  else ok('and the band on the change');
  if (!/noise floor/i.test(st.cut)) fail('the selection floor must be shown, not just used: ' + st.cut);
  else ok('and the noise floor a scan of that many segments throws up for free');

  // this seeded record has a genuinely large direction split, so it should clear
  // both bars - if it does not, the bars have become unusable rather than strict
  if (!/hypothesis/i.test(st.cut)) fail('a cleared cut must still be labelled a hypothesis: ' + st.cut);
  else ok('a real leak clears both bars and is still called a hypothesis, not an instruction');

  // ---------- 4. it survives a reload ----------
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 20000 });
  await settle(2000);
  st = await read();
  if (st.selValue !== cutValue('Direction', 'Short')) fail('the cut did not persist: ' + st.selValue);
  else if (!/150 trades from/i.test(st.desc)) fail('restored the cut but not the edge behind it: ' + st.desc);
  else ok('the cut and the record behind it both survive a reload');

  // ---------- 5. under 30 kept trades it refuses, and says so ----------
  await pick('jEdgeAcct', 'Small');
  await settle(2200);
  st = await read();
  if (!/Not applied/i.test(st.cut)) fail('cutting 13 of 40 leaves 27 and must be declined: ' + st.cut);
  else ok('27 trades left -> declined: ' + st.cut.slice(0, 110));
  if (!/\b30\b/.test(st.cut)) fail('the refusal has to name the bar it is applying: ' + st.cut);
  else ok('and it names the 30-trade bar Validate uses');
  if (!/warn/.test(st.cls)) fail('a declined cut should not look like a normal answer: ' + st.cls);
  if (!/40 trades from/i.test(st.desc)) {
    fail('a declined cut must leave the FULL record driving every tab, got: ' + st.desc);
  } else ok('and every tab is still on the full 40-trade record, not the 27');

  // and the same refusal has to be REACHABLE, not only inherited. Hiding the
  // option on a small account meant a trader could ask nothing and be told
  // nothing - the question simply had no control.
  await pick('jEdgeCut', '');
  await settle(1500);
  st = await read();
  const smallShort = st.opts.find((o) => /^Direction · Short/.test(o));
  if (!smallShort) fail('a 40-trade account must still be able to ASK, got: ' + JSON.stringify(st.opts));
  else ok('the option is still offered on a record too small to answer it: "' + smallShort + '"');
  await pick('jEdgeCut', cutValue('Direction', 'Short'));
  await settle(1800);
  st = await read();
  if (!/Not applied/i.test(st.cut)) fail('picking it fresh must decline the same way: ' + st.cut);
  else ok('and picking it fresh gives the same refusal, with the reason');

  // ---------- 6. clearing it puts everything back ----------
  await pick('jEdgeAcct', 'Main');
  await pick('jEdgeCut', '');
  await settle(1800);
  st = await read();
  if (!st.hidden) fail('clearing the cut must clear the readout: ' + st.cut);
  else if (!/200 trades from/i.test(st.desc)) fail('back to the full record: ' + st.desc);
  else ok('clearing the cut restores the whole record and hides the claim');

  await browser.close();
  if (!process.exitCode) console.log('\nAll counterfactual checks passed.');
})().catch((e) => { fail(e.stack || e.message); process.exit(1); });
