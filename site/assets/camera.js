/* Disposable camera: take a shot with the phone's own camera app, keep it on
 * the phone (IndexedDB) until the server confirms it, never show it.
 *
 * Each shot: resize + re-encode (strips location data) -> saved on this phone
 * -> reserve its slot (same client_id on every retry) -> upload to the signed
 * URL -> confirm. Retries on reconnect, on returning to the page, and every
 * 20 seconds while anything is waiting. A shot only leaves the phone's queue
 * after the server says it is uploaded.
 */
(function () {
  'use strict';
  var KT = window.KT;
  if (KT.feature && KT.feature('camera') !== 'open') { KT.whenOpen('camera', function () {}); return; }

  var api = KT.songsClient();
  var $ = function (id) { return document.getElementById(id); };
  var MAX_EDGE = 2048, QUALITY = 0.85, MAX_BYTES = 7.5 * 1024 * 1024;
  var server = null;      // camera_status() from the database
  var local = [];         // shots still on this phone (IndexedDB rows)
  var working = false, lastProblem = null, retryTimer = null;

  if (api.mode === 'demo') $('demo-note').hidden = false;
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}

  /* --------------------------------------------------------- IndexedDB -- */
  var dbp = null;
  function db() {
    if (!dbp) {
      dbp = new Promise(function (ok, no) {
        var req = indexedDB.open('kt-camera', 1);
        req.onupgradeneeded = function () { req.result.createObjectStore('shots', { keyPath: 'client_id' }); };
        req.onsuccess = function () { ok(req.result); };
        req.onerror = function () { no(req.error); };
      });
    }
    return dbp;
  }
  function tx(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (ok, no) {
        var t = d.transaction('shots', mode), store = t.objectStore('shots'), out = fn(store);
        t.oncomplete = function () { ok(out && out.result !== undefined ? out.result : undefined); };
        t.onerror = function () { no(t.error); };
        t.onabort = function () { no(t.error); };
      });
    });
  }
  function loadLocal() {
    return tx('readonly', function (s) { return s.getAll(); })
      .then(function (rows) { local = (rows || []).sort(function (a, b) { return a.created - b.created; }); });
  }
  function putLocal(rec) { return tx('readwrite', function (s) { return s.put(rec); }); }
  function dropLocal(id) { return tx('readwrite', function (s) { return s.delete(id); }); }

  /* ------------------------------------------------------------ helpers -- */
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function notice(tone, title, body) {
    var mark = { info: 'i', success: '✓', warning: '!', danger: '×' }[tone];
    $('message').innerHTML = !body ? '' : '<div class="kt-notice kt-notice-' + tone + '">' +
      '<span class="kt-notice-mark" aria-hidden="true">' + mark + '</span>' +
      '<span class="kt-notice-title">' + esc(title) + '</span>' +
      '<p class="kt-notice-body">' + esc(body) + '</p></div>';
  }
  function revealText(iso) {
    if (!iso) return '';
    var d = new Date(iso), tz = { timeZone: 'America/Los_Angeles' };
    return d.toLocaleDateString('en-US', Object.assign({ weekday: 'long', month: 'long', day: 'numeric' }, tz)) +
      ' at ' + d.toLocaleTimeString('en-US', Object.assign({ hour: 'numeric', minute: '2-digit' }, tz));
  }

  // Resize to MAX_EDGE and re-encode as JPEG. Drawing to a canvas also drops
  // the EXIF block, so no location data leaves the phone.
  function prepare(file) {
    var bitmap = window.createImageBitmap
      ? createImageBitmap(file, { imageOrientation: 'from-image' }).catch(function () { return viaImage(file); })
      : viaImage(file);
    return bitmap.then(function (img) {
      var w = img.width, h = img.height, k = Math.min(1, MAX_EDGE / Math.max(w, h));
      var c = document.createElement('canvas');
      c.width = Math.round(w * k); c.height = Math.round(h * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      if (img.close) img.close();
      var encode = function (q) {
        return new Promise(function (ok, no) {
          c.toBlob(function (b) { b ? ok(b) : no(new Error('encode')); }, 'image/jpeg', q);
        });
      };
      return encode(QUALITY).then(function (b) { return b.size > MAX_BYTES ? encode(0.7) : b; });
    });
  }
  function viaImage(file) {
    return new Promise(function (ok, no) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); ok(img); };
      img.onerror = function () { URL.revokeObjectURL(url); no(new Error('decode')); };
      img.src = url;
    });
  }

  /* ------------------------------------------------------------- render -- */
  function pending() { return local.filter(function (r) { return r.status !== 'refused'; }); }
  function shotsLeft() {
    if (!server) return 0;
    var known = {};
    (server.shots || []).forEach(function (s) { known[s.client_id] = true; });
    var notYetReserved = pending().filter(function (r) { return !known[r.client_id]; }).length;
    return Math.max(0, server.left - notYetReserved);
  }

  function render() {
    if (!server) return;
    $('loading').hidden = true;
    var hasPass = server.has_pass;
    $('no-pass').hidden = hasPass;
    $('camera').hidden = !hasPass;
    $('shots-section').hidden = !hasPass;
    if (!hasPass) return;

    var left = shotsLeft();
    $('left').textContent = left;
    $('left-label').textContent = left === 1 ? 'Shot left' : 'Shots left';
    var canShoot = server.open && left > 0;
    $('shot').disabled = !canShoot;
    $('shutter').setAttribute('aria-disabled', canShoot ? 'false' : 'true');
    $('shutter-word').textContent = !server.open ? 'Camera closed' : left > 0 ? 'Take a photo' : 'All shots taken';
    $('shutter-hint').hidden = !canShoot;

    // One row per shot: the server's list (oldest first), then shots this
    // phone hasn't managed to reserve yet.
    var byId = {};
    local.forEach(function (r) { byId[r.client_id] = r; });
    var rows = (server.shots || []).map(function (s) { return { id: s.client_id, server: s.status, mine: byId[s.client_id] }; });
    var listed = {};
    rows.forEach(function (r) { listed[r.id] = true; });
    local.forEach(function (r) { if (!listed[r.client_id]) rows.push({ id: r.client_id, server: null, mine: r }); });

    $('shots').innerHTML = rows.length ? rows.map(function (r, i) {
      var word, tone;
      if (r.server === 'uploaded') { word = '✓ Uploaded'; tone = 'is-up'; }
      else if (r.mine && r.mine.status === 'refused') { word = 'Not uploaded'; tone = 'is-no'; }
      else if (r.mine && r.mine.status === 'uploading') { word = 'Uploading…'; tone = 'is-wait'; }
      else if (r.mine) { word = 'Saved on this phone'; tone = 'is-wait'; }
      else { word = 'On another phone'; tone = ''; }
      return '<li><span class="cam-shot-name">Shot ' + (i + 1) + '</span><span class="cam-state ' + tone + '">' + word + '</span></li>';
    }).join('') : '<li class="cam-empty">No shots yet.</li>';

    var waiting = pending().length;
    if (!server.open && !waiting) notice('warning', 'Camera closed', 'The camera is closed right now.');
    else if (waiting) {
      notice('warning', 'Keep this page open', lastProblem
        ? lastProblem + ' Your ' + (waiting === 1 ? 'photo is' : waiting + ' photos are') + ' safe on this phone.'
        : 'Uploading ' + (waiting === 1 ? 'your photo' : waiting + ' photos') + '. Leave this page open until every shot says Uploaded.');
    } else if (server.used && left === 0) notice('success', 'That’s a wrap', 'All your shots are in. Thank you!');
    else notice('info', '', '');

    $('reveal-line').innerHTML = server.revealed
      ? 'The photos are out! <a class="kt-link" href="/photos/">See everyone’s photos</a>.'
      : 'We’ll share everyone’s photos on ' + esc(revealText(server.reveal_at)) + '.';
  }

  function refresh() {
    return api.camera.status().then(function (s) { server = s; render(); })
      .catch(function (err) {
        if (!server) { $('loading').textContent = err.message; }
      });
  }

  /* -------------------------------------------------------------- queue -- */
  function work() {
    if (working) return Promise.resolve();
    var queue = pending().filter(function (r) { return r.status !== 'uploaded'; });
    if (!queue.length) return Promise.resolve();
    working = true;
    var step = function (i) {
      if (i >= queue.length) return Promise.resolve();
      var rec = queue[i];
      rec.status = 'uploading'; render();
      return api.camera.reserve(rec.client_id)
        .then(function (slot) {
          return (slot.upload ? api.camera.upload(slot.upload, rec.blob) : Promise.resolve())
            .then(function () { return api.camera.confirm(slot.photo_id); });
        })
        .then(function () {
          lastProblem = null;
          local = local.filter(function (r) { return r.client_id !== rec.client_id; });
          return dropLocal(rec.client_id).then(refresh).then(function () { return step(i + 1); });
        })
        .catch(function (err) {
          // Final answers from the server: this shot will never upload.
          if (['out_of_shots', 'not_yours', 'no_pass'].indexOf(err.code) >= 0) {
            rec.status = 'refused'; rec.blob = null; lastProblem = null;
            notice('danger', 'Not uploaded', err.message);
            return putLocal(rec).then(function () { return step(i + 1); });
          }
          // Anything else (signal, timeouts): keep it, try again later.
          rec.status = 'saved'; lastProblem = err.message;
          return putLocal(rec);
        });
    };
    return step(0).then(function () { working = false; render(); }, function () { working = false; render(); });
  }

  function scheduleRetry() {
    clearInterval(retryTimer);
    retryTimer = setInterval(function () {
      if (pending().some(function (r) { return r.status !== 'refused'; })) work();
    }, 20000);
  }

  /* ------------------------------------------------------------- events -- */
  $('shot').addEventListener('change', function () {
    var file = this.files && this.files[0];
    this.value = '';
    if (!file) return;
    if (shotsLeft() <= 0) { notice('danger', 'All shots taken', 'That was your last shot on this pass.'); return; }
    prepare(file).then(function (blob) {
      var rec = { client_id: uuid(), created: Date.now(), status: 'saved', blob: blob };
      local.push(rec);
      render();
      return putLocal(rec).then(work);
    }).catch(function () {
      notice('danger', 'Not quite', 'We couldn’t read that photo. Try taking it again.');
    });
  });

  window.addEventListener('online', function () { work(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { refresh().then(work); } });
  window.addEventListener('beforeunload', function (e) {
    if (pending().some(function (r) { return r.status !== 'refused'; })) { e.preventDefault(); e.returnValue = ''; }
  });

  loadLocal()
    .then(function () {
      // A reload mid-upload leaves rows marked "uploading": they're just waiting.
      local.forEach(function (r) { if (r.status === 'uploading') r.status = 'saved'; });
    })
    .catch(function () { local = []; })
    .then(refresh)
    .then(function () { scheduleRetry(); return work(); });
})();
