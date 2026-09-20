/**
 * Next Token — prototype app shell.
 *
 * Layout: [sidebar] [top strip + tab area] [copilot]
 * The per-space accent is applied as a CSS variable on the root so every
 * component can tint itself without prop-drilling (see index.css).
 *
 * Global shortcuts (also listed in ui/README.md):
 *   ⌘/Ctrl+K or ⌘/Ctrl+T … command bar
 *   ⌘/Ctrl+1…4 ……………… switch space
 *   ⌘/Ctrl+S ……………… toggle sidebar
 *   ⌘/Ctrl+. ……………… toggle copilot
 *   Esc ……………………… cancel split-pick / close command bar
 */

import { useEffect } from "react";
import { CommandBar } from "./components/CommandBar";
import { Copilot } from "./components/Copilot";
import { Sidebar } from "./components/Sidebar";
import { TabArea } from "./components/TabArea";
import { TopStrip } from "./components/TopStrip";
import { StoreProvider, useStore } from "./store";

function Shell() {
  const { state, dispatch, space, activeTab } = useStore();

  // Per-space accent for the whole UI.
  useEffect(() => {
    document.documentElement.style.setProperty("--accent", space.accent);
  }, [space.accent]);

  // Tab title follows the active tab, like a real browser.
  useEffect(() => {
    document.title = activeTab ? `${activeTab.title} — Next Token` : "Next Token";
  }, [activeTab]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) {
        if (e.key === "Escape" && state.splitPick) {
          dispatch({ type: "SET_SPLIT_PICK", picking: false });
        }
        return;
      }
      const k = e.key.toLowerCase();
      if (k === "k" || k === "t") {
        e.preventDefault();
        dispatch({ type: "SET_COMMAND_BAR", open: !state.commandBarOpen });
      } else if (k === "s") {
        e.preventDefault(); // don't trigger the browser's save dialog
        dispatch({ type: "TOGGLE_SIDEBAR" });
      } else if (k === ".") {
        e.preventDefault();
        dispatch({ type: "TOGGLE_COPILOT" });
      } else if (["1", "2", "3", "4"].includes(k)) {
        const target = state.spaces[Number(k) - 1];
        if (target) {
          e.preventDefault();
          dispatch({ type: "SWITCH_SPACE", spaceId: target.id });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch, state.commandBarOpen, state.spaces, state.splitPick]);

  return (
    <div className="flex h-full overflow-hidden bg-[#08080c] text-white">
      {state.sidebarOpen && <Sidebar />}
      <div className="flex min-w-0 flex-1 flex-col">
        <TopStrip />
        <div className="flex min-h-0 flex-1">
          <TabArea />
          {state.copilotOpen && <Copilot />}
        </div>
      </div>
      {state.commandBarOpen && <CommandBar />}
    </div>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
