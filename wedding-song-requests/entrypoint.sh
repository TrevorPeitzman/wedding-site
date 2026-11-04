#!/usr/bin/env bash
# Web container entrypoint: wait for the DB, apply the schema, seed, then serve.
set -euo pipefail

echo "[entrypoint] applying schema..."
python scripts/init_db.py

echo "[entrypoint] seeding event..."
python scripts/seed.py ${SEED_DEMO:+--demo}

echo "[entrypoint] starting web server on :8000"
exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips='*'
