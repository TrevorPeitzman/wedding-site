#!/usr/bin/env node
// Rehearsal load tests against the LIVE project in site/assets/config.js.
// Needs Node 18+ (built-in fetch); no packages. Run each once, deliberately,
// during rehearsal week; never on the night.
//
// 1. Read-only (the default): N phones on the song board.
//
//      node scripts/load_test.mjs [--phones 105] [--minutes 3] [--every 7]
//
//    Each phone reads the feature schedule, then the board every 7 seconds
//    (the page's poll). No sign-ins and no writes.
//
// 2. The night (--night): N phones doing what guests do, all at once.
//
//      node scripts/load_test.mjs --night --key '<organizer key>' [--phones 60]
//          [--minutes 5] [--ramp 30] [--photo-kb 600] [--cleanup]
//
//    Each phone signs in anonymously, claims one of the 10 test passes
//    (made if missing), opens its pass card, then until the end: reads the
//    board every ~7s, checks the camera every 20s, and now and then searches
//    Spotify and requests a song, votes, or takes a photo (reserve, upload a
//    real JPEG of --photo-kb, confirm). Phones start within --ramp seconds.
//    The 10 test passes have 12 shots each, so "out_of_shots" refusals late
//    in the run are expected.
//
//    It WRITES to the live project, all of it tied to test passes. Clean up
//    with /admin/ -> Rehearsal -> Delete test passes (photos, their song
//    requests and votes), or pass --cleanup to do that at the end.
//    Before: switch Song requests and Camera on in /admin/ (closed features
//    show up as feature_soon / feature_closed refusals). Each phone is one
//    anonymous sign-in; Supabase allows 300 an hour from one IP address.
//
// Prints latency per step (p50, p95, max), refusals by code (the app saying
// no, which is fine) and errors (timeouts, 5xx, network: the worrying kind).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const config = readFileSync(join(here, "..", "site", "assets", "config.js"), "utf8");
const pick = (name) => (config.match(new RegExp(name + ":\\s*'([^']+)'")) || [])[1];
const has = (flag) => process.argv.includes("--" + flag);
const str = (name, dflt) => {
  const i = process.argv.indexOf("--" + name);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const num = (name, dflt) => Number(str(name, dflt));
const URL_ = str("url", pick("supabaseUrl")), KEY = pick("supabaseAnonKey");
if (!URL_ || !KEY) { console.error("No supabaseUrl/supabaseAnonKey in site/assets/config.js"); process.exit(1); }

const NIGHT = has("night");
const PHONES = num("phones", NIGHT ? 60 : 105), MINUTES = num("minutes", NIGHT ? 5 : 3), EVERY = num("every", 7);
const RAMP = num("ramp", 30), PHOTO_KB = num("photo-kb", 600);
const ORG_KEY = str("key", process.env.KT_ORG_KEY);

const times = {}, errors = {}, refusals = {};
let calls = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const end = () => Date.now() >= deadline;
let deadline = 0;

// One HTTP call, timed. Resolves to { ok, data, code }: ok false with a code
// is the app refusing (counted, not an error); network/5xx/timeouts are errors.
async function step(label, url, { method = "POST", body, token, headers = {}, raw } = {}) {
  const t0 = performance.now();
  calls++;
  try {
    const r = await fetch(url, {
      method,
      headers: { apikey: KEY, Authorization: `Bearer ${token || KEY}`,
                 ...(raw ? {} : { "Content-Type": "application/json" }), ...headers },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
      signal: AbortSignal.timeout(30000),
    });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (r.status >= 500 || r.status === 429) throw new Error(`HTTP ${r.status}`);
    (times[label] ||= []).push(performance.now() - t0);
    const code = !r.ok ? (data?.details || data?.code || data?.error_code || `HTTP ${r.status}`)
      : data && data.ok === false ? data.code || "refused" : null;
    if (code) {
      const k = `${label}: ${code}`;
      refusals[k] = (refusals[k] || 0) + 1;
      return { ok: false, code, data };
    }
    return { ok: true, data };
  } catch (e) {
    const k = `${label}: ${e.name === "TimeoutError" ? "timeout (30s)" : e.message}`;
    errors[k] = (errors[k] || 0) + 1;
    return { ok: false, code: "error" };
  }
}
const rpc = (name, args = {}, token, label = name) => step(label, `${URL_}/rest/v1/rpc/${name}`, { body: args, token });
const fn = (name, body, token, label) => step(label, `${URL_}/functions/v1/${name}`, { body, token });

/* ------------------------------------------------------------- read-only -- */
async function reader() {
  await sleep(Math.random() * EVERY * 1000);
  await rpc("features");
  while (!end()) {
    await rpc("song_board");
    await sleep(EVERY * 1000);
  }
}

/* ------------------------------------------------------------- the night -- */
// A real (tiny) JPEG, padded with comment segments to about --photo-kb.
const TINY = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAAQABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDEooor1zgP/9k=", "base64");
function photo(kb) {
  const parts = [TINY.subarray(0, 2)];
  let left = Math.max(0, kb * 1024 - TINY.length);
  while (left > 0) {
    const n = Math.min(left, 65533), seg = Buffer.alloc(n + 4);
    seg[0] = 0xff; seg[1] = 0xfe; seg.writeUInt16BE(n + 2, 2);
    parts.push(seg); left -= n + 4;
  }
  parts.push(TINY.subarray(2));
  return Buffer.concat(parts);
}
const PHOTO = photo(PHOTO_KB);
const QUERIES = ["september", "dancing queen", "mr brightside", "shut up and dance", "uptown funk", "valerie",
  "hey ya", "levitating", "september earth wind", "i wanna dance with somebody", "pitbull", "abba", "beyonce"];
const any = (list) => list[Math.floor(Math.random() * list.length)];

async function guest(i, passes) {
  await sleep(Math.random() * RAMP * 1000);
  const s = await step("sign_in", `${URL_}/auth/v1/signup`, { body: {} });
  const token = s.data?.access_token;
  if (!token) return;
  await rpc("claim_pass", { p_token: passes[i % passes.length] }, token);
  await rpc("features");
  await rpc("my_pass_card", {}, token);
  let nextCamera = 0, left = 12;
  while (!end()) {
    const board = await rpc("song_board", {}, token);
    if (Date.now() >= nextCamera) {
      const c = await rpc("camera_status", {}, token);
      if (c.ok) left = c.data.left;
      nextCamera = Date.now() + 20000;
    }
    const r = Math.random();
    if (r < 0.12) {
      const found = await fn("songs", { action: "search", q: any(QUERIES) }, token, "search");
      const results = (found.data?.results || []).filter((t) => t.spotify_id && t.allowed !== false);
      if (results.length && Math.random() < 0.4) {
        await fn("songs", { action: "request", spotify_id: any(results).spotify_id }, token, "request");
      }
    } else if (r < 0.3) {
      const reqs = (board.data?.requests || []).filter((x) => x.status === "queued" && !x.voted);
      if (reqs.length) await rpc("vote", { p_request_id: any(reqs).id }, token);
    } else if (r < 0.4 && left > 0) {
      const res = await fn("camera", { action: "reserve", client_id: crypto.randomUUID() }, token, "reserve");
      if (res.ok && res.data.upload) {
        const up = await step("upload", `${URL_}/storage/v1/object/upload/sign/photos/${res.data.upload.path}?token=${res.data.upload.token}`,
          { method: "PUT", raw: PHOTO, headers: { "Content-Type": "image/jpeg", "x-upsert": "true" } });
        if (up.ok) await rpc("confirm_shot", { p_photo_id: res.data.photo_id }, token);
      }
      if (res.ok) left = res.data.left;
    }
    await sleep(EVERY * 1000 * (0.5 + Math.random()));
  }
}

/* ------------------------------------------------------------------ run -- */
function stats(list) {
  if (!list || !list.length) return "no successful calls";
  const s = [...list].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))].toFixed(0);
  return `${String(s.length).padStart(5)} ok · p50 ${at(0.5)} ms · p95 ${at(0.95)} ms · max ${s.at(-1).toFixed(0)} ms`;
}

