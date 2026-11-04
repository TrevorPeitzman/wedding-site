/* The reveal: everyone's disposable-camera photos, for guests with a claimed
 * pass, from photos_reveal_at on. Signed links last an hour; reload for more. */
(function () {
  'use strict';
  var KT = window.KT;
  var api = KT.songsClient();
  var $ = function (id) { return document.getElementById(id); };

  function notice(tone, title, body) {
    var mark = { info: 'i', warning: '!', danger: '×' }[tone];
    var p = document.createElement('p');
    p.className = 'kt-notice-body';
    p.textContent = body;
    $('message').innerHTML = '<div class="kt-notice kt-notice-' + tone + '"><span class="kt-notice-mark" aria-hidden="true">' +
      mark + '</span><span class="kt-notice-title"></span></div>';
    $('message').querySelector('.kt-notice-title').textContent = title;
    $('message').firstChild.appendChild(p);
  }
  function when(iso) {
    var d = new Date(iso), tz = { timeZone: 'America/Los_Angeles' };
    return d.toLocaleDateString('en-US', Object.assign({ weekday: 'long', month: 'long', day: 'numeric' }, tz)) +
      ' at ' + d.toLocaleTimeString('en-US', Object.assign({ hour: 'numeric', minute: '2-digit' }, tz));
  }

  api.camera.status().then(function (s) {
    $('loading').hidden = true;
    if (!s.has_pass) { $('no-pass').hidden = false; return; }
    if (!s.revealed) {
      notice('info', 'Still developing', 'Everyone’s photos come out on ' + when(s.reveal_at) + '. Come back then!');
      return;
    }
    return api.camera.gallery().then(function (g) {
      if (!g.photos.length) { notice('info', 'Nothing yet', 'No photos have come through.'); return; }
      var grid = $('grid');
      g.photos.forEach(function (p, i) {
        var li = document.createElement('li'), a = document.createElement('a'), img = document.createElement('img');
        a.href = p.url; a.target = '_blank'; a.rel = 'noopener';
        img.src = p.url; img.loading = 'lazy'; img.alt = 'Photo ' + (i + 1) + ' of ' + g.photos.length;
        a.appendChild(img); li.appendChild(a); grid.appendChild(li);
      });
      grid.hidden = false;
    });
  }).catch(function (err) {
    $('loading').hidden = true;
    notice('danger', 'Not quite', err.message);
  });
})();
