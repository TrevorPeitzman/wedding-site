/* Loaded synchronously in <head> so the right theme paints first.
 *
 * Theme rule: Terrace (day) always, whatever the device prefers or the time.
 * Finery (night) is a hidden extra: three quick taps on the crest on the
 * home page switch to it and back (site.js), remembered on the phone. (The
 * design system's own rule, Finery after dark, was set aside on Nov 7.)
 *
 * KT.now() is the page clock. Add ?now=2026-11-21T18:10 (Pacific time) to
 * any page to rehearse how it looks at that moment on the night.
 */
(function () {
  var KT = (window.KT = window.KT || {});
  var KEY = 'kt-theme';

  var override = null;
  try {
    var q = new URLSearchParams(location.search).get('now');
    // November 21 is after DST ends, so the venue is on PST (UTC-8).
    if (q) override = new Date(q.length <= 16 ? q + ':00-08:00' : q);
    if (override && isNaN(override)) override = null;
  } catch (e) {}

  KT.now = function () { return override ? new Date(override) : new Date(); };

  KT.storedTheme = function () {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  };
  KT.autoTheme = function () { return 'terrace'; };
  KT.setTheme = function (theme, remember) {
    document.documentElement.setAttribute('data-theme', theme);
    if (remember) { try { localStorage.setItem(KEY, theme); } catch (e) {} }
  };

  var t = KT.storedTheme();
  KT.setTheme(t === 'terrace' || t === 'finery' ? t : KT.autoTheme(), false);
})();
