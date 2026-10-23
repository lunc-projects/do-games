// DO Games — shared API library (storage, identity, scoring contracts).
//
// Mirrors the Bean Catch leaderboard architecture: submissions are only
// accepted after the score is RECOMPUTED server-side from the run
// breakdown and passes plausibility bounds derived from each game's own
// model. Telegram launch data (initData) is verified with the standard
// HMAC check against BOT_TOKEN; without it, players submit under a
// self-chosen guest name and are flagged as guests on the board.
//
// Boards: one COMBINED board per scope. A player's total is the SUM of
// their best single run in each of the 10 games ("DO Points").
// Scopes: all-time and ISO week (resets Monday 00:00 UTC).
//
// Storage: Upstash Redis REST when UPSTASH_REDIS_REST_URL /
// UPSTASH_REDIS_REST_TOKEN are set. When they are absent, an in-memory
// store with identical command semantics is used — DEV ONLY (state dies
// with the process and is not shared between serverless instances).

import { createHmac, timingSafeEqual } from 'node:crypto';

/* ---------------- storage ---------------- */

function storeConfig() {
  const url = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
  const auth = process.env.UPSTASH_REDIS_REST_TOKEN || '';
  return { url, auth, live: !!(url && auth) };
}

/* In-memory fallback (dev only). Implements exactly the command subset
   the boards use, with Redis semantics (incl. ZADD GT and SET NX/EX). */
