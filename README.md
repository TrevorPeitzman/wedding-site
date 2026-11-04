# wedding-site

Guest web app for Katarina & Trevor's vow renewal, 21 November 2026.

- `site/`: static event pages (home, schedule, details) on the K&T design system.
  Preview with `python3 -m http.server 8000 -d site`.
- `wedding-song-requests/`: song request board and DJ view (FastAPI + Postgres).

The plan, the design rules and the open questions are in [CLAUDE.md](CLAUDE.md).
