"""Create the event row and, with --demo, a board full of fake activity.

The starter block rules are examples, not opinions — delete them in the DJ
view. They exist so the block list has something in it on first look.
"""
import argparse
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config, service, spotify  # noqa: E402
from app.db import get_cursor  # noqa: E402

STARTER_RULES = [
    ("keyword", "Chicken Dance", "Example rule — delete me in the DJ view"),
    ("keyword", "Cha Cha Slide", "Example rule — delete me in the DJ view"),
]


def seed_rules():
    for kind, pattern, reason in STARTER_RULES:
        service.add_block_rule(kind, pattern, reason)
    print(f"[seed] {len(STARTER_RULES)} starter block rules")


def seed_demo(event: dict, guests: int = 14):
    """Fill the board from the offline fixture catalog so the UI has something
    to show before anyone has actually used it."""
    was_offline = config.SPOTIFY_OFFLINE
    config.SPOTIFY_OFFLINE = True  # demo data never hits the live API
    try:
        tracks = spotify._fixtures()
        random.seed(20260917)
        names = ["Casey", "Jordan", "Sam", "Riley", "Avery", "Quinn", "Drew", None]
        tokens = [f"demoguest{i:03d}" for i in range(guests)]
        for token in tokens:
            service.touch_guest(token, random.choice(names))

        for track in random.sample(tracks, min(10, len(tracks))):
            track_id = service.upsert_track(track)
            requester = random.choice(tokens)
            with get_cursor(commit=True) as cur:
                cur.execute(
                    """INSERT INTO song_requests (event_id, track_id, requested_by, requester_name)
                       VALUES (%s, %s, %s, %s)
                       ON CONFLICT (event_id, track_id) DO NOTHING
                       RETURNING id;""",
                    (event["id"], track_id, requester, random.choice(names)),
                )
                row = cur.fetchone()
                if not row:
                    continue
                voters = random.sample(tokens, random.randint(1, len(tokens)))
                for voter in voters:
                    cur.execute(
                        """INSERT INTO votes (request_id, guest_token) VALUES (%s, %s)
                           ON CONFLICT DO NOTHING;""",
                        (row["id"], voter),
                    )
    finally:
        config.SPOTIFY_OFFLINE = was_offline
    print("[seed] demo board populated")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--demo", action="store_true",
                        help="also create fake requests and votes")
    args = parser.parse_args()

    event = service.ensure_event()
    print(f"[seed] event {event['slug']!r} (id={event['id']})")
    seed_rules()
    if args.demo:
        seed_demo(event)
