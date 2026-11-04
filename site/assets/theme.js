/* Loaded synchronously in <head> so the right theme paints first.
 *
 * Theme rule (from the design system README): Terrace (day) by default;
 * Finery (night) when the device prefers dark, and from the ceremony on,
 * because every guest screen at the venue is opened in the dark.
 * A guest's own choice from the header toggle wins and is remembered.
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

  // 5:00 PM PST on Saturday 21 November 2026 = 01:00 UTC on the 22nd.
  KT.CEREMONY = Date.UTC(2026, 10, 22, 1, 0);

  KT.storedTheme = function () {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  };
  KT.autoTheme = function () {
    var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    return dark || KT.now().getTime() >= KT.CEREMONY ? 'finery' : 'terrace';
  };
  KT.setTheme = function (theme, remember) {
    document.documentElement.setAttribute('data-theme', theme);
    if (remember) { try { localStorage.setItem(KEY, theme); } catch (e) {} }
  };

  var t = KT.storedTheme();
  KT.setTheme(t === 'terrace' || t === 'finery' ? t : KT.autoTheme(), false);
})();
