# wedding-site

Guest web app for Katarina & Trevor's wedding, live at
[wedding.peitzman.net](https://wedding.peitzman.net).

| Path | What it is |
| --- | --- |
| `site/` | Static pages on the K&T design system, served by GitHub Pages: home, schedule, details |
| `site/songs/`, `site/songs/dj/` | Song requests and the DJ view |
| `site/camera/`, `site/photos/` | The disposable camera and, after the reveal, everyone's photos |
| `site/p/` | Where the QR on each boarding pass lands |
| `site/admin/` | Organizer screen: feature switches and times, camera, photo reveal |
| `supabase/` | The backend: database rules, Edge Functions, setup ([supabase/README.md](supabase/README.md)) |
| `scripts/import_passes.py` | Guest workbook → pass tokens, `passes.sql`, print merge with QR links (output stays in git-ignored `private/`) |
| `tests/sql/` | Database tests on a throwaway Postgres |
| `wedding-song-requests/` | The original FastAPI prototype, superseded |

Preview locally with `python3 -m http.server 8000 -d site`; add `?demo=1` to
a page for demo mode. Deploying: [DEPLOY.md](DEPLOY.md). The plan, the design
rules and the open questions: [CLAUDE.md](CLAUDE.md).
