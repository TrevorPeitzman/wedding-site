# wedding-site

Guest web app for Katarina & Trevor's wedding, live at
[wedding.peitzman.net](https://wedding.peitzman.net).

| Path | What it is |
| --- | --- |
| `site/` | Static pages on the K&T design system, served by GitHub Pages: home, schedule, details |
| `site/songs/`, `site/songs/dj/` | Song requests and the DJ view (shortcut: `/dj/`) |
| `site/camera/`, `site/photos/` | The disposable camera and, after the reveal, everyone's photos |
| `site/p/` | Where the QR on each boarding pass lands: the pass on screen and its Add to Wallet button |
| `site/admin/` | Organizer screen: feature switches and times, camera, photo reveal, every photo (hide, download), rehearsal |
| `supabase/` | The backend: database rules, Edge Functions, setup ([supabase/README.md](supabase/README.md)) |
| `scripts/import_passes.py` | Guest workbook → pass tokens, `passes.sql`, `passes.json`, print merge with QR links (output stays in git-ignored `private/`) |
| `scripts/make_wallet_passes.py` | One signed Apple Wallet pass per guest ([docs/wallet.md](docs/wallet.md)) |
| `tests/` | Database tests on a throwaway Postgres; Wallet pass generator tests |
| `docs/` | [Runbook](docs/runbook.md) (rehearsal and the night), [Song requests](docs/songs.md) (rules, Spotify setup, DJ questions), [Wallet account setup](docs/wallet.md) |
| `scripts/load_test.mjs` | Rehearsal load test: ~105 read-only phones on the song board |

Preview locally with `python3 -m http.server 8000 -d site`; add `?demo=1` to
a page for demo mode. Deploying: [DEPLOY.md](DEPLOY.md). The plan, the design
rules and the open questions: [CLAUDE.md](CLAUDE.md).
