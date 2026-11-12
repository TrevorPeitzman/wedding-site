// Edge Function: the disposable camera's two privileged steps.
//
// POST { action: "reserve", client_id }  -> { ok, photo_id, path, left, status, upload: { path, token } }
//   Reserves (or, for a retry, re-reads) the photo's slot as the guest, then
//   signs an upload URL for that one path in the private `photos` bucket. The
//   phone uploads with supabase.storage.from('photos').uploadToSignedUrl(),
//   then calls the confirm_shot RPC, which checks the file really arrived.
//
// POST { action: "gallery" }  -> { ok, photos: [{ path, url }] }
//   After the reveal, signed URLs (1 hour) for every uploaded photo, for a
//   phone holding a claimed pass or let in by the gallery password
//   (unlock_gallery). Before it, a not_revealed refusal.
//
// POST { action: "purge", key, what: "test_pass" | "test_passes", token? }
//   Organizer only (rehearsal): drops test shots and removes their files.
//
// POST { action: "admin_photos", key, include_tests? }  -> { ok, photos: [{ id, url, first_name, ... }] }
//   Organizer only: every uploaded photo (hidden ones too) with who took it
//   and a signed URL (1 hour), for the Photos section of /admin/. Works
//   before the reveal.
//
// Photo album (organizer key; files in the private `album` bucket):
// POST { action: "album_reserve", key, name, ext, credit? } -> { ok, id, full: { path, token }, web: { path, token } }
//   then the browser uploads both and calls rpc admin_album_confirm.
// POST { action: "album_list", key }        -> { ok, photos: [{ id, ..., web_url, full_url }] }
// POST { action: "album_delete", key, id }  -> { ok } (row and both files)
// The gallery action also returns `album` once the photos are out.
//
// Refusals come back as 200 { ok: false, code, message } like `songs`.
import { createClient } from "jsr:@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const URL_ = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
function refuse(code: string, message: string) {
  return json({ ok: false, code, message });
}
// deno-lint-ignore no-explicit-any
function fromDb(error: any) {
  if (error?.code === "P0001") return refuse(error.details ?? "refused", error.message);
  throw error;
}

