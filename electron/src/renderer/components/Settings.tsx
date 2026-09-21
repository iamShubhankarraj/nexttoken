/**
 * Settings overlay (nt.uiSetSettingsOpen) on the new design system:
 * BYOK provider, local models, saved skills, voice & search, and the
 * per-Bit theme editor.
 *
 * The stored API key is never displayed — settingsGetProvider() only
 * reports keyConfigured, and the key field submits empty to keep the
 * existing value.
 */

import {
  Check,
  ChevronRight,
  Database,
  Import,
  KeyRound,
  Loader2,
  Mic,
  Palette,
  Plug,
  Plus,
  Search,
  Shield,
  Trash2,
  Volume2,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import {
  PROVIDER_PRESETS,
  type AdBlockState,
  type ProviderPublic,
  type ProviderId,
  type VoiceSettings,
} from "../../shared/ipc";
import { useBrowser } from "../BrowserContext";
import { nt } from "../nt";
import { openImportDialog } from "./ImportDialog";
import { ModelsPanel } from "./ModelsPanel";
import { SkillsSection } from "./SettingsSkills";
import { ThemeEditor } from "./ThemeEditor";

type Section = "provider" | "models" | "skills" | "voice" | "theme" | "privacy" | "import";

const SECTIONS: Array<{ id: Section; label: string; icon: typeof Plug }> = [
  { id: "provider", label: "AI Provider", icon: Plug },
  { id: "models", label: "Models", icon: Database },
  { id: "skills", label: "Skills", icon: Zap },
  { id: "voice", label: "Voice & Search", icon: Mic },
  { id: "privacy", label: "Privacy", icon: Shield },
  { id: "import", label: "Import", icon: Import },
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
          boxShadow: "var(--nt-shadow-overlay)",
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
            {section === "import" && <ImportSection />}
            {section === "theme" &&
              (activeSpace ? (
                <ThemeEditor spaceId={activeSpace.id} />
              ) : (
                <p className="text-[13px]" style={{ color: "var(--nt-text-3)" }}>
                  No active Bit.
                </p>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ AI providers ---------------------------- */
/*
 * Provider manager — connect multiple API gateway providers:
 * OpenAI, Anthropic, OpenRouter, Ollama, and any number of Custom
 * OpenAI-compatible endpoints. Each provider gets its own card with
 * name, endpoint, default model, secure key, enable toggle, Test, and
 * Remove. Keys live in the OS keychain via the main process (one
 * encrypted file per provider) and are never displayed or echoed.
 */

const PROVIDER_KINDS = ["openai", "anthropic", "openrouter", "ollama", "custom"] as const;

function ProviderSection() {
  const [providers, setProviders] = useState<ProviderPublic[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      setProviders(await nt().providersList());
    } catch {
      /* bridge unavailable */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const addProvider = async (presetId: ProviderId) => {
    const preset = PROVIDER_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    try {
      const list = await nt().providersSave({
        presetId,
        name: preset.name,
        baseUrl: preset.baseUrl,
        model: "",
        api: preset.api,
        apiKey: "",
        enabled: true,
      });
      setProviders(list);
    } catch {
      /* surface on the card instead */
    } finally {
      setAdding(false);
    }
  };

  if (!loaded) {
    return (
      <div>
        <p className="mb-4 text-[13px] leading-relaxed" style={{ color: "var(--nt-text-2)" }}>
          Loading providers…
        </p>
        <JevSection />
      </div>
    );
  }

  return (
    <div>
      <p className="mb-4 text-[13px] leading-relaxed" style={{ color: "var(--nt-text-2)" }}>
        Bring your own keys — connect as many AI providers as you like. The model you pick in the
        Agent tab is served from these providers; each one gets a per-key OS-keychain vault, and
        keys are never shown or logged.
      </p>

      <div className="flex flex-col gap-3">
        {providers.map((p) => (
          <ProviderCard key={p.id} provider={p} onChanged={setProviders} />
        ))}
        {providers.length === 0 && (
          <p className="nt-r-md border border-dashed px-4 py-5 text-center text-[13px]" style={{ borderColor: "var(--nt-border)", color: "var(--nt-text-3)" }}>
            No providers yet — add one below to power the agent with cloud models.
          </p>
        )}
      </div>

      {adding ? (
        <div className="nt-r-md mt-3 border p-3" style={{ borderColor: "var(--nt-border)", background: "var(--nt-bg-raised)" }}>
          <p className="nt-micro mb-2">Add a provider</p>
          <div className="flex flex-wrap gap-2">
            {PROVIDER_KINDS.map((kind) => {
              const preset = PROVIDER_PRESETS.find((p) => p.id === kind);
              if (!preset) return null;
              return (
                <button
                  key={kind}
                  onClick={() => void addProvider(kind)}
                  className="nt-r-sm border px-3 py-1.5 text-[13px] font-medium transition-colors hover:bg-[var(--nt-bg-hover)]"
                  style={{ borderColor: "var(--nt-border)", color: "var(--nt-text-1)" }}
                >
                  {preset.name}
                </button>
              );
            })}
          </div>
          <button
            onClick={() => setAdding(false)}
            className="mt-2 text-[12px] underline"
            style={{ color: "var(--nt-text-3)" }}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="nt-r-sm mt-3 flex items-center gap-1.5 border px-4 py-2 text-[13px] font-medium transition-colors hover:bg-[var(--nt-bg-hover)]"
          style={{ borderColor: "var(--nt-border)", color: "var(--nt-text-1)" }}
        >
          <Plus size={14} strokeWidth={1.75} />
          Add provider
        </button>
      )}

      {/* Jev System-One — the orchestration brain. Key in OS keychain. */}
      <JevSection />
    </div>
  );
}

/** One provider card: name, endpoint, model, key, enable toggle, test, remove. */
function ProviderCard({ provider, onChanged }: { provider: ProviderPublic; onChanged: (p: ProviderPublic[]) => void }) {
  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [model, setModel] = useState(provider.model);
  const [apiKey, setApiKey] = useState("");
  const [api, setApi] = useState<"openai" | "anthropic">(provider.api);
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testOk, setTestOk] = useState<boolean | null>(null);
  const [savedTick, setSavedTick] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const preset = PROVIDER_PRESETS.find((p) => p.id === provider.presetId);
  const needsKey = provider.needsKey;

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const list = await nt().providersSave({
        id: provider.id,
        presetId: provider.presetId,
        name,
        baseUrl,
        model,
        api,
        apiKey,
        enabled: provider.enabled,
      });
      onChanged(list);
      setApiKey("");
      setSavedTick(true);
      setTimeout(() => setSavedTick(false), 1800);
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    if (testing) return;
    setTesting(true);
    setTestResult(null);
    setTestOk(null);
    try {
      // Tests the CURRENT form values, so the user can validate before saving.
      const r = await nt().providersValidate({
        id: provider.id,
        presetId: provider.presetId,
        baseUrl,
        api,
        apiKey,
        model,
      });
      setTestOk(r.ok);
      setTestResult(r.message);
    } catch (err) {
      setTestOk(false);
      setTestResult(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };

  const toggleEnabled = async () => {
    try {
      onChanged(await nt().providersSetEnabled(provider.id, !provider.enabled));
    } catch {
      /* leave the toggle as-is */
    }
  };

  const remove = async () => {
    if (!confirmRemove) {
      setConfirmRemove(true);
      setTimeout(() => setConfirmRemove(false), 4000);
      return;
    }
    try {
      onChanged(await nt().providersRemove(provider.id));
    } catch {
      /* leave the card in place */
    }
  };

  const inputCls =
    "nt-r-sm w-full border px-3 py-2 text-[13px] outline-none transition-colors placeholder:text-[var(--nt-text-faint)] focus:border-[var(--nt-accent)]";
  const inputStyle: CSSProperties = {
    borderColor: "var(--nt-border)",
    background: "var(--nt-bg-sunken)",
    color: "var(--nt-text-1)",
  };

  return (
    <div className="nt-r-md border" style={{ borderColor: "var(--nt-border)", background: "var(--nt-bg-raised)" }}>
      {/* header row */}
      <div className="flex items-center gap-2.5 px-3.5 py-3">
        <button
          onClick={toggleEnabled}
          title={provider.enabled ? "Disable provider" : "Enable provider"}
          aria-pressed={provider.enabled}
          className="nt-r-full relative h-5.5 w-10 shrink-0 transition-colors"
          style={{
            height: 22,
            background: provider.enabled ? "var(--nt-accent)" : "var(--nt-bg-sunken)",
            border: "1px solid var(--nt-border)",
            borderRadius: 999,
          }}
        >
          <span
            className="absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full transition-all"
            style={{
              height: 14,
              width: 14,
              left: provider.enabled ? 22 : 4,
              background: provider.enabled ? "var(--nt-accent-text)" : "var(--nt-text-3)",
            }}
          />
        </button>
        <button
          onClick={() => setExpanded((e) => !e)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="truncate text-[14px] font-semibold" style={{ color: "var(--nt-text-1)" }}>
            {provider.name}
          </span>
          {provider.keyConfigured && needsKey ? (
            <span className="nt-r-full shrink-0 px-2 py-0.5 text-[10px] font-medium" style={{ background: "var(--nt-accent-soft)", color: "var(--nt-accent)" }}>
              key ✓
            </span>
          ) : needsKey ? (
            <span className="nt-r-full shrink-0 px-2 py-0.5 text-[10px] font-medium" style={{ background: "var(--nt-bg-sunken)", color: "var(--nt-text-3)" }}>
              no key
            </span>
          ) : (
            <span className="nt-r-full shrink-0 px-2 py-0.5 text-[10px] font-medium" style={{ background: "var(--nt-bg-sunken)", color: "var(--nt-text-3)" }}>
              no key needed
            </span>
          )}
          {!provider.enabled && (
            <span className="nt-r-full shrink-0 px-2 py-0.5 text-[10px] font-medium" style={{ background: "var(--nt-bg-sunken)", color: "var(--nt-text-3)" }}>
              off
            </span>
          )}
          <ChevronRight
            size={14}
            strokeWidth={1.75}
            className="shrink-0 transition-transform"
            style={{ color: "var(--nt-text-3)", transform: expanded ? "rotate(90deg)" : undefined }}
          />
        </button>
      </div>

      {expanded && (
        <div className="border-t px-3.5 pb-3.5 pt-3" style={{ borderColor: "var(--nt-border)" }}>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <FieldLabel text="Name" />
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder={preset?.name} spellCheck={false} className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <FieldLabel text="Model" />
              <input value={model} onChange={(e) => setModel(e.target.value)} placeholder={preset?.modelHint || "model-id"} spellCheck={false} className={inputCls} style={inputStyle} />
            </label>
          </div>
          <label className="mt-3 block">
            <FieldLabel text="Base URL" hint="Local Ollama: keep http://localhost:11434/v1" />
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={preset?.baseUrl || "https://…"} spellCheck={false} className={inputCls} style={inputStyle} />
          </label>
          {provider.presetId === "custom" && (
            <label className="mt-3 block">
              <FieldLabel text="API style" hint="How this endpoint speaks" />
              <div className="nt-r-sm flex overflow-hidden border" style={{ borderColor: "var(--nt-border)" }}>
                {(["openai", "anthropic"] as const).map((k) => (
                  <button
                    key={k}
                    onClick={() => setApi(k)}
                    className="flex-1 px-3 py-1.5 text-[13px] font-medium transition-colors"
                    style={{
                      background: api === k ? "var(--nt-accent-soft)" : "transparent",
                      color: api === k ? "var(--nt-accent)" : "var(--nt-text-2)",
                    }}
                  >
                    {k === "openai" ? "OpenAI-compatible" : "Anthropic"}
                  </button>
                ))}
              </div>
            </label>
          )}
          {needsKey && (
            <label className="mt-3 block">
              <FieldLabel text="API key" hint={provider.keyConfigured ? "A key is stored. Leave blank to keep it." : "Stored securely by the main process."} />
              <div className="relative">
                <KeyRound size={14} strokeWidth={1.75} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2" style={{ color: "var(--nt-text-3)" }} />
                <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={provider.keyConfigured ? "•••••••• (stored)" : "paste key…"} spellCheck={false} autoComplete="off" className={`${inputCls} pl-9`} style={inputStyle} />
              </div>
            </label>
          )}
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
              {testing ? <Loader2 size={14} strokeWidth={1.75} className="animate-spin" /> : <Plug size={14} strokeWidth={1.75} />}
              Test connection
            </button>
            <span className="flex-1" />
            <button
              onClick={() => void remove()}
              className="nt-r-sm flex items-center gap-1.5 border px-3 py-2 text-[13px] font-medium transition-colors hover:bg-[var(--nt-bg-hover)]"
              style={{ borderColor: confirmRemove ? "#d97362" : "var(--nt-border)", color: confirmRemove ? "#d97362" : "var(--nt-text-2)" }}
            >
              <Trash2 size={14} strokeWidth={1.75} />
              {confirmRemove ? "Sure?" : "Remove"}
            </button>
          </div>
          {testResult && (
            <p className="mt-3 text-[13px]" style={{ color: testOk === true ? "#6fa287" : testOk === false ? "#d97362" : "var(--nt-text-2)" }}>
              {testResult}
            </p>
          )}
        </div>
      )}
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
  const [voice, setVoice] = useState<VoiceSettings>({
    enabled: false,
    speakReplies: false,
    voiceControl: false,
    cleanupEnabled: true,
    quickCleanMaxWords: 12,
    micDeviceId: "",
  });
  const [engine, setEngine] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [savedTick, setSavedTick] = useState(false);
  const [mics, setMics] = useState<{ deviceId: string; label: string }[]>([]);
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
    // Microphone picker (labels need mic permission; fall back to numbered names).
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((ds) => {
        if (!alive) return;
        const inputs = ds.filter((d) => d.kind === "audioinput");
        setMics(
          inputs.map((d, i) => ({
            deviceId: d.deviceId,
            label: d.label || `Microphone ${i + 1}`,
          })),
        );
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const setVoiceCfg = (next: VoiceSettings) => {
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
          <ToggleRow
            label="Clean up transcripts"
            hint="Remove filler words and false starts before the agent acts (“um”, stutters, repeats)"
            checked={voice.cleanupEnabled}
            onChange={(v) => setVoiceCfg({ ...voice, cleanupEnabled: v })}
          />
        </div>

        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[12px] font-medium" style={{ color: "var(--nt-text-2)" }}>
              Quick-clean word limit
            </span>
            <input
              type="number"
              min={4}
              max={40}
              value={voice.quickCleanMaxWords}
              onChange={(e) => {
                const n = Math.max(4, Math.min(40, Number(e.target.value) || 12));
                setVoiceCfg({ ...voice, quickCleanMaxWords: n });
              }}
              className="nt-r-sm w-full border bg-[var(--nt-bg-base)] px-3 py-2 text-[13px] outline-none focus:border-[var(--nt-accent)]"
              style={{ borderColor: "var(--nt-border)", color: "var(--nt-text-1)" }}
            />
            <span className="mt-1 block text-[11px]" style={{ color: "var(--nt-text-3)" }}>
              Short utterances are cleaned instantly; longer ones go through the model.
            </span>
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] font-medium" style={{ color: "var(--nt-text-2)" }}>
              Microphone
            </span>
            <select
              value={voice.micDeviceId}
              onChange={(e) => setVoiceCfg({ ...voice, micDeviceId: e.target.value })}
              className="nt-r-sm w-full border bg-[var(--nt-bg-base)] px-3 py-2 text-[13px] outline-none focus:border-[var(--nt-accent)]"
              style={{ borderColor: "var(--nt-border)", color: "var(--nt-text-1)" }}
            >
              <option value="">System default</option>
              {mics.map((m) => (
                <option key={m.deviceId} value={m.deviceId}>
                  {m.label}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[11px]" style={{ color: "var(--nt-text-3)" }}>
              Used for on-device voice capture.
            </span>
          </label>
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
            "“switch to <Bit>”",
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

function ImportSection() {
  const [loginsCount, setLoginsCount] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    nt()
      .importLoginsCount()
      .then((n) => {
        if (alive) setLoginsCount(n);
      })
      .catch(() => {
        if (alive) setLoginsCount(0);
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h3
          className="mb-2 flex items-center gap-2 text-[13px] font-semibold"
          style={{ color: "var(--nt-text-1)" }}
        >
          <Import size={14} strokeWidth={1.75} /> Import from another browser
        </h3>
        <p className="mb-3 text-[12px]" style={{ color: "var(--nt-text-3)" }}>
          Bring bookmarks, open &amp; pinned tabs, and saved passwords from Arc,
          Chrome, Brave, Edge, Safari, or Firefox into the current Bit. Nothing
          is read until you choose to import — duplicates are skipped, never
          overwritten.
        </p>
        <button
          onClick={openImportDialog}
          className="nt-r-md flex items-center gap-2 px-4 py-2 text-[13px] font-semibold"
          style={{ background: "var(--nt-accent)", color: "white" }}
        >
          <Import size={14} />
          Import from another browser
        </button>
      </div>
      <div>
        <h3
          className="mb-2 flex items-center gap-2 text-[13px] font-semibold"
          style={{ color: "var(--nt-text-1)" }}
        >
          <KeyRound size={14} strokeWidth={1.75} /> Imported passwords
        </h3>
        <p className="text-[12px]" style={{ color: "var(--nt-text-3)" }}>
          {loginsCount === null
            ? "Checking…"
            : loginsCount === 0
              ? "No passwords imported yet. They are stored encrypted in this Mac's keychain."
              : `${loginsCount} logins stored encrypted in this Mac's keychain.`}
        </p>
      </div>
    </div>
  );
}

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
