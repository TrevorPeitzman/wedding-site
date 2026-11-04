import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config, spotify


def test_offline_search_matches_title_and_artist(monkeypatch):
    monkeypatch.setattr(config, "SPOTIFY_OFFLINE", True)
    assert any(t["title"] == "September" for t in spotify.search_tracks("september"))
    assert all("stevie wonder" in t["artist"].lower()
               for t in spotify.search_tracks("Stevie Wonder"))
    assert spotify.search_tracks("zzzz no such song") == []
    assert spotify.search_tracks("  ") == []


def test_offline_search_respects_limit(monkeypatch):
    monkeypatch.setattr(config, "SPOTIFY_OFFLINE", True)
    assert len(spotify.search_tracks("e", limit=3)) <= 3


def test_offline_get_track(monkeypatch):
    monkeypatch.setattr(config, "SPOTIFY_OFFLINE", True)
    known = spotify.search_tracks("September")[0]
    assert spotify.get_track(known["spotify_id"])["title"] == "September"
    assert spotify.get_track("nope") is None


def test_normalize_track_flattens_the_api_shape():
    out = spotify.normalize_track({
        "id": "xyz", "name": "Valerie", "duration_ms": 233000, "explicit": False,
        "artists": [{"name": "Mark Ronson"}, {"name": "Amy Winehouse"}],
        "album": {"name": "Version", "images": [{"url": "big.jpg"}, {"url": "small.jpg"}]},
        "preview_url": None,
    })
    assert out["artist"] == "Mark Ronson, Amy Winehouse"
    assert out["artwork_url"] == "small.jpg"   # smallest image, listed last
    assert out["album"] == "Version"


def test_search_without_credentials_falls_back_offline(monkeypatch):
    monkeypatch.setattr(config, "SPOTIFY_OFFLINE", False)
    monkeypatch.setattr(config, "SPOTIFY_CONFIGURED", False)
    assert spotify.search_tracks("September")  # no network, no raise
