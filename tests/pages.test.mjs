// jsdom smoke + play tests for the DO Games pages.
// Run: node ~/workspace/do-games/tests/pages.test.mjs
//
// Canvas 2D is stubbed, requestAnimationFrame is pumped manually on a
// fake clock (performance.now is stubbed to the same clock), fetch is
// stubbed: GET returns leaderboard fixtures, POST is captured so the
// submitted breakdown can be checked against the server contracts.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire('/home/hatch/workspace/coffee-wallet/src/package.json');
const { JSDOM } = require('jsdom');

let passed = 0, failed = 0;
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.log('  FAIL ' + label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
}
function eq(a, b, label) { ok(a === b, label + ' (want ' + JSON.stringify(b) + ', got ' + JSON.stringify(a) + ')'); }

const commonJs = readFileSync(new URL('../common.js', import.meta.url), 'utf8');

function makeCtx(canvas) {
  const grad = { addColorStop() { } };
  const base = {
    canvas,
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
    measureText: () => ({ width: 0 }),
  };
  return new Proxy(base, {
    get(t, k) { if (k in t) return t[k]; return () => { }; },
    set() { return true; },
  });
}

const BOARD_FIXTURE = {
  ok: true, week: '2026-W43', resetsAt: '2026-10-26T00:00:00.000Z',
  weekly: {
    board: 'week', entries: [
      { id: 'tg:42', name: 'Ada @ada', guest: false, total: 630, games: { catch: 610, wheel: 20, rocket: 0, slice: 0, breakout: 0, stack: 0, mines: 0, memory: 0, snake: 0, crossing: 0 } },
      { id: 'guest:tester', name: 'Tester', guest: true, total: 55, games: { catch: 0, wheel: 0, rocket: 0, slice: 0, breakout: 0, stack: 0, mines: 55, memory: 0, snake: 0, crossing: 0 } },
    ],
  },
  allTime: {
    board: 'all', entries: [
      { id: 'tg:42', name: 'Ada @ada', guest: false, total: 630, games: { catch: 610, wheel: 20, rocket: 0, slice: 0, breakout: 0, stack: 0, mines: 0, memory: 0, snake: 0, crossing: 0 } },
    ],
  },
};

function loadPage(file, opts = {}) {
  let html = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
  html = html.replace('<script src="https://telegram.org/js/telegram-web-app.js"></script>', '');
  html = html.replace('<script src="common.js"></script>', '<script>\n' + commonJs + '\n</script>');
  const errors = [];
  const posts = [];
  const rafQ = [];
  let now = 0;
  const dom = new JSDOM(html, {
    url: opts.url || 'https://do-games.example/',
    runScripts: 'dangerously',
    beforeParse(window) {
      window.HTMLCanvasElement.prototype.getContext = function () { return makeCtx(this); };
      window.requestAnimationFrame = (cb) => { rafQ.push(cb); return rafQ.length; };
      window.performance.now = () => now;
      window.fetch = (u, o) => {
        if (o && o.method === 'POST') {
          posts.push(JSON.parse(o.body));
          return Promise.resolve({ json: async () => ({ ok: true, score: 1, rankWeek: 2, rankAll: 3, totalAll: 100 }) });
        }
        return Promise.resolve({ json: async () => BOARD_FIXTURE });
      };
      if (opts.guestName !== null) {
        try { window.localStorage.setItem('doGamesName', opts.guestName || 'Tester'); } catch (e) { }
      }
      window.addEventListener('error', (e) => errors.push(String(e.message || e.error)));
    },
  });
  return {
    dom, errors, posts,
    w: dom.window,
    pump(n, stepMs = 16.7) {
      for (let i = 0; i < (n || 1); i++) {
        const cb = rafQ.shift();
        if (!cb) break;
        now += stepMs;
        cb(now);
      }
    },
    advance(ms) { now += ms; },
  };
}
async function flush() { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); }

console.log('— lobby —');
{
  const { dom, errors, w } = loadPage('index.html');
  await flush();
  const cards = w.document.querySelectorAll('.card');
  eq(cards.length, 10, 'lobby renders 10 game cards');
  ok(w.document.body.textContent.includes('DO Games'), 'lobby title present');
  const rows = w.document.querySelectorAll('.lbrow');
  eq(rows.length, 2, 'weekly fixture renders 2 rows');
  ok(rows[1].querySelector('.gtag'), 'guest tag on guest row');
  ok(rows[0].textContent.includes('Catch 610'), 'per-game breakdown line rendered', rows[0].textContent);
  ok(w.document.getElementById('idChip').textContent.includes('Tester'), 'identity chip shows guest name');
  w.document.getElementById('tabAll').click();
  await flush();
  eq(w.document.querySelectorAll('.lbrow').length, 1, 'all-time tab renders its fixture');
  eq(errors.length, 0, 'zero page errors (lobby)', errors);
  dom.window.close();
}

