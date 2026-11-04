"""FastAPI app: guest-facing song request board, DJ view, setlist export.

Route groups:
  /            public board (search, request, upvote)
  /api/*       JSON the board polls and posts to
  /admin       DJ view, gated by ADMIN_TOKEN
  /setlist*    end-of-night export (HTML, text, CSV, Spotify URIs)
"""
import csv
import io
from pathlib import Path

from fastapi import Depends, FastAPI, Form, HTTPException, Query, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app import blocklist, config, guests, service, spotify
from app.service import ActionError

BASE_DIR = Path(__file__).resolve().parent
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))

app = FastAPI(title="Wedding Song Requests", version="0.1.0")
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")


def duration(ms: int | None) -> str:
    if not ms:
        return ""
    total = round(ms / 1000)
    return f"{total // 60}:{total % 60:02d}"


templates.env.filters["duration"] = duration


def _maybe_int(value: str) -> int | None:
    """Blank admin form fields mean 'leave this setting alone'."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


# --- Request-scoped helpers ---------------------------------------------

@app.middleware("http")
async def guest_cookie(request: Request, call_next):
    """Attach a guest token to every request and (re)issue the cookie.

    Doing this in middleware rather than per-route means the cookie is set on
    whatever response the route builds, including template and redirect
    responses, without any header juggling.
    """
    token = guests.read_cookie(request)
    is_new = token is None
    request.state.guest_token = token or guests.new_token()
    response = await call_next(request)
    # Renew on page loads so an early visitor's cookie outlives the engagement;
    # the polling endpoint doesn't need a Set-Cookie on every tick.
    if is_new or request.url.path in ("/", "/setlist"):
        guests.set_cookie(response, request.state.guest_token)
    return response


def current_guest(request: Request) -> str:
    """This browser's guest token, recorded as active."""
    token = request.state.guest_token
    service.touch_guest(token)
    return token


def require_admin(request: Request) -> bool:
    """Admin gate. The token may arrive as ?token= (first visit, then stored in
    a cookie) or in the admin cookie on later visits."""
    if not config.ADMIN_TOKEN:
        raise HTTPException(status_code=404, detail="Admin view is not enabled")
    supplied = request.query_params.get("token") or request.cookies.get("wsr_admin")
    if supplied != config.ADMIN_TOKEN:
        raise HTTPException(status_code=403, detail="Bad or missing admin token")
    return True


@app.exception_handler(ActionError)
def action_error_handler(request: Request, exc: ActionError):
    return JSONResponse(
        status_code=429 if exc.retry_after else 400,
        content={"ok": False, "code": exc.code, "message": exc.message,
                 "retry_after": exc.retry_after},
    )


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


# --- Public board --------------------------------------------------------

@app.get("/", response_class=HTMLResponse)
def board(request: Request):
    event = service.ensure_event()
    token = current_guest(request)
    rows = service.leaderboard(event["id"], token)
    return templates.TemplateResponse(
        request, "board.html",
        {"event": event, "requests": rows,
         "spotify_live": config.SPOTIFY_CONFIGURED and not config.SPOTIFY_OFFLINE},
    )


@app.get("/api/requests")
def api_requests(request: Request):
    event = service.ensure_event()
    token = current_guest(request)
    rows = service.leaderboard(event["id"], token)
    payload = {
        "ok": True,
        "requests_open": event["requests_open"],
        "voting_open": event["voting_open"],
        "vote_cooldown_remaining": service.vote_cooldown_remaining(
            token, event["vote_cooldown_seconds"]),
        "requests": [_public_row(r) for r in rows],
    }
    return JSONResponse(payload)


def _public_row(row: dict) -> dict:
    return {
        "id": row["id"],
        "title": row["title"],
        "artist": row["artist"],
        "album": row["album"],
        "artwork_url": row["artwork_url"],
        "duration_ms": row["duration_ms"],
        "votes": row["votes"],
        "voted": row["voted"],
        "status": row["status"],
        "requester_name": row["requester_name"],
    }


@app.get("/api/search")
def api_search(q: str = Query("", min_length=0, max_length=200), limit: int = 8):
    try:
        results = spotify.search_tracks(q, limit=max(1, min(limit, 20)))
    except spotify.SpotifyError as exc:
        return JSONResponse(status_code=503,
                            content={"ok": False, "code": "search_unavailable",
                                     "message": "Song search is having a moment. "
                                                "Try again in a second.",
                                     "detail": str(exc)})
    # Pre-filter blocked songs so a guest never picks one only to be refused.
    rules = service.list_block_rules()
    allowed = [t for t in results if blocklist.check(t, rules) is None]
    return {"ok": True, "results": allowed}


