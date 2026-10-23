// DO Games — score submission. POST {game, breakdown, initData|guestName}
// Identity is verified first (Telegram HMAC via BOT_TOKEN, else guest
// name); the score is recomputed from the breakdown by the per-game
// contract in _lib.js — a client-sent score is never read.

import {
  resolveIdentity, rateLimit, validateRun, submitRun,
} from './_lib.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'method not allowed' });
      return;
    }
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = null; }
    }
    if (!body || typeof body !== 'object') {
      res.status(400).json({ ok: false, error: 'body must be a JSON object' });
      return;
    }

    const { identity, status, error } = resolveIdentity(body);
    if (!identity) {
      res.status(status).json({ ok: false, error });
      return;
    }

    if (!(await rateLimit(identity.id))) {
      res.status(429).json({ ok: false, error: 'slow down — one score every 10 seconds' });
      return;
    }

    const v = validateRun(body.game, body.breakdown);
    if (v.error) {
      res.status(400).json({ ok: false, error: v.error });
      return;
    }

    const out = await submitRun(identity, body.game, v.score);
    res.status(200).json(out);
  } catch (e) {
    const msg = e && e.message ? e.message : 'server error';
    res.status(500).json({ ok: false, error: msg.startsWith('storage') ? 'leaderboard storage unavailable' : 'server error' });
  }
}
