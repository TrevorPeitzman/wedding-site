-- Wedding Song Requests — schema
-- Postgres. All DDL is idempotent so it can be applied on every container start.
--
-- Design notes:
--  * A request is unique per (event, track). A second guest "requesting" a song
--    that already exists is silently converted into an upvote, which is what
--    they meant anyway and keeps the leaderboard free of duplicates.
--  * Identity is a signed cookie holding an opaque guest token. There is no
--    login, no email, no PII beyond an optional display name the guest types.
--  * `votes` is the source of truth for the score; no denormalized counter, so
--    a vote can never drift from its row. At wedding scale (a few hundred
--    guests) counting on read is free.
--  * `played_tracks` is deliberately present but unused by the MVP. Capturing
--    what the DJ actually mixed is an open question (see DESIGN.md); when it is
--    answered, the capture path writes here and the setlist export reads here
--    instead of from the request list. Nothing else has to change.

CREATE TABLE IF NOT EXISTS events (
    id                       SERIAL PRIMARY KEY,
    slug                     TEXT NOT NULL UNIQUE,
    name                     TEXT NOT NULL,
    event_date               DATE,
    -- Live controls, flipped from the admin view during the night.
    requests_open            BOOLEAN NOT NULL DEFAULT TRUE,
    voting_open              BOOLEAN NOT NULL DEFAULT TRUE,
    -- Anti-spam knobs. A guest may cast one vote per cooldown window, and
    -- submit a new song no more often than the request cooldown.
    vote_cooldown_seconds    INTEGER NOT NULL DEFAULT 300,
    request_cooldown_seconds INTEGER NOT NULL DEFAULT 600,
    max_requests_per_guest   INTEGER NOT NULL DEFAULT 5,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Track metadata, cached from Spotify on first request so the leaderboard
-- never needs a live API call to render.
CREATE TABLE IF NOT EXISTS tracks (
    id           SERIAL PRIMARY KEY,
    spotify_id   TEXT UNIQUE,                     -- NULL for manual entries
    title        TEXT NOT NULL,
    artist       TEXT NOT NULL,
    album        TEXT,
    artwork_url  TEXT,
    duration_ms  INTEGER,
    explicit     BOOLEAN NOT NULL DEFAULT FALSE,
    preview_url  TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Manual entries have no Spotify id, so dedupe them on normalized text.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tracks_manual_key
    ON tracks (lower(artist), lower(title)) WHERE spotify_id IS NULL;

-- One row per browser that has ever interacted. The token is the value inside
-- the signed cookie; it is opaque and carries no personal information.
CREATE TABLE IF NOT EXISTS guests (
    token        TEXT PRIMARY KEY,
    display_name TEXT,
    first_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS song_requests (
    id             SERIAL PRIMARY KEY,
    event_id       INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    track_id       INTEGER NOT NULL REFERENCES tracks(id),
    requested_by   TEXT REFERENCES guests(token),
    requester_name TEXT,
    -- queued: on the board. played: the DJ marked it played. hidden: removed by
    -- the DJ or by a block rule added after the fact; stays in the table so the
    -- guest's vote history is intact but drops off the public board.
    status         TEXT NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'played', 'hidden')),
    played_at      TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (event_id, track_id)
);
CREATE INDEX IF NOT EXISTS idx_requests_event_status
    ON song_requests (event_id, status);

CREATE TABLE IF NOT EXISTS votes (
    id          SERIAL PRIMARY KEY,
    request_id  INTEGER NOT NULL REFERENCES song_requests(id) ON DELETE CASCADE,
    guest_token TEXT NOT NULL REFERENCES guests(token),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (request_id, guest_token)                -- one vote per song per guest
);
CREATE INDEX IF NOT EXISTS idx_votes_guest_recent
    ON votes (guest_token, created_at DESC);        -- serves the cooldown check

-- Auto-block list. Checked at submit time, before a request row is created.
--   spotify_id : exact track match
--   artist     : case-insensitive substring of the artist string
--   title      : case-insensitive substring of the title
--   keyword    : case-insensitive substring of either
CREATE TABLE IF NOT EXISTS block_rules (
    id         SERIAL PRIMARY KEY,
    kind       TEXT NOT NULL CHECK (kind IN ('spotify_id', 'artist', 'title', 'keyword')),
    pattern    TEXT NOT NULL,
    reason     TEXT,
    active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_block_rules_key
    ON block_rules (kind, lower(pattern));

-- Reserved for real "what actually played" capture. Unused by the MVP; see the
-- open question in DESIGN.md. `source` records where the row came from so a
-- setlist assembled from two capture paths stays traceable.
CREATE TABLE IF NOT EXISTS played_tracks (
    id         SERIAL PRIMARY KEY,
    event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    track_id   INTEGER REFERENCES tracks(id),
    raw_title  TEXT,                                -- when the source is unmatched text
    raw_artist TEXT,
    played_at  TIMESTAMPTZ NOT NULL,
    source     TEXT NOT NULL
               CHECK (source IN ('dj_marked', 'dj_export', 'listener')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_played_event_time
    ON played_tracks (event_id, played_at);
