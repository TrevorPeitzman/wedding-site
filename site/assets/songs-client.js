/* Data layer for the song board and the DJ view.
 *
 * KT.songsClient() returns one of two backends with the same methods:
 *  - live: Supabase (database functions + the `songs` Edge Function)
 *  - demo: an in-browser copy of the same rules, stored in localStorage, used
 *          when assets/config.js has no Supabase settings.
 *
 * Every method returns a Promise. Refusals reject with an Error carrying
 * .code (stable, e.g. "vote_cooldown") and .retryAfter (seconds or null).
 */
(function () {
  var KT = (window.KT = window.KT || {});
  var PASS_KEY = 'kt-pass';

  function refusal(code, message, retryAfter) {
    var err = new Error(message || 'Something went wrong. Try again?');
    err.code = code || 'error';
    err.retryAfter = retryAfter == null || retryAfter === '' ? null : Number(retryAfter);
    return err;
  }
  KT.refusal = refusal;

  function storedPass() {
    try { return localStorage.getItem(PASS_KEY); } catch (e) { return null; }
  }
  function forgetPass() {
    try { localStorage.removeItem(PASS_KEY); } catch (e) {}
  }

  /* ------------------------------------------------------------ live -- */

  function liveClient(cfg) {
    var sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'kt-auth' }
    });
    var sessionPromise = null;

    function hasSession() {
      return sb.auth.getSession().then(function (r) { return !!(r.data && r.data.session); });
    }

    // Guests become anonymous Supabase users lazily, on their first request or
    // vote, so people who only look at the board don't create accounts.
    function ensureSession() {
      if (!sessionPromise) {
        sessionPromise = hasSession().then(function (has) {
          if (has) return;
          return sb.auth.signInAnonymously().then(function (r) {
            if (r.error) throw refusal('no_session', 'We couldn’t connect. Check your signal and try again.');
          });
        }).catch(function (err) { sessionPromise = null; throw err; });
      }
      return sessionPromise;
    }

    function rpc(name, args) {
      return sb.rpc(name, args || {}).then(function (r) {
        if (r.error) {
          if (r.error.code === 'P0001') throw refusal(r.error.details, r.error.message, r.error.hint);
          throw refusal('unavailable', 'We couldn’t reach the song list. Try again in a moment.');
        }
        return r.data;
      });
    }

    function fn(body) {
      return sb.functions.invoke('songs', { body: body }).then(function (r) {
        if (r.error || !r.data) throw refusal('unavailable', 'Song search is having a moment. Try again in a second.');
        if (r.data.ok === false) throw refusal(r.data.code, r.data.message, r.data.retry_after);
        return r.data;
      });
    }

    var api = {
      mode: 'live',
      // Claims a boarding pass captured from the URL (see site.js), once.
      init: function () {
        var pass = storedPass();
        if (!pass) return Promise.resolve();
        return ensureSession()
          .then(function () { return rpc('claim_pass', { p_token: pass }); })
          .then(function () { forgetPass(); })
          .catch(function (err) { if (err.code === 'unknown_pass') forgetPass(); });
      },
      board: function () { return rpc('song_board'); },
      search: function (q) { return fn({ action: 'search', q: q }); },
      request: function (track, name) {
        return ensureSession().then(function () {
          var body = { action: 'request', requester_name: name || null };
          if (track.spotify_id) body.spotify_id = track.spotify_id;
          else { body.title = track.title; body.artist = track.artist; }
          return fn(body);
        });
      },
      vote: function (id) {
        return ensureSession().then(function () { return rpc('vote', { p_request_id: id }); });
      },
      admin: {
        board: function (key) { return rpc('admin_board', { p_key: key }); },
        setStatus: function (key, id, status) {
          return rpc('admin_set_status', { p_key: key, p_request_id: id, p_status: status });
        },
        updateEvent: function (key, settings) {
          return rpc('admin_update_event', { p_key: key, p_settings: settings });
        },
        addRule: function (key, kind, pattern, reason, hideId) {
          return rpc('admin_add_block_rule', {
            p_key: key, p_kind: kind, p_pattern: pattern, p_reason: reason || null,
            p_hide_request_id: hideId == null ? null : hideId
          });
        },
        deleteRule: function (key, id) { return rpc('admin_delete_block_rule', { p_key: key, p_rule_id: id }); }
      }
    };
    return api;
  }

  /* ------------------------------------------------------------ demo -- */

  var DEMO_KEY = 'kt-songs-demo-v1';
  var ME = 'me';

  function demoClient() {
    var catalog = null;
    function loadCatalog() {
      if (catalog) return Promise.resolve(catalog);
      return fetch('/songs/demo-tracks.json').then(function (r) { return r.json(); })
        .then(function (list) { catalog = list; return list; });
    }

    function fresh() {
      var now = Date.now();
      function seed(i, t, n) {
        var voters = [];
        for (var v = 0; v < n; v++) voters.push('guest' + v);
        return { id: i, spotify_id: t[0], title: t[1], artist: t[2], album: null, artwork_url: null,
                 duration_ms: null, status: 'queued', requester_name: t[3] || null, created_at: now - i * 60000,
                 played_at: null, voters: voters };
      }
      return {
        nextId: 6,
        event: { requests_open: true, voting_open: true, block_explicit: false,
                 vote_cooldown_seconds: 300, request_cooldown_seconds: 600, max_requests_per_guest: 5 },
        me: { name: null, from_pass: false },
        requests: [
          seed(1, ['demo000000000000000001', 'September', 'Earth, Wind & Fire', 'Casey'], 7),
          seed(2, ['demo000000000000000002', 'Dancing Queen', 'ABBA', 'Jordan'], 5),
          seed(3, ['demo000000000000000016', 'Twist and Shout', 'The Beatles', null], 4),
          seed(4, ['demo000000000000000010', 'Mr. Brightside', 'The Killers', 'Sam'], 3),
          seed(5, ['demo000000000000000004', 'I Wanna Dance with Somebody', 'Whitney Houston', 'Riley'], 2)
        ],
        rules: [
          { id: 1, kind: 'keyword', pattern: 'Chicken Dance', reason: 'Example rule. Delete it in the DJ view.', active: true },
          { id: 2, kind: 'keyword', pattern: 'Cha Cha Slide', reason: 'Example rule. Delete it in the DJ view.', active: true }
        ],
        nextRule: 3
      };
    }
    function load() {
      try { var s = JSON.parse(localStorage.getItem(DEMO_KEY)); if (s && s.requests) return s; } catch (e) {}
      return fresh();
    }
    function save(s) { try { localStorage.setItem(DEMO_KEY, JSON.stringify(s)); } catch (e) {} }
    function later(v) { return new Promise(function (ok) { setTimeout(function () { ok(v); }, 120); }); }
    function fail(code, msg) { return new Promise(function (ok, no) { setTimeout(function () { no(refusal(code, msg)); }, 120); }); }

    function blocked(s, t) {
      if (s.event.block_explicit && t.explicit) return 'Explicit tracks are turned off for this event.';
      for (var i = 0; i < s.rules.length; i++) {
        var r = s.rules[i], p = String(r.pattern || '').trim().toLowerCase();
        if (!r.active || !p) continue;
        var title = String(t.title || '').toLowerCase(), artist = String(t.artist || '').toLowerCase();
        var hit = r.kind === 'spotify_id' ? t.spotify_id === r.pattern.trim()
          : r.kind === 'artist' ? artist.indexOf(p) >= 0
          : r.kind === 'title' ? title.indexOf(p) >= 0
          : title.indexOf(p) >= 0 || artist.indexOf(p) >= 0;
        if (hit) return r.reason || 'That one is on the do-not-play list. Pick another!';
      }
      return null;
    }

    function ranked(s, includeHidden) {
      return s.requests.filter(function (r) { return includeHidden || r.status !== 'hidden'; })
        .map(function (r) {
          return { id: r.id, status: r.status, spotify_id: r.spotify_id, title: r.title, artist: r.artist,
                   album: r.album, artwork_url: r.artwork_url, duration_ms: r.duration_ms,
                   requester_name: r.requester_name, played_at: r.played_at, created_at: r.created_at,
                   votes: r.voters.length, voted: r.voters.indexOf(ME) >= 0 };
        })
        .sort(function (a, b) {
          return (a.status === 'played') - (b.status === 'played') || b.votes - a.votes || a.created_at - b.created_at;
        });
    }

    function castVote(s, id) {
      if (!s.event.voting_open) return 'Voting is closed for now.|voting_closed';
      var r = s.requests.filter(function (x) { return x.id === id; })[0];
      if (!r || r.status === 'hidden') return 'That song is not on the list.|not_found';
      if (r.status !== 'queued') return 'That one has already been played.|not_votable';
      if (r.voters.indexOf(ME) >= 0) return 'You have already voted for that one.|already_voted';
      r.voters.push(ME);
      return null;
    }

    function finish(problem, value) {
      if (!problem) return later(value);
      var parts = problem.split('|');
      return fail(parts[1], parts[0]);
    }

    function admin(key, f) {
      if (!key) return fail('not_admin', 'That DJ link is not valid.');
      var s = load(); var out = f(s); save(s); return later(out);
    }

    return {
      mode: 'demo',
      init: function () {
        var pass = storedPass();
        if (pass) {
          var s = load(); s.me = { name: 'Guest with pass', from_pass: true }; save(s); forgetPass();
        }
        return later();
      },
      board: function () {
        var s = load();
        return later({
          requests_open: s.event.requests_open, voting_open: s.event.voting_open,
          vote_cooldown_seconds: s.event.vote_cooldown_seconds, vote_cooldown_remaining: 0,
          me: s.me, requests: ranked(s, false)
        });
      },
      search: function (q) {
        var needle = String(q || '').trim().toLowerCase();
        return loadCatalog().then(function (list) {
          var s = load();
          var hits = list.filter(function (t) {
            return needle.length >= 2 && (t.title + ' ' + t.artist + ' ' + (t.album || '')).toLowerCase().indexOf(needle) >= 0 && !blocked(s, t);
          }).slice(0, 8);
          return later({ ok: true, live: false, results: hits });
        });
      },
      request: function (track, name) {
        var s = load();
        if (!s.event.requests_open) return fail('requests_closed', 'Song requests are closed for now.');
        if (!track.title || !track.artist) return fail('incomplete_track', 'Give both a song title and an artist.');
        var why = blocked(s, track);
        if (why) return fail('blocked', why);
        if (name && !s.me.from_pass) s.me.name = String(name).slice(0, 60);
        var existing = s.requests.filter(function (r) {
          return track.spotify_id ? r.spotify_id === track.spotify_id
            : !r.spotify_id && r.title.toLowerCase() === track.title.toLowerCase() && r.artist.toLowerCase() === track.artist.toLowerCase();
        })[0];
        if (existing) {
          if (existing.status === 'hidden') return fail('blocked', 'That song is not available to request.');
          var p = castVote(s, existing.id); if (!p) save(s);
          return finish(p, { action: 'voted', request_id: existing.id });
        }
        var mine = s.requests.filter(function (r) { return r.mine && r.status !== 'hidden'; }).length;
        if (s.event.max_requests_per_guest && mine >= s.event.max_requests_per_guest) {
          return fail('request_cap', 'You have already put in ' + s.event.max_requests_per_guest + ' songs. Upvote someone else’s instead!');
        }
        var id = s.nextId++;
        s.requests.push({ id: id, spotify_id: track.spotify_id || null, title: track.title, artist: track.artist,
                          album: track.album || null, artwork_url: track.artwork_url || null,
                          duration_ms: track.duration_ms || null, status: 'queued', requester_name: s.me.name,
                          created_at: Date.now(), played_at: null, voters: [ME], mine: true });
        save(s);
        return later({ ok: true, action: 'created', request_id: id });
      },
      vote: function (id) {
        var s = load(); var p = castVote(s, id); if (!p) save(s);
        return finish(p, { action: 'voted', request_id: id });
      },
      admin: {
        board: function (key) {
          return admin(key, function (s) {
            return { event: Object.assign({ name: 'Katarina & Trevor' }, s.event), requests: ranked(s, true), rules: s.rules };
          });
        },
        setStatus: function (key, id, status) {
          return admin(key, function (s) {
            s.requests.forEach(function (r) {
              if (r.id === id) { r.status = status; r.played_at = status === 'played' ? new Date().toISOString() : null; }
            });
          });
        },
        updateEvent: function (key, settings) {
          return admin(key, function (s) {
            Object.keys(settings).forEach(function (k) { if (settings[k] != null) s.event[k] = settings[k]; });
          });
        },
        addRule: function (key, kind, pattern, reason, hideId) {
          if (!String(pattern || '').trim()) return fail('empty_pattern', 'A block rule needs something to match.');
          return admin(key, function (s) {
            s.rules.push({ id: s.nextRule++, kind: kind, pattern: pattern.trim(), reason: reason || null, active: true });
            if (hideId != null) s.requests.forEach(function (r) { if (r.id === hideId) r.status = 'hidden'; });
          });
        },
        deleteRule: function (key, id) {
          return admin(key, function (s) { s.rules = s.rules.filter(function (r) { return r.id !== id; }); });
        }
      }
    };
  }

  var client = null;
  KT.songsClient = function () {
    if (client) return client;
    var cfg = window.KT_CONFIG || {};
    // ?demo=1 forces demo mode for this tab (local UI work, rehearsals),
    // even when Supabase is configured. ?demo=0 turns it back off.
    var demo = false;
    try {
      var flag = new URLSearchParams(location.search).get('demo');
      if (flag === '1') sessionStorage.setItem('kt-demo', '1');
      if (flag === '0') sessionStorage.removeItem('kt-demo');
      demo = sessionStorage.getItem('kt-demo') === '1';
    } catch (e) {}
    if (demo || !(cfg.supabaseUrl && cfg.supabaseAnonKey)) return (client = demoClient());
    if (window.supabase) return (client = liveClient(cfg));
    // Configured, but the Supabase library didn't load (blocked CDN, bad
    // signal). Never fall back to the demo here: guests would think their
    // requests went through.
    var down = function () { return Promise.reject(refusal('unavailable', 'We couldn’t reach the song list. Reload the page to try again.')); };
    return (client = { mode: 'offline', init: function () { return Promise.resolve(); }, board: down, search: down,
      request: down, vote: down,
      admin: { board: down, setStatus: down, updateEvent: down, addRule: down, deleteRule: down } });
  };
})();
