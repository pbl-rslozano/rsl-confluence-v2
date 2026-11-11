/**
 * shell-fullscreen.ts — v2.7 (plan WP14.3). The chart's full-screen button asks the
 * native shell for help through this one hook, registered at boot from the adapters
 * (only packages/adapters imports @tauri-apps / @capacitor):
 *   - desktop (Tauri): the window goes full screen (core:window:allow-set-fullscreen);
 *   - phones (Capacitor): the status bar is hidden while the chart fills the screen;
 *   - web: no hook — the Fullscreen API or the Focus view is used directly.
 */
export interface ShellFullscreen {
  /** "tauri" | "capacitor" — shells whose WebView element fullscreen is not relied on. */
  shell: string;
  set(on: boolean): Promise<void>;
}

let hook: ShellFullscreen | null = null;

export function registerShellFullscreen(next: ShellFullscreen | null | undefined): void {
  hook = next ?? null;
}

export function shellFullscreen(): ShellFullscreen | null {
  return hook;
}
