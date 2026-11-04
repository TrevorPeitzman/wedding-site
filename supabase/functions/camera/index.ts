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
//   phone holding a claimed pass. Before it, a not_revealed refusal.
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
      if (!paths.length) return json({ ok: true, photos: [] });
      const { data: urls, error: urlError } = await admin.storage.from("photos").createSignedUrls(paths, 3600);
      if (urlError) throw urlError;
      return json({ ok: true, photos: urls.filter((u) => u.signedUrl).map((u) => ({ path: u.path, url: u.signedUrl })) });
    }

    return refuse("bad_request", "Unknown action.");
  } catch (err) {
    console.error(err);
    return refuse("unavailable", "The camera is having a moment. Your photo is safe on this phone; we'll keep trying.");
  }
});
