"use client";

/**
 * Canonical rsL brand block (kit brandBlockHTML): monogram → "rsL Confluence Terminal" →
 * "by rsLozano" → build stamp. Fixed order, dir="ltr", never translated (identity skill §2.3).
 * The kit escapes every string it emits.
 */
import { useMemo } from "react";
import { brandBlockHTML } from "@rsl/core-kit/core/rsl-brand.js";
import { APP } from "../app-info";

export function BrandBlock({ large = false, className = "" }: { large?: boolean; className?: string }) {
  const html = useMemo(() => brandBlockHTML({ name: APP.name, version: APP.version, year: APP.year, build: APP.build }), []);
  return <div className={`rsl-brand-host ${large ? "rsl-brand-host--large" : ""} ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
