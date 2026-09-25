// Multi-account: create accounts, scoped trades/stats/balances, combined view, checkbox delete, persistence.
const puppeteer = require('puppeteer-core');
const path = require('path');
const APP = 'file:///' + path.resolve(__dirname, '../dist/PropEdgeLab2.html').replace(/\\/g, '/');
function fail(m){ console.error('FAIL: ' + m); process.exitCode = 1; }
(async () => {
  const browser = await puppeteer.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: 'new', userDataDir: path.resolve('./pel-test/profile-acct-' + Date.now()), args: ['--no-sandbox','--disable-gpu','--allow-file-access-from-files', '--edge-skip-compat-layer-relaunch'] });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => { try { if (localStorage.getItem('pel_prop') == null) localStorage.setItem('pel_prop', 'true'); } catch (e) { /* opaque origin */ } });  // these suites exercise prop-firm mode
  await page.setViewport({ width: 1500, height: 1200 });
  page.on('pageerror', e => fail('pageerror: ' + e.message));
  await page.goto(APP, { waitUntil: 'load' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 15000 });
  await page.click('[data-mode="journal"]');

  async function newAccount(name) {
    await page.click('#jNewAcct');
    await page.waitForFunction('!document.getElementById("askOv").classList.contains("hide")', { timeout: 3000 });
    await page.evaluate((n) => { const i = document.getElementById('acctName'); i.value = n; }, name);
    const btns = await page.$$('#askBtns button');
    await btns[btns.length - 1].click();
    await new Promise(r => setTimeout(r, 250));
  }
  async function logTrade(pnl) {
    await page.click('#jNew');
    await page.evaluate((p) => {
      const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); };
      document.getElementById('edSymSel').value = 'ES';
      document.getElementById('edSess').value = 'New York';   // required on save
      set('edRisk', '100'); set('edPnl', String(p));
    }, pnl);
    await page.click('#edSave');
    await page.waitForFunction('document.getElementById("editorOv").classList.contains("hide")', { timeout: 5000 });
  }

  // Challenge account: 2 trades; Personal: 1 trade
  await newAccount('Challenge');
  const scope1 = await page.$eval('#jAcct', e => e.value);
  if (scope1 !== 'Challenge') fail('scope not switched to new account: ' + scope1); else console.log('ok: account created + scoped');
  await logTrade(250); await logTrade(-100);
  await newAccount('Personal');
  await logTrade(500);

  // scoped views
  const cardsPersonal = await page.$$eval('.tradecard', els => els.length);
  if (cardsPersonal !== 1) fail('Personal scope should show 1 trade, got ' + cardsPersonal); else console.log('ok: Personal scope shows 1 trade');
  await page.select('#jAcct', 'Challenge');
  await new Promise(r => setTimeout(r, 250));
  const cardsChallenge = await page.$$eval('.tradecard', els => els.length);
  if (cardsChallenge !== 2) fail('Challenge scope should show 2 trades, got ' + cardsChallenge); else console.log('ok: Challenge scope shows 2 trades');
  const sumCh = await page.$eval('#jSummary', e => e.textContent);
  if (!sumCh.includes('$150')) fail('Challenge P&L wrong: ' + sumCh.slice(0, 150)); else console.log('ok: Challenge stats separate (+$150)');

  // per-account balances. The starting balance lives behind the "Show dollars"
  // disclosure now: dollars are an opt-in layer over an R-denominated journal.
  async function openDollars() {
    const hidden = await page.$eval('#jDollarBox', e => e.classList.contains('hide'));
    if (hidden) { await page.click('#jDollarBtn'); await new Promise(r => setTimeout(r, 200)); }
  }
  await openDollars();
  await page.type('#jStartBal', '25000');
  await new Promise(r => setTimeout(r, 600));
  await page.select('#jAcct', 'Personal');
  await new Promise(r => setTimeout(r, 250));
  const balPersonalInput = await page.$eval('#jStartBal', e => e.value);
  if (balPersonalInput !== '') fail('Personal balance should be empty, got ' + balPersonalInput); else console.log('ok: balances are per-account');
  await openDollars();
  await page.type('#jStartBal', '5000');
  await new Promise(r => setTimeout(r, 600));

  // combined view
  await page.select('#jAcct', '');
  await new Promise(r => setTimeout(r, 250));
  const cardsAll = await page.$$eval('.tradecard', els => els.length);
  if (cardsAll !== 3) fail('All scope should show 3 trades, got ' + cardsAll); else console.log('ok: combined view shows all 3');
  const sumAll = await page.$eval('#jSummary', e => e.textContent);
  if (!sumAll.includes('$650')) fail('combined P&L wrong: ' + sumAll.slice(0, 200));
  if (!sumAll.includes('30,650')) fail('combined balance wrong (want 25000+5000+650): ' + sumAll.slice(0, 250));
  else console.log('ok: combined balance $30,650 = both starts + all P&L');
  const balDisabled = await page.$eval('#jStartBal', e => e.disabled);
  if (!balDisabled) fail('balance input should be disabled in combined view'); else console.log('ok: balance input disabled in combined view');
  const hasAcctTags = await page.$$eval('.tag.acct', els => els.length);
  if (hasAcctTags < 3) fail('account tags missing in combined view'); else console.log('ok: cards show account tags in combined view');

  // checkbox delete: select the Personal trade in All view, delete it
  await page.click('#jSelMode');
  await new Promise(r => setTimeout(r, 200));
  const boxes = await page.$$('.tradecard .selbox');
  if (boxes.length !== 3) fail('selmode checkboxes missing: ' + boxes.length);
  await boxes[0].click(); // newest = Personal +500 (today, logged last)
  await new Promise(r => setTimeout(r, 200));
  const delTxt = await page.$eval('#jDelSel', e => e.textContent);
  if (delTxt !== 'Delete (1)') fail('delete counter wrong: ' + delTxt); else console.log('ok: checkbox select counts (Delete (1))');
  await page.click('#jDelSel');
  await page.waitForFunction('!document.getElementById("askOv").classList.contains("hide")', { timeout: 3000 });
  const btns2 = await page.$$('#askBtns button');
  await btns2[btns2.length - 1].click();
  await new Promise(r => setTimeout(r, 400));
  const cardsAfter = await page.$$eval('.tradecard', els => els.length);
  if (cardsAfter !== 2) fail('after bulk delete expected 2 cards, got ' + cardsAfter); else console.log('ok: bulk delete removed selected trade');

  // edge-source dropdown: options include both accounts; picking Challenge feeds sim from it
  const edgeOpts = await page.$$eval('#jEdgeAcct option', els => els.map(e => e.textContent));
  if (!edgeOpts.includes('Challenge') || !edgeOpts.includes('Personal') || !edgeOpts.includes('All accounts'))
    fail('edge source options wrong: ' + JSON.stringify(edgeOpts));
  else console.log('ok: edge-source dropdown lists accounts + All');
  await page.select('#jEdgeAcct', 'Challenge');
  await page.click('[data-mode="sim"]');
  await page.click('#useJournal');
  await new Promise(r => setTimeout(r, 400));
  const desc = await page.$eval('#jedgeDesc', e => e.textContent);
  if (!desc.includes('Challenge')) fail('edge desc not scoped to Challenge: ' + desc);
  else console.log('ok: edge feed scoped (guard message names Challenge, has <10 trades)');
  await page.click('[data-mode="journal"]');

  // select-all: scope Challenge (2 trades), Select -> All -> counter 2
  await page.select('#jAcct', 'Challenge');
  await new Promise(r => setTimeout(r, 250));
  await page.click('#jSelMode');
  await page.click('#jSelAll');
  await new Promise(r => setTimeout(r, 200));
  const delAll = await page.$eval('#jDelSel', e => e.textContent);
  if (delAll !== 'Delete (2)') fail('select-all counter wrong: ' + delAll); else console.log('ok: Select All selects the whole scoped view');
  await page.click('#jSelMode'); // cancel

  // delete account: Challenge (2 trades) via scope Delete button
  const delBtnVisible = await page.$eval('#jDelAcct', e => !e.classList.contains('hide'));
  if (!delBtnVisible) fail('account Delete button not visible in scoped view');
  await page.click('#jDelAcct');
  await page.waitForFunction('!document.getElementById("askOv").classList.contains("hide")', { timeout: 3000 });
  const askTxt = await page.$eval('#askMsg', e => e.textContent);
  if (!askTxt.includes('Challenge') || !askTxt.includes('2')) fail('delete-account confirm wrong: ' + askTxt);
  const dbtns = await page.$$('#askBtns button');
  await dbtns[dbtns.length - 1].click();
  await new Promise(r => setTimeout(r, 400));
  const optsAfterDel = await page.$$eval('#jAcct option', els => els.map(e => e.value));
  if (optsAfterDel.includes('Challenge')) fail('Challenge still listed after delete');
  const cardsAfterDel = await page.$$eval('.tradecard', els => els.length);
  if (cardsAfterDel !== 0) fail('after account delete expected 0 cards (Personal trade was bulk-deleted earlier), got ' + cardsAfterDel);
  else console.log('ok: delete account removed account + its trades');

  // persistence across reload: Challenge gone, Personal + its balance survive
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 15000 });
  const opts = await page.$$eval('#jAcct option', els => els.map(e => e.value));
  if (opts.includes('Challenge')) fail('deleted account came back after reload');
  if (!opts.includes('Personal')) fail('accounts lost after reload: ' + JSON.stringify(opts));
  else console.log('ok: account list persists correctly after reload');
  await page.select('#jAcct', 'Personal');
  await new Promise(r => setTimeout(r, 250));
  const balP = await page.$eval('#jStartBal', e => e.value);
  if (balP !== '5000') fail('Personal balance lost: ' + balP); else console.log('ok: per-account balance persists');
  // an account that already has a balance keeps the dollar panel open, so a
  // configured setting is never hidden behind the new collapsed disclosure
  const boxOpen = await page.$eval('#jDollarBox', e => !e.classList.contains('hide'));
  if (!boxOpen) fail('dollar panel collapsed over an existing starting balance');
  else console.log('ok: dollar panel auto-opens for an account that already has one');

  await browser.close();
  console.log(process.exitCode ? 'MULTIACCT: FAIL' : 'MULTIACCT: ALL PASS');
})().catch(e => { console.error('crashed:', e.message); process.exit(1); });
