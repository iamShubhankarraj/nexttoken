/**
 * Agent copilot side panel.
 *
 * v1 scope (this prototype): page-aware chat UI with mock responses, a
 * page-context indicator, and suggestion chips. The product version keeps
 * this exact component — only `mockReply` is replaced by the real agent
 * runtime (CDP loop → LLM), and the context chip is fed by the bridge's
 * AX-tree/DOM snapshot instead of the active tab object.
 */

import { FlaskConical, Send, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { domainOf, useStore } from "../store";

interface Msg {
  id: number;
  role: "user" | "agent";
  text: string;
}

let msgN = 0;
const mid = () => ++msgN;

/** Prototype stand-in for the agent runtime. Clearly labeled as mocked. */
function mockReply(question: string, pageTitle: string, pageDomain: string): string {
  const q = question.toLowerCase();
  if (q.includes("summar")) {
    return (
      `Here's my read of “${pageTitle}” (${pageDomain}):\n\n` +
      `• The core idea is that browser chrome — not the engine — is where the next leap in browsing happens.\n` +
      `• Ephemeral tabs + auto-archive remove tab anxiety by making closing feel like tidying.\n` +
      `• Spaces map the UI onto real attention modes: a few persistent tools, a working set, and a passing stream.\n\n` +
      `Want me to pull out action items or compare it with another open tab?`
    );
  }
  if (q.includes("key point") || q.includes("extract")) {
    return (
      `Key points from “${pageTitle}”:\n\n` +
      `1. Calm comes from ephemerality — tabs that clean up after themselves.\n` +
      `2. Hierarchy beats flat lists: favorites → pinned → today.\n` +
      `3. The command bar is becoming the primary interface; the address bar is legacy.\n\n` +
      `Prototype note: in the real product I'd cite exact passages with links.`
    );
  }
  if (q.includes("eli5") || q.includes("explain")) {
    return (
      `Imagine your desk cleaned itself every night, but nothing important was ever thrown away — just filed. ` +
      `That's what “${pageTitle}” describes for browser tabs: the boring stuff archives itself, ` +
      `your real work stays pinned, and you stop dreading the tab bar.`
    );
  }
  return (
    `I'm looking at “${pageTitle}” (${pageDomain}) right now.\n\n` +
    `In this prototype my answers are mocked — the UI loop is real though: page context flows in, ` +
    `I reason, and I'd act through the page in the product build. Try “summarize this page” or ` +
    `“extract key points” to see the page-aware replies.`
  );
}

const SUGGESTIONS = [
  "Summarize this page",
  "Extract key points",
  "Explain like I'm 5",
];

export function Copilot() {
  const { dispatch, activeTab } = useStore();
  const [msgs, setMsgs] = useState<Msg[]>([
    {
      id: mid(),
      role: "agent",
      text: "Hey — I'm Copilot. I can see your current tab, so ask me about the page, or tell me to do something with it.\n\nPrototype note: my replies here are mocked.",
    },
  ]);
  const [input, setInput] = useState("");
  const [typing, setTyping] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, typing]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const send = (text: string) => {
    const q = text.trim();
    if (!q || typing) return;
    setMsgs((m) => [...m, { id: mid(), role: "user", text: q }]);
    setInput("");
    setTyping(true);
    timer.current = setTimeout(() => {
      setTyping(false);
      setMsgs((m) => [
        ...m,
        {
          id: mid(),
          role: "agent",
          text: mockReply(q, activeTab?.title ?? "this page", activeTab ? domainOf(activeTab.url) : ""),
        },
      ]);
      inputRef.current?.focus();
    }, 900);
  };

  return (
    <aside className="nt-fade-slide-in flex h-full w-[320px] shrink-0 flex-col border-l border-white/[0.07] bg-[#0c0c11]">
      <div className="flex items-center gap-2 border-b border-white/[0.07] px-3.5 py-3">
        <span
          className="flex h-7 w-7 items-center justify-center rounded-lg"
          style={{ background: "color-mix(in srgb, var(--accent) 20%, transparent)" }}
        >
          <Sparkles size={15} style={{ color: "var(--accent)" }} />
        </span>
        <p className="text-sm font-medium">Copilot</p>
        <span className="flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] text-white/40">
          <FlaskConical size={10} /> prototype · mocked
        </span>
        <button
          title="Close copilot"
          onClick={() => dispatch({ type: "TOGGLE_COPILOT" })}
          className="ml-auto rounded-lg p-1.5 text-white/40 hover:bg-white/[0.07] hover:text-white transition-colors"
        >
          <X size={15} />
        </button>
      </div>

      {/* Page-context indicator */}
      <div className="border-b border-white/[0.07] px-3.5 py-2.5">
        <p className="text-[10px] uppercase tracking-widest text-white/30">Reading</p>
        <p className="mt-0.5 truncate text-[13px] text-white/75">
          {activeTab ? activeTab.title : "No tab"}
        </p>
        <p className="truncate text-[11px] text-white/35">
          {activeTab ? domainOf(activeTab.url) : ""}
        </p>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-3.5 py-3">
        {msgs.map((m) => (
          <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[92%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed ${
                m.role === "user"
                  ? "rounded-br-md text-white"
                  : "rounded-bl-md border border-white/[0.07] bg-white/[0.04] text-white/85"
              }`}
              style={m.role === "user" ? { background: "var(--accent)" } : undefined}
            >
              {m.text}
            </div>
          </div>
        ))}
        {typing && (
          <div className="flex justify-start">
            <div className="flex items-center gap-1.5 rounded-2xl rounded-bl-md border border-white/[0.07] bg-white/[0.04] px-4 py-3">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="nt-typing-dot h-1.5 w-1.5 rounded-full bg-white/60"
                  style={{ animationDelay: `${i * 150}ms` }}
                />
              ))}
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-white/[0.07] p-3">
        <div className="mb-2 flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              onClick={() => send(s)}
              className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] text-white/60 hover:border-[var(--accent)]/50 hover:text-white transition-colors"
            >
              {s}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send(input)}
            placeholder="Ask about this page…"
            className="w-full rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-2.5 text-[13px] outline-none placeholder:text-white/30 focus:border-[var(--accent)]/60 transition-colors"
          />
          <button
            onClick={() => send(input)}
            title="Send"
            className="shrink-0 rounded-xl p-2.5 text-white transition-transform hover:scale-105"
            style={{ background: "var(--accent)" }}
          >
            <Send size={15} />
          </button>
        </div>
      </div>
    </aside>
  );
}
