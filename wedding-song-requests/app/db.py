"""Thin psycopg2 helpers, connect-per-request.

Wedding-night traffic is a few hundred guests refreshing a leaderboard; a
connection pool would be premature. Kept deliberately inspectable.
"""
import contextlib

import psycopg2
import psycopg2.extras

from app import config


@contextlib.contextmanager
def get_conn():
    conn = psycopg2.connect(config.DATABASE_URL)
    try:
        yield conn
    finally:
        conn.close()


@contextlib.contextmanager
def get_cursor(commit: bool = False):
    """Yield a dict-returning cursor. Commits on clean exit when commit=True."""
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        try:
            yield cur
            if commit:
                conn.commit()
        finally:
            cur.close()
