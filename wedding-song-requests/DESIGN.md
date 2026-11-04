# Design & roadmap

Feature order below follows the original priority list. Everything in
**Shipped** works today; everything under it is scoped but not built.

## Shipped — request + voting

The core loop. Search Spotify, put a song up, upvote what you like, highest
score floats to the top. Details in README under "How the rules work".

Decisions worth remembering:

- **Votes are rows, not a counter.** `votes` has a unique index on
  `(request_id, guest_token)`, so "one vote per song" is a database guarantee
  rather than a UI convention, and two fast taps can't double-count.
- **Duplicate request → upvote.** Guests don't scroll the board before
  searching. Refusing a duplicate would read as a bug; converting it to a vote
  is what they wanted.
- **The score is counted on read.** A few hundred guests is nowhere near
  needing a denormalized counter, and a counter can drift from its rows.
- **Optimistic vote UI.** The tap updates the number immediately and reconciles
  on the next poll. Venue wifi is bad; the button should never feel dead.
- **7-second polling, not websockets.** A long-lived socket per guest through a
  reverse proxy is a deployment risk for a night that happens once. Polling is
  boring and survives a dropped connection.

## Shipped — setlist export

`/setlist` plus `.txt`, `.csv` and `.uris`. Today this is the *request* list:
songs the DJ marked played (in order), then everything else by score.

**Open question for Zach — what does he mix on?** Capturing what actually got
played is the difference between "what the room asked for" and a real setlist.
Three ways in, and the answer changes which one is worth building:

| If Zach uses | Path | Effort |
|---|---|---|
| rekordbox / Serato / Traktor | Post-event history export (a text/CSV file), imported and fuzzy-matched to `tracks` | Low — an import script |
| Something without export | He taps "Played" in the DJ view as he goes | Already built, but relies on him remembering |
| Nothing, or you want it automatic | Mic'd device running audio fingerprinting (ACRCloud / AudD) in the room | High — hardware + a paid API + noise |

The schema is already ready for whichever answer: `played_tracks` exists with
a `source` column (`dj_marked` / `dj_export` / `listener`) and is unused by the
MVP. When capture lands, it writes there and `service.setlist()` reads from it
instead of the request list. Nothing else changes.

Things to ask him:
1. What software, and can he export a history file after the night?
2. Does he want the request list live on his laptop, or will he glance at a
   phone?
3. Does he want requests to stop at a certain point in the night?

**Spotify playlist creation** is the other half. The app's Client Credentials
token is app-only and cannot write to your account. Making the setlist appear
as a real Spotify playlist needs a user-authorized OAuth grant: an
`/auth/spotify` redirect, `playlist-modify-private` scope, and a stored
refresh token — perhaps 80 lines. Worth it only if pasting URIs into the
desktop app the next morning feels like too much.

## Shipped — auto-block list

Rules match on exact Spotify id, artist substring, title substring, or a
keyword across both, plus a global explicit-content switch (`BLOCK_EXPLICIT`).
Blocked songs are filtered out of *search results*, not just refused at
submit — a guest never picks something only to be told no.

`scripts/seed.py` installs two clearly-labelled example rules. Delete them in
the DJ view and add your own.

Not built, if you want it later: regex rules, a tempo/energy floor via
Spotify's audio-features endpoint (auto-block anything under 90 BPM after 9pm),
or importing a do-not-play list from a file.

## Shipped — DJ view

You were undecided between "a view for Zach" and public-only. It's built,
gated by `ADMIN_TOKEN`, and costs nothing if unused — leave the token blank
and it 404s.

It's deliberately plain HTML forms, no JS: it has to work on whatever laptop
or phone is at the booth, on venue wifi, at 11pm.

If Zach wants it, the obvious next step is auto-refresh on the queue and a
bigger-text "next up" mode.

## Not built — paid queue bumping

Scoped, not recommended without thinking about the room.

The mechanics are easy: Stripe Checkout, a webhook, a `bump_weight` on the
request that the leaderboard sorts by. Half a day.

The reasons to hesitate are social, not technical:

- Guests paying money at your wedding changes the feel of the night, and the
  ones who'd pay most are not necessarily the ones you want steering the music.
- Refunds when a paid song doesn't get played (Zach's call, always) are an
  awkward conversation the next day.
- It puts you in the position of processing payments at your own reception,
  with the tax and chargeback tail that follows.

A version that keeps the fun and drops the problems: **a charity tally**.
Bumps cost a pledge to a charity you pick, tracked in the app, and you write
one cheque after. Same game mechanics, no payment rails, no refunds.

If you do want real money: Stripe Checkout in payment-link mode is the least
code, and the bump should *decay* (a paid song loses its boost over ~30 min)
so one big spender can't own the whole night.

## Not built — now playing via in-room listening

You called this not necessary, and it's the most expensive item here: a
machine in the room with a mic, a continuous fingerprinting subscription
(ACRCloud or AudD), and a tolerance for a loud room with people singing over
the PA. Recognition rates on a dance floor are meaningfully worse than the
phone-in-a-cafe case those APIs are tuned for.

If it does happen, it's the same `played_tracks` insert as the DJ-export path,
with `source='listener'` — so it doubles as the setlist capture, which is the
only argument for building it.

A much cheaper "now playing": Zach's "Played" tap in the DJ view already marks
the moment. Showing the most recent one on the guest board is about 10 lines.

## Anti-fraud: why the cookie is enough

You chose signed-cookie-only, and for this room it is the right call. What it
stops and what it doesn't:

- **Stops**: editing a cookie to impersonate another guest, forging tokens,
  double-voting from one browser, rapid-fire voting (the cooldown).
- **Doesn't stop**: clearing cookies, a private window, or a second device.

The realistic abuse case is one determined cousin voting four times, which
moves a song by four. The cures are all worse than the disease at a wedding:
IP limits break on venue wifi (everyone shares one NAT'd address), and per-
invite codes put a login between a tipsy guest and their song. If it ever
matters, the cheapest real tightening is a per-IP *request* cap (not a vote
cap) — spam of new songs is the failure mode that actually degrades the board.

## Things worth deciding before the day

1. **Cooldown numbers.** Defaults are 5 min between votes, 10 min between
   requests, 5 songs per guest. Tune in the DJ view once you see the pace.
2. **When requests close.** Leaving them open all night means last-call
   requests nobody votes on. Closing at, say, 10pm makes the board settle.
3. **Explicit tracks.** `BLOCK_EXPLICIT=1` if grandma's table is a concern.
4. **The QR code.** Print it for the tables — it is the entire discovery
   mechanism for this thing.