let passes = [];
if (NIGHT) {
  if (!ORG_KEY) { console.error("--night needs the organizer key: --key '<organizer key>' (or KT_ORG_KEY)."); process.exit(1); }
  if (PHONES > 250) { console.error("Over 250 phones would use up the hour's anonymous sign-ins (300 per IP)."); process.exit(1); }
  const made = await rpc("admin_make_test_passes", { p_key: ORG_KEY, p_count: 10 }, null, "setup");
  if (!made.ok) { console.error("Couldn't make test passes:", made.code, made.data?.message || ""); process.exit(1); }
  passes = made.data.test_passes.map((p) => p.token);
  const f = await rpc("features", {}, null, "setup");
  for (const name of ["songs", "camera"]) {
    const st = f.data?.[name]?.state;
    if (st && st !== "open") console.log(`! ${name} is ${st}: its writes will come back as refusals. Open it in /admin/ for the test.`);
  }
  console.log(`${PHONES} guests on ${passes.length} test passes, starting within ${RAMP}s, for ${MINUTES} min, photos ${PHOTO_KB} KB, against ${URL_}`);
} else {
  console.log(`${PHONES} phones, every ${EVERY}s, for ${MINUTES} min, against ${URL_}`);
}
deadline = Date.now() + MINUTES * 60_000;
const ticker = setInterval(() => process.stdout.write(`  ${calls} calls…\r`), 5000);
await Promise.all(Array.from({ length: PHONES }, (_, i) => NIGHT ? guest(i, passes) : reader()));
clearInterval(ticker);

console.log("");
for (const [label, list] of Object.entries(times)) if (label !== "setup") console.log(`${label.padEnd(14)}${stats(list)}`);
const refs = Object.entries(refusals).filter(([k]) => !k.startsWith("setup"));
if (refs.length) console.log("refusals (the app saying no; expected in moderation):\n" + refs.map(([k, n]) => `  ${n} × ${k}`).join("\n"));
const errs = Object.entries(errors);
console.log(errs.length ? "ERRORS:\n" + errs.map(([k, n]) => `  ${n} × ${k}`).join("\n") : "no errors");

if (NIGHT && has("cleanup")) {
  const c = await fn("camera", { action: "purge", key: ORG_KEY, what: "test_passes" }, null, "cleanup");
  console.log(c.ok ? `cleaned up: test passes, their song activity and ${c.data.removed} photos removed` : `cleanup failed (${c.code}): use /admin/ -> Delete test passes`);
} else if (NIGHT) {
  console.log("Clean up: /admin/ -> Rehearsal -> Delete test passes.");
}
process.exit(errs.length ? 1 : 0);