console.log('— lobby: telegram identity highlight —');
{
  const rawUser = JSON.stringify({ id: 42, first_name: 'Ada', username: 'ada' });
  const rawInit = 'query_id=AAE1&user=' + encodeURIComponent(rawUser) + '&auth_date=1792700000&hash=0123abcd';
  const url = 'https://do-games.example/#tgWebAppData=' + encodeURIComponent(rawInit) + '&tgWebAppVersion=7.0';
  const { dom, errors, w } = loadPage('index.html', { url, guestName: null });
  await flush();
  const rows = w.document.querySelectorAll('.lbrow');
  ok(rows.length && rows[0].classList.contains('me'), 'own telegram row highlighted');
  ok(w.document.getElementById('idChip').textContent.includes('Ada @ada'), 'chip shows telegram name');
  eq(errors.length, 0, 'zero page errors (lobby tg)', errors);
  dom.window.close();
}

console.log('— catch —');
{
  const L = loadPage('catch.html');
  const { w, errors, posts } = L;
  const hook = w.__doGame;
  ok(!!hook, 'catch hook present');
  hook.start();
  const G = hook.game;
  // catch 2 regular + 1 golden at the jar mouth
  for (const [type, n] of [['regular', 2], ['golden', 1]]) {
    for (let i = 0; i < n; i++) {
      const it = hook.spawn(type, G.jarX);
      it.y = G.jarY + 4;
      hook.step(0.016);
    }
  }
  eq(G.stats.regular, 2, 'caught 2 regular');
  eq(G.stats.golden, 1, 'caught 1 golden');
  eq(G.score, 50, 'score 2×10 + 30 = 50');
  // 3 burnt catches end the run
  for (let i = 0; i < 3; i++) {
    const it = hook.spawn('burnt', G.jarX);
    it.y = G.jarY + 4;
    hook.step(0.016);
  }
  eq(G.state, 'over', 'run ends on 3rd burnt catch');
  eq(G.stats.burnt, 3, '3 burnt recorded');
  await flush();
  eq(posts.length, 1, 'one score POST');
  eq(posts[0].game, 'catch', 'POST game = catch');
  eq(posts[0].guestName, 'Tester', 'POST carries guest name');
  eq(posts[0].breakdown.regular, 2, 'POST breakdown regular');
  eq(posts[0].breakdown.burnt, 3, 'POST breakdown burnt');
  ok(Number.isInteger(posts[0].breakdown.durationMs), 'POST durationMs present');
  eq(errors.length, 0, 'zero page errors (catch)', errors);
  L.dom.window.close();
}

console.log('— wheel —');
{
  const L = loadPage('wheel.html');
  const { w, errors, posts } = L;
  const hook = w.__doGame;
  hook.spin();
  L.pump(300); // fake clock runs the whole 3.2–3.7 s animation
  ok(hook.state.lastResult, 'wheel produced a result');
  const idx = hook.landedIndex(hook.state.rot);
  eq(hook.state.lastResult.idx, idx, 'landed index matches final rotation');
  ok(hook.segments.includes(hook.state.lastResult.value === 0 ? 'BUST' : hook.state.lastResult.value), 'value is a real segment');
  ok(hook.state.lastResult.spinMs >= 2800, 'spinMs ≥ 2800 (server minimum)', hook.state.lastResult.spinMs);
  await flush();
  eq(posts.length, 1, 'one score POST');
  eq(posts[0].game, 'wheel', 'POST game = wheel');
  eq(posts[0].breakdown.value, hook.state.lastResult.value, 'POST value matches landed segment');
  eq(errors.length, 0, 'zero page errors (wheel)', errors);
  L.dom.window.close();
}

