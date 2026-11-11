/**
 * rsl-platform.js — rsL Core Kit · v1.0 2026
 * Platform adapter (ports & adapters). Core code calls these functions; each shell injects
 * its native plugins at startup. This file never imports @tauri-apps/* or @capacitor/*.
 *
 *   Desktop  (Tauri 2)     : @tauri-apps/plugin-dialog + @tauri-apps/plugin-fs
 *   Mobile   (Capacitor 8+): @capacitor/filesystem + @capacitor/share
 *   PWA / browser          : showSaveFilePicker (Chromium) → Web Share (files) → <a download>
 *
 * Why it exists: WKWebView (macOS/iOS) has no File System Access API, so SheetJS/docx exports
 * that call showSaveFilePicker silently fail on Apple devices unless saving goes through here.
 */

/** Which shell and OS are we in? Pure detection, no side effects. */
export function detectPlatform(g = globalThis) {
  const ua = String(g.navigator?.userAgent || '');
  const uaPlatform = String(g.navigator?.userAgentData?.platform || g.navigator?.platform || '');
  let shell = 'browser';
  if (g.__TAURI_INTERNALS__ || g.__TAURI__) shell = 'tauri';
  else if (g.Capacitor?.isNativePlatform?.()) shell = 'capacitor';
  else if (/Electron\//.test(ua)) shell = 'electron';
  else if (g.matchMedia?.('(display-mode: standalone)').matches || g.navigator?.standalone) shell = 'pwa';

  let os = 'unknown';
  if (/Android/i.test(ua)) os = 'android';
  else if (/iPhone|iPad|iPod/i.test(ua) || (/Mac/i.test(uaPlatform) && (g.navigator?.maxTouchPoints || 0) > 1)) os = 'ios';
  else if (/Mac/i.test(uaPlatform) || /Mac OS X/i.test(ua)) os = 'macos';
  else if (/Win/i.test(uaPlatform) || /Windows/i.test(ua)) os = 'windows';
  else if (/Linux/i.test(uaPlatform)) os = 'linux';

  const coarse = !!g.matchMedia?.('(pointer: coarse)').matches;
  return { shell, os, pointer: coarse ? 'coarse' : 'fine', mobile: os === 'ios' || os === 'android' };
}

const toBytes = async (data) => (data instanceof Uint8Array ? data : typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(await data.arrayBuffer()));
const toBase64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };

/**
 * @param {object} adapters  any subset of:
 *   tauri:     { dialog: { save, open }, fs: { writeFile, readFile } }
 *   capacitor: { Filesystem, Directory, Share }
 * @returns {{ info, saveOrShare, openFile }}
 */
export function createPlatform(adapters = {}, g = globalThis) {
  const info = detectPlatform(g);

  /**
   * Save (desktop) or share (mobile) a generated file.
   * @param {Blob|Uint8Array|string} data   @param {string} filename   @param {string} mime
   * @returns {Promise<{ ok:boolean, method:string, path?:string, cancelled?:boolean }>}
   */
  async function saveOrShare(data, filename, mime = 'application/octet-stream') {
    if (info.shell === 'tauri' && adapters.tauri) {
      const { dialog, fs } = adapters.tauri;
      const ext = filename.split('.').pop();
      const path = await dialog.save({ defaultPath: filename, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
      if (!path) return { ok: false, method: 'tauri', cancelled: true };
      await fs.writeFile(path, await toBytes(data));
      return { ok: true, method: 'tauri', path };
    }
    if (info.shell === 'capacitor' && adapters.capacitor) {
      const { Filesystem, Directory, Share } = adapters.capacitor;
      const r = await Filesystem.writeFile({ path: filename, data: toBase64(await toBytes(data)), directory: Directory.Cache });
      try { await Share.share({ title: filename, files: [r.uri] }); } catch (e) { if (!/cancel/i.test(String(e?.message))) throw e; return { ok: false, method: 'capacitor-share', cancelled: true }; }
      return { ok: true, method: 'capacitor-share', path: r.uri };
    }
    const blob = data instanceof Blob ? data : new Blob([await toBytes(data)], { type: mime });
    if (g.showSaveFilePicker) {
      try {
        const h = await g.showSaveFilePicker({ suggestedName: filename });
        const w = await h.createWritable(); await w.write(blob); await w.close();
        return { ok: true, method: 'file-system-access' };
      } catch (e) { if (e?.name === 'AbortError') return { ok: false, method: 'file-system-access', cancelled: true }; }
    }
    const file = typeof File === 'function' ? new File([blob], filename, { type: mime }) : null;
    if (info.mobile && file && g.navigator?.canShare?.({ files: [file] })) {
      try { await g.navigator.share({ files: [file], title: filename }); return { ok: true, method: 'web-share' }; }
      catch (e) { if (e?.name === 'AbortError') return { ok: false, method: 'web-share', cancelled: true }; }
    }
    const a = g.document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename; a.rel = 'noopener';
    g.document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
    return { ok: true, method: 'download' };
  }

  /** Let the user pick a file to import. Returns { name, bytes } or null when cancelled. */
  async function openFile({ accept = [], maxBytes = 25 * 1024 * 1024 } = {}) {
    if (info.shell === 'tauri' && adapters.tauri) {
      const path = await adapters.tauri.dialog.open({ multiple: false, filters: accept.length ? [{ name: 'Files', extensions: accept.map((a) => a.replace(/^\./, '')) }] : [] });
      if (!path) return null;
      const bytes = await adapters.tauri.fs.readFile(path);
      if (bytes.length > maxBytes) throw new Error('The file is too large to import.');
      return { name: String(path).split(/[\\/]/).pop(), bytes };
    }
    return new Promise((resolve, reject) => {
      const input = g.document.createElement('input');
      input.type = 'file'; if (accept.length) input.accept = accept.join(',');
      input.onchange = async () => {
        const f = input.files?.[0]; if (!f) return resolve(null);
        if (f.size > maxBytes) return reject(new Error('The file is too large to import.'));
        resolve({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
      };
      input.click();
    });
  }

  return { info, saveOrShare, openFile };
}
