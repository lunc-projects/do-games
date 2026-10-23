// API tests for DO Games — in-memory fake of the Upstash REST endpoint
// (fetch is intercepted) plus a section for the dev-only in-memory
// fallback store. No live services involved.
// Run: node ~/workspace/do-games/tests/api.test.mjs

import { createHmac } from 'node:crypto';

let passed = 0, failed = 0;
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.log('  FAIL ' + label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
}
function eq(a, b, label) { ok(a === b, label + ' (want ' + JSON.stringify(b) + ', got ' + JSON.stringify(a) + ')'); }

/* ---------------- fake Redis over REST (mirrors bean-catch) ---------------- */
class FakeRedis {
  constructor() { this.zsets = new Map(); this.hashes = new Map(); this.strings = new Map(); this.offsetMs = 0; }
  now() { return Date.now() + this.offsetMs; }
  advance(sec) { this.offsetMs += sec * 1000; }
  zset(k) { if (!this.zsets.has(k)) this.zsets.set(k, new Map()); return this.zsets.get(k); }
  hash(k) { if (!this.hashes.has(k)) this.hashes.set(k, new Map()); return this.hashes.get(k); }
  exec(cmd) {
    const [op, ...a] = cmd.map(String);
    switch (op) {
      case 'ZADD': {
        let i = 1, gt = false;
        if (a[1] === 'GT') { gt = true; i = 2; }
        const zs = this.zset(a[0]); const score = Number(a[i]); const member = a[i + 1];
        const had = zs.has(member);
        if (had && gt && score <= zs.get(member)) return 0;
        zs.set(member, score);
        return had ? 0 : 1;
      }
      case 'ZSCORE': {
        const zs = this.zsets.get(a[0]);
        return zs && zs.has(a[1]) ? String(zs.get(a[1])) : null;
      }
      case 'ZREVRANK': {
        const zs = this.zsets.get(a[0]);
        if (!zs || !zs.has(a[1])) return null;
        const sorted = [...zs.entries()].sort((x, y) => y[1] - x[1]);
        return sorted.findIndex(([m]) => m === a[1]);
      }
      case 'ZRANGE': {
        const zs = this.zsets.get(a[0]);
        if (!zs) return [];
        let entries = [...zs.entries()].sort((x, y) => x[1] - y[1]);
        const rest = a.slice(3);
        if (rest.includes('REV')) entries.reverse();
        let start = Number(a[1]), stop = Number(a[2]);
        if (stop < 0) stop = entries.length + stop;
        const slice = entries.slice(start, stop + 1);
        if (rest.includes('WITHSCORES')) {
          const out = [];
          for (const [m, s] of slice) out.push(m, String(s));
          return out;
        }
        return slice.map(([m]) => m);
      }
      case 'HSET': { const h = this.hash(a[0]); const had = h.has(a[1]); h.set(a[1], a[2]); return had ? 0 : 1; }
      case 'HGET': { const h = this.hashes.get(a[0]); return h && h.has(a[1]) ? h.get(a[1]) : null; }
      case 'HMGET': { const h = this.hashes.get(a[0]); return a.slice(1).map((f) => (h && h.has(f) ? h.get(f) : null)); }
      case 'SET': {
        const key = a[0];
        const exIdx = a.indexOf('EX');
        const nx = a.includes('NX');
        const cur = this.strings.get(key);
        const alive = cur && (cur.exp === null || cur.exp > this.now());
        if (nx && alive) return null;
        this.strings.set(key, { v: a[1], exp: exIdx >= 0 ? this.now() + Number(a[exIdx + 1]) * 1000 : null });
        return 'OK';
      }
      default: throw new Error('fake: unsupported command ' + op);
    }
  }
}

const fake = new FakeRedis();
const FAKE_URL = 'https://fake.upstash.local';
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (!u.startsWith(FAKE_URL)) throw new Error('unexpected fetch to ' + u);
  const body = JSON.parse(opts.body);
  if (u.endsWith('/pipeline')) {
    return { ok: true, status: 200, json: async () => body.map((cmd) => ({ result: fake.exec(cmd) })) };
  }
  return { ok: true, status: 200, json: async () => ({ result: fake.exec(body) }) };
};

process.env.UPSTASH_REDIS_REST_URL = FAKE_URL;
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-rest-secret';
const TEST_BOT = '222222:TEST-BOT-SECRET';
process.env.BOT_TOKEN = TEST_BOT;

