// Capture every screen of Edge Lab for the beginner guide.
//
// Seeds ONE realistic journal so every panel has something honest to show: a
// positive but not absurd edge, enough trades to clear the app's own n>=30
// sizing bar, real dates so the day-clustering and calendar surfaces populate,
// tags and sessions so the Edge report has rows, and MFE/MAE so Exit management
// unlocks (it needs 30 since 2.11.0).
//
// Light theme throughout: the guide is meant to be printable, and the dark
// palettes turn into ink-heavy pages. The theme picker gets its own shot.
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const REPO = path.resolve(__dirname, '..');
const APP = 'file:///' + path.resolve(REPO + '/dist/PropEdgeLab2.html').replace(/\\/g, '/');
const OUT = path.resolve(REPO + '/guide/shots');
fs.mkdirSync(OUT, { recursive: true });

const FIRM = {
  name: 'Tradeify Growth', type: 'futures', account: 50000, p1: 6, p2: 0, maxdd: 4,
  ddType: 'trailing-eod', ddLock: 1, daily: 0, minDays: 0, cons: 0, tpd: 3, split: 90,
  fee: 299, feeMode: 'once', timeLimit: 0, activation: 0, instant: false,
  payoutMin: 0, payoutEvery: 0, payoutFirst: 0, resetFee: 0,
  payoutBuffer: 3000, payoutCap: 50, payoutCapAmt: 0, payoutCons: 0,
  winDays: 5, winAmt: 150, kind: 'futures',
};

const SETUPS = ['Opening range break', 'VWAP reclaim', 'Trend pullback'];
const MODELS = ['Liq sweep + CHOCH', 'Failed breakout', 'Session open drive'];
const SESS = ['Asia', 'London', 'New York'];
const COND = ['Trend day', 'Range / chop', 'High volatility'];

function seedTrades() {
  let s = 40404;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const out = [];
  // 96 trades over ~32 trading days at 3/day - matches the firm's tpd so the
  // guide's numbers are internally consistent
  for (let i = 0; i < 96; i++) {
    const long = rnd() > 0.42;
    const win = rnd() < (long ? 0.60 : 0.50);
    const r = win ? +(0.8 + rnd() * 2.6).toFixed(2) : -(0.75 + rnd() * 0.35).toFixed(2);
    const scratch = rnd() < 0.08;
    const rr = scratch ? 0 : r;
    const day = 1 + Math.floor(i / 3);
    const mo = 6 + Math.floor((day - 1) / 22);
    const dom = ((day - 1) % 22) + 1;
    const d = '2026-' + String(mo).padStart(2, '0') + '-' + String(dom).padStart(2, '0');
    out.push({
      id: 'g' + i, createdAt: 1750000000000 + i * 90000,
      dateTime: d + 'T' + String(8 + (i % 6)).padStart(2, '0') + ':' + String(5 + (i % 50)).padStart(2, '0'),
      exitTime: d + 'T' + String(9 + (i % 6)).padStart(2, '0') + ':' + String(10 + (i % 45)).padStart(2, '0'),
      instrument: ['MNQ', 'MES', 'MNQ'][i % 3], account: 'Funded MNQ',
      direction: long ? 'long' : 'short', session: SESS[i % 3],
      setup: SETUPS[i % 3], entryModel: MODELS[i % 3],
      entry: null, stop: null, target: null, exit: null, size: 2,
      riskAmt: 250, pnl: Math.round(rr * 250), fees: null,
      R: rr, Rmanual: true, pnlManual: false,
      tags: {
        quality: rr > 0 ? 'A+ setup' : (i % 5 === 0 ? 'Forced' : 'B setup'),
        mistake: i % 7 === 0 ? ['Exited early'] : [],
        condition: [COND[i % 3]],
      },
      emotionBefore: rr > 0 ? 2 : 3, emotionAfter: rr > 0 ? 2 : 4,
      followedPlan: i % 9 !== 0,
      planText: 'Waiting for the session open to set a range, then taking the break with the trend.',
      notes: rr > 0 ? 'Clean break, held to target.' : 'Break failed and came back through the range.',
      imageIds: [],
      mfeR: +(Math.max(rr, 0) + 0.4 + rnd() * 1.5).toFixed(2),
      maeR: +(rnd() * 0.8).toFixed(2),
      mfe: null, mae: null, mfeD: null, maeD: null,
    });
  }
  return out;
}

