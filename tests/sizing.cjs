// The sizes the app names hold up when the edge is only an estimate (2.18.7).
// On the sample record and the 2-step preset the old Funded "Best size" was
// 0.82%: 89% survival as measured, one grid step below a cliff, and under 85%
// survival in 43% of plausible versions of the record. The balanced size must
// sit below that, say how often it holds, and Validate must quote it rather than
// grade the Funded risk against its own, different model.
const puppeteer = require('puppeteer-core');
const path = require('path');
const { pathToFileURL } = require('url');

const APP = pathToFileURL(path.resolve(__dirname, '../dist/EdgeLab.html')).href;
const SAMPLE = path.resolve(__dirname, '../samples/sample-1000-trades.json');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => { console.log('FAIL: ' + m); process.exitCode = 1; };
const ok = (m) => console.log('ok: ' + m);

(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new', userDataDir: path.resolve('./pel-test/sizing-' + process.pid), protocolTimeout: 180000,
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--edge-skip-compat-layer-relaunch'],
  });
  const page = await b.newPage();
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('pel_free_notice_off', 'true'); if (localStorage.getItem('pel_prop') == null) localStorage.setItem('pel_prop', 'true'); } catch (e) { /* opaque origin */ } });
  await page.setViewport({ width: 1360, height: 900 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(APP, { waitUntil: 'load' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 25000 });
  await page.evaluate(() => document.querySelector('[data-mode="journal"]').click());
  await (await page.$('#jImportFile')).uploadFile(SAMPLE);
  await wait(4000);
  await page.evaluate(() => {
    document.querySelector('[data-mode="sim"]').click();
    const u = document.getElementById('useJournal'); if (!u.checked) { u.checked = true; u.dispatchEvent(new Event('change', { bubbles: true })); }
    document.querySelector('[data-tab="funded"]').click();
  });
  // the robust check runs in the background: wait for the tile to resolve
  try { await page.waitForFunction(() => /holds \d|fragile|none survivable|n\/a/.test(document.getElementById('fPeak').textContent), { timeout: 150000, polling: 500 }); }
  catch { fail('the balanced size never resolved'); }
  const f = await page.evaluate(() => ({ label: document.getElementById('fPeak').previousElementSibling.textContent, text: document.getElementById('fPeak').innerText, title: document.getElementById('fPeak').title }));
  const size = parseFloat(f.text);
  if (f.label !== 'Balanced size') fail('the tile should be labelled Balanced size, is "' + f.label + '"');
  if (!(size > 0.2 && size < 0.82)) fail('balanced size should sit below the old 0.82% pick, got ' + f.text.replace(/\n/g, ' | '));
  else ok('Funded: ' + f.text.replace(/\n/g, ' | '));
  if (!/plausible/.test(f.title) || !/% of the most net profit/.test(f.title)) fail('the tooltip must state the robustness and the profit cost: ' + f.title);
  else ok('tooltip: ' + f.title);

  // Challenge eval pick on the Decision tab, after its robust check
  await page.evaluate(() => document.querySelector('[data-tab="decision"]').click());
  try { await page.waitForFunction(() => !/checking/.test(document.getElementById('dEvalSize').textContent) && /%/.test(document.getElementById('dEvalSize').textContent), { timeout: 150000, polling: 500 }); }
  catch { fail('the eval size never finished its robust check'); }
  const e = await page.evaluate(() => ({ text: document.getElementById('dEvalSize').innerText, title: document.getElementById('dEvalSize').title }));
  if (!/plausible versions of your edge/.test(e.title)) fail('eval tooltip must state the robust bar: ' + e.title.slice(0, 200));
  else ok('Decision eval size: ' + e.text.replace(/\n/g, ' | '));

  // Validate quotes the Funded tab instead of colouring its risk
  await page.evaluate(() => document.querySelector('[data-tab="validate"]').click());
  await wait(4000);
  const v = await page.evaluate(() => { const r = document.querySelector('#ddRisk .rv'); return { cls: r ? r.className : '', text: document.getElementById('ddRisk').innerText }; });
  if (/cell-(go|stop)/.test(v.cls)) fail('Validate must not grade the Funded risk with its own model: ' + v.cls);
  if (!/balanced size is \d+\.\d+%/.test(v.text) || !/firm.s own rules/.test(v.text)) fail('Validate should quote the Funded balanced size and say why it differs: ' + v.text);
  else ok('Validate: ' + v.text.replace(/\n/g, ' | ').slice(0, 260));

  if (errs.length) fail('page errors: ' + errs.join(' | '));
  await b.close();
  console.log(process.exitCode ? 'SIZING: FAILURES' : 'SIZING: ALL PASS');
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
