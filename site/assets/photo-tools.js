/* Saving photos from the gallery (/photos/) and the organizer view (/admin/).
 *
 * KT.photoTools.save(items, opts) fetches each { url, name } and hands the
 * files over the best way for the device:
 *   - a phone that can share files, 10 or fewer: the share sheet ("Save
 *     Images" puts them in the camera roll);
 *   - one photo elsewhere: a plain .jpg download;
 *   - more: .zip downloads of up to 100 photos or 200 MB each (stored, not
 *     compressed: JPEGs don't shrink), built here so nothing else is needed.
 *
 * KT.photoTools.webCopy(file) -> Promise<Blob>: a 2048px JPEG of an image
 * file (for the album's grid; the original is kept as is).
 *
 * An item with a `stamp` (a Date) is saved with the disposable-camera look:
 * film colour, vignette, grain, a faint light leak and the orange date in
 * the corner (KT.photoTools.disposable(blob, date) -> Promise<Blob>).
 * opts: { zipName, onProgress(done, total, label), ask(label) -> Promise }
 * `ask` shows a button and resolves when it's tapped: the share sheet needs
 * a fresh tap if fetching took too long.
 * Resolves to { saved, failed, how: 'share' | 'file' | 'zip' | 'cancelled' }. */
(function () {
  'use strict';
  var KT = window.KT = window.KT || {};
  var PART = 100, PART_BYTES = 200 * 1024 * 1024, BATCH = 12, SHARE_MAX = 10, PARALLEL = 4;

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
    var out = new Array(items.length), next = 0, done = 0, failed = 0, plain = 0;
    function worker() {
      if (next >= items.length) return Promise.resolve();
      var i = next++, it = items[i];
      return fetch(it.url).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.blob();
      }).then(function (blob) {
        return it.stamp ? disposable(blob, it.stamp).catch(function () { plain++; return blob; }) : blob;
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
      return { files: out.filter(Boolean), failed: failed, plain: plain };
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
            return { saved: files.length, failed: got.failed, plain: got.plain, how: 'share' };
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

    // Many: .zip files of up to PART photos or PART_BYTES each, fetched a
    // batch at a time, so a phone never holds more than about one part.
    var saved = 0, failed = 0, plain = 0, done = 0, partNo = 0, part = [], partBytes = 0;
    function flush(last) {
      if (!part.length) return;
      partNo++;
      var named = last && partNo === 1 ? zipName : zipName + '-part' + partNo;
      download(zip(part), named + '.zip');
      saved += part.length; part = []; partBytes = 0;
    }
    var chain = Promise.resolve();
    for (var i = 0; i < items.length; i += BATCH) {
      (function (slice) {
        chain = chain.then(function () {
          return fetchAll(slice, function (d) { progress(done + d, items.length, partNo ? 'Part ' + (partNo + 1) + ':' : 'Getting'); })
            .then(function (got) {
              done += slice.length; failed += got.failed; plain += got.plain;
              return got.files.reduce(function (p, f) {
                return p.then(function () { return bytesOf(f.blob); }).then(function (bytes) {
                  if (part.length && (part.length >= PART || partBytes + bytes.length > PART_BYTES)) flush(false);
                  part.push({ name: f.name, bytes: bytes, date: f.date }); partBytes += bytes.length;
                });
              }, Promise.resolve());
            });
        });
      })(items.slice(i, i + BATCH));
    }
    return chain.then(function () { flush(true); return { saved: saved, failed: failed, plain: plain, how: 'zip' }; });
  }

  function asDownloads(got, zipName, progress) {
    if (got.files.length === 1) {
      download(got.files[0].blob, got.files[0].name);
      return Promise.resolve({ saved: 1, failed: got.failed, plain: got.plain, how: 'file' });
    }
    return Promise.all(got.files.map(function (f) {
      return bytesOf(f.blob).then(function (b) { return { name: f.name, bytes: b, date: f.date }; });
    })).then(function (entries) {
      if (entries.length) download(zip(entries), zipName + '.zip');
      progress(entries.length, entries.length, 'Saved');
      return { saved: entries.length, failed: got.failed, plain: got.plain, how: 'zip' };
    });
  }

  /* ----------------------------------------------------------- web copy -- */
  function webCopy(file, maxEdge, quality) {
    maxEdge = maxEdge || 2048; quality = quality || 0.85;
    var decode = window.createImageBitmap
      ? createImageBitmap(file, { imageOrientation: 'from-image' }).catch(function () { return viaImage(file); })
      : viaImage(file);
    return decode.then(function (img) {
      var w = img.width, h = img.height, k = Math.min(1, maxEdge / Math.max(w, h));
      var c = document.createElement('canvas');
      c.width = Math.round(w * k); c.height = Math.round(h * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      if (img.close) img.close();
      return new Promise(function (ok, no) {
        c.toBlob(function (b) { b ? ok(b) : no(new Error('encode')); }, 'image/jpeg', quality);
      });
    }).catch(function () {
      var e = new Error('We couldn’t read ' + (file.name || 'that file') + ' as a photo.');
      e.code = 'unreadable';
      throw e;
    });
  }
  function viaImage(file) {
    return new Promise(function (ok, no) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); ok(img); };
      img.onerror = function () { URL.revokeObjectURL(url); no(new Error('decode')); };
      img.src = url;
    });
  }

  /* --------------------------------------------------- disposable look -- */
  // The date back of a 90s point-and-shoot: '26 11 21 in glowing orange
  // seven-segment digits, bottom right, Pacific time; plus warm film colour,
  // lifted blacks, a vignette, grain and a faint light leak.
  var SEGS = { '0': 'abcdef', '1': 'bc', '2': 'abdeg', '3': 'abcdg', '4': 'bcfg', '5': 'acdfg',
               '6': 'acdefg', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg', '-': 'g' };
  function stampParts(date) {
    var p = {};
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', year: '2-digit',
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(date).forEach(function (x) { p[x.type] = x.value; });
    return "'" + p.year + ' ' + p.month + ' ' + p.day + '  ' + p.hour + ':' + p.minute;
  }
  // Draws the text right-aligned with its baseline at (x, y); h = digit height.
  function drawStamp(g, text, x, y, h) {
    var w = h * 0.5, t = h * 0.13, gap = h * 0.22, half = h / 2;
    var widthOf = function (c) { return c === ' ' ? w * 0.6 : c === ':' || c === "'" ? t * 2.2 : w; };
    var total = 0;
    for (var i = 0; i < text.length; i++) total += widthOf(text[i]) + gap;
    var cx = x - total;
    g.save();
    g.translate(0, y);
    g.transform(1, 0, -0.08, 1, 0, 0);   // the slight slant of LED digits
    var bar = function (bx, by, bw, bh) { g.fillRect(bx, by - h, bw, bh); };
    for (var j = 0; j < text.length; j++) {
      var c = text[j], segs = SEGS[c];
      if (segs) {
        if (segs.indexOf('a') >= 0) bar(cx + t, 0, w - 2 * t, t);
        if (segs.indexOf('b') >= 0) bar(cx + w - t, t, t, half - t);
        if (segs.indexOf('c') >= 0) bar(cx + w - t, half, t, half - t);
        if (segs.indexOf('d') >= 0) bar(cx + t, h - t, w - 2 * t, t);
        if (segs.indexOf('e') >= 0) bar(cx, half, t, half - t);
        if (segs.indexOf('f') >= 0) bar(cx, t, t, half - t);
        if (segs.indexOf('g') >= 0) bar(cx + t, half - t / 2, w - 2 * t, t);
      } else if (c === ':') {
        bar(cx + t * 0.6, h * 0.28, t, t); bar(cx + t * 0.6, h * 0.68, t, t);
      } else if (c === "'") {
        bar(cx + t * 0.6, 0, t, h * 0.3);
      }
      cx += widthOf(c) + gap;
    }
    g.restore();
  }
  // One photo at a time, with each canvas emptied as soon as it's done:
  // phones (iPhones especially) cap canvas memory, and past the cap a
  // render fails. A failed render is tried once more, then reported.
  var lookQueue = Promise.resolve();
  function disposable(blob, date, opts) {
    var job = lookQueue.then(function () {
      return renderLook(blob, date, opts || {}).catch(function () {
        return new Promise(function (ok) { setTimeout(ok, 500); }).then(function () { return renderLook(blob, date, opts || {}); });
      });
    });
    lookQueue = job.catch(function () {});
    return job;
  }
  // opts.maxEdge: render smaller (the gallery's thumbnails).
  function renderLook(blob, date, opts) {
    var decode = window.createImageBitmap ? createImageBitmap(blob).catch(function () { return viaImage(blob); }) : viaImage(blob);
    return decode.then(function (img) {
      var k = opts.maxEdge ? Math.min(1, opts.maxEdge / Math.max(img.width, img.height)) : 1;
      var c = document.createElement('canvas'), W = c.width = Math.round(img.width * k), H = c.height = Math.round(img.height * k);
      var g = c.getContext('2d');
      if (!g) throw new Error('no canvas');
      g.drawImage(img, 0, 0, W, H);
      if (img.close) img.close();
      // Film colour: warm, a little faded, a touch more saturated; luma grain.
      var px = g.getImageData(0, 0, W, H), d = px.data, seed = 1234567;
      for (var i = 0; i < d.length; i += 4) {
        var r = d[i], gg = d[i + 1], b = d[i + 2], l = 0.3 * r + 0.59 * gg + 0.11 * b;
        r = l + (r - l) * 1.12; gg = l + (gg - l) * 1.12; b = l + (b - l) * 1.12;
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        var n = ((seed >> 16) / 32768 - 0.5) * 18;
        d[i] = 16 + r * 0.92 * 1.05 + n;
        d[i + 1] = 14 + gg * 0.92 + n;
        d[i + 2] = 10 + b * 0.92 * 0.86 + n;
      }
      g.putImageData(px, 0, 0);
      // Vignette.
      var v = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) * 0.55);
      v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.38)');
      g.fillStyle = v; g.fillRect(0, 0, W, H);
      // A faint warm light leak from one edge (which one varies by photo).
      var left = (date.getTime() / 60000) % 2 < 1;
      var leak = g.createLinearGradient(left ? 0 : W, 0, left ? W * 0.28 : W * 0.72, 0);
      leak.addColorStop(0, 'rgba(255,120,40,0.22)'); leak.addColorStop(1, 'rgba(255,120,40,0)');
      g.globalCompositeOperation = 'screen'; g.fillStyle = leak; g.fillRect(0, 0, W, H);
      g.globalCompositeOperation = 'source-over';
      // The date: glow first, then the bright digits.
      var h = Math.round(Math.min(W, H) * 0.038), text = stampParts(date);
      var x = W - Math.round(Math.min(W, H) * 0.05), y = H - Math.round(Math.min(W, H) * 0.05);
      g.shadowColor = 'rgba(255,110,0,0.9)'; g.shadowBlur = h * 0.6;
      g.fillStyle = 'rgba(255,150,40,0.85)';
      drawStamp(g, text, x, y, h);
      g.shadowBlur = h * 0.15; g.fillStyle = '#ffb347';
      drawStamp(g, text, x, y, h);
      px = null;
      return new Promise(function (ok, no) {
        c.toBlob(function (out) {
          c.width = c.height = 0;   // hand the memory back now, not at GC
          out ? ok(out) : no(new Error('encode'));
        }, 'image/jpeg', 0.92);
      });
    });
  }

  KT.photoTools = { save: save, zip: zip, crc32: crc32, slug: slug, webCopy: webCopy, disposable: disposable };
})();
