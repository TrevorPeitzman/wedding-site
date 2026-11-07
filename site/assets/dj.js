/* DJ view: queue, mark played / hide / block, live controls, block list and
 * setlist export. The key arrives once as /songs/dj/#key=<key> and is kept in
 * this browser so later visits are just /songs/dj/. */
(function () {
  'use strict';
  var KT = window.KT;
  var api = KT.songsClient();
  var STORE = 'kt-dj-key';
  var $ = function (id) { return document.getElementById(id); };
  var key = null, data = null, toastTimer = null, editing = false;

  if (api.mode === 'demo') $('demo-note').hidden = false;

  try {
    var m = location.hash.match(/key=([^&]+)/);
    if (m) { localStorage.setItem(STORE, decodeURIComponent(m[1])); history.replaceState(null, '', location.pathname); }
    key = localStorage.getItem(STORE);
    // The organizer key opens this view too: an organizer arriving from
    // /admin/ needn't type anything, and gets a link back.
    var orgKey = localStorage.getItem('kt-org-key');
    if (orgKey) {
      if (!key) key = orgKey;
      $('nav-admin').hidden = false;
    }
  } catch (e) {}

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(message, tone) {
    tone = tone || 'success';
    toastEl().innerHTML = '<div class="kt-notice kt-notice-' + tone + '"><span class="kt-notice-mark" aria-hidden="true">' +
      (tone === 'success' ? '✓' : '×') + '</span><span class="kt-notice-title">' + (tone === 'success' ? 'Done' : 'Not quite') +
      '</span><p class="kt-notice-body">' + esc(message) + '</p></div>';
    toastEl().classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl().classList.remove('is-on'); }, 3500);
  }
  function toastEl() { return $('toast'); }

  function showKeyForm(message) {
    $('dj').hidden = true;
    $('key-form').hidden = false;
    $('key-error').hidden = !message;
    $('key-error').textContent = message || '';
  }

  /* --------------------------------------------------------- render -- */

  // A title that opens the track in Spotify (its app, if installed: Spotify's
  // track links are universal links). Demo-catalog ids aren't real tracks.
  function titleHtml(r) {
    var id = r.spotify_id || '';
    if (!/^[A-Za-z0-9]{22}$/.test(id) || /^demo/.test(id)) return esc(r.title);
    return '<a class="song-link" href="https://open.spotify.com/track/' + id + '" target="_blank" rel="noopener">' +
      esc(r.title) + '<span class="visually-hidden"> (opens in Spotify)</span></a>';
  }
  // "3:45 · 128 BPM · Pop": whatever is known (manual entries have none).
  function facts(r) {
    var out = [];
    if (r.duration_ms) {
      var sec = Math.round(r.duration_ms / 1000);
      out.push(Math.floor(sec / 60) + ':' + ('0' + sec % 60).slice(-2));
    }
    if (r.bpm) out.push(Math.round(r.bpm) + ' BPM');
    if (r.genre) out.push(r.genre);
    return out.length ? '<p class="song-by dj-facts">' + esc(out.join(' · ')) + '</p>' : '';
  }

  function row(r, i, done) {
    var votes = r.votes + (r.votes === 1 ? ' vote' : ' votes');
    var buttons = done
      ? '<button class="kt-btn kt-btn-secondary kt-btn-sm" data-act="queued" data-id="' + r.id + '">' +
        (r.status === 'played' ? 'Back to the list' : 'Restore') + '</button>'
      : '<button class="kt-btn kt-btn-primary kt-btn-sm" data-act="played" data-id="' + r.id + '">Played</button>' +
        '<button class="kt-btn kt-btn-secondary kt-btn-sm" data-act="hidden" data-id="' + r.id + '">Hide</button>' +
        '<button class="kt-btn kt-btn-quiet kt-btn-sm" data-act="block" data-id="' + r.id + '">Block artist</button>';
    return '<li class="song-row dj-row' + (done ? ' is-played' : '') + '">' +
      '<span class="song-rank" aria-hidden="true">' + (done ? '' : i + 1) + '</span>' +
      '<div class="song-meta"><p class="song-title">' + titleHtml(r) + '</p>' +
      '<p class="song-artist">' + esc(r.artist) + '</p>' + facts(r) +
      (r.requester_name ? '<p class="song-by">Asked for by ' + esc(r.requester_name) + '</p>' : '') +
      (done ? '<p class="song-by">' + (r.status === 'played' ? 'Played' : 'Hidden') + '</p>' : '') + '</div>' +
      '<span class="dj-votes">' + esc(votes) + '</span>' +
      '<div class="dj-actions">' + buttons + '</div></li>';
  }

  function render() {
    var queued = data.requests.filter(function (r) { return r.status === 'queued'; });
    var done = data.requests.filter(function (r) { return r.status !== 'queued'; });
    $('queue').innerHTML = queued.length ? queued.map(function (r, i) { return row(r, i, false); }).join('')
      : '<li class="song-empty">No requests waiting.</li>';
    $('done').innerHTML = done.length ? done.map(function (r) { return row(r, 0, true); }).join('')
      : '<li class="song-empty">Nothing played or hidden yet.</li>';
    $('rules').innerHTML = data.rules.length ? data.rules.map(function (r) {
      return '<div class="dj-rule"><p><span class="dj-kind">' + esc(r.kind.replace('_', ' ')) + '</span><br>' + esc(r.pattern) +
        (r.reason ? '<br><span class="kt-hint">' + esc(r.reason) + '</span>' : '') + '</p>' +
        '<button class="kt-btn kt-btn-quiet kt-btn-sm" data-rule="' + r.id + '" aria-label="' + esc('Remove rule ' + r.pattern) + '">Remove</button></div>';
    }).join('') : '<p class="kt-hint">No rules yet.</p>';
    if (!editing) {
      var e = data.event, f = $('controls');
      f.requests_open.checked = !!e.requests_open;
      f.voting_open.checked = !!e.voting_open;
      f.block_explicit.checked = !!e.block_explicit;
      f.vote_cooldown_minutes.value = Math.round(e.vote_cooldown_seconds / 60);
      f.request_cooldown_minutes.value = Math.round(e.request_cooldown_seconds / 60);
      f.max_requests_per_guest.value = e.max_requests_per_guest;
    }
    $('updated').textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  }

  // BPM and genre arrive from the server's lookups; ask for any missing at
  // most once a minute, and redraw when some came in.
  var lastAsk = 0;
  function askForDetails() {
    var missing = (data.requests || []).some(function (r) { return r.spotify_id && r.bpm == null && r.genre == null; });
    if (!missing || !api.admin.details || Date.now() - lastAsk < 60000) return;
    lastAsk = Date.now();
    api.admin.details(key).then(function (r) { if (r && r.filled) load(); }, function () {});
  }

  function load() {
    if (!key) { showKeyForm(); return Promise.resolve(); }
    return api.admin.board(key).then(function (d) {
      data = d; $('key-form').hidden = true; $('dj').hidden = false; render();
      askForDetails();
    }).catch(function (err) {
      if (err.code === 'not_admin') {
        key = null; try { localStorage.removeItem(STORE); } catch (e) {}
        showKeyForm(err.message);
      } else if (!data) showKeyForm(err.message);
    });
  }

  function act(promise, message) {
    return promise.then(function () { if (message) toast(message); return load(); })
      .catch(function (err) { toast(err.message, 'danger'); });
  }

  /* --------------------------------------------------------- events -- */
  $('key-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    key = $('key').value.trim();
    try { localStorage.setItem(STORE, key); } catch (e) {}
    load();
  });

  $('forget').addEventListener('click', function () {
    try { localStorage.removeItem(STORE); } catch (e) {}
    key = null; data = null; showKeyForm();
  });

  document.addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-act]');
    if (b) {
      var id = Number(b.dataset.id), what = b.dataset.act;
      var req = data.requests.filter(function (r) { return r.id === id; })[0];
      if (what === 'block') {
        if (!req || !confirm('Block every song by ' + req.artist + '? This also hides this request.')) return;
        act(api.admin.addRule(key, 'artist', req.artist, null, id), 'Blocked ' + req.artist + '.');
      } else {
        act(api.admin.setStatus(key, id, what),
            what === 'played' ? 'Marked played.' : what === 'hidden' ? 'Hidden from guests.' : 'Back on the list.');
      }
      return;
    }
    var r = ev.target.closest('button[data-rule]');
    if (r) act(api.admin.deleteRule(key, Number(r.dataset.rule)), 'Rule removed.');
    var x = ev.target.closest('button[data-export]');
    if (x) exportSetlist(x.dataset.export);
  });

  var controls = $('controls');
  // While the DJ is changing settings, refreshes must not overwrite the form.
  controls.addEventListener('focusin', function () { editing = true; });
  controls.addEventListener('change', function () { editing = true; });
  controls.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var f = controls;
    var mins = function (v) { return v === '' ? null : Math.max(0, Math.round(Number(v) * 60)); };
    var num = function (v) { return v === '' ? null : Math.max(0, Math.round(Number(v))); };
    act(api.admin.updateEvent(key, {
      requests_open: f.requests_open.checked,
      voting_open: f.voting_open.checked,
      block_explicit: f.block_explicit.checked,
      vote_cooldown_seconds: mins(f.vote_cooldown_minutes.value),
      request_cooldown_seconds: mins(f.request_cooldown_minutes.value),
      max_requests_per_guest: num(f.max_requests_per_guest.value)
    }), 'Saved.').then(function () { editing = false; render(); });
  });

  $('rule-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    act(api.admin.addRule(key, $('r-kind').value, $('r-pattern').value, $('r-reason').value.trim(), null), 'Rule added.')
      .then(function () { $('r-pattern').value = ''; $('r-reason').value = ''; });
  });

  /* --------------------------------------------------------- export -- */
  function setlistRows() {
    var played = data.requests.filter(function (r) { return r.status === 'played'; })
      .sort(function (a, b) { return String(a.played_at || '').localeCompare(String(b.played_at || '')); });
    var queued = data.requests.filter(function (r) { return r.status === 'queued'; });
    return played.concat(queued);
  }
  function download(name, text, type) {
    var url = URL.createObjectURL(new Blob([text], { type: type }));
    var a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function csvCell(v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function exportSetlist(kind) {
    var rows = setlistRows();
    if (kind === 'txt') {
      download('setlist.txt', rows.map(function (r) { return r.artist + ' - ' + r.title; }).join('\n') + '\n', 'text/plain');
    } else if (kind === 'csv') {
      var lines = [['status', 'played_at', 'votes', 'artist', 'title', 'album', 'requested_by', 'spotify_id']].concat(rows.map(function (r) {
        return [r.status, r.played_at || '', r.votes, r.artist, r.title, r.album || '', r.requester_name || '', r.spotify_id || ''];
      }));
      download('setlist.csv', lines.map(function (l) { return l.map(csvCell).join(','); }).join('\n') + '\n', 'text/csv');
    } else {
      // Paste these into a playlist in the Spotify desktop app.
      download('setlist-spotify-uris.txt', rows.filter(function (r) { return r.spotify_id; })
        .map(function (r) { return 'spotify:track:' + r.spotify_id; }).join('\n') + '\n', 'text/plain');
    }
  }

  setInterval(function () { if (!document.hidden && key) load(); }, 10000);
  load();
})();
