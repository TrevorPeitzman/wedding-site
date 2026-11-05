# Rehearsal and the night: runbook

One page to work from in rehearsal week (Nov 17–20) and on the night. Links
assume the organizer key is in your browser already (`/admin/#key=…` once).

| What | Where |
| --- | --- |
| Organizer screen: switches, times, camera counts, rehearsal tools | https://wedding.peitzman.net/admin/ |
| DJ view | https://wedding.peitzman.net/dj/#key=<DJ key> (send the DJ this link) |
| Guest landing page (what the QR opens) | https://wedding.peitzman.net/p/?pass=<token> |
| Supabase dashboard | https://supabase.com/dashboard/project/pzmeppjcvsjkneducqvd |
| Rehearse a moment of the night | add `?now=2026-11-21T18:10` to any page URL (Pacific time) |

---

## Rehearsal week

### 1. Test passes

In `/admin/` → **Rehearsal** → **Make 3 test passes**. Each one has a link:
open it on a phone (or show it on a laptop and scan it as a QR from another
phone). Test passes behave like real ones, but **Reset shots** gives them
their 12 back and their photos never reach the gallery.

Don't rehearse with a real guest's pass: its shots would be used up.

### 2. Phone checklist

Do each on **an iPhone (Safari)** and **an Android phone (Chrome)**, ideally
in a dim room on the venue's wifi and again on cellular.

- [ ] Scan a test pass: `/p/` greets "Test", shows the boarding pass, and the
      address bar loses `?pass=`.
- [ ] Wallet (once passes are made): the right button for the phone; Apple's
      opens the Add to Wallet sheet; the pass shows the gate, table and barcode.
- [ ] Camera: take a shot; it reaches **Uploaded**; the count drops.
- [ ] Camera, airplane mode: take a shot; it says **Saved on this phone**; turn
      airplane mode off; it uploads without touching anything.
- [ ] Camera, close the page mid-upload, reopen it: the shot is still there
      and uploads.
- [ ] Camera, if the phone asks for camera access, tap Don't Allow once:
      no shot is taken or counted, and tapping the shutter again lets you
      allow it. (Note what each phone does; it's the most likely guest
      question.)
- [ ] Camera, lock the screen during an upload, unlock: it finishes.
- [ ] Song board: search finds a real song; request it; it shows your test
      name; its title opens Spotify; vote on another; the cooldown message
      appears on a second vote.
- [ ] DJ view on the DJ's own device: the request appears; mark it Played.
- [ ] Night theme: from 5:00 PM (`?now=2026-11-21T17:10`) pages are dark.
- [ ] Every timed release you set, with `?now=` just before and just after.

### 3. Load test

Two runs from a laptop, each once, deliberately, during rehearsal week (not
within an hour of the event: each simulated phone in the second run uses one
of the 300 anonymous sign-ins Supabase allows per IP address per hour).

**a. Everyone reading the board** (read-only, writes nothing):

```bash
node scripts/load_test.mjs --phones 105 --minutes 3
```

**b. The night** (60 guests at once doing everything: sign in, claim a test
pass, open the pass card, read the board, search Spotify, request, vote, take
600 KB photos). First open Song requests and Camera in `/admin/`. It uses the
10 test passes (made if missing) and cleans up after itself with `--cleanup`
(test passes, their photos, their song requests and votes):

```bash
node scripts/load_test.mjs --night --key '<organizer key>' --phones 60 --minutes 5 --cleanup
```

Healthy: **no ERRORS**, and p95 well under a second for the database steps
(`song_board`, `vote`, `claim_pass`, `confirm_shot`) and under a few seconds
for `search`, `reserve` and `upload` (those go to Spotify or carry a photo,
and depend on your own upload speed). Refusals are the app saying no and are
fine in moderation: `vote_cooldown`, `already_voted`, `out_of_shots` late in
the run (10 test passes × 12 shots). `feature_soon`/`feature_closed` mean a
feature wasn't open. If you see `HTTP 429`, `HTTP 5xx` or timeouts, tell the
build session before the night. Try `--phones 105` too if the first run is
clean.

What this can't test is the venue's wifi and signal: that's the
walk-through below, with real phones.

### 4. Venue walk-through

- [ ] Wifi and cellular signal in the Terrace Room, Finery Bar & Lounge and
      Uptown Ballroom: open `/songs/` and take a camera shot in each.
- [ ] Print a test QR at the real size and scan it in the room's lighting.

---

## The day before

- [ ] `/admin/` → set the night's schedule (for example: camera and Wallet
      open at cocktail hour, songs closing when the DJ says or at a set time,
      photos out 24 hours after).
- [ ] **Delete test passes and their photos** (Rehearsal card).
- [ ] **Clear the song board** (type CLEAR), unless you want early requests kept.
- [ ] DJ view: delete the two example do-not-play rules; add real ones; set
      cooldowns and songs per guest; send the DJ his link.
- [ ] Check the fallback in `site/assets/features.js` matches the schedule
      (it's what pages use if Supabase is unreachable).
- [ ] Supabase is on **Pro** (no pausing, daily backups, enough storage).

---

## On the night

**Who watches what:** one person (not the couple) keeps `/admin/` open for
camera counts (Photos → **Show photos** to see them come in, with who took
each one); the DJ keeps the DJ view open.

| If… | Then… |
| --- | --- |
| A guest's camera says "Saved on this phone" for a long time | It's waiting for signal; it uploads on its own. Ask them to keep the page open. |
| A guest scanned someone else's pass | Their phone now shares that pass's 12 shots and name. Give them their own QR to scan; the latest scan wins. |
| A guest lost their paper pass | They can still use the song board without one; the camera needs a pass (look up their token in `private/print-merge-with-qr.csv`). |
| Requests get rowdy | DJ view: hide a song, block an artist, or switch off "Guests can request". |
| You want requests closed | DJ view switch, or `/admin/` → Song requests → Closes. |
| A guest used their shots and wants more | `/admin/` → Camera → Shots by guest → find them → **Reset shots**. Their photos stay. |
| A photo shouldn't be in the gallery | `/admin/` → Photos → **Hide** on it. It still counts as one of that pass's shots; **Show** puts it back. |
| Something is wrong with a feature | `/admin/` → switch it off; pages drop it on their next load. |
| Supabase is down | The schedule, details and landing pages still work (static). Songs and camera show an error; shots stay saved on phones and upload later. Check https://status.supabase.com. |

---

## After

- [ ] Next day: DJ view → **Download .csv** and **Spotify URIs** (setlist).
- [ ] Export every photo: `/admin/` → Photos → **Download all** on a laptop
      (.zip files of 100, named by table, guest and time; hidden ones
      included, and a table filter narrows it). Or Supabase → Storage →
      `photos`, or `supabase storage cp -r ss:///photos ./photos-export --experimental --linked`.
- [ ] Photos come out on schedule, or `/admin/` → **Release photos now**.
      Guests save from `/photos/`: **Select** some (up to 10 go straight to
      a phone's photos through the share sheet) or **Save all** (.zip files).
- [ ] After the gallery has been up a while and everything is downloaded:
      downgrade Supabase from Pro.
