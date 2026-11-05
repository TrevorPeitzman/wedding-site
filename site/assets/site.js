/* Progressive enhancement only: every page reads fine without this file.
 *  - wires the Day / Night toggle in the header
 *  - on the schedule, marks past and current items and lights up the
 *    current room on the map while the evening is under way
 */
(function () {
  var KT = window.KT || {};
  var root = document.documentElement;

  /* ---------- Boarding pass link ----------
   * The QR on each printed pass opens a page with ?pass=<token>. Keep the
   * token on this phone (the song board and, later, the camera claim it) and
   * take it out of the address bar so it isn't shared by accident. */
  try {
    var params = new URLSearchParams(location.search);
    var pass = params.get('pass');
    if (pass && /^[A-Za-z0-9_-]{6,128}$/.test(pass)) {
      localStorage.setItem('kt-pass', pass);
      params.delete('pass');
      var rest = params.toString();
      history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
    }
  } catch (e) {}

  /* ---------- Theme toggle ---------- */
  var toggle = document.querySelector('.theme-toggle');
  function paintToggle() {
    if (!toggle) return;
    var night = root.getAttribute('data-theme') === 'finery';
    toggle.setAttribute('aria-pressed', String(night));
    var word = toggle.querySelector('.theme-word');
    if (word) word.textContent = night ? 'Day' : 'Night';
    toggle.setAttribute('aria-label', night ? 'Switch to day colors' : 'Switch to night colors');
  }
  if (toggle) {
    toggle.hidden = false;
    toggle.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'finery' ? 'terrace' : 'finery';
      if (KT.setTheme) KT.setTheme(next, true); else root.setAttribute('data-theme', next);
      paintToggle();
    });
    paintToggle();
  }

  /* ---------- Schedule: past / now ---------- */
  var items = Array.prototype.slice.call(document.querySelectorAll('.kt-tl-item[data-start]'));
  if (!items.length) return;

  var ROOM_NAMES = { terrace: 'Terrace Room', finery: 'Finery Bar & Lounge', ballroom: 'Uptown Ballroom' };
  var END = document.querySelector('.kt-timeline[data-end]');
  var end = END ? new Date(END.getAttribute('data-end')).getTime() : Infinity;

  function update() {
    var now = (KT.now ? KT.now() : new Date()).getTime();
    items.forEach(function (li, i) {
      var start = new Date(li.getAttribute('data-start')).getTime();
      var next = items[i + 1] ? new Date(items[i + 1].getAttribute('data-start')).getTime() : end;
      var isNow = now >= start && now < next;
      var isPast = now >= next;
      li.classList.toggle('kt-tl-now', isNow);
      li.classList.toggle('kt-tl-past', isPast);
      if (isNow) { li.setAttribute('aria-current', 'step');} else li.removeAttribute('aria-current');
      var title = li.querySelector('.kt-tl-title');
      var badge = title && title.querySelector('.kt-tl-badge');
      if (isNow && !badge && title) {
        badge = document.createElement('span');
        badge.className = 'kt-tl-badge';
        badge.textContent = 'Now';
        title.appendChild(badge);
      } else if (!isNow && badge) badge.remove();
    });

    // Light up the room we are in now (the most recent item that names one).
    var room = null;
    for (var i = items.length - 1; i >= 0; i--) {
      var s = new Date(items[i].getAttribute('data-start')).getTime();
      if (now >= s && now < end && items[i].getAttribute('data-room')) { room = items[i].getAttribute('data-room'); break; }
    }
    // The floor plan: each room's wash and label carry data-room.
    document.querySelectorAll('.kt-map [data-room]').forEach(function (el) {
      var on = !!room && el.getAttribute('data-room') === room;
      if (el.classList) el.classList.toggle('is-on', on);
      else el.setAttribute('class', (el.getAttribute('class') || '').replace(/\s*is-on/g, '') + (on ? ' is-on' : ''));
    });
    var svg = document.querySelector('.kt-map svg');
    var roomName = room && ROOM_NAMES[room];
    if (svg) svg.setAttribute('aria-label', 'Map of the event rooms at The Linden Club' + (roomName ? ', ' + roomName + ' highlighted' : ''));
  }

  update();
  setInterval(update, 60 * 1000);

  // "Show restrooms": they're tucked away, so the map can point them out.
  var wcBtn = document.getElementById('show-wc'), map = document.querySelector('.kt-map');
  if (wcBtn && map) {
    wcBtn.hidden = false;
    wcBtn.addEventListener('click', function () {
      var on = !map.classList.contains('show-wc');
      map.classList.toggle('show-wc', on);
      wcBtn.setAttribute('aria-pressed', String(on));
      wcBtn.textContent = on ? 'Hide restrooms' : 'Show restrooms';
      if (on && map.scrollIntoView) map.querySelector('svg').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }
})();


/* Home: Wi-Fi. A web page can't join a network for the guest, so "Join
 * Wi-Fi" copies the password and says where to paste it. */
(function () {
  'use strict';
  var btn = document.getElementById('wifi-join'), how = document.getElementById('wifi-how');
  if (!btn || !how) return;
  btn.hidden = false;
  btn.addEventListener('click', function () {
    var done = function () {
      how.textContent = 'Password copied. Now open Settings, then Wi-Fi, choose Linden Club Guest and paste it.';
      btn.textContent = 'Copied';
    };
    var fail = function () {
      how.textContent = 'Open Settings, then Wi-Fi, choose Linden Club Guest and type the password: 24Welcome.';
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText('24Welcome').then(done, fail);
    else fail();
  });
})();
