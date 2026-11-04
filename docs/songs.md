# Song requests: setup, DJ questions, decisions

What's still useful from the original FastAPI prototype (deleted on Nov 4,
2026; it lives on in git history), updated for the Supabase version.

## How the rules work

All enforced in the database (`supabase/migrations/`), not the page:

- **One vote per song per phone**, by a unique index.
- **One vote per cooldown window** (default 5 minutes) across all songs, so
  nobody rapid-fires a song up the board.
- **Requesting a song already on the board becomes an upvote**, which is what
  the guest meant and keeps the list free of duplicates.
- **A cap on songs per guest** (default 5), nudging people toward upvoting, and
  a cooldown between requests (default 10 minutes).
- **The do-not-play list** is checked at submit time *and* filters search
  results, so a blocked song never even appears as something to pick.
- **The schedule** (`/admin/`): requests and votes are refused outside the
  `songs` feature's window.

Identity is a Supabase anonymous user per phone. It stops vote-stealing; it
does not stop someone who clears their browser or uses a second phone. The
realistic abuse case is one determined cousin voting four times. Tighter
options (per-IP caps, required pass) all add friction for real guests on
shared venue wifi, so they're deliberately not used.

## Spotify app setup

Search uses the **Client Credentials** flow: the `songs` Edge Function
authenticates as itself, so guests never log in.

1. At https://developer.spotify.com/dashboard, create an app (any name). It
   asks for a redirect URI; Client Credentials doesn't use one, so enter the
   site URL.
2. Copy its Client ID and Client Secret into Supabase:
   `supabase secrets set SPOTIFY_CLIENT_ID=... SPOTIFY_CLIENT_SECRET=... SPOTIFY_MARKET=US`.
   `SPOTIFY_MARKET` keeps results to what the DJ can actually play.
3. Without the secrets, search falls back to a 22-song demo catalog: if search
   only ever finds classics, the secrets aren't set.

This token can't write a playlist to your account. The DJ view's **Spotify
URIs** export gives one track URI per line, to paste into a playlist in the
Spotify desktop app. Creating the playlist automatically would need a
user-authorized OAuth grant (`playlist-modify-private`) and a stored refresh
token: worth it only if pasting feels like too much the next morning.

## Questions for the DJ

What actually got played is the difference between "what the room asked for"
and a real setlist. The answer to the first question decides how to capture it:

| If the DJ uses | Path | Effort |
| --- | --- | --- |
| rekordbox / Serato / Traktor | Their history export after the night, imported and matched to `tracks` | Low: an import script |
| Something without an export | Taps "Played" in the DJ view as he goes | Built, but relies on remembering |
| Nothing, or it should be automatic | A mic'd device with audio fingerprinting (ACRCloud, AudD) | High: hardware, a paid API, a loud room |

`public.played_tracks` (with a `source` column: `dj_marked`, `dj_export`,
`listener`) is ready for whichever answer and unused today.

1. What software, and can he export a history file after the night?
2. Does he want the request list live on his laptop, or will he glance at a phone?
3. Does he want requests to stop at a certain point in the night?

## Decide before the day

1. **Cooldowns.** Defaults: 5 minutes between votes, 10 between requests,
   5 songs per guest. Tune them in the DJ view once you see the pace.
2. **When requests close.** Open all night means last-call requests nobody
   votes on; closing around 10 PM lets the board settle. Set a closing time
   for `songs` in `/admin/`, or let the DJ flip it in the DJ view.
3. **Explicit tracks.** The DJ view's "Block explicit songs" switch.
4. **The do-not-play list.** Delete the two example rules; add the real ones.

## Ideas not built

- **Paid queue bumping.** Easy mechanically, awkward socially (guests paying
  at your wedding, refunds when a song doesn't get played). A gentler version:
  pledges to a charity, tallied in the app, one cheque after.
- **Now playing.** The DJ's "Played" tap already records the moment; showing
  the latest one on the guest board is a small change.
- **Auto-block by tempo or time of night,** or importing a do-not-play list
  from a file.
