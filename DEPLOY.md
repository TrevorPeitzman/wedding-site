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
2. Supabase directory: `supabase`. Turn on **Deploy to production** for branch
   `main`. Leave **Automatic branching** off: preview branches are billed
   separately, and one event doesn't need them.
3. Let the integration apply the migrations on the next push to `main`,
   rather than pasting them into the SQL editor. If you already pasted the
   first one, that's fine: it is safe to apply twice.
4. From then on, a database change is a new file in `supabase/migrations/`.
   Never edit one that has already been applied: it won't run again.

Still manual, because they're secrets or private data: the DJ key
(`select app_private.set_admin_key(...)`), the Spotify secrets, and loading
guests (`scripts/import_passes.py`, then run `private/passes.sql`).

**Edge Functions: the `Deploy functions` workflow.** Add repository secrets
`SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_REF` (instructions at the top of
`.github/workflows/functions.yml`), and every change to `supabase/functions/`
on `main` deploys. If your integration screen says it deploys functions too,
you can skip these secrets.

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
