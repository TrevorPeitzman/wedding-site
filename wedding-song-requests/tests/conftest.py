"""Pytest fixtures.

Creates a throwaway database (``<db>_selftest``), applies the schema, and points
the app's connection helper at it. If no Postgres is reachable the DB-backed
tests are skipped, so ``pytest`` still works anywhere (the pure-logic tests
cover the blocklist, cookies and search on their own).
"""
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

try:
    import psycopg2
    import psycopg2.extras
    from psycopg2.extensions import ISOLATION_LEVEL_AUTOCOMMIT
except ImportError:  # pragma: no cover
    psycopg2 = None

SCHEMA = (ROOT / "db" / "schema.sql").read_text()


@pytest.fixture(scope="session")
def selftest_dsn():
    if psycopg2 is None:
        pytest.skip("psycopg2 not installed")
    host = os.environ.get("PGHOST", "localhost")
    port = os.environ.get("PGPORT", "5432")
    user = os.environ.get("PGUSER", "wedding")
    password = os.environ.get("PGPASSWORD", "wedding")
    admin_db = os.environ.get("PGDATABASE", "wedding_songs")
    test_db = f"{admin_db}_selftest"

    try:
        admin = psycopg2.connect(host=host, port=port, user=user, password=password,
                                 dbname=admin_db, connect_timeout=3)
    except psycopg2.OperationalError as exc:
        pytest.skip(f"no reachable Postgres for DB tests: {exc}")

    admin.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
    with admin.cursor() as cur:
        cur.execute(f'DROP DATABASE IF EXISTS "{test_db}";')
        cur.execute(f'CREATE DATABASE "{test_db}";')

    dsn = f"postgresql://{user}:{password}@{host}:{port}/{test_db}"
    conn = psycopg2.connect(dsn)
    with conn, conn.cursor() as cur:
        cur.execute(SCHEMA)
    conn.close()

    from app import config
    config.DATABASE_URL = dsn  # app.db reads this at connect time

    yield dsn

    with admin.cursor() as cur:
        cur.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                    "WHERE datname = %s AND pid <> pg_backend_pid();", (test_db,))
        cur.execute(f'DROP DATABASE IF EXISTS "{test_db}";')
    admin.close()


@pytest.fixture
def event(selftest_dsn):
    """A clean event with permissive limits. Cooldowns are opt-in per test so
    the common path isn't fighting a timer."""
    from app import service
    with psycopg2.connect(selftest_dsn) as conn, conn.cursor() as cur:
        cur.execute("TRUNCATE votes, song_requests, played_tracks, tracks, "
                    "guests, block_rules, events RESTART IDENTITY CASCADE;")
    row = service.ensure_event()
    service.update_event(row["id"], vote_cooldown_seconds=0,
                         request_cooldown_seconds=0, max_requests_per_guest=50)
    return service.ensure_event()


@pytest.fixture
def guest(event):
    from app import service
    service.touch_guest("guest-a", "Guest A")
    return "guest-a"
