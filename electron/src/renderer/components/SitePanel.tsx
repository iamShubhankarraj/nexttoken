/**
 * SitePanel — one cohesive per-site control center in the address bar.
 *
 * Merges the old ShieldButton (native ad blocker: live blocked count +
 * per-site toggle) with per-site permissions and site-data controls, in the
 * Brave-Shields pattern:
 *
 *   1. Connection — HTTPS / certificate health summary for this tab.
 *   2. Shields    — ads & trackers blocked on this page + per-site toggle.
 *   3. Permissions — per-site allow/ask/block for the 8 managed permission
 *      types (same backend as Settings → Privacy → Advanced).
 *   4. Site data  — cookies stored for this site + "clear site data"
 *      (two-step confirm; it signs the user out of the site).
 */

import {
  ChevronDown,
  Database,
  Lock,
  LockOpen,
  Shield,
  ShieldOff,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  AdBlockState,
  PrivacySnapshot,
  SiteConnectionInfo,
  SiteDataSummary,
} from "../../shared/ipc";
import { useBrowser } from "../BrowserContext";
import { nt } from "../nt";

const PERMISSIONS: { id: string; label: string }[] = [
  { id: "camera", label: "Camera" },
  { id: "microphone", label: "Microphone" },
  { id: "location", label: "Location" },
  { id: "notifications", label: "Notifications" },
  { id: "popups", label: "Popups" },
  { id: "autoplay", label: "Autoplay" },
  { id: "clipboard", label: "Clipboard" },
  { id: "screen-capture", label: "Screen capture" },
];

type Tri = "allow" | "ask" | "block";

const INITIAL_AB: AdBlockState = {
  enabled: true,
  allowedHosts: [],
  ready: false,
  ruleCount: 0,
  listsLoaded: 0,
  listsTotal: 0,
  lastUpdatedMs: null,
  failedLists: [],
  resourcesDegraded: false,
};

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="nt-micro px-2 pb-1 pt-2"
      style={{ color: "var(--nt-text-faint)" }}
    >
      {children}
    </p>
  );
}

