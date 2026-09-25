// Import-path hardening (from the pre-public security audit). A journal backup is
// an untrusted file: this asserts that a hostile one cannot run script, poison
// Object.prototype, escape the images directory, or destroy the existing journal.
const puppeteer = require('puppeteer-core');
const path = require('path');
const APP = 'file:///' + path.resolve(__dirname, '../dist/PropEdgeLab2.html').replace(/\\/g, '/');
function fail(m){ console.error('FAIL: ' + m); process.exitCode = 1; }

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new',
    pipe: true, // avoid the Edge remote-debugging-port hand-off to a running instance
    userDataDir: path.resolve('./pel-test/profile-sec-' + process.pid),
    args: ['--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--edge-skip-compat-layer-relaunch'],
  });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => { try { if (localStorage.getItem('pel_prop') == null) localStorage.setItem('pel_prop', 'true'); } catch (e) { /* opaque origin */ } });  // these suites exercise prop-firm mode
  await page.setViewport({ width: 1400, height: 950 });
  page.on('pageerror', e => fail('pageerror: ' + e.message));
  await page.goto(APP, { waitUntil: 'load' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 20000 });
  await page.evaluate(() => {
    if (!document.getElementById('askOv').classList.contains('hide')) {
      const b = [...document.querySelectorAll('#askBtns button')].find(x => /later/i.test(x.textContent));
      if (b) b.click();
    }
    window.__XSS_FIRED = false;
    window.__xssbeacon = () => { window.__XSS_FIRED = true; };
  });
  await page.click('.modenav button[data-mode="journal"]');

  const importJson = async (obj, mode) => {
    const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
    await page.evaluate((t) => {
      const file = new File([t], 'backup.json', { type: 'application/json' });
      const dt = new DataTransfer(); dt.items.add(file);
      const inp = document.getElementById('jImportFile');
      inp.files = dt.files; inp.dispatchEvent(new Event('change'));
    }, text);
    await new Promise(r => setTimeout(r, 300));
    const hasDialog = await page.evaluate(() => !document.getElementById('askOv').classList.contains('hide'));
    if (hasDialog) {
      await page.evaluate((m) => {
        const b = [...document.querySelectorAll('#askBtns button')].find(x => new RegExp(m, 'i').test(x.textContent));
        if (b) b.click();
      }, mode);
      await new Promise(r => setTimeout(r, 500));
    }
    await new Promise(r => setTimeout(r, 350));
  };
  const cards = () => page.$$eval('.tradecard', els => els.map(e => e.getAttribute('data-id')));

  // seed a legit journal
  await importJson({ trades: [{ id: 'legit1', dateTime: '2026-05-01T10:00', instrument: 'ES', pnl: 100 }] }, 'replace');
  if ((await cards()).length !== 1) fail('seed import did not produce 1 trade');
  else console.log('ok: seeded 1 legit trade');

  // XSS via a non-string dateTime that sidesteps slice()
  await importJson({ meta: { startBalance: 10000 }, trades: [{ id: 'x9', instrument: 'ES', pnl: 50, dateTime: ['<img src=x onerror="window.__xssbeacon()">'] }] }, 'merge');
  await page.click('[data-jview="stats"]'); await new Promise(r => setTimeout(r, 500));
  await page.evaluate(() => document.querySelector('#jv-stats button[data-stat="edge"]')?.click());
  await new Promise(r => setTimeout(r, 400));
  await page.click('[data-jview="log"]'); await new Promise(r => setTimeout(r, 300));
  if (await page.evaluate(() => window.__XSS_FIRED)) fail('XSS fired from an imported backup');
  else console.log('ok: hostile dateTime did not execute script');

  // prototype pollution via __proto__ in balances
  await importJson({ trades: [{ id: 'x8', dateTime: '2026-05-02T10:00', pnl: 10 }], meta: { accounts: ['Ghost'], balances: { '__proto__': { Ghost: 999999 } } } }, 'merge');
  const poll = await page.evaluate(() => ({ polluted: ({}).Ghost === 999999, protoIntact: Object.getPrototypeOf({}) === Object.prototype }));
  if (poll.polluted || !poll.protoIntact) fail('Object.prototype was polluted by an imported backup');
  else console.log('ok: __proto__ key did not pollute Object.prototype');

  // path-traversal / non-string ids: traversal dropped, numeric coerced, good kept
  await importJson({ trades: [
    { id: '../../../../evil', dateTime: '2026-05-03T10:00', pnl: 1 },
    { id: 5, dateTime: '2026-05-03T11:00', pnl: 2 },
    { id: 'good_id-3', dateTime: '2026-05-03T12:00', pnl: 3 },
  ] }, 'merge');
  const ids = await cards();
  if (ids.includes('../../../../evil')) fail('a path-traversal id was imported');
  else if (!ids.includes('good_id-3')) fail('a legitimate id was rejected');
  else if (!ids.includes('5')) fail('a numeric id was not coerced to a safe string');
  else console.log('ok: traversal id dropped, numeric coerced to "5", legit kept');

  // destructive replace must validate before deleting
  const before = (await cards()).length;
  await importJson({ trades: [{ id: null, pnl: 1 }, { foo: 'bar' }] }, 'replace');
  if ((await cards()).length !== before) fail('a bad replace-import destroyed the existing journal');
  else console.log('ok: replace with an all-invalid file preserved existing trades');
  await importJson('not json {{{', 'replace');
  if ((await cards()).length !== before) fail('a corrupt file destroyed the existing journal');
  else console.log('ok: corrupt file preserved existing trades');

  // oversized guard
  const rejected = await page.evaluate(async () => {
    const big = new File([new Uint8Array(65 * 1024 * 1024)], 'huge.json', { type: 'application/json' });
    const dt = new DataTransfer(); dt.items.add(big);
    const inp = document.getElementById('jImportFile'); inp.files = dt.files; inp.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 400));
    return (document.getElementById('toast').textContent || '');
  });
  if (!/too large/i.test(rejected)) fail('oversized backup was not rejected: "' + rejected + '"');
  else console.log('ok: >64MB backup rejected before parsing');

  // a good replace still works end to end
  await importJson({ trades: [{ id: 'fresh1', dateTime: '2026-06-01T09:00', pnl: 200 }] }, 'replace');
  const final = await cards();
  if (final.length !== 1 || final[0] !== 'fresh1') fail('a legitimate replace-import did not work: ' + JSON.stringify(final));
  else console.log('ok: legitimate replace-import still works');

  if (process.exitCode !== 1) console.log('SECURITY-IMPORT: ALL PASS');
  await browser.close();
})().catch(e => { console.error('SECURITY-IMPORT crashed:', e); process.exitCode = 1; });
