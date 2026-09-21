/**
 * PrivacyAdvanced — Settings → Privacy & security → Advanced.
 * A Chrome-like manager: per-site permissions, cookies & site data,
 * and clear-browsing-data. Warm-charcoal + ember styling to match Settings.
 */
import { useEffect, useState } from "react";
import { ChevronDown, Database, Shield, Trash2 } from "lucide-react";
import { nt } from "../nt";
import type {
  CookieDetail,
  HistoryEntry,
  PrivacySnapshot,
  SiteDataSummary,
} from "../../shared/ipc";

const PERMISSIONS: { id: string; label: string; hint: string }[] = [
  { id: "camera", label: "Camera", hint: "Sites asking to use your camera" },
  { id: "microphone", label: "Microphone", hint: "Sites asking to use your microphone" },
  { id: "location", label: "Location", hint: "Sites asking for your location" },
  { id: "notifications", label: "Notifications", hint: "Sites asking to send notifications" },
  { id: "popups", label: "Popups", hint: "Per-site popup policy" },
  { id: "autoplay", label: "Autoplay", hint: "Block video autoplay until you interact" },
  { id: "clipboard", label: "Clipboard", hint: "Sites reading your clipboard" },
  { id: "screen-capture", label: "Screen capture", hint: "Sites asking to share your screen" },
];

type Tri = "allow" | "ask" | "block";

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
          onClick={() => onChange(o)}
          className="nt-r-full px-2.5 py-1 text-[11px] font-medium capitalize transition-colors"
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

function SectionTitle({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <h4
      className="mb-2 flex items-center gap-2 text-[13px] font-semibold"
      style={{ color: "var(--nt-text-1)" }}
    >
      {icon}
      {children}
    </h4>
  );
}

