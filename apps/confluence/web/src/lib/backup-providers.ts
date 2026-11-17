// WP28 Task 4: the five backup providers, their public build-time configuration and where each one is available.
// Client IDs are PUBLIC identifiers (never secrets) that arrive as build-time variables and are empty by default.
// A provider without a valid client ID is "not set up yet" and is excluded from every network path. There is no
// client secret anywhere in the app.
import { UPDATE_ORIGIN } from "./update-channel";

export type BackupProviderId = "gdrive" | "onedrive" | "pcloud" | "b2" | "r2";
export type OAuthProviderId = "gdrive" | "onedrive" | "pcloud";

/** Provider names are constants, never catalog keys (brand-like strings are not translated). */
export const PROVIDER_NAMES: Record<BackupProviderId, string> = {
  gdrive: "Google Drive",
  onedrive: "Microsoft OneDrive",
  pcloud: "pCloud",
  b2: "Backblaze B2",
  r2: "Cloudflare R2",
};

export const HOSTED_ORIGIN = UPDATE_ORIGIN;
/** Where the hosted web app is sent back after sign-in. */
export const WEB_REDIRECT = HOSTED_ORIGIN + "/";
export const LOOPBACK_PORT = 48787;
/** The desktop app listens here (127.0.0.1 only) for the one sign-in redirect. Listening is not egress. */
export const LOOPBACK_REDIRECT = "http://127.0.0.1:48787/callback";
/** The phone's verified app link: the hosted page that hands the redirect to the installed app. */
export const APP_LINK_PATH = "/oauth/app/";
export const APP_LINK_REDIRECT = HOSTED_ORIGIN + APP_LINK_PATH;

export interface BackupConfig {
  clientIds: Record<OAuthProviderId, string>;
  appLink: boolean;
}

const ID_PATTERNS: Record<OAuthProviderId, RegExp> = {
  gdrive: /^[0-9]{6,20}-[a-z0-9]{20,40}\.apps\.googleusercontent\.com$/,
  onedrive: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  pcloud: /^[A-Za-z0-9]{6,64}$/,
};

function clean(p: OAuthProviderId, v: string | undefined): string {
  const s = typeof v === "string" ? v.trim() : "";
  return ID_PATTERNS[p].test(s) ? s : "";
}

/** An ID that fails its pattern becomes "" (that provider is then "not set up yet"). */
export function readBackupConfig(env: Record<string, string | undefined>): BackupConfig {
  return {
    clientIds: {
      gdrive: clean("gdrive", env.NEXT_PUBLIC_RSL_BACKUP_GDRIVE_CLIENT_ID),
      onedrive: clean("onedrive", env.NEXT_PUBLIC_RSL_BACKUP_ONEDRIVE_CLIENT_ID),
      pcloud: clean("pcloud", env.NEXT_PUBLIC_RSL_BACKUP_PCLOUD_CLIENT_ID),
    },
    appLink: env.NEXT_PUBLIC_RSL_APP_LINK === "1",
  };
}

/** Each `process.env.NEXT_PUBLIC_*` is written literally so Next inlines it at build time. */
export const BUILD_BACKUP_CONFIG: BackupConfig = readBackupConfig({
  NEXT_PUBLIC_RSL_BACKUP_GDRIVE_CLIENT_ID: process.env.NEXT_PUBLIC_RSL_BACKUP_GDRIVE_CLIENT_ID,
  NEXT_PUBLIC_RSL_BACKUP_ONEDRIVE_CLIENT_ID: process.env.NEXT_PUBLIC_RSL_BACKUP_ONEDRIVE_CLIENT_ID,
  NEXT_PUBLIC_RSL_BACKUP_PCLOUD_CLIENT_ID: process.env.NEXT_PUBLIC_RSL_BACKUP_PCLOUD_CLIENT_ID,
  NEXT_PUBLIC_RSL_APP_LINK: process.env.NEXT_PUBLIC_RSL_APP_LINK,
});

export type BackupShell = "web" | "tauri" | "capacitor";
export type Availability = "ready" | "not-set-up" | "desktop-only" | "web-desktop-only" | "needs-gateway" | "not-here";

export interface AvailabilityContext {
  shell: BackupShell;
  config: BackupConfig;
  origin: string;
  gatewayProviders: string[];
}

/** First match wins. */
export function availability(p: BackupProviderId, ctx: AvailabilityContext): Availability {
  if (p === "gdrive") {
    if (ctx.shell !== "tauri") return "desktop-only";
  } else if (p === "onedrive" || p === "pcloud") {
    if (ctx.shell === "capacitor" && !ctx.config.appLink) return "web-desktop-only";
  } else {
    if (ctx.shell === "capacitor") return "desktop-only";
    return ctx.gatewayProviders.includes(p) ? "ready" : "needs-gateway";
  }
  if (!ctx.config.clientIds[p]) return "not-set-up";
  if (ctx.shell === "web" && ctx.origin !== HOSTED_ORIGIN) return "not-here";
  return "ready";
}
