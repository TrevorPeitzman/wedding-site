"""Route-level tests through Starlette's TestClient, including the cookie flow."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config, guests, service  # noqa: E402

pytest.importorskip("fastapi.testclient")
from fastapi.testclient import TestClient  # noqa: E402


@pytest.fixture
def client(event, monkeypatch):
    monkeypatch.setattr(config, "SPOTIFY_OFFLINE", True)
    monkeypatch.setattr(config, "COOKIE_SECURE", False)  # TestClient speaks http
    monkeypatch.setattr(config, "ADMIN_TOKEN", "test-admin")
    from app.main import app
    with TestClient(app) as c:
        yield c


def test_board_renders_and_issues_a_signed_cookie(client):
    resp = client.get("/")
    assert resp.status_code == 200
    assert "Request a song" in resp.text
    raw = resp.cookies.get(config.COOKIE_NAME)
    assert raw and guests.unsign(raw)


def test_search_returns_offline_results(client):
    body = client.get("/api/search", params={"q": "september"}).json()
    assert body["ok"] and any(r["title"] == "September" for r in body["results"])


def test_search_hides_blocked_tracks(client):
    service.add_block_rule("title", "September", "nope")
    body = client.get("/api/search", params={"q": "september"}).json()
    assert all(r["title"] != "September" for r in body["results"])


def test_submit_then_vote_from_a_second_browser(client, event):
    track = client.get("/api/search", params={"q": "Dancing Queen"}).json()["results"][0]
    created = client.post("/api/requests", data={"spotify_id": track["spotify_id"],
                                                 "requester_name": "Casey"})
    assert created.json()["action"] == "created"
    request_id = created.json()["request_id"]

    board = client.get("/api/requests").json()
    assert board["requests"][0]["votes"] == 1
    assert board["requests"][0]["voted"] is True
    assert board["requests"][0]["requester_name"] == "Casey"

    # A second browser is just a client with no cookie jar entry.
    from app.main import app
    with TestClient(app) as other:
        voted = other.post(f"/api/requests/{request_id}/vote")
        assert voted.status_code == 200
        assert other.get("/api/requests").json()["requests"][0]["votes"] == 2


def test_voting_twice_in_one_browser_is_refused(client):
    track = client.get("/api/search", params={"q": "Superstition"}).json()["results"][0]
    request_id = client.post("/api/requests",
                             data={"spotify_id": track["spotify_id"]}).json()["request_id"]
    again = client.post(f"/api/requests/{request_id}/vote")
    assert again.status_code == 400
    assert again.json()["code"] == "already_voted"


def test_blocked_song_is_refused_at_submit(client):
    track = client.get("/api/search", params={"q": "Mr. Brightside"}).json()["results"][0]
    service.add_block_rule("spotify_id", track["spotify_id"], "Not tonight!")
    resp = client.post("/api/requests", data={"spotify_id": track["spotify_id"]})
    assert resp.status_code == 400
    assert resp.json()["message"] == "Not tonight!"


def test_manual_entry_requires_both_fields(client):
    assert client.post("/api/requests", data={"title": "Only A Title"}).status_code == 400
    ok = client.post("/api/requests", data={"title": "Our Song", "artist": "The Band"})
    assert ok.json()["action"] == "created"


def test_unknown_spotify_id_is_rejected(client):
    resp = client.post("/api/requests", data={"spotify_id": "not-a-real-id"})
    assert resp.status_code == 400 and resp.json()["code"] == "unknown_track"


def test_cooldown_surfaces_as_429_with_retry_after(client, event):
    """A guest who just voted is held off the next song, not off the board."""
    mine = client.get("/api/search", params={"q": "Levitating"}).json()["results"][0]
    client.post("/api/requests", data={"spotify_id": mine["spotify_id"]})  # auto-votes

    # Someone else's song, added server-side so this browser has no vote on it.
    service.touch_guest("guest-z")
    theirs = service.submit_request(
        service.ensure_event(),
        {"spotify_id": "othertrack", "title": "Get Lucky", "artist": "Daft Punk"},
        "guest-z")

    service.update_event(event["id"], vote_cooldown_seconds=600)
    resp = client.post(f"/api/requests/{theirs['request_id']}/vote")
    assert resp.status_code == 429
    body = resp.json()
    assert body["code"] == "vote_cooldown" and 0 < body["retry_after"] <= 600

    # The board still renders for them, with the remaining wait attached.
    assert client.get("/api/requests").json()["vote_cooldown_remaining"] > 0


def test_admin_requires_the_token(client):
    assert client.get("/admin").status_code == 403
    ok = client.get("/admin", params={"token": "test-admin"})
    assert ok.status_code == 200 and "DJ view" in ok.text


def test_admin_can_mark_played_and_block(client, event):
    track = client.get("/api/search", params={"q": "Wagon Wheel"}).json()["results"][0]
    request_id = client.post("/api/requests",
                             data={"spotify_id": track["spotify_id"]}).json()["request_id"]
    client.get("/admin", params={"token": "test-admin"})  # stores the admin cookie

    client.post(f"/admin/requests/{request_id}/status", data={"status": "played"},
                follow_redirects=False)
    assert service.leaderboard(event["id"])[0]["status"] == "played"

    client.post("/admin/blocklist", data={"kind": "title", "pattern": "Wagon Wheel",
                                          "reason": "no", "hide_request_id": request_id},
                follow_redirects=False)
    assert service.leaderboard(event["id"]) == []
    assert any(r["pattern"] == "Wagon Wheel" for r in service.list_block_rules())


def test_setlist_exports(client, event):
    track = client.get("/api/search", params={"q": "At Last"}).json()["results"][0]
    request_id = client.post("/api/requests",
                             data={"spotify_id": track["spotify_id"]}).json()["request_id"]
    service.set_status(event["id"], request_id, "played")

    assert "Etta James - At Last" in client.get("/setlist.txt").text
    assert f"spotify:track:{track['spotify_id']}" in client.get("/setlist.uris").text

    csv_body = client.get("/setlist.csv")
    assert csv_body.headers["content-type"].startswith("text/csv")
    assert "At Last" in csv_body.text and "played" in csv_body.text
    assert "The setlist" in client.get("/setlist").text


def test_healthz(client):
    assert client.get("/healthz").json() == {"status": "ok"}
