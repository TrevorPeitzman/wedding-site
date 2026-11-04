# Katarina & Trevor — event web app

A mobile-first site for one evening: Katarina and Trevor's wedding. Domain: **wedding.peitzman.net**.

Guests reach it from the QR on their printed boarding pass, which they first
receive **during cocktail hour** (and later NFC placards), mostly in a dark
room. The MVP:

1. **Event details**: static pages that keep working if everything else fails.
2. **Song requests**: guests request and upvote songs, and the DJ sees them ranked.
3. **Wallet passes**: one QR per guest; iPhones get an Apple Wallet pass,
   Android gets Save to Google Wallet.
4. **Disposable camera**: 12 photos per guest, uploaded to us, revealed later.

Every feature can be switched off or given opening and closing times from the
organizer screen (`/admin/`); the database enforces the times.

Source plan: the "Event Webapp Plan" Claude Doc (decisions, phases, roadmap).
Design source: the "Katarina & Trevor" design system (Claude artifact).
Deploying: `DEPLOY.md`. Backend: `supabase/README.md`.

## Architecture (decided, live)

- **GitHub Pages** serves everything in `site/` (`.github/workflows/pages.yml`)
  at wedding.peitzman.net.
- **Supabase** (project `pzmeppjcvsjkneducqvd`) is the only backend: Postgres
  functions hold every rule, Edge Functions talk to Spotify and sign camera
  uploads (later: serve Wallet passes), Storage holds the photos. Migrations,
  the Edge Functions and the `photos` bucket deploy through Supabase's GitHub
  integration on every push to `main` (working directory `.`).
  `.github/workflows/functions.yml` is a fallback for functions.
- No servers of our own. `wedding-song-requests/` (FastAPI) is the original
  prototype, superseded now that the Supabase version is live; delete it once
  nobody needs it as a reference.

## Repo layout

```
site/                       static pages (no build step)
  index.html, schedule/, details/
  songs/                    guest song board; songs/dj/ is the DJ view
  camera/                   disposable camera (pass required, no peeking)
  photos/                   the reveal: everyone's photos, guests with a pass
  p/                        QR landing page (/p/?pass=<token>), never switched off
  admin/                    organizer screen: feature switches + times, camera, reveal
  assets/ds/                design system files, copied VERBATIM
  assets/site.css           page layout (tokens only); songs/camera/admin.css per area
  assets/theme.js           sync <head>: Terrace/Finery, KT.now() rehearsal clock
  assets/config.js          public Supabase URL + anon key (sync <head>, before features.js)
  assets/features.js        sync <head>: feature switches + timed release (server + fallback)
  assets/site.js            theme toggle, schedule "now", ?pass= capture
  assets/songs-client.js    data layer (songs, DJ, camera, organizer): live Supabase or demo
  assets/songs.js, dj.js    the two song pages
  assets/camera.js          capture, resize, IndexedDB queue, retries
  assets/photos.js          the gallery
  assets/admin.js           the organizer screen
supabase/
  config.toml               functions + the photos bucket (deployed by the integration)
  migrations/               schema + rules (the API is these functions)
  functions/songs/          Spotify search + submit (Deno)
  functions/camera/         reserve -> signed upload URL; gallery signed URLs
scripts/import_passes.py    guest workbook -> tokens, passes.sql, print merge + QR URLs
tests/sql/run.sh            migrations + SQL tests on a throwaway local Postgres
private/                    GIT-IGNORED guest data (tokens, SQL, print CSV)
wedding-song-requests/      original FastAPI prototype (superseded)
```

## Working on it

- Preview: `python3 -m http.server 8000 -d site` → http://localhost:8000.
  Links are root-absolute (`/schedule/`), so serve `site/` as the web root.
- `assets/config.js` points at the live project. Add `?demo=1` to a page URL
  for **demo mode** in that tab (localStorage, demo catalog, any DJ or
  organizer key; `?demo=0` to leave it). In demo mode the organizer screen
  drives the demo pages. Use it for UI work and rehearsals.
- Rehearse the night: `?now=2026-11-21T18:10` (Pacific) on any URL; it also
  drives timed release on the page (the database uses the real clock).
- **Feature switches and timed release** (`features.js`): the live schedule is
  `public.feature_schedule`, set from `/admin/`, read by every page through
  `features()` and cached on the phone; the `DEFAULTS` in `features.js` are the
  fallback when Supabase is unreachable. In HTML: `data-feature="<name>"` on
  nav items, cards and mentions (hidden when off or closed), `data-requires` on
  the tool, `data-until` on its "opens at" notice, `<html data-page-feature>`
  on its page (sent home when off). A new feature needs a row in the
  migration's check list, a line in `features.js` and one in each rule group at
  the top of `site.css`. `/p/`, `/photos/` and `/admin/` belong to no feature.
