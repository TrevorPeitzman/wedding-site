# Wedding Song Requests

> **Superseded.** This FastAPI prototype was ported to Supabase + static
> pages (`supabase/` and `site/songs/` at the repo root), which are live. It
> stays only as a reference for the rules, the Spotify app setup and the DJ
> questions in DESIGN.md; nothing here is deployed.

A guest-facing song request board. Guests search for a song, put it on the
list, and upvote each other's picks so the loudest wishes float to the top.
The DJ works off that list; at the end of the night it exports as a setlist.

Built to self-host: FastAPI + Postgres + Jinja templates, no frontend build
step, one `docker compose up`.

```
        guest phone  ──▶  /            board: search, request, upvote
                          /api/*       JSON the board polls every 7s
        DJ laptop    ──▶  /admin       queue, mark played, block list
        after        ──▶  /setlist     html / .txt / .csv / .uris
```

## Quick start

```bash
cp .env.example .env
make secret          # paste the output into SECRET_KEY in .env
make up              # http://localhost:8000
```

With no Spotify credentials the app searches a bundled demo catalog, so it is
fully clickable from the first boot. To see it with a populated board:

```bash
SEED_DEMO=1 docker compose up --build
```

Local (no Docker), against a Postgres you already have:

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
make init     # apply db/schema.sql
make seed     # create the event row (add `make demo` for fake activity)
make dev      # http://localhost:8000
```

## Spotify setup

Search uses the **Client Credentials** flow: the app authenticates as itself,
so guests never log in and there is no OAuth redirect to host.

1. Go to https://developer.spotify.com/dashboard and create an app. Any name.
2. It will ask for a redirect URI — Client Credentials doesn't use one, so
   put your site URL in and move on.
3. Copy the Client ID and Client Secret into `.env`.
4. Restart. The "Demo catalog" hint under the search box disappears when the
   live API is in use.

Rate limits are per-app and generous; a wedding's worth of searches is not
close to them. Set `SPOTIFY_MARKET` to your country so results match what the
DJ can actually play.

**The one thing this token cannot do is write a playlist to your account.**
Playlist creation needs a user-authorized grant, which means an OAuth
redirect, a stored refresh token, and a login as you. That is deliberate
scope for later — see DESIGN.md. Today `/setlist.uris` gives you the track
URIs to paste into a playlist in the Spotify desktop app.

## The DJ view

Set `ADMIN_TOKEN` in `.env`, then open `/admin?token=<that value>`. The token
is stored in a cookie so later visits are just `/admin`. Leaving `ADMIN_TOKEN`
blank disables the view entirely (it 404s).

From there: mark songs played, hide a request, add a block rule, open/close
requests and voting, and adjust the cooldowns live.

## How the rules work

- **One vote per song per guest**, enforced by a unique index — not by the UI.
- **One vote per cooldown window** (default 5 min) across all songs, so nobody
  can rapid-fire their way up the board.
- **Requesting a song already on the board becomes an upvote**, which is what
  the guest meant and keeps the list deduplicated.
- **A cap on songs per guest** (default 5), nudging people toward upvoting.
- **The block list** is checked at submit time *and* filters search results, so
  a blocked song never even appears as something to pick.

Identity is a signed cookie. It stops cookie editing and vote-stealing; it
does not stop someone who clears cookies or opens a private window. That is a
deliberate trade — see the "Anti-fraud" section of DESIGN.md for what
tightening it would cost you in friction.

## Deploying to the VPS

The compose file is the deployment. Behind a reverse proxy terminating TLS:

```bash
git pull
cp .env.example .env    # first time only; fill in the real values
docker compose up -d --build
```

Checklist before the day:

- [ ] `SECRET_KEY` set to a real random value and **never changed again** —
      changing it invalidates every guest's cookie and their vote history.
- [ ] `COOKIE_SECURE=1` (you are behind HTTPS).
- [ ] `ADMIN_TOKEN` set to something long; it is the only lock on the DJ view.
- [ ] `EVENT_NAME` / `EVENT_DATE` set, `SEED_DEMO` blank.
- [ ] A QR code to the site printed for the tables.
- [ ] Postgres volume is on disk you back up (`pgdata` in the compose file).

`uvicorn` runs with `--proxy-headers`, so put nginx or Caddy in front and
forward to `:8000`. A `/healthz` endpoint is there for uptime checks.

## Tests

```bash
make test    # 38 tests; DB-backed ones skip if no Postgres is reachable
make smoke   # end-to-end against the configured database
```

The suite covers the vote rules, cooldowns, block list, dedupe-to-upvote,
event scoping, the admin gate, and all four export formats.

## Layout

```
app/
  main.py        routes (public, admin, export)
  service.py     every DB read/write; guest-facing refusals as ActionError
  spotify.py     Client Credentials search, with an offline fixture catalog
  blocklist.py   rule matching
  guests.py      signed-cookie identity
  templates/     board, admin, setlist
  static/        one stylesheet, one script
db/schema.sql    all tables, idempotent
scripts/         init_db, seed, smoke
tests/
```
