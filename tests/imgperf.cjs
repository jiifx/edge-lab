// Long-log performance + image handling: lazy thumbnails, downscaled list thumbs,
// full-resolution originals in the lightbox, debounced filter typing, gallery order.
const puppeteer = require('puppeteer-core');
const path = require('path');
const APP = 'file:///' + path.resolve(__dirname, '../dist/PropEdgeLab2.html').replace(/\\/g, '/');
function fail(m){ console.error('FAIL: ' + m); process.exitCode = 1; }
const N = 1200;

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new',
    userDataDir: path.resolve('./pel-test/profile-imgperf-' + Date.now()),
    args: ['--no-sandbox','--disable-gpu','--allow-file-access-from-files', '--edge-skip-compat-layer-relaunch'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 900 });
  page.on('pageerror', e => fail('pageerror: ' + e.message));
  await page.goto(APP, { waitUntil: 'load' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 20000 });

  // seed N trades, each with a 1600x900 screenshot
  await page.evaluate(async (N) => {
    const c = document.createElement('canvas');
    c.width = 1600; c.height = 900;
    const x = c.getContext('2d');
    x.fillStyle = '#111'; x.fillRect(0, 0, 1600, 900);
    for (let i = 0; i < 300; i++) { x.fillStyle = 'hsl(' + (i % 360) + ',60%,55%)'; x.fillRect(i * 5, 300 + (i % 200), 4, 60); }
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
    await new Promise((res) => {
      const rq = indexedDB.open('propEdgeLab', 1);
      rq.onsuccess = e => {
        const db = e.target.result;
        const tx = db.transaction(['trades','images'], 'readwrite');
        const ts = tx.objectStore('trades'), ims = tx.objectStore('images');
        ts.clear(); ims.clear();
        const pad = v => String(v).padStart(2, '0');
        for (let i = 0; i < N; i++) {
          const d = new Date(2025, 0, 1 + Math.floor(i / 5), 9 + (i % 5), (i * 7) % 60);
          const dt = d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
          const R = (i % 3) ? 1.6 : -1;
          // last trade carries three images to exercise ordering + paging
          const ids = i === N - 1 ? ['im_a','im_b','im_c'] : ['im' + i];
          ids.forEach(id => ims.put({ id, blob, w: 1600, h: 900 }));
          ts.put({
            id: 't' + i, account: 'Main', dateTime: dt, instrument: 'MNQ',
            direction: i % 2 ? 'long' : 'short', session: 'New York', setup: 'Breakout',
            entry: 100, stop: 99, target: 102, exit: 100 + R, size: 1, riskAmt: 100,
            pnl: Math.round(R * 100), fees: 2, R: null, Rmanual: false, followedPlan: true,
            planText: '', notes: 'seeded', tags: { quality: 'B setup', mistake: [], condition: [] },
            emotionBefore: 2, emotionAfter: 2, imageIds: ids,
          });
        }
        tx.oncomplete = () => { db.close(); res(); };
      };
    });
  }, N);

  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction('window.__PEL_READY === true', { timeout: 20000 });
  // dismiss the weekly-backup prompt if it shows
  await page.evaluate(() => {
    if (!document.getElementById('askOv').classList.contains('hide')) {
      const b = [...document.querySelectorAll('#askBtns button')].find(x => /later/i.test(x.textContent));
      if (b) b.click();
    }
  });
  await page.click('.modenav button[data-mode="journal"]');
  await page.waitForSelector('.tradecard', { timeout: 10000 });

  const cards = await page.$$eval('.tradecard', els => els.length);
  if (cards !== N) fail('expected ' + N + ' cards, got ' + cards);
  else console.log('ok: ' + N + ' cards rendered');

  const loaded = () => page.$$eval('img[data-thumb]', els => els.filter(e => e.src && e.src.startsWith('blob:')).length);
  await new Promise(r => setTimeout(r, 2500));
  const atTop = await loaded();
  if (atTop === 0) fail('no thumbnails loaded at all - lazy loading broken');
  else if (atTop > 120) fail('lazy loading not limiting work: ' + atTop + ' of ' + N + ' thumbs loaded at top of list');
  else console.log('ok: lazy thumbnails - only ' + atTop + ' of ' + N + ' loaded while at the top');

  // list thumbs must be the downscaled copies, not the 1600px originals
  const thumbW = await page.$$eval('img[data-thumb]', els => {
    const im = els.find(e => e.src && e.src.startsWith('blob:') && e.naturalWidth);
    return im ? im.naturalWidth : 0;
  });
  if (!thumbW) fail('could not measure a loaded thumbnail');
  else if (thumbW > 192) fail('list thumb is full-size (' + thumbW + 'px) - downscaling not applied');
  else console.log('ok: list thumbs downscaled to ' + thumbW + 'px (originals are 1600px)');

  // scrolling streams in more
  await page.evaluate(() => { document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight * 0.5; });
  await new Promise(r => setTimeout(r, 2000));
  const midway = await loaded();
  if (midway <= atTop) fail('scrolling loaded no further thumbs (' + atTop + ' -> ' + midway + ')');
  else console.log('ok: scrolling streams in more thumbs (' + atTop + ' -> ' + midway + ')');
  await page.evaluate(() => { document.scrollingElement.scrollTop = 0; });

  // typing a word must coalesce into a single re-render
  const renders = await page.evaluate(async () => {
    const log = document.getElementById('jv-log');
    let n = 0;
    const mo = new MutationObserver(() => { n++; });
    mo.observe(log, { childList: true });
    const ft = document.getElementById('fltText');
    for (const w of ['s','se','see','seed','seede','seeded']) {
      ft.value = w;
      ft.dispatchEvent(new Event('input'));
      await new Promise(r => setTimeout(r, 50));
    }
    await new Promise(r => setTimeout(r, 500));
    mo.disconnect();
    return n;
  });
  if (renders > 2) fail('filter typing not debounced: ' + renders + ' re-renders for 6 keystrokes');
  else console.log('ok: 6 keystrokes coalesced into ' + renders + ' re-render(s)');
  await page.evaluate(() => { const ft = document.getElementById('fltText'); ft.value = ''; ft.dispatchEvent(new Event('input')); });
  await new Promise(r => setTimeout(r, 600));

  // ---- originals stay full quality ----
  await page.evaluate(() => {
    const c = [...document.querySelectorAll('.tradecard')].find(el => el.querySelector('.imgn'));
    (c || document.querySelector('.tradecard')).click();
  });
  await page.waitForSelector('#detailOv:not(.hide)', { timeout: 5000 });
  await new Promise(r => setTimeout(r, 900));
  const galOrder = await page.$$eval('#dtGallery img', els => els.map(e => e.alt));
  if (galOrder.length !== 3) fail('expected 3 gallery images, got ' + galOrder.length);
  else if (!galOrder[0].includes('1 of 3') || !galOrder[2].includes('3 of 3')) fail('gallery order wrong: ' + galOrder.join(' | '));
  else console.log('ok: gallery keeps logged image order (' + galOrder.length + ' images)');

  await page.click('#dtGallery img');
  await page.waitForSelector('#lightbox:not(.hide)', { timeout: 5000 });
  await new Promise(r => setTimeout(r, 900));
  const lb = await page.evaluate(() => {
    const im = document.getElementById('lightboxImg');
    return { w: im.naturalWidth, h: im.naturalHeight, count: document.getElementById('lbCount').textContent, zoom: document.getElementById('lbZoom').textContent };
  });
  if (lb.w !== 1600 || lb.h !== 900) fail('lightbox is NOT showing the original: ' + lb.w + 'x' + lb.h + ' (expected 1600x900)');
  else console.log('ok: lightbox shows the full-resolution original (' + lb.w + 'x' + lb.h + ')');
  if (lb.count.trim() !== '1 / 3') fail('lightbox counter wrong: ' + lb.count);
  else console.log('ok: lightbox paging counter reads ' + lb.count.trim());

  // zoom in, then page to the next image
  await page.click('#lbIn');
  const zoomed = await page.evaluate(() => document.getElementById('lbZoom').textContent);
  if (zoomed === '100%') fail('zoom-in had no effect');
  else console.log('ok: lightbox zooms (' + zoomed + ')');
  await page.click('#lbNext');
  await new Promise(r => setTimeout(r, 500));
  const after = await page.evaluate(() => ({ count: document.getElementById('lbCount').textContent.trim(), zoom: document.getElementById('lbZoom').textContent }));
  if (after.count !== '2 / 3') fail('lightbox next did not advance: ' + after.count);
  else console.log('ok: lightbox next -> ' + after.count + ', zoom reset to ' + after.zoom);

  // zoom must be proportional to scroll magnitude: a Mac trackpad emits a burst
  // of tiny deltas where a mouse wheel emits one big notch
  const zoomFeel = await page.evaluate(async () => {
    const box = document.getElementById('lightbox');
    const fire = (dy, n) => { for (let i = 0; i < n; i++) box.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, clientX: 700, clientY: 450, bubbles: true, cancelable: true })); };
    const z = () => parseInt(document.getElementById('lbZoom').textContent, 10);
    document.getElementById('lbFit').click();
    fire(-3, 1);                       // one trackpad tick
    const oneTrackpadTick = z();
    document.getElementById('lbFit').click();
    fire(-3, 25);                      // a full trackpad swipe
    const trackpadSwipe = z();
    document.getElementById('lbFit').click();
    fire(-100, 1);                     // one mouse-wheel notch
    const oneMouseNotch = z();
    document.getElementById('lbFit').click();
    return { oneTrackpadTick, trackpadSwipe, oneMouseNotch };
  });
  if (zoomFeel.oneTrackpadTick > 110) fail('a single trackpad tick jumps to ' + zoomFeel.oneTrackpadTick + '% - zoom not magnitude-scaled');
  else if (zoomFeel.trackpadSwipe >= 800) fail('a trackpad swipe pins zoom at max (' + zoomFeel.trackpadSwipe + '%)');
  else if (zoomFeel.oneMouseNotch < 115) fail('a mouse notch barely zooms (' + zoomFeel.oneMouseNotch + '%) - too weak for a wheel');
  else console.log('ok: zoom scales with scroll magnitude - trackpad tick ' + zoomFeel.oneTrackpadTick + '%, swipe ' + zoomFeel.trackpadSwipe + '%, mouse notch ' + zoomFeel.oneMouseNotch + '%');

  if (process.exitCode !== 1) console.log('IMGPERF: ALL PASS');
  await browser.close();
})().catch(e => { console.error('IMGPERF crashed:', e); process.exitCode = 1; });