/** Compact allow/ask/block segmented control. */
function TriSegment({
  value,
  onChange,
  ariaLabel,
  options = ["allow", "ask", "block"],
}: {
  value: Tri;
  onChange: (v: Tri) => void;
  ariaLabel: string;
  options?: Tri[];
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="nt-r-full flex shrink-0 border p-0.5"
      style={{ borderColor: "var(--nt-border)" }}
    >
      {options.map((o) => (
        <button
          key={o}
          role="radio"
          aria-checked={value === o}
          title={o[0].toUpperCase() + o.slice(1)}
          onClick={() => onChange(o as Tri)}
          className="nt-r-full px-2 py-0.5 text-[10.5px] font-medium capitalize transition-colors"
          style={{
            color: value === o ? "#1c1512" : "var(--nt-text-3)",
            background: value === o ? "var(--nt-accent)" : "transparent",
          }}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

export function SitePanel() {
  const { activeTab } = useBrowser();
  const [open, setOpen] = useState(false);
  const [ab, setAb] = useState<AdBlockState>(INITIAL_AB);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [info, setInfo] = useState<SiteConnectionInfo | null>(null);
  const [snap, setSnap] = useState<PrivacySnapshot | null>(null);
  const [sites, setSites] = useState<SiteDataSummary[]>([]);
  const [permsOpen, setPermsOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearMsg, setClearMsg] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);

  // Ad-block state + live per-tab counts (always live, like the old shield).
  useEffect(() => {
    let alive = true;
    nt()
      .adblockGet()
      .then((s) => {
        if (alive) setAb(s);
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

  const refresh = () => {
    nt().siteinfoGet().then(setInfo).catch(() => {});
    nt().privacySnapshot().then(setSnap).catch(() => {});
    nt().privacySites().then(setSites).catch(() => {});
    setConfirmClear(false);
    setClearMsg("");
  };

  useEffect(() => {
    if (!open) return;
    refresh();
  }, [open, activeTab?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open ]);

  const host = activeTab ? hostnameOf(activeTab.url) : "";
  const origin = info?.origin ?? (host ? `https://${host}` : "");
  const siteAllowed = !!host && ab.allowedHosts.includes(host);
  const count = activeTab ? (counts[activeTab.id] ?? 0) : 0;
  const protecting = ab.enabled && !siteAllowed && !!host;
  const loading = ab.enabled && !ab.ready;
  const cookieCount = host
    ? (sites.find((s) => s.site === host)?.cookies ?? 0)
    : 0;

  const toggleSite = () => {
    if (!host) return;
    void nt()
      .adblockSetSiteAllowed(host, siteAllowed)
      .then(setAb)
      .catch(() => {});
  };

  // -- per-site permission helpers (same backend as PrivacyAdvanced) --------
  const siteDecision = (perm: string): Tri => {
    if (!snap) return "ask";
    if (perm === "popups")
      return snap.popups[origin] ?? snap.defaults["popups"] ?? "ask";
    if (perm === "autoplay")
      return snap.autoplay[origin] === "block" ||
        snap.defaults["autoplay"] === "block"
        ? "block"
        : "allow";
    return snap.permissions[origin]?.[perm] ?? "ask";
  };

  const setSiteDecision = (perm: string, v: Tri) => {
    if (!origin) return;
    if (perm === "popups") {
      void nt()
        .privacySetPopup(origin, v === "ask" ? null : v)
        .then(setSnap)
        .catch(() => {});
      return;
    }
    if (perm === "autoplay") {
      void nt()
        .privacySetAutoplay(origin, v !== "block")
        .then(setSnap)
        .catch(() => {});
      return;
    }
    void nt()
      .privacySetPermission(origin, perm, v === "ask" ? null : v)
      .then(setSnap)
      .catch(() => {});
  };

  const clearSiteData = () => {
    if (!host) return;
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setConfirmClear(false);
    void nt()
      .privacyDeleteSite(host)
      .then((r) => {
        setClearMsg(
          r.cookies > 0
            ? `Cleared ${r.cookies} cookie${r.cookies === 1 ? "" : "s"} and site storage.`
            : "No site data to clear.",
        );
        nt().privacySites().then(setSites).catch(() => {});
      })
      .catch(() => setClearMsg("Couldn't clear site data."));
  };

  const overrides = snap
    ? PERMISSIONS.filter((p) => {
        const d = siteDecision(p.id);
        return p.id === "autoplay" ? d === "block" : d !== "ask";
      }).length
    : 0;

  const title = loading
    ? "Ad blocker is loading filter lists — protection starts in a moment."
    : protecting
      ? `Ad blocker on — ${count} blocked on this page. Click for site options.`
      : siteAllowed
        ? "Ads allowed on this site. Click to block them."
        : "Ad blocker off. Click for options.";

  const secure = info?.security === "secure" && !info?.certError;

  return (
    <div ref={wrapRef} className="relative">
      <button
        title={title}
        onClick={() => setOpen((o) => !o)}
        className="nt-r-sm relative p-2 transition-colors hover:bg-[var(--nt-bg-hover)]"
        style={{
          color: protecting ? "var(--nt-text-2)" : "var(--nt-text-3)",
          opacity: loading ? 0.55 : 1,
        }}
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
          className="nt-popover nt-r-md absolute left-0 top-10 z-30 max-h-[70vh] w-72 overflow-y-auto border p-3"
          style={{
            background: "var(--nt-bg-overlay)",
            borderColor: "var(--nt-border)",
            boxShadow: "var(--nt-shadow-pop)",
          }}
          role="dialog"
          aria-label={`Site settings for ${host}`}
        >
          {/* ---- Connection ------------------------------------------------ */}
          <div className="flex items-start gap-2.5 px-1 pb-1">
            {info?.certError ? (
              <TriangleAlert
                size={16}
                strokeWidth={1.75}
                className="mt-0.5 shrink-0"
                style={{ color: "#c96a4a" }}
              />
            ) : secure ? (
              <Lock
                size={16}
                strokeWidth={1.75}
                className="mt-0.5 shrink-0"
                style={{ color: "var(--nt-accent)" }}
              />
            ) : (
              <LockOpen
                size={16}
                strokeWidth={1.75}
                className="mt-0.5 shrink-0"
                style={{ color: "var(--nt-text-3)" }}
              />
            )}
            <div className="min-w-0">
              <p
                className="nt-mono truncate text-[12.5px] font-medium"
                style={{ color: "var(--nt-text-1)" }}
              >
                {host}
              </p>
              <p className="text-[11.5px]" style={{ color: "var(--nt-text-3)" }}>
                {info?.certError
                  ? `Certificate problem — ${info.certError}`
                  : secure
                    ? "Connection is secure · certificate valid"
                    : info?.security === "not-secure"
                      ? "Not secure — this page is served over HTTP"
                      : "Browser page"}
              </p>
            </div>
          </div>

          {/* ---- Shields ----------------------------------------------------- */}
          <div
            className="mt-1 border-t pt-1"
            style={{ borderColor: "var(--nt-border)" }}
          >
            <SectionTitle>Shields</SectionTitle>
            <button
              onClick={toggleSite}
              className="nt-r-sm flex w-full items-center justify-between gap-3 px-2 py-1.5 text-left transition-colors hover:bg-[var(--nt-bg-hover)]"
            >
              <span
                className="text-[12.5px]"
                style={{ color: "var(--nt-text-2)" }}
              >
                {protecting
                  ? "Blocking ads & trackers on this site"
                  : "Allowing ads & trackers on this site"}
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
              className="px-2 pt-1 text-[11.5px]"
              style={{ color: "var(--nt-text-3)" }}
            >
              {loading
                ? "Filter lists are still downloading — full protection starts in a moment."
                : count > 0
                  ? `${count} ad/tracker request${count === 1 ? "" : "s"} blocked on this page.`
                  : "No ad/tracker requests blocked on this page yet."}
            </p>
            {!ab.enabled && (
              <p
                className="px-2 pt-1 text-[11.5px]"
                style={{ color: "var(--nt-text-3)" }}
              >
                Ad blocking is off globally — turn it on in Settings →
                Privacy.
              </p>
            )}
          </div>

          {/* ---- Permissions -------------------------------------------------- */}
          <div
            className="mt-1 border-t pt-1"
            style={{ borderColor: "var(--nt-border)" }}
          >
            <button
              onClick={() => setPermsOpen((o) => !o)}
              aria-expanded={permsOpen}
              className="nt-r-sm flex w-full items-center justify-between px-2 py-1 text-left transition-colors hover:bg-[var(--nt-bg-hover)]"
            >
              <span
                className="nt-micro"
                style={{ color: "var(--nt-text-faint)" }}
              >
                Permissions
                {overrides > 0 && (
                  <span
                    className="nt-r-full ml-1.5 px-1.5 py-px text-[10px] font-bold"
                    style={{
                      background: "var(--nt-accent-soft)",
                      color: "var(--nt-accent)",
                    }}
                  >
                    {overrides}
                  </span>
                )}
              </span>
              <ChevronDown
                size={14}
                strokeWidth={2}
                className={`shrink-0 transition-transform ${permsOpen ? "rotate-180" : ""}`}
                style={{ color: "var(--nt-text-3)" }}
              />
            </button>
            {permsOpen && (
              <div className="space-y-1.5 px-2 pb-1 pt-1">
                {PERMISSIONS.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between gap-2"
                  >
                    <span
                      className="text-[12.5px]"
                      style={{ color: "var(--nt-text-2)" }}
                    >
                      {p.label}
                    </span>
                    <TriSegment
                      ariaLabel={`${p.label} for ${host}`}
                      value={siteDecision(p.id)}
                      options={
                        p.id === "autoplay" ? ["allow", "block"] : undefined
                      }
                      onChange={(v) => setSiteDecision(p.id, v)}
                    />
                  </div>
                ))}
                <p
                  className="pt-0.5 text-[11px]"
                  style={{ color: "var(--nt-text-faint)" }}
                >
                  “Ask” follows the global default in Settings → Privacy.
                </p>
              </div>
            )}
          </div>

          {/* ---- Site data ---------------------------------------------------- */}
          <div
            className="mt-1 border-t pt-1"
            style={{ borderColor: "var(--nt-border)" }}
          >
            <SectionTitle>Site data</SectionTitle>
            <div className="flex items-center justify-between gap-2 px-2 pb-1">
              <span
                className="flex items-center gap-1.5 text-[12.5px]"
                style={{ color: "var(--nt-text-2)" }}
              >
                <Database
                  size={13}
                  strokeWidth={1.75}
                  style={{ color: "var(--nt-text-3)" }}
                />
                {cookieCount} cookie{cookieCount === 1 ? "" : "s"} stored
              </span>
              <button
                onClick={clearSiteData}
                className="nt-r-sm px-2.5 py-1 text-[12px] font-medium transition-colors"
                style={
                  confirmClear
                    ? { background: "#c96a4a", color: "#fff" }
                    : {
                        background: "var(--nt-bg-hover)",
                        color: "var(--nt-text-2)",
                      }
                }
              >
                {confirmClear ? "Confirm clear" : "Clear site data"}
              </button>
            </div>
            {confirmClear && (
              <p
                className="px-2 pb-1 text-[11.5px]"
                style={{ color: "#c96a4a" }}
              >
                This signs you out of {host}. Click again to confirm.
              </p>
            )}
            {clearMsg && (
              <p
                className="px-2 pb-1 text-[11.5px]"
                style={{ color: "var(--nt-text-3)" }}
              >
                {clearMsg}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
