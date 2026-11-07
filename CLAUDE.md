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
- No servers of our own. The original FastAPI prototype was deleted on Nov 4
  (it's in git history); what's still useful from it is in `docs/songs.md`.

## Repo layout

```
site/                       static pages (no build step)
  index.html, schedule/, details/
  songs/                    guest song board; songs/dj/ is the DJ view
  dj/                       shortcut: /dj/#key=… → /songs/dj/#key=…
  camera/                   disposable camera (pass required, no peeking)
  photos/                   the reveal: everyone's photos + the album, guests with a pass; select + save
  p/                        QR landing page (/p/?pass=<token>), never switched off
  admin/                    organizer screen: feature switches + times, camera, reveal, photos, album, rehearsal
  404.html                  GitHub Pages' not-found page
  assets/ds/                design system files, copied VERBATIM
  assets/site.css           page layout (tokens only); songs/camera/admin.css per area
  assets/theme.js           sync <head>: Terrace/Finery, KT.now() rehearsal clock
  assets/config.js          public Supabase URL + anon key (sync <head>, before features.js)
  assets/features.js        sync <head>: feature switches + timed release (server + fallback)
  assets/site.js            crest triple-tap (night colors), "My pass" link, schedule "now", ?pass= capture, Wi-Fi
  assets/songs-client.js    data layer (songs, DJ, camera, organizer): live Supabase or demo
  assets/songs.js, dj.js    the two song pages
  assets/camera.js          capture, resize, IndexedDB queue, retries
  assets/photos.js          the gallery
  assets/photo-tools.js     save photos: share sheet on phones (up to 10), else .jpg / .zip (built here); 2048px copies
  assets/admin.js           the organizer screen
  assets/wallet.js          /p/: on-screen boarding pass + device-aware Wallet button
supabase/
  config.toml               functions + the photos, wallet and album buckets (deployed by the integration)
  migrations/               schema + rules (the API is these functions)
  functions/songs/          Spotify search + submit (Deno)
  functions/camera/         reserve -> signed upload URL; gallery signed URLs; organizer photo list; album uploads
  functions/wallet/         GET ?t=<token> -> the guest's .pkpass (verify_jwt off)
scripts/import_passes.py    guest workbook -> tokens, passes.sql, passes.json, print merge + QR URLs
scripts/make_wallet_passes.py  passes.json + .p12 -> one signed .pkpass per guest (--upload)
scripts/requirements.txt    cryptography, Pillow, openpyxl
scripts/load_test.mjs       load test: N phones on the board (read-only), or --night (full guest mix on test passes)
tests/test_wallet_passes.py signs test passes with a throwaway certificate, verifies with openssl
tests/sql/run.sh            migrations + SQL tests on a throwaway local Postgres
docs/songs.md               song rules, Spotify app setup, DJ questions, decisions
docs/wallet.md              Apple Developer + Google Wallet account setup (Phase 4)
docs/runbook.md             rehearsal checklist, the day before, the night, after
private/                    GIT-IGNORED guest data (tokens, SQL, print CSV)
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
  Every `DELETE`/`UPDATE` in a public function needs a `WHERE` (Supabase's
  pg-safeupdate refuses bare ones in API calls; local Postgres doesn't, so a
  test checks the function bodies).
  To add a schedule check to an existing function, wrap it as the
  timed-release migration does (move the old one to `app_private`).
- Edge Functions: `npx -y deno@2.1.4 check supabase/functions/*/index.ts`.
- Wallet generator: `python3 tests/test_wallet_passes.py` (CI runs it too).
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
  strips it from the URL; the header then links back to `/p/` ("My pass").
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
- Themes: `data-theme="terrace"` (day) always, whatever the device prefers
  or the time (changed Nov 7; the design system's "Finery after dark" rule is
  set aside). `"finery"` (night) is hidden: three quick taps on the home
  page's crest switch to it and back, remembered on the phone. The header
  toggle stays in the markup, `hidden`; `site.js` no longer shows it.
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
Static Home, Schedule (timeline + room map), Details; day colors (night by
three taps on the crest);
rehearsal clock; crest; feature switches; QR landing page `/p/`; this file.
- ✅ Wi-Fi card, last on Home and on `/p/` (Linden Club Guest / 24Welcome in
  plain text; **Join Wi-Fi** copies the password, since a page can't join a
  network; a WIFI: QR for another phone to scan, folded away).
- ✅ **My pass** in the guest header once this phone has a pass: set when a
  `?pass=` link is opened (`kt-has-pass` in localStorage), confirmed or taken
  away whenever the server answers `has_pass` (`songs-client.js` →
  `KT.setHasPass`). With five items the nav tightens slightly on phones to stay
  on one line down to 320px.
- ✅ Nov 5: the timeline follows the final "Wedding Schedule" sheet (guest-facing
  items only: arrive 5:00, ceremony 5:30, cocktail hour 6:00, champagne tower
  7:00, grand entrance 7:15 … last call 10:15, good night and the party bus
  11:00; photobooth until 7:00 and 8:00 – 10:00; a faint sunset marker at
  4:47 PM). The party bus card links to its Partiful RSVP (a link out: its
  RSVP needs a sign-in, which an iframe can't do reliably). The 9:30 snack
  is a surprise: "? ? ? ? ?" and inflight refreshments, never named.
  **Show restrooms** on the map: men's in the strip between the Finery Bar and
  the Uptown Ballroom, women's (three stalls) by Coat Check, family
  (single) by the Terrace Bar; the map key lists them too. The map is
  the venue's floor plan, traced to SVG paths (theme colors, the current room
  lit by `site.js`).

### 2. Song requests on Supabase ✅ live (Nov 4)
- ✅ Rules in Postgres functions with SQL tests; Spotify Edge Function; guest
  board and DJ view on the design system; demo mode; Spotify links on titles.
- ✅ Supabase live through the GitHub integration; DJ key set; Spotify secrets
  set; anonymous sign-ins on, 300/hour; `config.js` filled (legacy anon JWT key
  on purpose; see the comment there).
- ✅ Pages live at wedding.peitzman.net (TLS provisioning on Nov 4).
- ☐ DJ walkthrough (questions in `docs/songs.md`).
- Easter egg: requesting "Hotel Room Service" by Pitbull opens a note
  (`#egg` in `songs/index.html`, `easterEgg()` in `songs.js`).

### 3. Details live (by Nov 10)
- Fill the `EDIT ME` cards on the Details page from Zola and un-hide them.
- Print a test QR code.

### 4. Wallet passes (Nov 5–16) — built, waiting on the accounts
- **Start the accounts, both have lead time:** step by step in `docs/wallet.md`.
  Apple Developer Program ($99/year) for the Pass Type ID + signing
  certificate; Google Wallet issuer account, then request publishing access
  (new accounts are demo-only).
- ✅ Guest import: `scripts/import_passes.py` reads the KT 1121 merge workbook
  (105 attending guests) → tokens, `passes.sql`, and the print merge CSV with a
  `qr_url` column for the print shop.
- ✅ Guests loaded: 105 passes, 14 tables, tokens matching the print merge
  sent from the build session (`private/print-merge-with-qr.csv`).
- Gates are **P01–P14** (one per table, as in the workbook), not the K/T +
  table number the design system first assumed; the design system is updated.
- Passes are **not sent ahead**: guests first get them with the paper pass at
  cocktail hour, so each pass is generated once, after seating is final (after
  Nov 9), with its real gate. No TBA version or replacement needed.
- ✅ Apple generator `scripts/make_wallet_passes.py`: one signed `.pkpass` per
  guest (boarding-pass style, no iOS 26 live flight fields; PDF417 with the
  same BCBP string as the paper; design-system colors; crest icon and logo;
  back field links to the guest's `/p/`). Checks the certificate matches the
  Pass Type ID and Team ID; `--only` for a one-pass test; `--upload`. Tested
  with a throwaway chain (signature verified by openssl), not yet with Apple's.
- ✅ Serving: private `wallet` bucket (`<zola_guest_id>.pkpass`); the `wallet`
  Edge Function serves `GET /functions/v1/wallet?t=<token>` as
  `application/vnd.apple.pkpass`, only while the `wallet` feature is open.
- ✅ Landing page `/p/`: the guest's boarding pass on screen (design-system
  BoardingPass), greeting by first name; iPhone → Add to Apple Wallet, Android
  → Save to Google Wallet, desktop → both, each only when ready; Wallet takes
  the primary button. `my_pass_card()` feeds it.
- ☐ Apple: certificate → test pass on your phone → everyone's, after Nov 9
  (`docs/wallet.md`, "Making the Apple passes").
- ☐ Google: verify the docs (`developers.google.com` blocked here), then a
  generator that fills `passes.google_save_url`.
- ☐ Official "Add to Apple Wallet" / "Add to Google Wallet" badge artwork.
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
- ✅ Organizer photo view (`/admin/` → Photos): every shot as it uploads with
  name, table and time, before the reveal too; filter by table, test photos
  on request; **Hide** keeps one out of the gallery (still a shot);
  download selected or all as .zip files of 100 (`admin_photos`,
  `admin_hide_photo`, the `camera` function's `admin_photos`).
- ✅ Guests save from `/photos/`: Select → Save (share sheet on a phone for
  up to 10, so they land in the camera roll), or Save all (.zip files).
- Organizer export: `/admin/` → Download all, or see supabase/README.md.
- ✅ Photo album (`/admin/` → Photo album): photos from other cameras, uploaded
  with an optional credit; the original (JPEG/PNG/WebP, 40 MB) plus a 2048px
  copy made in the browser go to the private `album` bucket. Guests see them
  on `/photos/` after the reveal under "More from the night"; Select / Save
  give them the originals. Hide or delete from `/admin/`.
- ✅ Shots by guest (`/admin/` → Camera): each pass's count; **Reset shots**
  for one guest or everyone gives the full count back and keeps their photos
  (`passes.shots_reset_at`; earlier shots stop counting).

### 6. Timed release ✅ built (Nov 4)
- ✅ `public.feature_schedule` (on/off, opens_at, closes_at per feature),
  enforced in the database for song requests, votes and new camera shots
  (`feature_soon` / `feature_closed`); a retry of a shot already taken still
  uploads.
- ✅ Pages read it at load through `features()` and cache it; `features.js`
  defaults are the offline fallback.
- ✅ Organizer screen `/admin/` with its own key: switches and Pacific times
  per feature, shots per pass, the reveal time and "Release photos now".
- ✅ Organizer key set.
- ☐ Choose the night's schedule in `/admin/` (likely: camera and
  Wallet at cocktail hour, songs open now and closed by the DJ, photos 24
  hours after).

### 7. Rehearsal (Nov 17–20) — tools built
- ✅ Test passes (`passes.is_test`), made from `/admin/` → Rehearsal: behave
  like real passes, but their shots can be reset and their photos never reach
  the gallery. Clean slate for the night: delete test passes (rows and photo
  files, via the `camera` function's organizer-only `purge`) and clear the
  song board (type CLEAR).
- ✅ `scripts/load_test.mjs`: ~105 read-only phones polling the board; `--night`
  runs the full guest mix (sign-in, pass, board, Spotify search, requests,
  votes, 600 KB photo uploads) on test passes, `--cleanup` after. Delete test
  passes also removes their song requests and votes.
- ✅ `docs/runbook.md`: phone checklist (iPhone Safari + Android Chrome, dim
  room, airplane mode, page closed mid-upload, screen lock, Wallet), load
  test, venue walk-through, the day before, the night's "if… then…", after.
- ☐ Run it: the checklist on real phones, the load test once, the venue.

### 8. The night and after (Nov 21–22)
Follow `docs/runbook.md`: watch uploads (`/admin/`) and the DJ view. Next
day: export the setlist and every photo, release the gallery, then downgrade
Supabase.

### Later / if there's time
Table pages from NFC placards (`TableHeader`, `GuestList`; the workbook's NFC
URL column is ready for them); a "now playing" line from the DJ's Played tap.

## Open questions

- Content for the Details `EDIT ME` cards (Zola wasn't reachable from the build
  session; `zola.com` would need to be on its network allowlist).
- 5 workbook rows carry a QC note ("family-name-first guess"): confirm their
  FIRST/LAST and STRIP NAME before printing.
- Do the Apple and Google accounts exist yet, and under whose name?
- Google Wallet: does a boarding pass accept a made-up carrier ("KT 1121"), or
  does it need a Generic pass styled as one? (`docs/wallet.md`)
- Destinations in script on the pass: Adora Bouton's capital S ("Santorini")
  reads a little like an F. Keep, or set the destination in Baskerville?
