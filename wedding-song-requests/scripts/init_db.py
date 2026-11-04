"""Wait for Postgres to accept connections, then apply db/schema.sql.

Idempotent: the schema is all CREATE ... IF NOT EXISTS, so this is safe to run
on every container start.
"""
import sys
import time
from pathlib import Path

import psycopg2

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config  # noqa: E402

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "db" / "schema.sql"


def wait_for_db(max_attempts: int = 30, delay: float = 1.0):
    for attempt in range(1, max_attempts + 1):
        try:
            psycopg2.connect(config.DATABASE_URL).close()
            print(f"[init_db] database reachable (attempt {attempt})")
            return
        except psycopg2.OperationalError as exc:
            print(f"[init_db] waiting for database ({attempt}/{max_attempts}): {exc}")
            time.sleep(delay)
    raise SystemExit("[init_db] database never became reachable")


def apply_schema():
    conn = psycopg2.connect(config.DATABASE_URL)
    try:
        with conn, conn.cursor() as cur:
            cur.execute(SCHEMA_PATH.read_text())
        print(f"[init_db] applied {SCHEMA_PATH.name}")
    finally:
        conn.close()


if __name__ == "__main__":
    wait_for_db()
    apply_schema()
