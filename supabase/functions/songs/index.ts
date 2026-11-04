// Edge Function: Spotify search and song submission for the guest board.
//
// Why this exists: the Spotify client secret must stay off the static site,
// and a submitted song must be looked up here rather than trusted from the
// browser (a guest could otherwise put any title or artwork on the board).
//
// POST { action: "search", q }                       -> { ok, results, live }
// POST { action: "request", spotify_id, requester_name? }
// POST { action: "request", title, artist, requester_name? }   (manual entry)
//                                                    -> { ok, action, request_id }
// Guest-facing refusals come back as 200 { ok: false, code, message, retry_after }
// so the page can show them without unpacking an HTTP error.
//
// Secrets (supabase secrets set ...): SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET,
// optional SPOTIFY_MARKET (default US). Without the Spotify pair the function
// searches the small demo catalog in demo-tracks.json.
import { createClient } from "jsr:@supabase/supabase-js@2.45.4";
import demoTracks from "./demo-tracks.json" with { type: "json" };

type Track = {
  spotify_id: string | null;
  title: string;
  artist: string;
  album: string | null;
  artwork_url: string | null;
  duration_ms: number | null;
  explicit: boolean;
  preview_url: string | null;
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SPOTIFY_ID = Deno.env.get("SPOTIFY_CLIENT_ID") ?? "";
const SPOTIFY_SECRET = Deno.env.get("SPOTIFY_CLIENT_SECRET") ?? "";
const MARKET = Deno.env.get("SPOTIFY_MARKET") ?? "US";
const LIVE = Boolean(SPOTIFY_ID && SPOTIFY_SECRET);

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function refuse(code: string, message: string, retry_after: number | null = null) {
  return json({ ok: false, code, message, retry_after });
}

// ---------------------------------------------------------------- Spotify --

let token: { value: string; expires: number } | null = null;

async function spotifyToken(): Promise<string> {
  if (token && Date.now() < token.expires) return token.value;
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${SPOTIFY_ID}:${SPOTIFY_SECRET}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`Spotify token: ${res.status}`);
  const data = await res.json();
  token = { value: data.access_token, expires: Date.now() + (data.expires_in - 60) * 1000 };
  return token.value;
}

// deno-lint-ignore no-explicit-any
function normalize(item: any): Track {
  const images = item?.album?.images ?? [];
  return {
    spotify_id: item.id,
    title: item.name ?? "",
    // deno-lint-ignore no-explicit-any
    artist: (item.artists ?? []).map((a: any) => a.name).filter(Boolean).join(", "),
    album: item?.album?.name ?? null,
    // Spotify lists images largest first; the smallest is plenty for a row.
    artwork_url: images.length ? images[images.length - 1].url : null,
    duration_ms: item.duration_ms ?? null,
    explicit: Boolean(item.explicit),
    preview_url: item.preview_url ?? null,
  };
}

async function search(q: string): Promise<Track[]> {
  const needle = q.trim().toLowerCase();
  if (needle.length < 2) return [];
  if (!LIVE) {
    return (demoTracks as Track[])
      .filter((t) => `${t.title} ${t.artist} ${t.album ?? ""}`.toLowerCase().includes(needle))
      .sort((a, b) => Number(!a.title.toLowerCase().includes(needle)) - Number(!b.title.toLowerCase().includes(needle)))
      .slice(0, 8);
  }
  const url = new URL("https://api.spotify.com/v1/search");
  url.search = new URLSearchParams({ q, type: "track", limit: "8", market: MARKET }).toString();
  const res = await fetch(url, { headers: { Authorization: `Bearer ${await spotifyToken()}` } });
  if (!res.ok) throw new Error(`Spotify search: ${res.status}`);
  const data = await res.json();
  return (data?.tracks?.items ?? []).map(normalize);
}

async function lookup(id: string): Promise<Track | null> {
  if (!/^[A-Za-z0-9]{1,40}$/.test(id)) return null;
  if (!LIVE) return (demoTracks as Track[]).find((t) => t.spotify_id === id) ?? null;
  const res = await fetch(`https://api.spotify.com/v1/tracks/${id}?market=${MARKET}`, {
    headers: { Authorization: `Bearer ${await spotifyToken()}` },
  });
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new Error(`Spotify lookup: ${res.status}`);
  return normalize(await res.json());
}

// ------------------------------------------------------------------ server --

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, message: "POST only" }, 405);

  // deno-lint-ignore no-explicit-any
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return refuse("bad_request", "Something went wrong. Try again?");
  }

  try {
    if (body.action === "search") {
      const found = await search(String(body.q ?? "").slice(0, 200));
      const { data, error } = await admin.rpc("allowed_tracks", { p_tracks: found });
      if (error) throw error;
      return json({ ok: true, live: LIVE, results: data });
    }

    if (body.action === "request") {
      // The guest's own session (a Supabase anonymous user), not the anon key.
      const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
      const { data: who } = await admin.auth.getUser(jwt);
      if (!who?.user) return refuse("no_session", "Reload the page and try again.");

      let track: Track | null;
      if (body.spotify_id) {
        track = await lookup(String(body.spotify_id).trim());
        if (!track) return refuse("unknown_track", "We couldn't find that song. Try searching again.");
      } else {
        const title = String(body.title ?? "").trim().slice(0, 200);
        const artist = String(body.artist ?? "").trim().slice(0, 200);
        if (!title || !artist) return refuse("incomplete_track", "Give both a song title and an artist.");
        track = { spotify_id: null, title, artist, album: null, artwork_url: null,
                  duration_ms: null, explicit: false, preview_url: null };
      }

      const { data, error } = await admin.rpc("submit_request_as", {
        p_guest: who.user.id,
        p_track: track,
        p_requester_name: body.requester_name ? String(body.requester_name).slice(0, 60) : null,
      });
      if (error) {
        // Raised by the database rules: detail = code, hint = retry-after.
        if (error.code === "P0001") {
          return refuse(error.details ?? "refused", error.message, error.hint ? Number(error.hint) : null);
        }
        throw error;
      }
      return json({ ok: true, ...data });
    }

    return refuse("bad_request", "Unknown action.");
  } catch (err) {
    console.error(err);
    return refuse("unavailable", "Song search is having a moment. Try again in a second.");
  }
});