const { default: submitHandler } = await import('../api/submit.js');
const { default: leaderboardHandler } = await import('../api/leaderboard.js');
const lib = await import('../api/_lib.js');
const X = lib._internals;

/* ---------------- req/res mocks ---------------- */
function mockRes() {
  return {
    statusCode: 0, payload: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.payload = o; return this; },
  };
}
async function post(body) {
  const res = mockRes();
  await submitHandler({ method: 'POST', url: '/api/submit', body }, res);
  return res;
}
async function boards() {
  const res = mockRes();
  await leaderboardHandler({ method: 'GET', url: '/api/leaderboard' }, res);
  return res.payload;
}

/* ---------------- initData crafting (per Telegram docs) ---------------- */
function makeInitData(userObj, opts = {}) {
  const params = new URLSearchParams();
  params.set('query_id', 'AAE1test');
  params.set('user', JSON.stringify(userObj));
  params.set('auth_date', String(opts.authDate ?? Math.floor(Date.now() / 1000)));
  const pairs = [];
  for (const [k, v] of params.entries()) pairs.push(k + '=' + v);
  pairs.sort();
  const secret = createHmac('sha256', 'WebAppData').update(TEST_BOT).digest();
  let hash = createHmac('sha256', secret).update(pairs.join('\n')).digest('hex');
  if (opts.tamperHash) hash = (hash[0] === 'a' ? 'b' : 'a') + hash.slice(1);
  params.set('hash', hash);
  if (opts.tamperUser) {
    const u = JSON.parse(params.get('user'));
    u.first_name = 'Mallory';
    params.set('user', JSON.stringify(u));
  }
  return params.toString();
}
const ADA = { id: 42, first_name: 'Ada', username: 'ada' };
const adaInit = () => makeInitData(ADA);

console.log('— model sanity —');
eq(lib.isoWeekKey(new Date('2026-10-19T12:00:00Z')), '2026-W43', 'ISO week of Mon 2026-10-19');
eq(lib.isoWeekKey(new Date('2026-10-26T12:00:00Z')), '2026-W44', 'ISO week of Mon 2026-10-26');
ok(lib.maxSpawns(60, 0.85, 0.38, 0.008, 0.8, 1.15) > 100, 'catch spawn bound sane for 60s');

console.log('— catch: telegram submit + combined board —');
{
  const res = await post({ initData: adaInit(), game: 'catch', breakdown: { regular: 40, golden: 8, burnt: 2, durationMs: 60000 } });
  eq(res.statusCode, 200, 'valid catch accepted');
  eq(res.payload.score, 610, 'catch recomputed: 40*10 + 8*30 − 2*15 = 610');
  eq(res.payload.guest, false, 'telegram player not guest');
  eq(res.payload.name, 'Ada @ada', 'verified name used');
  eq(res.payload.totalAll, 610, 'combined total = catch only');
  eq(res.payload.rankAll, 1, 'rank 1 all time');
  const b = await boards();
  eq(b.weekly.entries.length, 1, 'weekly board has Ada');
  eq(b.weekly.entries[0].total, 610, 'weekly total 610');
  eq(b.weekly.entries[0].games.catch, 610, 'per-game breakdown attached');
  eq(b.allTime.entries[0].total, 610, 'all-time total 610');
  ok(/^\d{4}-W\d{2}$/.test(b.week), 'week key format');
  ok(typeof b.resetsAt === 'string' && b.resetsAt.endsWith('T00:00:00.000Z'), 'resetsAt is a Monday 00:00 UTC');
}

console.log('— combined totals across games + best-only —');
{
  fake.advance(11);
  const w = await post({ initData: adaInit(), game: 'wheel', breakdown: { value: 20, spinMs: 3100 } });
  eq(w.payload.score, 20, 'wheel 20');
  eq(w.payload.totalAll, 630, 'combined total = 610 + 20');
  fake.advance(11);
  const lower = await post({ initData: adaInit(), game: 'catch', breakdown: { regular: 10, golden: 0, burnt: 3, durationMs: 30000 } });
  eq(lower.statusCode, 200, 'lower catch still accepted');
  eq(lower.payload.score, 55, 'lower catch recomputed: 100 − 45 = 55');
  eq(lower.payload.bestGame, 610, 'best kept at 610');
  eq(lower.payload.totalAll, 630, 'total unchanged by lower run');
}

