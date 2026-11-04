# Katarina & Trevor — event web app

A mobile-first site for one evening: Katarina and Trevor's **vow renewal**,
Saturday 21 November 2026, 5:00–11:00 PM PST, The Linden Club, 3636 Linden
Ave, Long Beach, CA 90807. Domain: **wedding.peitzman.net**.

Guests reach it from the QR on their printed boarding pass (and later NFC
placards), mostly in a dark room. The MVP:

1. **Event details**: static pages that keep working if everything else fails.
2. **Song requests**: guests request and upvote songs, and the DJ sees them ranked.
3. **Wallet passes**: one QR per guest; iPhones get an Apple Wallet pass,
   Android gets Save to Google Wallet.
4. **Disposable camera**: 12 photos per guest, uploaded to us, revealed later.

Source plan: the "Event Webapp Plan" Claude Doc (decisions, phases, roadmap).
Design source: the "Katarina & Trevor" design system (Claude artifact).

## Architecture (decided)

- **GitHub Pages** serves everything in `site/` (workflow: `.github/workflows/pages.yml`).
- **Supabase** is the only backend: Postgres functions hold every rule, an Edge
  Function talks to Spotify, Storage will hold photos and signed passes.
  Setup steps: `supabase/README.md`.
- No servers of our own. `wedding-song-requests/` (FastAPI) is the original
  prototype, kept as reference until the Supabase version is live, then deleted.

## Repo layout

```
site/                       static pages (no build step)
  index.html, schedule/, details/
  songs/                    guest song board; songs/dj/ is the DJ view
  assets/ds/                design system files, copied VERBATIM
  assets/site.css           page layout (tokens only); songs.css for the board
  assets/theme.js           sync <head>: Terrace/Finery, KT.now() rehearsal clock
  assets/site.js            theme toggle, schedule "now", ?pass= capture
  assets/config.js          public Supabase URL + anon key (blank = demo mode)
  assets/songs-client.js    data layer: live Supabase or in-browser demo
  assets/songs.js, dj.js    the two song pages
supabase/
  migrations/               schema + rules (the API is these functions)
  functions/songs/          Spotify search + submit, Edge Function (Deno)
  tests/run.sh              SQL tests on a throwaway local Postgres
wedding-song-requests/      original FastAPI prototype (reference only)
```

## Working on it

- Preview: `python3 -m http.server 8000 -d site` → http://localhost:8000.
  Links are root-absolute (`/schedule/`), so serve `site/` as the web root.
- With `assets/config.js` blank, the song board and DJ view run in **demo
  mode** (localStorage, demo catalog, any DJ key). Use it for UI work.
- Rehearse the night: `?now=2026-11-21T18:10` (Pacific) on any URL.
- DB rules: change `supabase/migrations/` (new file per change once the hosted
  project exists) and run `supabase/tests/run.sh`; add a test for each rule.
- Guest-facing DB errors: `app_private.fail(code, message, retry_after)`; the
  client shows `message` and switches on `code`.
- Pages must work without JavaScript except the song board and camera.
- `[hidden]` is forced to `display:none` in site.css because design-system
  components set `display:grid`. Keep that rule.
- The Details page has `hidden` cards marked `EDIT ME` (parking, RSVP/registry,
  FAQ, day-of contact) waiting for content.

## Identity

- The **pass token** (random, 16+ characters, never a name) is the guest's
  identity. It is in the QR on their paper pass and maps to their Zola guest ID
  in `public.passes`. Any page opened with `?pass=<token>` stores it on the
  phone (`site.js`) and strips it from the URL.
- Song board: anonymous per phone (a Supabase anonymous user) so guests can
  request from home; once a pass is claimed, their name ("Josephine M.") is
  attached to their requests.
- Camera: requires a claimed pass; the 12-shot limit counts per pass, not per
  phone.

## Design system rules (summary — the artifact's README is the authority)

- `assets/ds/` files are copied unchanged from the design system. Don't edit
  them; re-copy when the system changes. Layout goes in `site.css`/`songs.css`
  using only tokens (`var(--…)`).
- Themes: `data-theme="terrace"` (day, default) or `"finery"` (night). Finery
  when the device prefers dark or from 5:00 PM on the day; the toggle wins.
- Text is cobalt (`--text`); no grey body text. `--brand` is the only
  interactive color; one primary button per view.
- Adora Bouton (script) is display only: page titles, names, date lines. Never
  on anything a guest acts on, never a guest's name, never a word with a
  capital L ("Linden", "Long Beach"); avoid all-caps abbreviations like "DJ".
