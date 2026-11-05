/* Saving photos from the gallery (/photos/) and the organizer view (/admin/).
 *
 * KT.photoTools.save(items, opts) fetches each { url, name } and hands the
 * files over the best way for the device:
 *   - a phone that can share files, 10 or fewer: the share sheet ("Save
 *     Images" puts them in the camera roll);
 *   - one photo elsewhere: a plain .jpg download;
 *   - more: .zip downloads of up to 100 photos each (stored, not
 *     compressed: JPEGs don't shrink), built here so nothing else is needed.
 * opts: { zipName, onProgress(done, total, label), ask(label) -> Promise }
 * `ask` shows a button and resolves when it's tapped: the share sheet needs
 * a fresh tap if fetching took too long.
 * Resolves to { saved, failed, how: 'share' | 'file' | 'zip' | 'cancelled' }. */
(function () {
  'use strict';
  var KT = window.KT = window.KT || {};
  var PART = 100, SHARE_MAX = 10, PARALLEL = 4;

  /* ---------------------------------------------------------------- zip -- */
  var CRC = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function dosTime(d) {
    return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
             date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
  }
  // files: [{ name, bytes: Uint8Array, date? }] -> Blob (application/zip)
  function zip(files) {
    var enc = new TextEncoder(), parts = [], central = [], offset = 0;
    files.forEach(function (f) {
      var name = enc.encode(f.name), crc = crc32(f.bytes), size = f.bytes.length, t = dosTime(f.date || new Date());
      var h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
      h.setUint16(8, 0, true); h.setUint16(10, t.time, true); h.setUint16(12, t.date, true);
      h.setUint32(14, crc, true); h.setUint32(18, size, true); h.setUint32(22, size, true);
      h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      parts.push(h.buffer, name, f.bytes);
      var c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true);
      c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true); c.setUint16(12, t.time, true);
      c.setUint16(14, t.date, true); c.setUint32(16, crc, true); c.setUint32(20, size, true);
      c.setUint32(24, size, true); c.setUint16(28, name.length, true);
      c.setUint32(42, offset, true);
      central.push(c.buffer, name);
      offset += 30 + name.length + size;
    });
    var cdSize = central.reduce(function (n, b) { return n + b.byteLength; }, 0);
    var e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
    return new Blob(parts.concat(central, [e.buffer]), { type: 'application/zip' });
  }

  /* ------------------------------------------------------------ helpers -- */
  // Names for files: plain letters and numbers only ("Zoë" -> "Zoe").
  function slug(v) {
    return String(v == null ? '' : v).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '');
  }
  function fetchAll(items, onProgress) {
    var out = new Array(items.length), next = 0, done = 0, failed = 0;
    function worker() {
      if (next >= items.length) return Promise.resolve();
      var i = next++, it = items[i];
      return fetch(it.url).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.blob();
      }).then(function (blob) {
        out[i] = { name: it.name, blob: blob, date: it.date };
      }, function () { failed++; }).then(function () {
        done++;
        if (onProgress) onProgress(done, items.length);
        return worker();
      });
    }
    var workers = [];
    for (var w = 0; w < Math.min(PARALLEL, items.length); w++) workers.push(worker());
    return Promise.all(workers).then(function () {
      return { files: out.filter(Boolean), failed: failed };
    });
  }
  function download(blob, filename) {
    var url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = filename; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }
  function phone() {
    return !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
  }
  function asFiles(list) {
    return list.map(function (f) { return new File([f.blob], f.name, { type: f.blob.type || 'image/jpeg' }); });
  }
  function canShare(files) {
    try { return !!(navigator.share && navigator.canShare && navigator.canShare({ files: files })); } catch (e) { return false; }
  }
  function bytesOf(blob) {
    return blob.arrayBuffer ? blob.arrayBuffer().then(function (b) { return new Uint8Array(b); })
      : new Promise(function (ok, no) {
        var r = new FileReader(); r.onload = function () { ok(new Uint8Array(r.result)); }; r.onerror = no; r.readAsArrayBuffer(blob);
      });
  }

  /* --------------------------------------------------------------- save -- */
  function share(files, ask) {
    return navigator.share({ files: files }).catch(function (err) {
      if (err && err.name === 'AbortError') throw err;
      // Too long since the tap: ask for another one, then share.
      if (!ask) throw err;
      return ask('Save ' + files.length + ' photo' + (files.length === 1 ? '' : 's')).then(function () {
        return navigator.share({ files: files });
      });
    });
  }

  function save(items, opts) {
    opts = opts || {};
    var progress = opts.onProgress || function () {};
    var zipName = opts.zipName || 'photos';
    if (!items.length) return Promise.resolve({ saved: 0, failed: 0, how: 'file' });

    // A phone that can share files: straight to the share sheet.
    if (items.length <= SHARE_MAX && phone() && navigator.share && navigator.canShare) {
      return fetchAll(items, function (d, t) { progress(d, t, 'Getting'); }).then(function (got) {
        var files = asFiles(got.files);
        if (files.length && canShare(files)) {
          return share(files, opts.ask).then(function () {
            return { saved: files.length, failed: got.failed, how: 'share' };
          }, function (err) {
            if (err && err.name === 'AbortError') return { saved: 0, failed: got.failed, how: 'cancelled' };
            throw err;
          });
        }
        return asDownloads(got, zipName, progress);
      });
    }

    if (items.length === 1) {
      return fetchAll(items).then(function (got) { return asDownloads(got, zipName, progress); });
    }

    // Many: .zip files of PART photos each, one after another, so a phone
    // never holds more than one part in memory.
    var parts = Math.ceil(items.length / PART), saved = 0, failed = 0, chain = Promise.resolve();
    for (var p = 0; p < parts; p++) {
      (function (p) {
        chain = chain.then(function () {
          var slice = items.slice(p * PART, (p + 1) * PART);
          var label = parts > 1 ? 'Part ' + (p + 1) + ' of ' + parts + ':' : 'Getting';
          return fetchAll(slice, function (d, t) { progress(p * PART + d, items.length, label); }).then(function (got) {
            failed += got.failed;
            return Promise.all(got.files.map(function (f) {
              return bytesOf(f.blob).then(function (b) { return { name: f.name, bytes: b, date: f.date }; });
            }));
          }).then(function (entries) {
            if (!entries.length) return;
            saved += entries.length;
            download(zip(entries), zipName + (parts > 1 ? '-part' + (p + 1) : '') + '.zip');
          });
        });
      })(p);
    }
    return chain.then(function () { return { saved: saved, failed: failed, how: 'zip' }; });
  }

  function asDownloads(got, zipName, progress) {
    if (got.files.length === 1) {
      download(got.files[0].blob, got.files[0].name);
      return Promise.resolve({ saved: 1, failed: got.failed, how: 'file' });
    }
    return Promise.all(got.files.map(function (f) {
      return bytesOf(f.blob).then(function (b) { return { name: f.name, bytes: b, date: f.date }; });
    })).then(function (entries) {
      if (entries.length) download(zip(entries), zipName + '.zip');
      progress(entries.length, entries.length, 'Saved');
      return { saved: entries.length, failed: got.failed, how: 'zip' };
    });
  }

  KT.photoTools = { save: save, zip: zip, crc32: crc32, slug: slug };
})();
