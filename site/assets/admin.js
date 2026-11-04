/* Organizer screen: feature switches and times, camera settings, the reveal.
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
    return api.admin.features(key).then(function (d) {
      data = d; $('key-form').hidden = true; $('admin').hidden = false; render();
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

  setInterval(function () { if (!document.hidden && key && !document.querySelector('#admin :focus')) load(); }, 30000);
  load();
})();
