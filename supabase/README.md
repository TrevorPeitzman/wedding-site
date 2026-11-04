# Supabase backend

Everything that has to be shared between phones lives here: the song board
today, and the boarding passes and camera next. The pages themselves are static
on GitHub Pages and talk to this project directly.

```
migrations/   schema + every rule, as Postgres functions (the only API)
functions/    songs: Spotify search and song submission (Edge Function)
tests/        run.sh: migrations + SQL tests on a throwaway local Postgres
```

## How it fits together

| Browser does | Goes to | Who is allowed |
| --- | --- | --- |
| Read the board | `rpc('song_board')` | anyone |
| Vote, claim a pass | `rpc('vote')`, `rpc('claim_pass')` | a signed-in guest (anonymous user) |
| Search, request a song | Edge Function `songs` | anyone / signed-in guest |
| DJ actions | `rpc('admin_*', { p_key })` | whoever holds the DJ key |

Tables are never exposed: RLS is on with no policies, and the API roles have
no table grants. Each guest phone becomes a Supabase **anonymous user** the
first time it votes or requests. That replaces the old signed cookie, and like
it, clearing the browser makes a new guest. Votes are still one per song per
phone, enforced by a unique index.

## Setting up the hosted project

1. Create a project at supabase.com. Plan: **Pro** for November (photos will
   pass the free plan's 1 GB, and free projects pause when idle). Downgrade
   after the photos are exported.
2. **Database:** run `migrations/20261104000000_song_requests.sql` in the SQL
   editor (or `supabase link` then `supabase db push`).
3. **DJ key:** in the SQL editor, with a long random string of your own:
   ```sql
   select app_private.set_admin_key('<long random string>');
   ```
   The DJ link is then `https://wedding.peitzman.net/songs/dj/#key=<that string>`.
4. **Auth:** Authentication → Sign In / Providers → turn on **Allow anonymous
   sign-ins**. Then Authentication → Rate Limits: raise **anonymous sign-ins
   per hour** well above the default (try 1000). Every guest on venue wifi
   shares one IP address, and the default would lock most of them out.
5. **Edge Function:**
   ```bash
   supabase functions deploy songs
   supabase secrets set SPOTIFY_CLIENT_ID=... SPOTIFY_CLIENT_SECRET=... SPOTIFY_MARKET=US
   ```
   Without the Spotify secrets the function searches the small demo catalog.
   The Spotify app setup is in `wedding-song-requests/README.md`.
6. **Site:** put the project URL and the **anon** key in `site/assets/config.js`
   and push. Both are public by design. Never put the service-role key there.

## Before the day

- Close or tune requests in the DJ view: cooldowns, songs per guest, explicit filter.
- Delete the two example rules on the do-not-play list.
- Back up: Database → Backups is daily on Pro; also export the setlist from the DJ view.

## Tests

```bash
supabase/tests/run.sh
```

It needs only the Postgres server binaries (`initdb`, `pg_ctl`), not Docker or
the Supabase CLI. `stub_supabase.sql` fakes the bits of Supabase the migration
uses (`auth.uid()`, the API roles). CI runs it on every change under `supabase/`.

The Edge Function is not covered by these tests. Try it with `supabase start`
and `supabase functions serve songs` before the first real deploy.
