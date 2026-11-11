import type { NextConfig } from "next";
import { buildCsp } from "./src/lib/csp";

import path from "node:path";

// Static targets: "html" (PWA / browser), "capacitor" (iOS / Android), "tauri" (Windows / macOS).
const isStaticBuild = ["capacitor", "html", "tauri"].includes(process.env.BUILD_TARGET ?? "");
const isNetlify = process.env.NETLIFY === "true";
const isDev = process.env.NODE_ENV === "development";

const nextConfig: NextConfig = {
  assetPrefix: isStaticBuild ? "." : undefined,
  // Netlify's OpenNext adapter expects the standard `.next` layout. The
  // standalone server output remains useful for self-hosted deployments.
  output: isStaticBuild ? "export" : isNetlify ? undefined : "standalone",
  trailingSlash: isStaticBuild,
  // Build 2.02: the client decides its market-data path from this, not from the
  // URL scheme. Static exports contain no /api routes, so they fetch directly.
  env: {
    NEXT_PUBLIC_BUILD_TARGET: isStaticBuild ? (process.env.BUILD_TARGET as string) : "server",
  },
  images: { unoptimized: true },
  // v2.6 WP8: never emit browser source maps (BG-1, release check R17). Stated explicitly so a
  // default change in Next cannot ship maps; tools/protect-build.mjs also deletes any stray *.map.
  productionBrowserSourceMaps: false,
  // Monorepo: the rsL Core Kit and shell adapters are plain ES-module workspace packages.
  transpilePackages: ["@rsl/core-kit", "@rsl/adapter-web", "@rsl/adapter-tauri", "@rsl/adapter-capacitor"],
  turbopack: { root: path.join(__dirname, "../../..") },
  outputFileTracingRoot: path.join(__dirname, "../../.."),
  // Strict mode surfaces effect-cleanup bugs via double-render in development.
  // The scan abort/interval logic in page.tsx is exactly the kind of code that
  // needs it.
  reactStrictMode: true,

  // `headers()` is not supported by `output: "export"`. For the static HTML and
  // Capacitor targets the policy is emitted as a <meta> tag in layout.tsx
  // instead — weaker, but it is the only mechanism available without a server.
  ...(isStaticBuild
    ? {}
    : {
        async headers() {
          return [
            {
              source: "/:path*",
              headers: [
                { key: "Content-Security-Policy", value: buildCsp(isDev) },
                { key: "X-Content-Type-Options", value: "nosniff" },
                { key: "Referrer-Policy", value: "no-referrer" },
                { key: "X-Frame-Options", value: "DENY" },
                { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
                { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
              ],
            },
          ];
        },
      }),
};

export default nextConfig;
