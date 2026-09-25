// Trap #1, automated: does the app still render under the CSP the PACKAGED app
// serves?
//
// This class of bug is invisible everywhere the suites already look. `npm run
// dev` serves no CSP and neither does dist/PropEdgeLab2.html, so a rule a nonce
// makes inert renders perfectly in both and is wrong only in the installed app
// - which is how it shipped once already (Trap #1: calendar heat tint gone,
// `grid-column:1/-1` tiles collapsed into one narrow column, every stat-tile
// mini-meter and rule-guard meter missing).
//
// Driving the real .exe is not the answer: WebView2 suspends the renderer when
// the window is occluded, so CDP evaluation hangs a few seconds after launch.
// Serving dist/ with the exact header from tauri.conf.json reproduces the thing
// that actually matters - the directive semantics - in a browser that can be
// driven. Two passes:
//   1. the literal config CSP: what ships, because
//      `dangerousDisableAssetCspModification: ["style-src"]` stops Tauri's
//      codegen adding a nonce to it.
//   2. the same CSP with a nonce injected into style-src: what would ship if
//      that flag were ever dropped. Per the CSP spec a nonce makes
//      'unsafe-inline' IGNORED, so this pass is what proves `style-src-attr`
//      (the other half of the belt-and-braces) is really carrying the style=""
//      attributes rather than them surviving by luck.
const puppeteer = require('puppeteer-core');
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', 'dist');
const CFG = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'src-tauri', 'tauri.conf.json'), 'utf8'));
const BASE_CSP = CFG.app.security.csp;
function fail(m) { console.error('FAIL: ' + m); process.exitCode = 1; }
function ok(m) { console.log('ok - ' + m); }

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
function serve(csp) {
  return new Promise((res) => {
    const s = http.createServer((rq, rs) => {
      const rel = decodeURIComponent(rq.url.split('?')[0]);
      const p = path.join(ROOT, rel === '/' ? 'index.html' : rel);
      if (!p.startsWith(ROOT) || !fs.existsSync(p)) { rs.writeHead(404); rs.end(); return; }
      rs.writeHead(200, {
        'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream',
        'Content-Security-Policy': csp,
      });
      rs.end(fs.readFileSync(p));
    });
    s.listen(0, '127.0.0.1', () => res(s));
  });
}

