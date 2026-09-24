// A 0R trade must be neither a win nor a loss: 2W-1L-1S must read 67% (2/3),
// not 50% (2/4), with the scratch named in the record and the pill neutral.
const puppeteer = require('puppeteer-core');
const path = require('path');
const APP = 'file:///' + require('path').resolve(__dirname, '../dist/PropEdgeLab2.html').replace(/\\/g, '/');
function fail(m){ console.error('FAIL: ' + m); process.exitCode = 1; }

(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new', userDataDir: path.resolve('./pel-test/profile-scratch-' + Date.now()),
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--edge-skip-compat-layer-relaunch'],
  });
  const p = await b.newPage();
  await p.setViewport({ width: 1400, height: 1100 });
  p.on('pageerror', e => fail('pageerror: ' + e.message));
  await p.goto(APP, { waitUntil: 'load' });
  await p.waitForFunction('window.__PEL_READY === true', { timeout: 20000 });
  await p.evaluate(() => document.querySelector('.modenav button[data-mode="journal"]').click());

  const set = async (id, v) => p.evaluate((id, v) => {
    const e = document.getElementById(id); e.value = String(v); e.dispatchEvent(new Event('input', { bubbles: true }));
  }, id, v);
  const T = [[300, '09:31'], [150, '09:45'], [-100, '10:05'], [0, '10:25']]; // 2W 1L 1S
  for (let i = 0; i < T.length; i++) {
    await p.click('#jNew');
    await set('edDate', '2026-07-' + String(20 + i).padStart(2, '0') + 'T' + T[i][1]);
    await p.select('#edSymSel', 'ES');
    await p.select('#edSess', 'New York');   // session is required on save
    await set('edSetup', 'ORB');
    await set('edRisk', 100); await set('edPnl', T[i][0]);
    await p.click('#edSave');
    await p.waitForFunction('document.getElementById("editorOv").classList.contains("hide")', { timeout: 8000 });
  }

  // the 0R pill must carry neither win nor loss styling
  const pills = await p.evaluate(() => [...document.querySelectorAll('.rpill')].map(e => e.className.trim()));
  const neutral = pills.filter(c => c === 'rpill').length;
  if (!pills.some(c => c.includes('win')) || !pills.some(c => c.includes('loss')) || neutral < 1)
    fail('pill classes wrong: ' + JSON.stringify(pills));
  else console.log('ok: 0R pill is neutral (classes: ' + JSON.stringify(pills) + ')');

  await p.evaluate(() => document.querySelector('.subnav button[data-jview="stats"]').click());
  await new Promise(r => setTimeout(r, 1200));
  const txt = await p.evaluate(() => document.getElementById('jv-stats').innerText.replace(/\n+/g, ' | '));
  const m = txt.match(/Win rate \| (\d+)%/i) || txt.match(/WIN RATE \| (\d+)%/i);
  if (!m) fail('no win rate found: ' + txt.slice(0, 300));
  else if (m[1] !== '67') fail('win rate is ' + m[1] + '% - a scratch is still being counted as a loss (expected 67%)');
  else console.log('ok: win rate reads 67% for a 2W-1L-1S record');
  if (!/2W.1L.1 scratch/i.test(txt.replace(/[–—]/g, '-'))) fail('record line missing: ' + txt.slice(0, 400));
  else console.log('ok: record reads 2W-1L-1 scratch');
  if (process.exitCode !== 1) console.log('SCRATCH TEST: ALL PASS');
  await b.close();
})();
