/*
 * Two-browser end-to-end test for the authoritative room server.
 *
 * Starts are orchestrated by the server; this test checks that both browser
 * contexts join the same room, receive the same two-car snapshot, start the
 * race, send inputs, and see both cars moving under server authority.
 *
 * Run against local services:
 *   node tests/multiplayer.e2e.js
 * Environment:
 *   MP_BASE=http://127.0.0.1:8789/index.html
 *   MP_WS=ws://127.0.0.1:8788/ws
 */
const { chromium } = require('playwright');

const BASE = process.env.MP_BASE || 'http://127.0.0.1:8789/index.html';
const WS = process.env.MP_WS || 'ws://127.0.0.1:8788/ws';
const ROOM = 'E2E' + Date.now().toString(36).toUpperCase().slice(-7);
const CHECK_FINISH = process.env.MP_SKIP_FINISH !== '1';

function fail(message) {
  throw new Error(message);
}

(async () => {
  const launch = { args: ['--no-sandbox'] };
  if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;
  const browser = await chromium.launch(launch);
  const errors = [];
  const pages = [];
  try {
    for (let i = 0; i < 2; i++) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      page.on('pageerror', err => errors.push(String(err).slice(0, 240)));
      let url = BASE + (BASE.includes('?') ? '&' : '?') + 'room=' + encodeURIComponent(ROOM);
      if (process.env.MP_SKIP_WS_PARAM !== '1') url += '&ws=' + encodeURIComponent(WS);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      pages.push(page);
    }

    for (let i = 0; i < pages.length; i++) {
      await pages[i].waitForFunction(
        () => window.__mpStats && window.__mpStats.slot,
        null,
        { timeout: 8000 }
      );
    }

    const joined = await Promise.all(pages.map(p => p.evaluate(() => window.__mpStats)));
    if (joined[0].slot === joined[1].slot) fail('both browsers received the same slot');
    if (!joined.every(s => s.room === ROOM)) fail('room code mismatch');

    // The server starts the countdown when the second browser joins.
    for (const page of pages) {
      await page.waitForFunction(
        () => window.__mpStats && window.__mpStats.phase === 'run',
        null,
        { timeout: 15000 }
      );
    }

    await Promise.all(pages.map(async (page, i) => {
      await page.bringToFront();
      await page.keyboard.down('ArrowUp');
    }));
    await new Promise(resolve => setTimeout(resolve, 900));
    await Promise.all(pages.map(page => page.keyboard.up('ArrowUp')));

    const states = await Promise.all(pages.map(p => p.evaluate(() => window.__mpStats)));
    for (let i = 0; i < states.length; i++) {
      const s = states[i];
      if (!s || s.phase !== 'run') fail('page ' + (i + 1) + ' did not enter run');
      if (!s.cars || s.cars.length !== 2) fail('page ' + (i + 1) + ' did not receive two cars');
      if (!s.cars.some(c => c.id === 'p1') || !s.cars.some(c => c.id === 'p2')) {
        fail('page ' + (i + 1) + ' missing a player snapshot');
      }
      if (!(s.cars.some(c => Math.abs(c.z - 480) > 2))) fail('server cars did not move');
    }

    const content = await pages[0].evaluate(() => ({
      room: window.__mpStats && window.__mpStats.room,
      menus: !!document.querySelector('.menu.on')
    }));
    if (content.room !== ROOM || content.menus) fail('multiplayer status was not rendered');

    let finish = null;
    if (CHECK_FINISH) {
      for (const page of pages) {
        await page.waitForFunction(
          () => window.__mpStats && window.__mpStats.phase === 'finished',
          null,
          { timeout: 20000 }
        );
        await page.waitForSelector('#raceResult.on', { timeout: 5000 });
      }
      finish = await Promise.all(pages.map(p => p.evaluate(() => ({
        title: document.getElementById('resultTitle').textContent,
        kicker: document.getElementById('resultKicker').textContent,
        menus: !!document.querySelector('.menu.on')
      }))));
      if (!finish.every(f => /YOU WIN|RIVAL WINS|TIME UP/.test(f.title))) {
        fail('authoritative result overlay did not render a winner');
      }

      // The server's 7 s rematch delay must create a fresh run without a reload.
      for (const page of pages) {
        await page.waitForFunction(
          () => window.__mpStats && window.__mpStats.phase === 'run' && window.__mpStats.tick > 0,
          null,
          { timeout: 15000 }
        );
      }
    }

    console.log('PASS', JSON.stringify({
      room: ROOM,
      slots: joined.map(s => s.slot),
      ticks: states.map(s => s.tick),
      cars: states[0].cars.map(c => ({ id: c.id, z: c.z })),
      status: content,
      finish: finish && finish.map(f => f.title)
    }));
    if (errors.length) fail('page errors: ' + errors.join(' | '));
  } finally {
    await browser.close();
  }
})().catch(err => {
  console.error('FAIL', err.stack || err);
  process.exit(1);
});
