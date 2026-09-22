/**
 * ShortcutCheatsheet — every Next Token shortcut in one place.
 *
 * Opened from ⌘K → "Keyboard shortcuts". Grouped like the shell's own
 * handler (App.tsx), so the list and the code can't drift silently —
 * keep them in sync when adding shortcuts.
 */

import { Keyboard, X } from "lucide-react";
import { useEffect } from "react";

const GROUPS: Array<{ title: string; rows: Array<[string, string]> }> = [
  {
    title: "Tabs",
    rows: [
      ["⌘T", "New tab"],
      ["⌘W", "Close active tab"],
      ["⌘⇧T", "Reopen last closed tab"],
      ["⌘L", "Focus the omnibox"],
      ["⌘D", "Bookmark this page"],
    ],
  },
  {
    title: "Find & zoom",
    rows: [
      ["⌘F", "Find in page"],
      ["⌘=", "Zoom in"],
      ["⌘-", "Zoom out"],
      ["⌘0", "Reset zoom"],
    ],
  },
  {
    title: "Bits",
    rows: [["⌘1 … ⌘9", "Switch to Bit 1–9"]],
  },
  {
    title: "Panels",
    rows: [
      ["⌘K", "Command bar"],
      ["⌘E", "Toggle agent panel"],
      ["⌘B", "Toggle sidebar"],
    ],
  },
  {
    title: "Voice",
    rows: [
      ["Alt+V", "Voice command"],
      ["⌘⇧V", "Voice command (alternate)"],
    ],
  },
  {
    title: "Overlays",
    rows: [["Esc", "Close topmost overlay"]],
  },
];

function Key({ label }: { label: string }) {
  return (
    <kbd
      className="nt-r-sm nt-num shrink-0 border px-1.5 py-0.5 text-[11px] font-medium"
      style={{
        borderColor: "var(--nt-border-strong)",
        color: "var(--nt-text-1)",
        background: "var(--nt-bg-hover)",
      }}
    >
      {label}
    </kbd>
  );
}

export function ShortcutCheatsheet({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-6"
      style={{ background: "rgba(0,0,0,0.45)" }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-label="Keyboard shortcuts"
    >
      <div
        className="nt-popover nt-r-lg max-h-[80vh] w-[520px] overflow-y-auto border p-6 shadow-2xl"
        style={{
          background: "var(--nt-bg-overlay)",
          borderColor: "var(--nt-border)",
          boxShadow: "var(--nt-shadow-pop)",
        }}
      >
        <div className="mb-5 flex items-center gap-2.5">
          <span
            className="nt-r-sm flex h-8 w-8 items-center justify-center"
            style={{ background: "var(--nt-accent-soft)", color: "var(--nt-accent)" }}
          >
            <Keyboard size={16} strokeWidth={1.75} />
          </span>
          <h2
            className="text-[15px] font-semibold tracking-[-0.01em]"
            style={{ color: "var(--nt-text-1)" }}
          >
            Keyboard shortcuts
          </h2>
          <button
            onClick={onClose}
            title="Close"
            aria-label="Close"
            className="nt-r-sm ml-auto p-1.5 transition-colors hover:bg-[var(--nt-bg-hover)]"
            style={{ color: "var(--nt-text-3)" }}
          >
            <X size={15} strokeWidth={1.75} />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-x-8 gap-y-5">
          {GROUPS.map((g) => (
            <section key={g.title}>
              <p className="nt-micro mb-2">{g.title}</p>
              <ul className="space-y-1.5">
                {g.rows.map(([key, label]) => (
                  <li key={key} className="flex items-center justify-between gap-3">
                    <span className="text-[13px]" style={{ color: "var(--nt-text-2)" }}>
                      {label}
                    </span>
                    <Key label={key} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <p className="mt-5 text-[12px]" style={{ color: "var(--nt-text-3)" }}>
          Shell shortcuts also work while a page has focus — ⌘S is
          intentionally unbound so pages keep their own save shortcut.
        </p>
      </div>
    </div>
  );
}
