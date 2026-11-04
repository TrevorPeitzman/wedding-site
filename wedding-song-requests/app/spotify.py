"""Spotify catalog search via the Client Credentials flow.

Client Credentials is the right grant here: the app searches the public
catalog on behalf of nobody, so there is no guest login, no OAuth redirect and
no refresh-token storage. The trade-off is that this token CANNOT create a
playlist on your account — playlist writes need a user-authorized grant. See
DESIGN.md under "Setlist export" for how the end-of-night export works today.

Offline mode (SPOTIFY_OFFLINE=1) searches a local fixture catalog instead, so
the app runs and its tests pass with no credentials.
"""
import json
import threading
import time
from pathlib import Path

import httpx

from app import config

TOKEN_URL = "https://accounts.spotify.com/api/token"
API_BASE = "https://api.spotify.com/v1"
FIXTURE_PATH = Path(__file__).resolve().parent / "fixtures" / "tracks.json"

_token_lock = threading.Lock()
_token_value: str | None = None
_token_expires_at: float = 0.0


class SpotifyError(RuntimeError):
    """Search could not be completed. The caller turns this into a 503 and the
    UI falls back to telling the guest to try again."""


def _fixtures() -> list[dict]:
    return json.loads(FIXTURE_PATH.read_text())


def _get_token() -> str:
    """Fetch and cache an app token. Refreshed 60s before it actually expires."""
    global _token_value, _token_expires_at
    with _token_lock:
        if _token_value and time.time() < _token_expires_at:
            return _token_value
        if not config.SPOTIFY_CONFIGURED:
            raise SpotifyError("Spotify credentials are not configured")
        try:
            resp = httpx.post(
                TOKEN_URL,
                data={"grant_type": "client_credentials"},
                auth=(config.SPOTIFY_CLIENT_ID, config.SPOTIFY_CLIENT_SECRET),
                timeout=10.0,
            )
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            raise SpotifyError(f"could not get a Spotify token: {exc}") from exc
        payload = resp.json()
        _token_value = payload["access_token"]
        _token_expires_at = time.time() + int(payload.get("expires_in", 3600)) - 60
        return _token_value


def normalize_track(item: dict) -> dict:
    """Spotify's track object -> the flat shape the rest of the app stores."""
    images = (item.get("album") or {}).get("images") or []
    # Spotify returns images largest-first; the smallest is plenty for a list row.
    artwork = images[-1]["url"] if images else None
    return {
        "spotify_id": item.get("id"),
        "title": item.get("name", ""),
        "artist": ", ".join(a["name"] for a in item.get("artists", []) if a.get("name")),
        "album": (item.get("album") or {}).get("name"),
        "artwork_url": artwork,
        "duration_ms": item.get("duration_ms"),
        "explicit": bool(item.get("explicit")),
        "preview_url": item.get("preview_url"),
    }


def _offline_search(query: str, limit: int) -> list[dict]:
    needle = query.strip().lower()
    if not needle:
        return []
    scored = []
    for track in _fixtures():
        haystack = f"{track['title']} {track['artist']} {track.get('album') or ''}".lower()
        if needle in haystack:
            # Title matches rank above artist-only matches.
            scored.append((0 if needle in track["title"].lower() else 1, track))
    scored.sort(key=lambda pair: pair[0])
    return [track for _, track in scored[:limit]]


def search_tracks(query: str, limit: int = 8) -> list[dict]:
    """Search the catalog. Returns normalized track dicts, possibly empty."""
    if config.SPOTIFY_OFFLINE or not config.SPOTIFY_CONFIGURED:
        return _offline_search(query, limit)
    if not query.strip():
        return []
    try:
        resp = httpx.get(
            f"{API_BASE}/search",
            params={"q": query, "type": "track", "limit": limit,
                    "market": config.SPOTIFY_MARKET},
            headers={"Authorization": f"Bearer {_get_token()}"},
            timeout=10.0,
        )
        resp.raise_for_status()
    except httpx.HTTPError as exc:
        raise SpotifyError(f"Spotify search failed: {exc}") from exc
    items = (resp.json().get("tracks") or {}).get("items") or []
    return [normalize_track(item) for item in items]


def get_track(spotify_id: str) -> dict | None:
    """Re-fetch one track so a submission cannot be spoofed with client-supplied
    metadata: the browser sends an id, the server decides what that id means."""
    if config.SPOTIFY_OFFLINE or not config.SPOTIFY_CONFIGURED:
        return next((t for t in _fixtures() if t["spotify_id"] == spotify_id), None)
    try:
        resp = httpx.get(
            f"{API_BASE}/tracks/{spotify_id}",
            params={"market": config.SPOTIFY_MARKET},
            headers={"Authorization": f"Bearer {_get_token()}"},
            timeout=10.0,
        )
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
    except httpx.HTTPError as exc:
        raise SpotifyError(f"Spotify lookup failed: {exc}") from exc
    return normalize_track(resp.json())