const mem = {
  zsets: new Map(), hashes: new Map(), strings: new Map(),
};
function memReset() { mem.zsets.clear(); mem.hashes.clear(); mem.strings.clear(); }
function memZset(k) { if (!mem.zsets.has(k)) mem.zsets.set(k, new Map()); return mem.zsets.get(k); }
function memHash(k) { if (!mem.hashes.has(k)) mem.hashes.set(k, new Map()); return mem.hashes.get(k); }
function memExec(cmd) {
  const [op, ...a] = cmd.map(String);
  switch (op) {
    case 'ZADD': {
      let i = 1, gt = false;
      if (a[1] === 'GT') { gt = true; i = 2; }
      const zs = memZset(a[0]); const score = Number(a[i]); const member = a[i + 1];
      const had = zs.has(member);
      if (had && gt && score <= zs.get(member)) return 0;
      zs.set(member, score);
      return had ? 0 : 1;
    }
    case 'ZSCORE': {
      const zs = mem.zsets.get(a[0]);
      return zs && zs.has(a[1]) ? String(zs.get(a[1])) : null;
    }
    case 'ZREVRANK': {
      const zs = mem.zsets.get(a[0]);
      if (!zs || !zs.has(a[1])) return null;
      const sorted = [...zs.entries()].sort((x, y) => y[1] - x[1]);
      return sorted.findIndex(([m]) => m === a[1]);
    }
    case 'ZRANGE': {
      const zs = mem.zsets.get(a[0]);
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
    case 'HSET': {
      const h = memHash(a[0]); const had = h.has(a[1]);
      h.set(a[1], a[2]); return had ? 0 : 1;
    }
    case 'HGET': {
      const h = mem.hashes.get(a[0]);
      return h && h.has(a[1]) ? h.get(a[1]) : null;
    }
    case 'HMGET': {
      const h = mem.hashes.get(a[0]);
      return a.slice(1).map((f) => (h && h.has(f) ? h.get(f) : null));
    }
    case 'SET': {
      const key = a[0];
      const exIdx = a.indexOf('EX');
      const nx = a.includes('NX');
      const cur = mem.strings.get(key);
      const alive = cur && (cur.exp === null || cur.exp > Date.now());
      if (nx && alive) return null;
      mem.strings.set(key, { v: a[1], exp: exIdx >= 0 ? Date.now() + Number(a[exIdx + 1]) * 1000 : null });
      return 'OK';
    }
    default: throw new Error('memory store: unsupported command ' + op);
  }
}

async function redis(cmd) {
  const { url, auth, live } = storeConfig();
  if (!live) return memExec(cmd);
  const r = await fetch(url, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + auth, 'content-type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = await r.json().catch(() => null);
  if (!j || j.error) throw new Error('storage error: ' + ((j && j.error) || ('http ' + r.status)));
  return j.result;
}

async function redisPipe(cmds) {
  const { url, auth, live } = storeConfig();
  if (!live) return cmds.map((c) => memExec(c));
  const r = await fetch(url + '/pipeline', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + auth, 'content-type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  const j = await r.json().catch(() => null);
  if (!Array.isArray(j)) throw new Error('storage error: http ' + r.status);
  return j.map((x) => {
    if (x && x.error) throw new Error('storage error: ' + x.error);
    return x ? x.result : null;
  });
}

/* ---------------- ISO week (mirrors bean-catch) ---------------- */

function isoWeekKey(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;              // Mon = 0
  date.setUTCDate(date.getUTCDate() - dayNum + 3);        // this week's Thursday
  const year = date.getUTCFullYear();
  const first = new Date(Date.UTC(year, 0, 4));
  const firstDay = (first.getUTCDay() + 6) % 7;
  first.setUTCDate(first.getUTCDate() - firstDay + 3);    // first week's Thursday
  const week = 1 + Math.round((date - first) / (7 * 24 * 3600 * 1000));
  return year + '-W' + String(week).padStart(2, '0');
}

function weekResetIso(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 7);        // next Monday 00:00 UTC
  return date.toISOString();
}

/* ---------------- identity (mirrors bean-catch) ---------------- */

function cleanName(raw, maxLen) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[<>&"'`\/\\]/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function validateInitData(initData, botSecret) {
  if (typeof initData !== 'string' || !initData || !botSecret) return null;
  let params;
  try { params = new URLSearchParams(initData); } catch { return null; }
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const pairs = [];
  for (const [k, v] of params.entries()) pairs.push(k + '=' + v);
  pairs.sort();
  const secret = createHmac('sha256', 'WebAppData').update(botSecret).digest();
  const calc = createHmac('sha256', secret).update(pairs.join('\n')).digest('hex');
  const a = Buffer.from(calc, 'utf8');
  const b = Buffer.from(String(hash).toLowerCase(), 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const authDate = parseInt(params.get('auth_date') || '0', 10);
  const now = Math.floor(Date.now() / 1000);
  if (!authDate || now - authDate > 86400 || authDate - now > 300) return null;
  let user = null;
  try { user = JSON.parse(params.get('user') || 'null'); } catch { user = null; }
  if (!user || typeof user.id !== 'number') return null;
  return user;
}

function telegramIdentity(user) {
  let name = cleanName(user.first_name || 'Player', 24) || 'Player';
  if (user.username) name += ' @' + cleanName(user.username, 32);
  else if (user.last_name) name += ' ' + cleanName(user.last_name, 24);
  return { id: 'tg:' + user.id, name: name.slice(0, 40), guest: false };
}

function guestIdentity(rawName) {
  const name = cleanName(rawName, 16);
  if (name.length < 3) return null;
  return { id: 'guest:' + name.toLowerCase(), name, guest: true };
}

/* ---------------- scoring contracts ----------------
   Every validator takes the run breakdown and returns either
   { score } or { error }. The score is ALWAYS recomputed here —
   a client-sent score is never read. */

const GAMES = ['catch', 'wheel', 'rocket', 'slice', 'breakout', 'stack', 'mines', 'memory', 'snake', 'crossing'];

function isCount(n) { return Number.isInteger(n) && n >= 0 && n <= 100000; }
function isDuration(n, max) { return Number.isInteger(n) && n >= 0 && n <= max; }
function needCounts(b, fields) {
  for (const f of fields) if (!isCount(b[f])) return f + ' must be a non-negative integer';
  return null;
}

// Spawn-bound simulator (bean-catch style): interval(t) shrinks from
// `start` to `floor` at rate k per second; gaps use the adversarial
// minimum jitter factor, then a safety margin is applied.
function maxSpawns(durationSec, start, floor, k, gapMin, margin) {
  let spawns = 0, t = 0;
  const dt = 0.05;
  while (t < durationSec) {
    const interval = Math.max(floor, start - k * t);
    spawns += dt / (gapMin * interval);
    t += dt;
  }
  return Math.ceil(spawns * margin);
}

/* 1 — COOKIE CATCH: 60 s runs. Regular +10, golden +30; catching a
   burnt cookie is −15 AND costs a life (3 lives ends the run early).
   Dropping a good cookie costs nothing. Score floored at 0.
   Spawn model (client): interval max(0.38, 0.85 − 0.008·t) s, gap
   jitter U(0.8, 1.2); mix: regular .73 / golden .12 / burnt .15. */
function validateCatch(b) {
  const e = needCounts(b, ['regular', 'golden', 'burnt']);
  if (e) return { error: e };
  if (!isDuration(b.durationMs, 62000)) return { error: 'durationMs out of range' };
  if (b.burnt > 3) return { error: 'more burnt catches than lives' };
  if (b.burnt < 3 && b.durationMs < 50000) return { error: 'run ended early without losing 3 lives' };
  const events = b.regular + b.golden + b.burnt;
  if (b.durationMs < events * 200) return { error: 'catches faster than the game allows' };
  const goodBound = Math.floor(maxSpawns(b.durationMs / 1000, 0.85, 0.38, 0.008, 0.8, 1.15) * 0.85);
  if (b.regular + b.golden > goodBound) return { error: 'more catches than the game can spawn in that time' };
  return { score: Math.max(0, b.regular * 10 + b.golden * 30 - b.burnt * 15) };
}

/* 2 — DO WHEEL: one spin per run. Segments are exactly
   [BUST, 5, 10, BUST, 15, 5, 20, 10]; BUST submits value 0.
   A real spin animates ≥ 3 s; 2.8 s is accepted (timer slack). */
const WHEEL_VALUES = [0, 5, 10, 15, 20];
function validateWheel(b) {
  if (!WHEEL_VALUES.includes(b.value)) return { error: 'value is not a wheel segment' };
  if (!Number.isInteger(b.spinMs) || b.spinMs < 2800 || b.spinMs > 60000) return { error: 'spinMs out of range' };
  return { score: b.value };
}

/* 3 — DO ROCKET: multiplier climbs as mult = e^(0.11·t) from 1.00x.
   Cash out banks floor(10 × mult), capped at 50. A crash submits
   cashedMult 0 and scores 0. Client crash points never exceed 8x. */
const ROCKET_RATE = 0.11;
function validateRocket(b) {
  if (typeof b.cashedMult !== 'number' || !Number.isFinite(b.cashedMult) || b.cashedMult < 0 || b.cashedMult > 8) {
    return { error: 'cashedMult must be between 0 and 8' };
  }
  if (!isDuration(b.durationMs, 180000)) return { error: 'durationMs out of range' };
  if (b.cashedMult === 0) {
    if (b.durationMs < 250) return { error: 'run too short' };
    return { score: 0 };
  }
  if (b.cashedMult < 1) return { error: 'cashedMult below the 1.00x launch value' };
  const minMs = (Math.log(b.cashedMult) / ROCKET_RATE) * 1000;
  if (b.durationMs < minMs * 0.9) return { error: 'multiplier too high for the flight time' };
  return { score: Math.min(50, Math.floor(10 * b.cashedMult)) };
}

/* 4 — COOKIE SLICE: 45 s runs. Cookie +10, golden +30. Slicing a
   burnt bomb is −25 AND a strike; 3 strikes end the run early
   (documented rule — bombs do not end the run outright).
   Spawn model (client): one launch every max(0.42, 0.72 − 0.006·t) s,
   gap jitter U(0.8, 1.25); mix: cookie .78 / golden .10 / bomb .12.
   `sliced` counts regular cookies only; golden is separate. */
function validateSlice(b) {
  const e = needCounts(b, ['sliced', 'golden', 'bombs']);
  if (e) return { error: e };
  if (!isDuration(b.durationMs, 47000)) return { error: 'durationMs out of range' };
  if (b.bombs > 3) return { error: 'more bombs than strikes' };
  if (b.bombs < 3 && b.durationMs < 40000) return { error: 'run ended early without 3 strikes' };
  const events = b.sliced + b.golden + b.bombs;
  if (b.durationMs < events * 180) return { error: 'slices faster than the game allows' };
  const goodBound = Math.floor(maxSpawns(b.durationMs / 1000, 0.72, 0.42, 0.006, 0.8, 1.15) * 0.88);
  if (b.sliced + b.golden > goodBound) return { error: 'more slices than the game can spawn in that time' };
  return { score: Math.max(0, b.sliced * 10 + b.golden * 30 - b.bombs * 25) };
}
/* 5 — DO BREAKOUT: 8 cols × 6 rows of cookie blocks. Tier values by
   row, TOP row first: [15, 12, 10, 8, 6, 5]. Clearing the whole grid
   pays a +50 bonus. 3 balls per run: the run can only end with the
   grid cleared or all 3 balls used. */
const BREAKOUT_TIERS = [15, 12, 10, 8, 6, 5];
const BREAKOUT_COLS = 8;
const BREAKOUT_CLEAR_BONUS = 50;
function validateBreakout(b) {
  if (!Array.isArray(b.blocksByTier) || b.blocksByTier.length !== BREAKOUT_TIERS.length) {
    return { error: 'blocksByTier must have 6 entries' };
  }
  for (const n of b.blocksByTier) {
    if (!isCount(n)) return { error: 'blocksByTier entries must be non-negative integers' };
    if (n > BREAKOUT_COLS) return { error: 'more blocks than a row holds' };
  }
  if (!Number.isInteger(b.ballsUsed) || b.ballsUsed < 1 || b.ballsUsed > 3) return { error: 'ballsUsed must be 1-3' };
  if (!isDuration(b.durationMs, 1800000)) return { error: 'durationMs out of range' };
  const total = b.blocksByTier.reduce((s, n) => s + n, 0);
  if (total < BREAKOUT_TIERS.length * BREAKOUT_COLS && b.ballsUsed < 3) {
    return { error: 'run cannot end with balls remaining and blocks standing' };
  }
  if (b.durationMs < total * 120) return { error: 'blocks cleared faster than the ball can travel' };
  let score = 0;
  b.blocksByTier.forEach((n, i) => { score += n * BREAKOUT_TIERS[i]; });
  if (total === BREAKOUT_TIERS.length * BREAKOUT_COLS) score += BREAKOUT_CLEAR_BONUS;
  return { score };
}

/* 6 — COOKIE STACK: each placed layer +1; a perfect drop (offset
   within max(4px, 5% of current width)) pays +1 bonus AND restores
   width by 8% of the original layer width (capped at the original).
   Score = layers + perfects. A drop cycle — slide across, react,
   tap — cannot beat 300 ms per layer. */
function validateStack(b) {
  const e = needCounts(b, ['layers', 'perfects']);
  if (e) return { error: e };
  if (b.perfects > b.layers) return { error: 'more perfects than layers' };
  if (b.layers > 250) return { error: 'layers beyond the game maximum' };
  if (!isDuration(b.durationMs, 1800000)) return { error: 'durationMs out of range' };
  if (b.durationMs < b.layers * 300) return { error: 'layers stacked faster than the game allows' };
  return { score: b.layers + b.perfects };
}

/* 7 — DO MINES: 5×5 grid, 5 hidden burnt mines, 20 safe tiles.
   Payout curve: the k-th safe tile revealed adds k points, so the
   bank after n safe tiles is n(n+1)/2 (max 210 at 20 tiles).
   Points only count if the player CASHED OUT; a mine scores 0. */
function validateMines(b) {
  const e = needCounts(b, ['safeTiles']);
  if (e) return { error: e };
  if (typeof b.cashedOut !== 'boolean') return { error: 'cashedOut must be a boolean' };
  if (b.safeTiles > 20) return { error: 'more safe tiles than the grid holds' };
  if (!b.cashedOut && b.safeTiles > 19) return { error: 'all safe tiles revealed means the run cashed out' };
  if (!isDuration(b.durationMs, 1800000)) return { error: 'durationMs out of range' };
  if (b.durationMs < b.safeTiles * 150) return { error: 'tiles revealed faster than the game allows' };
  return { score: b.cashedOut ? (b.safeTiles * (b.safeTiles + 1)) / 2 : 0 };
}

/* 8 — COOKIE MEMORY: 4×4 cards, 8 pairs; a "flip" is one card turn,
   so a run has an even flip count and 16 is a perfect game.
   Completed score = 100 base
                   + max(0, 64 − 2·(flips − 16))   efficiency bonus
                   + max(0, 30 − floor(durationMs / 2000))  speed bonus
   → bounded maximum 194. Uncompleted runs score 0. */
function validateMemory(b) {
  const e = needCounts(b, ['flips']);
  if (e) return { error: e };
  if (typeof b.completed !== 'boolean') return { error: 'completed must be a boolean' };
  if (b.flips % 2 !== 0) return { error: 'flips must be even' };
  if (!isDuration(b.durationMs, 1800000)) return { error: 'durationMs out of range' };
  if (!b.completed) return { score: 0 };
  if (b.flips < 16) return { error: 'fewer flips than a perfect game' };
  if (b.flips > 1000) return { error: 'flips beyond the game maximum' };
  if (b.durationMs < Math.max(3000, b.flips * 120)) return { error: 'finished faster than the cards allow' };
  const score = 100
    + Math.max(0, 64 - 2 * (b.flips - 16))
    + Math.max(0, 30 - Math.floor(b.durationMs / 2000));
  return { score };
}

/* 9 — DO SNAKE: cookie +25; every 5th cookie spawned is golden (+60),
   and only one cookie is ever on the field, so golden MUST equal
   floor((regular + golden) / 5) exactly. The snake ticks at most
   every 85 ms and crossing cells takes time — 300 ms per cookie is
   the generous plausibility bound. */
function validateSnake(b) {
  const e = needCounts(b, ['regular', 'golden']);
  if (e) return { error: e };
  if (!isDuration(b.durationMs, 1800000)) return { error: 'durationMs out of range' };
  const total = b.regular + b.golden;
  if (b.golden !== Math.floor(total / 5)) return { error: 'golden count does not match the every-5th-cookie rule' };
  if (b.durationMs < total * 300) return { error: 'cookies eaten faster than the snake can travel' };
  return { score: b.regular * 25 + b.golden * 60 };
}

/* 10 — COOKIE CROSSING: +50 per successful crossing. A crossing means
   traversing 6 moving lanes and cannot take under ~2.5 s. */
const CROSSING_POINTS = 50;
function validateCrossing(b) {
  const e = needCounts(b, ['crossings']);
  if (e) return { error: e };
  if (b.crossings > 300) return { error: 'crossings beyond the game maximum' };
  if (!isDuration(b.durationMs, 3600000)) return { error: 'durationMs out of range' };
  if (b.durationMs < b.crossings * 2500) return { error: 'crossings faster than the floor allows' };
  return { score: b.crossings * CROSSING_POINTS };
}

const VALIDATORS = {
  catch: validateCatch, wheel: validateWheel, rocket: validateRocket,
  slice: validateSlice, breakout: validateBreakout, stack: validateStack,
  mines: validateMines, memory: validateMemory, snake: validateSnake,
  crossing: validateCrossing,
};

function validateRun(game, breakdown) {
  if (!GAMES.includes(game)) return { error: 'unknown game' };
  if (!breakdown || typeof breakdown !== 'object') return { error: 'breakdown is required' };
  return VALIDATORS[game](breakdown);
}

/* ---------------- boards ---------------- */

const K = {
  names: 'dogames:names',
  bestsAll: 'dogames:bests:all',
  bestsWeek: (wk) => 'dogames:bests:week:' + wk,
  lbAll: 'dogames:lb:all',
  lbWeek: (wk) => 'dogames:lb:week:' + wk,
  rl: (id) => 'dogames:rl:' + id,
};

function parseBests(raw) {
  const out = {};
  for (const g of GAMES) out[g] = 0;
  if (raw) {
    try {
      const j = JSON.parse(raw);
      for (const g of GAMES) if (Number.isInteger(j[g]) && j[g] >= 0) out[g] = j[g];
    } catch { /* fall through with zeros */ }
  }
  return out;
}
function totalOf(bests) { return GAMES.reduce((s, g) => s + (bests[g] || 0), 0); }

async function submitRun(identity, game, score) {
  const wk = isoWeekKey(new Date());
  const [rawAll, rawWeek] = await redisPipe([
    ['HGET', K.bestsAll, identity.id],
    ['HGET', K.bestsWeek(wk), identity.id],
  ]);
  const bestsAll = parseBests(rawAll);
  const bestsWeek = parseBests(rawWeek);
  if (score > bestsAll[game]) bestsAll[game] = score;
  if (score > bestsWeek[game]) bestsWeek[game] = score;
  const totalAll = totalOf(bestsAll);
  const totalWeek = totalOf(bestsWeek);
  const nameRec = JSON.stringify({ name: identity.name, guest: identity.guest });
  await redisPipe([
    ['HSET', K.bestsAll, identity.id, JSON.stringify(bestsAll)],
    ['HSET', K.bestsWeek(wk), identity.id, JSON.stringify(bestsWeek)],
    ['ZADD', K.lbAll, 'GT', String(totalAll), identity.id],
    ['ZADD', K.lbWeek(wk), 'GT', String(totalWeek), identity.id],
    ['HSET', K.names, identity.id, nameRec],
  ]);
  const [rankAll, rankWeek] = await redisPipe([
    ['ZREVRANK', K.lbAll, identity.id],
    ['ZREVRANK', K.lbWeek(wk), identity.id],
  ]);
  const rank = (r) => (r === null || r === undefined ? null : Number(r) + 1);
  return {
    ok: true,
    id: identity.id,
    name: identity.name,
    guest: identity.guest,
    game,
    score,
    bestGame: bestsAll[game],
    totalWeek,
    totalAll,
    rankWeek: rank(rankWeek),
    rankAll: rank(rankAll),
  };
}

async function readBoard(scope, wk) {
  const lbKey = scope === 'week' ? K.lbWeek(wk) : K.lbAll;
  const bestsKey = scope === 'week' ? K.bestsWeek(wk) : K.bestsAll;
  const flat = await redis(['ZRANGE', lbKey, '0', '19', 'REV', 'WITHSCORES']);
  const entries = [];
  if (Array.isArray(flat)) {
    for (let i = 0; i + 1 < flat.length; i += 2) {
      entries.push({ id: String(flat[i]), total: Number(flat[i + 1]) });
    }
  }
  if (entries.length) {
    const ids = entries.map((e) => e.id);
    const [names, bests] = await redisPipe([
      ['HMGET', K.names, ...ids],
      ['HMGET', bestsKey, ...ids],
    ]);
    entries.forEach((e, i) => {
      let rec = null;
      try { rec = names && names[i] ? JSON.parse(names[i]) : null; } catch { rec = null; }
      e.name = rec && rec.name ? rec.name : 'Player';
      e.guest = !!(rec && rec.guest);
      e.games = parseBests(bests && bests[i]);
    });
  }
  return entries;
}

async function readBoards() {
  const now = new Date();
  const wk = isoWeekKey(now);
  const [weekly, allTime] = [await readBoard('week', wk), await readBoard('all', wk)];
  return {
    ok: true,
    week: wk,
    resetsAt: weekResetIso(now),
    weekly: { board: 'week', entries: weekly },
    allTime: { board: 'all', entries: allTime },
  };
}

async function rateLimit(id) {
  const r = await redis(['SET', K.rl(id), '1', 'EX', '10', 'NX']);
  return r === 'OK';
}

function resolveIdentity(body) {
  if (body.initData) {
    const user = validateInitData(body.initData, process.env.BOT_TOKEN || '');
    if (!user) return { status: 401, error: 'Telegram sign-in check failed' };
    return { identity: telegramIdentity(user) };
  }
  const identity = guestIdentity(body.guestName);
  if (!identity) return { status: 400, error: 'guest name must be 3-16 characters' };
  return { identity };
}

export {
  GAMES, WHEEL_VALUES, BREAKOUT_TIERS, CROSSING_POINTS,
  isoWeekKey, weekResetIso, cleanName, validateInitData,
  telegramIdentity, guestIdentity, validateRun, submitRun,
  readBoards, rateLimit, resolveIdentity, maxSpawns, storeConfig,
};

export const _internals = {
  validateCatch, validateWheel, validateRocket, validateSlice,
  validateBreakout, validateStack, validateMines, validateMemory,
  validateSnake, validateCrossing, parseBests, totalOf, memReset,
};
