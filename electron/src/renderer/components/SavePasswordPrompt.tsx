/**
 * SavePasswordPrompt.tsx — approval-gated password prompts for the shell.
 *
 * PasswordPromptHost mounts in App.tsx (next to ImportDialogHost) and
 * listens for guest login-form reports (dispatched as window
 * CustomEvents by TabView's console-message routing):
 *
 *  - form-present: a login page with saved credentials → shows the
 *    AutofillOffer chip ("Fill password as <user>?"). One click (or
 *    keyboard: focus the chip, Enter fills, Esc dismisses) calls main,
 *    which injects the fill into the guest directly — the password never
 *    crosses IPC.
 *  - form-submit: the guest reported a login submission → the renderer
 *    tells main (no password involved), main captures the stash from the
 *    guest WebContents itself, and pushes 'nt.passwords.save-prompt'.
 *    SavePasswordPrompt asks "Save password for <origin>?" — nothing is
 *    stored unless the user explicitly clicks Save (or "Never for this
 *    site", which goes on the blocklist).
 */

import { KeyRound, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useBrowser } from "../BrowserContext";
import type { LoginReport } from "../loginDetectScript";
import { nt, domainOf } from "../nt";

interface SavePrompt {
  token: string;
  origin: string;
  username: string;
  /** True when this login already exists with a changed password. */
  update?: boolean;
}

interface Offer {
  tabId: string;
  origin: string;
  usernames: string[];
}

type Decision = "save" | "dismiss" | "never";

function Chip({
  children,
  onDismiss,
  label,
}: {
  children: React.ReactNode;
  onDismiss: () => void;
  label: string;
}) {
  return (
    <div className="nt-toast" role="dialog" aria-label={label}>
      <KeyRound size={15} strokeWidth={2} style={{ color: "var(--nt-accent)" }} />
      {children}
      <button
        type="button"
        className="nt-toast-dismiss"
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        <X size={13} strokeWidth={2} />
      </button>
    </div>
  );
}

function AutofillOffer({ offer, onDone }: { offer: Offer; onDone: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.querySelector("button")?.focus();
  }, []);

  const fill = useCallback(
    (username: string) => {
      setBusy(username);
      setError(null);
      nt()
        .passwordsAutofill(offer.tabId, username)
        .then((r) => {
          setBusy(null);
          if (r.ok) onDone();
          else setError(r.error ?? "Could not fill the form.");
        })
        .catch(() => {
          setBusy(null);
          setError("Could not fill the form.");
        });
    },
    [offer.tabId, onDone],
  );

  return (
    <Chip onDismiss={onDone} label={`Fill saved password for ${domainOf(offer.origin)}`}>
      <span className="nt-toast-text">
        Fill saved password for <strong>{domainOf(offer.origin)}</strong>?
      </span>
      <span className="flex items-center gap-1.5">
        {offer.usernames.map((u) => (
          <button
            key={u}
            type="button"
            className="nt-toast-action"
            disabled={busy !== null}
            onClick={() => fill(u)}
          >
            {busy === u ? "Filling…" : u}
          </button>
        ))}
      </span>
      {error && (
        <span className="nt-toast-text" style={{ color: "#c0392b" }}>
          {error}
        </span>
      )}
    </Chip>
  );
}

function SavePasswordPrompt({
  prompt,
  onDone,
}: {
  prompt: SavePrompt;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const decide = useCallback(
    (decision: Decision) => {
      setBusy(true);
      nt()
        .passwordsSaveDecision(prompt.token, decision)
        .catch(() => undefined)
        .finally(() => {
          setBusy(false);
          onDone();
        });
    },
    [prompt.token, onDone],
  );

  return (
    <Chip
      onDismiss={() => decide("dismiss")}
      label={`Save password for ${domainOf(prompt.origin)}`}
    >
      <span className="nt-toast-text">
        {prompt.update ? (
          <>
            Update password for <strong>{domainOf(prompt.origin)}</strong>
          </>
        ) : (
          <>
            Save password for <strong>{domainOf(prompt.origin)}</strong>
          </>
        )}
        {prompt.username ? (
          <>
            {" "}as <strong>{prompt.username}</strong>
          </>
        ) : null}
        ?
      </span>
      <span className="flex items-center gap-1.5">
        <button
          type="button"
          className="nt-toast-action"
          disabled={busy}
          onClick={() => decide("save")}
        >
          {busy ? (prompt.update ? "Updating…" : "Saving…") : prompt.update ? "Update" : "Save"}
        </button>
        <button
          type="button"
          className="nt-toast-action"
          disabled={busy}
          onClick={() => decide("never")}
          title="Never ask to save passwords for this site again"
        >
          Never for this site
        </button>
      </span>
    </Chip>
  );
}

export function PasswordPromptHost() {
  const { snapshot } = useBrowser();
  const [offer, setOffer] = useState<Offer | null>(null);
  const [savePrompt, setSavePrompt] = useState<SavePrompt | null>(null);
  const activeTabId = snapshot?.spaces.find(
    (s) => s.id === snapshot.activeSpaceId,
  )?.activeTabId;

  // Guest reports arrive as window CustomEvents from TabView.
  useEffect(() => {
    const onReport = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as {
        tabId?: string;
        report?: LoginReport;
      };
      const tabId = detail?.tabId;
      const r = detail?.report;
      if (!tabId || !r || typeof r.origin !== "string") return;
      if (r.kind === "form-present") {
        // Offer only for the tab that's actually on screen.
        nt()
          .passwordsLookup(tabId, r.origin)
          .then((res) => {
            if (res.has && res.usernames.length > 0) {
              setOffer({ tabId, origin: r.origin, usernames: res.usernames });
            }
          })
          .catch(() => undefined);
      } else if (r.kind === "form-submit") {
        // Hand the tab to main; main captures the password from the
        // guest itself and pushes back a save-prompt event on approval need.
        nt()
          .passwordsLoginDetected(tabId, r.origin, r.username)
          .catch(() => undefined);
      }
    };
    window.addEventListener("nt:login-form-report", onReport);
    return () => window.removeEventListener("nt:login-form-report", onReport);
  }, []);

  // Main pushes this when a login submission needs the save decision.
  useEffect(() => {
    const off = nt().onPasswordsSavePrompt((p) => {
      if (p && typeof p.token === "string") setSavePrompt(p);
    });
    return off;
  }, []);

  // The offer belongs to a tab — clear it when the user switches away.
  useEffect(() => {
    if (offer && offer.tabId !== activeTabId) setOffer(null);
  }, [activeTabId, offer]);

  return (
    <>
      {offer && (
        <AutofillOffer offer={offer} onDone={() => setOffer(null)} />
      )}
      {savePrompt && (
        <SavePasswordPrompt
          prompt={savePrompt}
          onDone={() => setSavePrompt(null)}
        />
      )}
    </>
  );
}