console.log('— identity attacks —');
{
  const b = { regular: 1, golden: 0, burnt: 3, durationMs: 20000 };
  const t1 = await post({ initData: makeInitData(ADA, { tamperUser: true }), game: 'catch', breakdown: b });
  eq(t1.statusCode, 401, 'tampered user rejected');
  const t2 = await post({ initData: makeInitData(ADA, { tamperHash: true }), game: 'catch', breakdown: b });
  eq(t2.statusCode, 401, 'bad hash rejected');
  const t3 = await post({ initData: makeInitData(ADA, { authDate: Math.floor(Date.now() / 1000) - 90000 }), game: 'catch', breakdown: b });
  eq(t3.statusCode, 401, 'stale auth_date rejected');
  fake.advance(11); // step out of Ada's rate-limit window from the previous block
  const t4 = await post({ initData: adaInit(), guestName: 'ForgedName', game: 'wheel', breakdown: { value: 5, spinMs: 3000 } });
  eq(t4.payload.name, 'Ada @ada', 'client-sent guestName ignored when initData present');
}

console.log('— wheel —');
{
  const g = await post({ guestName: 'Wendy', game: 'wheel', breakdown: { value: 20, spinMs: 3400 } });
  eq(g.statusCode, 200, 'guest wheel accepted');
  eq(g.payload.guest, true, 'guest flagged');
  const bust = await post({ guestName: 'Wanda', game: 'wheel', breakdown: { value: 0, spinMs: 2900 } });
  eq(bust.payload.score, 0, 'BUST submits as 0');
  const badVal = await post({ guestName: 'Will', game: 'wheel', breakdown: { value: 25, spinMs: 3400 } });
  eq(badVal.statusCode, 400, 'value 25 (not a segment) rejected');
  const fast = await post({ guestName: 'Walt', game: 'wheel', breakdown: { value: 20, spinMs: 1500 } });
  eq(fast.statusCode, 400, 'spin under 2.8s rejected');
}

console.log('— rocket —');
{
  // ln(3.42)/0.11 ≈ 11.17s → 11200ms is just enough
  const r = await post({ guestName: 'Rita', game: 'rocket', breakdown: { cashedMult: 3.42, durationMs: 11200 } });
  eq(r.statusCode, 200, 'valid cash-out accepted');
  eq(r.payload.score, 34, 'floor(10 × 3.42) = 34');
  const crash = await post({ guestName: 'Rex', game: 'rocket', breakdown: { cashedMult: 0, durationMs: 4000 } });
  eq(crash.statusCode, 200, 'crash submit accepted');
  eq(crash.payload.score, 0, 'crash scores 0');
  const over = await post({ guestName: 'Rogue', game: 'rocket', breakdown: { cashedMult: 9, durationMs: 60000 } });
  eq(over.statusCode, 400, 'mult above 8 rejected');
  const fast = await post({ guestName: 'Rush', game: 'rocket', breakdown: { cashedMult: 7, durationMs: 2000 } });
  eq(fast.statusCode, 400, '7x in 2s rejected (growth-curve bound)');
  const under = await post({ guestName: 'Runt', game: 'rocket', breakdown: { cashedMult: 0.5, durationMs: 3000 } });
  eq(under.statusCode, 400, 'mult below 1.00 (nonzero) rejected');
}

console.log('— catch forgeries —');
{
  const greedy = await post({ guestName: 'Greedy', game: 'catch', breakdown: { regular: 400, golden: 0, burnt: 0, durationMs: 60000 } });
  eq(greedy.statusCode, 400, '400 catches in 60s rejected');
  const lives = await post({ guestName: 'Liv', game: 'catch', breakdown: { regular: 0, golden: 0, burnt: 4, durationMs: 60000 } });
  eq(lives.statusCode, 400, '4 burnt catches (only 3 lives) rejected');
  const early = await post({ guestName: 'Early', game: 'catch', breakdown: { regular: 20, golden: 0, burnt: 1, durationMs: 30000 } });
  eq(early.statusCode, 400, 'run ending at 30s with lives left rejected');
}

