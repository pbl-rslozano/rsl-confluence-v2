"use client";

/**
 * RslContext — mounts the rsL boot sequence once and exposes platform, storage, audit,
 * identity (Customer Name Recall) and i18n to the app. Children render only after boot,
 * so preferences, identity and language are ready on first paint of the terminal.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Identity } from "@rsl/core-kit/core/rsl-identity.js";
import { applyToDocument, getLanguage } from "@rsl/core-kit/core/rsl-i18n.js";
import { boot, loadAdapters, type BootResult } from "./boot";
import { bindPreferencesPort } from "@/lib/preferences-store";
import { Splash } from "./components/Splash";
import { FirstRunWizard } from "./components/FirstRunWizard";
import { UpdateProvider } from "./UpdateContext";

interface RslValue extends BootResult {
  t: (key: string, vars?: Record<string, unknown>) => string;
  lang: string;
  setLang: (code: string) => Promise<void>;
  id: Identity;
  setIdentity: (next: Identity) => Promise<{ ok: boolean; errors: string[] }>;
  announce: (msg: string) => void;
  online: boolean;
  lastBackupAt: string | null;
  markBackup: () => Promise<void>;
  /** Native menu actions (Tauri): about, settings, backup.export, backup.restore, refresh, contact. */
  onMenuAction: (fn: (id: string) => void) => () => void;
  openExternal: (url: string) => void;
}

const Ctx = createContext<RslValue | null>(null);

export function useRsl(): RslValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useRsl() outside <RslProvider>");
  return v;
}

export function RslProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<BootResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lang, setLangState] = useState("en");
  const [id, setId] = useState<Identity | null>(null);
  const [splashDone, setSplashDone] = useState(false);
  const [wizard, setWizard] = useState(false);
  const [online, setOnline] = useState(true);
  const [lastBackupAt, setLastBackupAt] = useState<string | null>(null);
  const [live, setLive] = useState("");
  const started = useRef(false);
  // A stable Set (not a ref) so handlers can be read from callbacks without touching refs in render.
  const [menuHandlers] = useState(() => new Set<(id: string) => void>());

  useEffect(() => {
    if (started.current) return; // React strict mode double-invokes effects in development
    started.current = true;
    (async () => {
      try {
        const adapters = await loadAdapters();
        const result = await boot(adapters);
        await bindPreferencesPort(result.port, {
          onSaved: (before, after) => {
            const changed = Object.keys(after).filter((k) => JSON.stringify((before as never)?.[k]) !== JSON.stringify((after as never)[k]));
            if (!changed.length) return;
            void result.audit.append({ actorId: result.identity.get().operator.id || "local", event: "preferences.update", record: "preferences", reason: `changed: ${changed.join(", ")}` });
          },
        });
        result.identity.subscribe((v) => setId(v));
        result.i18n.onChange((code) => { setLangState(code); applyToDocument(result.i18n); });
        setLangState(result.i18n.lang);
        setLastBackupAt(((await result.port.get("meta", "last-backup")) as { at?: string } | null)?.at ?? null);
        setWizard(result.firstRun);
        // Native menu (desktop) → app
        void adapters.onMenu?.((menuId) => menuHandlers.forEach((fn) => fn(menuId)));
        // Android back: close the top sheet/dialog first, then let the shell navigate or ask to exit.
        adapters.onBack?.(() => {
          const open = document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"]');
          if (!open) return false;
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
          return true;
        });
        // Desktop / mobile shells: external links leave the webview through the OS, never by navigation.
        if (adapters.openExternal) {
          const openExt = adapters.openExternal;
          document.addEventListener("click", (e) => {
            const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
            if (!a) return;
            const href = a.getAttribute("href") ?? "";
            if (/^(https?:|mailto:)/i.test(href) && !href.startsWith(window.location.origin)) {
              e.preventDefault();
              void openExt(href);
            }
          }, true);
        }
        setState(result);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  useEffect(() => {
    const up = () => setOnline(navigator.onLine);
    up();
    window.addEventListener("online", up);
    window.addEventListener("offline", up);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", up); };
  }, []);

  const announce = useCallback((msg: string) => { setLive(""); requestAnimationFrame(() => setLive(msg)); }, []);

  const value = useMemo<RslValue | null>(() => {
    if (!state || !id) return null;
    const actor = () => state.identity.get().operator.id || "local";
    return {
      ...state,
      lang,
      id,
      online,
      lastBackupAt,
      announce,
      t: (key, vars) => state.i18n.t(key, vars),
      setLang: async (code) => {
        const before = state.i18n.lang;
        state.i18n.setLang(code);
        const cur = state.identity.get();
        await state.identity.set({ ...cur, operator: { ...cur.operator, preferredLang: state.i18n.lang } });
        await state.audit.append({ actorId: actor(), event: "identity.language", record: "identity", reason: `${before} → ${state.i18n.lang}` });
        announce(state.i18n.t("live.lang", { language: getLanguage(state.i18n.lang).native }));
      },
      setIdentity: async (next) => {
        const before = state.identity.get();
        const r = await state.identity.set(next);
        if (r.ok) {
          await state.audit.append({ actorId: actor(), event: "identity.update", record: "identity", reason: "Identity edited", before: { customer: before.customer.code, name: before.customer.legalName }, after: { customer: r.value.customer.code, name: r.value.customer.legalName } });
          if (before.customer.code !== r.value.customer.code) announce(state.i18n.t("live.switched", { customer: r.value.customer.shortName }));
        }
        return r;
      },
      onMenuAction: (fn) => { menuHandlers.add(fn); return () => { menuHandlers.delete(fn); }; },
      openExternal: (url) => { if (state.adapters.openExternal) void state.adapters.openExternal(url); else window.open(url, "_blank", "noopener"); },
      markBackup: async () => {
        const at = new Date().toISOString();
        await state.port.put("meta", "last-backup", { at });
        setLastBackupAt(at);
      },
    };
  }, [state, id, lang, online, lastBackupAt, announce, menuHandlers]);

  const finishWizard = useCallback(async () => {
    if (!state) return;
    await state.port.put("meta", "first-run", { pending: false, completedAt: new Date().toISOString() });
    await state.audit.append({ actorId: state.identity.get().operator.id || "local", event: "identity.first-run", record: "identity", reason: "First-run setup completed" });
    setWizard(false);
  }, [state]);

  if (error) {
    return (
      <div role="alert" className="flex h-[100dvh] items-center justify-center bg-zinc-950 p-6 text-sm text-rose-300">
        <div className="max-w-md space-y-2">
          <p className="font-semibold">The app could not start.</p>
          <p className="font-mono text-xs text-rose-200/80">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div aria-live="polite" className="sr-only">{live}</div>
      {value && splashDone && !wizard && <Ctx.Provider value={value}><UpdateProvider>{children}</UpdateProvider></Ctx.Provider>}
      {value && splashDone && wizard && (
        <Ctx.Provider value={value}>
          <FirstRunWizard onDone={finishWizard} />
        </Ctx.Provider>
      )}
      {!splashDone && <Splash ready={!!value} value={value} onDone={() => setSplashDone(true)} />}
    </>
  );
}
