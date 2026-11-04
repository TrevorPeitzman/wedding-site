/* Feature switches and timed release. Loaded synchronously in <head>, right
 * after theme.js, on every page.
 *
 * For each feature:
 *   on: false          removes it everywhere: nav links, home cards, inline
 *                      mentions, and its page sends visitors home.
 *   opensAt: '<ISO>'   timed release. Before this moment the feature shows as
 *                      "opens at 5:45 PM" instead of working; after it, it
 *                      opens on its own (pages reload themselves at the time).
 *                      Use Pacific time with its offset: '2026-11-21T17:45:00-08:00'.
 *
 * Rehearse with ?now=2026-11-21T17:50 (see theme.js).
 *
 * In HTML:
 *   data-feature="songs"   hidden when songs is off (nav links, cards, mentions)
 *   data-requires="songs"  shown only while songs is open (the tool itself)
 *   data-until="songs"     shown only before songs opens (the "opens at" notice)
 *   data-opens="songs"     filled with the opening time, e.g. "5:45 PM on Saturday, November 21"
 *   <html data-page-feature="songs">  the page belongs to songs (sent home when off)
 *
 * This is the static layer: it decides what guests see. Phase 6 of the plan
 * adds the same schedule in Supabase so the database refuses early use too.
 */
(function () {
  var KT = (window.KT = window.KT || {});

  var FEATURES = {
    schedule: { on: true },
    details:  { on: true },
    songs:    { on: true },
    camera:   { on: true },
    wallet:   { on: true }
  };

  KT.features = FEATURES;

  KT.feature = function (name) {
    var f = FEATURES[name];
    if (!f || f.on === false) return 'off';
    if (f.opensAt && (KT.now ? KT.now() : new Date()).getTime() < Date.parse(f.opensAt)) return 'soon';
    return 'open';
  };

  KT.opensAtText = function (name) {
    var f = FEATURES[name];
    if (!f || !f.opensAt) return '';
    var d = new Date(f.opensAt), tz = { timeZone: 'America/Los_Angeles' };
    var time = d.toLocaleTimeString('en-US', Object.assign({ hour: 'numeric', minute: '2-digit' }, tz));
    var day = d.toLocaleDateString('en-US', Object.assign({ weekday: 'long', month: 'long', day: 'numeric' }, tz));
    return time + ' on ' + day;
  };

  // Calls fn once the feature opens (now, or later on a timer).
  KT.whenOpen = function (name, fn) {
    var state = KT.feature(name);
    if (state === 'open') return fn();
    if (state !== 'soon') return;
    var wait = Date.parse(FEATURES[name].opensAt) - (KT.now ? KT.now() : new Date()).getTime();
    // Timers longer than ~24 days overflow; a guest won't keep a tab open that long.
    if (wait < 2147483647) setTimeout(function () { location.reload(); }, wait + 1000);
  };

  var root = document.documentElement;
  Object.keys(FEATURES).forEach(function (name) {
    var state = KT.feature(name);
    if (state !== 'open') root.classList.add('kt-' + state + '-' + name);
  });

  var own = root.getAttribute('data-page-feature');
  if (own && KT.feature(own) === 'off') location.replace('/');

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-opens]').forEach(function (el) {
      var text = KT.opensAtText(el.getAttribute('data-opens'));
      if (text) el.textContent = text;
    });
  });
})();
