import type { CapacitorConfig } from "@capacitor/cli";

/**
 * rsL Confluence Terminal — Capacitor 8 shell. The web core is the same static export the
 * desktop and PWA ship (BUILD_TARGET=capacitor). Security per builder skill §6.
 */
const config: CapacitorConfig = {
  appId: "com.rslozano.confluence",
  appName: "rsL Confluence",
  webDir: "../web/out",
  loggingBehavior: "none",
  android: {
    allowMixedContent: false,
    backgroundColor: "#0B1B33",
    webContentsDebuggingEnabled: false,
  },
  ios: {
    backgroundColor: "#0B1B33",
    contentInset: "always",
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    SplashScreen: { launchShowDuration: 600, backgroundColor: "#0B1B33", showSpinner: false },
    StatusBar: { backgroundColor: "#0B1B33", style: "DARK", overlaysWebView: false },
    CapacitorSQLite: {
      iosDatabaseLocation: "Library/CapacitorDatabase",
      iosIsEncryption: false,
      androidIsEncryption: false,
    },
  },
};

export default config;