console.log('— slice —');
{
  const s = await post({ guestName: 'Sue', game: 'slice', breakdown: { sliced: 30, golden: 3, bombs: 1, durationMs: 45000 } });
  eq(s.statusCode, 200, 'valid slice accepted');
  eq(s.payload.score, 365, 'slice recomputed: 300 + 90 − 25 = 365');
  const bombs = await post({ guestName: 'Sid', game: 'slice', breakdown: { sliced: 5, golden: 0, bombs: 4, durationMs: 45000 } });
  eq(bombs.statusCode, 400, '4 bombs (only 3 strikes) rejected');
  const many = await post({ guestName: 'Sal', game: 'slice', breakdown: { sliced: 300, golden: 0, bombs: 0, durationMs: 45000 } });
  eq(many.statusCode, 400, '300 slices in 45s rejected (spawn bound)');
}

console.log('— breakout —');
{
  const full = await post({ guestName: 'Bea', game: 'breakout', breakdown: { blocksByTier: [8, 8, 8, 8, 8, 8], ballsUsed: 2, durationMs: 180000 } });
  eq(full.statusCode, 200, 'full clear accepted');
  eq(full.payload.score, 498, 'breakout recomputed: 8×56 + 50 bonus = 498');
  const tier9 = await post({ guestName: 'Bob', game: 'breakout', breakdown: { blocksByTier: [9, 0, 0, 0, 0, 0], ballsUsed: 3, durationMs: 60000 } });
  eq(tier9.statusCode, 400, '9 blocks in an 8-wide row rejected');
  const early = await post({ guestName: 'Ben', game: 'breakout', breakdown: { blocksByTier: [4, 0, 0, 0, 0, 0], ballsUsed: 1, durationMs: 60000 } });
  eq(early.statusCode, 400, 'run ending with balls left and blocks standing rejected');
  const partial = await post({ guestName: 'Bree', game: 'breakout', breakdown: { blocksByTier: [8, 8, 0, 0, 0, 0], ballsUsed: 3, durationMs: 90000 } });
  eq(partial.payload.score, 216, 'partial: 8×15 + 8×12 = 216, no bonus');
}

console.log('— stack —');
{
  const s = await post({ guestName: 'Stu', game: 'stack', breakdown: { layers: 20, perfects: 5, durationMs: 30000 } });
  eq(s.statusCode, 200, 'valid stack accepted');
  eq(s.payload.score, 25, 'stack recomputed: 20 + 5 = 25');
  const pf = await post({ guestName: 'Sue2', game: 'stack', breakdown: { layers: 5, perfects: 6, durationMs: 30000 } });
  eq(pf.statusCode, 400, 'more perfects than layers rejected');
  const fast = await post({ guestName: 'Swift', game: 'stack', breakdown: { layers: 50, perfects: 0, durationMs: 5000 } });
  eq(fast.statusCode, 400, '50 layers in 5s rejected (300ms/drop bound)');
}

console.log('— mines —');
{
  const cash = await post({ guestName: 'Mia', game: 'mines', breakdown: { safeTiles: 10, cashedOut: true, durationMs: 20000 } });
  eq(cash.statusCode, 200, 'valid cash-out accepted');
  eq(cash.payload.score, 55, 'mines bank: 10×11/2 = 55');
  const bust = await post({ guestName: 'Max', game: 'mines', breakdown: { safeTiles: 10, cashedOut: false, durationMs: 20000 } });
  eq(bust.statusCode, 200, 'bust submit accepted');
  eq(bust.payload.score, 0, 'bust scores 0 even with 10 safe tiles');
  const over = await post({ guestName: 'Mel', game: 'mines', breakdown: { safeTiles: 21, cashedOut: true, durationMs: 30000 } });
  eq(over.statusCode, 400, '21 safe tiles (grid holds 20) rejected');
  const lie = await post({ guestName: 'Moe', game: 'mines', breakdown: { safeTiles: 20, cashedOut: false, durationMs: 30000 } });
  eq(lie.statusCode, 400, 'all 20 safe but "not cashed out" rejected');
}

