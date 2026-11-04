# Deploying wedding.peitzman.net

Three parts, in this order: Supabase (the backend), GitHub Pages (the site),
then DNS. All three are set up and live as of November 4. This guide is how
it was done, and how to redo it.

Day to day, a deploy is just a merge to `main`: Pages republishes `site/`,
and the Supabase integration applies new migrations and redeploys the
functions and the `photos` bucket.

## 1. Supabase

Follow `supabase/README.md` for the project itself (plan, auth settings, the
DJ and organizer keys, Spotify secrets, `site/assets/config.js`, guests). Two
choices about how changes reach it:

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
   `supabase/migrations/`, deploys the Edge Functions declared in
   `supabase/config.toml` (`songs`, `camera`) and creates the buckets declared
   there (`photos`). Auth and API settings in that file are ignored: set those
   in the dashboard.
5. Check it worked: Database → Migrations lists every file in
   `supabase/migrations/`. Only then run the key commands below.
6. From then on, a database change is a new file in `supabase/migrations/`.
   Never edit one that has already been applied: it won't run again.

Still manual, because they're secrets or private data: the DJ and organizer
keys (`app_private.set_admin_key(...)`, `app_private.set_organizer_key(...)`),
the Spotify secrets, and loading guests (`scripts/import_passes.py`, then paste
the contents of `private/passes.sql` into the SQL editor).

**Edge Functions** deploy through the integration (step 4). The `Deploy
functions` workflow is a fallback if you don't use the integration: add
repository secrets `SUPABASE_ACCESS_TOKEN` (a scoped token) and
`SUPABASE_PROJECT_REF`, and every change to `supabase/functions/` on `main`
deploys. With both set up, a function just deploys twice, which is harmless.

## 2. GitHub Pages

**If the repo is private,** GitHub Pages publishes it only on a paid plan
(GitHub Pro, $4/month). Choose one:

- **GitHub Pro.** Nothing else changes.
- **Make the repo public.** Nothing secret is committed: guest data is
  git-ignored (`private/`, `*.xlsx`), the Supabase anon key in `config.js` is
  public by design, and the DJ key exists only as a hash in the database. The
  code, including the DJ view, would be readable by anyone.
- **Host the pages elsewhere** (Cloudflare Pages or Netlify point at `site/`
  with no build command). Skip the rest of this section if so.

Then:

1. Repo → Settings → Pages → Build and deployment → Source: **GitHub Actions**.
2. Merge into `main`. The `Deploy site` workflow publishes `site/`.
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
- `/songs/` shows **no** "Demo mode" notice. A test request appears in the DJ
  view (`/songs/dj/#key=<DJ key>`), and its title opens Spotify.
- A QR link from `private/print-merge-with-qr.csv` opens `/p/` and the address
  bar loses the `?pass=` part. From there, the camera takes a shot and it
  reaches **Uploaded**.
- `/admin/#key=<organizer key>` shows the five features and the camera counts.

## Switching things off, or opening them later

Use the organizer screen, `/admin/`: each feature has an on/off switch and
opening and closing times (Pacific). The database enforces them straight away,
and pages pick them up on their next load; no deploy needed.

`site/assets/features.js` holds the fallback the pages use only when Supabase
can't be reached. Keep its defaults matching the real schedule before the night.
