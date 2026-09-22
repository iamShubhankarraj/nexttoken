/**
 * StartupNudge — the one-time default-browser toast (v0.6.3, impl-5).
 *
 * On first launch (and never again) when Next Token isn't the default
 * browser, shows a small toast offering "Make default". Dismissing never
 * nags — Settings → On startup always has the button.
 */
import { useEffect, useState } from "react";
import { Globe, X } from "lucide-react";
import { nt } from "../nt";

export function StartupNudge() {
  const [show, setShow] = useState(false);
  const [making, setMaking] = useState(false);

  useEffect(() => {
    // Give the window a beat to settle before asking anything.
    const t = window.setTimeout(() => {
      nt().startupNudge().then((r) => setShow(r.show)).catch(() => {});
    }, 4000);
    return () => window.clearTimeout(t);
  }, []);

  if (!show) return null;

  const makeDefault = () => {
    setMaking(true);
    void nt()
      .startupMakeDefaultBrowser()
      .then(() => setShow(false))
      .catch(() => setMaking(false));
  };

  return (
    <div className="nt-toast" role="status">
      <Globe size={15} strokeWidth={2} style={{ color: "var(--nt-accent)" }} />
      <span className="nt-toast-text">Make Next Token your default browser?</span>
      <button type="button" className="nt-toast-action" onClick={makeDefault} disabled={making}>
        {making ? "Working…" : "Make default"}
      </button>
      <button
        type="button"
        className="nt-toast-dismiss"
        onClick={() => setShow(false)}
        aria-label="Dismiss"
      >
        <X size={13} strokeWidth={2} />
      </button>
    </div>
  );
}
