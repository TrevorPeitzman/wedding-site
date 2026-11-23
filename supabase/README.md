# Supabase backend

Everything that has to be shared between phones lives here: the song board,
the disposable camera, the feature schedule, and (next) the Wallet passes. The
pages themselves are static on GitHub Pages and talk to this project directly.

```
config.toml   Edge Functions + the photos bucket (the GitHub integration deploys both)
migrations/   schema + every rule, as Postgres functions (the only API)
functions/    songs: Spotify search and song submission
              camera: signed upload URLs for reserved shots; gallery (and album) links after the reveal;
                      organizer album uploads, list and delete;
                      organizer-only photo list with links ("admin_photos") and
                      "purge" of test passes' photo files (rehearsal)
              wallet: serves a guest's signed Apple pass to its token (no login)

tests/sql/    (repo root) run.sh: migrations + SQL tests on a throwaway Postgres
```

## How it fits together

| Browser does | Goes to | Who is allowed |
| --- | --- | --- |
| Read the feature schedule | `rpc('features')` | anyone |
| Read the song board | `rpc('song_board')` | anyone |
| Vote, claim a pass | `rpc('vote')`, `rpc('claim_pass')` | a signed-in guest (anonymous user) |
| Search, request a song | Edge Function `songs` | anyone / signed-in guest |
| Camera status, confirm a shot | `rpc('camera_status')`, `rpc('confirm_shot')` | a guest (claimed pass for the camera) |
| Reserve a shot + upload URL; gallery | Edge Function `camera` | a guest with a claimed pass |
| Landing page pass card | `rpc('my_pass_card')` | a guest with a claimed pass |
| Download the Apple Wallet pass | Edge Function `wallet` (`GET ?t=<token>`) | whoever holds the token, while `wallet` is open |
| DJ view | `rpc('admin_board' …)` with `p_key` | DJ key or organizer key |
| Organizer screen | `rpc('admin_features' / 'admin_set_feature' / 'admin_set_camera')` | organizer key |
| Gallery password: status, unlock | `rpc('gallery_status' / 'unlock_gallery')` | anyone / signed-in guest |
| Set the gallery password | `rpc('admin_gallery_password')` | organizer key |
| Organizer photos: list, hide | `camera` function `admin_photos`, `rpc('admin_hide_photo')` | organizer key |
| Shots by guest, reset a counter | `rpc('admin_shots' / 'admin_reset_shots')` | organizer key |
| Photo album: upload, list, hide, delete | `camera` function `album_reserve` / `album_list` / `album_delete`, `rpc('admin_album_confirm' / 'admin_album_hide')` | organizer key |
| Rehearsal tools | `rpc('admin_rehearsal' / 'admin_make_test_passes' / 'admin_clear_songs')`, `camera` function `purge` | organizer key |

Tables are never exposed: RLS is on with no policies, and the API roles have
no table grants. Each guest phone becomes a Supabase **anonymous user** the
first time it votes, requests or opens the camera; clearing the browser makes a
new guest. Votes are one per song per phone (a unique index); camera shots are
12 per **pass**, however many phones claimed it.

The schedule (`feature_schedule`) is enforced here, not just in the pages:
requests and votes need `songs` open, new shots need `camera` open. Outside
the window they are refused with `feature_soon` or `feature_closed`.

## Setting up the hosted project

