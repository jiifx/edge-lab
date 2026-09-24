// Render manual.html (the user manual) to a print-ready PDF.
//
// Chromium's own print engine rather than reportlab: the guide is
// screenshot-heavy and the layout is CSS, so letting the same engine that
// renders the app render the guide keeps typography and image scaling right,
// and keeps the source editable as HTML.
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const REPO = path.resolve(__dirname, '..');
const SRC = 'file:///' + path.resolve(REPO + '/guide/manual.html').replace(/\\/g, '/');
const OUT = process.argv[2] || path.resolve(REPO + '/guide/Edge Lab - User Manual.pdf');
const VERSION = require(REPO + '/package.json').version;

(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new', userDataDir: path.resolve('./pel-test/guidepdf-' + process.pid),
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--edge-skip-compat-layer-relaunch'],
  });
  const p = await b.newPage();
  p.on('pageerror', (e) => console.log('PAGEERROR: ' + e.message));
  await p.goto(SRC, { waitUntil: 'networkidle0' });
  // every screenshot must be decoded before the print, or images land blank
  await p.evaluate(async () => {
    await Promise.all([...document.images].map((i) => (i.complete ? Promise.resolve() : new Promise((r) => { i.onload = i.onerror = r; }))));
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
  });
  const missing = await p.evaluate(() =>
    [...document.images].filter((i) => !i.naturalWidth).map((i) => i.getAttribute('src')));
  if (missing.length) console.log('!! images that did not load:\n   ' + missing.join('\n   '));

  await p.pdf({
    path: OUT,
    format: 'A4',
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: '<div style="font-size:7pt;color:#8A9187;width:100%;padding:0 15mm;font-family:Segoe UI,sans-serif;">' +
      '<span style="float:left">Edge Lab — User Manual</span>' +
      '<span style="float:right">v' + VERSION + '</span></div>',
    footerTemplate: '<div style="font-size:7pt;color:#8A9187;width:100%;padding:0 15mm;font-family:Segoe UI,sans-serif;text-align:center">' +
      '<span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    margin: { top: '17mm', bottom: '20mm', left: '15mm', right: '15mm' },
  });
  await b.close();
  const mb = (fs.statSync(OUT).size / 1048576).toFixed(2);
  console.log('wrote ' + OUT + ' (' + mb + ' MB)');
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
