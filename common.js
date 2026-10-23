/* DO Games — shared client helpers: Telegram bootstrap, identity,
   score submission, guest-name prompt, per-game local bests.
   The server verifies everything; this file only carries data. */
(function () {
  'use strict';

  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { } }

  /* ---- Telegram WebApp bootstrap ---- */
  var TG = (window.Telegram && window.Telegram.WebApp) || null;
  var INIT_DATA = null, TG_USER = null;
  if (TG) {
    try { TG.ready(); TG.expand(); } catch (e) { }
    if (TG.initData) INIT_DATA = TG.initData;
    if (TG.initDataUnsafe && TG.initDataUnsafe.user) TG_USER = TG.initDataUnsafe.user;
  }
  if (!INIT_DATA) {
    // Fallback: launch data also arrives in the URL hash on web_app opens.
    try {
      var m = /(?:^#|[#&])tgWebAppData=([^&]*)/.exec(window.location.hash || '');
      if (m) {
        INIT_DATA = decodeURIComponent(m[1]);
        var u = new URLSearchParams(INIT_DATA).get('user');
        if (u) TG_USER = JSON.parse(u);
      }
    } catch (e) { INIT_DATA = null; TG_USER = null; }
  }

  function cleanGuestName(raw) {
    return String(raw || '').replace(/[<>&"'`\/\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  }
  function guestName() {
    var n = cleanGuestName(lsGet('doGamesName') || '');
    return n.length >= 3 ? n : null;
  }
  function myBoardId() {
    if (TG_USER && TG_USER.id) return 'tg:' + TG_USER.id;
    var n = guestName();
    return n ? 'guest:' + n.toLowerCase() : null;
  }
  function displayIdentity() {
    if (TG_USER) {
      var nm = TG_USER.first_name || 'Player';
      if (TG_USER.username) nm += ' @' + TG_USER.username;
      return { label: nm, guest: false };
    }
    var g = guestName();
    return g ? { label: g + ' (guest)', guest: true } : { label: 'Guest — set your name', guest: true };
  }

  /* ---- guest-name prompt (once, remembered in localStorage) ---- */
  function promptGuestName(cb) {
    if (guestName()) { cb(guestName()); return; }
    var wrap = document.createElement('div');
    wrap.id = 'dgPrompt';
    wrap.innerHTML =
      '<div class="card"><h3>What should the board call you?</h3>' +
      '<p>Telegram players are verified automatically. As a guest, pick a name (3–16 characters). It is self-chosen, so guests are flagged on the board.</p>' +
      '<input id="dgNameInput" type="text" maxlength="16" placeholder="Your name" autocomplete="off">' +
      '<button class="btn" id="dgNameSave" type="button">Save &amp; submit</button>' +
      '<div class="skip" id="dgNameSkip">Skip — play without the board</div></div>';
    document.body.appendChild(wrap);
    var input = wrap.querySelector('#dgNameInput');
    try { input.focus(); } catch (e) { }
    function done(name) { wrap.remove(); cb(name); }
    wrap.querySelector('#dgNameSave').addEventListener('click', function () {
      var n = cleanGuestName(input.value);
      if (n.length < 3) { input.focus(); input.style.borderColor = '#e2483a'; return; }
      lsSet('doGamesName', n);
      done(n);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); wrap.querySelector('#dgNameSave').click(); }
    });
    wrap.querySelector('#dgNameSkip').addEventListener('click', function () { done(null); });
  }

  /* ---- score submission ----
     submitRun(game, breakdown, statusEl) → Promise<result|null>
     Handles identity: verified initData when present, else the guest
     prompt. Never sends a score — the server recomputes it. */
  function postRun(game, breakdown, identityFields, statusEl) {
    if (statusEl) statusEl.textContent = 'Sending score…';
    var payload = { game: game, breakdown: breakdown };
    for (var k in identityFields) payload[k] = identityFields[k];
    return fetch('api/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (statusEl) {
          if (j && j.ok) {
            statusEl.textContent = 'Score saved: ' + j.score + ' pts' +
              (j.rankWeek ? ' · #' + j.rankWeek + ' this week' : '') +
              (j.rankAll ? ' · #' + j.rankAll + ' all time' : '') +
              ' · DO Points total ' + j.totalAll;
          } else {
            statusEl.textContent = 'Score not saved' + (j && j.error ? ' — ' + j.error : '');
          }
        }
        return j;
      })
      .catch(function () {
        if (statusEl) statusEl.textContent = 'Leaderboard unreachable — your best is still saved on this device.';
        return null;
      });
  }

  function submitRun(game, breakdown, statusEl) {
    if (INIT_DATA) return postRun(game, breakdown, { initData: INIT_DATA }, statusEl);
    return new Promise(function (resolve) {
      promptGuestName(function (name) {
        if (!name) {
          if (statusEl) statusEl.textContent = 'Played as guest — no name, no board entry.';
          resolve(null);
          return;
        }
        resolve(postRun(game, breakdown, { guestName: name }, statusEl));
      });
    });
  }

  /* ---- per-game local bests (device only; the board is the truth) ---- */
  function localBest(game) { return parseInt(lsGet('doGamesBest:' + game) || '0', 10) || 0; }
  function saveLocalBest(game, score) {
    var b = localBest(game);
    if (score > b) { lsSet('doGamesBest:' + game, String(score)); return score; }
    return b;
  }

  function fetchBoards() {
    return fetch('api/leaderboard').then(function (r) { return r.json(); });
  }

  window.DoGames = {
    tg: TG,
    initData: INIT_DATA,
    tgUser: TG_USER,
    guestName: guestName,
    setGuestName: function (n) { var c = cleanGuestName(n); if (c.length >= 3) lsSet('doGamesName', c); return guestName(); },
    myBoardId: myBoardId,
    displayIdentity: displayIdentity,
    promptGuestName: promptGuestName,
    submitRun: submitRun,
    localBest: localBest,
    saveLocalBest: saveLocalBest,
    fetchBoards: fetchBoards,
    lsGet: lsGet,
    lsSet: lsSet,
  };
})();
