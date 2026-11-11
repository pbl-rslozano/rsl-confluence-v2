/**
 * Tauri isolation hook (security.pattern = isolation). Every IPC message from the web app
 * passes through this sandboxed iframe before it reaches Rust. Only the plugin commands the
 * app actually uses are allowed; anything else is dropped. Keep in step with capabilities/main.json.
 */
const ALLOWED = [
  /^plugin:sql\|(load|execute|select|close)$/,
  /^plugin:dialog\|(save|open)$/,
  /^plugin:fs\|(write_file|read_file)$/,
  /^plugin:opener\|open_url$/,
  /^plugin:event\|(listen|unlisten)$/,
  /^plugin:window-state\|/,
];
window.__TAURI_ISOLATION_HOOK__ = (payload) => {
  const cmd = payload && payload.cmd;
  if (typeof cmd === "string" && ALLOWED.some((re) => re.test(cmd))) return payload;
  // Rejecting by throwing: the command never reaches the Rust side.
  throw new Error(`rsL isolation: blocked IPC command ${String(cmd)}`);
};
