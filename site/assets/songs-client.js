/* Data layer for the song board, the DJ view, the disposable camera and the
 * organizer screen.
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

    function fn(body, name) {
      return sb.functions.invoke(name || 'songs', { body: body }).then(function (r) {
        if (r.error || !r.data) {
          throw refusal('unavailable', name === 'camera'
            ? 'We couldn’t reach the camera. Your photo is safe on this phone; we’ll keep trying.'
            : 'Song search is having a moment. Try again in a second.');
        }
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
          .then(function () { forgetPass(); if (KT.setHasPass) KT.setHasPass(true); })
          .catch(function (err) {
            if (err.code === 'unknown_pass') { forgetPass(); if (KT.setHasPass) KT.setHasPass(false); }
          });
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
        // Looks up BPM and genre for requested tracks that don't have them yet.
        details: function (key) { return fn({ action: 'details', key: key }); },
        galleryPassword: function (key, password) {
          return rpc('admin_gallery_password', { p_key: key, p_password: password || null });
        },
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
        deleteRule: function (key, id) { return rpc('admin_delete_block_rule', { p_key: key, p_rule_id: id }); },
        camera: function (key) { return rpc('admin_camera', { p_key: key }); },
        // Organizer key only (the admin screen).
        features: function (key) { return rpc('admin_features', { p_key: key }); },
        setFeature: function (key, feature, on, opensAt, closesAt) {
          return rpc('admin_set_feature', { p_key: key, p_feature: feature, p_on: on,
                                            p_opens_at: opensAt || null, p_closes_at: closesAt || null });
        },
        setCamera: function (key, settings) { return rpc('admin_set_camera', { p_key: key, p_settings: settings }); },
        // Rehearsal (organizer key).
        rehearsal: function (key) { return rpc('admin_rehearsal', { p_key: key }); },
        makeTestPasses: function (key, count) { return rpc('admin_make_test_passes', { p_key: key, p_count: count }); },
        resetTestPass: function (key, token) { return fn({ action: 'purge', key: key, what: 'test_pass', token: token }, 'camera'); },
        deleteTestPasses: function (key) { return fn({ action: 'purge', key: key, what: 'test_passes' }, 'camera'); },
        clearSongs: function (key, confirmWord) { return rpc('admin_clear_songs', { p_key: key, p_confirm: confirmWord }); },
        // Every uploaded photo with who took it and a signed link (1 hour).
        photos: function (key, includeTests) {
          return fn({ action: 'admin_photos', key: key, include_tests: !!includeTests }, 'camera')
            .then(function (r) { return r.photos; });
        },
        hidePhoto: function (key, id, hidden) { return rpc('admin_hide_photo', { p_key: key, p_photo_id: id, p_hidden: !!hidden }); },
        // Shot counters per pass; a reset keeps the photos already taken.
        shots: function (key) { return rpc('admin_shots', { p_key: key }); },
        resetShots: function (key, token) { return rpc('admin_reset_shots', { p_key: key, p_token: token || null }); },
        // The photo album: the original plus a 2048px copy, both to the
        // private `album` bucket through signed upload links.
        albumList: function (key) {
          return fn({ action: 'album_list', key: key }, 'camera').then(function (r) { return r.photos; });
        },
        albumUpload: function (key, file, credit) {
          var ext = albumExt(file);
          if (!ext) return Promise.reject(refusal('bad_type', 'JPEG, PNG or WebP photos only.'));
          return KT.photoTools.webCopy(file).then(function (web) {
            return fn({ action: 'album_reserve', key: key, name: file.name, ext: ext, credit: credit || null }, 'camera')
              .then(function (a) {
                var bucket = sb.storage.from('album');
                var check = function (r) {
                  if (r.error) throw refusal('upload_failed', 'The upload didn’t finish. Try that one again.');
                };
                return bucket.uploadToSignedUrl(a.full.path, a.full.token, file, { contentType: ALBUM_TYPES[ext], upsert: true })
                  .then(check)
                  .then(function () { return bucket.uploadToSignedUrl(a.web.path, a.web.token, web, { contentType: 'image/jpeg', upsert: true }); })
                  .then(check)
                  .then(function () { return rpc('admin_album_confirm', { p_key: key, p_id: a.id }); });
              });
          });
        },
        albumHide: function (key, id, hidden) { return rpc('admin_album_hide', { p_key: key, p_id: id, p_hidden: !!hidden }); },
        albumDelete: function (key, id) { return fn({ action: 'album_delete', key: key, id: id }, 'camera'); }
      },
      // Disposable camera. Every call needs a guest session: the pass the
      // phone claimed is the camera's identity.
      camera: {
        status: function () {
          return ensureSession().then(function () { return api.init(); })
            .then(function () { return rpc('camera_status'); });
        },
        reserve: function (clientId) {
          return ensureSession().then(function () { return fn({ action: 'reserve', client_id: clientId }, 'camera'); });
        },
        upload: function (upload, blob) {
          return sb.storage.from('photos')
            .uploadToSignedUrl(upload.path, upload.token, blob, { contentType: 'image/jpeg', upsert: true })
            .then(function (r) {
              if (r.error) throw refusal('upload_failed', 'The upload didn’t finish. We’ll try again.');
              return r.data;
            });
        },
        confirm: function (photoId) {
          return ensureSession().then(function () { return rpc('confirm_shot', { p_photo_id: photoId }); });
        },
        gallery: function () {
          return ensureSession().then(function () { return api.init(); })
            .then(function () { return fn({ action: 'gallery' }, 'camera'); });
        },
        // The photos page: a pass on this phone, or the shared password.
        galleryStatus: function () {
          return ensureSession().then(function () { return api.init(); })
            .then(function () { return rpc('gallery_status'); });
        },
        unlockGallery: function (password) {
          return ensureSession().then(function () { return rpc('unlock_gallery', { p_password: password }); })
            .then(function (r) { if (!r.access) throw refusal(r.code, r.message); return r; });
        }
      },
      // Wallet: the claimed pass for the landing page, and its Apple link
      // (served by the `wallet` Edge Function to whoever holds the token).
      wallet: {
        card: function () {
          return ensureSession().then(function () { return api.init(); })
            .then(function () { return rpc('my_pass_card'); });
        },
        appleUrl: function (token) {
          return cfg.supabaseUrl.replace(/\/$/, '') + '/functions/v1/wallet?t=' + encodeURIComponent(token);
        }
      }
    };
    return api;
  }

  var ALBUM_TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  function albumExt(file) {
    var byType = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[file.type];
    var m = /\.(jpe?g|png|webp)$/i.exec(file.name || '');
    return byType || (m ? m[1].toLowerCase().replace('jpeg', 'jpg') : null);
  }

  /* ------------------------------------------------------------ demo -- */

  var DEMO_KEY = 'kt-songs-demo-v1';
  var CAM_KEY = 'kt-camera-demo-v1';
  var DEMO_REVEAL = '2026-11-22T23:00:00-08:00';
  var ME = 'me';
  function cam() {
    try { var c = JSON.parse(localStorage.getItem(CAM_KEY)); if (c && c.shots) return c; } catch (e) {}
    return { shots: [] };
  }
  function saveCam(c) { try { localStorage.setItem(CAM_KEY, JSON.stringify(c)); } catch (e) {} }
  function demoTests() {
    try { return JSON.parse(localStorage.getItem('kt-rehearsal-demo')) || []; } catch (e) { return []; }
  }
  // Demo photos: drawn on a canvas as real JPEGs, so saving and zipping them
  // can be rehearsed. Hidden ones are remembered in this browser.
  var DEMO_GUESTS = [['Dora', 'Day', 5], ['Josephine', 'March', 2], ['Felix', 'Ortega', 9], ['Ana', 'Lind', 14],
    ['Theo', 'Park', 1], ['Mira', 'Novak', 7], ['Sam', 'Reyes', 11], ['Ivy', 'Chen', 3]];
  var demoPhotoCache = null;
  function demoPhotoUrl(i) {
    try {
      var c = document.createElement('canvas'); c.width = 640; c.height = 480;
      var g = c.getContext('2d'), hue = (i * 47) % 360;
      var grad = g.createLinearGradient(0, 0, 640, 480);
      grad.addColorStop(0, 'hsl(' + hue + ',45%,32%)'); grad.addColorStop(1, 'hsl(' + ((hue + 60) % 360) + ',55%,62%)');
      g.fillStyle = grad; g.fillRect(0, 0, 640, 480);
      g.fillStyle = 'rgba(255,255,255,.85)'; g.font = '64px Georgia, serif'; g.textAlign = 'center';
      g.fillText('Demo ' + (i + 1), 320, 260);
      return c.toDataURL('image/jpeg', 0.8);
    } catch (e) { return ''; }
  }
  function demoPhotoHidden() {
    try { return JSON.parse(localStorage.getItem('kt-photos-demo-hidden')) || {}; } catch (e) { return {}; }
  }
  function demoPhotos(includeTests) {
    if (!demoPhotoCache) {
      var start = Date.parse('2026-11-21T18:05:00-08:00');
      demoPhotoCache = [];
      for (var i = 0; i < 26; i++) {
        var test = i >= 24, who = test ? ['Test Guest', String(i - 23), null] : DEMO_GUESTS[i % DEMO_GUESTS.length];
        demoPhotoCache.push({ id: 'demo-photo-' + i, path: 'demo-photo-' + i + '.jpg', url: demoPhotoUrl(i),
          uploaded_at: new Date(start + i * 9 * 60000).toISOString(), bytes: 80000,
          first_name: who[0], last_name: who[1], table_number: who[2], is_test: test });
      }
      demoPhotoCache.reverse();
    }
    var hidden = demoPhotoHidden();
    return demoPhotoCache.filter(function (p) { return includeTests || !p.is_test; })
      .map(function (p) { return Object.assign({}, p, { hidden: !!hidden[p.id] }); });
  }
  // Demo shot counters: the sample guests, plus this browser's demo camera
  // as Dora Day. A reset is remembered per token.
  function demoResets() {
    try { return JSON.parse(localStorage.getItem('kt-shots-demo-reset')) || {}; } catch (e) { return {}; }
  }
  function demoUsed() {
    var at = demoResets().demo;
    return cam().shots.filter(function (x) { return !at || (x.at || 0) > Date.parse(at); }).length;
  }
  function demoShots() {
    var resets = demoResets();
    var list = [{ token: 'demo', first_name: 'Dora', last_name: 'Day', table_number: 5, is_test: false,
                  used: demoUsed(), uploaded: cam().shots.filter(function (x) { return x.status === 'uploaded'; }).length, phones: 1 }];
    DEMO_GUESTS.slice(1).forEach(function (g, i) {
      var tok = 'demo-guest-' + i, used = resets[tok] ? 0 : (i * 5 + 3) % 13;
      list.push({ token: tok, first_name: g[0], last_name: g[1], table_number: g[2], is_test: false,
                  used: used, uploaded: (i * 5 + 3) % 13, phones: used ? 1 : 0 });
    });
    return { shots_per_pass: 12, passes: list };
  }
  // Demo album: four sample pictures, plus whatever is uploaded in this tab
  // (kept in memory). Hidden and deleted ones are remembered in this browser.
  var demoAlbumList = null;
  function demoAlbumState() {
    try { return JSON.parse(localStorage.getItem('kt-album-demo')) || { hidden: {}, gone: {} }; } catch (e) { return { hidden: {}, gone: {} }; }
  }
  function demoAlbum() {
    if (!demoAlbumList) {
      demoAlbumList = [];
      for (var i = 0; i < 4; i++) {
        var url = demoPhotoUrl(40 + i);
        demoAlbumList.push({ id: 'demo-album-' + i, ext: 'jpg', name: 'DSC_00' + (10 + i) + '.jpg', credit: 'Demo photographer',
          bytes: 6000000, uploaded_at: new Date(Date.parse('2026-11-22T10:00:00-08:00') + i * 60000).toISOString(),
          web_url: url, full_url: url });
      }
    }
    var st = demoAlbumState();
    return demoAlbumList.filter(function (a) { return !st.gone[a.id]; })
      .map(function (a) { return Object.assign({}, a, { hidden: !!st.hidden[a.id] }); });
  }
  function saveDemoAlbumState(st) { try { localStorage.setItem('kt-album-demo', JSON.stringify(st)); } catch (e) {} }
  function demoGalleryOpen() {
    try { return localStorage.getItem('kt-gallery-demo') === '1'; } catch (e) { return false; }
  }
  function demoFeatures() {
    var f = null;
    try { f = JSON.parse(localStorage.getItem('kt-features-demo')); } catch (e) {}
    f = f || {};
    ['schedule', 'details', 'songs', 'camera', 'wallet'].forEach(function (n) {
      if (!f[n]) f[n] = { on: true, opens_at: null, closes_at: null };
    });
    return f;
  }

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
                   album: r.album, artwork_url: r.artwork_url,
                   // Demo song details: made up, so the DJ view can show them.
                   duration_ms: r.duration_ms || (150 + (r.id * 37) % 120) * 1000,
                   bpm: r.spotify_id ? 90 + (r.id * 23) % 50 : null,
                   genre: r.spotify_id ? ['Pop', 'Dance', 'R&B', 'Rock', 'Disco'][r.id % 5] : null,
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
        details: function () { return later({ ok: true, filled: 0 }); },
        galleryPassword: function (key, password) {
          if (password != null && password.trim().length < 4) return fail('too_short', 'The password needs at least 4 characters.');
          return admin(key, function () {
            if (password != null) { try { localStorage.setItem('kt-gallery-pw-demo', password.trim().toLowerCase()); } catch (e) {} }
            return { set: true, phones: demoGalleryOpen() ? 1 : 0 };
          });
        },
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
        },
        camera: function (key) {
          return admin(key, function () {
            var c = cam();
            return { open: true, shots_per_pass: 12, uploaded: c.shots.filter(function (x) { return x.status === 'uploaded'; }).length };
          });
        },
        // Demo organizer screen: the schedule is kept where features.js reads
        // it in demo mode, so every demo page follows these settings.
        features: function (key) {
          return admin(key, function () {
            var f = demoFeatures(), c = cam();
            return { features: f, passes: 0, passes_claimed: 0,
                     camera: { open: true, shots_per_pass: 12, reveal_at: c.reveal_at || DEMO_REVEAL,
                               uploaded: c.shots.filter(function (x) { return x.status === 'uploaded'; }).length,
                               reserved: c.shots.filter(function (x) { return x.status === 'reserved'; }).length,
                               passes_shooting: c.shots.length ? 1 : 0, bytes: 0 } };
          });
        },
        setFeature: function (key, feature, on, opensAt, closesAt) {
          if (opensAt && closesAt && Date.parse(closesAt) <= Date.parse(opensAt)) {
            return fail('bad_times', 'The closing time has to be after the opening time.');
          }
          return admin(key, function () {
            var f = demoFeatures();
            f[feature] = { on: on !== false, opens_at: opensAt || null, closes_at: closesAt || null };
            try { localStorage.setItem('kt-features-demo', JSON.stringify(f)); } catch (e) {}
            return f;
          });
        },
        setCamera: function (key, settings) {
          return admin(key, function () {
            var c = cam();
            if (settings.photos_reveal_at) c.reveal_at = settings.photos_reveal_at === 'now' ? new Date().toISOString() : settings.photos_reveal_at;
            saveCam(c);
          });
        },
        // Demo rehearsal: fake test passes in localStorage. Their links open
        // the demo landing page with a pass.
        rehearsal: function (key) {
          return admin(key, function (s) {
            return { test_passes: demoTests(), test_photos: 0, real_photos: cam().shots.length,
                     song_requests: s.requests.length, votes: s.requests.reduce(function (n, r) { return n + r.voters.length; }, 0) };
          });
        },
        makeTestPasses: function (key, count) {
          var t = demoTests();
          for (var i = t.length + 1; i <= Math.min(count || 3, 10); i++) {
            t.push({ token: 'DemoTestPass' + ('0000' + i).slice(-4), name: 'Test Guest ' + i, shots_used: 0, phones: 0 });
          }
          try { localStorage.setItem('kt-rehearsal-demo', JSON.stringify(t)); } catch (e) {}
          return this.rehearsal(key);
        },
        resetTestPass: function (key) { saveCam({ shots: [] }); return admin(key, function () { return { ok: true, removed: 0 }; }); },
        deleteTestPasses: function (key) {
          try { localStorage.removeItem('kt-rehearsal-demo'); } catch (e) {}
          return admin(key, function () { return { ok: true, removed: 0 }; });
        },
        clearSongs: function (key, confirmWord) {
          if (confirmWord !== 'CLEAR') return fail('not_confirmed', 'Type CLEAR to empty the song board.');
          return admin(key, function (s) { var n = s.requests.length; s.requests = []; return { removed: n }; });
        },
        photos: function (key, includeTests) {
          return admin(key, function () { return demoPhotos(includeTests); });
        },
        hidePhoto: function (key, id, hidden) {
          return admin(key, function () {
            var h = demoPhotoHidden();
            if (hidden) h[id] = true; else delete h[id];
            try { localStorage.setItem('kt-photos-demo-hidden', JSON.stringify(h)); } catch (e) {}
            return { id: id, hidden: !!hidden };
          });
        },
        shots: function (key) { return admin(key, function () { return demoShots(); }); },
        albumList: function (key) {
          return admin(key, function () { return demoAlbum().slice().reverse(); });
        },
        albumUpload: function (key, file, credit) {
          var ext = albumExt(file);
          if (!key) return fail('not_organizer', 'That organizer link is not valid.');
          if (!ext) return fail('bad_type', 'JPEG, PNG or WebP photos only.');
          return KT.photoTools.webCopy(file).then(function (web) {
            demoAlbum();
            var a = { id: 'demo-up-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6), ext: ext, name: file.name,
                      credit: credit || null, bytes: file.size, uploaded_at: new Date().toISOString(),
                      web_url: URL.createObjectURL(web), full_url: URL.createObjectURL(file) };
            demoAlbumList.push(a);
            return later(a);
          });
        },
        albumHide: function (key, id, hidden) {
          return admin(key, function () {
            var st = demoAlbumState();
            if (hidden) st.hidden[id] = true; else delete st.hidden[id];
            saveDemoAlbumState(st);
            return { id: id, hidden: !!hidden };
          });
        },
        albumDelete: function (key, id) {
          return admin(key, function () { var st = demoAlbumState(); st.gone[id] = true; saveDemoAlbumState(st); return { ok: true }; });
        },
        resetShots: function (key, token) {
          return admin(key, function () {
            var r = demoResets(), list = demoShots().passes, now = new Date().toISOString();
            if (token && !list.some(function (x) { return x.token === token; })) return null;
            list.forEach(function (x) { if (!token || x.token === token) r[x.token] = now; });
            try { localStorage.setItem('kt-shots-demo-reset', JSON.stringify(r)); } catch (e) {}
            return { reset: token ? 1 : list.length };
          });
        }
      },
      // Demo camera: the same rules, kept in localStorage. Uploads "fail"
      // while the browser is offline, so the retry queue can be rehearsed.
      camera: {
        status: function () {
          var pass = storedPass();
          if (pass) { var s0 = load(); s0.me = { name: 'Guest with pass', from_pass: true }; save(s0); forgetPass(); }
          var s = load(), c = cam();
          var used = demoUsed();
          var reveal = c.reveal_at || DEMO_REVEAL;
          var revealed = (KT.now ? KT.now() : new Date()).getTime() >= Date.parse(reveal);
          return later({ open: true, has_pass: !!s.me.from_pass, first_name: s.me.from_pass ? 'Guest' : null,
                         shots_per_pass: 12, used: used, left: Math.max(0, 12 - used),
                         uploaded: c.shots.filter(function (x) { return x.status === 'uploaded'; }).length,
                         reveal_at: reveal, revealed: revealed,
                         shots: c.shots.map(function (x) { return { client_id: x.client_id, status: x.status }; }) });
        },
        reserve: function (clientId) {
          var s = load(), c = cam();
          if (!s.me.from_pass) return fail('no_pass', 'Scan the QR on your boarding pass to use the camera.');
          var shot = c.shots.filter(function (x) { return x.client_id === clientId; })[0];
          if (!shot) {
            if (demoUsed() >= 12) return fail('out_of_shots', 'That’s all 12 shots on this pass. Thank you!');
            shot = { client_id: clientId, photo_id: 'demo-' + clientId, status: 'reserved', at: Date.now() };
            c.shots.push(shot); saveCam(c);
          }
          return later({ ok: true, photo_id: shot.photo_id, path: shot.photo_id + '.jpg', status: shot.status,
                         left: Math.max(0, 12 - demoUsed()),
                         upload: shot.status === 'uploaded' ? null : { path: shot.photo_id + '.jpg', token: 'demo' } });
        },
        upload: function () {
          if (!navigator.onLine) return fail('upload_failed', 'The upload didn’t finish. We’ll try again.');
          return later({});
        },
        confirm: function (photoId) {
          var c = cam();
          c.shots.forEach(function (x) { if (x.photo_id === photoId) x.status = 'uploaded'; });
          saveCam(c);
          return later({ photo_id: photoId, status: 'uploaded' });
        },
        // Demo password: "kt1121", or whatever the demo organizer screen set.
        galleryStatus: function () {
          var pass = storedPass();
          if (pass) { var s0 = load(); s0.me = { name: 'Guest with pass', from_pass: true }; save(s0); forgetPass(); }
          var has = !!load().me.from_pass, reveal = cam().reveal_at || DEMO_REVEAL;
          return later({ has_pass: has, access: has || demoGalleryOpen(), password_set: true, reveal_at: reveal,
                         revealed: (KT.now ? KT.now() : new Date()).getTime() >= Date.parse(reveal) });
        },
        unlockGallery: function (password) {
          var want = 'kt1121';
          try { want = localStorage.getItem('kt-gallery-pw-demo') || want; } catch (e) {}
          if (String(password || '').trim().toLowerCase() !== want) {
            return fail('wrong_password', 'That isn’t the password. It’s the same one as our wedding website on Zola.');
          }
          try { localStorage.setItem('kt-gallery-demo', '1'); } catch (e) {}
          return later({ access: true });
        },
        gallery: function () {
          var revealed = (KT.now ? KT.now() : new Date()).getTime() >= Date.parse(cam().reveal_at || DEMO_REVEAL);
          if (!load().me.from_pass && !demoGalleryOpen()) return fail('no_access', 'Enter the password, or scan the QR on your boarding pass, to see the photos.');
          if (!revealed) return fail('not_revealed', 'The photos aren’t out yet.');
          return later({ ok: true, photos: demoPhotos(false).filter(function (p) { return !p.hidden; })
            .map(function (p) { return { path: p.path, url: p.url }; }),
            album: demoAlbum().filter(function (a) { return !a.hidden; }) });
        }
      },
      // Demo pass: a sample guest once a ?pass= link was opened. The Wallet
      // buttons appear but don't download anything.
      wallet: {
        card: function () {
          var pass = storedPass();
          if (pass) { var s0 = load(); s0.me = { name: 'Guest with pass', from_pass: true }; save(s0); forgetPass(); }
          if (!load().me.from_pass) return later({ has_pass: false });
          var f = demoFeatures().wallet, now = (KT.now ? KT.now() : new Date()).getTime();
          var state = !f.on ? 'off' : f.opens_at && now < Date.parse(f.opens_at) ? 'soon'
            : f.closes_at && now >= Date.parse(f.closes_at) ? 'closed' : 'open';
          return later({ has_pass: true, token: 'demo', first_name: 'Dora', last_name: 'Day',
                         pass_name: 'DAY/DORA', strip_name: 'DORA D.', table_number: 5, gate: 'P05',
                         seat: '005A', cabin: 'F', destination_city: 'Santorini', destination_code: 'JTR',
                         ssr_remarks: 'Demo pass: this is what a guest sees.', wallet_state: state,
                         apple_ready: state === 'open', google_save_url: state === 'open' ? '#google-demo' : null });
        },
        appleUrl: function () { return '#apple-demo'; }
      }
    };
  }

  var client = null;
  // Whenever the server says whether this phone has a pass, tell site.js,
  // which shows "My pass" in the header from then on (or takes it away).
  function remembersPass(api) {
    var note = function (r) { if (r && 'has_pass' in r && KT.setHasPass) KT.setHasPass(!!r.has_pass); return r; };
    var card = api.wallet.card, status = api.camera.status, gstatus = api.camera.galleryStatus;
    api.wallet.card = function () { return card.apply(this, arguments).then(note); };
    api.camera.status = function () { return status.apply(this, arguments).then(note); };
    api.camera.galleryStatus = function () {
      // Only a "yes" counts here: a phone let in by password has no pass.
      return gstatus.apply(this, arguments).then(function (r) { if (r && r.has_pass && KT.setHasPass) KT.setHasPass(true); return r; });
    };
    return api;
  }

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
    if (demo || !(cfg.supabaseUrl && cfg.supabaseAnonKey)) return (client = remembersPass(demoClient()));
    if (window.supabase) return (client = remembersPass(liveClient(cfg)));
    // Configured, but the Supabase library didn't load (blocked CDN, bad
    // signal). Never fall back to the demo here: guests would think their
    // requests went through.
    var down = function () { return Promise.reject(refusal('unavailable', 'We couldn’t connect. Check your signal and reload the page.')); };
    return (client = { mode: 'offline', init: function () { return Promise.resolve(); }, board: down, search: down,
      request: down, vote: down,
      admin: { board: down, details: down, galleryPassword: down, setStatus: down, updateEvent: down, addRule: down, deleteRule: down, camera: down,
               features: down, setFeature: down, setCamera: down, rehearsal: down, makeTestPasses: down,
               resetTestPass: down, deleteTestPasses: down, clearSongs: down, photos: down, hidePhoto: down,
               shots: down, resetShots: down, albumList: down, albumUpload: down, albumHide: down, albumDelete: down },
      camera: { status: down, reserve: down, upload: down, confirm: down, gallery: down, galleryStatus: down, unlockGallery: down },
      wallet: { card: down, appleUrl: function () { return '#'; } } });
  };
})();
