# DO Games — build notes

A Telegram mini-app games hub for the DO Chain assistant bot
(@Dochainassistancebot): ten small cookie-themed games, one combined
leaderboard. Modeled directly on the in-house Bean Catch architecture
(server-recomputed scores, Telegram initData HMAC verification, Upstash
Redis REST boards, ISO-week resets). **Bragging rights only — no crypto,
no token prizes, no wallet anything, anywhere in the app.**

Theme: DO Chain purple + warm cookie-brown. Everything is drawn with
CSS/canvas shapes — no external assets, no webfonts, no emoji. The only
external script is Telegram's own `telegram-web-app.js`.

## File map

| File | What it is |
|---|---|
| `index.html` | Lobby: identity chip, 10 game cards, combined leaderboard (Weekly / All-Time tabs) |
| `catch.html` | 1 — Cookie Catch (canvas) |
| `wheel.html` | 2 — DO Wheel (canvas) |
| `rocket.html` | 3 — DO Rocket (canvas) |
| `slice.html` | 4 — Cookie Slice (canvas) |
| `breakout.html` | 5 — DO Breakout (canvas) |
| `stack.html` | 6 — Cookie Stack (canvas) |
| `mines.html` | 7 — DO Mines (DOM grid) |
| `memory.html` | 8 — Cookie Memory (DOM cards) |
| `snake.html` | 9 — DO Snake (canvas) |
| `crossing.html` | 10 — Cookie Crossing (canvas) |
| `common.css` | Shared theme, HUD, overlays, leaderboard styles |
| `common.js` | Telegram bootstrap (WebApp initData, hash fallback), identity, guest-name prompt (once, localStorage `doGamesName`), `submitRun()`, per-game local bests (`doGamesBest:<game>`) |
| `api/submit.js` | `POST /api/submit` — identity → rate limit → validate → store |
| `api/leaderboard.js` | `GET /api/leaderboard` — both boards in one response |
| `api/_lib.js` | Storage, identity, all 10 scoring contracts, boards (not a route) |
| `tests/api.test.mjs` | API tests (fake Upstash REST + memory-fallback section) |
| `tests/pages.test.mjs` | jsdom page tests (lobby + all 10 games) |
| `package.json` | `"type": "module"` so Vercel runs the API files as ESM |

Each game page exposes a `window.__doGame` debug/testing hook, the
Bean Catch pattern.

## Combined leaderboard

A player's **DO Points** total = the **sum of their best single run in
each of the 10 games**. Two scopes: all-time and ISO week (resets
**Monday 00:00 UTC**, Bean Catch's `isoWeekKey` logic verbatim). Top 20
per board; each entry carries the per-game bests so the lobby can show
the breakdown. Names come from the verified Telegram user
(`First @username`) when initData is present; guests are self-named and
flagged `guest` on the board — never let a client-supplied name through
when initData exists (the server ignores `guestName` in that case).

`GET /api/leaderboard` response: `{ ok, week, resetsAt, weekly:
{ entries }, allTime: { entries } }`, entries
`{ id, name, guest, total, games: {catch, wheel, …} }`.

`POST /api/submit` body: `{ game, breakdown, initData | guestName }`.
Response: `{ ok, id, name, guest, game, score, bestGame, totalWeek,
totalAll, rankWeek, rankAll }`. One submit per identity per 10 s (429).

## Scoring contracts (server recomputes everything)

The client never sends a score; it sends a breakdown. The server
recomputes the score from the breakdown and rejects anything the game
itself couldn't have produced.

1. **Cookie Catch** — `{regular, golden, burnt, durationMs}`.
   Score = `max(0, regular·10 + golden·30 − burnt·15)`. 60 s runs;
   catching a burnt cookie is −15 **and** a life (3 lives end the run
   early, so `burnt ≤ 3`, and `burnt < 3` requires a ~full-length run).
   Dropping a good cookie costs nothing (documented judgment call).
   Plausibility: spawn simulator over the client's model (interval
   `max(0.38, 0.85 − 0.008t)` s, adversarial gap factor 0.8, margin
   1.15, good fraction 0.85) bounds regular+golden; events also capped
   at one per 200 ms.
