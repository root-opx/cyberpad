/*
 * Pure logic for notes linked to a file on disk: what text goes into the file,
 * when to reload silently or ask, tracking unwritten changes, and a
 * one-write-at-a-time queue. No DOM, no I/O.
 */
(function (root, factory) {
  'use strict';
  const deps = typeof module === 'object' && module.exports
    ? { store: require('./store.js'), text: require('./texttools.js') }
    : { store: root.NP.store, text: root.NP.text };
  const mod = factory(deps);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else (root.NP = root.NP || {}).filelink = mod;
})(typeof self !== 'undefined' ? self : this, function (deps) {
  'use strict';

  const { store, text: T } = deps;

  const MAX_NAME = 120;
  const IDLE_RELOAD_MS = 2000;
  const EXT = Object.freeze({ txt: '.txt', md: '.md', cpnote: '.cpnote' });
  const DAMAGED = 'This .cpnote file is damaged or not a CyberPad note.';

  class FileLinkError extends Error {}

  const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  /** Text to write for a note in its persisted form. Encrypted notes use the cipher only, never body. */
  function fileTextOf(note) {
    if (!isPlainObject(note)) throw new FileLinkError('That note cannot be written to a file.');
    if (note.cipher === null) {
      if (typeof note.body !== 'string') throw new FileLinkError('That note cannot be written to a file.');
      return note.body;
    }
    if (!store.validateEnvelope(note.cipher)) throw new FileLinkError('That encrypted note has no data to write.');
    return JSON.stringify({ app: 'cyberpad', kind: 'note', v: 1, cipher: note.cipher });
  }

  /** Returns the validated envelope of a .cpnote file's text. */
  function parseCpnote(src) {
    if (typeof src !== 'string') throw new FileLinkError(DAMAGED);
    let raw;
    try { raw = JSON.parse(src); } catch (err) {
      if (err instanceof SyntaxError) throw new FileLinkError(DAMAGED);
      throw err;
    }
    if (!isPlainObject(raw) || raw.app !== 'cyberpad' || raw.kind !== 'note' || raw.v !== 1) throw new FileLinkError(DAMAGED);
    if (Object.keys(raw).some((k) => !['app', 'kind', 'v', 'cipher'].includes(k))) throw new FileLinkError(DAMAGED);
    const cipher = store.validateEnvelope(raw.cipher);
    if (!cipher) throw new FileLinkError(DAMAGED);
    return cipher;
  }

  function formatsFor(note) {
    return note && note.cipher ? ['cpnote'] : ['txt', 'md'];
  }

  function suggestedFileName(title, format) {
    if (typeof format !== 'string' || !Object.prototype.hasOwnProperty.call(EXT, format)) {
      throw new FileLinkError('That file format is not supported.');
    }
    const ext = EXT[format];
    const slug = T.slugify(typeof title === 'string' ? title : '') || 'note';
    return slug.slice(0, MAX_NAME - ext.length) + ext;
  }

  /** What to do about the file's state: 'none' | 'reload' | 'conflict' | 'missing'. */
  function decide({ status, hasUnwritten, msSinceInput }) {
    if (status === 'missing') return 'missing';
    if (status !== 'changed') return 'none';
    return !hasUnwritten && msSinceInput >= IDLE_RELOAD_MS ? 'reload' : 'conflict';
  }

  /** Remembers the text last confirmed on disk per note. */
  function createTracker() {
    const confirmed = new Map();
    return {
      confirm(noteId, txt) { confirmed.set(noteId, txt); },
      hasUnwritten(noteId, txt) { return !confirmed.has(noteId) || confirmed.get(noteId) !== txt; },
      forget(noteId) { confirmed.delete(noteId); },
    };
  }

  /**
   * One write in flight per note; requests during a write coalesce into exactly one more.
   * A rejecting writer does not break the queue (callers handle their own errors inside write).
   */
  function createWriteQueue(write) {
    const state = new Map(); // noteId -> { pending: boolean }
    let waiters = [];

    function settle() {
      if (state.size === 0) { const w = waiters; waiters = []; for (const r of w) r(); }
    }

    async function run(noteId, entry) {
      try {
        await write(noteId);
      } catch (err) {
        // intentionally ignored: the writer reports its own failures
      }
      if (entry.pending) {
        entry.pending = false;
        return run(noteId, entry);
      }
      state.delete(noteId);
      settle();
    }

    return {
      request(noteId) {
        const entry = state.get(noteId);
        if (entry) { entry.pending = true; return; }
        const fresh = { pending: false };
        state.set(noteId, fresh);
        run(noteId, fresh);
      },
      idle() {
        if (state.size === 0) return Promise.resolve();
        return new Promise((resolve) => { waiters.push(resolve); });
      },
    };
  }

  return { FileLinkError, fileTextOf, parseCpnote, formatsFor, suggestedFileName, decide, createTracker, createWriteQueue };
});
