/* The reveal: everyone's disposable-camera photos, for guests with a claimed
 * pass, from photos_reveal_at on. Signed links last an hour; reload for more.
 * Tap a photo to open it; Select picks some to save, Save all takes every
 * one (the share sheet on a phone for up to 10, otherwise .zip files). */
(function () {
  'use strict';
  var KT = window.KT;
  var api = KT.songsClient();
  var $ = function (id) { return document.getElementById(id); };
  var photos = [], picked = {}, selecting = false, busy = false, pendingAsk = null;

  function notice(tone, title, body, where) {
    var mark = { info: 'i', warning: '!', danger: '×', success: '✓' }[tone];
    var box = $(where || 'message');
    var p = document.createElement('p');
    p.className = 'kt-notice-body';
    p.textContent = body;
    box.innerHTML = '<div class="kt-notice kt-notice-' + tone + '"><span class="kt-notice-mark" aria-hidden="true">' +
      mark + '</span><span class="kt-notice-title"></span></div>';
    box.querySelector('.kt-notice-title').textContent = title;
    box.firstChild.appendChild(p);
  }
  function when(iso) {
    var d = new Date(iso), tz = { timeZone: 'America/Los_Angeles' };
    return d.toLocaleDateString('en-US', Object.assign({ weekday: 'long', month: 'long', day: 'numeric' }, tz)) +
      ' at ' + d.toLocaleTimeString('en-US', Object.assign({ hour: 'numeric', minute: '2-digit' }, tz));
  }
  function plural(n) { return n + ' photo' + (n === 1 ? '' : 's'); }
  function fileName(i) { return 'KT1121-' + ('00' + (i + 1)).slice(-3) + '.jpg'; }
  function pickedList() { return photos.filter(function (p, i) { return picked[i]; }); }

  function render() {
    var grid = $('grid');
    grid.innerHTML = '';
    photos.forEach(function (p, i) {
      var li = document.createElement('li'), a = document.createElement('a'), img = document.createElement('img');
      a.href = p.url; a.target = '_blank'; a.rel = 'noopener';
      img.src = p.url; img.loading = 'lazy'; img.alt = 'Photo ' + (i + 1) + ' of ' + photos.length;
      a.appendChild(img); li.appendChild(a);
      // Shown only while selecting: covers the photo, so a tap picks it.
      var label = document.createElement('label'), box = document.createElement('input'), mark = document.createElement('span');
      label.className = 'gal-check';
      box.type = 'checkbox'; box.setAttribute('data-i', i);
      box.setAttribute('aria-label', 'Choose photo ' + (i + 1));
      mark.setAttribute('aria-hidden', 'true');
      label.appendChild(box); label.appendChild(mark); li.appendChild(label);
      grid.appendChild(li);
    });
    grid.hidden = false;
    $('tools').hidden = false;
    update();
  }

  function update() {
    var n = pickedList().length;
    $('count').textContent = plural(photos.length);
    $('grid').classList.toggle('is-selecting', selecting);
    $('select').setAttribute('aria-pressed', String(selecting));
    $('select').textContent = selecting ? 'Done' : 'Select';
    Array.prototype.forEach.call($('grid').children, function (li, i) {
      li.classList.toggle('is-picked', !!picked[i]);
      li.querySelector('input').checked = !!picked[i];
      var a = li.querySelector('a');
      if (selecting) { a.setAttribute('tabindex', '-1'); a.setAttribute('aria-hidden', 'true'); }
      else { a.removeAttribute('tabindex'); a.removeAttribute('aria-hidden'); }
    });
    $('bar').hidden = !selecting && !busy;
    if (!pendingAsk) {
      $('save-picked').textContent = n ? 'Save ' + plural(n) : 'Save';
      $('save-picked').disabled = !n || busy;
      $('bar-note').textContent = busy ? $('bar-note').textContent : n ? plural(n) + ' chosen.' : 'Tap photos to choose them.';
    }
    $('save-all').disabled = busy;
    $('save-all').textContent = 'Save all ' + photos.length;
  }

  function save(list, zipName, button) {
    if (busy || !list.length) return;
    busy = true; update();
    var note = $('bar-note');
    note.textContent = 'Getting ready…';
    KT.photoTools.save(list.map(function (p) { return { url: p.url, name: p.name }; }), {
      zipName: zipName,
      onProgress: function (done, total, label) { note.textContent = label + ' ' + done + ' of ' + total + '…'; },
      ask: function (label) {
        return new Promise(function (ok) {
          pendingAsk = function () { pendingAsk = null; ok(); };
          button = $('save-picked');
          button.textContent = label; button.disabled = false;
          note.textContent = 'Ready.';
        });
      }
    }).then(function (r) {
      if (r.how === 'cancelled') { notice('info', 'Nothing saved', 'Choose Save again whenever you like.', 'save-message'); return; }
      var msg = r.how === 'share' ? 'Saved through your phone’s share sheet.' :
        r.how === 'zip' ? 'Look in your downloads for the .zip' + (list.length > 100 ? ' files' : '') + '.' : 'Look in your downloads.';
      if (r.failed) msg += ' ' + plural(r.failed) + ' didn’t come through: reload the page and try those again.';
      notice(r.saved ? 'success' : 'danger', r.saved ? plural(r.saved) + ' saved' : 'Not quite', r.saved ? msg : 'Reload the page and try again.', 'save-message');
      if (r.saved) picked = {};
    }).catch(function () {
      notice('danger', 'Not quite', 'Those photos didn’t save. Reload the page and try again.', 'save-message');
    }).then(function () {
      busy = false; pendingAsk = null; selecting = false; update();
    });
  }

  $('select').addEventListener('click', function () {
    selecting = !selecting;
    if (!selecting) picked = {};
    update();
  });
  $('done').addEventListener('click', function () { selecting = false; picked = {}; update(); });
  $('grid').addEventListener('change', function (ev) {
    var i = ev.target.getAttribute('data-i');
    if (i == null) return;
    if (ev.target.checked) picked[i] = true; else delete picked[i];
    update();
  });
  $('save-picked').addEventListener('click', function () {
    if (pendingAsk) return pendingAsk();
    save(pickedList(), 'KT1121-photos', this);
  });
  $('save-all').addEventListener('click', function () {
    if (photos.length > 100 && !confirm('Save all ' + photos.length + ' photos? They come as .zip files of 100 each, so it takes a while. Keep this page open until they’re done.')) return;
    save(photos, 'KT1121-photos', $('save-picked'));
  });

  api.camera.status().then(function (s) {
    $('loading').hidden = true;
    if (!s.has_pass) { $('no-pass').hidden = false; return; }
    if (!s.revealed) {
      notice('info', 'Still developing', 'Everyone’s photos come out on ' + when(s.reveal_at) + '. Come back then!');
      return;
    }
    return api.camera.gallery().then(function (g) {
      if (!g.photos.length) { notice('info', 'Nothing yet', 'No photos have come through.'); return; }
      photos = g.photos.map(function (p, i) { return { url: p.url, name: fileName(i) }; });
      render();
    });
  }).catch(function (err) {
    $('loading').hidden = true;
    notice('danger', 'Not quite', err.message);
  });
})();