- DB rules: a new file in `supabase/migrations/` per change (never edit one
  that has been applied); run `tests/sql/run.sh`; add a test for each rule.
  To add a schedule check to an existing function, wrap it as the
  timed-release migration does (move the old one to `app_private`).
- Edge Functions: `npx -y deno@2.1.4 check supabase/functions/*/index.ts`.
- Guest-facing DB errors: `app_private.fail(code, message, retry_after)`; the
  client shows `message` and switches on `code`.
- Pages must work without JavaScript except the song board, camera and admin.
- `[hidden]` is forced to `display:none` in site.css because design-system
  components set `display:grid`. Keep that rule.
- The Details page has `hidden` cards marked `EDIT ME` (parking, RSVP/registry,
  FAQ, day-of contact) waiting for content.
- **Guest data never goes in git**: the workbook, tokens and generated SQL/CSV
  stay in `private/` (ignored) or outside the repo.
- **Supabase tooling:** `.mcp.json` registers Supabase's MCP server for project
  `pzmeppjcvsjkneducqvd` (each person signs in once with `claude /mcp` in a local
  terminal). `.claude/skills/` holds Supabase's agent skills (`supabase`,
  `supabase-postgres-best-practices`), pinned in `skills-lock.json`; update with
  `npx skills update -p`. The public-schema `SECURITY DEFINER` functions are
  deliberate: each revokes PUBLIC and grants back only its intended role, so
  Supabase's advisor flagging them is expected. GitGuardian flags the anon key
  in `config.js`; it is public by design (mark it a false positive).

## Identity and keys

- The **pass token** (16 random URL-safe characters, never a name) is the
  guest's identity. `scripts/import_passes.py` issues one per Zola guest ID and
  never changes it once issued (`private/pass-tokens.csv` is the source of
  truth: back it up). The paper pass's QR is `https://wedding.peitzman.net/p/?pass=<token>`.
- Any page opened with `?pass=<token>` stores it on the phone (`site.js`) and
  strips it from the URL.
- Song board: anonymous per phone (a Supabase anonymous user) so guests can
  request from home; once a pass is claimed, their name ("Josephine M.") is
  attached to their requests. Titles of Spotify tracks link to
  `open.spotify.com/track/<id>` (opens the app if installed).
- Camera: requires a claimed pass; the 12-shot limit counts per pass, not per
  phone.
- **DJ key** (`app_private.set_admin_key`): the DJ view. **Organizer key**
  (`app_private.set_organizer_key`): the admin screen, camera settings and the
  reveal, and everything the DJ key can do. Only SHA-256 hashes are stored.

## Design system rules (summary — the artifact's README is the authority)

- `assets/ds/` files are copied unchanged from the design system. Don't edit
  them; re-copy when the system changes. Layout goes in the per-area CSS files
  using only tokens (`var(--…)`).
- Themes: `data-theme="terrace"` (day, default) or `"finery"` (night). Finery
  when the device prefers dark or from 5:00 PM on the day; the toggle wins.
- Text is cobalt (`--text`); no grey body text. `--brand` is the only
  interactive color; one primary button per view.
- Adora Bouton (script) is display only: page titles, names, date lines. Never
  on anything a guest acts on, never a guest's name, never a word with a
  capital L ("Linden", "Long Beach"); avoid all-caps abbreviations like "DJ";
  check every new title rendered, since some letters mislead ("Disposable"
  reads as "Disposafle").
- Libre Baskerville for everything else; letterspaced caps for labels and
  buttons. The mono face is for the boarding pass only.
- Copy: first person plural, warm and plain, sentence-case headings. "5:45 PM",
  "5:00 – 11:00 PM". Exact room names: Terrace Room, Finery Bar & Lounge,
  Uptown Ballroom, Parlor. Never mention the Ebell Club. No emoji.
- Phone first at 375px, 44px tap targets, 640px max width, no horizontal scroll.
- Don't invent event facts; unknowns go on the open-questions list.

## Phased plan

The event is on a fast-approaching date. Each phase ends with something usable.
The roadmap drawing is in the Event Webapp Plan doc.

### 1. Foundations ✅ (Nov 4)
Static Home, Schedule (timeline + room map), Details; day/night themes;
rehearsal clock; crest; feature switches; QR landing page `/p/`; this file.

### 2. Song requests on Supabase ✅ live (Nov 4)
- ✅ Rules in Postgres functions with SQL tests; Spotify Edge Function; guest
  board and DJ view on the design system; demo mode; Spotify links on titles.
- ✅ Supabase live through the GitHub integration; DJ key set; Spotify secrets
  set; anonymous sign-ins on, 300/hour; `config.js` filled (legacy anon JWT key
  on purpose; see the comment there).
- ✅ Pages live at wedding.peitzman.net (TLS provisioning on Nov 4).
- ☐ DJ walkthrough (see wedding-song-requests/DESIGN.md "Things to ask him").

