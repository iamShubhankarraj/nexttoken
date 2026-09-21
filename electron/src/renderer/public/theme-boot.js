/* Next Token — pre-paint theme boot.
 *
 * Parser-blocking classic script (see index.html <head>): runs before
 * first paint so the chrome never flashes the wrong theme on relaunch.
 * Reads the CSS-vars mirror written by applyTokensToRoot() in theme.ts
 * (key "nt.theme.vars.mirror.v1" — keep in sync with THEME_MIRROR_KEY).
 * No modules, no imports, no framework — intentionally tiny.
 */
(function () {
  try {
    var raw = localStorage.getItem("nt.theme.vars.mirror.v1");
    if (!raw) return;
    var data = JSON.parse(raw);
    if (!data || typeof data.vars !== "object" || !data.vars) return;
    var root = document.documentElement;
    var vars = data.vars;
    for (var k in vars) {
      if (
        Object.prototype.hasOwnProperty.call(vars, k) &&
        typeof vars[k] === "string"
      ) {
        root.style.setProperty(k, vars[k]);
      }
    }
    if (data.colorScheme === "light" || data.colorScheme === "dark") {
      root.style.setProperty("color-scheme", data.colorScheme);
    }
  } catch (e) {
    /* corrupted mirror — fall back to the :root defaults in CSS */
  }
})();
