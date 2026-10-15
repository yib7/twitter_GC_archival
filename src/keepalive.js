/* keepalive.js — presence for the double-click launcher.
 *
 * The launcher starts the local server with `--open`; that server shuts itself
 * down once the browser is closed, so closing the browser also closes the
 * stray command window. SP-6: a hidden tab's timers are throttled (Chromium:
 * about one a minute after 5 minutes) or frozen (sleeping tabs, a closed
 * laptop), so silence can't mean "closed". Instead each page:
 *   - pings GET /api/ping?c=<its own id> now and every 15 s while it can;
 *   - says goodbye with a beacon (POST /api/bye?c=<id>) when it is closed or
 *     navigated away from — the server exits a few seconds after the LAST
 *     open page said goodbye (a reload pings again well within that);
 *   - re-pings as soon as it is shown again, and if the server is gone shows
 *     a banner saying so (and how to restart it) instead of a later
 *     "Failed to fetch".
 * A no-op over file:// (nothing to talk to) and harmless against a manually
 * started server (which ignores presence). */
(function () {
  if (location.protocol !== "http:" && location.protocol !== "https:") return;
  var id = (Date.now().toString(36) + Math.random().toString(36).slice(2, 12)).replace(/[^A-Za-z0-9]/g, "");
  var banner = null;

  function showDown(down) {
    if (!down) { if (banner) banner.hidden = true; return; }
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "gca-server-down";
      banner.className = "gca-server-down";
      banner.setAttribute("role", "alert");
      banner.textContent = "The local server has stopped, so changes can't be saved and media may not load. " +
        "Run start-setup again (or node scripts/server.js), then reload this page.";
      (document.body || document.documentElement).appendChild(banner);
    }
    banner.hidden = false;
  }
  function ping() {
    try {
      fetch("/api/ping?c=" + id, { cache: "no-store" })
        .then(function (r) { showDown(!r.ok); }, function () { showDown(true); });
    } catch (e) { /* very old browser: nothing to do */ }
  }
  function bye() {
    try {
      if (navigator.sendBeacon) navigator.sendBeacon("/api/bye?c=" + id);
      else fetch("/api/bye?c=" + id, { method: "POST", keepalive: true }).catch(function () {});
    } catch (e) { /* closing anyway */ }
  }

  ping();
  setInterval(ping, 15000);
  document.addEventListener("visibilitychange", function () { if (document.visibilityState !== "hidden") ping(); });
  window.addEventListener("pageshow", function (e) { if (e.persisted) ping(); });   // back from the bfcache
  window.addEventListener("pagehide", bye);
}());
