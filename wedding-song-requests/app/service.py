"""Every database read and write the app makes.

Routes stay thin: they handle HTTP, call one function here, and render. Guest
rule violations (cooldowns, caps, closed voting, blocked songs) are raised as
ActionError so the route can turn them into one consistent JSON shape.
"""
from datetime import datetime, timezone

from psycopg2 import errors

from app import config
from app.db import get_cursor

TRACK_COLUMNS = """
    t.spotify_id, t.title, t.artist, t.album, t.artwork_url,
    t.duration_ms, t.explicit
"""


class ActionError(Exception):
    """A guest-visible refusal. `code` is stable for the UI, `message` is prose."""

    def __init__(self, code: str, message: str, retry_after: int | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retry_after = retry_after


# --- Event ---------------------------------------------------------------

def ensure_event() -> dict:
    """Fetch the configured event, creating it on first boot."""
    with get_cursor(commit=True) as cur:
        cur.execute("SELECT * FROM events WHERE slug = %s;", (config.EVENT_SLUG,))
        row = cur.fetchone()
        if row:
            return dict(row)
        cur.execute(
            """INSERT INTO events (slug, name, event_date)
               VALUES (%s, %s, %s)
               ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
               RETURNING *;""",
            (config.EVENT_SLUG, config.EVENT_NAME, config.EVENT_DATE),
        )
        return dict(cur.fetchone())


def update_event(event_id: int, **fields) -> None:
    allowed = {"requests_open", "voting_open", "vote_cooldown_seconds",
               "request_cooldown_seconds", "max_requests_per_guest"}
    updates = {k: v for k, v in fields.items() if k in allowed and v is not None}
    if not updates:
        return
    assignments = ", ".join(f"{k} = %s" for k in updates)
    with get_cursor(commit=True) as cur:
        cur.execute(f"UPDATE events SET {assignments} WHERE id = %s;",
                    (*updates.values(), event_id))


# --- Guests --------------------------------------------------------------

def touch_guest(token: str, display_name: str | None = None) -> None:
    """Record that this browser is active. Called on every page load."""
    with get_cursor(commit=True) as cur:
        cur.execute(
            """INSERT INTO guests (token, display_name)
               VALUES (%s, %s)
               ON CONFLICT (token) DO UPDATE
                   SET last_seen = now(),
                       display_name = COALESCE(EXCLUDED.display_name, guests.display_name);""",
            (token, display_name or None),
        )


def _seconds_remaining(last: datetime | None, cooldown: int) -> int:
    if last is None or cooldown <= 0:
        return 0
    elapsed = (datetime.now(timezone.utc) - last).total_seconds()
    return max(0, int(round(cooldown - elapsed)))


def vote_cooldown_remaining(token: str, cooldown: int) -> int:
    with get_cursor() as cur:
        cur.execute("SELECT max(created_at) AS last FROM votes WHERE guest_token = %s;",
                    (token,))
        row = cur.fetchone()
    return _seconds_remaining(row["last"] if row else None, cooldown)


def request_cooldown_remaining(token: str, event_id: int, cooldown: int) -> int:
    with get_cursor() as cur:
        cur.execute(
            """SELECT max(created_at) AS last FROM song_requests
               WHERE requested_by = %s AND event_id = %s;""",
            (token, event_id),
        )
        row = cur.fetchone()
    return _seconds_remaining(row["last"] if row else None, cooldown)


def requests_by_guest(token: str, event_id: int) -> int:
    with get_cursor() as cur:
        cur.execute(
            """SELECT count(*) AS n FROM song_requests
               WHERE requested_by = %s AND event_id = %s AND status <> 'hidden';""",
            (token, event_id),
        )
        return cur.fetchone()["n"]


# --- Block rules ---------------------------------------------------------

def list_block_rules(active_only: bool = True) -> list[dict]:
    clause = "WHERE active" if active_only else ""
    with get_cursor() as cur:
        cur.execute(f"SELECT * FROM block_rules {clause} ORDER BY kind, pattern;")
        return [dict(r) for r in cur.fetchall()]


def add_block_rule(kind: str, pattern: str, reason: str | None = None) -> None:
    pattern = (pattern or "").strip()
    if not pattern:
        raise ActionError("empty_pattern", "A block rule needs something to match on.")
    with get_cursor(commit=True) as cur:
        cur.execute(
            """INSERT INTO block_rules (kind, pattern, reason) VALUES (%s, %s, %s)
               ON CONFLICT (kind, lower(pattern))
               DO UPDATE SET active = TRUE, reason = EXCLUDED.reason;""",
            (kind, pattern, reason or None),
        )


def delete_block_rule(rule_id: int) -> None:
    with get_cursor(commit=True) as cur:
        cur.execute("DELETE FROM block_rules WHERE id = %s;", (rule_id,))


# --- Tracks --------------------------------------------------------------

def upsert_track(track: dict) -> int:
    """Insert or refresh a track row and return its id.

    Two shapes land here: Spotify results (keyed on spotify_id) and manual
    entries (keyed on normalized artist+title). The partial unique index means
    the two never collide.
    """
    title = (track.get("title") or "").strip()
    artist = (track.get("artist") or "").strip()
    if not title or not artist:
        raise ActionError("incomplete_track", "That song is missing a title or artist.")

    with get_cursor(commit=True) as cur:
        if track.get("spotify_id"):
            cur.execute(
                """INSERT INTO tracks (spotify_id, title, artist, album, artwork_url,
                                       duration_ms, explicit, preview_url)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (spotify_id) DO UPDATE
                       SET title = EXCLUDED.title, artist = EXCLUDED.artist,
                           album = EXCLUDED.album, artwork_url = EXCLUDED.artwork_url
                   RETURNING id;""",
                (track["spotify_id"], title, artist, track.get("album"),
                 track.get("artwork_url"), track.get("duration_ms"),
                 bool(track.get("explicit")), track.get("preview_url")),
            )
            return cur.fetchone()["id"]

        cur.execute(
            """SELECT id FROM tracks
               WHERE spotify_id IS NULL AND lower(artist) = lower(%s)
                 AND lower(title) = lower(%s);""",
            (artist, title),
        )
        existing = cur.fetchone()
        if existing:
            return existing["id"]
        cur.execute(
            """INSERT INTO tracks (title, artist, explicit)
               VALUES (%s, %s, %s) RETURNING id;""",
            (title, artist, bool(track.get("explicit"))),
        )
        return cur.fetchone()["id"]


# --- Requests and votes --------------------------------------------------

def leaderboard(event_id: int, guest_token: str | None = None,
                include_hidden: bool = False) -> list[dict]:
    """The board, highest score first. Played songs sink to the bottom.

    `voted` tells the UI whether to draw this guest's button as already cast.
    """
    status_clause = "" if include_hidden else "AND r.status <> 'hidden'"
    with get_cursor() as cur:
        cur.execute(
            f"""SELECT r.id, r.status, r.created_at, r.requester_name, r.played_at,
                       {TRACK_COLUMNS},
                       count(v.id) AS votes,
                       COALESCE(bool_or(v.guest_token = %s), FALSE) AS voted
                FROM song_requests r
                JOIN tracks t ON t.id = r.track_id
                LEFT JOIN votes v ON v.request_id = r.id
                WHERE r.event_id = %s {status_clause}
                GROUP BY r.id, t.id
                ORDER BY (r.status = 'played'), count(v.id) DESC, r.created_at ASC;""",
            (guest_token, event_id),
        )
        return [dict(r) for r in cur.fetchall()]


def _existing_request(cur, event_id: int, track_id: int) -> dict | None:
    cur.execute(
        "SELECT id, status FROM song_requests WHERE event_id = %s AND track_id = %s;",
        (event_id, track_id),
    )
    row = cur.fetchone()
    return dict(row) if row else None


def submit_request(event: dict, track: dict, guest_token: str,
                   requester_name: str | None = None) -> dict:
    """Put a song on the board.

    If the song is already there this is treated as an upvote instead of an
    error — that is what the guest meant, and it keeps the board deduplicated.
    Returns {"request_id", "action"} where action is "created" or "voted".
    """
    if not event["requests_open"]:
        raise ActionError("requests_closed", "Song requests are closed for now.")

    # Every write below carries a FK to guests; make sure the row is there
    # rather than relying on the caller having touched it first.
    touch_guest(guest_token)
    track_id = upsert_track(track)

    with get_cursor(commit=True) as cur:
        existing = _existing_request(cur, event["id"], track_id)
    if existing:
        if existing["status"] == "hidden":
            raise ActionError("blocked", "That song isn't available to request.")
        vote(event, existing["id"], guest_token)
        return {"request_id": existing["id"], "action": "voted"}

    cap = event["max_requests_per_guest"]
    if cap and requests_by_guest(guest_token, event["id"]) >= cap:
        raise ActionError(
            "request_cap",
            f"You've already put in {cap} songs — upvote someone else's instead!",
        )

    wait = request_cooldown_remaining(guest_token, event["id"],
                                      event["request_cooldown_seconds"])
    if wait:
        raise ActionError("request_cooldown",
                          f"Give it {_pretty(wait)} before adding another song.", wait)

    with get_cursor(commit=True) as cur:
        cur.execute(
            """INSERT INTO song_requests (event_id, track_id, requested_by, requester_name)
               VALUES (%s, %s, %s, %s) RETURNING id;""",
            (event["id"], track_id, guest_token, (requester_name or "").strip() or None),
        )
        request_id = cur.fetchone()["id"]
        # The submitter's own vote. It counts against their vote cooldown, so
        # adding a song and immediately upvoting a second one isn't free.
        cur.execute(
            """INSERT INTO votes (request_id, guest_token) VALUES (%s, %s)
               ON CONFLICT DO NOTHING;""",
            (request_id, guest_token),
        )
    return {"request_id": request_id, "action": "created"}


def vote(event: dict, request_id: int, guest_token: str) -> dict:
    """Cast one upvote. Enforces one-per-song and the per-guest cooldown."""
    if not event["voting_open"]:
        raise ActionError("voting_closed", "Voting is closed for now.")

    touch_guest(guest_token)

    with get_cursor() as cur:
        cur.execute(
            "SELECT id, status FROM song_requests WHERE id = %s AND event_id = %s;",
            (request_id, event["id"]),
        )
        row = cur.fetchone()
    if not row:
        raise ActionError("not_found", "That song isn't on the board.")
    if row["status"] != "queued":
        raise ActionError("not_votable", "That one's already been played.")

    with get_cursor() as cur:
        cur.execute(
            "SELECT 1 FROM votes WHERE request_id = %s AND guest_token = %s;",
            (request_id, guest_token),
        )
        if cur.fetchone():
            raise ActionError("already_voted", "You've already voted for that one.")

    wait = vote_cooldown_remaining(guest_token, event["vote_cooldown_seconds"])
    if wait:
        raise ActionError("vote_cooldown",
                          f"One vote at a time — try again in {_pretty(wait)}.", wait)

    try:
        with get_cursor(commit=True) as cur:
            cur.execute(
                "INSERT INTO votes (request_id, guest_token) VALUES (%s, %s);",
                (request_id, guest_token),
            )
    except errors.UniqueViolation:
        # Two taps raced each other; the unique index is the real guarantee.
        raise ActionError("already_voted", "You've already voted for that one.")
    return {"request_id": request_id, "action": "voted"}


# --- DJ / admin actions --------------------------------------------------

def set_status(event_id: int, request_id: int, status: str) -> None:
    if status not in ("queued", "played", "hidden"):
        raise ActionError("bad_status", f"Unknown status {status!r}.")
    played_at = "now()" if status == "played" else "NULL"
    with get_cursor(commit=True) as cur:
        cur.execute(
            f"""UPDATE song_requests SET status = %s, played_at = {played_at}
                WHERE id = %s AND event_id = %s;""",
            (status, request_id, event_id),
        )


def setlist(event_id: int) -> dict:
    """What the night produced.

    Today this is the request board: songs the DJ marked played (in order), then
    everything else by score. When real capture of the DJ's mix exists, `played`
    comes from played_tracks instead and `requested` stays as the wish list.
    """
    rows = leaderboard(event_id)
    played = [r for r in rows if r["status"] == "played"]
    played.sort(key=lambda r: r["played_at"] or r["created_at"])
    return {
        "played": played,
        "requested": [r for r in rows if r["status"] == "queued"],
    }


def _pretty(seconds: int) -> str:
    if seconds < 60:
        return f"{seconds}s"
    minutes = round(seconds / 60)
    return f"{minutes} minute{'s' if minutes != 1 else ''}"
