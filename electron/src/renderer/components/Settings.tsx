/**
 * Settings overlay (nt.uiSetSettingsOpen) on the new design system:
 * BYOK provider, local models, saved skills, voice & search, and the
 * per-space theme editor.
 *
 * The stored API key is never displayed — settingsGetProvider() only
 * reports keyConfigured, and the key field submits empty to keep the
 * existing value.
 */

import {
  Check,
  Database,
  KeyRound,
  Loader2,
  Mic,
  Palette,
  Plug,
  Search,
  Shield,
  Volume2,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  PROVIDER_PRESETS,
  type AdBlockState,
  type ProviderConfigPublic,
  type ProviderId,
} from "../../shared/ipc";
import { useBrowser } from "../BrowserContext";
import { nt } from "../nt";
import { ModelsPanel } from "./ModelsPanel";
import { SkillsSection } from "./SettingsSkills";
import { ThemeEditor } from "./ThemeEditor";

type Section = "provider" | "models" | "skills" | "voice" | "theme" | "privacy";

const SECTIONS: Array<{ id: Section; label: string; icon: typeof Plug }> = [
  { id: "provider", label: "AI Provider", icon: Plug },
  { id: "models", label: "Models", icon: Database },
  { id: "skills", label: "Skills", icon: Zap },
  { id: "voice", label: "Voice & Search", icon: Mic },
  { id: "privacy", label: "Privacy", icon: Shield },
  { id: "theme", label: "Theme", icon: Palette },
];