(async () => {
  if (!fs.existsSync(path.join(ROOT, 'index.html'))) { fail('dist/index.html missing - run npm run build first'); process.exit(1); }
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new',
    userDataDir: path.resolve('./pel-test/profile-csp-' + process.pid),
    args: ['--no-sandbox', '--disable-gpu', '--edge-skip-compat-layer-relaunch'],
  });

  const run = async (label, csp) => {
    const server = await serve(csp);
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => { try { if (localStorage.getItem('pel_prop') == null) localStorage.setItem('pel_prop', 'true'); } catch (e) { /* opaque origin */ } });  // these suites exercise prop-firm mode
    await page.setViewport({ width: 1400, height: 950 });
    await page.evaluateOnNewDocument(() => {
      window.__CSPV = [];
      document.addEventListener('securitypolicyviolation', (e) => {
        window.__CSPV.push(e.violatedDirective + ' <- ' + (e.sourceFile || '') + ':' + e.lineNumber);
      });
    });
    page.on('pageerror', (e) => fail(label + ': pageerror ' + e.message));
    await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
    await page.waitForFunction('window.__PEL_READY === true', { timeout: 20000 });
    const r = await page.evaluate(() => {
      const cs = (el) => getComputedStyle(el);
      const out = { cspv: window.__CSPV.slice(0, 6) };
      // (a) did the app's CSS load at all - if the inline <style> block were
      //     blocked, every check below would be meaningless
      out.railDashed = cs(document.querySelector('.jedge')).borderTopStyle;
      // (b) inline style="" attributes. The counterfactual field's own one, plus
      //     a probe INJECTED VIA innerHTML - attributes parsed from HTML strings
      //     are exactly the path a nonced style-src kills, and injecting one is
      //     deterministic where hunting for an app tile depends on which screen
      //     happens to be rendered
      const lc = document.querySelector('label[for="jEdgeCut"]');
      out.cutFieldMarginTop = lc ? cs(lc.parentElement).marginTop : 'MISSING';
      const probe = document.createElement('div');
      document.body.appendChild(probe);
      probe.innerHTML = '<div id="cspProbe" style="margin-top:33px"></div>';
      out.injectedInline = cs(document.getElementById('cspProbe')).marginTop;
      probe.remove();
      // (c) the new stylesheet rules, exercised on real markup
      const box = document.getElementById('jedgeCut');
      out.hasBox = !!box;
      if (box) {
        box.className = 'cutbox';
        box.innerHTML = '<p class="ch">p</p><table class="cuttab"><thead><tr><th>&nbsp;</th><th>now</th><th>without</th></tr></thead>'
          + '<tbody><tr><td>expectancy</td><td class="was">+0.08R</td><td class="now">+0.34R</td></tr></tbody></table>'
          + '<p class="cv-band">b</p>';
        const b = cs(box), tab = box.querySelector('.cuttab');
        out.cutboxBorderTop = b.borderTopWidth;
        out.cutboxPaddingTop = b.paddingTop;
        out.tabCollapse = cs(tab).borderCollapse;
        out.tabMono = /mono|courier|consol/i.test(cs(tab).fontFamily);
        out.nowAlign = cs(box.querySelector('td.now')).textAlign;
        out.nowWeight = cs(box.querySelector('td.now')).fontWeight;
        out.overflowsRail = tab.scrollWidth > box.clientWidth + 2;
        box.className = 'cutbox warn';
        out.warnBorder = cs(box).borderTopColor;
        box.className = 'cutbox hide';
        out.hidden = cs(box).display;
      }
      return out;
    });
    await page.close();
    server.close();
    return r;
  };

  // ---------- pass 1: exactly what ships ----------
  const shipped = await run('shipped', BASE_CSP);
  if (shipped.railDashed !== 'dashed') fail('the app stylesheet did not apply under the shipped CSP (.jedge border-top ' + shipped.railDashed + ')');
  else ok('shipped CSP: the stylesheet applies');
  if (shipped.cutFieldMarginTop !== '8px') fail('the counterfactual field lost its inline style="" - this is Trap #1: ' + shipped.cutFieldMarginTop);
  else ok('shipped CSP: the new field keeps its inline style attribute (8px)');
  if (!shipped.hasBox) fail('#jedgeCut is not in the built markup');
  else if (shipped.cutboxBorderTop === '0px' || shipped.cutboxPaddingTop === '0px') fail('the .cutbox rules did not apply: ' + JSON.stringify(shipped));
  else ok('shipped CSP: .cutbox applies (border-top ' + shipped.cutboxBorderTop + ', padding-top ' + shipped.cutboxPaddingTop + ')');
  if (shipped.tabCollapse !== 'collapse' || !shipped.tabMono || shipped.nowAlign !== 'right' || shipped.nowWeight !== '700') {
    fail('the .cuttab rules did not apply: ' + JSON.stringify({ collapse: shipped.tabCollapse, mono: shipped.tabMono, align: shipped.nowAlign, weight: shipped.nowWeight }));
  } else ok('shipped CSP: .cuttab is mono, right-aligned, with a bold "without" column');
  if (shipped.overflowsRail) fail('the readout table overflows the rail');
  else ok('shipped CSP: the table fits inside the rail');
  if (shipped.hidden !== 'none') fail('.cutbox.hide does not hide it: display ' + shipped.hidden);
  else ok('shipped CSP: .hide still hides the readout when no cut is set');
  if (shipped.injectedInline !== '33px') fail('an innerHTML-injected style attribute died under the shipped CSP: ' + shipped.injectedInline);
  else ok('shipped CSP: innerHTML-injected style attributes apply');
  // the probe deliberately violates nothing under the shipped policy; the readout
  // itself is built through innerHTML, so a violation here is a broken app
  if (shipped.cspv.length) fail('CSP violations under the shipped policy: ' + JSON.stringify(shipped.cspv));
  else ok('shipped CSP: no violations reported by the page');

  // ---------- pass 2: the nonce variant the belt-and-braces exists for ----------
  const nonced = await run('nonced', BASE_CSP.replace("style-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline' 'nonce-abc123'"));
  if (nonced.cutFieldMarginTop !== '8px') {
    fail('with a nonce in style-src the inline attribute died - style-src-attr is not covering it: ' + nonced.cutFieldMarginTop);
  } else ok('nonce in style-src: style-src-attr still carries the parsed inline attribute');
  if (nonced.injectedInline !== '33px') fail('an innerHTML-injected attribute died under a nonce - style-src-attr is not covering it: ' + nonced.injectedInline);
  else ok('nonce in style-src: innerHTML-injected attributes survive too');

  await browser.close();
  if (!process.exitCode) console.log('\nAll CSP checks passed.');
})().catch((e) => { fail(e.stack || e.message); process.exit(1); });
