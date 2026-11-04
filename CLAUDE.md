# Katarina & Trevor — event web app

A mobile-first site for one evening: Katarina and Trevor's **vow renewal**,
Saturday 21 November 2026, 5:00–11:00 PM PST, The Linden Club, 3636 Linden
Ave, Long Beach, CA 90807. Planned domain: `wedding.peitzman.net`.

Guests open it from a QR code (later NFC placards) on their phones, mostly in
a dark room. The MVP has three features:

1. **Event details**: static pages that keep working if everything else fails.
2. **Song requests**: guests request and upvote songs, and the DJ sees them ranked.
3. **Disposable camera**: guests take a limited number of photos that upload to us.

Source plan: the "Event Webapp Plan" Claude Doc. Design source: the
"Katarina & Trevor" design system (Claude artifact).

## Repo layout

```
site/                     static guest pages (no build step)
  index.html              home
  schedule/index.html     timeline + room map (marks "now" on the night)
  details/index.html      venue, time, dress code
  assets/ds/              design system files, copied VERBATIM (see below)
  assets/site.css         page layout only; no new colors
  assets/theme.js         sync <head> script: picks Terrace/Finery, KT.now()
  assets/site.js          progressive enhancement (theme toggle, schedule status)
  assets/img/             crest (cobalt for day, ivory for night), WebP
wedding-song-requests/    FastAPI + Postgres song board, DJ view, setlist export
                          (see its README.md and DESIGN.md)
```

## Working on the static site

- Preview: `python3 -m http.server 8000 -d site` → http://localhost:8000.
  Links are root-absolute (`/schedule/`), so serve `site/` as the web root.
- Rehearse the night: add `?now=2026-11-21T18:10` (Pacific) to any URL. The
  schedule marks past and current items and lights the current room; the theme
  switches to Finery from 5:00 PM.
- Every page duplicates the same `<head>`, header and footer. With three pages
  that is cheaper than a build step; if the page count grows past ~6, add a
  tiny generator rather than hand-editing each copy.
- Pages must render fully without JavaScript. JS only adds the theme toggle and
  the live schedule status.
- `/songs/` is the link to the song app. Where it is served from is an open
  question (see Phase 2).

## Design system rules (summary — the artifact's README is the authority)

- `assets/ds/tokens.css`, `components.css` and `fonts/` are copied unchanged
  from the design system. Don't edit them; re-copy when the system changes.
  Layout goes in `site.css`, using only tokens (`var(--…)`).
- Themes: `data-theme="terrace"` (day, default) or `"finery"` (night). Finery
  when the device prefers dark or from 5:00 PM on the day; the guest's toggle
  choice wins.
- Text is cobalt (`--text`); no grey body text. `--brand` is the only
  interactive color, and each view gets one primary button.
- Adora Bouton (script) is display only: page titles, the couple's names, date
  lines. Never on anything a guest acts on, never a guest's name, and **never a
  word with a capital L** ("Linden", "Long Beach"), because its L reads as a J.
- Libre Baskerville for everything else; letterspaced caps for labels and
  buttons. The mono face is for the boarding pass only.
- Copy: first person plural, warm and plain, sentence-case headings. Times are
  "5:45 PM"; ranges are "5:00 – 11:00 PM". Room names are exact: Terrace Room,
  Finery Bar & Lounge, Uptown Ballroom, Parlor. Never mention the Ebell Club.
  No emoji.
- Phone first at 375px, 44px tap targets, 640px max reading width, no
  horizontal scroll. Focus ring is 2px `--focus` with a 2px offset.
- Don't invent event facts. Anything not confirmed by the couple goes on the
  open-questions list below, not on a page.

## Phased plan

Today is early November 2026 and the event is **21 November 2026**. The phases
are ordered so that something useful can ship at the end of each one.

### Phase 0 — Foundations ✅
- Static site skeleton on the design system: Home, Schedule (timeline + room
  map), Details.
- Day/night themes, rehearsal clock (`?now=`), crest assets.
- This file.

### Phase 1 — Event details live (target: ~Nov 8)
- Fill content gaps from the open questions (parking, RSVP/registry/Zola links,
  anything else guests ask).
- Pick hosting and deploy `site/` behind HTTPS on `wedding.peitzman.net`.
- Generate the event QR code (and a test print).
- Check on iPhone Safari and Android Chrome in both themes.

### Phase 2 — Song requests on the same domain (target: ~Nov 12)
- Mount the song app at `/songs/` behind the same reverse proxy (FastAPI
  `root_path`, so its absolute `/static` and `/api` links still resolve), or on
  a subdomain.
- Reskin `wedding-song-requests/app/static/app.css` and templates with the
  design system (tokens.css + components.css, Finery at night) so guests don't
  notice a change between pages.
- Production config: `SECRET_KEY`, `ADMIN_TOKEN`, `COOKIE_SECURE=1`,
  `EVENT_NAME`, `EVENT_DATE`, Spotify credentials, block list.
- DJ walkthrough (see DESIGN.md "Things to ask him"); decide when requests
  close.

### Phase 3 — Disposable camera (target: ~Nov 17)
- Reuse the song app's backend: the same FastAPI service, Postgres and
  signed-cookie guest identity. Add a display-name step.
- Server-enforced shot limit, with a reserved slot per photo so retries don't
  use up a shot.
- Short-lived upload URLs that send photos straight to private object storage
  (R2 or S3-compatible), never through the app server. Server-side size and
  type checks.
- Phone side: in-page camera (HTTPS and permission), per-photo status (saved
  on this phone / uploading / uploaded), an IndexedDB queue that retries on
  reconnect and when the page comes back to the foreground.
- Organizer-only export, and an optional gallery after a reveal time.

### Phase 4 — Rehearsal and hardening (Nov 18–20)
- Device matrix: denied camera permission, screen lock, refresh mid-upload,
  bad wifi.
- A walkthrough at the venue: QR to camera, cell and wifi coverage in each room.
- Light load test (about 100 guests polling plus uploads).
- Backups: the Postgres volume, plus a storage bucket lifecycle and export plan.
- A one-page day-of runbook: URLs, admin link, how to pause requests, who to call.

### Phase 5 — The night and after
- Monitor `/healthz`, the DJ view and upload counts.
- Next day: export the setlist (`/setlist.*`) and download every photo to a
  separate copy, then decide when to turn things off.

### Later / if there's time
- Boarding pass per guest (the design system has `BoardingPass`; it needs
  seating data, gates and per-guest links).
- Table pages opened from NFC placards (`TableHeader`, `GuestList`); needs the
  14 table destinations and the guest list.
- A "now playing" line on the song board, driven by the DJ's Played tap.

## Open questions

Tracked here until answered; answers become content or config.

- Hosting: is the existing Option B backend on **Railway** (as the plan doc
  says) or the self-hosted **VPS + docker compose** (as the song app README
  says)? Is `wedding.peitzman.net` the final domain?
- `/songs/` path on the same domain, or a subdomain?
- Content for Details: parking/valet, a Zola link (RSVP, registry), kids,
  accessibility, a contact for day-of questions?
- Camera: shots per guest, strict per-person limits (individual links) or QR +
  display name, reveal time, photos only or video too?
- Does the camera need anything visible before the night (a preview or test
  mode), or does it stay "coming soon" until 5:00 PM?
