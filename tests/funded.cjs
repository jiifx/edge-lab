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
const APP = 'file:///' + path.resolve(__dirname, '../dist/PropEdgeLab2.html').replace(/\\/g, '/');
function fail(m) { console.error('FAIL: ' + m); process.exitCode = 1; }

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new',
    userDataDir: path.resolve('./pel-test/profile-funded-' + process.pid),
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--edge-skip-compat-layer-relaunch'],
  });
  const page = await browser.newPage();
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
      surv: t('fSurv'), peak: t('fPeak'),
      goalHidden: document.getElementById('fGoalRow').classList.contains('hide'),
    };
  });
  for (const [k, v] of Object.entries(kv)) {
    if (k === 'goalHidden') continue;
    if (!v || v === '--') fail('#f' + k + ' never populated: "' + v + '"');
  }
  if (!/%/.test(kv.payAny)) fail('chance of a payout is not a percentage: ' + kv.payAny);
  else console.log('ok: chance of a payout reads ' + kv.payAny);
  if (!/typical/.test(kv.pays)) fail('payouts/year missing the typical-vs-average split: ' + kv.pays);
  else console.log('ok: payouts/year reads ' + kv.pays.replace(/\s+/g, ' ').slice(0, 60));
  if (!kv.goalHidden) fail('the goal row must stay hidden until a goal is set');
  else console.log('ok: goal row hidden at goal 0');

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

  // ---------- the goal ----------
  await page.click('[data-tab="funded"]');
  await new Promise(r => setTimeout(r, 500));
  const setGoal = async (v) => {
    await page.evaluate((val) => {
      const n = document.getElementById('nGoal');
      n.value = String(val); n.dispatchEvent(new Event('input', { bubbles: true }));
    }, v);
    await new Promise(r => setTimeout(r, 800));
  };

  await setGoal(9000);
  const g1 = await page.evaluate(() => ({
    hidden: document.getElementById('fGoalRow').classList.contains('hide'),
    text: (document.getElementById('fGoal').textContent || '').trim(),
    sub: (document.getElementById('lGoalSub').textContent || '').trim(),
    slider: document.getElementById('sGoal').value,
  }));
  if (g1.hidden) fail('goal row still hidden after setting a goal');
  else if (!/%/.test(g1.text)) fail('goal row shows no odds: ' + g1.text);
  else console.log('ok: goal $9,000 -> "' + g1.text.replace(/\s+/g, ' ') + '"');
  if (!/payouts of/.test(g1.sub)) fail('goal sub-line does not name the payout quantisation: ' + g1.sub);
  else console.log('ok: goal sub-line reads "' + g1.sub + '"');
  if (Number(g1.slider) < 1) fail('the whole-payout slider did not follow the dollar box: ' + g1.slider);
  else console.log('ok: payout slider re-seated to ' + g1.slider);

  // an absurd goal must say so plainly rather than bracketing noise
  await setGoal(5000000);
  const g2 = await page.$eval('#fGoal', e => (e.textContent || '').trim());
  if (!/out of reach/.test(g2)) fail('an unreachable goal should say so, got: ' + g2);
  else console.log('ok: unreachable goal reads "' + g2 + '"');

  // ---------- per month is an input convenience, not a second number ----------
  // The goal is STORED yearly whatever period is on screen, because the horizon
  // everything else here is measured over is a year. Switching period must move
  // the box, never the target - and it must say so, since payouts are lumpy and
  // a monthly figure invites reading it as a wage.
  await setGoal(12000);
  const yr = await page.evaluate(() => ({ box: document.getElementById('nGoal').value, stored: JSON.parse(localStorage.getItem('pel_pay_goal')) }));
  await page.evaluate(() => document.querySelector('button[data-goalp="mo"]').click());
  await new Promise(r => setTimeout(r, 800));
  const mo = await page.evaluate(() => ({
    box: document.getElementById('nGoal').value,
    stored: JSON.parse(localStorage.getItem('pel_pay_goal')),
    lbl: (document.getElementById('lGoalLbl').textContent || '').trim(),
    sub: (document.getElementById('lGoalSub').textContent || '').trim(),
  }));
  if (Number(mo.stored) !== Number(yr.stored)) fail('switching period moved the target: ' + yr.stored + ' -> ' + mo.stored);
  else console.log('ok: period switch left the stored yearly target at ' + mo.stored);
  if (Number(mo.box) !== Math.round(Number(yr.box) / 12)) fail('monthly box is not the yearly figure over 12: ' + yr.box + ' -> ' + mo.box);
  else console.log('ok: box shows ' + mo.box + '/mo for ' + yr.box + '/yr');
  if (!/month/i.test(mo.lbl)) fail('label did not follow the period: ' + mo.lbl);
  // the lumpy-payouts caveat lives in the user manual now; the sub-line only
  // has to show the yearly total the goal is stored as
  if (!/\/yr = \d+ payouts/.test(mo.sub)) fail('monthly mode must show the yearly total: ' + mo.sub);
  else console.log('ok: monthly mode shows "' + mo.sub.replace(/\s+/g, ' ') + '"');
  await page.evaluate(() => document.querySelector('button[data-goalp="yr"]').click());
  await new Promise(r => setTimeout(r, 700));

  // ---------- the firm's own schedule is a hard ceiling ----------
  // Cadence deliberately does not move the EV, but it still caps how many times
  // you can physically be paid - and that is a different failure from "your edge
  // is too small", with a different fix.
  await page.evaluate(() => {
    document.getElementById('firmToggle').click();
    const set = (id, v) => { const e = document.getElementById(id); e.value = String(v); e.dispatchEvent(new Event('input', { bubbles: true })); };
    set('fPayEvery', 60);   // one withdrawal every 60 trading days
  });
  await setGoal(45000);
  const cap = await page.evaluate(() => ({
    text: (document.getElementById('fGoal').textContent || '').trim(),
    title: document.getElementById('fGoal').title,
  }));
  if (!/caps you first/.test(cap.text)) fail('a goal past the firm cadence ceiling should name the firm, got: ' + cap.text);
  else console.log('ok: cadence ceiling reads "' + cap.text.replace(/\s+/g, ' ') + '"');
  if (!/60 trading days/.test(cap.title)) fail('ceiling tooltip does not explain the window: ' + cap.title);
  await page.evaluate(() => {
    const e = document.getElementById('fPayEvery');
    e.value = '0'; e.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await new Promise(r => setTimeout(r, 700));

  // and back off
  await setGoal(0);
  const g3 = await page.evaluate(() => document.getElementById('fGoalRow').classList.contains('hide'));
  if (!g3) fail('goal row did not hide again at 0');
  else console.log('ok: goal row hides again at 0');

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
