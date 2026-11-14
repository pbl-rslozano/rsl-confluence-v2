import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ServiceWorkerRegister } from "@/components/service-worker-register";
import { buildCsp } from "@/lib/csp";
import { RslProvider } from "@/rsl/RslContext";
import "@fontsource/space-grotesk/700.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/noto-naskh-arabic/400.css";
import "@fontsource/noto-naskh-arabic/600.css";
import "@fontsource/noto-nastaliq-urdu/400.css";

const IS_STATIC_BUILD =
  process.env.BUILD_TARGET === "capacitor" || process.env.BUILD_TARGET === "html";
// Tauri sets its own CSP header (with hashes for the bundled inline scripts) from
// tauri.conf.json, so the desktop build must not add a second, looser <meta> policy.
const STATIC_CSP = buildCsp(false);

export const metadata: Metadata = {
  title: "rsL Confluence Terminal",
  description:
    "Crypto market screener with 21 technical indicators (18 voting) and a bloc-weighted confluence signal.",
  keywords: [
    "crypto",
    "trading",
    "dashboard",
    "technical indicators",
    "confluence",
    "bitcoin",
    "binance",
  ],
  authors: [{ name: "Confluence Terminal" }],
  // Personal edition (ADR-0004, 14 Nov 2026): kept out of search results. Netlify also sends X-Robots-Tag (public/_headers).
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
  manifest: "./manifest.webmanifest",
  applicationName: "Confluence Terminal",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Confluence",
  },
  icons: {
    icon: [
      { url: "./favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "./favicon-16.png", sizes: "16x16", type: "image/png" },
      { url: "./icon.svg", type: "image/svg+xml" },
    ],
    apple: [{ url: "./apple-touch-icon.png", sizes: "180x180" }],
  },
  openGraph: {
    title: "Confluence Terminal",
    description:
      "Crypto market screener with a bloc-weighted 18-vote confluence signal.",
    type: "website",
  },
};

export const viewport: Viewport = {
  // v2.5: per-scheme defaults; lib/theme.ts applyTheme() updates them when the user picks a theme.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F5F7FA" },
    { media: "(prefers-color-scheme: dark)", color: "#0B1B33" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

/** Generated from tools/menu-fonts.lock.json — rebuild with `python3 tools/build-menu-fonts.py`. */
const MENU_FONT_FACES = "@font-face{font-family:\"rsL Menu Arab\";src:url(\"./fonts/menu/rsl-menu-arab.woff2\") format(\"woff2\");font-display:block}@font-face{font-family:\"rsL Menu Nastaliq\";src:url(\"./fonts/menu/rsl-menu-nastaliq.woff2\") format(\"woff2\");font-display:block}@font-face{font-family:\"rsL Menu Deva\";src:url(\"./fonts/menu/rsl-menu-deva.woff2\") format(\"woff2\");font-display:block}@font-face{font-family:\"rsL Menu Beng\";src:url(\"./fonts/menu/rsl-menu-beng.woff2\") format(\"woff2\");font-display:block}@font-face{font-family:\"rsL Menu SC\";src:url(\"./fonts/menu/rsl-menu-sc.woff2\") format(\"woff2\");font-display:block}@font-face{font-family:\"rsL Menu JP\";src:url(\"./fonts/menu/rsl-menu-jp.woff2\") format(\"woff2\");font-display:block}@font-face{font-family:\"rsL Menu KR\";src:url(\"./fonts/menu/rsl-menu-kr.woff2\") format(\"woff2\");font-display:block}";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" data-theme="dark" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            // v2.5 pre-paint: resolve System/Light/Dark before CSS applies (keys kept in sync with lib/theme.ts).
            __html: `(function(){var r=document.documentElement,p=null;try{p=localStorage.getItem("ct-theme-pref")||localStorage.getItem("ct-theme")}catch(e){}if(p!=="light"&&p!=="dark")p=(window.matchMedia&&matchMedia("(prefers-color-scheme: light)").matches)?"light":"dark";if(window.CSS&&CSS.supports&&!CSS.supports("color","color-mix(in lab, red, red)"))p="dark";r.dataset.theme=p;r.style.colorScheme=p;r.classList.toggle("dark",p==="dark");r.classList.toggle("ct-light",p==="light")})()`,
          }}
        />
        {/* v2.5: vendored glyph-subset fonts for the language menu's native names (tools/build-menu-fonts.py, OFL 1.1).
            Inline so the relative URLs resolve against the page (works at a root, in a subfolder and in the native shells). */}
        <style dangerouslySetInnerHTML={{ __html: MENU_FONT_FACES }} />
        {/*
          Content-Security-Policy is delivered as a real HTTP header by
          next.config.ts for server builds. Static exports (HTML / Capacitor)
          have no server to set headers, so they fall back to this meta tag.
        */}
        {IS_STATIC_BUILD && (
          <meta httpEquiv="Content-Security-Policy" content={STATIC_CSP} />
        )}
      </head>
      <body
        className="antialiased bg-background text-foreground"
      >
        <RslProvider>{children}</RslProvider>
        <Toaster />
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
