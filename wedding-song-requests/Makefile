.PHONY: up down logs init seed demo dev test smoke secret

# --- Docker (recommended) ---
up:            ## build + start db and web (http://localhost:8000)
	docker compose up --build

down:          ## stop and remove containers
	docker compose down

logs:
	docker compose logs -f web

# --- Local (virtualenv) ---
init:          ## apply the schema to the DB named by env/.env
	python scripts/init_db.py

seed:          ## create the event row + starter block rules
	python scripts/seed.py

demo:          ## seed + a board full of fake requests and votes
	python scripts/seed.py --demo

dev:           ## run the web server locally with autoreload
	uvicorn app.main:app --reload --port 8000

test:          ## unit + DB-backed tests (DB tests skip if no Postgres)
	pytest -q

smoke:         ## end-to-end check against the configured database
	python scripts/smoke.py

secret:        ## generate a SECRET_KEY for .env
	@python -c "import secrets; print(secrets.token_urlsafe(32))"
