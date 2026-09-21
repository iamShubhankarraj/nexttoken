/**
 * FindBar — find-in-page for the active tab's guest content.
 *
 * ⌘F opens it (from App's global shortcuts); Enter searches, Enter again
 * (or ↓) steps through matches, Shift+Enter steps back, Esc closes.
 * Match counts come back from main via nt.onFindResult.
 */
import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { nt } from "../nt";

export function FindBar({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<{ matches: number; active: number } | null>(
    null,
  );
  const submitted = useRef("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  useEffect(() => nt().onFindResult((r) => setRes({ matches: r.matches, active: r.active })), []);

  const go = (forward: boolean) => {
    const query = q.trim();
    if (!query) return;
    if (submitted.current !== query) {
      submitted.current = query;
      setRes(null);
      void nt().findStart(query);
    } else {
      void nt().findNext(forward);
    }
  };

  const count =
    res == null
      ? ""
      : res.matches === 0
        ? "No matches"
        : `${res.active} of ${res.matches}`;

  return (
    <div className="nt-findbar" role="search" aria-label="Find in page">
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            go(!e.shiftKey);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
        placeholder="Find in page"
        aria-label="Find in page"
        spellCheck={false}
      />
      {count ? <span className="nt-findbar-count">{count}</span> : null}
      <button
        type="button"
        className="nt-findbar-btn"
        onClick={() => go(false)}
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"
      >
        <ChevronUp size={14} strokeWidth={2} />
      </button>
      <button
        type="button"
        className="nt-findbar-btn"
        onClick={() => go(true)}
        title="Next match (Enter)"
        aria-label="Next match"
      >
        <ChevronDown size={14} strokeWidth={2} />
      </button>
      <button
        type="button"
        className="nt-findbar-btn"
        onClick={onClose}
        title="Close (Esc)"
        aria-label="Close find"
      >
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  );
}
