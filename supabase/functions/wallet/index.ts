// Edge Function: serve a guest's signed Apple Wallet pass.
//
// GET /functions/v1/wallet?t=<pass token>
//   -> the .pkpass from the private `wallet` bucket, as
//      application/vnd.apple.pkpass, so Safari opens the Add to Wallet sheet.
//
// The link is opened straight from the landing page (a plain navigation, no
// Authorization header), so verify_jwt is off for this function in
// supabase/config.toml. The 16-character random pass token is the credential,
// exactly as it is for the QR on the paper pass; the database also checks the
// `wallet` feature is open (wallet_file_as).
//
// Passes are made and uploaded by scripts/make_wallet_passes.py.
import { createClient } from "jsr:@supabase/supabase-js@2.45.4";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const SITE = "https://wedding.peitzman.net";

// A small page in plain words for anything but a pass: a phone that lands
// here by mistake should see why, and a way back.
function page(status: number, message: string) {
  const esc = message.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Your boarding pass</title><body style="font-family:Georgia,serif;color:#1F51A0;background:#F1F0F0;` +
    `max-width:32em;margin:3em auto;padding:0 1em;line-height:1.6"><p>${esc}</p>` +
    `<p><a href="${SITE}/p/" style="color:#1F51A0">Back to your boarding pass</a></p></body>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

Deno.serve(async (req) => {
  if (req.method !== "GET") return new Response("GET only", { status: 405 });
  const token = new URL(req.url).searchParams.get("t") ?? "";
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(token)) return page(404, "We could not find that boarding pass.");

  try {
    const { data: path, error } = await admin.rpc("wallet_file_as", { p_token: token });
    if (error) {
      if (error.code === "P0001") return page(error.details === "unknown_pass" ? 404 : 403, error.message);
      throw error;
    }
    const { data: file, error: dlError } = await admin.storage.from("wallet").download(path);
    if (dlError || !file) throw dlError ?? new Error("empty download");
    return new Response(file, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.apple.pkpass",
        "Content-Disposition": 'attachment; filename="KT1121.pkpass"',
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error(err);
    return page(503, "Your Wallet pass is having a moment. Try again in a minute; your paper pass works just the same.");
  }
});
