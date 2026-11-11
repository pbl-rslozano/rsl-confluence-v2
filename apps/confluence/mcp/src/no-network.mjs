/**
 * no-network.mjs — defence in depth for the read-only analyst server.
 *
 * The server code never imports a network or process module (enforced by
 * test/no-network.test.mjs, which scans every file in src/). This module also
 * replaces the web-platform network globals with functions that throw, so a
 * future edit or a library cannot reach the network through them by accident.
 * Node's `http`, `https`, `net`, `tls`, `dgram` and `child_process` are
 * never imported here. The stdio transport works through process.stdin and
 * process.stdout.
 */

// The only place the blocked names appear; the static test strips this line.
const BLOCKED_GLOBALS = ["fetch", "WebSocket", "EventSource", "XMLHttpRequest", "WebSocketStream"];

export function installNetworkGuard(target = globalThis) {
  for (const name of BLOCKED_GLOBALS) {
    const blocked = function blockedNetworkGlobal() {
      throw new Error(`Network access is disabled in the rsL Confluence analyst server (${name}).`);
    };
    try {
      Object.defineProperty(target, name, { value: blocked, writable: false, configurable: false, enumerable: false });
    } catch {
      // Already locked by an earlier call: nothing to do.
    }
  }
  return BLOCKED_GLOBALS.length;
}

export const BLOCKED_GLOBAL_COUNT = BLOCKED_GLOBALS.length;