@app.post("/api/requests")
def api_submit(request: Request,
               spotify_id: str = Form(""), title: str = Form(""),
               artist: str = Form(""), requester_name: str = Form("")):
    event = service.ensure_event()
    token = current_guest(request)

    if spotify_id:
        track = spotify.get_track(spotify_id.strip())
        if not track:
            raise ActionError("unknown_track", "Couldn't find that song — try searching again.")
    else:
        if not title.strip() or not artist.strip():
            raise ActionError("incomplete_track", "Give both a song title and an artist.")
        track = {"spotify_id": None, "title": title.strip(), "artist": artist.strip(),
                 "album": None, "artwork_url": None, "duration_ms": None,
                 "explicit": False, "preview_url": None}

    blocked = blocklist.check(track, service.list_block_rules())
    if blocked:
        raise ActionError("blocked", blocked.get("reason")
                          or "That one's on the do-not-play list. Pick another!")

    if requester_name.strip():
        service.touch_guest(token, requester_name.strip()[:60])

    return {"ok": True, **service.submit_request(event, track, token, requester_name)}


@app.post("/api/requests/{request_id}/vote")
def api_vote(request_id: int, request: Request):
    event = service.ensure_event()
    token = current_guest(request)
    return {"ok": True, **service.vote(event, request_id, token)}


# --- DJ / admin ----------------------------------------------------------

@app.get("/admin", response_class=HTMLResponse)
def admin(request: Request, _: bool = Depends(require_admin)):
    event = service.ensure_event()
    rows = service.leaderboard(event["id"], include_hidden=True)
    resp = templates.TemplateResponse(
        request, "admin.html",
        {"event": event, "requests": rows,
         "rules": service.list_block_rules(active_only=False)},
    )
    if request.query_params.get("token"):
        # Stash the token so later admin requests don't need it in the URL.
        resp.set_cookie("wsr_admin", config.ADMIN_TOKEN, httponly=True,
                        samesite="lax", secure=config.COOKIE_SECURE, path="/")
    return resp


@app.post("/admin/requests/{request_id}/status")
def admin_set_status(request_id: int, request: Request, status: str = Form(...),
                     _: bool = Depends(require_admin)):
    event = service.ensure_event()
    service.set_status(event["id"], request_id, status)
    return RedirectResponse("/admin", status_code=303)


@app.post("/admin/event")
def admin_event(request: Request, requests_open: str = Form("off"),
                voting_open: str = Form("off"), vote_cooldown_seconds: str = Form(""),
                request_cooldown_seconds: str = Form(""),
                max_requests_per_guest: str = Form(""),
                _: bool = Depends(require_admin)):
    event = service.ensure_event()
    service.update_event(
        event["id"],
        requests_open=requests_open == "on",
        voting_open=voting_open == "on",
        vote_cooldown_seconds=_maybe_int(vote_cooldown_seconds),
        request_cooldown_seconds=_maybe_int(request_cooldown_seconds),
        max_requests_per_guest=_maybe_int(max_requests_per_guest),
    )
    return RedirectResponse("/admin", status_code=303)


@app.post("/admin/blocklist")
def admin_add_block(request: Request, kind: str = Form(...), pattern: str = Form(...),
                    reason: str = Form(""), hide_request_id: str = Form(""),
                    _: bool = Depends(require_admin)):
    service.add_block_rule(kind, pattern, reason)
    hide_request_id = _maybe_int(hide_request_id)
    if hide_request_id:
        # Blocking from a row on the board also pulls that row down.
        event = service.ensure_event()
        service.set_status(event["id"], hide_request_id, "hidden")
    return RedirectResponse("/admin", status_code=303)


@app.post("/admin/blocklist/{rule_id}/delete")
def admin_delete_block(rule_id: int, request: Request, _: bool = Depends(require_admin)):
    service.delete_block_rule(rule_id)
    return RedirectResponse("/admin", status_code=303)


# --- Setlist export ------------------------------------------------------

@app.get("/setlist", response_class=HTMLResponse)
def setlist_view(request: Request):
    event = service.ensure_event()
    return templates.TemplateResponse(
        request, "setlist.html",
        {"event": event, "setlist": service.setlist(event["id"])},
    )


def _export_rows(event_id: int) -> list[dict]:
    data = service.setlist(event_id)
    return data["played"] + data["requested"]


@app.get("/setlist.txt", response_class=PlainTextResponse)
def setlist_txt():
    event = service.ensure_event()
    lines = [f"{r['artist']} - {r['title']}" for r in _export_rows(event["id"])]
    return "\n".join(lines) + "\n"


@app.get("/setlist.uris", response_class=PlainTextResponse)
def setlist_uris():
    """Spotify URIs, one per line.

    Paste these into a playlist in the Spotify desktop app. The app's own token
    is app-only and cannot write to your account, so playlist creation is a
    copy-paste rather than an API call — see DESIGN.md.
    """
    event = service.ensure_event()
    uris = [f"spotify:track:{r['spotify_id']}" for r in _export_rows(event["id"])
            if r["spotify_id"]]
    return "\n".join(uris) + "\n"


@app.get("/setlist.csv")
def setlist_csv():
    event = service.ensure_event()
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["status", "played_at", "votes", "artist", "title", "album",
                     "requested_by", "spotify_id"])
    for r in _export_rows(event["id"]):
        writer.writerow([r["status"], r["played_at"] or "", r["votes"], r["artist"],
                         r["title"], r["album"] or "", r["requester_name"] or "",
                         r["spotify_id"] or ""])
    return Response(
        buf.getvalue(), media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{event["slug"]}-setlist.csv"'},
    )
