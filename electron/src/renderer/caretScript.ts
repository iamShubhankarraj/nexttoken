/**
 * Script injected into every webview guest (on dom-ready) to power the
 * writing-hint popup (Dia pattern: AI where the caret is).
 *
 * It reports focus/blur of editable elements back to the embedder via a
 * prefixed console message — the embedder listens for `console-message`
 * on the <webview> element, so no guest preload file is needed.
 */

export const CARET_HINT_PREFIX = "[nt-caret-hint]";

export const CARET_SCRIPT = `(() => {
  if (window.__ntCaretHint) return;
  window.__ntCaretHint = true;
  const send = (payload) => {
    try { console.log(${JSON.stringify(CARET_HINT_PREFIX)} + JSON.stringify(payload)); } catch {}
  };
  const describe = (el) => {
    if (!el || !el.getBoundingClientRect) return null;
    const editable =
      el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
    if (!editable) return null;
    if (el.tagName === "INPUT") {
      const t = (el.type || "text").toLowerCase();
      if (!["text", "search", "url", "email", "password"].includes(t)) return null;
    }
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    let text = "";
    try { text = (el.value !== undefined ? el.value : el.innerText) || ""; } catch {}
    return {
      tag: el.tagName.toLowerCase(),
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      text: String(text).slice(0, 240),
      placeholder: el.getAttribute ? (el.getAttribute("placeholder") || "") : "",
    };
  };
  document.addEventListener("focusin", (e) => {
    const d = describe(e.target);
    if (d) send({ type: "focus", ...d });
  });
  // Clicking an already-focused field should re-offer the hint.
  document.addEventListener("click", (e) => {
    const d = describe(e.target);
    if (d && document.activeElement === e.target) send({ type: "focus", ...d });
  });
  document.addEventListener("focusout", () => send({ type: "blur" }));
})();`;

export interface CaretHintDetail {
  tabId: string;
  tag: string;
  rect: { x: number; y: number; width: number; height: number };
  text: string;
  placeholder: string;
}
