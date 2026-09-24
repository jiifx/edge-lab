// E2E v2: instrument dropdown, tagged trades, edge report, prop odds, persistence.
const puppeteer = require('puppeteer-core');
const path = require('path');

const APP = 'file:///' + path.resolve(__dirname, '../dist/PropEdgeLab2.html').replace(/\\/g, '/');
const PROFILE = path.resolve('./pel-test/profile-e2e2-' + Date.now());
function fail(m){ console.error('FAIL: ' + m); process.exitCode = 1; }

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new', userDataDir: PROFILE,
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--edge-skip-compat-layer-relaunch'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 1400 });
  page.on('pageerror', e => fail('pageerror: ' + e.message));
  await page.goto(APP, { waitUntil: 'load' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 15000 });
  await page.click('[data-mode="journal"]');

  async function type(id, v){ await page.evaluate(id => { document.getElementById(id).value=''; }, id); await page.type('#'+id, String(v), { delay: 2 }); }
  async function chip(setId, val){ await page.evaluate((setId,val)=>{ const b=[...document.querySelectorAll('#'+setId+' .opt')].find(x=>x.getAttribute('data-v')===val); if(b)b.click(); }, setId, val); }
  async function emo(rowId, v){ await page.evaluate((rowId,v)=>{ const b=[...document.querySelectorAll('#'+rowId+' button')].find(x=>x.getAttribute('data-v')==String(v)); if(b)b.click(); }, rowId, v); }

  // --- instrument and session are required, and say which one is missing ----
  // Both are fields the edge report cannot reconstruct later, so the save is
  // refused rather than quietly writing a row that no breakdown can ever show.
  await page.click('#jNew');
  await page.waitForSelector('#editorOv:not(.hide)', { timeout: 5000 });
  await page.click('#edSave');
  await new Promise(r => setTimeout(r, 200));
  let open1 = await page.$eval('#editorOv', e => !e.classList.contains('hide'));
  const symFlag = await page.$eval('#edSymSel', e => e.classList.contains('needs'));
  if (!open1 || !symFlag) fail('saved with no instrument (open=' + open1 + ', flagged=' + symFlag + ')');
  else console.log('ok: save refused with no instrument, and the field is flagged');
  await page.select('#edSymSel', 'ES');
  await page.click('#edSave');
  await new Promise(r => setTimeout(r, 200));
  open1 = await page.$eval('#editorOv', e => !e.classList.contains('hide'));
  const sessFlag = await page.$eval('#edSess', e => e.classList.contains('needs'));
  if (!open1 || !sessFlag) fail('saved with no session (open=' + open1 + ', flagged=' + sessFlag + ')');
  else console.log('ok: save refused with no session, and the field is flagged');
  await page.select('#edSess', 'Asia');
  if (await page.$eval('#edSess', e => e.classList.contains('needs'))) fail('the marker outlived the fix');
  else console.log('ok: the marker clears the moment the field is filled');
  await page.click('#edClose');                       // discard - not one of the 13
  await page.waitForFunction('!document.getElementById("askOv").classList.contains("hide")', { timeout: 3000 });
  const dsc = await page.$$('#askBtns button');
  await dsc[dsc.length - 1].click();
  await page.waitForFunction('document.getElementById("editorOv").classList.contains("hide")', { timeout: 5000 });

  // session is required on save, so every seeded trade carries one
  const T = [];
  for (let i=0;i<5;i++) T.push({ sym:'ES', day:13+i, sess:'New York', setup:'ORB', pnl:200, cond:'Trend day', qual:'A+ setup', emoB:2 });
  for (let i=0;i<4;i++) T.push({ sym:'NQ', dir:'short', day:13+i, sess:'New York', setup:'VWAP fade', pnl:-150, cond:'Range / chop', mist:'Chased', emoB:4 });
  T.push({ sym:'EURUSD', day:18, sess:'London', setup:'Breakout', pnl:100, cond:'News day' });
  T.push({ sym:'EURUSD', day:18, sess:'London', setup:'Breakout', pnl:50, cond:'News day' });
  T.push({ sym:'EURUSD', day:19, sess:'London', setup:'Breakout', pnl:-80, cond:'News day' });

  for (const t of T) {
    await page.click('#jNew');
    await page.evaluate(d => { const e=document.getElementById('edDate'); e.value=d; e.dispatchEvent(new Event('input',{bubbles:true})); }, `2026-07-${String(t.day).padStart(2,'0')}T09:45`);
    await page.select('#edSymSel', t.sym);                      // dropdown, not typing
    await page.select('#edSess', t.sess);
    if (t.dir) await page.select('#edDir', t.dir);
    await type('edSetup', t.setup);
    await type('edRisk', '100'); await type('edPnl', String(t.pnl));
    if (t.cond) await chip('edConditions', t.cond);
    if (t.qual) await chip('edQuality', t.qual);
    if (t.mist) await chip('edMistakes', t.mist);
    if (t.emoB) await emo('edEmoB', t.emoB);
    await page.click('#edSave');
    await page.waitForFunction('document.getElementById("editorOv").classList.contains("hide")', { timeout: 5000 });
  }
  console.log('ok: 12 tagged trades saved via dropdown UI');

  // custom instrument path
  await page.click('#jNew');
  await page.select('#edSymSel', '__custom');
  await page.waitForFunction('!document.getElementById("edSymCustomWrap").classList.contains("hide")', { timeout: 3000 });
  await type('edSym', 'MYSYM');
  await page.select('#edSess', 'Asia');
  await type('edRisk','100'); await type('edPnl','10');
  await page.click('#edSave');
  await page.waitForFunction('document.getElementById("editorOv").classList.contains("hide")', { timeout: 5000 });
  const symsNow = await page.$$eval('.tradecard .sym', els => els.map(e => e.textContent));
  const hasCustom = symsNow.includes('MYSYM');
  if (!hasCustom) fail('custom instrument not in log; cards show: ' + JSON.stringify(symsNow)); else console.log('ok: custom instrument saved');

  // rail tiles now include odds (13 resolved >= 10)
  const rail = await page.$eval('#jSummary', e => e.textContent);
  if (!rail.includes('Pass odds') || !rail.includes('Stay funded')) fail('rail odds tiles missing: ' + rail.slice(0,200));
  else console.log('ok: rail Pass odds / Stay funded tiles');

  // stats view: prop odds + edge report
  await page.click('[data-jview="stats"]');
  await page.waitForSelector('#propOdds', { timeout: 5000 });
  const odds = await page.$eval('#propOdds', e => e.textContent);
  if (!odds.includes('Pass the eval') || !odds.includes('resolved trades')) fail('prop odds panel wrong: ' + odds.slice(0,200));
  else console.log('ok: prop odds panel rendered -', odds.match(/Pass the eval(\d+%)/)?.[1] ?? odds.slice(0,40));
  if (!odds.includes('90% range')) fail('odds missing bootstrap range'); else console.log('ok: bootstrap ranges shown');
  if (!odds.includes('very thin') && !odds.includes('thin')) fail('odds missing sample grade'); else console.log('ok: sample-quality grade shown');

  // the payout goal set on the Simulator's Funded tab, answered against the
  // journal's OWN trades. Absent until a goal exists, so it cannot clutter the
  // panel for anyone who has not asked the question.
  if (odds.includes('Your payout goal')) fail('goal tile showed with no goal set');
  else console.log('ok: no goal tile until a goal is set');
  await page.evaluate(() => {
    localStorage.setItem('pel_pay_goal', '18000');
    localStorage.setItem('pel_pay_goal_period', '"mo"');
  });
  await page.click('[data-jview="log"]');
  await page.click('[data-jview="stats"]');
  await page.waitForSelector('#propOdds', { timeout: 5000 });
  await new Promise(r => setTimeout(r, 600));
  const goalTxt = await page.$eval('#propOdds', e => e.textContent);
  if (!goalTxt.includes('Your payout goal')) fail('goal tile missing after setting a goal: ' + goalTxt.slice(-200));
  else if (!/payouts? .{0,4}your record averages/i.test(goalTxt.replace(/\s+/g, ' '))) fail('goal tile does not compare need against the record: ' + goalTxt.slice(-220));
  else if (!/lumps/.test(goalTxt)) fail('goal tile must say payouts arrive in lumps, not monthly');
  else console.log('ok: journal goal tile reads "' + (goalTxt.replace(/\s+/g, ' ').match(/Your payout goal.{0,110}/) || [''])[0] + '"');
  await page.evaluate(() => { localStorage.removeItem('pel_pay_goal'); localStorage.removeItem('pel_pay_goal_period'); });
  const statsTxt = await page.$eval('#jv-stats', e => e.textContent);
  if (!statsTxt.includes('SQN')) fail('metrics grid missing SQN');
  if (!statsTxt.includes('95% CI')) fail('metrics grid missing CI sub-lines');
  if (!statsTxt.includes('Kelly')) fail('metrics grid missing Kelly');
  if (!statsTxt.includes('Best-day share')) fail('metrics grid missing best-day share');
  if (!(await page.$('#cRdist'))) fail('R-distribution canvas missing');
  if (!(await page.$('#cRolling'))) fail('rolling expectancy canvas missing');
  if (process.exitCode !== 1) console.log('ok: quant metrics grid + R histogram + rolling expectancy');
  // weekday and entry hour moved to the Timing tab; the edge report stays here
  await page.click('[data-stat="time"]');
  await new Promise(r => setTimeout(r, 700));
  const timeTxt = await page.$eval('#jv-stats', e => e.textContent);
  if (!timeTxt.includes('By weekday')) fail('weekday breakdown missing from Timing');
  if (!timeTxt.includes('By entry hour')) fail('entry-hour breakdown missing from Timing');
  if (!timeTxt.includes('By holding time')) fail('holding-time breakdown missing from Timing');
  if (!timeTxt.includes('Which trade of the day')) fail('trade-of-the-day breakdown missing');
  if (!timeTxt.includes('Does any of it hold up')) fail('Timing is missing its separability verdict block');
  // the tab must never assert a timing edge without saying what it cleared: on a
  // 13-trade fixture the only honest reading is that it cannot test anything yet
  if (!/Too few trades to test timing|stands out|Nothing stands out yet/i.test(timeTxt)) {
    fail('Timing printed no verdict at all - it must always say where it stands');
  }
  if (process.exitCode !== 1) console.log('ok: Timing carries all five axes and a verdict');

  await page.click('[data-stat="edge"]');
  await page.waitForSelector('#edgeReport', { timeout: 5000 });
  const edgeTxt = await page.$eval('#jv-stats', e => e.textContent);
  if (edgeTxt.includes('By entry hour')) fail('entry-hour table is still on the Edge report - it must not exist twice');
  if (process.exitCode !== 1) console.log('ok: edge report points at Timing and does not duplicate it');
  const er = await page.$eval('#edgeReport', e => e.textContent);
  if (!er.includes('Trend day')) fail('edge report missing Trend day strength');
  if (!er.includes('Chased')) fail('edge report missing Chased leak');
  if (!er.includes('Discipline check')) fail('edge report missing discipline check');
  if (!/Range \/ chop/.test(er)) fail('edge report missing regime leak');
  if (process.exitCode !== 1) console.log('ok: edge report has strengths, leaks, discipline check');

  // reload persistence incl. custom + odds
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 15000 });
  await page.waitForSelector('#mode-journal:not(.hide)', { timeout: 5000 });
  const cards = await page.$$eval('.tradecard', els => els.length);
  if (cards !== 13) fail('after reload expected 13 cards, got ' + cards); else console.log('ok: 13 trades persisted');
  await page.click('[data-jview="stats"]');
  // the stats sub-tab persists; hop back to Performance where the odds panel lives
  await page.waitForSelector('[data-stat="perf"]', { timeout: 5000 });
  await page.click('[data-stat="perf"]');
  await page.waitForSelector('#propOdds', { timeout: 5000 });
  const odds2 = await page.$eval('#propOdds', e => e.textContent);
  if (!odds2.includes('Pass the eval')) fail('odds gone after reload'); else console.log('ok: odds persist after reload');

  await page.screenshot({ path: 'pel-test/e2e2-stats.png', fullPage: false });
  await browser.close();
  console.log(process.exitCode ? 'E2E2: FAILURES ABOVE' : 'E2E2: ALL PASS');
})().catch(e => { console.error('E2E2 crashed:', e.message); process.exit(1); });