2. **DO Wheel** — `{value, spinMs}`. Segments exactly
   `[BUST, 5, 10, BUST, 15, 5, 20, 10]`; BUST submits `value: 0`.
   Server accepts only `value ∈ {0,5,10,15,20}` and `spinMs ≥ 2800`
   (client animates 3.2–3.7 s). Score = value.
3. **DO Rocket** — `{cashedMult, durationMs}`.
   Score = `min(50, floor(10 · cashedMult))`; `cashedMult: 0` means
   crashed → 0. Rejects `cashedMult > 8` (client crash cap) and any
   multiplier the growth curve `mult = e^(0.11t)` couldn't have
   reached in `durationMs` (10% tolerance). Non-zero mult below the
   1.00x launch value is rejected.
4. **Cookie Slice** — `{sliced, golden, bombs, durationMs}` (`sliced` =
   regular cookies only). Score =
   `max(0, sliced·10 + golden·30 − bombs·25)`. **Documented rule:**
   slicing a burnt bomb is −25 **and a strike**; 3 strikes end the run
   (bombs do not end the run outright). 45 s runs; same spawn-bound
   method as Catch (interval `max(0.42, 0.72 − 0.006t)`, good
   fraction 0.88).
5. **DO Breakout** — `{blocksByTier, ballsUsed, durationMs}`.
   8 cols × 6 rows; tier values top row first **[15, 12, 10, 8, 6,
   5]**; clearing all 48 pays **+50**. Server rejects any tier count
   > 8, and any run that ends with blocks standing but `ballsUsed < 3`
   (3 balls per run). Duration ≥ 120 ms per block.
6. **Cookie Stack** — `{layers, perfects, durationMs}`. Score =
   `layers + perfects`. Perfect-drop rule (exact): offset within
   `max(4px, 5% of current width)` → +1 bonus point, layer snaps
   aligned, and width restores by **8% of the original layer width**
   (capped at the original). `perfects ≤ layers`; ≥ 300 ms per drop.
7. **DO Mines** — `{safeTiles, cashedOut, durationMs}`. 5×5 grid,
   5 mines, 20 safe tiles. **Payout curve:** the k-th safe tile adds
   k points → bank(n) = `n(n+1)/2`, max **210**. Score is the bank
   **only if `cashedOut` is true**, else 0. Rejects `safeTiles > 20`
   and the impossible `safeTiles = 20, cashedOut = false` (revealing
   every safe tile auto-cashes in the client).
8. **Cookie Memory** — `{flips, durationMs, completed}`. Only
   completed runs score: `100 + max(0, 64 − 2·(flips − 16)) +
   max(0, 30 − floor(durationMs/2000))`, bounded max **194**
   (16 flips = perfect game). Rejects odd flips, `flips < 16`, and
   completions faster than 120 ms/flip or under 3 s.
9. **DO Snake** — `{regular, golden, durationMs}`. Score =
   `regular·25 + golden·60`. Strong invariant: with one cookie on the
   field at a time and every 5th spawn golden, `golden` must equal
   `floor((regular + golden)/5)` exactly. Totals bounded at
   300 ms per cookie.
10. **Cookie Crossing** — `{crossings, durationMs}`. Score =
    `crossings × 50` (the rate the owner set). Crossings bounded at
    one per 2.5 s; the client speeds lanes up ×1.12 per crossing.

## Env vars needed at deploy

| Var | Where | Notes |
|---|---|---|
| `BOT_TOKEN` | Vercel project env | The **@Dochainassistancebot** token — used only as the initData HMAC secret. Never shipped to the client. |
| `UPSTASH_REDIS_REST_URL` | Vercel project env | Upstash Redis REST endpoint |
| `UPSTASH_REDIS_REST_TOKEN` | Vercel project env | Upstash Redis REST token |

