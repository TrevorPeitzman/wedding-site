"""Runtime configuration, read from the environment.

Either DATABASE_URL or the individual PG* vars are accepted so the same code
runs under docker-compose and a local virtualenv.
"""
import os
import secrets

from dotenv import load_dotenv

load_dotenv()  # no-op if there is no .env file


def build_dsn() -> str:
    url = os.environ.get("DATABASE_URL")
    if url:
        return url
    host = os.environ.get("PGHOST", "localhost")
    port = os.environ.get("PGPORT", "5432")
    user = os.environ.get("PGUSER", "wedding")
    password = os.environ.get("PGPASSWORD", "wedding")
    db = os.environ.get("PGDATABASE", "wedding_songs")
    return f"postgresql://{user}:{password}@{host}:{port}/{db}"


DATABASE_URL = build_dsn()

# --- Event ---------------------------------------------------------------
# One row is created from these on first boot; after that the admin view is
# the source of truth for the live toggles.
EVENT_SLUG = os.environ.get("EVENT_SLUG", "wedding")
EVENT_NAME = os.environ.get("EVENT_NAME", "The Wedding")
EVENT_DATE = os.environ.get("EVENT_DATE") or None

# --- Identity / security -------------------------------------------------
# Signs the guest cookie. MUST be set in production: regenerating it on each
# boot silently invalidates every guest's vote history.
SECRET_KEY = os.environ.get("SECRET_KEY") or secrets.token_urlsafe(32)
SECRET_KEY_IS_EPHEMERAL = not os.environ.get("SECRET_KEY")

# Gate for the DJ/admin view. Unset means the admin routes stay closed.
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN") or ""

COOKIE_NAME = os.environ.get("COOKIE_NAME", "wsr_guest")
# Set to 0 only for plain-HTTP local testing; behind your VPS TLS keep it 1.
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "1") not in ("0", "false", "False")
COOKIE_MAX_AGE_DAYS = int(os.environ.get("COOKIE_MAX_AGE_DAYS", "30"))

# --- Spotify -------------------------------------------------------------
SPOTIFY_CLIENT_ID = os.environ.get("SPOTIFY_CLIENT_ID", "")
SPOTIFY_CLIENT_SECRET = os.environ.get("SPOTIFY_CLIENT_SECRET", "")
SPOTIFY_MARKET = os.environ.get("SPOTIFY_MARKET", "US")
# Offline mode searches a small local fixture catalog instead of the live API,
# so the app is demo-able and testable with no credentials at all.
SPOTIFY_OFFLINE = os.environ.get("SPOTIFY_OFFLINE", "0") in ("1", "true", "True")
SPOTIFY_CONFIGURED = bool(SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET)

# Reject explicit tracks at submit time without needing a block rule per song.
BLOCK_EXPLICIT = os.environ.get("BLOCK_EXPLICIT", "0") in ("1", "true", "True")
