/*
 * Platform adapter: the same page runs in a browser (localStorage + blob
 * downloads) and inside the WebView2 desktop host (message bridge).
 * Note content is never logged; errors carry only a reason.
 */
(function (root, factory) {
  'use strict';
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else (root.NP = root.NP || {}).platformFactory = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_DESKTOP_CHARS = 64 * 1024 * 1024;
  const DEFAULT_TIMEOUT_MS = 15000;

  class PlatformError extends Error {
    constructor(reason, message) {
      super(message || reason);
      this.name = 'PlatformError';
      this.reason = reason;
    }
  }

  const isQuota = (err) => !!err && (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED' || err.code === 22 || err.code === 1014);
  const wellFormed = (s) => s.toWellFormed();

  function createPlatform(env, opts = {}) {
    const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    const storageKey = opts.storageKey || 'cyberpad.v1';
    const legacyKeys = Array.isArray(opts.legacyKeys) ? opts.legacyKeys : ['neonpad.v1'];

    const webview = env.chrome && env.chrome.webview;
    const isDesktop = !!webview && typeof webview.postMessage === 'function';
    const maxStateChars = isDesktop ? MAX_DESKTOP_CHARS : Infinity;

    const pending = new Map(); // id -> { resolve, reject, timer, accept }
    let flushHandler = null;

    function newId() {
      const bytes = env.crypto.getRandomValues(new Uint8Array(8));
      return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    }

    function settle(id) {
      const p = pending.get(id);
      if (!p) return null;
      pending.delete(id);
      if (p.timer !== null) env.clearTimeout(p.timer);
      return p;
    }

    async function runFlush() {
      try {
        if (flushHandler) await flushHandler();
      } catch (err) {
        console.error('flush handler failed', err && err.name);
      } finally {
        webview.postMessage({ type: 'flushed' });
      }
    }

    function onMessage(ev) {
      const m = ev && ev.data;
      if (!m || typeof m !== 'object' || typeof m.type !== 'string') return;
      if (m.type === 'flush') { runFlush(); return; }
      if (typeof m.id !== 'string') return;
      const p = settle(m.id);
      if (!p) return; // unknown or already settled
      const reason = typeof m.reason === 'string' ? m.reason : 'host';
      if (m.type === 'rejected' || m.type === 'saveFailed' || m.type === 'exportFailed') p.reject(new PlatformError('host', reason));
      else p.accept(m, p.resolve, p.reject);
    }

    if (isDesktop && typeof webview.addEventListener === 'function') webview.addEventListener('message', onMessage);

    /** Post a message with a fresh id; `accept(reply, resolve, reject)` handles the matching reply. */
    function request(type, fields, accept, { timeout = true } = {}) {
      return new Promise((resolve, reject) => {
        const id = newId();
        const entry = { resolve, reject, accept, timer: null };
        if (timeout) {
          entry.timer = env.setTimeout(() => {
            if (pending.get(id) === entry) { pending.delete(id); reject(new PlatformError('timeout')); }
          }, timeoutMs);
        }
        pending.set(id, entry);
        try {
          webview.postMessage({ type, id, ...fields });
        } catch (err) {
          settle(id);
          reject(new PlatformError('host', err && err.name));
        }
      });
    }

    const expect = (type, map) => (m, resolve, reject) => (
      m.type === type ? resolve(map ? map(m) : undefined) : reject(new PlatformError('host', 'unexpected reply'))
    );

    // ---------------------------------------------------------------- load

    async function loadState() {
      if (isDesktop) {
        return request('load', {}, expect('loaded', (m) => ({
          main: typeof m.main === 'string' ? m.main : null,
          backup: typeof m.backup === 'string' ? m.backup : null,
          legacyKey: null,
          storageOk: true,
          version: typeof m.version === 'string' ? m.version : null,
          dataDir: typeof m.dataDir === 'string' ? m.dataDir : null,
        })));
      }
      const out = { main: null, backup: null, legacyKey: null, storageOk: true, version: null, dataDir: null };
      try {
        out.main = env.localStorage.getItem(storageKey);
        if (out.main === null) {
          for (const key of legacyKeys) {
            const legacy = env.localStorage.getItem(key);
            if (legacy !== null) { out.main = legacy; out.legacyKey = key; break; }
          }
        }
      } catch (err) {
        out.storageOk = false;
        out.main = null;
        out.legacyKey = null;
        console.error('storage unavailable', err && err.name);
      }
      return out;
    }

    // ---------------------------------------------------------------- save

    async function saveState(text) {
      if (typeof text !== 'string') throw new PlatformError('host', 'invalid state');
      if (text.length > maxStateChars) throw new PlatformError('too-large');
      if (isDesktop) return request('save', { data: wellFormed(text) }, expect('saved'));
      try {
        env.localStorage.setItem(storageKey, text);
      } catch (err) {
        if (isQuota(err)) throw new PlatformError('quota');
        throw new PlatformError('host', err && err.name);
      }
      return undefined;
    }

    function removeLegacy(key) {
      if (isDesktop) return;
      try { env.localStorage.removeItem(key); } catch (err) { console.error('storage unavailable', err && err.name); }
    }

    async function quarantine(raw) {
      if (isDesktop) return request('quarantine', {}, expect('quarantined'));
      try {
        env.localStorage.setItem(`${storageKey}.unreadable-${Date.now()}`, raw);
      } catch (err) {
        if (isQuota(err)) throw new PlatformError('quota');
        throw new PlatformError('host', err && err.name);
      }
      return undefined;
    }

    // -------------------------------------------------------------- export

    async function exportFile({ kind, suggestedName, text, mime }) {
      if (typeof text !== 'string') throw new PlatformError('host', 'invalid text');
      if (isDesktop) {
        if (text.length > maxStateChars) throw new PlatformError('too-large');
        // No mime (the host rejects extra fields) and no timeout (it waits for the user).
        return request('exportFile', { kind, suggestedName, text: wellFormed(text) }, (m, resolve, reject) => {
          if (m.type === 'exported') resolve({ saved: true, name: typeof m.name === 'string' ? m.name : suggestedName });
          else if (m.type === 'exportCancelled') resolve({ saved: false, name: null });
          else reject(new PlatformError('host', 'unexpected reply'));
        }, { timeout: false });
      }
      const BlobCtor = env.Blob || Blob;
      const url = env.URL.createObjectURL(new BlobCtor([text], { type: mime }));
      try {
        const a = env.document.createElement('a');
        a.href = url;
        a.download = suggestedName;
        a.hidden = true;
        env.document.body.append(a);
        a.click();
        a.remove();
      } finally {
        env.setTimeout(() => env.URL.revokeObjectURL(url), 2000);
      }
      return { saved: true, name: suggestedName };
    }

    function onFlushRequest(fn) {
      flushHandler = typeof fn === 'function' ? fn : null;
    }

    return { isDesktop, maxStateChars, loadState, saveState, removeLegacy, quarantine, exportFile, onFlushRequest };
  }

  return { createPlatform, PlatformError };
});
