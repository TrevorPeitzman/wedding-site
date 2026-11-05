/* Organizer screen: feature switches and times, camera settings, the reveal,
 * every photo with who took it (hide one, download some or all), rehearsal.
 * The key arrives once as /admin/#key=<key> and is kept in this browser.
 * Every input and label is in Pacific time, whatever the laptop's zone. */
(function () {
  'use strict';
  var KT = window.KT;
  var api = KT.songsClient();
  var STORE = 'kt-org-key', TZ = 'America/Los_Angeles';
  var $ = function (id) { return document.getElementById(id); };
  var key = null, data = null, toastTimer = null;
  var LABELS = { schedule: 'Schedule', details: 'Details', songs: 'Song requests', camera: 'Camera', wallet: 'Wallet pass' };
  var NOTES = {
    schedule: 'The timeline and room map.',
    details: 'Venue, dress code and the other details.',
    songs: 'Requests and votes. The database refuses them outside these times.',
    camera: 'New shots. The database refuses them outside these times; shots already taken still upload.',
    wallet: 'The Add to Wallet button on the boarding-pass page.'
  };

  if (api.mode === 'demo') $('demo-note').hidden = false;
  try {
    var m = location.hash.match(/key=([^&]+)/);
    if (m) { localStorage.setItem(STORE, decodeURIComponent(m[1])); history.replaceState(null, '', location.pathname + location.search); }
    key = localStorage.getItem(STORE);
  } catch (e) {}

  /* ------------------------------------------------- Pacific time helpers -- */
  var fmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  function parts(d) {
    var o = {};
    fmt.formatToParts(d).forEach(function (p) { o[p.type] = p.value; });
    return o;
  }
  // ISO instant -> "2026-11-21T17:45" as a Pacific wall clock, for datetime-local.
  function toInput(iso) {
    if (!iso) return '';
    var p = parts(new Date(iso));
    return p.year + '-' + p.month + '-' + p.day + 'T' + p.hour + ':' + p.minute;
  }
  // "2026-11-21T17:45" read as Pacific -> ISO instant.
  function fromInput(v) {
    if (!v) return null;
    var guess = Date.parse(v + ':00Z');
    var p = parts(new Date(guess));
    var asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
    return new Date(guess - (asUtc - guess)).toISOString();
  }
  function say(iso) {
    var d = new Date(iso);
    return d.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' }) + ', ' +
      d.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
  }

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(message, ok) {
    $('toast').innerHTML = '<div class="kt-notice kt-notice-' + (ok === false ? 'danger' : 'success') + '"><span class="kt-notice-mark" aria-hidden="true">' +
      (ok === false ? '×' : '✓') + '</span><span class="kt-notice-title">' + (ok === false ? 'Not quite' : 'Done') +
      '</span><p class="kt-notice-body">' + esc(message) + '</p></div>';
    $('toast').classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { $('toast').classList.remove('is-on'); }, 3500);
  }
  function showKeyForm(message) {
    $('admin').hidden = true;
    $('key-form').hidden = false;
    $('key-error').hidden = !message;
    $('key-error').textContent = message || '';
  }

  /* -------------------------------------------------------------- render -- */
  function stateOf(f) {
    var now = (KT.now ? KT.now() : new Date()).getTime();
    if (!f.on) return ['Off', 'is-off'];
    if (f.opens_at && now < Date.parse(f.opens_at)) return ['Opens ' + say(f.opens_at), 'is-soon'];
    if (f.closes_at && now >= Date.parse(f.closes_at)) return ['Closed ' + say(f.closes_at), 'is-off'];
    return [f.closes_at ? 'Open until ' + say(f.closes_at) : 'Open', 'is-open'];
  }

  function featureCard(name, f) {
    var st = stateOf(f);
    return '<form class="kt-card adm-feature" data-feature-form="' + name + '">' +
      '<div class="adm-head"><h3 class="kt-card-title">' + LABELS[name] + '</h3>' +
      '<span class="adm-state ' + st[1] + '">' + esc(st[0]) + '</span></div>' +
      '<p class="kt-hint">' + NOTES[name] + '</p>' +
      '<label class="kt-choice"><input type="checkbox" name="on"' + (f.on ? ' checked' : '') + '><span>On</span></label>' +
      '<div class="adm-times">' +
      '<div class="kt-field"><label class="kt-label" for="o-' + name + '">Opens <span class="kt-opt">(blank: now)</span></label>' +
      '<input class="kt-input" id="o-' + name + '" name="opens" type="datetime-local" value="' + toInput(f.opens_at) + '"></div>' +
      '<div class="kt-field"><label class="kt-label" for="c-' + name + '">Closes <span class="kt-opt">(blank: never)</span></label>' +
      '<input class="kt-input" id="c-' + name + '" name="closes" type="datetime-local" value="' + toInput(f.closes_at) + '"></div>' +
      '</div>' +
      '<div><button class="kt-btn kt-btn-secondary kt-btn-sm" type="submit">Save ' + LABELS[name].toLowerCase() + '</button></div>' +
      '</form>';
  }

  function render() {
    var f = data.features || {};
    $('features').innerHTML = Object.keys(LABELS).map(function (n) {
      return featureCard(n, f[n] || { on: true, opens_at: null, closes_at: null });
    }).join('');
    var c = data.camera || {};
    var mb = Math.round((c.bytes || 0) / 1048576);
    $('camera-stats').innerHTML =
      '<dt>Uploaded</dt><dd>' + (c.uploaded || 0) + ' photos' + (mb ? ' · ' + mb + ' MB' : '') + '</dd>' +
      '<dt>Still uploading</dt><dd>' + (c.reserved || 0) + '</dd>' +
      '<dt>Passes shooting</dt><dd>' + (c.passes_shooting || 0) + ' of ' + (data.passes || 0) +
      ' (' + (data.passes_claimed || 0) + ' scanned)</dd>' +
      '<dt>Photos out</dt><dd>' + (c.reveal_at ? say(c.reveal_at) : 'Not set') + '</dd>';
    if (document.activeElement && document.activeElement.closest && document.activeElement.closest('#camera-form')) return;
    $('shots').value = c.shots_per_pass == null ? '' : c.shots_per_pass;
    $('reveal').value = toInput(c.reveal_at);
  }

  function load() {
    if (!key) { showKeyForm(); return Promise.resolve(); }
    if (key.length < 16) {
      key = null; try { localStorage.removeItem(STORE); } catch (e) {}
      showKeyForm('Organizer keys are at least 16 characters. Set a longer one in the SQL editor, then use it here.');
      return Promise.resolve();
    }
    return api.admin.features(key).then(function (d) {
      data = d; $('key-form').hidden = true; $('admin').hidden = false; render(); loadRehearsal();
      $('updated').textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }).catch(function (err) {
      if (err.code === 'not_organizer') {
        key = null; try { localStorage.removeItem(STORE); } catch (e) {}
        showKeyForm(err.message);
      } else if (!data) showKeyForm(err.message);
      else toast(err.message, false);
    });
  }

  /* -------------------------------------------------------------- events -- */
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

  $('features').addEventListener('submit', function (ev) {
    var form = ev.target.closest('form[data-feature-form]');
    if (!form) return;
    ev.preventDefault();
    var name = form.getAttribute('data-feature-form');
    api.admin.setFeature(key, name, form.on.checked, fromInput(form.opens.value), fromInput(form.closes.value))
      .then(function () {
        // The next page this browser opens should follow the change at once.
        try { localStorage.removeItem('kt-features-server'); } catch (e) {}
        toast(LABELS[name] + ' saved.');
        return load();
      })
      .catch(function (err) { toast(err.message, false); });
  });

  $('camera-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var settings = {};
    if ($('shots').value !== '') settings.shots_per_pass = Math.max(0, Math.round(Number($('shots').value)));
    if ($('reveal').value) settings.photos_reveal_at = fromInput($('reveal').value);
    api.admin.setCamera(key, settings)
      .then(function () { toast('Camera saved.'); document.activeElement.blur(); return load(); })
      .catch(function (err) { toast(err.message, false); });
  });

  $('release').addEventListener('click', function () {
    if (!confirm('Release everyone’s photos now? Every guest with a pass can see them from this moment.')) return;
    api.admin.setCamera(key, { photos_reveal_at: 'now' })
      .then(function () { toast('The photos are out.'); return load(); })
      .catch(function (err) { toast(err.message, false); });
  });

  /* -------------------------------------------------------------- photos -- */
  // Loaded on demand (signed links last an hour; "Refresh photos" renews them).
  var PAGE = 60;
  var ph = { all: null, shown: PAGE, picked: {}, busy: false, ask: null };
  function phName(p) { return [p.first_name, p.last_name].filter(Boolean).join(' ') || 'Guest'; }
  function phWhen(iso) {
    var d = new Date(iso);
    return d.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short' }) + ' ' +
      d.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
  }
  function phFile(p) {
    var t = parts(new Date(p.uploaded_at));
    var table = p.is_test ? 'Test' : p.table_number != null ? 'T' + ('0' + p.table_number).slice(-2) : 'T00';
    var who = [KT.photoTools.slug(p.first_name), KT.photoTools.slug(p.last_name)].filter(Boolean).join('-') || 'Guest';
    return table + '-' + who + '-' + t.hour + t.minute + '-' + String(p.id).replace(/-/g, '').slice(0, 6) + '.jpg';
  }
  function phFiltered() {
    var table = $('photo-table').value, hiddenOnly = $('photo-hidden-only').checked;
    return (ph.all || []).filter(function (p) {
      if (table === 'test' ? !p.is_test : table && String(p.table_number) !== table) return false;
      return !hiddenOnly || p.hidden;
    });
  }
  function phPicked() {
    return (ph.all || []).filter(function (p) { return ph.picked[p.id]; });
  }
  function phTile(p) {
    return '<li class="adm-photo' + (p.hidden ? ' is-hidden' : '') + (ph.picked[p.id] ? ' is-picked' : '') + '">' +
      '<a class="adm-thumb" href="' + esc(p.url) + '" target="_blank" rel="noopener">' +
      '<img src="' + esc(p.url) + '" loading="lazy" alt="Photo by ' + esc(phName(p)) + ', ' + esc(phWhen(p.uploaded_at)) + '"></a>' +
      '<p class="adm-cap"><span class="cam-shot-name">' + esc(phName(p)) + '</span>' +
      '<span>' + (p.is_test ? 'Test pass' : p.table_number != null ? 'Table ' + esc(p.table_number) : 'No table') +
      ' · ' + esc(phWhen(p.uploaded_at)) + '</span>' +
      (p.hidden ? '<span class="cam-state is-no">Hidden</span>' : '') + '</p>' +
      '<div class="adm-photo-act">' +
      '<label class="kt-choice"><input type="checkbox" data-pick="' + esc(p.id) + '"' + (ph.picked[p.id] ? ' checked' : '') + '><span>Select</span></label>' +
      '<button class="kt-btn kt-btn-quiet kt-btn-sm" type="button" data-hide="' + esc(p.id) + '">' + (p.hidden ? 'Show' : 'Hide') + '</button>' +
      '</div></li>';
  }
  function phCount() {
    var list = phFiltered(), picked = phPicked().length;
    var hidden = list.filter(function (p) { return p.hidden; }).length;
    $('photo-count').textContent = list.length + ' photo' + (list.length === 1 ? '' : 's') +
      (hidden ? ' · ' + hidden + ' hidden' : '') + (picked ? ' · ' + picked + ' selected' : '');
    $('photo-pick-all').textContent = list.length && list.every(function (p) { return ph.picked[p.id]; }) ? 'Select none' : 'Select all';
    $('photo-pick-all').disabled = !list.length;
    if (!ph.ask) {
      $('photo-save-picked').textContent = picked ? 'Download selected (' + picked + ')' : 'Download selected';
      $('photo-save-picked').disabled = !picked || ph.busy;
      $('photo-save-all').textContent = list.length ? 'Download all (' + list.length + ')' : 'Download all';
      $('photo-save-all').disabled = !list.length || ph.busy;
    }
  }
  function phRender() {
    var list = phFiltered();
    $('photos').innerHTML = list.length ? list.slice(0, ph.shown).map(phTile).join('')
      : '<li class="cam-empty">' + (ph.all.length ? 'No photos match.' : 'No photos yet.') + '</li>';
    $('photos').hidden = false;
    $('photo-more-wrap').hidden = list.length <= ph.shown;
    $('photo-more').textContent = 'Show more (' + (list.length - ph.shown) + ' left)';
    phCount();
  }
  function phTables() {
    var sel = $('photo-table'), keep = sel.value, seen = {};
    (ph.all || []).forEach(function (p) { if (!p.is_test && p.table_number != null) seen[p.table_number] = true; });
    var nums = Object.keys(seen).map(Number).sort(function (a, b) { return a - b; });
    var hasTest = (ph.all || []).some(function (p) { return p.is_test; });
    sel.innerHTML = '<option value="">All tables</option>' + nums.map(function (n) {
      return '<option value="' + n + '">Table ' + n + '</option>';
    }).join('') + (hasTest ? '<option value="test">Test passes</option>' : '');
    sel.value = keep;
    if (sel.value !== keep) sel.value = '';
  }
  function loadPhotos() {
    $('photos-load').disabled = true;
    return api.admin.photos(key, $('photo-tests').checked).then(function (list) {
      ph.all = list;
      var ids = {};
      list.forEach(function (p) { ids[p.id] = true; });
      Object.keys(ph.picked).forEach(function (id) { if (!ids[id]) delete ph.picked[id]; });
      $('photo-tools').hidden = false;
      $('photo-save-picked').hidden = false;
      $('photo-save-all').hidden = false;
      $('photos-load').textContent = 'Refresh photos';
      phTables(); phRender();
    }).catch(function (err) { toast(err.message, false); })
      .then(function () { $('photos-load').disabled = false; });
  }
  function phSave(list, zipName, button) {
    if (ph.busy || !list.length) return;
    ph.busy = true; phCount();
    var progress = $('photo-progress');
    progress.hidden = false; progress.textContent = 'Getting ready…';
    KT.photoTools.save(list.map(function (p) { return { url: p.url, name: phFile(p), date: new Date(p.uploaded_at) }; }), {
      zipName: zipName,
      onProgress: function (done, total, label) { progress.textContent = label + ' ' + done + ' of ' + total + '…'; },
      ask: function (label) {
        return new Promise(function (ok) {
          ph.ask = function () { ph.ask = null; ok(); };
          button.textContent = label; button.disabled = false;
          progress.textContent = 'Ready. Tap “' + label + '”.';
        });
      }
    }).then(function (r) {
      if (r.how === 'cancelled') { toast('Nothing saved.', false); return; }
      var msg = 'Saved ' + r.saved + ' photo' + (r.saved === 1 ? '' : 's') + (r.how === 'zip' ? ' as .zip' : '') + '.';
      if (r.failed) msg += ' ' + r.failed + ' didn’t download: press Refresh photos and try again.';
      toast(msg, r.saved ? true : false);
    }).catch(function (err) {
      toast((err && err.message) || 'That didn’t work. Try again?', false);
    }).then(function () {
      ph.busy = false; ph.ask = null; progress.hidden = true; phCount();
    });
  }

  $('photos-load').addEventListener('click', loadPhotos);
  $('photo-tests').addEventListener('change', loadPhotos);
  $('photo-table').addEventListener('change', function () { ph.shown = PAGE; phRender(); });
  $('photo-hidden-only').addEventListener('change', function () { ph.shown = PAGE; phRender(); });
  $('photo-more').addEventListener('click', function () { ph.shown += PAGE; phRender(); });
  $('photo-pick-all').addEventListener('click', function () {
    var list = phFiltered(), all = list.every(function (p) { return ph.picked[p.id]; });
    list.forEach(function (p) { if (all) delete ph.picked[p.id]; else ph.picked[p.id] = true; });
    phRender();
  });
  $('photos').addEventListener('change', function (ev) {
    var id = ev.target.getAttribute('data-pick');
    if (!id) return;
    if (ev.target.checked) ph.picked[id] = true; else delete ph.picked[id];
    ev.target.closest('.adm-photo').classList.toggle('is-picked', ev.target.checked);
    phCount();
  });
  $('photos').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-hide]');
    if (!b) return;
    var p = (ph.all || []).filter(function (x) { return String(x.id) === b.dataset.hide; })[0];
    if (!p) return;
    b.disabled = true;
    api.admin.hidePhoto(key, p.id, !p.hidden).then(function (r) {
      p.hidden = r.hidden;
      toast(r.hidden ? 'Hidden from the guest gallery.' : 'Back in the guest gallery.');
      phRender();
    }).catch(function (err) { b.disabled = false; toast(err.message, false); });
  });
  $('photo-save-picked').addEventListener('click', function () {
    if (ph.ask) return ph.ask();
    phSave(phPicked(), 'KT1121-selected', this);
  });
  $('photo-save-all').addEventListener('click', function () {
    if (ph.ask) return ph.ask();
    var list = phFiltered(), t = $('photo-table').value;
    if (list.length > 100 && !confirm('Download ' + list.length + ' photos? They come as .zip files of 100 each; keep this tab open until they’re done.')) return;
    phSave(list, 'KT1121-photos' + (t === 'test' ? '-test' : t ? '-table-' + t : ''), this);
  });

  /* ----------------------------------------------------------- rehearsal -- */
  var SITE = 'https://wedding.peitzman.net';
  function renderRehearsal(r) {
    var list = r.test_passes || [];
    $('test-passes').innerHTML = list.length ? list.map(function (t) {
      var link = (location.origin.indexOf('localhost') >= 0 ? location.origin : SITE) + '/p/?pass=' + t.token;
      return '<li class="adm-pass"><span class="cam-shot-name">' + esc(t.name) + '</span>' +
        '<span class="cam-state">' + t.shots_used + ' shot' + (t.shots_used === 1 ? '' : 's') + ' · ' +
        t.phones + ' phone' + (t.phones === 1 ? '' : 's') + '</span>' +
        '<a class="kt-link" href="' + esc(link) + '" target="_blank" rel="noopener">' + esc(link) + '</a>' +
        '<div class="adm-row"><button class="kt-btn kt-btn-quiet kt-btn-sm" type="button" data-copy="' + esc(link) + '">Copy link</button>' +
        '<button class="kt-btn kt-btn-quiet kt-btn-sm" type="button" data-reset="' + esc(t.token) + '">Reset shots</button></div></li>';
    }).join('') : '<li class="cam-empty">No test passes yet.</li>';
    $('rehearsal-stats').innerHTML =
      '<dt>Song board</dt><dd>' + r.song_requests + ' requests · ' + r.votes + ' votes</dd>' +
      '<dt>Photos</dt><dd>' + r.real_photos + ' from guests · ' + r.test_photos + ' from test passes</dd>';
    $('make-tests').textContent = list.length >= 3 ? 'Test passes ready' : 'Make 3 test passes';
    $('make-tests').disabled = list.length >= 3;
  }
  function loadRehearsal() {
    if (!key) return Promise.resolve();
    return api.admin.rehearsal(key).then(renderRehearsal).catch(function () {});
  }
  $('make-tests').addEventListener('click', function () {
    api.admin.makeTestPasses(key, 3).then(function (r) { renderRehearsal(r); toast('Test passes ready.'); })
      .catch(function (err) { toast(err.message, false); });
  });
  $('test-passes').addEventListener('click', function (ev) {
    var copy = ev.target.closest('[data-copy]'), reset = ev.target.closest('[data-reset]');
    if (copy) {
      (navigator.clipboard ? navigator.clipboard.writeText(copy.dataset.copy) : Promise.reject())
        .then(function () { toast('Link copied.'); }, function () { toast('Copy it from the link above.', false); });
    }
    if (reset) {
      api.admin.resetTestPass(key, reset.dataset.reset)
        .then(function (r) { toast('Shots reset (' + r.removed + ' photo' + (r.removed === 1 ? '' : 's') + ' removed).'); return loadRehearsal(); })
        .catch(function (err) { toast(err.message, false); });
    }
  });
  $('delete-tests').addEventListener('click', function () {
    if (!confirm('Delete every test pass and its photos? Phones that used one go back to having no pass.')) return;
    api.admin.deleteTestPasses(key)
      .then(function (r) { toast('Test passes deleted (' + r.removed + ' photos removed).'); return loadRehearsal(); })
      .catch(function (err) { toast(err.message, false); });
  });
  $('clear-songs').addEventListener('click', function () {
    var word = prompt('This removes every song request and vote, for everyone. Type CLEAR to go ahead.');
    if (word === null) return;
    api.admin.clearSongs(key, word.trim())
      .then(function (r) { toast('Song board cleared (' + r.removed + ' requests).'); return loadRehearsal(); })
      .catch(function (err) { toast(err.message, false); });
  });

  setInterval(function () { if (!document.hidden && key && !document.querySelector('#admin :focus')) { load(); loadRehearsal(); } }, 30000);
  load();
})();
