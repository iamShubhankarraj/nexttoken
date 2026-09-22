/**
 * loginDetectScript.ts — injected into each tab guest on dom-ready
 * (same mechanism as caretScript.ts: webview.executeJavaScript, no guest
 * preload file required). Reports through prefixed console messages,
 * which TabView.tsx routes to window CustomEvents.
 *
 * What it does:
 *  - "form-present": once per page, when a visible password field appears
 *    (MutationObserver covers SPA-injected forms), so the shell can offer
 *    autofill for saved logins.
 *  - "form-submit": when a form containing a password field is submitted,
 *    it stashes the credentials on window.__ntLoginCapture and reports
 *    {origin, username} (NO password — main reads the stash directly from
 *    the guest WebContents, so the password never flows through the
 *    console-message channel).
 *
 * The script self-guards against double-install on the same document.
 */

export const LOGIN_REPORT_PREFIX = "[NTLOGIN]";

/** Payload kinds the guest can report. */
export type LoginReportKind = "form-present" | "form-submit";

export interface LoginReport {
  kind: LoginReportKind;
  origin: string;
  username: string;
}

export const LOGIN_DETECT_SCRIPT = `(() => {
  if (window.__ntLoginDetect) return;
  window.__ntLoginDetect = true;
  const PREFIX = ${JSON.stringify(LOGIN_REPORT_PREFIX)};
  const report = (kind, username) => {
    try {
      console.log(PREFIX + JSON.stringify({ kind, origin: location.origin, username: username || "" }));
    } catch { /* never break the page */ }
  };
  const visible = (el) => {
    try {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
    } catch { return false; }
  };
  const passwordFields = () =>
    [...document.querySelectorAll('input[type="password"]')].filter(visible);

  // --- form-present -------------------------------------------------
  let reportedPresent = false;
  const checkPresent = () => {
    if (reportedPresent) return;
    if (passwordFields().length > 0) {
      reportedPresent = true;
      report("form-present", "");
    }
  };
  checkPresent();
  let moTimer = 0;
  const mo = new MutationObserver(() => {
    if (reportedPresent || moTimer) return;
    moTimer = setTimeout(() => { moTimer = 0; checkPresent(); }, 400);
  });
  if (document.documentElement) mo.observe(document.documentElement, { childList: true, subtree: true });

  // --- form-submit --------------------------------------------------
  const usernameFor = (form) => {
    const scope = form || document;
    const cand = [...scope.querySelectorAll('input[type="email"], input[type="text"], input:not([type])')]
      .filter(visible)
      .find((el) => /user|email|login|account/i.test(el.name + el.id + el.placeholder));
    const first = [...scope.querySelectorAll('input[type="email"], input[type="text"], input:not([type])')].filter(visible)[0];
    return (cand || first || { value: "" }).value || "";
  };
  const capture = (form) => {
    const pws = form ? [...form.querySelectorAll('input[type="password"]')].filter(visible) : passwordFields();
    if (pws.length === 0) return;
    const username = usernameFor(form).slice(0, 256);
    const password = (pws[0].value || "").slice(0, 1024);
    if (!password) return;
    // Stash lives on window; main reads it via executeJavaScript and
    // clears it immediately. It is never logged or reported.
    window.__ntLoginCapture = { origin: location.origin, username, password };
    report("form-submit", username);
  };
  document.addEventListener("submit", (ev) => {
    try { capture(ev.target instanceof HTMLFormElement ? ev.target : null); } catch { /* never break submit */ }
  }, true);
})();`;
