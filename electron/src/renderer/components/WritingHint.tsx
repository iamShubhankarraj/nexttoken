/**
 * Writing hint — a small popup near the focused text field in a page
 * (Dia pattern: AI help at the insertion point).
 *
 * Actions run through the existing agent bus, so no new agent plumbing
 * was needed: complete the sentence, summarize the page, or drop an
 * @-mention of the tab into the agent's draft.
 */

import { ListPlus, PenLine, ScrollText, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useBrowser } from "../BrowserContext";
import { askAgent, prefillAgent } from "../agentBus";
import type { CaretHintDetail } from "../caretScript";
import { nt } from "../nt";

export function WritingHint() {
  const { activeTab } = useBrowser();
  const [detail, setDetail] = useState<CaretHintDetail | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hide = () => setDetail(null);

  useEffect(() => {
    const onHint = (e: Event) => {
      const d = (e as CustomEvent<CaretHintDetail>).detail;
      if (!d) return;
      if (hideTimer.current) clearTimeout(hideTimer.current);
      // Anchor to the field: the reported rect is in page coordinates,
      // so offset by the content area's screen position.
      const content = document.getElementById("nt-content");
      const r = content?.getBoundingClientRect();
      const x = (r?.left ?? 0) + d.rect.x;
      const y = (r?.top ?? 0) + d.rect.y + d.rect.height + 8;
      setPos({
        x: Math.min(Math.max(8, x), window.innerWidth - 300),
        y: Math.min(Math.max(8, y), window.innerHeight - 160),
      });
      setDetail(d);
    };
    const onBlur = () => {
      // Small grace period so a click on the popup itself doesn't
      // instantly dismiss it.
      hideTimer.current = setTimeout(() => setDetail(null), 180);
    };
    window.addEventListener("nt:writing-hint", onHint);
    window.addEventListener("nt:writing-hint-blur", onBlur);
    return () => {
      window.removeEventListener("nt:writing-hint", onHint);
      window.removeEventListener("nt:writing-hint-blur", onBlur);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, []);

  // Hide when the user switches tabs.
  useEffect(() => {
    hide();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.id]);

  if (!detail || detail.tabId !== activeTab?.id) return null;

  const openPanel = () => nt().uiSetAgentPanelOpen(true);
  const pageRef = `${activeTab?.title || "this page"}`;

  const actions = [
    {
      icon: PenLine,
      label: "Complete sentence",
      run: () => {
        hide();
        void openPanel().then(() =>
          askAgent(
            `I am writing in a text field on "${pageRef}". ` +
              `The text so far ends with: "${detail.text.slice(-160)}". ` +
              `Complete the current sentence naturally, matching my tone. ` +
              `Reply with only the completion, no quotes or commentary.`,
          ),
        );
      },
    },
    {
      icon: ScrollText,
      label: "Summarize page",
      run: () => {
        hide();
        void openPanel().then(() =>
          askAgent(`Summarize this page for me: "${pageRef}".`),
        );
      },
    },
    {
      icon: ListPlus,
      label: "Insert tab context",
      run: () => {
        hide();
        void openPanel().then(() =>
          prefillAgent(`@${activeTab?.title || "New tab"} `),
        );
      },
    },
  ];

  return (
    <div
      className="nt-fade-in nt-r-md fixed z-40 border p-1.5"
      style={{
        left: pos.x,
        top: pos.y,
        width: 284,
        background: "var(--nt-bg-overlay)",
        borderColor: "var(--nt-border)",
        boxShadow: "var(--nt-shadow-pop)",
      }}
      onMouseEnter={() => {
        if (hideTimer.current) clearTimeout(hideTimer.current);
      }}
      role="dialog"
      aria-label="Writing help"
    >
      <div className="flex items-center justify-between px-2 pb-1 pt-0.5">
        <p className="nt-micro">Writing help</p>
        <button
          onClick={hide}
          aria-label="Dismiss writing help"
          className="nt-r-sm p-1 transition-colors hover:bg-[var(--nt-bg-hover)]"
          style={{ color: "var(--nt-text-3)" }}
        >
          <X size={13} strokeWidth={1.75} />
        </button>
      </div>
      {actions.map((a) => (
        <button
          key={a.label}
          onClick={a.run}
          className="nt-r-sm flex w-full items-center gap-2.5 px-2.5 py-2 text-left text-[13px] transition-colors hover:bg-[var(--nt-bg-hover)]"
          style={{ color: "var(--nt-text-1)" }}
        >
          <a.icon size={14} strokeWidth={1.75} style={{ color: "var(--nt-accent)" }} />
          {a.label}
        </button>
      ))}
      <p
        className="px-2.5 pb-1 pt-1.5 text-[11px]"
        style={{ color: "var(--nt-text-faint)" }}
      >
        Powered by your chosen agent model
      </p>
    </div>
  );
}
