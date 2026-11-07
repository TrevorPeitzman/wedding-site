/* Feature switches and timed release. Loaded synchronously in <head>, after
 * theme.js and config.js, on every page.
 *
 * Two layers:
 *  1. The schedule in Supabase (feature_schedule, set from /admin/). It is
 *     the one that counts: the database refuses song requests, votes and
 *     camera shots outside their window. Pages fetch it after load and keep
 *     the last copy on the phone, so the next page applies it before paint.
 *  2. The defaults below: used before the first fetch and whenever Supabase
 *     can't be reached, so the static pages always work.
 *
 * For each feature:
 *   on: false          removes it everywhere: nav links, home cards, inline
 *                      mentions, and its page sends visitors home.
 *   opensAt: '<ISO>'   before this moment the feature shows as "opens at
 *                      5:45 PM" instead of working; pages reload at the time.
 *   closesAt: '<ISO>'  from this moment it is treated as off.
 *   Use Pacific time with its offset: '2026-11-21T17:45:00-08:00'.
 *
 * Rehearse with ?now=2026-11-21T17:50 (see theme.js). With ?demo=1 the
 * "server" layer is the demo admin screen's settings in this browser.
 *
 * In HTML:
 *   data-feature="songs"   hidden when songs is off or closed
 *   data-requires="songs"  shown only while songs is open (the tool itself)
 *   data-until="songs"     shown only before songs opens (the "opens at" notice)
 *   data-opens="songs"     filled with the opening time, e.g. "5:45 PM on Saturday, November 21"
 *   data-yields="camera"   hidden while camera is open (Details in the nav makes room for Camera)
 *   <html data-page-feature="songs">  the page belongs to songs (sent home when off)
 */
(function () {
  var KT = (window.KT = window.KT || {});
  var CACHE = 'kt-features-server', DEMO_STORE = 'kt-features-demo';

  var DEFAULTS = {
    schedule: { on: true },
    details:  { on: true },
    songs:    { on: true },
    camera:   { on: true },
    wallet:   { on: true }
  };
  var NAMES = Object.keys(DEFAULTS);

  function demoMode() {
    try {
      var flag = new URLSearchParams(location.search).get('demo');
      if (flag === '1') return true;
      if (flag === '0') return false;
      return sessionStorage.getItem('kt-demo') === '1';
    } catch (e) { return false; }
  }
  function readJson(store, key) {
    try { return JSON.parse(store.getItem(key)); } catch (e) { return null; }
  }

  // Server rows look like { on, opens_at, closes_at, state }.
  function merge(server) {
    var out = {};
    NAMES.forEach(function (n) {
      var s = server && server[n];
      out[n] = s ? { on: s.on !== false, opensAt: s.opens_at || null, closesAt: s.closes_at || null }
                 : Object.assign({}, DEFAULTS[n]);
    });
    return out;
  }

  var demo = demoMode();
  var serverCopy = demo ? readJson(localStorage, DEMO_STORE) : readJson(localStorage, CACHE);
  var FEATURES = merge(serverCopy);
  KT.features = FEATURES;

  function now() { return (KT.now ? KT.now() : new Date()).getTime(); }
  function state(f) {
    if (!f || f.on === false) return 'off';
    if (f.opensAt && now() < Date.parse(f.opensAt)) return 'soon';
    if (f.closesAt && now() >= Date.parse(f.closesAt)) return 'closed';
    return 'open';
  }

  // 'off' | 'soon' | 'open' | 'closed'. Pages treat closed like off.
  KT.feature = function (name) { return state(FEATURES[name]); };

  KT.opensAtText = function (name) {
    var f = FEATURES[name];
    if (!f || !f.opensAt) return '';
    var d = new Date(f.opensAt), tz = { timeZone: 'America/Los_Angeles' };
    var time = d.toLocaleTimeString('en-US', Object.assign({ hour: 'numeric', minute: '2-digit' }, tz));
    var day = d.toLocaleDateString('en-US', Object.assign({ weekday: 'long', month: 'long', day: 'numeric' }, tz));
    return time + ' on ' + day;
  };

  function reloadAt(iso) {
    var wait = Date.parse(iso) - now();
    // Timers longer than ~24 days overflow; nobody keeps a tab open that long.
    if (wait > 0 && wait < 2147483647) setTimeout(function () { location.reload(); }, wait + 1000);
  }

  // Calls fn now if the feature is open; otherwise reloads the page when it opens.
  KT.whenOpen = function (name, fn) {
    var s = KT.feature(name);
    if (s === 'open') return fn();
    if (s === 'soon') reloadAt(FEATURES[name].opensAt);
  };

  var root = document.documentElement;
  function apply() {
    NAMES.forEach(function (n) {
      var s = KT.feature(n);
      root.classList.toggle('kt-off-' + n, s === 'off' || s === 'closed');
      root.classList.toggle('kt-soon-' + n, s === 'soon');
      root.classList.toggle('kt-open-' + n, s === 'open');
    });
  }
  apply();

  var own = root.getAttribute('data-page-feature');
  var ownState = own ? KT.feature(own) : null;
  if (own && (ownState === 'off' || ownState === 'closed')) location.replace('/');
  if (own && ownState === 'open' && FEATURES[own].closesAt) reloadAt(FEATURES[own].closesAt);

  function fillOpens() {
    document.querySelectorAll('[data-opens]').forEach(function (el) {
      var text = KT.opensAtText(el.getAttribute('data-opens'));
      if (text) el.textContent = text;
    });
  }

  // Fetch the live schedule, keep it for the next page, and catch up if it
  // changed: re-apply the classes, and reload when this page's own feature
  // flipped between open and not (its script decided at load).
  function refresh() {
    var cfg = window.KT_CONFIG || {};
    if (demo || !cfg.supabaseUrl || !cfg.supabaseAnonKey || !window.fetch) return;
    fetch(cfg.supabaseUrl + '/rest/v1/rpc/features', {
      method: 'POST',
      headers: { apikey: cfg.supabaseAnonKey, Authorization: 'Bearer ' + cfg.supabaseAnonKey, 'Content-Type': 'application/json' },
      body: '{}'
    }).then(function (r) { return r.ok ? r.json() : null; }).then(function (server) {
      if (!server || typeof server !== 'object') return;
      try { localStorage.setItem(CACHE, JSON.stringify(server)); } catch (e) {}
      var fresh = merge(server);
      var before = {};
      NAMES.forEach(function (n) { before[n] = KT.feature(n); });
      NAMES.forEach(function (n) { FEATURES[n] = fresh[n]; });
      apply();
      fillOpens();
      if (!own) return;
      var after = KT.feature(own);
      if (after === 'off' || after === 'closed') { location.replace('/'); return; }
      if ((before[own] === 'open') !== (after === 'open')) location.reload();
    }).catch(function () { /* offline: the cached or default schedule stands */ });
  }

  document.addEventListener('DOMContentLoaded', function () { fillOpens(); refresh(); });
})();
