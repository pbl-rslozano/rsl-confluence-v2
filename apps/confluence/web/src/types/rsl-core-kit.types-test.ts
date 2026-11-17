/**
 * Type-level test (checked by `tsc --noEmit`, never imported by the app): the kit's brand helpers accept a missing,
 * null or undefined version / build since KIT-003 (packages/core/core/rsl-brand.js), so the declarations in
 * rsl-core-kit.d.ts must accept them too.
 */
import { buildStamp, poweredBy, semver } from "@rsl/core-kit/core/rsl-brand.js";

export const kitBrandTypeCases: string[] = [
  semver("2.7"),
  semver(2),
  semver(null),
  semver(undefined),
  buildStamp({ version: "2.7.0", build: "20261111" }),
  buildStamp({ version: "2.7.0", year: 2026, build: 20261111 }),
  buildStamp({ version: null, build: "20261111" }),
  buildStamp({ version: "2.7.0", build: undefined }),
  buildStamp({}),
  poweredBy({ name: "Confluence Terminal", version: "2.7.0", build: "20261111" }),
  poweredBy({ name: "Confluence Terminal", version: undefined, build: null }),
  poweredBy({ name: "Confluence Terminal" }),
];
