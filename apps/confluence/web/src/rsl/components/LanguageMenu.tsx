"use client";

/**
 * Language menu — the 18 rsL languages in fixed order; flag + native + English name,
 * searchable, keyboard navigable (↑/↓, Enter, Esc). Draft catalogs are labelled.
 * v2.5: native names use vendored subset fonts (`.lang-native`); a bottom sheet below 640 px.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Languages } from "lucide-react";
import { LANGUAGES } from "@rsl/core-kit/core/rsl-i18n.js";
import { useRsl } from "../RslContext";
import { Flag } from "./Flags";
import { useMediaQuery, PHONE_QUERY } from "@/lib/use-media-query";

export function LanguageMenu({ inline = false, onPicked }: { inline?: boolean; onPicked?: () => void }) {
  const { lang, setLang, t, i18n } = useRsl();
  const [open, setOpen] = useState(inline);
  const [q, setQ] = useState("");
  const [activeCode, setActiveCode] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const isPhone = useMediaQuery(PHONE_QUERY);
  const sheet = isPhone && !inline;

  const items = useMemo(() => {
    const s = q.trim().toLowerCase();
    return LANGUAGES.filter((l) => !s || l.native.toLowerCase().includes(s) || l.english.toLowerCase().includes(s) || l.code.includes(s));
  }, [q]);

  // Highlighted row is tracked by language code and derived per render (no state sync in effects).
  const activeIdx = items.findIndex((l) => l.code === (activeCode ?? lang));
  const active = activeIdx < 0 ? 0 : activeIdx;
  const setActive = (i: number | ((a: number) => number)) => {
    const next = typeof i === "function" ? i(active) : i;
    setActiveCode(items[Math.max(0, Math.min(items.length - 1, next))]?.code ?? null);
  };
  useEffect(() => {
    if (!open || inline) return;
    // The phone sheet is portalled to <body>, so clicks inside it are not inside boxRef.
    const close = (e: MouseEvent) => { const n = e.target as Node; if (!boxRef.current?.contains(n) && !panelRef.current?.contains(n)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open, inline]);

  const pick = async (code: string) => {
    await setLang(code);
    if (!inline) { setOpen(false); triggerRef.current?.focus(); }
    onPicked?.();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter" && items[active]) { e.preventDefault(); void pick(items[active].code); }
    else if (e.key === "Escape" && !inline) { e.preventDefault(); e.stopPropagation(); setOpen(false); triggerRef.current?.focus(); }
  };
  useEffect(() => { listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" }); }, [active]);
  const current = LANGUAGES.find((l) => l.code === lang)!;

  const panel = (
    <div
      ref={panelRef}
      data-lang-sheet={sheet ? "" : undefined}
      className={inline ? "w-full"
        : sheet ? "fixed inset-x-0 bottom-0 z-[61] max-h-[75dvh] rounded-t-xl border-t border-zinc-700 bg-zinc-900 p-3 shadow-2xl"
        : "absolute end-0 top-9 z-50 w-72 rounded-lg border border-zinc-700 bg-zinc-900 p-2 shadow-2xl"}
      style={sheet ? { paddingBottom: "max(env(safe-area-inset-bottom), 12px)" } : undefined}
      onKeyDown={onKey}>
      <input
        autoFocus={!inline}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t("lang.search")}
        aria-label={t("lang.search")}
        aria-controls="rsl-lang-list"
        aria-activedescendant={items[active] ? `rsl-lang-${items[active].code}` : undefined}
        className="mb-2 h-9 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 text-sm text-zinc-100 placeholder:text-zinc-500"
      />
      <ul id="rsl-lang-list" ref={listRef} role="listbox" aria-label={t("ctl.language")} className={`overflow-y-auto ${inline ? "max-h-72" : sheet ? "max-h-[60dvh]" : "max-h-80"}`}>
        {items.map((l, i) => (
          <li
            key={l.code}
            id={`rsl-lang-${l.code}`}
            data-i={i}
            role="option"
            aria-selected={l.code === lang}
            onMouseEnter={() => setActive(i)}
            onClick={() => void pick(l.code)}
            className={`flex min-h-11 cursor-pointer items-center gap-2.5 rounded-md px-2 text-sm [@media(pointer:coarse)]:min-h-12 ${i === active ? "bg-zinc-800" : ""} ${l.code === lang ? "text-cyan-300" : "text-zinc-200"}`}
          >
            <Flag code={l.flag} />
            <span lang={l.code} dir={l.dir} className="lang-native font-medium">{l.native}</span>
            <span className="text-xs text-zinc-400">{l.english}</span>
            {i18n.status(l.code) === "DRAFT" && <span className="ms-auto rounded border border-amber-500/40 px-1 text-[10px] uppercase text-amber-300">{t("lang.draft")}</span>}
            {i18n.status(l.code) === "MACHINE-CHECKED" && <span className="ms-auto rounded border border-sky-500/40 px-1 text-[10px] text-sky-300">{t("lang.machineChecked")}</span>}
            {i18n.status(l.code) === "CERTIFIED" && <span className="ms-auto rounded border border-emerald-500/40 px-1 text-[10px] text-emerald-300">{t("lang.certified")}</span>}
          </li>
        ))}
      </ul>
    </div>
  );

  if (inline) return panel;
  return (
    <div ref={boxRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${t("ctl.language")}: ${current.native}`}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2 text-xs text-zinc-300 hover:bg-zinc-800"
      >
        <Flag code={current.flag} />
        <span className="hidden xl:inline">{current.native}</span>
        <Languages className="h-3.5 w-3.5 xl:hidden" />
      </button>
      {/* Phones: the sheet is portalled to <body> — the header's backdrop-filter would otherwise contain fixed children. */}
      {open && sheet && createPortal(<><div aria-hidden="true" className="fixed inset-0 z-[60] bg-black/50" onClick={() => setOpen(false)} />{panel}</>, document.body)}
      {open && !sheet && panel}
    </div>
  );
}
