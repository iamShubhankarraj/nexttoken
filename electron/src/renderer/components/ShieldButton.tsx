/**
 * Shield indicator in the toolbar: shows the native ad blocker's live
 * per-tab blocked-request count and offers a per-site toggle.
 *
 * - Badge appears only when this page actually had requests blocked.
 * - Dimmed shield = blocking off globally or this site is allowlisted.
 * - Click opens a small popover: per-site toggle + blocked count.
 */

import { Shield, ShieldOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AdBlockState } from "../../shared/ipc";
import { useBrowser } from "../BrowserContext";
import { nt } from "../nt";

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function ShieldButton() {
  const { activeTab } = useBrowser();
  const [state, setState] = useState<AdBlockState>({
    enabled: true,
    allowedHosts: [],
  });
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    nt()
      .adblockGet()
      .then((s) => {
        if (alive) setState(s);
      })
      .catch(() => {});
    const off = nt().onAdBlockStats((s) =>
      setCounts((m) => ({ ...m, [s.tabId]: s.count })),
    );
    return () => {
      alive = false;
      off();
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open ]);

  const host = activeTab ? hostnameOf(activeTab.url) : "";
  const siteAllowed = !!host && state.allowedHosts.includes(host);
  const count = activeTab ? (counts[activeTab.id] ?? 0) : 0;
  const protecting = state.enabled && !siteAllowed && !!host;

  const toggleSite = () => {
    if (!host) return;
    // Flip the per-site allowlist entry; the shield re-renders from fresh state.
    void nt()
      .adblockSetSiteAllowed(host, siteAllowed)
      .then(setState)
      .catch(() => {});
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        title={
          protecting
            ? `Ad blocker on — ${count} blocked on this page. Click for site options.`
            : siteAllowed
              ? "Ads allowed on this site. Click to block them."
              : "Ad blocker off. Click for options."
        }
        onClick={() => setOpen((o) => !o)}
        className="nt-r-sm relative p-2 transition-colors hover:bg-[var(--nt-bg-hover)]"
        style={{ color: protecting ? "var(--nt-text-2)" : "var(--nt-text-3)" }}
      >
        {protecting ? (
          <Shield size={16} strokeWidth={1.75} />
        ) : (
          <ShieldOff size={16} strokeWidth={1.75} />
        )}
        {protecting && count > 0 && (
          <span
            className="nt-r-full absolute -right-0.5 -top-0.5 flex min-w-[16px] items-center justify-center px-1 text-[9px] font-bold leading-[16px]"
            style={{
              background: "var(--nt-accent)",
              color: "var(--nt-accent-text)",
            }}
          >
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>

      {open && !!host && (
        <div
          className="nt-popover nt-r-md absolute left-0 top-10 z-30 w-64 border p-3 shadow-xl"
          style={{
            background: "var(--nt-bg-overlay)",
            borderColor: "var(--nt-border)",
          }}
        >
          <p
            className="nt-mono mb-2 truncate text-[12px]"
            style={{ color: "var(--nt-text-1)" }}
          >
            {host}
          </p>
          <button
            onClick={toggleSite}
            className="nt-r-sm flex w-full items-center justify-between gap-3 px-2 py-1.5 text-left transition-colors hover:bg-[var(--nt-bg-hover)]"
          >
            <span
              className="text-[12px]"
              style={{ color: "var(--nt-text-2)" }}
            >
              {protecting ? "Blocking ads on this site" : "Allowing ads on this site"}
            </span>
            <span
              className="nt-r-full relative h-5 w-9 shrink-0 transition-colors"
              style={{
                background: protecting
                  ? "var(--nt-accent)"
                  : "var(--nt-border-strong)",
              }}
            >
              <span
                className="nt-r-full absolute top-0.5 h-4 w-4 bg-white transition-all"
                style={{ left: protecting ? "18px" : "2px" }}
              />
            </span>
          </button>
          <p
            className="mt-2 px-2 text-[11px]"
            style={{ color: "var(--nt-text-3)" }}
          >
            {count > 0
              ? `${count} ad/tracker request${count === 1 ? "" : "s"} blocked on this page.`
              : "No ad/tracker requests blocked on this page yet."}
          </p>
          {!state.enabled && (
            <p
              className="mt-1 px-2 text-[11px]"
              style={{ color: "var(--nt-text-3)" }}
            >
              Ad blocking is off globally — turn it on in Settings →
              Privacy.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
