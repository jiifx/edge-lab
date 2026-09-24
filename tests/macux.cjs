// macOS-specific UI paths, exercised from Windows by spoofing the platform before
// any app script runs. Covers the things a Windows dev box can never surface:
// Cmd labels, WKWebView-safe CSS, and the clipboard fallback affordance.
const puppeteer = require('puppeteer-core');
const path = require('path');
const APP = 'file:///' + path.resolve(__dirname, '../dist/PropEdgeLab2.html').replace(/\\/g, '/');
function fail(m){ console.error('FAIL: ' + m); process.exitCode = 1; }

async function open(asMac) {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new',
    userDataDir: path.resolve('./pel-test/profile-macux-' + (asMac ? 'mac' : 'win') + '-' + process.pid),
    args: ['--no-sandbox','--disable-gpu','--allow-file-access-from-files', '--edge-skip-compat-layer-relaunch'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 950 });
  page.on('pageerror', e => fail('pageerror: ' + e.message));
  if (asMac) {
    // must land before the bundle evaluates IS_MAC at import time
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
      Object.defineProperty(navigator, 'userAgent', {
        get: () => 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      });
    });
  }
  await page.goto(APP, { waitUntil: 'load' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 20000 });
  await page.evaluate(() => {
    if (!document.getElementById('askOv').classList.contains('hide')) {
      const b = [...document.querySelectorAll('#askBtns button')].find(x => /later/i.test(x.textContent));
      if (b) b.click();
    }
  });
  return { browser, page };
}

