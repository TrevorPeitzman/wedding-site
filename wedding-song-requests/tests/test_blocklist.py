import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import blocklist, config


def track(**over):
    base = {"spotify_id": "abc123", "title": "Sweet Caroline",
            "artist": "Neil Diamond", "explicit": False}
    base.update(over)
    return base


def rule(kind, pattern, active=True):
    return {"kind": kind, "pattern": pattern, "active": active, "reason": None}


def test_artist_and_title_match_case_insensitively():
    assert blocklist.match_rule(track(), rule("artist", "neil DIAMOND"))
    assert blocklist.match_rule(track(), rule("title", "sweet"))


def test_keyword_looks_at_both_fields():
    assert blocklist.match_rule(track(), rule("keyword", "caroline"))
    assert blocklist.match_rule(track(), rule("keyword", "diamond"))
    assert not blocklist.match_rule(track(), rule("keyword", "polka"))


def test_spotify_id_is_exact_not_substring():
    assert blocklist.match_rule(track(), rule("spotify_id", "abc123"))
    assert not blocklist.match_rule(track(), rule("spotify_id", "abc"))


def test_inactive_and_empty_rules_never_match():
    assert not blocklist.match_rule(track(), rule("title", "sweet", active=False))
    assert not blocklist.match_rule(track(), rule("title", "   "))


def test_check_returns_the_matching_rule_or_none():
    rules = [rule("artist", "abba"), rule("title", "caroline")]
    hit = blocklist.check(track(), rules)
    assert hit is not None and hit["pattern"] == "caroline"
    assert blocklist.check(track(title="Dancing Queen", artist="Queen"), rules) is None


def test_explicit_switch_blocks_without_a_rule(monkeypatch):
    monkeypatch.setattr(config, "BLOCK_EXPLICIT", True)
    assert blocklist.check(track(explicit=True), [])["kind"] == "explicit"
    assert blocklist.check(track(explicit=False), []) is None
