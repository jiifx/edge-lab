// Retina (DPR=2) regression: canvas heights must stay at design size across many re-renders.
// Also: number-input <-> slider sync, reload button presence + function.
const puppeteer = require('puppeteer-core');
const path = require('path');
const APP = 'file:///' + path.resolve(__dirname, '../dist/PropEdgeLab2.html').replace(/\\/g, '/');
function fail(m){ console.error('FAIL: ' + m); process.exitCode = 1; }
(async () => {
  const browser = await puppeteer.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: 'new', userDataDir: path.resolve('./pel-test/profile-retina-' + Date.now()), args: ['--no-sandbox','--disable-gpu','--allow-file-access-from-files', '--edge-skip-compat-layer-relaunch'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 }); // Mac Retina
  page.on('pageerror', e => fail('pageerror: ' + e.message));
  await page.goto(APP, { waitUntil: 'load' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 15000 });
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  console.log('ok: loaded at DPR=' + dpr);

  // hammer re-renders: 12 slider moves + tab bounces (each re-fits every visible canvas)
  for (let i = 0; i < 12; i++) {
    await page.evaluate((v) => {
      const s = document.getElementById('swr');
      s.value = String(45 + (v % 10));
      s.dispatchEvent(new Event('input', { bubbles: true }));
    }, i);
  }
  await page.click('[data-tab="challenge"]');
  await page.click('[data-tab="validate"]');
  await page.click('[data-tab="challenge"]');
  await new Promise(r => setTimeout(r, 400));

  // journal charts were never covered here - the DPR doubling bug that broke the
  // Mac beta lives in fit(), which the equity / R-dist / rolling canvases also use
  await page.evaluate(async () => {
    await new Promise((res) => {
      const rq = indexedDB.open('propEdgeLab', 1);
      rq.onsuccess = (e) => {
        const db = e.target.result;
        const tx = db.transaction('trades', 'readwrite');
        const st = tx.objectStore('trades');
        const pad = (v) => String(v).padStart(2, '0');
        for (let i = 0; i < 40; i++) {
          const d = new Date(2025, 2, 1 + Math.floor(i / 2), 10 + (i % 4), (i * 13) % 60);
          const R = i % 3 ? 1.5 : -1;
          st.put({
            id: 'ret' + i, account: 'Main',
            dateTime: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()),
            instrument: 'MNQ', direction: i % 2 ? 'long' : 'short', session: 'New York', setup: 'Breakout',
            entry: 100, stop: 99, target: 102, exit: 100 + R, size: 1, riskAmt: 100,
            pnl: Math.round(R * 100), fees: 0, R: null, Rmanual: false, followedPlan: true,
            planText: '', notes: '', tags: { quality: 'B setup', mistake: [], condition: [] },
            emotionBefore: 2, emotionAfter: 2, imageIds: [],
          });
        }
        tx.oncomplete = () => { db.close(); res(); };
      };
    });
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 15000 });
  await page.evaluate(() => {
    if (!document.getElementById('askOv').classList.contains('hide')) {
      const b = [...document.querySelectorAll('#askBtns button')].find(x => /later/i.test(x.textContent));
      if (b) b.click();
    }
    document.querySelector('.modenav button[data-mode="journal"]').click();
  });
  await new Promise(r => setTimeout(r, 400));
  await page.evaluate(() => document.querySelector('.subnav button[data-jview="stats"]').click());
  await new Promise(r => setTimeout(r, 700));
  // bounce the stats sub-tabs so every journal canvas re-fits several times
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => { const b = document.querySelector('#jv-stats button[data-stat="edge"]'); if (b) b.click(); });
    await new Promise(r => setTimeout(r, 200));
    await page.evaluate(() => { const b = document.querySelector('#jv-stats button[data-stat="perf"]'); if (b) b.click(); });
    await new Promise(r => setTimeout(r, 250));
  }
  const jSizes = await page.evaluate(() =>
    [...document.querySelectorAll('#jv-stats canvas')].filter(c => c.offsetParent !== null).map(c => ({
      id: c.id, cssH: Math.round(c.getBoundingClientRect().height), attrH: Number(c.dataset.h || c.getAttribute('height')),
    })));
  console.log('journal canvas sizes after 4 sub-tab bounces:', JSON.stringify(jSizes));
  if (!jSizes.length) fail('no journal canvases found to check');
  jSizes.forEach((s) => {
    if (Math.abs(s.cssH - s.attrH) > 2) fail('journal canvas ' + s.id + ' drifted: css ' + s.cssH + 'px vs design ' + s.attrH + 'px');
  });
  if (process.exitCode !== 1) console.log('ok: journal canvases stable at DPR=2');
  await page.evaluate(() => document.querySelector('.modenav button[data-mode="sim"]').click());
  await new Promise(r => setTimeout(r, 400));

  const sizes = await page.evaluate(() =>
    [...document.querySelectorAll('canvas')].filter(c => c.offsetParent !== null).map(c => ({
      id: c.id, designH: c.dataset.h, cssH: c.getBoundingClientRect().height, backingH: c.height,
    })));
  console.log('canvas sizes after 15 re-renders:', JSON.stringify(sizes));
  for (const s of sizes) {
    const dh = Number(s.designH);
    if (Math.abs(s.cssH - dh) > 2) fail(`${s.id}: css height ${s.cssH} drifted from design ${dh}`);
    if (s.backingH !== dh * 2) fail(`${s.id}: backing ${s.backingH} != designH*2`);
  }
  if (process.exitCode !== 1) console.log('ok: RETINA STABLE - no canvas growth at DPR=2');

  // number input -> slider sync
  await page.evaluate(() => {
    const n = document.getElementById('nrc');
    n.value = '1.5';
    n.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await new Promise(r => setTimeout(r, 300));
  const src = await page.$eval('#src', e => e.value);
  const sub = await page.$eval('#lrcSub', e => e.textContent);
  if (src !== '1.5') fail('slider did not follow number input: ' + src);
  else console.log('ok: number input drives slider (risk -> 1.5%, sub: ' + sub.trim() + ')');
  // slider -> number input sync
  await page.evaluate(() => {
    const s = document.getElementById('src');
    s.value = '0.6';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await new Promise(r => setTimeout(r, 400)); // renders are rAF-coalesced now
  const nrc = await page.$eval('#nrc', e => e.value);
  if (nrc !== '0.6') fail('number input did not follow slider: ' + nrc);
  else console.log('ok: slider drives number input');

  // reload button: exists, and clicking it reloads (PEL_READY resets then returns)
  if (!(await page.$('#reloadBtn'))) fail('reload button missing');
  await page.evaluate(() => { window.__RELOAD_CANARY = true; });
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#reloadBtn')]);
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 15000 });
  const canary = await page.evaluate(() => window.__RELOAD_CANARY);
  if (canary) fail('reload did not actually reload'); else console.log('ok: reload button reloads the app');

  await browser.close();
  console.log(process.exitCode ? 'RETINA TEST: FAIL' : 'RETINA TEST: ALL PASS');
})().catch(e => { console.error('crashed:', e.message); process.exit(1); });
