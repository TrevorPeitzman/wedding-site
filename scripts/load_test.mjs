#!/usr/bin/env node
// A rehearsal load test: N phones on the song board at once.
//
//   node scripts/load_test.mjs [--phones 105] [--minutes 3] [--every 7] [--url <other project>]
//
// Each simulated phone does what an open song board does: on load it reads
// the feature schedule, then reads the board every 7 seconds (the page's
// poll), starting at a random moment so they don't all fire together. It is
// read-only (no sign-ins, votes, requests or uploads), so it adds nothing to
// the database; it does hit the LIVE project from site/assets/config.js.
// Run it once, deliberately, during rehearsal week, not on the night.
//
// Prints latency (p50, p95, max) and every error by type. Needs Node 18+
// (built-in fetch); no packages.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const config = readFileSync(join(here, "..", "site", "assets", "config.js"), "utf8");
const pick = (name) => (config.match(new RegExp(name + ":\\s*'([^']+)'")) || [])[1];
const urlArg = process.argv.indexOf("--url");
const URL_ = urlArg > 0 ? process.argv[urlArg + 1] : pick("supabaseUrl"), KEY = pick("supabaseAnonKey");
if (!URL_ || !KEY) { console.error("No supabaseUrl/supabaseAnonKey in site/assets/config.js"); process.exit(1); }

const arg = (name, dflt) => {
  const i = process.argv.indexOf("--" + name);
  return i > 0 ? Number(process.argv[i + 1]) : dflt;
};
const PHONES = arg("phones", 105), MINUTES = arg("minutes", 3), EVERY = arg("every", 7);

const times = { features: [], song_board: [] };
const errors = {};
let calls = 0;

async function rpc(name) {
  const t0 = performance.now();
  calls++;
  try {
    const r = await fetch(`${URL_}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(15000),
    });
    await r.arrayBuffer();
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    times[name].push(performance.now() - t0);
  } catch (e) {
    const k = `${name}: ${e.name === "TimeoutError" ? "timeout (15s)" : e.message}`;
    errors[k] = (errors[k] || 0) + 1;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const end = Date.now() + MINUTES * 60_000;

async function phone() {
  await sleep(Math.random() * EVERY * 1000);
  await rpc("features");
  while (Date.now() < end) {
    await rpc("song_board");
    await sleep(EVERY * 1000);
  }
}

function stats(list) {
  if (!list.length) return "no successful calls";
  const s = [...list].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))].toFixed(0);
  return `${s.length} ok · p50 ${at(0.5)} ms · p95 ${at(0.95)} ms · max ${s.at(-1).toFixed(0)} ms`;
}

console.log(`${PHONES} phones, every ${EVERY}s, for ${MINUTES} min, against ${URL_}`);
const ticker = setInterval(() => process.stdout.write(`  ${calls} calls…\r`), 5000);
await Promise.all(Array.from({ length: PHONES }, phone));
clearInterval(ticker);

console.log(`\nfeatures    ${stats(times.features)}`);
console.log(`song_board  ${stats(times.song_board)}`);
const errs = Object.entries(errors);
console.log(errs.length ? "errors:\n" + errs.map(([k, n]) => `  ${n} × ${k}`).join("\n") : "no errors");
process.exit(errs.length ? 1 : 0);
