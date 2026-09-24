// Re-capture the three panels whose selectors missed, plus the theme menu,
// which is absolutely positioned and so needs a clipped region rather than an
// element box.
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const REPO = path.resolve(__dirname, '..');
const APP = 'file:///' + path.resolve(REPO + '/dist/PropEdgeLab2.html').replace(/\\/g, '/');
const OUT = path.resolve(REPO + '/guide/shots');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new', userDataDir: path.resolve('./pel-test/guidefix-' + process.pid),
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--edge-skip-compat-layer-relaunch'],
  });
  const p = await b.newPage();
  await p.setViewport({ width: 1340, height: 980, deviceScaleFactor: 2 });
  p.on('pageerror', (e) => console.log('PAGEERROR: ' + e.message));
  await p.goto(APP, { waitUntil: 'load' });
  await p.waitForFunction('window.__PEL_READY === true', { timeout: 25000 });
  // the main capture runs in the light theme for print; these must match or the
  // guide mixes palettes page to page
  await p.evaluate(() => localStorage.setItem('pel_theme', JSON.stringify('light')));
  await p.reload({ waitUntil: 'load' });
  await p.waitForFunction('window.__PEL_READY === true', { timeout: 25000 });
  await p.evaluate(() => {
    const ov = document.getElementById('askOv');
    if (ov && !ov.classList.contains('hide')) {
      const x = [...document.querySelectorAll('#askBtns button')].find((e) => /later/i.test(e.textContent));
      if (x) x.click();
    }
  });
  const save = async (name, sel) => {
    const el = await p.$(sel);
    if (!el) { console.log('  !! still missing ' + sel); return; }
    await el.screenshot({ path: path.join(OUT, name + '.png') });
    console.log('  ok ' + name + '.png (' + Math.round(fs.statSync(path.join(OUT, name + '.png')).size / 1024) + 'KB)');
  };

  // journal sidebar panels, addressed by what they CONTAIN
  await p.evaluate(() => document.querySelector('[data-mode="journal"]').click());
  await wait(3500);

  // the theme menu: absolutely positioned, so clip the top-right corner
  await p.evaluate(() => {
    document.querySelector('[data-mode="sim"]').click();
    document.getElementById('themeBtn').click();
  });
  await wait(700);
  const box = await p.evaluate(() => {
    const m = document.getElementById('themeMenu').getBoundingClientRect();
    const t = document.querySelector('.topbar').getBoundingClientRect();
    return { x: Math.max(0, m.left - 30), y: Math.max(0, t.top), width: m.width + 60, height: (m.bottom - t.top) + 16 };
  });
  await p.screenshot({ path: path.join(OUT, '06-themes.png'), clip: box });
  console.log('  ok 06-themes.png (' + Math.round(fs.statSync(path.join(OUT, '06-themes.png')).size / 1024) + 'KB)');

  await b.close();
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