- Libre Baskerville for everything else; letterspaced caps for labels and
  buttons. The mono face is for the boarding pass only.
- Copy: first person plural, warm and plain, sentence-case headings. "5:45 PM",
  "5:00 – 11:00 PM". Exact room names: Terrace Room, Finery Bar & Lounge,
  Uptown Ballroom, Parlor. Never mention the Ebell Club. No emoji.
- Phone first at 375px, 44px tap targets, 640px max width, no horizontal scroll.
- Don't invent event facts; unknowns go on the open-questions list.

## Phased plan

The event is **21 November 2026**. Each phase ends with something usable.
The roadmap drawing is in the Event Webapp Plan doc.

### 1. Foundations ✅ (Nov 4)
Static Home, Schedule (timeline + room map), Details; day/night themes;
rehearsal clock; crest; this file.

### 2. Song requests on Supabase (Nov 4–10) — built, not yet deployed
- ✅ Rules ported to Postgres functions with SQL tests; Spotify Edge Function;
  guest board and DJ view rebuilt on the design system; demo mode.
- ✅ GitHub Pages and SQL-test workflows.
- ☐ Create the Supabase project and follow `supabase/README.md`.
- ☐ Fill `site/assets/config.js`; enable Pages; DNS for wedding.peitzman.net.
- ☐ Try the Edge Function locally (`supabase functions serve`) before deploy.
- ☐ DJ walkthrough (see wedding-song-requests/DESIGN.md "Things to ask him").

### 3. Details live (by Nov 10)
- Fill the `EDIT ME` cards on the Details page from Zola and un-hide them.
- Print a test QR code.

### 4. Wallet passes (Nov 5–14)
- **Nov 5: start the accounts, both have lead time.** Apple Developer Program
  ($99/year) for the Pass Type ID + signing certificate; Google Wallet issuer
  account, then request publishing access (new accounts are demo-only).
- Import guests from Zola into `public.passes` with a random token each.
- Generator (from the guest CSV): one signed `.pkpass` per guest (standard
  boarding-pass style, no iOS 26 live flight fields; PDF417 with the same BCBP
  string as the paper; back field links to the camera) and one Google Wallet
  boarding-pass object + save link per guest.
- Storage: `.pkpass` files in a private Supabase bucket; an Edge Function
  serves `GET /pass?t=<token>` with `Content-Type: application/vnd.apple.pkpass`.
- Landing page `site/p/` (the QR target, `?pass=<token>`): iPhone → straight to
  the .pkpass; Android → Save to Google Wallet button; other → both + the
  on-screen pass. It also claims the pass for the camera and song board.
- Paper pass: the stub's decorative PDF417 becomes a QR labelled ADD TO WALLET.
- **TBA first:** send passes ahead (Nov 14) with gate TBA, since seating is not
  final until after Nov 9. The paper QR at the door adds the final pass with
  the **same serial number**, which should replace the TBA one — verify on a
  real iPhone. Fallback: the PassKit update web service (an Edge Function +
  push) so passes refresh themselves when gates are set.

### 5. Camera (Nov 10–16)
- Requires a claimed pass. 12 shots per pass, enforced in the database with a
  reserved slot per photo so retries never cost a shot. Photos only, no video.
- Signed upload URLs straight to a private Storage bucket; server-side size and
  type checks; client-side resize before upload.
- Phone: in-page camera (HTTPS + permission), per-photo status (saved on this
  phone / uploading / uploaded), IndexedDB queue retried on reconnect and focus.
- Reveal: guests see everyone's photos 24 hours after the event, or earlier
  when we release them (an admin switch). Organizer-only export.

### 6. Rehearsal (Nov 17–20)
iPhone Safari + Android Chrome (camera denied, screen lock, refresh mid-upload,
bad wifi; Wallet add and TBA replacement); venue walk-through; light load test
(~100 guests); backups; one-page day-of runbook.

### 7. The night and after (Nov 21–22)
Watch uploads and the DJ view. Next day: export the setlist and every photo,
release the gallery, then downgrade Supabase.

### Later / if there's time
Table pages from NFC placards (`TableHeader`, `GuestList`); a "now playing"
line on the song board from the DJ's Played tap.

## Open questions

- Content for the Details `EDIT ME` cards (Zola wasn't reachable from the build
  session; `zola.com` would need to be on its network allowlist).
- How the TBA passes reach guests before the night: a Zola email, or our own?
- Which guest CSV export from Zola feeds the pass generator (columns, IDs)?
- Do Supabase and Apple/Google accounts already exist, and under whose name?
