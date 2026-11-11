/** @rsl/adapter-web — browser / PWA: no native plugins. Storage falls back to IndexedDB → localStorage → memory. */
export async function createAdapters() {
  return { shell: 'web' };
}