console.log('— rocket —');
{
  const L = loadPage('rocket.html');
  const { w, errors, posts } = L;
  const hook = w.__doGame;
  hook.start();
  hook.game.crashAt = 8; // pin the crash point so the test flight cannot crash early
  L.pump(400); // ~6.7 s of game time → mult ≈ e^0.74 ≈ 2.1
  ok(hook.game.mult > 1.9 && hook.game.mult < 2.4, 'multiplier climbed to ~2.1x', hook.game.mult);
  hook.cashOut();
  await flush();
  eq(posts.length, 1, 'one score POST');
  eq(posts[0].game, 'rocket', 'POST game = rocket');
  const cm = posts[0].breakdown.cashedMult;
  ok(cm > 1.9 && cm < 2.4, 'cashedMult matches flight', cm);
  const minMs = (Math.log(cm) / 0.11) * 1000 * 0.9;
  ok(posts[0].breakdown.durationMs >= minMs, 'durationMs consistent with growth curve', posts[0].breakdown);
  eq(errors.length, 0, 'zero page errors (rocket)', errors);
  L.dom.window.close();
}

console.log('— slice —');
{
  const L = loadPage('slice.html');
  const { w, errors, posts } = L;
  const hook = w.__doGame;
  hook.start();
  const it = hook.spawn('cookie', 150);
  it.x = 150; it.y = 200; it.vy = 0;
  hook.sliceSeg(110, 200, 190, 200);
  eq(hook.game.stats.sliced, 1, 'cookie sliced');
  eq(hook.game.score, 10, 'score +10');
  const bomb = hook.spawn('bomb', 150);
  bomb.x = 150; bomb.y = 200; bomb.vy = 0;
  hook.sliceSeg(110, 200, 190, 200);
  eq(hook.game.stats.bombs, 1, 'bomb sliced = strike');
  eq(hook.game.strikes, 1, 'one strike');
  eq(hook.game.score, 0, 'bomb penalty −25 floored at 0 (was 10)');
  eq(errors.length, 0, 'zero page errors (slice)', errors);
  L.dom.window.close();
}

console.log('— breakout —');
{
  const L = loadPage('breakout.html');
  const { w, errors } = L;
  const hook = w.__doGame;
  hook.start();
  const G = hook.game;
  hook.launch();
  const blk = G.blocks[3]; // top row (row 0), col 3 — clear space above it
  G.ball.x = blk.x + G.bw / 2;
  G.ball.y = blk.y - G.ball.r + 2;
  G.ball.vx = 0; G.ball.vy = 300;
  hook.step(0.016);
  eq(G.counts.reduce((s, n) => s + n, 0), 1, 'one block broken');
  eq(G.counts[0], 1, 'the broken block is in the top row');
  eq(G.score, 15, 'top row pays 15');
  eq(errors.length, 0, 'zero page errors (breakout)', errors);
  L.dom.window.close();
}

console.log('— stack —');
{
  const L = loadPage('stack.html');
  const { w, errors, posts } = L;
  const hook = w.__doGame;
  hook.start();
  const G = hook.game;
  hook.step(1);
  G.moving.x = G.layers[0].x + 10; // partial overlap
  hook.drop();
  eq(G.layersCount, 1, 'layer 1 placed');
  eq(G.perfects, 0, 'offset drop is not perfect');
  hook.step(1);
  G.moving.x = G.layers[G.layers.length - 1].x; // dead-on
  hook.drop();
  eq(G.layersCount, 2, 'layer 2 placed');
  eq(G.perfects, 1, 'dead-on drop is perfect');
  eq(hook.score(), 3, 'score = 2 layers + 1 perfect');
  hook.step(1);
  const top = G.layers[G.layers.length - 1];
  G.moving.x = top.x + top.w + 60; // complete miss
  hook.drop();
  eq(G.state, 'over', 'complete miss ends the run');
  await flush();
  eq(posts.length, 1, 'one score POST');
  eq(posts[0].game, 'stack', 'POST game = stack');
  eq(posts[0].breakdown.layers, 2, 'POST layers 2');
  eq(posts[0].breakdown.perfects, 1, 'POST perfects 1');
  ok(posts[0].breakdown.durationMs >= 600, 'POST durationMs ≥ layers × 300ms bound', posts[0].breakdown.durationMs);
  eq(errors.length, 0, 'zero page errors (stack)', errors);
  L.dom.window.close();
}