1. Create a project at supabase.com. Plan: **Pro** for November (photos will
   pass the free plan's 1 GB, and free projects pause when idle). Downgrade
   after the photos are exported.
2. **Deploys:** link the repo with Supabase's GitHub integration so each push
   to `main` applies new `migrations/`, deploys the functions and creates the
   `photos` bucket (see `DEPLOY.md`: the working directory is `.`). Check
   Database → Migrations before the next step.
3. **Keys**, in the SQL editor, each a long random string of your own, **at
   least 16 characters** (shorter ones are refused). To make one:
   `select encode(extensions.gen_random_bytes(18), 'base64');`
   ```sql
   select app_private.set_admin_key('<DJ key>');
   select app_private.set_organizer_key('<organizer key>');
   ```
   Setting a key again replaces the old one: links with the old key stop
   working, and a browser that saved it asks for the new one.
   DJ view: `https://wedding.peitzman.net/songs/dj/#key=<DJ key>` (or `/dj/#key=…`).
   Organizer screen: `https://wedding.peitzman.net/admin/#key=<organizer key>`.
   The organizer key also opens the DJ view; the DJ key can't open the admin
   screen, change the camera or release the photos.
4. **Auth** (the GitHub deploy ignores these): Authentication → Sign In /
   Providers → **Allow anonymous sign-ins** on. Authentication → Rate Limits →
   **anonymous sign-ins per hour** well above the default 30 (it's 300 now).
   Every guest on venue wifi shares one IP address.
5. **Spotify:** `supabase secrets set SPOTIFY_CLIENT_ID=... SPOTIFY_CLIENT_SECRET=... SPOTIFY_MARKET=US`.
   Without them the `songs` function searches a small demo catalog. The
   Spotify app setup is in `docs/songs.md`.
6. **Site:** the project URL and the **anon** key go in `site/assets/config.js`.
   Both are public by design. Never put the service-role or a secret key there.
7. **Guests:** `python3 scripts/import_passes.py <workbook.xlsx>` writes
   `private/passes.sql`. Open that file in a text editor, copy **everything in
   it**, paste it into the SQL editor and Run. (Typing the file's name runs
   nothing: the editor only sees the text you paste.) With the CLI instead:
   `psql "<connection string>" -f private/passes.sql`. Re-run both whenever the
   workbook changes; tokens never change once issued (they're in
   `private/pass-tokens.csv`, so back that file up).

## The organizer screen (`/admin/`)

- Each feature (schedule, details, song requests, camera, Wallet pass): on/off,
  an opening time and a closing time, in Pacific time. Pages follow within a
  page load; the database enforces it at once.
- Camera: shots per pass, when the photos come out, and **Release photos now**.
- Photos: every shot with who took it; filter by table; hide one from the
  gallery; download selected or all.
- Live counts: photos uploaded and still uploading, passes shooting, passes
  scanned.

The same settings by SQL, if the screen is ever out of reach:
```sql
update public.feature_schedule set is_on = false where feature = 'camera';
update public.feature_schedule set opens_at = '2026-11-21 17:45-08' where feature = 'camera';
update public.events set photos_reveal_at = now();          -- release the photos
```

## Wallet passes

- Signed `.pkpass` files sit in the private `wallet` bucket as
  `<zola_guest_id>.pkpass`, made and uploaded by `scripts/make_wallet_passes.py`
  (steps in `docs/wallet.md`). Until a guest's file is there, their landing
  page just shows the on-screen pass.
- The `wallet` function has `verify_jwt = false` in `config.toml`: Safari opens
  it as a plain link, and the 16-character pass token is the credential.
- Google save links go in `passes.google_save_url` (generator not built yet).

## The camera

- Photos land in the private `photos` bucket (JPEG only, 8 MB), one
  `<photo id>.jpg` per shot. `public.photos` records whose pass took each one
  and whether it uploaded.
- `/admin/` → Photos shows every photo as it uploads, with the guest's name,
  table and time, before the reveal too (signed links, 1 hour; **Refresh
  photos** renews them). **Hide** takes one out of the guest gallery (it
  still counts as a shot); **Show** puts it back. The same by SQL:
  ```sql
  update public.photos set status = 'removed' where id = '<photo id>';
  ```
- Export everything after the night: `/admin/` → Photos → **Download all**
  (.zip files of 100, built in the browser), Storage → `photos` in the
  dashboard, or with the CLI (check `supabase storage cp --help` first; it's
  experimental): `supabase storage cp -r ss:///photos ./photos-export --experimental --linked`.
- Guests save from `/photos/` after the reveal: Select some or Save all.
- **Gallery password** (`/admin/` → Camera → Gallery password): the same one
  as the Zola site, so guests without their boarding pass (at home, on a
  laptop) can see the photos. Only a bcrypt hash is kept; capitals and spaces
  don't matter. By SQL: `select app_private.set_gallery_password('...');`
- **Photo album** (`/admin/` → Photo album): photos from other cameras. Each
  is two files in the private `album` bucket, `<id>/full.<ext>` (the original:
  JPEG, PNG or WebP, up to 40 MB) and `<id>/web.jpg` (2048px, made in the
  browser for the grid); `public.album_photos` lists them. Guests see them on
  `/photos/` after the reveal and save the originals. Zips split at 100 photos
  or 200 MB.
- Give a guest their shots back: `/admin/` → Camera → Shots by guest →
  **Reset shots** (or **Reset everyone's shots**). Their photos stay; shots
  taken before the reset just stop counting (`passes.shots_reset_at`).

## Rehearsal

- Test passes (`passes.is_test`) come from `/admin/` → Rehearsal, up to 10.
  Their photos are left out of the gallery; their shots can be reset.
- **Delete test passes** removes them, their photo rows and their files.
  **Clear song board** deletes every request and vote (type CLEAR).
- Load tests: `node scripts/load_test.mjs --phones 105 --minutes 3` (read-only), and
  `--night --key '<organizer key>' --cleanup` (60 guests doing everything, on test passes).
  Details in `docs/runbook.md`.
- **Delete test passes** also removes song requests and votes made from phones on test passes.
- Full checklist: `docs/runbook.md`.

## Before the day

- Set the night's schedule in `/admin/`.
- Close or tune requests in the DJ view: cooldowns, songs per guest, explicit filter.
- Delete the two example rules on the do-not-play list.
- Back up: Database → Backups is daily on Pro; also export the setlist from the DJ view.

## Tests

```bash
tests/sql/run.sh
npx -y deno@2.1.4 check supabase/functions/*/index.ts
```

Supabase runs pg-safeupdate for API calls: a `DELETE` or `UPDATE` without a
`WHERE` fails there ("DELETE requires a WHERE clause") but works locally. A
test checks that no public function has one.

The SQL tests need only the Postgres server binaries (`initdb`, `pg_ctl`), not
Docker or the Supabase CLI. `stub_supabase.sql` fakes the parts of Supabase
the migrations use (`auth.uid()`, the API roles, Storage's tables). CI runs
them on every change under `supabase/` or `tests/sql/`. They live outside
`supabase/tests/` because the Supabase CLI reserves that folder for pgTAP.

The Edge Functions are type-checked but not run by these tests. Try a change
with `supabase start` and `supabase functions serve` before relying on it.
