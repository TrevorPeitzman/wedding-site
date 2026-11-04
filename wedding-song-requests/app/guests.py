"""Guest identity: an opaque token carried in a signed cookie.

Why signed rather than a bare UUID: the signature stops a guest from editing
the cookie to a value that already exists (stealing another guest's vote
history) or from minting tokens by hand in a loop. It does NOT stop the
determined case — clearing cookies or opening a private window gets you a
fresh identity. That is a deliberate, accepted limit for a wedding crowd; see
DESIGN.md for what tightening it would cost.
"""
import uuid

from itsdangerous import BadSignature, URLSafeSerializer

from app import config

_serializer = URLSafeSerializer(config.SECRET_KEY, salt="guest-token")

COOKIE_MAX_AGE = config.COOKIE_MAX_AGE_DAYS * 24 * 60 * 60


def sign(token: str) -> str:
    return _serializer.dumps(token)


def unsign(value: str) -> str | None:
    """Return the token inside a cookie value, or None if it was tampered with
    (or was signed by a previous SECRET_KEY)."""
    try:
        token = _serializer.loads(value)
    except BadSignature:
        return None
    return token if isinstance(token, str) else None


def new_token() -> str:
    return uuid.uuid4().hex


def read_cookie(request) -> str | None:
    raw = request.cookies.get(config.COOKIE_NAME)
    return unsign(raw) if raw else None


def set_cookie(response, token: str) -> None:
    response.set_cookie(
        config.COOKIE_NAME,
        sign(token),
        max_age=COOKIE_MAX_AGE,
        httponly=True,       # no JS access; nothing in the page needs to read it
        samesite="lax",
        secure=config.COOKIE_SECURE,
        path="/",
    )
