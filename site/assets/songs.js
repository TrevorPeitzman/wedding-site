/* Guest song board: search, request, vote, and a polled refresh.
 * Same behavior as the original wedding-song-requests board, restyled on the
 * design system and talking to Supabase through songs-client.js. */
(function () {
  'use strict';
  var KT = window.KT;
  // Timed release: before songs opens, the page shows its "opens at" notice
  // (features.js) and reloads itself at the opening time.
  if (KT.feature && KT.feature('songs') !== 'open') { KT.whenOpen('songs', function () {}); return; }
  var api = KT.songsClient();

  var $ = function (id) { return document.getElementById(id); };
  var q = $('q'), results = $('results'), searchMsg = $('search-msg'), board = $('board');
  var nameInput = $('name'), toastEl = $('toast');
  var POLL_MS = 7000;
  var state = null, busy = false, searchTimer = null, toastTimer = null, lastQuery = '';

  if (api.mode === 'demo') $('demo-note').hidden = false;

  try { var saved = localStorage.getItem('kt-song-name'); if (saved) nameInput.value = saved; } catch (e) {}

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pretty(seconds) {
    if (seconds < 60) return seconds + ' seconds';
    var m = Math.round(seconds / 60);
    return m + (m === 1 ? ' minute' : ' minutes');
  }
  function safeArt(url) {
    return /^https:\/\/i\.scdn\.co\/image\/[A-Za-z0-9]+$/.test(url || '') ? url : null;
  }

  /* ------------------------------------------------------- toast -- */
  var MARK = { success: '✓', danger: '×', info: 'i' };
  function toast(message, tone) {
    tone = tone || 'success';
    var title = tone === 'success' ? 'Done' : tone === 'danger' ? 'Not quite' : 'Note';
    toastEl.innerHTML = '<div class="kt-notice kt-notice-' + tone + '">' +
      '<span class="kt-notice-mark" aria-hidden="true">' + MARK[tone] + '</span>' +
      '<span class="kt-notice-title">' + title + '</span>' +
      '<p class="kt-notice-body">' + esc(message) + '</p></div>';
    toastEl.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('is-on'); }, 4500);
  }

  /* ------------------------------------------------------- board -- */
  var CHEVRON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 10.5 8 5.5l5 5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var NOTE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 17.5V6l10-2v11.5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="6.5" cy="17.5" r="2.5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="16.5" cy="15.5" r="2.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';

  function art(url) {
    var safe = safeArt(url);
    return safe ? '<span class="song-art"><img src="' + esc(safe) + '" alt="" width="48" height="48" loading="lazy"></span>'
                : '<span class="song-art song-art-empty">' + NOTE + '</span>';
  }

  function rowHtml(r, i) {
    var played = r.status === 'played';
    var canVote = !played && !r.voted && state.voting_open;
    var votes = r.votes + (r.votes === 1 ? ' vote' : ' votes');
    var action = played
      ? '<span class="song-played"><span aria-hidden="true">✓</span> Played</span>'
      : '<button class="song-vote' + (r.voted ? ' is-voted' : '') + '" type="button" data-id="' + r.id + '"' +
        ' aria-pressed="' + (r.voted ? 'true' : 'false') + '"' + (canVote ? '' : ' disabled') +
        ' aria-label="' + esc((r.voted ? 'You voted for ' : 'Vote for ') + r.title + ', ' + votes) + '">' +
        CHEVRON + '<span class="song-count">' + r.votes + '</span></button>';
    return '<li class="song-row' + (played ? ' is-played' : '') + '">' +
      '<span class="song-rank" aria-hidden="true">' + (played ? '' : i + 1) + '</span>' +
      art(r.artwork_url) +
      '<div class="song-meta"><p class="song-title">' + esc(r.title) + '</p>' +
      '<p class="song-artist">' + esc(r.artist) + '</p>' +
      (r.requester_name ? '<p class="song-by">Asked for by ' + esc(r.requester_name) + '</p>' : '') +
      (played ? '<p class="visually-hidden">' + esc(votes) + '</p>' : '') +
      '</div>' + action + '</li>';
  }

  function render() {
    if (!state) return;
    $('closed-note').hidden = state.requests_open;
    $('ask').hidden = !state.requests_open;
    var me = state.me || {};
    $('name-field').hidden = !!me.from_pass;
    $('pass-name').hidden = !me.from_pass;
    if (me.from_pass) $('pass-name').querySelector('strong').textContent = me.name || '';
    var queued = 0;
    board.innerHTML = state.requests.length
      ? state.requests.map(function (r) { return rowHtml(r, r.status === 'played' ? 0 : queued++); }).join('')
      : '<li class="song-empty">Nothing yet. Be the first!</li>';
    board.setAttribute('aria-busy', 'false');
    var mins = Math.round((state.vote_cooldown_seconds || 0) / 60);
    $('rules-note').textContent = state.voting_open
      ? 'One vote per song' + (mins ? ', and one vote every ' + (mins === 1 ? 'minute' : mins + ' minutes') : '') + '.'
      : 'Voting is closed for now.';
  }

  function refresh() {
    return api.board().then(function (data) { state = data; render(); })
      .catch(function (err) {
        if (!state) board.innerHTML = '<li class="song-empty">' + esc(err.message) + '</li>';
      });
  }

  /* ------------------------------------------------------ search -- */
  function renderResults(items) {
    if (!items.length) {
      results.hidden = true;
      searchMsg.textContent = 'No matches. Check the spelling, or type it in below.';
      return;
    }
    searchMsg.textContent = items.length + (items.length === 1 ? ' match' : ' matches');
    results.innerHTML = items.map(function (t, i) {
      return '<li class="song-result">' + art(t.artwork_url) +
        '<div class="song-meta"><p class="song-title">' + esc(t.title) + '</p>' +
        '<p class="song-artist">' + esc(t.artist) + '</p></div>' +
        '<button class="kt-btn kt-btn-secondary kt-btn-sm" type="button" data-i="' + i + '"' +
        ' aria-label="' + esc('Request ' + t.title + ' by ' + t.artist) + '">Request</button></li>';
    }).join('');
    results.hidden = false;
    results._items = items;
  }

  function runSearch() {
    var term = q.value.trim();
    lastQuery = term;
    if (term.length < 2) { results.hidden = true; searchMsg.textContent = ''; return; }
    searchMsg.textContent = 'Searching…';
    api.search(term).then(function (data) {
      if (term !== lastQuery) return; // a newer search is on its way
      renderResults(data.results || []);
    }).catch(function (err) {
      results.hidden = true;
      searchMsg.textContent = err.message;
    });
  }

  q.addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 300);
  });

  function name() {
    var n = nameInput.value.trim();
    try { if (n) localStorage.setItem('kt-song-name', n); } catch (e) {}
    return n;
  }

  function submit(track, done) {
    if (busy) return;
    busy = true;
    api.request(track, (state && state.me && state.me.from_pass) ? null : name())
      .then(function (data) {
        toast(data.action === 'voted'
          ? 'It was already on the list, so we counted your vote.'
          : 'Added! Now get your table to vote for it.');
        q.value = ''; results.hidden = true; searchMsg.textContent = '';
        if (done) done();
        return refresh();
      })
      .catch(function (err) { toast(err.message, 'danger'); })
      .then(function () { busy = false; });
  }

  results.addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-i]');
    if (b && results._items) submit(results._items[Number(b.dataset.i)]);
  });

  $('manual-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var t = $('m-title'), a = $('m-artist');
    submit({ title: t.value.trim(), artist: a.value.trim() }, function () {
      t.value = ''; a.value = '';
      $('manual-form').closest('details').open = false;
    });
  });

  /* ------------------------------------------------------- votes -- */
  board.addEventListener('click', function (ev) {
    var b = ev.target.closest('button.song-vote');
    if (!b || b.disabled || busy) return;
    busy = true;
    // Optimistic: the tap should feel instant on venue wifi. A refusal
    // re-renders from the server, which puts the number back.
    var count = b.querySelector('.song-count');
    count.textContent = String(Number(count.textContent) + 1);
    b.classList.add('is-voted');
    b.setAttribute('aria-pressed', 'true');
    b.disabled = true;
    api.vote(Number(b.dataset.id))
      .then(function () { toast('Vote counted.'); })
      .catch(function (err) {
        toast(err.code === 'vote_cooldown' && err.retryAfter
          ? 'One vote at a time. Try again in ' + pretty(err.retryAfter) + '.'
          : err.message, 'danger');
      })
      .then(function () { busy = false; return refresh(); });
  });

  /* ----------------------------------------------------- polling -- */
  setInterval(function () { if (!busy && !document.hidden) refresh(); }, POLL_MS);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });

  api.init().then(refresh, refresh);
})();
