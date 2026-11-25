/*
 * Data model, validation and (de)serialization.
 * Everything read back from storage or imported from a file is treated as
 * untrusted: it is rebuilt field-by-field from validated values.
 */
(function (root, factory) {
  'use strict';
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else (root.NP = root.NP || {}).store = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STORAGE_KEY = 'cyberpad.v1';
  const LEGACY_STORAGE_KEYS = Object.freeze(['neonpad.v1']); // migrated on first load
  const SCHEMA = 1;
  const BACKUP_APP = 'cyberpad';
  const LEGACY_BACKUP_APPS = Object.freeze(['neonpad']);

  const LIMITS = Object.freeze({
    notes: 2000,
    body: 1000000,
    history: 20,
    historyIntervalMs: 60000,
    importBytes: 2 * 1024 * 1024,
    backupBytes: 50 * 1024 * 1024,
    folderName: 40,
    folders: 100,
  });

  const THEMES = Object.freeze(['neon', 'amber', 'terminal']);
  const THEME_ALIASES = Object.freeze({ phosphor: 'terminal' }); // renamed themes
  const VIEWS = Object.freeze(['edit', 'split', 'preview']);
  const AUTOLOCK = Object.freeze([1, 5, 10, 30, 60]);

  const DEFAULT_SETTINGS = Object.freeze({
    theme: 'neon',
    crt: true,
    sound: false,
    view: 'split',
    boot: true,
    sidebar: true,
    autoLockMinutes: 10,
    lockOnHide: true,
    clearClipboard: true,
    arrows: true,
    collapsedFolders: Object.freeze([]),
  });

  const IMPORT_EXTENSIONS = Object.freeze(['txt', 'md', 'markdown', 'json']);
  const RISKY_INNER_EXTENSIONS = new Set(['exe', 'dll', 'bat', 'cmd', 'com', 'ps1', 'sh', 'js', 'mjs', 'html', 'htm', 'svg', 'php', 'phtml', 'jar', 'msi', 'scr', 'vbs', 'hta']);

  const FILE_FORMATS = Object.freeze(['txt', 'md', 'cpnote']);
  const LINK_ID_RE = /^[0-9a-f]{32}$/;
  // eslint-disable-next-line no-control-regex
  const BAD_FILE_NAME_RE = /[\u0000-\u001f\u007f/\\]/;

  // eslint-disable-next-line no-control-regex
  const BAD_FOLDER_RE = /[\u0000-\u001f\u007f/\\]/;

  class StoreError extends Error {}

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isId = (v) => typeof v === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(v);
  const isTime = (v) => Number.isSafeInteger(v) && v >= 0 && v < 8.64e15;
  const isB64 = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max && v.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(v);

  function newId() {
    return globalThis.crypto.randomUUID();
  }

  const NOTE_CIPHER_MAX = Math.ceil(LIMITS.body * 4 * 4 / 3) + 64;

  function validateEnvelope(e, maxData = NOTE_CIPHER_MAX) {
    if (!isObj(e)) return null;
    if (e.v !== 1 || e.kdf !== 'PBKDF2-SHA256') return null;
    if (!Number.isSafeInteger(e.iter) || e.iter < 100000 || e.iter > 5000000) return null;
    if (!isB64(e.salt, 64) || !isB64(e.iv, 32)) return null;
    if (!isB64(e.data, maxData)) return null;
    return { v: 1, kdf: e.kdf, iter: e.iter, salt: e.salt, iv: e.iv, data: e.data };
  }

  function validateHistory(h) {
    if (!Array.isArray(h)) return [];
    return h.slice(-LIMITS.history)
      .filter((s) => isObj(s) && isTime(s.t) && typeof s.body === 'string' && s.body.length <= LIMITS.body)
      .map((s) => ({ t: s.t, body: s.body }));
  }

  /**
   * A link to a file on disk: exactly { linkId, name, format } or null. The format must match the note's
   * encryption state (encrypted <-> cpnote, plain <-> txt/md). Anything else is dropped, never repaired.
   */
  function validateFile(f, encrypted) {
    if (!isObj(f)) return null;
    if (typeof f.linkId !== 'string' || !LINK_ID_RE.test(f.linkId)) return null;
    if (typeof f.name !== 'string' || f.name.length < 1 || f.name.length > 255 || BAD_FILE_NAME_RE.test(f.name)) return null;
    if (typeof f.format !== 'string' || !FILE_FORMATS.includes(f.format)) return null;
    if ((f.format === 'cpnote') !== encrypted) return null;
    return { linkId: f.linkId, name: f.name, format: f.format };
  }

  /** A folder name: trimmed, inner whitespace collapsed to one space; '' when anything is wrong with it. */
  function cleanFolder(value) {
    if (typeof value !== 'string' || value.length > LIMITS.folderName * 8 || BAD_FOLDER_RE.test(value)) return '';
    const name = value.trim().replace(/\s+/g, ' ');
    return name.length > LIMITS.folderName ? '' : name;
  }

  function validateNote(n, now = Date.now()) {
    if (!isObj(n) || !isId(n.id)) return null;
    let cipher = null;
    if (n.cipher != null) {
      cipher = validateEnvelope(n.cipher);
      if (!cipher) return null;
    }
    const body = typeof n.body === 'string' ? n.body : '';
    if (body.length > LIMITS.body) return null;
    const created = isTime(n.created) ? n.created : now;
    const updated = isTime(n.updated) ? n.updated : created;
    return {
      id: n.id,
      body: cipher ? '' : body,           // never keep plaintext next to ciphertext
      cipher,
      pinned: n.pinned === true,
      created,
      updated,
      history: cipher ? [] : validateHistory(n.history),
      file: validateFile(n.file, cipher !== null),
      folder: cleanFolder(n.folder),
    };
  }

  function validateNotes(list, now) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const links = new Set();
    const folders = new Set();
    const out = [];
    for (const raw of list.slice(0, LIMITS.notes)) {
      const n = validateNote(raw, now);
      if (!n || seen.has(n.id)) continue;
      seen.add(n.id);
      // One file, one note: only the first note holding a link id keeps it.
      if (n.file) {
        if (links.has(n.file.linkId)) n.file = null;
        else links.add(n.file.linkId);
      }
      // At most LIMITS.folders distinct folder names; a note with a further name goes to the top level.
      if (n.folder && !folders.has(n.folder)) {
        if (folders.size >= LIMITS.folders) n.folder = '';
        else folders.add(n.folder);
      }
      out.push(n);
    }
    return out;
  }

  /** A fresh copy of the defaults: the collapsedFolders array is never shared between callers. */
  function defaultSettings() {
    return { ...DEFAULT_SETTINGS, collapsedFolders: [] };
  }

  function validateCollapsed(v) {
    if (!Array.isArray(v)) return [];
    const out = new Set();
    for (const x of v.slice(0, LIMITS.folders * 4)) {
      if (typeof x === 'string' && cleanFolder(x) === x) out.add(x);
      if (out.size >= LIMITS.folders) break;
    }
    return [...out];
  }

  function validateSettings(s) {
    const d = DEFAULT_SETTINGS;
    if (!isObj(s)) return defaultSettings();
    const bool = (v, def) => (typeof v === 'boolean' ? v : def);
    const theme = Object.prototype.hasOwnProperty.call(THEME_ALIASES, s.theme) ? THEME_ALIASES[s.theme] : s.theme;
    return {
      theme: THEMES.includes(theme) ? theme : d.theme,
      crt: bool(s.crt, d.crt),
      sound: bool(s.sound, d.sound),
      view: VIEWS.includes(s.view) ? s.view : d.view,
      boot: bool(s.boot, d.boot),
      sidebar: bool(s.sidebar, d.sidebar),
      autoLockMinutes: AUTOLOCK.includes(s.autoLockMinutes) ? s.autoLockMinutes : d.autoLockMinutes,
      lockOnHide: bool(s.lockOnHide, d.lockOnHide),
      clearClipboard: bool(s.clearClipboard, d.clearClipboard),
      arrows: bool(s.arrows, d.arrows),
      collapsedFolders: validateCollapsed(s.collapsedFolders),
    };
  }

  function emptyState() {
    return { notes: [], settings: defaultSettings(), activeId: null, error: null };
  }

  function validateState(raw, now = Date.now()) {
    if (!isObj(raw) || raw.v !== SCHEMA) return { ...emptyState(), error: raw == null ? null : 'unsupported' };
    return {
      notes: validateNotes(raw.notes, now),
      settings: validateSettings(raw.settings),
      activeId: isId(raw.activeId) ? raw.activeId : null,
      error: null,
    };
  }

  function parseStored(text, now = Date.now()) {
    if (typeof text !== 'string' || text === '') return emptyState();
    try {
      return validateState(JSON.parse(text), now);
    } catch (err) {
      if (err instanceof SyntaxError) return { ...emptyState(), error: 'corrupt' };
      throw err;
    }
  }

  /** Parses one stored copy; null when it is missing or damaged. '' and 'null' count as damaged. */
  function usableCopy(text, now) {
    if (typeof text !== 'string') return null;
    let raw;
    try { raw = JSON.parse(text); } catch (err) {
      if (err instanceof SyntaxError) return null;
      throw err;
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const state = parseStored(text, now);
    return state.error ? null : state;
  }

  /** Chooses the main copy, else the backup, else an empty state. */
  function pickState(main, backup, now = Date.now()) {
    const fromMain = usableCopy(main, now);
    const fromBackup = fromMain ? null : usableCopy(backup, now);
    const unreadable = (main !== null && !fromMain) || (backup !== null && !usableCopy(backup, now));
    if (fromMain) return { state: fromMain, source: 'main', unreadable };
    if (fromBackup) return { state: fromBackup, source: 'backup', unreadable };
    return { state: emptyState(), source: 'none', unreadable };
  }

  function serialize({ notes, settings, activeId }) {
    return JSON.stringify({
      v: SCHEMA,
      activeId,
      settings,
      notes: notes.map((n) => ({
        id: n.id,
        body: n.cipher ? '' : n.body,
        cipher: n.cipher,
        pinned: n.pinned,
        created: n.created,
        updated: n.updated,
        history: n.cipher ? [] : n.history,
        file: n.file || null,
        folder: n.folder || '',
      })),
    });
  }

  function createNote(body = '', now = Date.now(), id = newId()) {
    return { id, body, cipher: null, pinned: false, created: now, updated: now, history: [], file: null, folder: '' };
  }

  /**
   * Record `prevBody` as a snapshot if it differs from the last one and the
   * interval has passed (or `force`). Returns a new bounded array.
   */
  function addSnapshot(history, prevBody, now, force = false) {
    if (typeof prevBody !== 'string' || !prevBody.trim()) return history;
    const last = history[history.length - 1];
    if (last && last.body === prevBody) return history;
    if (!force && last && now - last.t < LIMITS.historyIntervalMs) return history;
    return [...history, { t: now, body: prevBody }].slice(-LIMITS.history);
  }

  function makeBackup(notes, now = Date.now()) {
    return JSON.stringify({
      app: BACKUP_APP,
      v: SCHEMA,
      exported: now,
      notes: notes.map((n) => ({
        id: n.id, body: n.cipher ? '' : n.body, cipher: n.cipher, pinned: n.pinned,
        created: n.created, updated: n.updated, history: n.cipher ? [] : n.history,
        folder: n.folder || '',
        file: null, // a link to a file on this computer never travels in a backup
      })),
    }, null, 2);
  }

  function parseBackup(text, now = Date.now()) {
    let raw;
    try { raw = JSON.parse(text); } catch (err) {
      if (err instanceof SyntaxError) throw new StoreError('not-backup');
      throw err;
    }
    const appOk = raw && (raw.app === BACKUP_APP || LEGACY_BACKUP_APPS.includes(raw.app));
    if (!isObj(raw) || !appOk || raw.v !== SCHEMA || !Array.isArray(raw.notes)) {
      throw new StoreError('not-backup');
    }
    return validateNotes(raw.notes, now).map((n) => ({ ...n, file: null }));
  }

  const ENCRYPTED_BACKUP_KIND = 'encrypted-backup';

  /** Wraps a vault envelope (sealed with purpose 'backup') as a backup file. */
  function makeEncryptedBackup(envelope, now = Date.now()) {
    const cipher = validateEnvelope(envelope, LIMITS.backupBytes);
    if (!cipher) throw new StoreError('The encrypted backup could not be created.');
    return JSON.stringify({ app: BACKUP_APP, kind: ENCRYPTED_BACKUP_KIND, v: SCHEMA, exported: now, cipher }, null, 2);
  }

  /**
   * Returns the validated envelope of an encrypted backup file, or throws
   * StoreError('not-encrypted-backup') when the text is something else.
   */
  function parseEncryptedBackup(text) {
    let raw;
    try { raw = JSON.parse(text); } catch (err) {
      if (err instanceof SyntaxError) throw new StoreError('not-encrypted-backup');
      throw err;
    }
    if (!isObj(raw) || raw.app !== BACKUP_APP || raw.kind !== ENCRYPTED_BACKUP_KIND) throw new StoreError('not-encrypted-backup');
    const cipher = raw.v === SCHEMA ? validateEnvelope(raw.cipher, LIMITS.backupBytes) : null;
    if (!cipher) throw new StoreError('This encrypted backup is damaged or uses an unsupported format.');
    return cipher;
  }

  /** The folders in use with their note counts: sorted by name (case-insensitive), ties by plain order. */
  function folderList(notes) {
    const counts = new Map();
    for (const n of notes) {
      if (n && typeof n.folder === 'string' && n.folder) counts.set(n.folder, (counts.get(n.folder) || 0) + 1);
    }
    return [...counts].map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** Merge imported notes, giving fresh ids to any that collide. */
  function mergeNotes(existing, incoming) {
    const ids = new Set(existing.map((n) => n.id));
    const room = Math.max(0, LIMITS.notes - existing.length);
    const added = incoming.slice(0, room).map((raw) => {
      const n = { ...raw, file: null }; // an imported note is never linked to a file
      if (!ids.has(n.id)) { ids.add(n.id); return n; }
      const copy = { ...n, id: newId() };
      ids.add(copy.id);
      return copy;
    });
    return { notes: [...existing, ...added], added: added.length, skipped: incoming.length - added.length };
  }

  /** Check a file name and size before reading it. Returns the extension. */
  function checkImportFile(name, size) {
    if (typeof name !== 'string' || name.length === 0 || name.length > 255) throw new StoreError('That file name is not supported.');
    const parts = name.toLowerCase().split('.');
    if (parts.length < 2) throw new StoreError('Only .txt, .md and backup .json files can be imported.');
    const ext = parts.pop();
    if (!IMPORT_EXTENSIONS.includes(ext)) throw new StoreError('Only .txt, .md and backup .json files can be imported.');
    if (parts.slice(1).some((p) => RISKY_INNER_EXTENSIONS.has(p))) throw new StoreError('That file has a suspicious double extension and was not imported.');
    const max = ext === 'json' ? LIMITS.backupBytes : LIMITS.importBytes;
    if (!Number.isSafeInteger(size) || size < 0 || size > max) {
      throw new StoreError(`That file is too large. The limit is ${Math.round(max / 1024 / 1024)} MB.`);
    }
    return ext;
  }

  /** Decode file bytes as strict UTF-8 text; reject binary content. */
  function decodeImportBytes(buffer) {
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch (err) {
      if (err instanceof TypeError) throw new StoreError('That file is not UTF-8 text.');
      throw err;
    }
    if (text.includes('\u0000')) throw new StoreError('That file looks binary, not text.');
    return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  }

  return {
    STORAGE_KEY, LEGACY_STORAGE_KEYS, FILE_FORMATS, SCHEMA, LIMITS, THEMES, VIEWS, AUTOLOCK, DEFAULT_SETTINGS, StoreError,
    newId, cleanFolder, folderList, validateEnvelope, validateNote, validateNotes, validateSettings, validateState, parseStored, pickState, serialize, createNote, addSnapshot,
    makeBackup, parseBackup, makeEncryptedBackup, parseEncryptedBackup, mergeNotes, checkImportFile, decodeImportBytes,
  };
});