export function Settings({ onClose }: { onClose: () => void }) {
  const { activeSpace } = useBrowser();
  const [section, setSection] = useState<Section>("provider");

  return (
    <div
      className="nt-fade-in fixed inset-0 z-50 flex items-start justify-center bg-black/50"
      onMouseDown={onClose}
    >
      <div
        className="nt-popover nt-r-lg mt-[8vh] flex max-h-[84vh] w-full max-w-2xl flex-col overflow-hidden border"
        style={{
          borderColor: "var(--nt-border)",
          background: "var(--nt-bg-overlay)",
          boxShadow: "0 24px 64px rgba(0,0,0,0.55)",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center gap-2 border-b px-5 py-4"
          style={{ borderColor: "var(--nt-border)" }}
        >
          <h2
            className="text-[15px] font-semibold tracking-[-0.01em]"
            style={{ color: "var(--nt-text-1)" }}
          >
            Settings
          </h2>
          <button
            onClick={onClose}
            title="Close settings (Esc)"
            className="nt-r-sm ml-auto p-1.5 transition-colors hover:bg-[var(--nt-bg-hover)]"
            style={{ color: "var(--nt-text-3)" }}
          >
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* section nav */}
          <nav
            className="w-44 shrink-0 space-y-1 border-r p-3"
            style={{ borderColor: "var(--nt-border)" }}
          >
            {SECTIONS.map((s) => {
              const Icon = s.icon;
              const active = section === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => setSection(s.id)}
                  className={`nt-r-sm flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] font-medium transition-colors ${
                    active ? "" : "hover:bg-[var(--nt-bg-hover)]"
                  }`}
                  style={
                    active
                      ? {
                          background: "var(--nt-accent-soft)",
                          color: "var(--nt-accent)",
                        }
                      : { color: "var(--nt-text-2)" }
                  }
                >
                  <Icon size={16} strokeWidth={1.75} />
                  {s.label}
                </button>
              );
            })}
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {section === "provider" && <ProviderSection />}
            {section === "models" && <ModelsPanel />}
            {section === "skills" && <SkillsSection />}
            {section === "voice" && <VoiceSearchSection />}
            {section === "privacy" && <PrivacySection />}
            {section === "theme" &&
              (activeSpace ? (
                <ThemeEditor spaceId={activeSpace.id} />
              ) : (
                <p className="text-[13px]" style={{ color: "var(--nt-text-3)" }}>
                  No active space.
                </p>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ AI provider ----------------------------- */

function ProviderSection() {
  const [presetId, setPresetId] = useState<ProviderId>("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [keyConfigured, setKeyConfigured] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testOk, setTestOk] = useState<boolean | null>(null);
  const [savedTick, setSavedTick] = useState(false);

  // Load current config once (key itself never leaves main).
  useEffect(() => {
    let alive = true;
    nt()
      .settingsGetProvider()
      .then((c: ProviderConfigPublic) => {
        if (!alive) return;
        setPresetId(c.presetId);
        setBaseUrl(c.baseUrl);
        setModel(c.model);
        setKeyConfigured(c.keyConfigured);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => {
      alive = false;
    };
  }, []);

  const applyPreset = (id: ProviderId) => {
    setPresetId(id);
    const p = PROVIDER_PRESETS.find((x) => x.id === id);
    if (p) {
      setBaseUrl(p.baseUrl);
      setModel("");
      setApiKey("");
    }
    setTestResult(null);
    setTestOk(null);
  };

  const preset = PROVIDER_PRESETS.find((p) => p.id === presetId);

  const save = async () => {
    setSaving(true);
    try {
      const updated = await nt().settingsSetProvider({
        presetId,
        baseUrl: baseUrl.trim(),
        apiKey, // empty string = keep existing key
        model: model.trim() || preset?.modelHint || "",
      });
      setKeyConfigured(updated.keyConfigured);
      setApiKey("");
      setSavedTick(true);
      setTimeout(() => setSavedTick(false), 1600);
    } catch (err) {
      setTestResult(
        `Couldn't save: ${err instanceof Error ? err.message : String(err)}`,
      );
      setTestOk(false);
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    setTestOk(null);
    try {
      const r = await nt().settingsTestConnection();
      setTestOk(r.ok);
      setTestResult(
        r.ok
          ? `Connected${r.model ? ` — model “${r.model}” responded` : ""}.`
          : `Connection failed: ${r.error ?? "unknown error"}.`,
      );
    } catch (err) {
      setTestOk(false);
      setTestResult(
        `Connection failed: ${err instanceof Error ? err.message : String(err)}.`,
      );
    } finally {
      setTesting(false);
    }
  };

  const inputCls =
    "nt-r-sm w-full border bg-[var(--nt-bg-base)] px-3 py-2 text-[13px] outline-none transition-colors placeholder:text-[var(--nt-text-3)] focus:border-[var(--nt-accent)]";
  const inputStyle = {
    borderColor: "var(--nt-border)",
    color: "var(--nt-text-1)",
  } as const;

  if (!loaded) {
    return (
      <p className="text-[13px]" style={{ color: "var(--nt-text-3)" }}>
        Loading provider settings…
      </p>
    );
  }

  return (
    <div>
      <p className="mb-3 text-[13px]" style={{ color: "var(--nt-text-2)" }}>
        Bring your own key. The key is stored by the main process and never
        shown here again. Cloud is the fallback tier — on-device models
        (Settings → Models) are tried first.
      </p>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {PROVIDER_PRESETS.map((p) => {
          const active = p.id === presetId;
          return (
            <button
              key={p.id}
              onClick={() => applyPreset(p.id)}
              className="nt-r-md border p-3 text-left transition-colors"
              style={
                active
                  ? {
                      borderColor: "var(--nt-accent)",
                      background: "var(--nt-accent-soft)",
                    }
                  : {
                      borderColor: "var(--nt-border)",
                      background: "var(--nt-bg-base)",
                    }
              }
            >
              <span
                className="flex items-center gap-1.5 text-[13px] font-medium"
                style={{ color: "var(--nt-text-1)" }}
              >
                {active && (
                  <Check size={13} strokeWidth={2.5} style={{ color: "var(--nt-accent)" }} />
                )}
                {p.name}
              </span>
              <span
                className="mt-1 block truncate text-[11px]"
                style={{ color: "var(--nt-text-3)" }}
              >
                {p.needsKey ? "API key" : "No key needed"} · {p.api}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-4 space-y-3">
        <label className="block">
          <FieldLabel text="Endpoint URL" />
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={preset?.baseUrl || "https://…"}
            spellCheck={false}
            className={inputCls}
            style={inputStyle}
          />
        </label>

        {preset?.needsKey && (
          <label className="block">
            <FieldLabel
              text="API key"
              hint={
                keyConfigured
                  ? "A key is stored. Leave blank to keep it."
                  : "Stored securely by the main process."
              }
            />
            <div className="relative">
              <KeyRound
                size={14}
                strokeWidth={1.75}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2"
                style={{ color: "var(--nt-text-3)" }}
              />
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={keyConfigured ? "•••••••• (stored)" : "sk-…"}
                spellCheck={false}
                autoComplete="off"
                className={`${inputCls} pl-9`}
                style={inputStyle}
              />
            </div>
          </label>
        )}

        <label className="block">
          <FieldLabel text="Model" />
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={preset?.modelHint || "model-id"}
            spellCheck={false}
            className={inputCls}
            style={inputStyle}
          />
        </label>
      </div>

      <div className="mt-4 flex items-center gap-2">
        <button
          onClick={() => void save()}
          disabled={saving}
          className="nt-r-sm flex items-center gap-1.5 px-4 py-2 text-[13px] font-semibold transition-transform hover:scale-[1.02] disabled:opacity-50"
          style={{ background: "var(--nt-accent)", color: "var(--nt-accent-text)" }}
        >
          {saving && <Loader2 size={14} strokeWidth={1.75} className="animate-spin" />}
          {savedTick ? "Saved ✓" : "Save"}
        </button>
        <button
          onClick={() => void test()}
          disabled={testing}
          className="nt-r-sm flex items-center gap-1.5 border px-4 py-2 text-[13px] font-medium transition-colors hover:bg-[var(--nt-bg-hover)] disabled:opacity-50"
          style={{ borderColor: "var(--nt-border)", color: "var(--nt-text-1)" }}
        >
          {testing ? (
            <Loader2 size={14} strokeWidth={1.75} className="animate-spin" />
          ) : (
            <Plug size={14} strokeWidth={1.75} />
          )}
          Test connection
        </button>
      </div>

      {testResult && (
        <p
          className="mt-3 text-[13px]"
          style={{
            color:
              testOk === true
                ? "#6fa287"
                : testOk === false
                  ? "#d97362"
                  : "var(--nt-text-2)",
          }}
        >
          {testResult}
        </p>
      )}

      {/* Jev System-One — the orchestration brain. Key in OS keychain. */}
      <JevSection />
    </div>
  );
}

/* --------------------------- Jev orchestration -------------------------- */

function JevSection() {
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [configured, setConfigured] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [noteOk, setNoteOk] = useState<boolean | null>(null);
  const [savedTick, setSavedTick] = useState(false);

  // Load public config once — the key itself never leaves main.
  useEffect(() => {
    let alive = true;
    nt()
      .brainGetJev()
      .then((c) => {
        if (!alive) return;
        setBaseUrl(c.baseUrl);
        setConfigured(c.configured);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => {
      alive = false;
    };
  }, []);

  const save = async () => {
    setSaving(true);
    setNote(null);
    try {
      const updated = await nt().brainSetJev({ apiKey, baseUrl: baseUrl.trim() });
      setConfigured(updated.configured);
      setBaseUrl(updated.baseUrl);
      setApiKey("");
      setSavedTick(true);
      setTimeout(() => setSavedTick(false), 1600);
    } catch (err) {
      setNoteOk(false);
      setNote(`Couldn't save: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const validate = async () => {
    setValidating(true);
    setNote(null);
    try {
      // One lightweight decide() call with the typed key. It is NOT stored —
      // saving happens only when you press Save below.
      const r = await nt().brainValidateJev(apiKey, baseUrl.trim() || undefined);
      setNoteOk(r.ok);
      setNote(
        r.ok
          ? "Key accepted — Jev answered the validation probe."
          : `Validation failed: ${r.error ?? "unknown error"}.`,
      );
    } catch (err) {
      setNoteOk(false);
      setNote(
        `Validation failed: ${err instanceof Error ? err.message : String(err)}.`,
      );
    } finally {
      setValidating(false);
    }
  };

  const inputCls =
    "nt-r-sm w-full border bg-[var(--nt-bg-base)] px-3 py-2 text-[13px] outline-none transition-colors placeholder:text-[var(--nt-text-3)] focus:border-[var(--nt-accent)]";
  const inputStyle = {
    borderColor: "var(--nt-border)",
    color: "var(--nt-text-1)",
  } as const;

  if (!loaded) return null;

  return (
    <div
      className="nt-r-md mt-6 border p-4"
      style={{ borderColor: "var(--nt-border)", background: "var(--nt-bg-raised)" }}
    >
      <h3
        className="flex items-center gap-2 text-[13px] font-semibold"
        style={{ color: "var(--nt-text-1)" }}
      >
        <Zap size={14} strokeWidth={1.75} style={{ color: "var(--nt-accent)" }} />
        Jev — orchestration brain
      </h3>
      <p className="mt-1.5 text-[12px]" style={{ color: "var(--nt-text-2)" }}>
        Jev (TypeSafe AI) makes the fast System-One decisions: which voice
        command you meant, how complex a task is, whether it is sensitive, and
        whether the page is needed. Specialists still do the work. The key is
        stored in the OS keychain and never shown again.
      </p>

      <div className="mt-3 space-y-3">
        <label className="block">
          <FieldLabel text="Jev API base URL (optional)" />
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.typesafe.ai/v1"
            spellCheck={false}
            autoComplete="off"
            className={inputCls}
            style={inputStyle}
          />
        </label>
        <label className="block">
          <FieldLabel
            text="Jev API key"
            hint={
              configured
                ? "A key is stored. Leave blank to keep it."
                : "Stored in the OS keychain, never in plain text."
            }
          />
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={configured ? "•••••••• (stored)" : "jev-…"}
            spellCheck={false}
            autoComplete="off"
            className={inputCls}
            style={inputStyle}
          />
        </label>
      </div>

      <div className="mt-4 flex items-center gap-2">
        <button
          onClick={() => void save()}
          disabled={saving}
          className="nt-r-sm flex items-center gap-1.5 px-4 py-2 text-[13px] font-semibold transition-transform hover:scale-[1.02] disabled:opacity-50"
          style={{ background: "var(--nt-accent)", color: "var(--nt-accent-text)" }}
        >
          {saving && <Loader2 size={14} strokeWidth={1.75} className="animate-spin" />}
          {savedTick ? "Saved ✓" : "Save"}
        </button>
        <button
          onClick={() => void validate()}
          disabled={validating || !apiKey.trim()}
          title="One lightweight probe with the typed key — not stored"
          className="nt-r-sm flex items-center gap-1.5 border px-4 py-2 text-[13px] font-medium transition-colors hover:bg-[var(--nt-bg-hover)] disabled:opacity-50"
          style={{ borderColor: "var(--nt-border)", color: "var(--nt-text-1)" }}
        >
          {validating ? (
            <Loader2 size={14} strokeWidth={1.75} className="animate-spin" />
          ) : (
            <Zap size={14} strokeWidth={1.75} />
          )}
          Validate
        </button>
      </div>

      {note && (
        <p
          className="mt-3 text-[13px]"
          style={{
            color: noteOk === true ? "#6fa287" : noteOk === false ? "#d97362" : "var(--nt-text-2)",
          }}
        >
          {note}
        </p>
      )}
    </div>
  );
}

/* ---------------------------- voice & search ---------------------------- */

function VoiceSearchSection() {
  const [voice, setVoice] = useState({
    enabled: false,
    speakReplies: false,
    voiceControl: false,
  });
  const [engine, setEngine] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [savedTick, setSavedTick] = useState(false);
  const supported =
    typeof window !== "undefined" &&
    (!!window.webkitSpeechRecognition || !!window.SpeechRecognition);

  useEffect(() => {
    let alive = true;
    Promise.all([nt().settingsGetVoice(), nt().settingsGetSearchEngine()])
      .then(([v, e]) => {
        if (!alive) return;
        setVoice(v);
        setEngine(e);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => {
      alive = false;
    };
  }, []);

  const setVoiceCfg = (next: {
    enabled: boolean;
    speakReplies: boolean;
    voiceControl: boolean;
  }) => {
    setVoice(next);
    nt().settingsSetVoice(next).catch(() => {});
  };

  const saveEngine = () => {
    nt()
      .settingsSetSearchEngine(engine.trim())
      .then(() => {
        setSavedTick(true);
        setTimeout(() => setSavedTick(false), 1600);
      })
      .catch(() => {});
  };

  if (!loaded) {
    return (
      <p className="text-[13px]" style={{ color: "var(--nt-text-3)" }}>
        Loading…
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h3
          className="mb-2 flex items-center gap-2 text-[13px] font-semibold"
          style={{ color: "var(--nt-text-1)" }}
        >
          <Mic size={14} strokeWidth={1.75} /> Voice control
        </h3>
        {!supported && (
          <p
            className="nt-r-sm mb-3 border px-3 py-2 text-[12px]"
            style={{
              borderColor: "rgba(217,115,98,0.4)",
              color: "#d97362",
              background: "rgba(217,115,98,0.07)",
            }}
          >
            Voice input isn't available in this build — Chromium's Web Speech
            API wasn't detected. Everything else still works.
          </p>
        )}
        <div className="space-y-2">
          <ToggleRow
            label="Enable voice commands"
            hint="Mic button in the agent panel, Alt+V hotkey, dictation mode"
            checked={voice.enabled}
            onChange={(v) => setVoiceCfg({ ...voice, enabled: v })}
          />
          <ToggleRow
            label="Speak agent replies"
            hint="Read assistant messages aloud with speech synthesis"
            checked={voice.speakReplies}
            onChange={(v) => setVoiceCfg({ ...voice, speakReplies: v })}
          />
          <ToggleRow
            label="Control the browser by voice"
            hint="Route voice transcripts through the Jev brain: tabs, navigation, pages, settings"
            checked={voice.voiceControl}
            onChange={(v) => setVoiceCfg({ ...voice, voiceControl: v })}
          />
        </div>
      </div>

      <div>
        <h3
          className="mb-2 flex items-center gap-2 text-[13px] font-semibold"
          style={{ color: "var(--nt-text-1)" }}
        >
          <Search size={14} strokeWidth={1.75} /> Search engine
        </h3>
        <p className="mb-2 text-[12px]" style={{ color: "var(--nt-text-3)" }}>
          Used when the address bar input isn't a URL. Use{" "}
          <code className="nt-r-sm bg-[var(--nt-bg-hover)] px-1">%s</code> for
          the query.
        </p>
        <div className="flex gap-2">
          <input
            value={engine}
            onChange={(e) => setEngine(e.target.value)}
            placeholder="https://www.google.com/search?q=%s"
            spellCheck={false}
            className="nt-r-sm flex-1 border bg-[var(--nt-bg-base)] px-3 py-2 text-[13px] outline-none placeholder:text-[var(--nt-text-3)] focus:border-[var(--nt-accent)]"
            style={{ borderColor: "var(--nt-border)", color: "var(--nt-text-1)" }}
          />
          <button
            onClick={saveEngine}
            className="nt-r-sm flex items-center gap-1.5 px-4 py-2 text-[13px] font-semibold transition-transform hover:scale-[1.02]"
            style={{ background: "var(--nt-accent)", color: "var(--nt-accent-text)" }}
          >
            {savedTick ? "Saved ✓" : "Save"}
          </button>
        </div>
      </div>

      <div>
        <h3
          className="mb-2 flex items-center gap-2 text-[13px] font-semibold"
          style={{ color: "var(--nt-text-1)" }}
        >
          <Volume2 size={14} strokeWidth={1.75} /> Voice commands cheat sheet
        </h3>
        <ul
          className="grid grid-cols-1 gap-1 text-[12.5px] sm:grid-cols-2"
          style={{ color: "var(--nt-text-2)" }}
        >
          {[
            "“new tab” / “close tab”",
            "“go to <site>”",
            "“go back” / “go forward”",
            "“reload”",
            "“summarize this page”",
            "“switch to <space>”",
            "“open settings”",
            "“toggle sidebar”",
          ].map((c) => (
            <li
              key={c}
              className="nt-r-sm border px-2.5 py-1.5"
              style={{ borderColor: "var(--nt-border)" }}
            >
              {c}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/* --------------------------------- bits ---------------------------------- */

function FieldLabel({ text, hint }: { text: string; hint?: string }) {
  return (
    <span
      className="mb-1.5 flex items-baseline justify-between text-[12px] font-medium"
      style={{ color: "var(--nt-text-1)" }}
    >
      {text}
      {hint && (
        <span className="font-normal" style={{ color: "var(--nt-text-3)" }}>
          {hint}
        </span>
      )}
    </span>
  );
}

/* ------------------------------ privacy -------------------------------- */

function PrivacySection() {
  const [state, setState] = useState<AdBlockState>({
    enabled: true,
    allowedHosts: [],
  });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    nt()
      .adblockGet()
      .then((s) => {
        if (alive) {
          setState(s);
          setLoaded(true);
        }
      })
      .catch(() => setLoaded(true));
    return () => {
      alive = false;
    };
  }, []);

  const setEnabled = (enabled: boolean) => {
    setState((s) => ({ ...s, enabled }));
    void nt().adblockSetEnabled(enabled).then(setState).catch(() => {});
  };

  const removeHost = (host: string) => {
    void nt().adblockSetSiteAllowed(host, false).then(setState).catch(() => {});
  };

  if (!loaded) {
    return (
      <p className="text-[13px]" style={{ color: "var(--nt-text-3)" }}>
        Loading…
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h3
          className="mb-2 flex items-center gap-2 text-[13px] font-semibold"
          style={{ color: "var(--nt-text-1)" }}
        >
          <Shield size={14} strokeWidth={1.75} /> Ad blocker
        </h3>
        <div className="space-y-2">
          <ToggleRow
            label="Block ads and trackers"
            hint="Built-in filter list, enforced at the network layer. No remote lists are ever fetched."
            checked={state.enabled}
            onChange={setEnabled}
          />
        </div>
      </div>

      <div>
        <h3
          className="mb-2 text-[13px] font-semibold"
          style={{ color: "var(--nt-text-1)" }}
        >
          Allowed sites
        </h3>
        <p
          className="mb-3 text-[12px]"
          style={{ color: "var(--nt-text-3)" }}
        >
          Ads are allowed on these sites. Click the shield in the toolbar to
          add or remove the current site.
        </p>
        {state.allowedHosts.length === 0 ? (
          <p
            className="text-[12px]"
            style={{ color: "var(--nt-text-3)" }}
          >
            No exceptions — ads are blocked everywhere.
          </p>
        ) : (
          <div className="space-y-1.5">
            {state.allowedHosts.map((host) => (
              <div
                key={host}
                className="nt-r-sm flex items-center justify-between border px-3 py-1.5"
                style={{ borderColor: "var(--nt-border)" }}
              >
                <span
                  className="nt-mono truncate text-[12px]"
                  style={{ color: "var(--nt-text-2)" }}
                >
                  {host}
                </span>
                <button
                  title={`Block ads on ${host}`}
                  onClick={() => removeHost(host)}
                  className="nt-r-sm p-1 transition-colors hover:bg-[var(--nt-bg-hover)]"
                  style={{ color: "var(--nt-text-3)" }}
                >
                  <X size={13} strokeWidth={1.75} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div>
        <p className="text-[13px]" style={{ color: "var(--nt-text-1)" }}>
          {label}
        </p>
        <p className="text-[12px]" style={{ color: "var(--nt-text-3)" }}>
          {hint}
        </p>
      </div>
      <button
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className="nt-r-full relative h-6 w-11 shrink-0 transition-colors"
        style={{ background: checked ? "var(--nt-accent)" : "var(--nt-border-strong)" }}
      >
        <span
          className="nt-r-full absolute top-0.5 h-5 w-5 bg-white transition-all"
          style={{ left: checked ? "22px" : "2px" }}
        />
      </button>
    </div>
  );
}
