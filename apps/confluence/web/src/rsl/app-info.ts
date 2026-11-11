/**
 * App passport — rsL Confluence Terminal (personal edition).
 * Brand strings here are never translated (identity skill, rule 4).
 */
export const APP = {
  name: "Confluence Terminal",
  code: "CONF",
  version: "2.7.0",
  year: 2026,
  build: "20261111",
  subtitleKey: "app.subtitle",
  category: "Console",
  /** Personal edition: no customer licensing layer, no corporate credit or confidentiality line (ADR-0004). */
  edition: "personal",
  credit: "Created by rsLozano",
  contactSubject: "Confluence Terminal",
  coreKit: "rsL Core Kit v1.0 2026",
} as const;

/** Storage collections (StoragePort document model, table rsl_docs). */
// The signal ledger is stored separately (lib/signal-ledger.ts) and exported as CSV/JSON, not in backups.
export const COLLECTIONS = ["meta", "identity", "preferences", "audit", "audit_meta"] as const;

/** Personal default for Customer Name Recall: the "customer" is the owner's own workspace. */
export const PERSONAL_IDENTITY = {
  customer: { legalName: "rsLozano — Personal trading desk", shortName: "Personal", code: "PERS", logo: null, site: "" },
  operator: { id: null, displayName: "", role: "Trader", preferredLang: "en" },
  recent: [],
};