export function PrivacyAdvanced() {
  const [snap, setSnap] = useState<PrivacySnapshot | null>(null);
  const [sites, setSites] = useState<SiteDataSummary[]>([]);
  const [expandedSite, setExpandedSite] = useState<string | null>(null);
  const [cookies, setCookies] = useState<CookieDetail[] | null>(null);
  const [expandedOrigin, setExpandedOrigin] = useState<string | null>(null);
  const [clearOpts, setClearOpts] = useState({ cookies: true, cache: true, history: false });
  const [clearing, setClearing] = useState(false);
  const [cleared, setCleared] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  const refresh = () => {
    nt().privacySnapshot().then(setSnap).catch(() => {});
    nt().privacySites().then(setSites).catch(() => {});
  };

  useEffect(() => {
    refresh();
    nt().privacyHistory().then(setHistory).catch(() => {});
  }, []);

  useEffect(() => {
    if (!expandedSite) {
      setCookies(null);
      return;
    }
    nt().privacySiteCookies(expandedSite).then(setCookies).catch(() => setCookies([]));
  }, [expandedSite]);

  if (!snap) {
    return (
      <p className="text-[13px]" style={{ color: "var(--nt-text-3)" }}>
        Loading advanced settings…
      </p>
    );
  }

  const origins = Array.from(
    new Set([
      ...Object.keys(snap.permissions),
      ...Object.keys(snap.popups),
      ...Object.keys(snap.autoplay),
      ...Object.keys(snap.muted),
    ])
  ).sort();

  const siteDecision = (origin: string, perm: string): Tri => {
    // Effective value: per-site override, else the global default, else the
    // built-in base. (Autoplay per-site stores only "block" or no-override;
    // "allow" there means "use the default".)
    if (perm === "popups") return snap.popups[origin] ?? snap.defaults["popups"] ?? "ask";
    if (perm === "autoplay")
      return snap.autoplay[origin] === "block" || snap.defaults["autoplay"] === "block"
        ? "block"
        : "allow";
    return snap.permissions[origin]?.[perm] ?? "ask";
  };

  const setSiteDecision = (origin: string, perm: string, v: Tri) => {
    if (perm === "popups") {
      void nt().privacySetPopup(origin, v === "ask" ? null : v).then(setSnap).catch(() => {});
      return;
    }
    if (perm === "autoplay") {
      // Backend stores only "block" or no-override (default = allow).
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

  const deleteSite = (site: string) => {
    void nt()
      .privacyDeleteSite(site)
      .then(() => {
        setExpandedSite(null);
        refresh();
      })
      .catch(() => {});
  };

  const clearData = () => {
    setClearing(true);
    setCleared(false);
    void nt()
      .privacyClearData(clearOpts)
      .then(() => {
        setClearing(false);
        setCleared(true);
        refresh();
        nt().privacyHistory().then(setHistory).catch(() => {});
        window.setTimeout(() => setCleared(false), 4000);
      })
      .catch(() => setClearing(false));
  };

  return (
    <div className="space-y-7">
      {/* ---- Defaults --------------------------------------------------- */}
      <div>
        <SectionTitle icon={<Shield size={14} strokeWidth={1.75} />}>
          Default permissions
        </SectionTitle>
        <p className="mb-3 text-[12px]" style={{ color: "var(--nt-text-3)" }}>
          Used when a site has no per-site decision. “Ask” shows the permission
          prompt every time. (Autoplay has no prompt — its default is allow or
          block.)
        </p>
        <div className="space-y-2">
          {PERMISSIONS.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[13px]" style={{ color: "var(--nt-text-1)" }}>
                  {p.label}
                </p>
                <p className="text-[12px]" style={{ color: "var(--nt-text-3)" }}>
                  {p.hint}
                </p>
              </div>
              <TriSegment
                ariaLabel={`${p.label} default`}
                value={p.id === "autoplay" ? (snap.defaults[p.id] === "block" ? "block" : "allow") : (snap.defaults[p.id] ?? "ask")}
                options={p.id === "autoplay" ? ["allow", "block"] : undefined}
                onChange={(v) =>
                  void nt().privacySetDefault(p.id, v).then(setSnap).catch(() => {})
                }
              />
            </div>
          ))}
        </div>
      </div>

      {/* ---- Per-site ---------------------------------------------------- */}
      <div>
        <SectionTitle icon={<Shield size={14} strokeWidth={1.75} />}>
          Site settings
        </SectionTitle>
        {origins.length === 0 ? (
          <p className="text-[12px]" style={{ color: "var(--nt-text-3)" }}>
            No per-site decisions yet — they appear here after you allow, block,
            or are asked about a permission.
          </p>
        ) : (
          <div className="space-y-1.5">
            {origins.map((origin) => {
              const open = expandedOrigin === origin;
              const muted = !!snap.muted[origin];
              return (
                <div
                  key={origin}
                  className="nt-r-sm border px-3 py-2"
                  style={{ borderColor: "var(--nt-border)" }}
                >
                  <button
                    className="flex w-full items-center justify-between gap-2"
                    onClick={() => setExpandedOrigin(open ? null : origin)}
                    aria-expanded={open}
                  >
                    <span
                      className="nt-mono truncate text-[12.5px]"
                      style={{ color: "var(--nt-text-1)" }}
                    >
                      {origin}
                      {muted && (
                        <span className="ml-2 text-[11px]" style={{ color: "var(--nt-text-3)" }}>
                          · muted
                        </span>
                      )}
                    </span>
                    <ChevronDown
                      size={14}
                      strokeWidth={2}
                      className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
                      style={{ color: "var(--nt-text-3)" }}
                    />
                  </button>
                  {open && (
                    <div className="mt-2 space-y-2 border-t pt-2" style={{ borderColor: "var(--nt-border)" }}>
                      {PERMISSIONS.map((p) =>
                        p.id === "autoplay" ? (
                          <div key={p.id} className="flex items-center justify-between gap-3">
                            <span className="text-[12.5px]" style={{ color: "var(--nt-text-2)" }}>
                              {p.label}
                              <span className="ml-1.5 text-[11px]" style={{ color: "var(--nt-text-3)" }}>
                                (block or default)
                              </span>
                            </span>
                            <TriSegment
                              ariaLabel={`${p.label} for ${origin}`}
                              options={["allow", "block"]}
                              value={siteDecision(origin, p.id) === "block" ? "block" : "allow"}
                              onChange={(v) => setSiteDecision(origin, p.id, v)}
                            />
                          </div>
                        ) : (
                          <div key={p.id} className="flex items-center justify-between gap-3">
                            <span className="text-[12.5px]" style={{ color: "var(--nt-text-2)" }}>
                              {p.label}
                            </span>
                            <TriSegment
                              ariaLabel={`${p.label} for ${origin}`}
                              value={siteDecision(origin, p.id)}
                              onChange={(v) => setSiteDecision(origin, p.id, v)}
                            />
                          </div>
                        )
                      )}
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-[12.5px]" style={{ color: "var(--nt-text-2)" }}>
                          Muted
                        </span>
                        <button
                          role="switch"
                          aria-checked={muted}
                          aria-label={`Mute ${origin}`}
                          onClick={() =>
                            void nt().privacySetMuted(origin, !muted).then(setSnap).catch(() => {})
                          }
                          className="nt-r-full relative h-6 w-11 shrink-0 transition-colors"
                          style={{
                            background: muted ? "var(--nt-accent)" : "var(--nt-border-strong)",
                          }}
                        >
                          <span
                            className="nt-r-full absolute top-0.5 h-5 w-5 bg-white transition-all"
                            style={{ left: muted ? "22px" : "2px" }}
                          />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ---- Cookies & site data ------------------------------------------ */}
      <div>
        <SectionTitle icon={<Database size={14} strokeWidth={1.75} />}>
          Cookies and site data
        </SectionTitle>
        {sites.length === 0 ? (
          <p className="text-[12px]" style={{ color: "var(--nt-text-3)" }}>
            No stored site data.
          </p>
        ) : (
          <div className="space-y-1.5">
            {sites.map((s) => {
              const open = expandedSite === s.site;
              return (
                <div
                  key={s.site}
                  className="nt-r-sm border px-3 py-2"
                  style={{ borderColor: "var(--nt-border)" }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <button
                      className="flex min-w-0 flex-1 items-center gap-2"
                      onClick={() => setExpandedSite(open ? null : s.site)}
                      aria-expanded={open}
                    >
                      <ChevronDown
                        size={14}
                        strokeWidth={2}
                        className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
                        style={{ color: "var(--nt-text-3)" }}
                      />
                      <span
                        className="nt-mono truncate text-[12.5px]"
                        style={{ color: "var(--nt-text-1)" }}
                      >
                        {s.site}
                      </span>
                      <span className="shrink-0 text-[11px]" style={{ color: "var(--nt-text-3)" }}>
                        {s.cookies} cookie{s.cookies === 1 ? "" : "s"}
                      </span>
                    </button>
                    <button
                      title={`Delete all data for ${s.site}`}
                      onClick={() => deleteSite(s.site)}
                      className="nt-r-sm shrink-0 p-1.5 transition-colors hover:bg-[var(--nt-bg-hover)]"
                      style={{ color: "var(--nt-text-3)" }}
                    >
                      <Trash2 size={13} strokeWidth={1.75} />
                    </button>
                  </div>
                  {open && (
                    <div className="mt-2 border-t pt-2" style={{ borderColor: "var(--nt-border)" }}>
                      {cookies === null ? (
                        <p className="text-[12px]" style={{ color: "var(--nt-text-3)" }}>
                          Loading…
                        </p>
                      ) : cookies.length === 0 ? (
                        <p className="text-[12px]" style={{ color: "var(--nt-text-3)" }}>
                          No cookies.
                        </p>
                      ) : (
                        <ul className="max-h-40 space-y-1 overflow-y-auto">
                          {cookies.map((c) => (
                            <li
                              key={`${c.domain}${c.path}${c.name}`}
                              className="nt-mono flex items-center justify-between gap-2 text-[11.5px]"
                              style={{ color: "var(--nt-text-2)" }}
                            >
                              <span className="truncate">{c.name || "(unnamed)"}</span>
                              <span className="shrink-0" style={{ color: "var(--nt-text-3)" }}>
                                {c.session ? "session" : "persistent"}
                                {c.httpOnly ? " · httpOnly" : ""}
                                {c.secure ? " · secure" : ""}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ---- Clear browsing data ------------------------------------------ */}
      <div>
        <SectionTitle icon={<Trash2 size={14} strokeWidth={1.75} />}>
          Clear browsing data
        </SectionTitle>
        <div className="space-y-2">
          {(
            [
              ["cookies", "Cookies and site data", "Signs you out of most sites."],
              ["cache", "Cached images and files", "Frees disk space; pages reload fresh."],
              ["history", `Browsing history (${snap.historyCount} pages)`, "Visited-page list used above."],
            ] as const
          ).map(([key, label, hint]) => (
            <label key={key} className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={clearOpts[key]}
                onChange={(e) => setClearOpts((o) => ({ ...o, [key]: e.target.checked }))}
                className="mt-0.5 accent-[#E8A33D]"
              />
              <span>
                <span className="block text-[13px]" style={{ color: "var(--nt-text-1)" }}>
                  {label}
                </span>
                <span className="block text-[12px]" style={{ color: "var(--nt-text-3)" }}>
                  {hint}
                </span>
              </span>
            </label>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={clearData}
            disabled={clearing || (!clearOpts.cookies && !clearOpts.cache && !clearOpts.history)}
            className="nt-r-sm px-4 py-1.5 text-[13px] font-medium transition-opacity disabled:opacity-40"
            style={{ background: "var(--nt-accent)", color: "#1c1512" }}
          >
            {clearing ? "Clearing…" : "Clear data"}
          </button>
          {cleared && (
            <span className="text-[12px]" style={{ color: "var(--nt-accent)" }}>
              Cleared.
            </span>
          )}
        </div>
        {history.length > 0 && (
          <div className="mt-3">
            <p className="mb-1.5 text-[12px] font-medium" style={{ color: "var(--nt-text-2)" }}>
              Recent history
            </p>
            <ul className="max-h-36 space-y-1 overflow-y-auto">
              {history.slice(0, 12).map((h, i) => (
                <li
                  key={`${h.at}-${i}`}
                  className="truncate text-[12px]"
                  style={{ color: "var(--nt-text-3)" }}
                  title={h.url}
                >
                  {h.title || h.url}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
