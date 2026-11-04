"""End-to-end smoke test against the configured database.

Exercises the real service layer: submit, dedupe-to-upvote, one-vote-per-song,
the cooldown, and the block list. Leaves a `smoketest` event behind, separate
from the real one.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import blocklist, config, service, spotify  # noqa: E402
from app.db import get_cursor  # noqa: E402

FAILURES = []


def check(label: str, condition: bool):
    print(("  ok   " if condition else "  FAIL ") + label)
    if not condition:
        FAILURES.append(label)


def main():
    config.SPOTIFY_OFFLINE = True
    config.EVENT_SLUG = "smoketest"
    config.EVENT_NAME = "Smoke Test"

    event = service.ensure_event()
    with get_cursor(commit=True) as cur:
        cur.execute("DELETE FROM song_requests WHERE event_id = %s;", (event["id"],))
    service.update_event(event["id"], vote_cooldown_seconds=0,
                         request_cooldown_seconds=0, max_requests_per_guest=50)
    event = service.ensure_event()

    tracks = spotify._fixtures()
    alice, bob = "smoke-alice", "smoke-bob"
    service.touch_guest(alice)
    service.touch_guest(bob)

    print("submit + dedupe")
    first = service.submit_request(event, tracks[0], alice, "Alice")
    check("first submission creates a request", first["action"] == "created")
    again = service.submit_request(event, tracks[0], bob, "Bob")
    check("duplicate submission becomes a vote", again["action"] == "voted")
    check("same request row reused", again["request_id"] == first["request_id"])

    print("voting rules")
    rows = service.leaderboard(event["id"], alice)
    top = rows[0]
    check("two votes recorded", top["votes"] == 2)
    check("alice sees her own vote", top["voted"] is True)
    try:
        service.vote(event, first["request_id"], alice)
        check("second vote on the same song is refused", False)
    except service.ActionError as exc:
        check("second vote on the same song is refused", exc.code == "already_voted")

    print("cooldown")
    service.update_event(event["id"], vote_cooldown_seconds=600)
    hot = service.ensure_event()
    second = service.submit_request(hot, tracks[1], "smoke-carol")
    try:
        service.vote(hot, second["request_id"], alice)
        check("cooldown blocks a rapid second vote", False)
    except service.ActionError as exc:
        check("cooldown blocks a rapid second vote", exc.code == "vote_cooldown")
        check("cooldown reports a retry_after", (exc.retry_after or 0) > 0)

    print("block list")
    service.add_block_rule("artist", tracks[2]["artist"], "smoke test rule")
    rules = service.list_block_rules()
    check("rule matches its track", blocklist.check(tracks[2], rules) is not None)
    check("rule leaves others alone", blocklist.check(tracks[0], rules) is None)
    with get_cursor(commit=True) as cur:
        cur.execute("DELETE FROM block_rules WHERE reason = 'smoke test rule';")

    print("setlist")
    service.set_status(event["id"], first["request_id"], "played")
    data = service.setlist(event["id"])
    check("played song moves to the played list", len(data["played"]) == 1)
    check("played song leaves the request list",
          all(r["id"] != first["request_id"] for r in data["requested"]))

    print()
    if FAILURES:
        print(f"{len(FAILURES)} check(s) failed:")
        for name in FAILURES:
            print(f"  - {name}")
        raise SystemExit(1)
    print("all smoke checks passed")


if __name__ == "__main__":
    main()