If the Upstash vars are absent the API falls back to an **in-memory
store (dev only)** — fine for local tests, wrong for production
(serverless instances don't share memory).

## Redis key layout (all prefixed `dogames:`)

- `dogames:names` — hash: player id → JSON `{name, guest}`
- `dogames:bests:all` — hash: player id → JSON per-game all-time bests
- `dogames:bests:week:<YYYY-Www>` — hash: same, current ISO week
- `dogames:lb:all` — sorted set: player id → combined all-time total
- `dogames:lb:week:<YYYY-Www>` — sorted set: player id → combined weekly total
- `dogames:rl:<player id>` — rate-limit string, `SET … EX 10 NX`

Player ids: `tg:<telegram user id>` or `guest:<lowercased name>`.
Old weekly keys are simply never read again after the week rolls.

## What was verified (2026-10-23, local)

- **Syntax**: `node --check` on all API/common JS and every inline
  page script — clean.
- **API tests** (`tests/api.test.mjs`, Bean Catch pattern: fake
  Upstash REST via fetch interception, self-signed initData):
  **83/83 pass.** Covers every game — valid submits recomputed
  exactly; forged submits rejected (inflated catch/slice counts vs
  spawn bound, wheel non-segment value, rocket mult > 8 and
  too-fast-for-curve, breakout tier overflow and early-end, stack
  perfects > layers and too-fast, mines 21 tiles and
  cleared-but-not-cashed lie, memory flips < 16 / odd / too fast,
  snake every-5th invariant violation and too-fast, crossing
  too-fast); tampered/stale/bad-hash initData → 401; client-sent
  name ignored when initData present; guest submits accepted and
  flagged; combined totals sum across games; best-only semantics;
  10 s rate limit (429 then success after the window); the
  in-memory fallback store accepts, recomputes, boards, and still
  rejects forgeries.
- **Page tests** (`tests/pages.test.mjs`, jsdom — Bean Catch's method,
  canvas stubbed, rAF on a fake clock): **96/96 pass.** Lobby renders
  10 cards, both board tabs, per-game breakdown lines, guest tags,
  Telegram own-row highlighting. Every game boots with zero page
  errors and is driven through real play in the harness (catches incl.
  the 3-burnt ending, a full wheel spin whose landed index matches
  the final rotation and whose `spinMs` clears 2800, rocket cash-out
  consistent with the growth curve, slice + bomb strike math,
  breakout top-row block = 15, stack partial/perfect/miss sequence
  with the exact submitted breakdown, mines cash-out and bust POSTs,
  a perfect 16-flip memory game scoring 179 by the shared formula,
  snake golden invariant and wall ending, crossing bank + fatal
  collision). Every game's POST body was captured and shape-checked.
- **Real HTTP end-to-end**: the actual handlers mounted behind a
  Vercel-style shim on a local server (in-memory store): lobby served
  200; guest catch accepted with server-recomputed 245; a forged
  catch returned 400; a second game for the same guest produced the
  combined leaderboard total 300 with the per-game breakdown.
- **Screenshots** (headless Chrome, 420×900, local server): lobby,
  Cookie Catch menu, and DO Mines board all render as designed —
  purple + cookie-brown, CSS-drawn icons, no missing assets.

## Judgment calls (also flagged inline in the code)

- Catch: dropping a good cookie costs nothing — only burnt catches
  cost a life. Keeps 60 s runs the norm and the contract simple.
- Slice bomb rule: −25 and a strike, 3 strikes end the run (the
  gentler of the two options the owner offered).
- Memory runs only submit on completion (an abandoned board sends
  nothing); the server still accepts `completed: false` at score 0
  for uniformity with mines busts / rocket crashes, which *do*
  submit their zeros.
- Duration clocks: canvas games submit *game time* (accumulated
  frame dt) as `durationMs`, so a backgrounded tab can't inflate a
  duration past the contract caps; DOM games (mines, memory) use
  wall-clock time since they're event-driven.

## Open items (outside this build)

- Create the Vercel project (static root = this directory, `api/`
  functions automatic) and the GitHub repo; set the three env vars.
- Create an Upstash Redis database and copy its REST URL/token in.
- Point the DO bot at it: a `/games` command in
  `~/workspace/do-chain-assistant-bot` (menu button / web_app reply
  with this app's URL) — not part of this build and that repo was
  not touched.
- First real-device pass inside Telegram (iOS + Android webviews)
  after deploy, especially swipe gestures in Slice/Snake/Crossing.