// Signed links (1 hour) for album rows: the 2048px copy and the original.
// deno-lint-ignore no-explicit-any
async function signAlbum(rows: any[]) {
  const urls = new Map<string, string>();
  const paths = rows.flatMap((r) => [r.web_path, r.full_path]);
  for (let i = 0; i < paths.length; i += 500) {
    const { data, error } = await admin.storage.from("album").createSignedUrls(paths.slice(i, i + 500), 3600);
    if (error) throw error;
    for (const u of data) if (u.signedUrl && u.path) urls.set(u.path, u.signedUrl);
  }
  return rows.filter((r) => urls.has(r.web_path) && urls.has(r.full_path))
    .map((r) => ({ ...r, web_url: urls.get(r.web_path), full_url: urls.get(r.full_path) }));
}

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
    // Rehearsal clean-up, organizer key only: the database checks the key,
    // drops the rows and returns the photo paths; this removes the files.
    //   { action: "purge", key, what: "test_pass", token }  one test pass's shots
    //   { action: "purge", key, what: "test_passes" }       every test pass
    if (body.action === "purge") {
      const anon = createClient(URL_, Deno.env.get("SUPABASE_ANON_KEY")!, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const key = String(body.key ?? "");
      const call = body.what === "test_pass"
        ? anon.rpc("admin_reset_test_pass", { p_key: key, p_token: String(body.token ?? "") })
        : body.what === "test_passes"
        ? anon.rpc("admin_delete_test_passes", { p_key: key })
        : null;
      if (!call) return refuse("bad_request", "Unknown clean-up.");
      const { data: paths, error } = await call;
      if (error) return fromDb(error);
      if (paths.length) {
        const { error: rmError } = await admin.storage.from("photos").remove(paths);
        if (rmError) throw rmError;
      }
      return json({ ok: true, removed: paths.length });
    }

    // The organizer's photo view: the database checks the key and lists the
    // rows; this signs a link for each file.
    if (body.action === "admin_photos") {
      const anon = createClient(URL_, Deno.env.get("SUPABASE_ANON_KEY")!, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data: rows, error } = await anon.rpc("admin_photos", {
        p_key: String(body.key ?? ""),
        p_include_tests: body.include_tests === true,
      });
      if (error) return fromDb(error);
      // deno-lint-ignore no-explicit-any
      const list = rows as any[];
      const urls = new Map<string, string>();
      for (let i = 0; i < list.length; i += 500) {
        const paths = list.slice(i, i + 500).map((r) => r.path);
        const { data: signed, error: urlError } = await admin.storage.from("photos").createSignedUrls(paths, 3600);
        if (urlError) throw urlError;
        for (const u of signed) if (u.signedUrl && u.path) urls.set(u.path, u.signedUrl);
      }
      return json({
        ok: true,
        photos: list.filter((r) => urls.has(r.path)).map((r) => ({ ...r, url: urls.get(r.path) })),
      });
    }

    if (body.action === "album_reserve" || body.action === "album_list" || body.action === "album_delete") {
      const anon = createClient(URL_, Deno.env.get("SUPABASE_ANON_KEY")!, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const key = String(body.key ?? "");
      if (body.action === "album_reserve") {
        const { data: a, error } = await anon.rpc("admin_album_reserve", {
          p_key: key, p_name: String(body.name ?? ""), p_ext: String(body.ext ?? ""),
          p_credit: body.credit ? String(body.credit) : null,
        });
        if (error) return fromDb(error);
        const bucket = admin.storage.from("album");
        const full = await bucket.createSignedUploadUrl(a.full_path, { upsert: true });
        const web = await bucket.createSignedUploadUrl(a.web_path, { upsert: true });
        if (full.error) throw full.error;
        if (web.error) throw web.error;
        return json({ ok: true, ...a, full: { path: full.data.path, token: full.data.token },
                      web: { path: web.data.path, token: web.data.token } });
      }
      if (body.action === "album_delete") {
        const { data: paths, error } = await anon.rpc("admin_album_delete", { p_key: key, p_id: String(body.id ?? "") });
        if (error) return fromDb(error);
        const { error: rmError } = await admin.storage.from("album").remove(paths);
        if (rmError) throw rmError;
        return json({ ok: true });
      }
      const { data: rows, error } = await anon.rpc("admin_album", { p_key: key });
      if (error) return fromDb(error);
      return json({ ok: true, photos: await signAlbum(rows) });
    }

    const auth = req.headers.get("Authorization") ?? "";
    const { data: who } = await admin.auth.getUser(auth.replace(/^Bearer\s+/i, ""));
    if (!who?.user) return refuse("no_session", "Reload the page and try again.");

    if (body.action === "reserve") {
      const clientId = String(body.client_id ?? "");
      if (!/^[0-9a-f-]{36}$/i.test(clientId)) return refuse("bad_request", "Something went wrong. Try again?");
      // As the guest, so the database sees auth.uid() and applies every rule.
      const asGuest = createClient(URL_, Deno.env.get("SUPABASE_ANON_KEY")!, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: auth } },
      });
      const { data: slot, error } = await asGuest.rpc("reserve_shot", { p_client_id: clientId });
      if (error) return fromDb(error);
      if (slot.status === "uploaded") return json({ ok: true, ...slot, upload: null });
      // upsert: a retry after a lost response may overwrite its own half-done file.
      const { data: signed, error: signError } = await admin.storage
        .from("photos").createSignedUploadUrl(slot.path, { upsert: true });
      if (signError) throw signError;
      return json({ ok: true, ...slot, upload: { path: signed.path, token: signed.token } });
    }

    if (body.action === "gallery") {
      const { data: paths, error } = await admin.rpc("gallery_paths_as", { p_guest: who.user.id });
      if (error) return fromDb(error);
      // gallery_paths_as checked the pass and the reveal; the album follows.
      const { data: albumRows, error: albumError } = await admin.rpc("album_paths");
      if (albumError) throw albumError;
      const album = await signAlbum(albumRows);
      if (!paths.length) return json({ ok: true, photos: [], album });
      const { data: urls, error: urlError } = await admin.storage.from("photos").createSignedUrls(paths, 3600);
      if (urlError) throw urlError;
      return json({ ok: true, album,
                    photos: urls.filter((u) => u.signedUrl).map((u) => ({ path: u.path, url: u.signedUrl })) });
    }

    return refuse("bad_request", "Unknown action.");
  } catch (err) {
    console.error(err);
    return refuse("unavailable", "The camera is having a moment. Your photo is safe on this phone; we'll keep trying.");
  }
});
