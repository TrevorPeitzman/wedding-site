/* Guest board: debounced search, submit, upvote, and a polled refresh.
   Vanilla on purpose — the whole page is one file the DJ's phone can load on
   venue wifi, and there is no build step to forget about on deploy day. */
(function () {
  "use strict";

  var q = document.getElementById("q");
  var nameInput = document.getElementById("name");
  var results = document.getElementById("results");
  var searchMsg = document.getElementById("search-msg");
  var board = document.getElementById("board");
  var toastEl = document.getElementById("toast");

  var POLL_MS = 7000;
  var searchTimer = null;
  var toastTimer = null;
  var pollTimer = null;
  var busy = false;

  /* The name field is a convenience, not identity — the cookie is identity. */
  try {
    var saved = localStorage.getItem("wsr_name");
    if (saved && nameInput) nameInput.value = saved;
  } catch (e) { /* private mode: not worth caring about */ }

  function toast(message, isError) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.hidden = false;
    toastEl.style.background = isError ? "var(--danger)" : "var(--accent)";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, 4000);
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function post(url, body) {
    return fetch(url, { method: "POST", body: body, credentials: "same-origin" })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok || data.ok === false) {
            throw new Error(data.message || "Something went wrong. Try again?");
          }
          return data;
        });
      });
  }

  /* --- Search --------------------------------------------------------- */

  function renderResults(items) {
    if (!items.length) {
      results.hidden = true;
      searchMsg.textContent = "No matches. Check the spelling?";
      searchMsg.hidden = false;
      return;
    }
    searchMsg.hidden = true;
    results.innerHTML = items.map(function (t) {
      var art = t.artwork_url
        ? ' style="background-image:url(\'' + esc(t.artwork_url) + '\')"' : "";
      return '<li tabindex="0" role="button" data-spotify-id="' + esc(t.spotify_id) + '">' +
        '<span class="art"' + art + "></span>" +
        '<span class="meta"><span class="title">' + esc(t.title) + "</span><br>" +
        '<span class="artist">' + esc(t.artist) + "</span></span></li>";
    }).join("");
    results.hidden = false;
  }

  function runSearch() {
    var term = q.value.trim();
    if (term.length < 2) {
      results.hidden = true;
      searchMsg.hidden = true;
      return;
    }
    fetch("/api/search?q=" + encodeURIComponent(term), { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) throw new Error(data.message || "Search is unavailable.");
        renderResults(data.results || []);
      })
      .catch(function (err) {
        results.hidden = true;
        searchMsg.textContent = err.message;
        searchMsg.hidden = false;
      });
  }

  if (q) {
    q.addEventListener("input", function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(runSearch, 250);
    });
  }

  function submit(spotifyId) {
    if (busy) return;
    busy = true;
    var body = new FormData();
    body.append("spotify_id", spotifyId);
    if (nameInput && nameInput.value.trim()) {
      body.append("requester_name", nameInput.value.trim());
      try { localStorage.setItem("wsr_name", nameInput.value.trim()); } catch (e) {}
    }
    post("/api/requests", body)
      .then(function (data) {
        toast(data.action === "voted"
          ? "Already on the list — your vote's in!"
          : "Added. Now get everyone to upvote it.");
        q.value = "";
        results.hidden = true;
        refresh();
      })
      .catch(function (err) { toast(err.message, true); })
      .then(function () { busy = false; });
  }

  if (results) {
    results.addEventListener("click", function (ev) {
      var li = ev.target.closest("li[data-spotify-id]");
      if (li) submit(li.dataset.spotifyId);
    });
    results.addEventListener("keydown", function (ev) {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      var li = ev.target.closest("li[data-spotify-id]");
      if (li) { ev.preventDefault(); submit(li.dataset.spotifyId); }
    });
  }

  /* --- Voting --------------------------------------------------------- */

  board.addEventListener("click", function (ev) {
    var button = ev.target.closest("button.vote");
    if (!button || button.disabled || busy) return;
    busy = true;
    // Optimistic: the tap should feel instant even on venue wifi. A failure
    // re-renders from the server, which puts the number back.
    var count = button.querySelector(".count");
    count.textContent = String(Number(count.textContent) + 1);
    button.classList.add("voted", "bump");
    button.disabled = true;

    post("/api/requests/" + button.dataset.id + "/vote", new FormData())
      .then(function () { toast("Vote counted."); })
      .catch(function (err) { toast(err.message, true); })
      .then(function () { busy = false; refresh(); });
  });

  /* --- Polled refresh ------------------------------------------------- */

  function rowHtml(r) {
    var art = r.artwork_url
      ? ' style="background-image:url(\'' + esc(r.artwork_url) + '\')"' : "";
    var played = r.status === "played";
    var disabled = r.voted || played || !window.__votingOpen;
    return '<li class="row' + (played ? " played" : "") + '" data-id="' + r.id + '">' +
      '<div class="art"' + art + "></div>" +
      '<div class="meta"><p class="title">' + esc(r.title) + "</p>" +
      '<p class="artist">' + esc(r.artist) + "</p>" +
      (r.requester_name ? '<p class="by">asked for by ' + esc(r.requester_name) + "</p>" : "") +
      (played ? '<p class="by">played ✓</p>' : "") + "</div>" +
      '<button class="vote' + (r.voted ? " voted" : "") + '" data-id="' + r.id + '"' +
      (disabled ? " disabled" : "") + ' aria-label="Upvote ' + esc(r.title) + '">' +
      '<span class="chev">▲</span><span class="count">' + r.votes + "</span></button></li>";
  }

  function refresh() {
    return fetch("/api/requests", { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) return;
        window.__votingOpen = data.voting_open;
        board.innerHTML = data.requests.length
          ? data.requests.map(rowHtml).join("")
          : '<li class="empty">Nothing yet — be the first.</li>';
      })
      .catch(function () { /* transient wifi; the next tick will catch up */ });
  }

  window.__votingOpen = true;

  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(function () {
      // Don't refresh mid-tap, and don't poll a screen nobody is looking at.
      if (!busy && !document.hidden) refresh();
    }, POLL_MS);
  }

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) refresh();
  });

  startPolling();
})();
