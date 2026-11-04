# wedding-site

Guest web app for Katarina & Trevor's vow renewal, 21 November 2026.

- `site/`: static event pages (home, schedule, details) on the K&T design system.
  Preview with `python3 -m http.server 8000 -d site`.
- `site/songs/`: song request board and DJ view (demo mode until Supabase is configured).
- `supabase/`: the backend: database rules, the Spotify function and SQL tests. Setup is in `supabase/README.md`.
- `wedding-song-requests/`: the original FastAPI prototype, kept for reference.

The plan, the design rules and the open questions are in [CLAUDE.md](CLAUDE.md).
