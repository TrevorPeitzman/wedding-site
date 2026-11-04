"""The auto-block list.

Rules are matched in Python rather than SQL so the same function backs the
submit path, the admin preview, and the tests, and so `keyword` can look at
title and artist together without a compound query.
"""
from app import config


def match_rule(track: dict, rule: dict) -> bool:
    """True if this one rule blocks this track."""
    if not rule.get("active", True):
        return False
    kind = rule["kind"]
    pattern = (rule["pattern"] or "").strip().lower()
    if not pattern:
        return False
    title = (track.get("title") or "").lower()
    artist = (track.get("artist") or "").lower()

    if kind == "spotify_id":
        return bool(track.get("spotify_id")) and track["spotify_id"] == rule["pattern"].strip()
    if kind == "artist":
        return pattern in artist
    if kind == "title":
        return pattern in title
    if kind == "keyword":
        return pattern in title or pattern in artist
    return False


def check(track: dict, rules: list[dict]) -> dict | None:
    """Return the first rule that blocks this track, or None if it is allowed.

    The explicit-content switch is evaluated first and reported as a synthetic
    rule so the caller has one uniform shape to render.
    """
    if config.BLOCK_EXPLICIT and track.get("explicit"):
        return {"kind": "explicit", "pattern": "explicit",
                "reason": "Explicit tracks are turned off for this event"}
    for rule in rules:
        if match_rule(track, rule):
            return rule
    return None
