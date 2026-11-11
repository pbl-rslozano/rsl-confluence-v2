import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const eslintConfig = [...nextCoreWebVitals, ...nextTypescript, {
  rules: {
    // TypeScript rules
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/no-unused-vars": "off",
    "@typescript-eslint/no-non-null-assertion": "off",
    "@typescript-eslint/ban-ts-comment": "off",
    "@typescript-eslint/prefer-as-const": "off",
    "@typescript-eslint/no-unused-disable-directive": "off",
    
    // React rules
    "react-hooks/exhaustive-deps": "off",
    "react-hooks/purity": "off",
    "react/no-unescaped-entities": "off",
    "react/display-name": "off",
    "react/prop-types": "off",
    "react-compiler/react-compiler": "off",
    
    // Next.js rules
    "@next/next/no-img-element": "off",
    "@next/next/no-html-link-for-pages": "off",
    
    // General JavaScript rules
    "prefer-const": "off",
    "no-unused-vars": "off",
    "no-console": "off",
    "no-debugger": "off",
    "no-empty": "off",
    "no-irregular-whitespace": "off",
    "no-case-declarations": "off",
    "no-fallthrough": "off",
    "no-mixed-spaces-and-tabs": "off",
    "no-redeclare": "off",
    "no-undef": "off",
    "no-unreachable": "off",
    "no-useless-escape": "off",
  },
}, {
  // Ports and adapters (builder skill rule 3): the web core never imports native shell
  // plugins. Only packages/adapters/* may; the core loads them through boot.loadAdapters().
  files: ["src/**/*.{ts,tsx,js,mjs}"],
  rules: {
    "no-restricted-imports": ["error", { patterns: [
      { group: ["@tauri-apps/*"], message: "Import Tauri plugins only in packages/adapters/tauri." },
      { group: ["@capacitor/*", "@capacitor-community/*"], message: "Import Capacitor plugins only in packages/adapters/capacitor." },
    ] }],
  },
}, {
  // confluence-terminal-2.01/ is a standalone CommonJS/UMD launcher package,
  // not part of the Next.js app; linting it with the app's TS rules broke
  // `npm run lint` (and therefore CI) in Build 2.01.
  ignores: ["node_modules/**", ".next/**", "out/**", "dist-minified/**", "build/**", "release/**", "next-env.d.ts", "examples/**", "skills", "android/**", "ios/**", "scripts/**", "confluence-terminal-2.01/**", "src/rsl/i18n/*.json"]
}];

export default eslintConfig;