console.log('— mines —');
{
  const L = loadPage('mines.html');
  const { w, errors, posts } = L;
  const hook = w.__doGame;
  const S = hook.state();
  const safeIdx = [...Array(25).keys()].find((i) => !S.mines[i]);
  const mineIdx = [...Array(25).keys()].find((i) => S.mines[i]);
  w.document.querySelectorAll('.tile')[safeIdx].click();
  eq(hook.state().safe, 1, 'one safe tile revealed');
  eq(w.document.getElementById('bankVal').textContent, '1', 'bank shows 1');
  w.document.getElementById('cashBtn').click();
  await flush();
  eq(posts.length, 1, 'cash-out POST sent');
  eq(posts[0].breakdown.safeTiles, 1, 'POST safeTiles 1');
  eq(posts[0].breakdown.cashedOut, true, 'POST cashedOut true');
  hook.newBoard();
  const S2 = hook.state();
  const mine2 = [...Array(25).keys()].find((i) => S2.mines[i]);
  w.document.querySelectorAll('.tile')[mine2].click();
  await flush();
  eq(posts.length, 2, 'bust POST sent');
  eq(posts[1].breakdown.cashedOut, false, 'bust POST cashedOut false');
  ok(mineIdx !== undefined, 'mine index existed');
  eq(errors.length, 0, 'zero page errors (mines)', errors);
  L.dom.window.close();
}

console.log('— memory —');
{
  const L = loadPage('memory.html');
  const { w, errors, posts } = L;
  const hook = w.__doGame;
  const S = hook.state();
  const byType = {};
  S.deck.forEach((t, i) => { (byType[t] = byType[t] || []).push(i); });
  const cards = w.document.querySelectorAll('.card');
  for (const t of Object.keys(byType)) {
    cards[byType[t][0]].click();
    cards[byType[t][1]].click();
  }
  eq(hook.state().pairs, 8, 'all 8 pairs matched');
  eq(hook.state().flips, 16, 'perfect game = 16 flips');
  eq(hook.state().done, true, 'run completed');
  await flush();
  eq(posts.length, 1, 'completion POST sent');
  eq(posts[0].game, 'memory', 'POST game = memory');
  eq(posts[0].breakdown.flips, 16, 'POST flips 16');
  eq(posts[0].breakdown.completed, true, 'POST completed true');
  eq(hook.scoreFor(16, 30000), 179, 'client formula matches server: 100 + 64 + 15 = 179');
  eq(errors.length, 0, 'zero page errors (memory)', errors);
  L.dom.window.close();
}

console.log('— snake —');
{
  const L = loadPage('snake.html');
  const { w, errors, posts } = L;
  const hook = w.__doGame;
  hook.start();
  const G = hook.game;
  // feed 5 cookies straight ahead: the 5th is golden by the spawn rule
  for (let n = 1; n <= 5; n++) {
    G.food = { x: G.snake[0].x + 1, y: G.snake[0].y, golden: n === 5 };
    hook.stepOnce();
  }
  eq(G.regular, 4, '4 regular cookies');
  eq(G.golden, 1, '5th cookie golden');
  eq(G.score, 160, 'score 4×25 + 60 = 160');
  ok(G.golden === Math.floor((G.regular + G.golden) / 5), 'golden invariant holds');
  // run into the right wall
  let guard = 0;
  while (G.state === 'playing' && guard++ < 40) hook.stepOnce();
  eq(G.state, 'over', 'wall ends the run');
  await flush();
  eq(posts.length, 1, 'one score POST');
  eq(posts[0].game, 'snake', 'POST game = snake');
  eq(posts[0].breakdown.regular, 4, 'POST regular 4');
  eq(posts[0].breakdown.golden, 1, 'POST golden 1');
  eq(errors.length, 0, 'zero page errors (snake)', errors);
  L.dom.window.close();
}

console.log('— crossing —');
{
  const L = loadPage('crossing.html');
  const { w, errors, posts } = L;
  const hook = w.__doGame;
  hook.start();
  const G = hook.game;
  G.invuln = 999; // test driver: walk straight up without being flattened
  let guard = 0;
  while (G.crossings < 1 && guard++ < 30) { hook.move(0, -1); hook.step(0.1); }
  eq(G.crossings, 1, 'one crossing banked');
  eq(G.crossings * 50, 50, 'one crossing is worth 50');
  // Get flattened for real: jsdom canvas is clamped to H=320, so
  // zoneH=40, laneH=40 and lane 2 spans y 120-160 (centre 140).
  G.lives = 1; G.invuln = 0;
  const lane = G.lanes[2];
  G.px = lane.obstacles[0].x;
  G.py = 140;
  hook.step(0.016);
  eq(G.state, 'over', 'collision with 1 life left ends the run');
  await flush();
  eq(posts.length, 1, 'game-over POST sent');
  eq(posts[0].game, 'crossing', 'POST game = crossing');
  eq(posts[0].breakdown.crossings, 1, 'POST crossings 1');
  ok(Number.isInteger(posts[0].breakdown.durationMs), 'POST durationMs present');
  eq(errors.length, 0, 'zero page errors (crossing)', errors);
  L.dom.window.close();
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
