"""DB-backed tests for the request / vote rules. Skipped without Postgres."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import service  # noqa: E402
from app.service import ActionError  # noqa: E402

SONG_A = {"spotify_id": "trackaaa", "title": "September", "artist": "Earth, Wind & Fire"}
SONG_B = {"spotify_id": "trackbbb", "title": "Valerie", "artist": "Mark Ronson"}


def test_submitting_creates_a_request_and_the_submitter_s_vote(event, guest):
    result = service.submit_request(event, SONG_A, guest, "Guest A")
    assert result["action"] == "created"
    rows = service.leaderboard(event["id"], guest)
    assert len(rows) == 1
    assert rows[0]["votes"] == 1 and rows[0]["voted"] is True


def test_duplicate_submission_becomes_an_upvote(event, guest):
    first = service.submit_request(event, SONG_A, guest)
    service.touch_guest("guest-b")
    second = service.submit_request(event, SONG_A, "guest-b")

    assert second["action"] == "voted"
    assert second["request_id"] == first["request_id"]
    rows = service.leaderboard(event["id"])
    assert len(rows) == 1 and rows[0]["votes"] == 2


def test_a_guest_cannot_vote_twice_for_the_same_song(event, guest):
    created = service.submit_request(event, SONG_A, guest)
    with pytest.raises(ActionError) as exc:
        service.vote(event, created["request_id"], guest)
    assert exc.value.code == "already_voted"


def test_vote_cooldown_blocks_the_next_vote(event, guest):
    service.submit_request(event, SONG_A, guest)
    service.touch_guest("guest-b")
    other = service.submit_request(event, SONG_B, "guest-b")

    service.update_event(event["id"], vote_cooldown_seconds=600)
    hot = service.ensure_event()
    with pytest.raises(ActionError) as exc:
        service.vote(hot, other["request_id"], guest)
    assert exc.value.code == "vote_cooldown"
    assert 0 < exc.value.retry_after <= 600


def test_request_cap_is_enforced(event, guest):
    service.update_event(event["id"], max_requests_per_guest=1)
    capped = service.ensure_event()
    service.submit_request(capped, SONG_A, guest)
    with pytest.raises(ActionError) as exc:
        service.submit_request(capped, SONG_B, guest)
    assert exc.value.code == "request_cap"


def test_closed_event_refuses_requests_and_votes(event, guest):
    created = service.submit_request(event, SONG_A, guest)
    service.update_event(event["id"], requests_open=False, voting_open=False)
    closed = service.ensure_event()

    with pytest.raises(ActionError) as exc:
        service.submit_request(closed, SONG_B, guest)
    assert exc.value.code == "requests_closed"

    service.touch_guest("guest-b")
    with pytest.raises(ActionError) as exc:
        service.vote(closed, created["request_id"], "guest-b")
    assert exc.value.code == "voting_closed"


def test_leaderboard_orders_by_votes_then_age(event, guest):
    quiet = service.submit_request(event, SONG_A, guest)
    service.touch_guest("guest-b")
    popular = service.submit_request(event, SONG_B, "guest-b")
    for name in ("guest-c", "guest-d"):
        service.touch_guest(name)
        service.vote(event, popular["request_id"], name)

    order = [r["id"] for r in service.leaderboard(event["id"])]
    assert order == [popular["request_id"], quiet["request_id"]]


def test_played_songs_sink_and_stop_taking_votes(event, guest):
    played = service.submit_request(event, SONG_A, guest)
    for name in ("guest-b", "guest-c"):
        service.touch_guest(name)
        service.vote(event, played["request_id"], name)
    service.touch_guest("guest-d")
    queued = service.submit_request(event, SONG_B, "guest-d")

    service.set_status(event["id"], played["request_id"], "played")

    order = [r["id"] for r in service.leaderboard(event["id"])]
    assert order == [queued["request_id"], played["request_id"]]  # played last, despite more votes

    service.touch_guest("guest-e")
    with pytest.raises(ActionError) as exc:
        service.vote(event, played["request_id"], "guest-e")
    assert exc.value.code == "not_votable"


def test_hidden_requests_drop_off_the_public_board(event, guest):
    hidden = service.submit_request(event, SONG_A, guest)
    service.set_status(event["id"], hidden["request_id"], "hidden")

    assert service.leaderboard(event["id"]) == []
    assert len(service.leaderboard(event["id"], include_hidden=True)) == 1

    # Re-requesting a hidden song is refused rather than silently resurrecting it.
    service.touch_guest("guest-b")
    with pytest.raises(ActionError) as exc:
        service.submit_request(event, SONG_A, "guest-b")
    assert exc.value.code == "blocked"


def test_manual_entries_dedupe_on_artist_and_title(event, guest):
    manual = {"spotify_id": None, "title": "Our Song", "artist": "The Band"}
    first = service.upsert_track(manual)
    same = service.upsert_track({"spotify_id": None, "title": "our song", "artist": "the band"})
    assert first == same


def test_setlist_splits_played_from_requested(event, guest):
    played = service.submit_request(event, SONG_A, guest)
    service.touch_guest("guest-b")
    service.submit_request(event, SONG_B, "guest-b")
    service.set_status(event["id"], played["request_id"], "played")

    data = service.setlist(event["id"])
    assert [r["id"] for r in data["played"]] == [played["request_id"]]
    assert played["request_id"] not in [r["id"] for r in data["requested"]]
