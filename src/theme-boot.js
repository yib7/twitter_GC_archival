/* Apply the saved theme before first paint to avoid a flash-of-wrong-theme.
   gca.theme is the single source of truth (default "lightsout"); app.js's theme
   module reconciles the theme toggles + Settings and persists here. The
   theme-color meta follows the theme's page background (UX-6). Kept as a
   same-origin file (not an inline <script>) so the served-mode CSP can stay a
   clean `script-src 'self'` with no per-file hash to keep in sync. A classic
   <script src> in <head> is still render-blocking, so it runs before paint. */
(function () {
  try {
    var t = localStorage.getItem("gca.theme");
    var bg = { light: "#ffffff", dim: "#15202b", lightsout: "#000000" };
    if (t === "light" || t === "dim" || t === "lightsout") {
      document.documentElement.setAttribute("data-theme", t);
      var m = document.querySelector('meta[name="theme-color"]');
      if (m) m.setAttribute("content", bg[t]);
    }
  } catch (e) {}
})();
