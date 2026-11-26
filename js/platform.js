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
  const MAX_HOST_REASON_CHARS = 300;
  const WRITE_TIMEOUT_MS = 60000;
  const MAX_FILE_TEXT_CHARS = 4 * 1024 * 1024;
  const MAX_SUGGESTED_NAME_CHARS = 120;
  const MAX_LINK_IDS = 2000;
  // The file types the host opens and saves: the same table as store.FILE_FORMATS (a test pins the two copies).
  const FILE_FORMATS = Object.freeze([
    'txt', 'md', 'markdown', 'cpnote', 'py', 'pyw', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'sh', 'bash',
    'zsh', 'ps1', 'psm1', 'psd1', 'bat', 'cmd', 'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'cs', 'java', 'go',
    'rs', 'rb', 'php', 'lua', 'pl', 'sql', 'html', 'htm', 'xml', 'xsd', 'xsl', 'svg', 'css', 'scss', 'json',
    'jsonl', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'env', 'log', 'csv', 'tsv', 'diff',
    'patch', 'nfo', 'lst', 'rules', 'yar', 'yara', 'nse', 'asm', 's', 'tex', 'rst', 'gitignore',
  ]);
  const FILE_STATUSES = ['ok', 'changed', 'missing', 'unknown'];
  const LINK_ID_RE = /^[0-9a-f]{32}$/;
  // eslint-disable-next-line no-control-regex
  const BAD_FILE_NAME_RE = /[\u0000-\u001f\u007f/\\]/;
  const HOST_THEMES = Object.freeze(['neon', 'amber', 'terminal', 'light', 'dark']);
  const NO_FILES = 'Files are only available in the desktop app.';

  const isLinkId = (v) => typeof v === 'string' && LINK_ID_RE.test(v);
  const isFileName = (v) => typeof v === 'string' && v.length >= 1 && v.length <= 255 && !BAD_FILE_NAME_RE.test(v);
  const isFormat = (v) => typeof v === 'string' && FILE_FORMATS.includes(v);

  /**
   * `reason` is a short code ('host', 'timeout', 'quota', 'too-large'). `userFacing` is true only when
   * `message` is the host's own short, safe failure text (saveFailed / exportFailed), fit to show as is.
   */
  class PlatformError extends Error {
    constructor(reason, message, userFacing = false) {
      super(message || reason);
      this.name = 'PlatformError';
      this.reason = reason;
      this.userFacing = userFacing === true;
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
    let openHandler = null;

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

    /**
     * Answers every flush request exactly once: "flushed" only when the handler confirms that everything is
     * saved (or no handler is registered yet, so there is nothing to save), "flushFailed" otherwise.
     */
    async function runFlush() {
      let ok = false;
      try {
        ok = flushHandler ? (await flushHandler()) === true : true;
      } catch (err) {
        console.error('flush handler failed', err && err.name);
        ok = false;
      }
      try {
        webview.postMessage({ type: ok ? 'flushed' : 'flushFailed' });
      } catch (err) {
        console.error('flush reply failed', err && err.name);
      }
    }

    function onMessage(ev) {
      const m = ev && ev.data;
      if (!m || typeof m !== 'object' || typeof m.type !== 'string') return;
      if (m.type === 'flush') { runFlush(); return; }
      if (m.type === 'openRequested') { // host-initiated, carries no id
        if (openHandler) {
          try { openHandler(); } catch (err) { console.error('open handler failed', err && err.name); }
        }
        return;
      }
      if (typeof m.id !== 'string') return;
      const p = settle(m.id);
      if (!p) return; // unknown or already settled
      if (m.type === 'saveFailed' || m.type === 'exportFailed') {
        // The host's failure text is a short user-facing reason by contract; anything else is not shown.
        const shown = typeof m.reason === 'string' && m.reason.length > 0 && m.reason.length <= MAX_HOST_REASON_CHARS;
        p.reject(shown ? new PlatformError('host', m.reason, true) : new PlatformError('host', m.type));
      } else if (m.type === 'fileFailed') {
        const shown = typeof m.reason === 'string' && m.reason.length > 0 && m.reason.length <= MAX_HOST_REASON_CHARS;
        const err = shown ? new PlatformError('host', m.reason, true) : new PlatformError('host', m.type);
        if (isLinkId(m.linkId)) err.linkId = m.linkId;
        p.reject(err);
      } else if (m.type === 'rejected') {
        // A rejection reason is diagnostic (for example "unexpected field"), never shown to the user.
        p.reject(new PlatformError('host', typeof m.reason === 'string' ? m.reason.slice(0, MAX_HOST_REASON_CHARS) : 'rejected'));
      } else {
        p.accept(m, p.resolve, p.reject);
      }
    }

    if (isDesktop && typeof webview.addEventListener === 'function') webview.addEventListener('message', onMessage);

    /** Post a message with a fresh id; `accept(reply, resolve, reject)` handles the matching reply. */
    function request(type, fields, accept, { timeout = true, timeoutMs: ms } = {}) {
      return new Promise((resolve, reject) => {
        const id = newId();
        const entry = { resolve, reject, accept, timer: null };
        if (timeout) {
          entry.timer = env.setTimeout(() => {
            if (pending.get(id) === entry) { pending.delete(id); reject(new PlatformError('timeout')); }
          }, Number.isFinite(ms) && ms > 0 ? ms : timeoutMs);
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

    // ---------------------------------------------------------------- host theme

    /**
     * Tells the desktop host which of the three fixed themes is active (it colours the title bar).
     * Only the allow-listed name is ever sent, never a colour. Browser: nothing is sent, resolves false.
     */
    async function setHostTheme(theme) {
      if (typeof theme !== 'string' || !HOST_THEMES.includes(theme)) throw new PlatformError('host', 'invalid theme');
      if (!isDesktop) return false;
      return request('theme', { theme }, expect('themeApplied', () => true));
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

    // --------------------------------------------------------------- files

    const noFiles = () => new PlatformError('host', NO_FILES, true);
    const unexpected = () => new PlatformError('host', 'unexpected reply');
    const invalid = (what) => new PlatformError('host', 'invalid ' + what);
    const fileText = (text) => {
      if (typeof text !== 'string') throw invalid('text');
      if (text.length > MAX_FILE_TEXT_CHARS) throw new PlatformError('too-large');
      return wellFormed(text);
    };
    const linkIdOf = (id) => { if (!isLinkId(id)) throw invalid('link'); return id; };
    const linkIdsOf = (ids) => {
      if (!Array.isArray(ids) || ids.length > MAX_LINK_IDS) throw invalid('links');
      const seen = new Set();
      for (const id of ids) {
        if (!isLinkId(id) || seen.has(id)) throw invalid('links');
        seen.add(id);
      }
      return ids.slice();
    };

    /** A reply that names a link: every field is validated before it reaches the caller. */
    const linkOf = (m) => (isLinkId(m.linkId) && isFileName(m.name) && isFormat(m.format)
      ? { linkId: m.linkId, name: m.name, format: m.format } : null);

    async function saveAsFile({ format, suggestedName, text, relinkId } = {}) {
      if (!isDesktop) throw noFiles();
      if (!isFormat(format)) throw invalid('format');
      if (typeof suggestedName !== 'string' || suggestedName.length > MAX_SUGGESTED_NAME_CHARS) throw invalid('name');
      const body = fileText(text);
      const relink = relinkId !== undefined && relinkId !== null;
      const fields = relink
        ? { linkId: linkIdOf(relinkId), format, suggestedName: wellFormed(suggestedName), text: body }
        : { format, suggestedName: wellFormed(suggestedName), text: body };
      // No timeout: the host waits for the user in a dialog.
      return request(relink ? 'relinkFile' : 'saveAsFile', fields, (m, resolve, reject) => {
        if (m.type === 'fileLinked') {
          const link = linkOf(m);
          if (link) resolve({ linked: true, ...link }); else reject(unexpected());
        } else if (m.type === 'fileCancelled') resolve({ linked: false });
        else reject(unexpected());
      }, { timeout: false });
    }

    async function openFile() {
      if (!isDesktop) throw noFiles();
      return request('openFile', {}, (m, resolve, reject) => {
        if (m.type === 'fileOpened') {
          const link = linkOf(m);
          if (link && typeof m.text === 'string' && typeof m.alreadyLinked === 'boolean') {
            resolve({ opened: true, ...link, text: m.text, alreadyLinked: m.alreadyLinked });
          } else reject(unexpected());
        } else if (m.type === 'fileCancelled') resolve({ opened: false });
        else reject(unexpected());
      }, { timeout: false });
    }

    async function writeFile(linkId, text, force) {
      if (!isDesktop) throw noFiles();
      const fields = { linkId: linkIdOf(linkId), text: fileText(text), force: force === true };
      return request('writeFile', fields, (m, resolve, reject) => {
        if (m.type === 'fileWritten') resolve('written');
        else if (m.type === 'fileConflict') resolve('conflict');
        else if (m.type === 'fileMissing') resolve('missing');
        else reject(unexpected());
      }, { timeoutMs: WRITE_TIMEOUT_MS });
    }

    async function readFile(linkId) {
      if (!isDesktop) throw noFiles();
      return request('readFile', { linkId: linkIdOf(linkId) }, (m, resolve, reject) => {
        if (m.type === 'fileMissing') resolve({ missing: true });
        else if (m.type === 'fileRead' && typeof m.text === 'string') resolve({ missing: false, text: m.text });
        else reject(unexpected());
      });
    }

    /** True when the text, encoded the way the link's record says, is what CyberPad last wrote to the file or adopted. */
    async function matchesLastWrite(linkId, text) {
      if (!isDesktop) throw noFiles();
      const fields = { linkId: linkIdOf(linkId), text: fileText(text) };
      return request('matchesLastWrite', fields, (m, resolve, reject) => {
        if (m.type === 'lastWriteMatch' && typeof m.match === 'boolean') resolve(m.match);
        else reject(unexpected());
      });
    }

    async function checkFiles(linkIds) {
      if (!isDesktop) throw noFiles();
      const ids = linkIdsOf(linkIds);
      if (ids.length === 0) return {};
      return request('checkFiles', { linkIds: ids }, (m, resolve, reject) => {
        const s = m.type === 'fileStatus' ? m.statuses : null;
        if (s === null || typeof s !== 'object' || Array.isArray(s)) { reject(unexpected()); return; }
        const out = {};
        for (const key of Object.keys(s)) {
          if (isLinkId(key) && typeof s[key] === 'string' && FILE_STATUSES.includes(s[key])) out[key] = s[key];
        }
        resolve(out);
      });
    }

    async function unlinkFile(linkId) {
      if (!isDesktop) throw noFiles();
      return request('unlinkFile', { linkId: linkIdOf(linkId) }, expect('fileUnlinked'));
    }

    async function revealFile(linkId) {
      if (!isDesktop) throw noFiles();
      return request('revealFile', { linkId: linkIdOf(linkId) }, expect('fileRevealed'));
    }

    async function pruneLinks(linkIds) {
      if (!isDesktop) throw noFiles();
      return request('pruneLinks', { linkIds: linkIdsOf(linkIds) }, expect('linksPruned'));
    }

    function onOpenRequested(fn) {
      openHandler = typeof fn === 'function' ? fn : null;
    }

    function onFlushRequest(fn) {
      flushHandler = typeof fn === 'function' ? fn : null;
    }

    return { isDesktop, maxStateChars, loadState, saveState, removeLegacy, quarantine, setHostTheme, exportFile, onFlushRequest,
      saveAsFile, openFile, writeFile, readFile, matchesLastWrite, checkFiles, unlinkFile, revealFile, pruneLinks, onOpenRequested,
    };
  }

  return { createPlatform, PlatformError, FILE_FORMATS };
});
