# Deploying wedding.peitzman.net

Three parts, in this order: Supabase (the backend), GitHub Pages (the site),
then DNS. Total hands-on time is about 30 minutes, plus waiting for DNS and
the HTTPS certificate.

## 1. Supabase

Follow `supabase/README.md` for the project itself (plan, auth settings, DJ
key, Spotify secrets, `site/assets/config.js`). Two choices about how changes
reach it:

**Database: link the repo with Supabase's GitHub integration (recommended).**
The repo already has the layout it expects: `supabase/config.toml`, and
timestamped files in `supabase/migrations/`.

1. Supabase dashboard → Project Settings → Integrations → GitHub → connect,
   and pick `TrevorPeitzman/wedding-site`.
2. **Working directory: `.`** (a single dot). It is the folder that *contains*
   `supabase/`, which here is the repo root. Entering `supabase` makes the
   integration look in `supabase/supabase/` and silently deploy nothing.
3. Turn on **Deploy to production** for branch `main`. Leave **Automatic
   branching** off: preview branches are billed separately, and one event
   doesn't need them.
4. The integration deploys **only when something is pushed or merged to
   `main` after it is enabled**. If it was set up after the last merge, the
   next merge triggers the first deploy. It applies new files in
   `supabase/migrations/` and deploys the Edge Functions declared in
   `supabase/config.toml` (`songs` is). Auth and API settings in that file are
   ignored: set those in the dashboard.
5. Check it worked: Database → Migrations should list
   `20261104000000_song_requests` and `20261105000000_pass_details`. Only then
   run the DJ key command below.
6. From then on, a database change is a new file in `supabase/migrations/`.
   Never edit one that has already been applied: it won't run again.

Still manual, because they're secrets or private data: the DJ key
(`select app_private.set_admin_key(...)`), the Spotify secrets, and loading
guests (`scripts/import_passes.py`, then run `private/passes.sql`).

**Edge Functions** deploy through the integration (step 4). The `Deploy
functions` workflow is a fallback if you don't use the integration: add
repository secrets `SUPABASE_ACCESS_TOKEN` (a scoped token) and
`SUPABASE_PROJECT_REF`, and every change to `supabase/functions/` on `main`
deploys. With both set up, a function just deploys twice, which is harmless.

## 2. GitHub Pages

**The repo is private.** GitHub Pages publishes from a private repo only on a
paid plan (GitHub Pro, $4/month). Choose one:

- **GitHub Pro.** Nothing else changes.
- **Make the repo public.** Nothing secret is committed: guest data is
  git-ignored (`private/`, `*.xlsx`), the Supabase anon key in `config.js` is
  public by design, and the DJ key exists only as a hash in the database. The
  code, including the DJ view, would be readable by anyone.
- **Host the pages elsewhere** (Cloudflare Pages or Netlify point at `site/`
  with no build command). Skip the rest of this section if so.

Then:

1. Repo → Settings → Pages → Build and deployment → Source: **GitHub Actions**.
2. Merge this branch into `main`. The `Deploy site` workflow publishes `site/`.
   Watch it under the Actions tab; its summary shows the `github.io` URL.
3. Settings → Pages → Custom domain: `wedding.peitzman.net` → Save. (No
   `CNAME` file is needed with an Actions deploy.)

## 3. DNS

At whoever hosts DNS for `peitzman.net`:

| Type | Name | Value |
| --- | --- | --- |
| CNAME | `wedding` | `trevorpeitzman.github.io` |

- Just your username's `github.io`, not the repo name.
- On Cloudflare, set that record to **DNS only** (grey cloud) so GitHub can
  issue the certificate.
- **Verify the domain (recommended):** your GitHub profile → Settings → Pages →
  Add a domain → `peitzman.net`. GitHub shows a TXT record to add. Once it's
  verified, nobody else can point a GitHub site at your subdomains.

Back in Settings → Pages, wait for the DNS check to pass, then tick **Enforce
HTTPS**. The certificate can take from a few minutes to a day.

## 4. Check it

- https://wedding.peitzman.net loads, in day and night colors.
- `/songs/` shows **no** "Demo mode" notice once `config.js` is filled in. A
  test request appears in the DJ view: `/songs/dj/#key=<your key>`.
- A QR link from `private/print-merge-with-qr.csv` opens `/p/` and the address
  bar loses the `?pass=` part.

## Switching things off, or opening them later

`site/assets/features.js` has one line per feature. `on: false` removes it
from the site; `opensAt` sets a time it opens to guests. Commit and push, and
Pages redeploys in about a minute.