### 3. Details live (by Nov 10)
- Fill the `EDIT ME` cards on the Details page from Zola and un-hide them.
- Print a test QR code.

### 4. Wallet passes (Nov 5–16)
- **Start the accounts, both have lead time.** Apple Developer Program
  ($99/year) for the Pass Type ID + signing certificate; Google Wallet issuer
  account, then request publishing access (new accounts are demo-only).
- ✅ Guest import: `scripts/import_passes.py` reads the KT 1121 merge workbook
  (105 attending guests) → tokens, `passes.sql`, and the print merge CSV with a
  `qr_url` column for the print shop.
- ☐ Load the guests: paste the **contents** of `private/passes.sql` into the
  SQL editor (not its file name).
- Passes are **not sent ahead**: guests first get them with the paper pass at
  cocktail hour, so each pass is generated once, after seating is final (after
  Nov 9), with its real gate. No TBA version or replacement needed.
- Generator: one signed `.pkpass` per guest (standard boarding-pass style, no
  iOS 26 live flight fields; PDF417 with the same BCBP string as the paper;
  back field links to the camera) and one Google Wallet boarding-pass object +
  save link per guest.
- Storage: `.pkpass` files in a private Supabase bucket; an Edge Function
  serves `GET /pass?t=<token>` with `Content-Type: application/vnd.apple.pkpass`.
- Landing page `site/p/`: iPhone → straight to the .pkpass; Android → Save to
  Google Wallet button; other → both + the on-screen pass. It also claims the
  pass for the camera and song board. The `wallet` feature switch gates it.
- Paper pass: the stub's decorative PDF417 becomes a QR labelled ADD TO WALLET.

### 5. Camera ✅ live (Nov 4)
- ✅ Pass required; 12 shots per pass (shared by every phone on that pass),
  enforced in the database with a reserved slot per photo (`reserve_shot`,
  keyed by a client id, so retries never cost a shot). Photos only.
- ✅ **No peeking**: the page shows the count and each shot's status, never the
  image. Capture is the phone's own camera app (`<input capture>`): better in
  a dark room than an in-page viewfinder, and no permission prompt.
- ✅ Resize to 2048px + re-encode on the phone (drops location data); signed
  upload URL from the `camera` function straight to the private `photos`
  bucket (JPEG only, 8 MB, set in config.toml); `confirm_shot` checks the file
  is really in storage.
- ✅ IndexedDB queue: saved on this phone → uploading → uploaded; retried on
  reconnect, on returning to the page and every 20s; warns before leaving.
- ✅ Reveal at `events.photos_reveal_at` (default 11:00 PM Nov 22, 24 hours
  after the end), set or released from `/admin/`; `/photos/` shows everyone's
  photos to guests with a pass.
- ☐ Real-phone test (iPhone + Android, dark room, bad signal).
- Organizer export: see supabase/README.md.

### 6. Timed release ✅ built (Nov 4)
- ✅ `public.feature_schedule` (on/off, opens_at, closes_at per feature),
  enforced in the database for song requests, votes and new camera shots
  (`feature_soon` / `feature_closed`); a retry of a shot already taken still
  uploads.
- ✅ Pages read it at load through `features()` and cache it; `features.js`
  defaults are the offline fallback.
- ✅ Organizer screen `/admin/` with its own key: switches and Pacific times
  per feature, shots per pass, the reveal time and "Release photos now".
- ☐ Set the organizer key and choose the night's schedule (likely: camera and
  Wallet at cocktail hour, songs open now and closed by the DJ, photos 24
  hours after).

### 7. Rehearsal (Nov 17–20)
iPhone Safari + Android Chrome (camera denied, screen lock, refresh mid-upload,
bad wifi; Wallet add on both); every timed release with `?now=`; venue
walk-through; light load test (~105 guests); backups; one-page day-of runbook.

### 8. The night and after (Nov 21–22)
Watch uploads (`/admin/`) and the DJ view. Next day: export the setlist and
every photo, release the gallery, then downgrade Supabase.

### Later / if there's time
Table pages from NFC placards (`TableHeader`, `GuestList`; the workbook's NFC
URL column is ready for them); a "now playing" line from the DJ's Played tap.

## Open questions

- Content for the Details `EDIT ME` cards (Zola wasn't reachable from the build
  session; `zola.com` would need to be on its network allowlist).
- Gates: the workbook uses P01–P14, while the design system and the workbook's
  own note say K or T + table number (K9). Which is printed?
- 5 workbook rows carry a QC note ("family-name-first guess"): confirm their
  FIRST/LAST and STRIP NAME before printing.
- Which token set is final: the one the import script made locally, or the
  one sent from the build session? Only one may be printed and loaded.
- Do the Apple and Google accounts exist yet, and under whose name?