// sel: an element to shoot; a number instead crops a full-page shot to that
// many CSS pixels from the top, for screens too tall to stay legible on A4
const shot = async (page, name, sel) => {
  const file = path.join(OUT, name + '.png');
  if (typeof sel === 'number') {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: file, clip: { x: 0, y: 0, width: 1340, height: sel }, captureBeyondViewport: true });
  } else if (sel) {
    const el = await page.$(sel);
    if (!el) { console.log('  !! missing ' + sel + ' for ' + name); return; }
    await el.screenshot({ path: file });
  } else {
    await page.screenshot({ path: file, fullPage: true });
  }
  const kb = Math.round(fs.statSync(file).size / 1024);
  console.log('  ok ' + name + '.png (' + kb + 'KB)');
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new', userDataDir: path.resolve('./pel-test/guide-' + process.pid),
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--edge-skip-compat-layer-relaunch'],
  });
  const page = await browser.newPage();
  // deviceScaleFactor 2 so the screenshots stay sharp when placed at half size
  // on a printed page
  await page.setViewport({ width: 1340, height: 980, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => console.log('PAGEERROR: ' + e.message));

  await page.goto(APP, { waitUntil: 'load' });
  const unstick = () => page.addStyleTag({ content: '.topbar{position:static!important}.rail{position:static!important;max-height:none!important;overflow:visible!important}' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 25000 });

  console.log('seeding...');
  await page.evaluate(async (trades, firm) => {
    localStorage.setItem('pel_jmeta', JSON.stringify({
      startBalance: null, accounts: ['Funded MNQ'], balances: { 'Funded MNQ': 50000 },
      rBasis: { 'Funded MNQ': { mode: 'fixed', v: 250 } },
      accountFirms: { 'Funded MNQ': firm },
      accountPhase: { 'Funded MNQ': { phase: 'eval' } },
    }));
    localStorage.setItem('pel_acct', JSON.stringify('Funded MNQ'));
    localStorage.setItem('pel_edge_acct', JSON.stringify(''));
    localStorage.setItem('pel_theme', JSON.stringify('light'));
    localStorage.setItem('pel_mode', JSON.stringify('sim'));
    localStorage.setItem('pel_stats_tab', JSON.stringify('perf'));
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
  }, seedTrades(), FIRM);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 25000 });
  await unstick();
  await page.evaluate(() => {
    const ov = document.getElementById('askOv');
    if (ov && !ov.classList.contains('hide')) {
      const b = [...document.querySelectorAll('#askBtns button')].find((x) => /later/i.test(x.textContent));
      if (b) b.click();
    }
  });

  // ---------- the app before anything is turned on ----------
  console.log('simulator, slider edge...');
  await page.evaluate(() => {
    document.querySelector('[data-mode="sim"]').click();
    document.querySelector('[data-tab="validate"]').click();
  });
  await wait(4000);
  await shot(page, '01-first-look');
  await shot(page, '02-edge-bar', '.rail .bar');
  await shot(page, '03-journal-switch', '.jedge');

  // the firm editor, open
  await page.evaluate(() => {
    if (!document.getElementById('firmEdit').classList.contains('open')) document.getElementById('firmToggle').click();
    const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); };
    set('fType', 'futures'); set('fAccount', '50000'); set('fP1', '6'); set('fMaxdd', '4');
    set('fDdType', 'trailing-eod'); set('fDdLock', '1'); set('fDaily', '0'); set('fTpd', '3');
    set('fFee', '299'); set('fPayBuffer', '3000'); set('fPayCap', '50');
    set('fWinDays', '5'); set('fWinAmt', '150');
  });
  await wait(2500);
  await shot(page, '04-firm-editor', '#firmEdit');
  await shot(page, '05-firm-summary', '#firmSum');
  await page.evaluate(() => document.getElementById('firmToggle').click());

  // theme picker
  await page.evaluate(() => document.getElementById('themeBtn').click());
  await wait(600);
  await shot(page, '06-themes', '#themeWrap');
  await page.evaluate(() => document.getElementById('themeBtn').click());

  // ---------- turn the journal edge on, then every Simulator tab ----------
  console.log('turning on the journal edge...');
  await page.evaluate(() => {
    const uj = document.getElementById('useJournal');
    if (!uj.checked) { uj.checked = true; uj.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await wait(3000);

  const tabs = [
    ['validate', '07-validate', 30000],
    ['challenge', '08-challenge', 30000],
    ['funded', '09-funded', 30000],
    ['decision', '10-decision', 30000],
  ];
  for (const [tab, name, budget] of tabs) {
    console.log('tab ' + tab + '...');
    await page.evaluate((t) => document.querySelector('[data-tab="' + t + '"]').click(), tab);
    void budget;
    await wait(14000);   // let the bands and curves land
    await shot(page, name);
  }
  // a couple of close-ups the guide leans on
  await page.evaluate(() => document.querySelector('[data-tab="validate"]').click());
  await wait(9000);
  await shot(page, '13-dd-ladder', '#ddLadder');
  await shot(page, '14-risk-answer', '#ddRisk');

  // ---------- the Journal ----------
  console.log('journal...');
  await page.evaluate(() => document.querySelector('[data-mode="journal"]').click());
  await wait(3500);
  await shot(page, '20-journal-log', 980);
  await shot(page, '21-account-scope', '.bar:has(#jAcct)');
  await shot(page, '22-rule-guard', '#ruleGuard');
  await shot(page, '24-filters', '.bar:has(#fltText)');
  await shot(page, '31-equity', '.bar:has(#jEqLine)');

  // the trade editor
  await page.evaluate(() => document.getElementById('jNew').click());
  await wait(1600);
  await shot(page, '25-new-trade', '#editorOv .sheet');
  await page.evaluate(() => document.getElementById('edCancel').click());
  await wait(900);
  await page.evaluate(() => {
    const ov = document.getElementById('askOv');
    if (ov && !ov.classList.contains('hide')) {
      const b = [...document.querySelectorAll('#askBtns button')].find((x) => /discard|yes|leave/i.test(x.textContent));
      if (b) b.click();
    }
  });
  await wait(800);

  // stats sub-tabs
  for (const [st, name, w, crop] of [['perf', '26-stats-performance', 9000, 1500], ['edge', '28-edge-report', 9000, 1500], ['time', '27-timing', 6000, 1250], ['cal', '29-calendar', 5000, 1000]]) {
    console.log('stats ' + st + '...');
    await page.evaluate((t) => {
      document.querySelector('.subnav button[data-jview="stats"]').click();
      const b = document.querySelector('[data-stat="' + t + '"]');
      if (b) b.click();
    }, st);
    await wait(w);
    await shot(page, name, crop);
  }
  // header close-up, for the manual's orientation page
  await shot(page, '32-header', '.topbar');
  // prop odds close-up
  await page.evaluate(() => {
    document.querySelector('[data-stat="perf"]').click();
  });
  await wait(8000);
  await shot(page, '30-prop-odds', '#propOdds');

  await browser.close();
  console.log('\ndone -> ' + OUT);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
