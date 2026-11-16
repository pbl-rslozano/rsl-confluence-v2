/**
 * radar-keys.ts — v2.8 Step 4a (plan WP25, Task 6): when the R key toggles the Radar panel. Framework-free and duck-typed
 * (no DOM classes), so it runs under plain Node in the unit tests.
 */
interface ElementLike {
  tagName?: unknown;
  isContentEditable?: unknown;
  closest?: (selector: string) => unknown;
}

const EDITABLE_ROLES = '[contenteditable=""],[contenteditable="true"],[role="textbox"],[role="combobox"],[role="listbox"],[role="option"],[role="searchbox"],[role="menu"],[role="menuitem"]';
/** Any other open overlay: a dialog (not the radar itself), an alert dialog or a menu. */
export const OTHER_OVERLAY = '[role="dialog"]:not([data-testid="radar-panel"]), [role="alertdialog"], [role="menu"]';

/** An element the user types into (or picks from by letter): the R key must not toggle the panel there. */
export function isEditableTarget(target: unknown): boolean {
  const el = target as ElementLike | null;
  if (!el || typeof el !== "object" || typeof el.tagName !== "string") return false;
  const tag = el.tagName.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable === true) return true;
  return typeof el.closest === "function" && !!el.closest(EDITABLE_ROLES);
}

export interface KeyLike { key: string; repeat?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; defaultPrevented?: boolean; target?: unknown }
export interface DocLike { activeElement?: unknown; querySelector(selector: string): unknown }

/** True when this key event should toggle the Radar panel. */
export function shouldToggleRadar(e: KeyLike, doc: DocLike): boolean {
  if (e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return false;
  if (e.key !== "r" && e.key !== "R") return false;
  if (isEditableTarget(e.target) || isEditableTarget(doc.activeElement)) return false;
  if (doc.querySelector(OTHER_OVERLAY)) return false;
  return true;
}
