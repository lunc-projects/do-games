// DO Games — combined leaderboard. GET returns both boards:
// weekly (resets Monday 00:00 UTC) and all-time, top 20 each, where a
// player's total is the sum of their best run in each of the 10 games.

import { readBoards } from './_lib.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      res.status(405).json({ ok: false, error: 'method not allowed' });
      return;
    }
    const out = await readBoards();
    res.status(200).json(out);
  } catch (e) {
    const msg = e && e.message ? e.message : 'server error';
    res.status(500).json({ ok: false, error: msg.startsWith('storage') ? 'leaderboard storage unavailable' : 'server error' });
  }
}