(async () => {
  // ---------- shortcut labels flip on Mac, stay Ctrl on Windows ----------
  const win = await open(false);
  const winLabels = await win.page.evaluate(() => ({
    kbd: [...document.querySelectorAll('[data-kbd]')].map(e => e.textContent),
    save: document.getElementById('edSave').title,
  }));
  await win.browser.close();
  if (winLabels.kbd.join() !== 'Ctrl+N,Ctrl+V' || winLabels.save !== 'Ctrl+Enter')
    fail('Windows labels changed: ' + JSON.stringify(winLabels));
  else console.log('ok: Windows still reads ' + winLabels.kbd.join(' / ') + ' / ' + winLabels.save);

  const mac = await open(true);
  const page = mac.page;
  const macLabels = await page.evaluate(() => ({
    kbd: [...document.querySelectorAll('[data-kbd]')].map(e => e.textContent),
    save: document.getElementById('edSave').title,
  }));
  if (macLabels.kbd.join() !== '⌘N,⌘V') fail('Mac shortcut labels wrong: ' + JSON.stringify(macLabels.kbd));
  else console.log('ok: Mac reads ' + macLabels.kbd.join(' / '));
  if (macLabels.save !== '⌘↩') fail('Mac save tooltip wrong: ' + macLabels.save);
  else console.log('ok: Mac save tooltip reads ' + macLabels.save);

  await page.setViewport({ width: 1400, height: 950 });

  // ---------- WKWebView-safe CSS ----------
  await page.click('.modenav button[data-mode="journal"]');
  await new Promise(r => setTimeout(r, 400));
  const css = await page.evaluate(() => {
    const sel = getComputedStyle(document.getElementById('jAcct'));
    const root = getComputedStyle(document.documentElement);
    const bar = getComputedStyle(document.querySelector('.topbar'));
    const ov = getComputedStyle(document.querySelector('.ov'));
    return {
      appearance: sel.appearance,
      chevron: sel.backgroundImage.indexOf('svg') >= 0,
      colorScheme: root.colorScheme,
      topbarPrefixed: bar.webkitBackdropFilter !== undefined ? String(bar.webkitBackdropFilter || bar.backdropFilter) : String(bar.backdropFilter),
      ovBlur: String(ov.webkitBackdropFilter || ov.backdropFilter),
      // the whole document must not depend on color-mix for anything that carries meaning
      colorMixCount: (document.documentElement.outerHTML.match(/color-mix/g) || []).length,
      topbarHasFallback: /background:var\(--paper\);background:color-mix/.test(document.documentElement.outerHTML),
    };
  });
  if (css.appearance !== 'none') fail('select appearance not reset: ' + css.appearance);
  else console.log('ok: <select> appearance reset (no native aqua popup)');
  if (!css.chevron) fail('select lost its chevron after appearance:none');
  else console.log('ok: custom chevron drawn on <select>');
  if (!/light dark|dark|light/.test(css.colorScheme)) fail('color-scheme not declared: ' + css.colorScheme);
  else console.log('ok: color-scheme declared (' + css.colorScheme + ') so native pickers follow the theme');
  if (css.colorMixCount > 1) fail(css.colorMixCount + ' color-mix uses left - each needs a fallback for Safari < 16.2');
  else if (css.colorMixCount === 1 && !css.topbarHasFallback) fail('the remaining color-mix has no solid fallback');
  else console.log('ok: only the topbar uses color-mix, and it has a solid fallback');

  // ---------- calendar heat map must not depend on color-mix ----------
  await page.evaluate(async () => {
    await new Promise((res) => {
      const rq = indexedDB.open('propEdgeLab', 1);
      rq.onsuccess = (e) => {
        const db = e.target.result;
        const tx = db.transaction('trades', 'readwrite');
        const st = tx.objectStore('trades');
        [['2026-07-02T10:00', 250], ['2026-07-03T10:00', -180]].forEach(([dt, pnl], i) => {
          st.put({ id: 'cal' + i, account: 'Main', dateTime: dt, instrument: 'MNQ', direction: 'long',
            session: 'New York', setup: 'Breakout', entry: 100, stop: 99, target: 102, exit: pnl > 0 ? 101 : 99,
            size: 1, riskAmt: 100, pnl, fees: 0, R: null, Rmanual: false, pnlManual: false, followedPlan: true,
            planText: '', notes: '', tags: { quality: 'B setup', mistake: [], condition: [] },
            emotionBefore: 2, emotionAfter: 2, imageIds: [] });
        });
        tx.oncomplete = () => { db.close(); res(); };
      };
    });
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 20000 });
  await page.evaluate(() => {
    if (!document.getElementById('askOv').classList.contains('hide')) {
      const b = [...document.querySelectorAll('#askBtns button')].find(x => /later/i.test(x.textContent));
      if (b) b.click();
    }
    document.querySelector('.modenav button[data-mode="journal"]').click();
  });
  await new Promise(r => setTimeout(r, 400));
  await page.evaluate(() => document.querySelector('.subnav button[data-jview="stats"]').click());
  await new Promise(r => setTimeout(r, 900));
  await page.evaluate(() => { const b = document.querySelector('#jv-stats button[data-stat="cal"]'); if (b) b.click(); });
  await new Promise(r => setTimeout(r, 700));
  const heat = await page.$$eval('#calGrid .d.has', els => els.map(e => {
    const cs = getComputedStyle(e);
    return { img: cs.backgroundImage, color: cs.backgroundColor };
  }));
  if (!heat.length) fail('calendar rendered no coloured days');
  else if (!heat.every(h => /rgba?\(/.test(h.img) && h.img !== 'none')) fail('calendar heat tint missing: ' + JSON.stringify(heat[0]));
  else console.log('ok: calendar heat map paints ' + heat.length + ' days with rgba tints (no color-mix)');

  // ---------- clipboard affordance ----------
  const paste = await page.evaluate(async () => {
    document.getElementById('jNew').click();
    await new Promise(r => setTimeout(r, 250));
    const btn = document.getElementById('edPasteBtn');
    if (!btn) return { present: false };
    // no image on the clipboard here - it must degrade with a message, not throw
    btn.click();
    await new Promise(r => setTimeout(r, 400));
    const t = document.getElementById('toast');
    return { present: true, visible: btn.offsetParent !== null, toast: (t.textContent || '').slice(0, 60) };
  });
  if (!paste.present) fail('no "Paste from clipboard" button in the editor');
  else if (!paste.visible) fail('paste button exists but is not visible');
  else console.log('ok: paste-from-clipboard button present and degrades cleanly ("' + paste.toast + '")');

  if (process.exitCode !== 1) console.log('MACUX: ALL PASS');
  await mac.browser.close();
})().catch(e => { console.error('MACUX crashed:', e); process.exitCode = 1; });
