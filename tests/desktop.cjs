// The REAL desktop app (Tauri + WebView2), not the browser build: the Rust
// commands only exist here. Runs the release exe against a throwaway data
// folder (EDGE_LAB_DATA_DIR) and a throwaway WebView2 profile, so it never
// touches the user's journal or the settings of an installed copy that may be
// running at the same time. Drives the page over WebView2's debugging port.
//
//   npx tauri build --no-bundle && node tests/desktop.cjs
//
// Opens a PDF viewer, a browser tab and an Explorer window on the way - those
// are the features under test.
const puppeteer = require('puppeteer-core');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const EXE = path.resolve(__dirname, '../src-tauri/target/release/prop-edge-lab.exe');
const SAMPLE = path.resolve(__dirname, '../samples/sample-1000-trades.json');
const PORT = 9333 + (process.pid % 200);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => { console.log('FAIL: ' + m); process.exitCode = 1; };
const ok = (m) => console.log('ok: ' + m);

(async () => {
  if (process.platform !== 'win32') { console.log('DESKTOP: skipped (Windows only)'); return; }
  if (!fs.existsSync(EXE)) { console.log('FAIL: build the exe first (npx tauri build --no-bundle)'); process.exit(1); }
  const work = path.resolve('./pel-test/desktop-' + process.pid);
  const data = path.join(work, 'data'), exp = path.join(data, 'exports');
  fs.mkdirSync(work, { recursive: true });
  const app = spawn(EXE, [], {
    env: {
      ...process.env,
      EDGE_LAB_DATA_DIR: data,
      WEBVIEW2_USER_DATA_FOLDER: path.join(work, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + PORT,
    },
    stdio: 'ignore',
  });
  let exited = null;
  app.on('exit', (code) => { exited = code; });
  let b;
  try {
    // a fresh WebView2 profile on a cold CI machine can take a while
    for (let i = 0; i < 120 && !b && exited == null; i++) {
      await wait(500);
      try { b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:' + PORT, defaultViewport: null }); } catch { /* not up yet */ }
    }
    if (!b) {
      const wv = path.join(work, 'webview');
      throw new Error('could not reach the app on its debugging port ' + PORT +
        (exited != null ? ' - the app EXITED with code ' + exited : ' - the app is still running') +
        '; webview profile ' + (fs.existsSync(wv) ? 'created: ' + fs.readdirSync(wv).join(',') : 'NOT created') +
        '; data dir ' + (fs.existsSync(data) ? 'created' : 'not created'));
    }
    let page;
    for (let i = 0; i < 20 && !page; i++) { page = (await b.pages()).find((p) => !/^devtools:/.test(p.url())); if (!page) await wait(300); }
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.waitForFunction('window.__PEL_READY === true', { timeout: 25000 });
    const count = () => page.evaluate(() => { const t = document.querySelector('#jSummary .tile .v'); return t ? t.textContent.trim() : ''; });
    const clickAsk = (re) => page.evaluate((src) => { const x = [...document.querySelectorAll('#askBtns button')].find((e) => new RegExp(src, 'i').test(e.textContent)); if (x) x.click(); return !!x; }, re.source);
    const dialog = () => page.evaluate(() => { const o = document.getElementById('askOv'); return o && !o.classList.contains('hide') ? document.getElementById('askMsg').textContent : ''; });
    const files = (re) => (fs.existsSync(exp) ? fs.readdirSync(exp).filter((f) => re.test(f)) : []);

    // ---------- 0. it is the desktop build, on the throwaway folder ----------
    const where = await page.evaluate(() => ({ tauri: !!window.__TAURI__, dir: document.getElementById('jDataPath').textContent }));
    if (!where.tauri || path.resolve(where.dir) !== path.resolve(data)) throw new Error('not isolated: ' + JSON.stringify(where));
    ok('desktop app running on a throwaway data folder');

    // ---------- 1. the ? button opens the bundled manual ----------
    await page.evaluate(() => document.getElementById('manualBtn').click());
    await wait(1500);
    const m = await dialog();
    if (/could not open/i.test(m)) fail('the ? button failed: ' + m);
    else ok('? opened the bundled manual with no error');
    if (m) await clickAsk(/ok/);

    // ---------- 2. Check for updates ----------
    await page.evaluate(() => document.getElementById('updBtn').click());
    await wait(800);
    const t2 = await page.evaluate(() => document.getElementById('toast').textContent);
    if (/in your browser/.test(t2)) fail('Check for updates fell back: ' + t2);
    else ok('Check for updates opened the releases page');

    // ---------- 3. sample -> SQLite ----------
    await page.evaluate(() => document.querySelector('[data-mode="journal"]').click());
    await wait(500);
    await page.evaluate(() => document.getElementById('emptySample').click());
    await wait(4000);
    if ((await count()) !== '1000') fail('sample did not load into the desktop journal: ' + (await count()));
    else ok('Load sample journal: 1000 trades in journal.db');

    // ---------- 4. Replace is backed up first, and Undo restores ----------
    const small = path.join(work, 'three.csv');
    fs.writeFileSync(small, 'Date,R\n2025-01-02 09:30,1\n2025-01-03 09:30,-1\n2025-01-06 09:30,2\n');
    const inp = await page.$('#jImportFile');
    await inp.uploadFile(small);
    await wait(700);
    if (!/copy of your current journal is saved first/.test(await dialog())) fail('the Replace dialog does not say a copy is saved first');
    await clickAsk(/replace/);
    await wait(3000);
    const snaps = files(/^before-replace-.*\.json$/);
    if (snaps.length !== 1) fail('Replace wrote ' + snaps.length + ' before-replace backups');
    else {
      const n = JSON.parse(fs.readFileSync(path.join(exp, snaps[0]), 'utf-8')).trades.length;
      if (n !== 1000) fail('the before-replace backup holds ' + n + ' trades, not the 1000 replaced');
      else ok('Replace saved the old journal first: ' + snaps[0] + ' (1000 trades)');
    }
    if ((await count()) !== '3') fail('after Replace the journal should hold 3, holds ' + (await count()));
    const undo = await page.$('#toast .toastbtn');
    if (!undo) fail('no Undo after Replace');
    else {
      await undo.click();
      await wait(2500);
      if ((await count()) !== '1000') fail('Undo after Replace restored ' + (await count()));
      else ok('Undo after Replace: all 1000 trades back');
    }

    // ---------- 5. deleting an account can be undone ----------
    await page.evaluate(() => { const s = document.getElementById('jAcct'); s.value = [...s.options].find((o) => /Sample 50k/.test(o.textContent)).value; s.dispatchEvent(new Event('change', { bubbles: true })); });
    await wait(600);
    await page.evaluate(() => document.getElementById('jDelAcct').click());
    await wait(400);
    await clickAsk(/delete account/);
    await wait(2000);
    const afterDel = await page.evaluate(() => document.querySelector('#jSummary .tile .v').textContent.trim());
    const undo2 = await page.$('#toast .toastbtn');
    if (!undo2) fail('no Undo after deleting an account (' + afterDel + ' left)');
    else {
      await undo2.click();
      await wait(2500);
      const back = await page.evaluate(() => ({ n: document.querySelector('#jSummary .tile .v').textContent.trim(), acct: [...document.getElementById('jAcct').options].map((o) => o.textContent).join('|') }));
      if (back.n !== '1000' || !/Sample 50k/.test(back.acct)) fail('account Undo restored ' + JSON.stringify(back));
      else ok('deleting an account can be undone (1000 trades and the account back)');
    }

    // ---------- 6. the restore reached SQLite, not just the screen ----------
    await page.reload();
    await page.waitForFunction('window.__PEL_READY === true', { timeout: 25000 });
    await page.evaluate(() => document.querySelector('[data-mode="journal"]').click());
    await wait(1500);
    if ((await count()) !== '1000') fail('after a reload the journal holds ' + (await count()));
    else ok('after a reload: still 1000 (Undo was persisted)');

    // ---------- 7. Save as image writes a PNG into exports ----------
    await page.evaluate(() => document.querySelector('[data-mode="sim"]').click());
    await wait(3000);
    await page.evaluate(() => document.getElementById('vReport').click());
    let png = [];
    for (let i = 0; i < 20 && !png.length; i++) { await wait(300); png = files(/^edge-lab-report-.*\.png$/); }
    if (!png.length) fail('Save as image wrote no PNG in exports');
    else {
      const buf = fs.readFileSync(path.join(exp, png[0]));
      if (buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a' || buf.readUInt32BE(16) !== 2400) fail('the report file is not a 2400px PNG');
      else ok('Save as image wrote ' + png[0]);
    }

    // ---------- 8. automatic backups prune to the newest 8; manual ones stay ----------
    for (let i = 0; i < 11; i++) {
      await page.evaluate(() => window.__TAURI__.core.invoke('export_journal', { data: '{"trades":[]}', silent: true, kind: 'auto' }));
      await wait(1050);   // the stamp has 1-second resolution
    }
    await page.evaluate(() => window.__TAURI__.core.invoke('export_journal', { data: '{"trades":[]}', silent: true, kind: 'manual' }));
    const autos = files(/^auto-backup-.*\.json$/).length;
    if (autos !== 8) fail('auto-backups after 12 writes: ' + autos + ', expected 8');
    else ok('automatic backups pruned to the newest 8');
    if (!files(/^before-replace-/).length) fail('pruning removed the before-replace backup');
    if (!files(/^prop-edge-lab-journal-/).length) fail('a manual backup was not written or was pruned');

    if (errs.length) fail('page errors: ' + errs.join(' | '));
  } catch (e) {
    fail(String(e && e.message || e));
  } finally {
    try { if (b) b.disconnect(); } catch { /* ignore */ }
    app.kill();
  }
  console.log(process.exitCode ? 'DESKTOP: FAILURES' : 'DESKTOP: ALL PASS');
})();
