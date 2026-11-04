/* Landing page (/p/): the guest's boarding pass on screen, and the Wallet
 * button that suits their phone. iPhone → Add to Apple Wallet (the `wallet`
 * Edge Function serves the signed .pkpass); Android → Save to Google Wallet;
 * anything else → both, when ready. The on-screen pass is always there, so a
 * guest never depends on Wallet. */
(function () {
  'use strict';
  var KT = window.KT;
  var api = KT.songsClient();
  var $ = function (id) { return document.getElementById(id); };

  var ua = navigator.userAgent || '';
  var IOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var ANDROID = /Android/i.test(ua);

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var PLANE = '<svg viewBox="0 0 44 12" aria-hidden="true"><path d="M1 6 H34" stroke="currentColor" stroke-width="1" stroke-dasharray="2 3"/>' +
    '<path d="M34 6 l-4 -4 h3 l6 4 l-6 4 h-3 z" fill="currentColor"/></svg>';

  // The design system's BoardingPass, as markup (components.css styles it).
  function passHtml(c) {
    var name = c.pass_name || ((c.last_name || '') + '/' + (c.first_name || '')).toUpperCase();
    var cell = function (label, value, big) {
      return '<div' + (big ? ' class="kt-pass-big"' : '') + '><dt>' + label + '</dt><dd>' + esc(value || '—') + '</dd></div>';
    };
    return '<article class="kt-pass" aria-label="Boarding pass for ' + esc(c.first_name + ' ' + c.last_name) + '">' +
      '<div class="kt-pass-band"><span class="kt-pass-carrier">K &amp; T Airways</span><span class="kt-pass-flight">KT 1121</span></div>' +
      '<div class="kt-pass-main">' +
        '<div><p class="kt-pass-lbl">Passenger</p><div class="kt-pass-name">' + esc(name) + '</div></div>' +
        '<div class="kt-pass-route">' +
          '<div><div class="kt-pass-code">LGB</div><div class="kt-pass-city">Long Beach</div></div>' +
          '<div class="kt-pass-plane">' + PLANE + '</div>' +
          '<div><div class="kt-pass-code">' + esc(c.destination_code) + '</div><div class="kt-pass-city">' + esc(c.destination_city) + '</div></div>' +
        '</div>' +
        '<dl class="kt-pass-grid">' +
          cell('Gate', c.gate, true) + cell('Table', c.table_number, true) + cell('Boarding', '7:00P', true) +
          cell('Date', '21NOV26') + cell('Class', c.cabin === 'F' ? 'First' : c.cabin) + cell('Seat', c.seat) +
        '</dl>' +
      '</div>' +
      '<div class="kt-pass-perf" aria-hidden="true"></div>' +
      '<div class="kt-pass-stub wal-stub">' +
        '<div><p class="kt-pass-lbl">Destination</p><p class="kt-pass-dest">' + esc(c.destination_city) + '</p>' +
        (c.ssr_remarks ? '<p class="kt-pass-lbl" style="margin-top:8px">SSR · Remarks</p><p class="kt-pass-remark">' + esc(c.ssr_remarks) + '</p>' : '') +
        '</div>' +
      '</div>' +
    '</article>';
  }

  function buttons(c) {
    if (c.wallet_state !== 'open') return { html: '', hint: c.wallet_state === 'soon' && KT.opensAtText('wallet')
      ? 'You can add it to your phone’s Wallet from ' + KT.opensAtText('wallet') + '.' : '' };
    var apple = c.apple_ready ? api.wallet.appleUrl(c.token) : null;
    var google = c.google_save_url || null;
    var list = [];
    if (apple && (IOS || !ANDROID)) list.push({ href: apple, label: 'Add to Apple Wallet' });
    if (google && (ANDROID || !IOS)) list.push({ href: google, label: 'Save to Google Wallet' });
    var html = list.map(function (b, i) {
      return '<a class="kt-btn ' + (i === 0 ? 'kt-btn-primary' : 'kt-btn-secondary') + '" href="' + esc(b.href) + '"' +
        (b.href.indexOf('pay.google.com') >= 0 ? ' target="_blank" rel="noopener"' : '') + '>' + b.label + '</a>';
    }).join('');
    var hint = list.length ? 'Or keep this page: it’s your pass too.'
      : 'Your Wallet pass isn’t ready yet. This page is your pass in the meantime.';
    return { html: html, hint: hint, primary: list.length > 0 };
  }

  if (KT.feature && KT.feature('wallet') === 'off') return;

  api.wallet.card().then(function (c) {
    if (!c || !c.has_pass) return;
    $('pass-card').innerHTML = passHtml(c);
    var b = buttons(c);
    $('wallet-actions').innerHTML = b.html;
    $('wallet-actions').hidden = !b.html;
    $('wallet-hint').textContent = b.hint;
    $('wallet-hint').hidden = !b.hint;
    $('welcome').textContent = c.first_name + ', your boarding pass is your key to tonight. Keep this page handy.';
    $('pass-area').hidden = false;
    // One primary button per view: with a Wallet button, the camera steps back.
    if (b.primary) {
      document.querySelectorAll('main .kt-card .kt-btn-primary').forEach(function (a) {
        a.classList.remove('kt-btn-primary'); a.classList.add('kt-btn-secondary');
      });
    }
  }).catch(function () { /* the page still works without the pass card */ });
})();
