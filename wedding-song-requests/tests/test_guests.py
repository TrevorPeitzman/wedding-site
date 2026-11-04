import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import guests


def test_roundtrip():
    token = guests.new_token()
    assert guests.unsign(guests.sign(token)) == token


def test_tampered_cookie_is_rejected():
    signed = guests.sign("guest-one")
    assert guests.unsign(signed + "x") is None
    assert guests.unsign("guest-two") is None


def test_tokens_are_unique():
    assert len({guests.new_token() for _ in range(200)}) == 200