console.log('— memory —');
{
  const m = await post({ guestName: 'Nia', game: 'memory', breakdown: { flips: 16, durationMs: 30000, completed: true } });
  eq(m.statusCode, 200, 'perfect memory game accepted');
  eq(m.payload.score, 179, 'memory recomputed: 100 + 64 + 15 = 179');
  const few = await post({ guestName: 'Ned', game: 'memory', breakdown: { flips: 14, durationMs: 30000, completed: true } });
  eq(few.statusCode, 400, 'fewer flips than a perfect game rejected');
  const odd = await post({ guestName: 'Nan', game: 'memory', breakdown: { flips: 17, durationMs: 30000, completed: true } });
  eq(odd.statusCode, 400, 'odd flips rejected');
  const fast = await post({ guestName: 'Neo', game: 'memory', breakdown: { flips: 16, durationMs: 2500, completed: true } });
  eq(fast.statusCode, 400, 'completion in 2.5s rejected');
  const quit = await post({ guestName: 'Nia2', game: 'memory', breakdown: { flips: 10, durationMs: 20000, completed: false } });
  eq(quit.payload.score, 0, 'uncompleted run scores 0');
}

console.log('— snake —');
{
  const s = await post({ guestName: 'Sly', game: 'snake', breakdown: { regular: 8, golden: 2, durationMs: 20000 } });
  eq(s.statusCode, 200, 'valid snake accepted');
  eq(s.payload.score, 320, 'snake recomputed: 8×25 + 2×60 = 320');
  const bad = await post({ guestName: 'Sneak', game: 'snake', breakdown: { regular: 7, golden: 2, durationMs: 20000 } });
  eq(bad.statusCode, 400, 'golden count violating every-5th rule rejected');
  const fast = await post({ guestName: 'Speedy', game: 'snake', breakdown: { regular: 40, golden: 10, durationMs: 5000 } });
  eq(fast.statusCode, 400, '50 cookies in 5s rejected (travel bound)');
}

console.log('— crossing —');
{
  const c = await post({ guestName: 'Cleo', game: 'crossing', breakdown: { crossings: 4, durationMs: 30000 } });
  eq(c.statusCode, 200, 'valid crossing accepted');
  eq(c.payload.score, 200, 'crossing recomputed: 4 × 50 = 200');
  const fast = await post({ guestName: 'Crash', game: 'crossing', breakdown: { crossings: 20, durationMs: 10000 } });
  eq(fast.statusCode, 400, '20 crossings in 10s rejected (2.5s/crossing bound)');
}

console.log('— misc guards —');
{
  const unk = await post({ guestName: 'Uma', game: 'pong', breakdown: {} });
  eq(unk.statusCode, 400, 'unknown game rejected');
  const noName = await post({ game: 'wheel', breakdown: { value: 5, spinMs: 3000 } });
  eq(noName.statusCode, 400, 'no identity at all rejected');
  const shortName = await post({ guestName: 'ab', game: 'wheel', breakdown: { value: 5, spinMs: 3000 } });
  eq(shortName.statusCode, 400, 'too-short guest name rejected');
}

console.log('— rate limit —');
{
  const b = await boards();
  const n0 = b.allTime.entries.length;
  const r1 = await post({ guestName: 'Rita2', game: 'wheel', breakdown: { value: 5, spinMs: 3000 } });
  eq(r1.statusCode, 200, 'first submit ok');
  const r2 = await post({ guestName: 'Rita2', game: 'wheel', breakdown: { value: 10, spinMs: 3000 } });
  eq(r2.statusCode, 429, 'second submit within 10s rate-limited');
  fake.advance(11);
  const r3 = await post({ guestName: 'Rita2', game: 'wheel', breakdown: { value: 10, spinMs: 3000 } });
  eq(r3.statusCode, 200, 'submit allowed after 11s');
  const b2 = await boards();
  ok(b2.allTime.entries.length >= n0, 'board still readable');
}

console.log('— in-memory fallback store (no Upstash env) —');
{
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  X.memReset();
  const r = await post({ guestName: 'Memmy', game: 'rocket', breakdown: { cashedMult: 2, durationMs: 7000 } });
  eq(r.statusCode, 200, 'memory store accepts submit');
  eq(r.payload.score, 20, 'memory store recomputes (floor(10×2) = 20)');
  const b = await boards();
  const mem = b.allTime.entries.find((e) => e.id === 'guest:memmy');
  ok(!!mem && mem.total === 20 && mem.games.rocket === 20, 'memory store board shows the entry', b.allTime.entries);
  const c = await post({ guestName: 'Memmy2', game: 'catch', breakdown: { regular: 999, golden: 0, burnt: 0, durationMs: 60000 } });
  eq(c.statusCode, 400, 'memory store still rejects forged scores');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
