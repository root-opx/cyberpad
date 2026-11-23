/* CyberPad application controller. */
(function () {
  'use strict';

  const { calc, markdown, text: T, vault, store, secops, cvss, netcalc, dom, caret, sound, renderMarkdown } = window.NP;
  const { h } = dom;
  const { PlatformError } = window.NP.platformFactory;
  const platform = window.NP.platformFactory.createPlatform(window);
  const $ = (id) => document.getElementById(id);

  const els = {
    app: $('app'), sidebar: $('sidebar'), scrim: $('scrim'), workspace: $('workspace'),
    editor: $('editor'), preview: $('preview'), previewPane: document.querySelector('.pane-preview'), backlinks: $('backlinks'),
    lockscreen: $('lockscreen'), unlockForm: $('unlock-form'), unlockPass: $('unlock-pass'), unlockError: $('unlock-error'), unlockBtn: $('unlock-btn'),
    search: $('search'), noteList: $('note-list'), tagList: $('tag-list'), filterRow: $('filter-row'), filterLabel: $('filter-label'),
    btnClearFilter: $('btn-clear-filter'), btnNew: $('btn-new'), btnSidebar: $('btn-sidebar'), themeSelect: $('theme-select'),
    btnCrt: $('btn-crt'), btnSound: $('btn-sound'), btnPalette: $('btn-palette'),
    findbar: $('findbar'), findInput: $('find-input'), replaceInput: $('replace-input'), findCase: $('find-case'),
    findRegex: $('find-regex'), findCount: $('find-count'),
    stSave: $('st-save'), stSaveText: $('st-save-text'), stPos: $('st-pos'), stWords: $('st-words'), stSel: $('st-sel'),
    stLock: $('st-lock'), stTimer: $('st-timer'), stClock: $('st-clock'),
    slash: $('slash'), palette: $('palette'), paletteInput: $('palette-input'), paletteList: $('palette-list'),
    modal: $('modal'), toasts: $('toasts'), boot: $('boot'), bootLog: $('boot-log'), dropzone: $('dropzone'),
    fileInput: $('file-input'), hashFileInput: $('hash-file-input'), wordmark: document.querySelector('.wordmark-text'),
    secretAlert: $('secret-alert'), secretAlertText: $('secret-alert-text'),
  };

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const narrow = window.matchMedia('(max-width: 760px)');

  const THEME_NAMES = { neon: 'Neon', amber: 'Amber', terminal: 'Terminal green' };

  const WELCOME = [
    '# Welcome to CyberPad',
    '',
    'A notepad that lives in this browser. Everything saves automatically, on this device only.',
    '',
    '## Try these',
    '- [ ] Type / at the start of a word for quick inserts, like /date or /table',
    '- [ ] Put the cursor after a sum ending in = and press Tab: 1280 * 0.15 =',
    '- [ ] Press Ctrl+Enter on any line to turn it into a task, then tick it in the preview',
    '- [ ] Open the command palette with Ctrl+K and type "sort" or "json"',
    '- [ ] Select some numbers and look at the status bar: 12.5 7 30',
    '- [ ] Link notes with double brackets: [[Ideas]]',
    '- [ ] Tag notes with hashtags, then filter by tag in the sidebar',
    '',
    '## Keep secrets secret',
    'Open the palette and run **Encrypt note**. The note is sealed with AES-256-GCM using a key derived from your passphrase, and only the encrypted copy is ever saved.',
    '',
    '## Shortcuts',
    '| Keys | Does |',
    '| --- | --- |',
    '| Ctrl+K | Command palette |',
    '| Alt+N | New note |',
    '| Alt+T | Today\'s log |',
    '| Ctrl+E | Switch Write / Split / Read |',
    '| Ctrl+F | Find and replace |',
    '| Ctrl+B | Show or hide the note list |',
    '| Alt+Z | Zen mode |',
    '| Alt+L | Lock encrypted notes |',
    '| F1 | All shortcuts |',
    '',
    '#welcome',
  ].join('\n');

  const MIGRATION_LINE = 'Moving from the browser version? Export a backup there (Command palette → Export backup), then import it here.';
  const welcomeText = () => (platform.isDesktop
    ? WELCOME
      .replace('A notepad that lives in this browser.', 'A notepad that lives on this computer.')
      .replace(/\n#welcome$/, `\n${MIGRATION_LINE}\n\n#welcome`)
    : WELCOME);
  const where = () => (platform.isDesktop ? 'on this computer' : 'in this browser');

  const S = {
    notes: [],
    settings: { ...store.DEFAULT_SETTINGS },
    activeId: null,
    query: '',
    tag: null,
    keys: new Map(),        // note id -> { key: non-extractable CryptoKey, salt, iterations }
    plain: new Map(),       // note id -> decrypted text, memory only, never persisted
    meta: new Map(),        // note id -> cached derived data
    sealTimers: new Map(),
    sealing: new Map(),
    saveTimer: 0,
    saving: null,           // promise of the save loop while a save is in flight
    saveDirty: false,       // a change arrived during a save: save once more afterwards
    lastStateChars: 0,
    legacyKey: null,
    host: { version: null, dataDir: null },
    storageOk: true,
    timer: null,
    lastActive: Date.now(),
    unlockFails: 0,
    unlockBlockedUntil: 0,
    unlockBusy: false,
    secretIgnored: new Map(), // note id -> signature of findings the user chose to ignore (memory only)
    secretFindings: [],
    tabEscape: false,
    find: { case: false, regex: false, matches: [], idx: -1, capped: false },
    slash: { open: false, items: [], idx: 0, start: 0, query: '' },
    pal: { items: [], idx: 0 },
  };

  // ---------------------------------------------------------------- notes

  const noteById = (id) => S.notes.find((n) => n.id === id) || null;
  const active = () => noteById(S.activeId);
  const isLocked = (n) => !!(n && n.cipher && !S.keys.has(n.id));
  const bodyOf = (n) => (n.cipher ? (S.plain.has(n.id) ? S.plain.get(n.id) : null) : n.body);
  const isEditable = (n) => !!n && !isLocked(n);

  function metaOf(n) {
    const body = bodyOf(n);
    const cached = S.meta.get(n.id);
    if (cached && cached.body === body) return cached;
    const m = body == null
      ? { body, title: 'Encrypted note', tags: [], links: [] }
      : { body, title: T.deriveTitle(body), tags: T.extractTags(body), links: T.extractWikiLinks(body).map((l) => l.toLowerCase()) };
    S.meta.set(n.id, m);
    return m;
  }

  const titleOf = (n) => metaOf(n).title;

  function sortedNotes() {
    return [...S.notes].sort((a, b) => (b.pinned - a.pinned) || (b.updated - a.updated));
  }

  function visibleNotes() {
    const q = S.query.trim().toLowerCase();
    return sortedNotes().filter((n) => {
      const body = bodyOf(n);
      if (S.tag && !metaOf(n).tags.includes(S.tag)) return false;
      if (!q) return true;
      if (body == null) return 'encrypted note'.includes(q);
      return body.toLowerCase().includes(q);
    });
  }

  function findNoteByTitle(title) {
    const t = title.trim().toLowerCase();
    return S.notes.find((n) => !isLocked(n) && titleOf(n).toLowerCase() === t) || null;
  }

  // -------------------------------------------------------------- storage

  const SAVE_REASON = { timeout: 'the save timed out', host: 'the app could not write the file' };

  function setSaveState(state, label) {
    els.stSave.dataset.state = state;
    els.stSaveText.textContent = label || { saved: 'Saved', writing: 'Saving…', error: 'Not saved' }[state];
  }

  function pendingWrites() {
    return S.saveTimer !== 0 || S.sealTimers.size > 0 || S.sealing.size > 0;
  }

  function failSave(err) {
    const reason = err instanceof PlatformError ? err.reason : null;
    if (reason === 'too-large') {
      setSaveState('error', 'Not saved');
      toast('Your notes are over 64 MB, so they can’t be saved. Export a backup, then remove large notes.', 'error');
    } else {
      setSaveState('error', 'Save failed');
      toast(`Saving failed (${SAVE_REASON[reason] || 'unexpected error'}). Export a backup from the command palette to keep your notes safe.`, 'error');
    }
    console.error('save failed', reason || (err && err.name));
    return false;
  }

  const serializeState = () => store.serialize({ notes: S.notes, settings: S.settings, activeId: S.activeId });

  /** One save of the current state. Never throws. */
  async function saveOnce() {
    let text = serializeState();
    try {
      try {
        await platform.saveState(text);
      } catch (err) {
        if (!(err instanceof PlatformError) || err.reason !== 'quota') throw err;
        for (const n of S.notes) n.history = n.history.slice(-3);
        text = serializeState();
        try {
          await platform.saveState(text);
        } catch (err2) {
          if (err2 instanceof PlatformError && err2.reason === 'quota') {
            setSaveState('error', 'Storage full');
            toast('Storage is full. Export a backup, then delete large notes.', 'error');
            return false;
          }
          throw err2;
        }
        toast('Storage was full, so older versions were removed to make room.', 'error');
      }
    } catch (err) {
      return failSave(err);
    }
    S.lastStateChars = text.length;
    if (S.legacyKey) {
      // The data now lives under the new key, so the old copy can go.
      platform.removeLegacy(S.legacyKey);
      S.legacyKey = null;
    }
    if (!pendingWrites() && !S.saveDirty) setSaveState('saved');
    return true;
  }

  /**
   * Saves now. At most one save is in flight: a call during a save marks the
   * state dirty and the running loop saves once more. The promise resolves
   * after that last save, with whether it succeeded.
   */
  function persistNow() {
    clearTimeout(S.saveTimer);
    S.saveTimer = 0;
    if (!S.storageOk) { setSaveState('error', 'Not saving'); return Promise.resolve(false); }
    if (S.saving) { S.saveDirty = true; return S.saving; }
    // The first save starts synchronously, so a page-hide handler still writes in time.
    S.saving = (async () => {
      let ok = false;
      try {
        do {
          S.saveDirty = false;
          ok = await saveOnce();
        } while (S.saveDirty);
      } finally {
        S.saving = null;
      }
      return ok;
    })();
    return S.saving;
  }

  function schedulePersist() {
    setSaveState('writing');
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(persistNow, 400);
  }

  async function load() {
    let loaded = null;
    try {
      loaded = await platform.loadState();
    } catch (err) {
      // Fail closed: saving an empty state over notes that exist but could not be read would lose them.
      S.storageOk = false;
      console.error('load failed', err instanceof PlatformError ? err.reason : (err && err.name));
      setTimeout(() => toast('Your notes could not be loaded, so nothing will be saved in this session. Close CyberPad and open it again.', 'error'), 0);
      loaded = { main: null, backup: null, legacyKey: null, storageOk: true, version: null, dataDir: null };
    }
    if (!loaded.storageOk) S.storageOk = false;
    S.legacyKey = loaded.legacyKey;
    S.host = { version: loaded.version, dataDir: loaded.dataDir };
    const { state, source, unreadable } = store.pickState(loaded.main, loaded.backup);
    S.lastStateChars = source === 'main' ? loaded.main.length : (source === 'backup' ? loaded.backup.length : 0);
    if (source === 'backup') {
      setTimeout(() => toast('Your last save could not be read, so the previous save was restored.', 'error'), 0);
    }
    if (unreadable && S.storageOk) {
      // The browser keeps the raw string; the desktop host renames whichever files exist.
      const canKeep = platform.isDesktop || typeof loaded.main === 'string';
      let kept = false;
      if (canKeep) {
        try { await platform.quarantine(loaded.main); kept = true; } catch (err) {
          console.error('quarantine failed', err instanceof PlatformError ? err.reason : (err && err.name));
        }
      }
      const place = platform.isDesktop ? 'in the data folder' : 'in browser storage';
      setTimeout(() => toast(kept
        ? `Saved notes could not be read. The unreadable copy was kept ${place}.`
        : 'Saved notes could not be read, and the unreadable copy could not be kept.', 'error'), 0);
    }
    S.notes = state.notes;
    S.settings = state.settings;
    S.activeId = state.activeId;
    const firstRun = (S.notes.length === 0 && !unreadable) || !!S.legacyKey;
    if (!S.notes.length) S.notes.push(store.createNote(welcomeText()));
    if (!active()) S.activeId = sortedNotes()[0].id;
    if (!loaded.storageOk) setTimeout(() => toast('This browser is blocking storage, so notes will be lost when you close the tab.', 'error'), 0);
    return { firstRun };
  }

  // ------------------------------------------------------------ encryption

  function queueSeal(note) {
    clearTimeout(S.sealTimers.get(note.id));
    S.sealTimers.set(note.id, setTimeout(() => sealNow(note.id), 500));
    setSaveState('writing', 'Encrypting…');
  }

  function sealNow(id) {
    clearTimeout(S.sealTimers.get(id));
    S.sealTimers.delete(id);
    const prev = S.sealing.get(id) || Promise.resolve();
    const next = prev.then(async () => {
      const note = noteById(id);
      const keyInfo = S.keys.get(id);
      const text = S.plain.get(id);
      if (!note || !keyInfo || text == null) return;
      note.cipher = await vault.seal(keyInfo, text);
      persistNow();
    }).catch((err) => {
      setSaveState('error', 'Encrypt failed');
      toast('The latest changes could not be encrypted, so they were not saved. Press Ctrl+S to retry.', 'error');
      console.error(err);
    });
    S.sealing.set(id, next);
    next.then(() => {
      if (S.sealing.get(id) === next) S.sealing.delete(id);
      if (!pendingWrites() && els.stSave.dataset.state !== 'error') setSaveState('saved');
    });
    return next;
  }

  async function flushSeals() {
    for (const id of [...S.sealTimers.keys()]) sealNow(id);
    await Promise.all([...S.sealing.values()]);
  }

  async function lockAll(reason) {
    if (!S.keys.size) {
      if (!reason) toast('No encrypted notes are unlocked.');
      return;
    }
    await flushSeals();
    const n = active();
    // A dialog opened on an unlocked encrypted note may show its plaintext, and
    // its follow-up action must not run against a locked note: cancel it.
    if (n && n.cipher && finishCurrentDialog) finishCurrentDialog(null);
    if (els.palette.open) closePalette();
    S.keys.clear();
    S.plain.clear();
    S.meta.clear();
    closeSlash();
    renderAll();
    if (clip.pending) clearClipboardNow();
    toast(reason || 'Encrypted notes locked.');
  }

  /** New-passphrase and repeat fields with a strength meter. */
  function newPassphraseFields(idPrefix) {
    const pass1 = h('input', { type: 'password', autocomplete: 'new-password', maxlength: 1024, id: `${idPrefix}-pass` });
    const pass2 = h('input', { type: 'password', autocomplete: 'new-password', maxlength: 1024, id: `${idPrefix}-pass2` });
    const bar = h('i');
    const label = h('span', null, vault.strength('').label);
    const meter = h('div', { class: 'strength', 'data-level': 0 }, h('div', { class: 'strength-bar' }, bar), label);
    pass1.addEventListener('input', () => {
      const st = vault.strength(pass1.value);
      meter.dataset.level = String(st.level);
      bar.style.width = `${(st.level / 3) * 100}%`;
      label.textContent = st.label;
    });
    return {
      pass1,
      pass2,
      nodes: [
        h('label', { class: 'field' }, h('span', null, 'Passphrase'), pass1),
        meter,
        h('label', { class: 'field' }, h('span', null, 'Repeat passphrase'), pass2),
      ],
      problem() {
        if (pass1.value.length < vault.MIN_PASSPHRASE) return `Use at least ${vault.MIN_PASSPHRASE} characters.`;
        if (pass1.value !== pass2.value) return 'The passphrases do not match.';
        return null;
      },
      clear() { pass1.value = ''; pass2.value = ''; },
    };
  }

  async function encryptActive() {
    const note = active();
    if (!isEditable(note)) return;
    if (note.cipher) { toast('This note is already encrypted.'); return; }

    const fields = newPassphraseFields('enc');
    const { pass1, pass2 } = fields;
    const err = h('p', { class: 'form-error', role: 'alert' });

    const ok = await showDialog({
      title: 'Encrypt this note',
      initialFocus: '#enc-pass',
      body: [
        h('p', null, 'Only an encrypted copy will be saved, and its version history is deleted. If you forget the passphrase, nobody can recover the note.'),
        ...fields.nodes,
        err,
      ],
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Encrypt note', submit: true, className: 'btn-primary' },
      ],
      onSubmit: async (form) => {
        const problem = fields.problem();
        if (problem) { err.textContent = problem; return undefined; }
        const btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        btn.textContent = 'Encrypting…';
        try {
          const keyInfo = await vault.createKey(pass1.value);
          const plain = note.body;
          note.cipher = await vault.seal(keyInfo, plain);
          note.body = '';
          note.history = [];
          S.keys.set(note.id, keyInfo);
          S.plain.set(note.id, plain);
          return true;
        } catch (e) {
          if (e instanceof vault.VaultError) err.textContent = e.message;
          else { console.error(e); err.textContent = 'Encryption failed in this browser. The note was not changed.'; }
          btn.disabled = false;
          btn.textContent = 'Encrypt note';
          return undefined;
        } finally {
          pass1.value = '';
          pass2.value = '';
        }
      },
    });
    if (ok) {
      persistNow();
      renderAll();
      toast('Note encrypted. Only the encrypted copy is saved.');
    }
  }

  async function decryptActive() {
    const note = active();
    if (!note || !note.cipher) { toast('This note is not encrypted.'); return; }
    if (isLocked(note)) { toast('Unlock the note first.'); return; }
    const ok = await confirmDialog('Remove encryption?', `The note will be saved as plain text ${where()} from now on.`, 'Remove encryption', true);
    if (!ok) return;
    // The note may have auto-locked while the dialog was open: never replace it with an empty body.
    if (isLocked(note) || !S.plain.has(note.id)) { toast('The note was locked. Unlock it and try again.', 'error'); return; }
    await flushSeals();
    note.body = S.plain.get(note.id) || '';
    note.cipher = null;
    note.history = [];
    S.keys.delete(note.id);
    S.plain.delete(note.id);
    persistNow();
    renderAll();
    toast('Encryption removed.');
  }

  async function onUnlockSubmit(e) {
    e.preventDefault();
    const note = active();
    if (!note || !isLocked(note) || S.unlockBusy) return;
    const wait = S.unlockBlockedUntil - Date.now();
    if (wait > 0) {
      els.unlockError.textContent = `Too many attempts. Try again in ${Math.ceil(wait / 1000)} seconds.`;
      return;
    }
    S.unlockBusy = true;
    els.unlockBtn.disabled = true;
    els.unlockBtn.textContent = 'Unlocking…';
    try {
      const { keyInfo, text } = await vault.unlock(els.unlockPass.value, note.cipher);
      S.keys.set(note.id, keyInfo);
      S.plain.set(note.id, text);
      S.unlockFails = 0;
      els.unlockError.textContent = '';
      els.unlockPass.value = '';
      S.lastActive = Date.now();
      renderAll();
      els.editor.focus();
    } catch (err) {
      S.unlockFails++;
      if (S.unlockFails >= 5) S.unlockBlockedUntil = Date.now() + Math.min(60000, 2000 * 2 ** (S.unlockFails - 5));
      if (err instanceof vault.VaultError) els.unlockError.textContent = err.message;
      else { console.error(err); els.unlockError.textContent = 'Unlocking failed in this browser.'; }
      els.unlockPass.select();
    } finally {
      S.unlockBusy = false;
      els.unlockBtn.disabled = false;
      els.unlockBtn.textContent = 'Unlock note';
    }
  }

  // ------------------------------------------------------------- rendering

  function renderAll() {
    applySettings();
    renderEditor();
    renderList();
    renderTags();
    renderPreview();
    updateStatus();
    runSecretScan();
  }

  function applySettings() {
    const s = S.settings;
    document.documentElement.dataset.theme = s.theme;
    document.body.classList.toggle('crt', s.crt);
    els.app.classList.toggle('no-sidebar', !s.sidebar);
    els.workspace.dataset.view = s.view;
    document.querySelectorAll('.segmented [data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === s.view)));
    els.themeSelect.value = s.theme;
    els.btnCrt.setAttribute('aria-pressed', String(s.crt));
    els.btnSound.setAttribute('aria-pressed', String(s.sound));
    els.btnSidebar.setAttribute('aria-expanded', String(narrow.matches ? els.app.classList.contains('sidebar-open') : s.sidebar));
  }

  function renderEditor() {
    const note = active();
    const locked = !note || isLocked(note);
    els.lockscreen.hidden = !locked;
    els.editor.hidden = locked;
    if (locked) {
      els.editor.value = '';
      els.unlockError.textContent = '';
    } else {
      const body = bodyOf(note);
      if (els.editor.value !== body) {
        els.editor.value = body;
        els.editor.setSelectionRange(0, 0);
        els.editor.scrollTop = 0;
      }
    }
    els.editor.maxLength = store.LIMITS.body;
    document.title = note ? `${titleOf(note)} | CyberPad` : 'CyberPad';
  }

  function renderList() {
    const list = visibleNotes();
    const q = S.query.trim();
    const frag = document.createDocumentFragment();
    if (!list.length) {
      frag.append(h('li', { class: 'empty-list' }, S.query || S.tag ? 'No notes match. Clear the filter, or press Alt+N to start one.' : 'No notes yet. Press Alt+N to start one.'));
    }
    for (const n of list.slice(0, 500)) {
      const m = metaOf(n);
      const mark = n.pinned ? '◆' : n.cipher ? (isLocked(n) ? '▣' : '□') : '';
      const extra = [];
      if (q && m.body != null) {
        const idx = m.body.toLowerCase().indexOf(q.toLowerCase());
        if (idx >= 0) {
          const from = Math.max(0, idx - 12);
          extra.push(h('span', { class: 'snippet' },
            (from > 0 ? '…' : '') + m.body.slice(from, idx).replace(/\s+/g, ' '),
            h('mark', null, m.body.slice(idx, idx + q.length)),
            m.body.slice(idx + q.length, idx + q.length + 40).replace(/\s+/g, ' ')));
        }
      } else if (m.tags.length) {
        extra.push(h('span', { class: 'snippet' }, m.tags.slice(0, 3).map((t) => `#${t}`).join(' ')));
      }
      const states = [n.pinned && 'pinned', n.cipher && (isLocked(n) ? 'encrypted, locked' : 'encrypted, unlocked')].filter(Boolean).join(', ');
      frag.append(h('li', null, h('button', {
        type: 'button',
        class: 'note-item',
        'data-id': n.id,
        'aria-current': String(n.id === S.activeId),
      },
      h('span', { class: 'note-mark', 'aria-hidden': 'true' }, mark),
      h('span', { class: 'note-title' }, m.title, states ? h('span', { class: 'sr-only' }, ` (${states})`) : null),
      h('span', { class: 'note-meta' }, h('span', null, T.relativeTime(n.updated)), extra))));
    }
    els.noteList.replaceChildren(frag);
    els.filterRow.hidden = !S.tag;
    els.filterLabel.textContent = S.tag ? `Tagged #${S.tag}` : '';
  }

  function renderTags() {
    const counts = new Map();
    for (const n of S.notes) for (const t of metaOf(n).tags) counts.set(t, (counts.get(t) || 0) + 1);
    const tags = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 60);
    els.tagList.replaceChildren(...(tags.length
      ? tags.map(([t, c]) => h('button', { type: 'button', class: 'tag-btn', 'data-tag': t, 'aria-pressed': String(S.tag === t) }, `#${t}`, h('span', { class: 'count' }, c)))
      : [h('span', { class: 'muted' }, 'Add #tags to a note to see them here.')]));
  }

  let previewTimer = 0;
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, 120);
  }

  function renderPreview() {
    clearTimeout(previewTimer);
    const note = active();
    if (S.settings.view === 'edit' || !note) {
      els.preview.replaceChildren();
      els.backlinks.replaceChildren();
      return;
    }
    if (isLocked(note)) {
      els.preview.replaceChildren(h('p', { class: 'preview-empty' }, 'Unlock this note to preview it.'));
      els.backlinks.replaceChildren();
      return;
    }
    const body = bodyOf(note);
    let titles = null;
    const ctx = {
      readOnly: false,
      noteExists: (target) => {
        if (!titles) titles = new Set(S.notes.filter((n) => !isLocked(n)).map((n) => titleOf(n).toLowerCase()));
        return titles.has(target.trim().toLowerCase());
      },
    };
    const frag = body.trim()
      ? renderMarkdown(markdown.parse(body), ctx)
      : h('p', { class: 'preview-empty' }, 'Nothing here yet. The preview fills in as you write.');
    els.preview.replaceChildren(frag);
    renderBacklinks(note);
  }

  function renderBacklinks(note) {
    const title = titleOf(note).toLowerCase();
    const from = S.notes.filter((n) => n.id !== note.id && metaOf(n).links.includes(title));
    if (!from.length) { els.backlinks.replaceChildren(); return; }
    els.backlinks.replaceChildren(
      h('h2', null, `Linked from ${from.length} note${from.length === 1 ? '' : 's'}`),
      h('ul', null, from.map((n) => h('li', null, h('button', { type: 'button', class: 'chip', 'data-open': n.id }, titleOf(n))))),
    );
  }

  let statusTimer = 0;
  function scheduleStatus() {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(updateStatus, 60);
  }

  function updateStatus() {
    const note = active();
    const ed = els.editor;
    if (!isEditable(note)) {
      els.stPos.textContent = '';
      els.stWords.textContent = '';
      els.stSel.textContent = '';
    } else {
      const v = ed.value;
      const p = T.position(v, ed.selectionStart);
      els.stPos.textContent = `Ln ${p.line}, Col ${p.col}`;
      const st = T.stats(v);
      els.stWords.textContent = `${st.words} word${st.words === 1 ? '' : 's'}, ${st.readingMinutes} min read`;
      if (ed.selectionEnd > ed.selectionStart) {
        const sel = v.slice(ed.selectionStart, ed.selectionEnd);
        const ss = T.stats(sel);
        const ns = T.numberStats(sel);
        els.stSel.textContent = `${ss.words} selected${ns && ns.count > 1 ? `, sum ${calc.format(ns.sum)}, avg ${calc.format(ns.avg)}` : ''}`;
      } else {
        els.stSel.textContent = '';
      }
    }
    const unlocked = S.keys.size;
    els.stLock.hidden = !unlocked && !(note && note.cipher);
    els.stLock.textContent = note && note.cipher
      ? (isLocked(note) ? 'Encrypted, locked' : `Encrypted, auto-locks after ${S.settings.autoLockMinutes} min idle`)
      : `${unlocked} encrypted note${unlocked === 1 ? '' : 's'} unlocked`;
    els.stClock.textContent = T.hm(new Date());
  }

  // ---------------------------------------------------------- note actions

  function openNote(id, { focus = true } = {}) {
    if (!noteById(id)) return;
    closeSlash();
    S.activeId = id;
    schedulePersist();
    renderEditor();
    renderList();
    renderPreview();
    updateStatus();
    if (!els.findbar.hidden) computeMatches();
    runSecretScan();
    if (narrow.matches) setDrawer(false);
    if (focus && isEditable(active())) els.editor.focus();
    else if (isLocked(active())) els.unlockPass.focus();
  }

  function addNote(body, caretPos) {
    if (S.notes.length >= store.LIMITS.notes) {
      toast(`You have reached ${store.LIMITS.notes} notes. Delete some to make room.`, 'error');
      return null;
    }
    const n = store.createNote(body);
    S.notes.push(n);
    S.query = '';
    els.search.value = '';
    openNote(n.id);
    renderTags();
    if (typeof caretPos === 'number') els.editor.setSelectionRange(caretPos, caretPos);
    persistNow();
    return n;
  }

  function newNote() {
    if (S.tag) addNote(`\n\n#${S.tag}`, 0);
    else addNote('', 0);
  }

  function openDaily() {
    const title = `Log ${T.ymd(new Date())}`;
    const existing = findNoteByTitle(title);
    if (existing) { openNote(existing.id); return; }
    const body = `# ${title}\n\n- `;
    addNote(body, body.length);
  }

  function openOrCreateByTitle(raw) {
    const title = String(raw).replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
    if (!title) return;
    const existing = findNoteByTitle(title);
    if (existing) { openNote(existing.id); return; }
    const body = `# ${title}\n\n`;
    if (addNote(body, body.length)) toast(`Created "${title}".`);
  }

  function togglePin() {
    const note = active();
    if (!note) return;
    note.pinned = !note.pinned;
    persistNow();
    renderList();
    toast(note.pinned ? 'Pinned to the top of the list.' : 'Unpinned.');
  }

  function duplicateNote() {
    const note = active();
    if (!isEditable(note) || note.cipher) return;
    addNote(note.body);
  }

  async function deleteNote() {
    const note = active();
    if (!note) return;
    const ok = await confirmDialog(`Delete "${titleOf(note)}"?`, 'This cannot be undone. Export a backup first if you might need it later.', 'Delete note', true);
    if (!ok) return;
    clearTimeout(S.sealTimers.get(note.id));
    S.sealTimers.delete(note.id);
    S.notes = S.notes.filter((n) => n.id !== note.id);
    S.keys.delete(note.id);
    S.plain.delete(note.id);
    S.meta.delete(note.id);
    if (!S.notes.length) S.notes.push(store.createNote(''));
    S.activeId = sortedNotes()[0].id;
    persistNow();
    renderAll();
    toast('Note deleted.');
  }

  function setTag(tag) {
    S.tag = S.tag === tag ? null : tag;
    renderList();
    renderTags();
    if (narrow.matches && S.tag) setDrawer(true);
  }

  // ----------------------------------------------------------- the editor

  function lineBounds(value, pos) {
    const start = value.lastIndexOf('\n', pos - 1) + 1;
    let end = value.indexOf('\n', pos);
    if (end < 0) end = value.length;
    return { start, end };
  }

  /** Replace a range in the editor while keeping the browser's undo stack. */
  function replaceRange(start, end, text, caretStart = start + text.length, caretEnd = caretStart) {
    const ed = els.editor;
    ed.focus();
    ed.setSelectionRange(start, end);
    const before = ed.value;
    let ok = false;
    // execCommand acts on whatever has focus, so only use it when the editor really does.
    if (document.activeElement === ed) {
      if (text === '' && start !== end) ok = document.execCommand('delete', false);
      else if (text !== '') ok = document.execCommand('insertText', false, text);
    }
    const expected = before.slice(0, start) + text + before.slice(end);
    if (!ok || ed.value !== expected) {
      ed.value = expected;
      ed.dispatchEvent(new Event('input', { bubbles: true }));
    }
    ed.setSelectionRange(caretStart, caretEnd);
  }

  function continueList() {
    const ed = els.editor;
    const { selectionStart: s, selectionEnd: e, value } = ed;
    if (s !== e) return false;
    const { start } = lineBounds(value, s);
    const cont = T.listContinuation(value.slice(start, s));
    if (!cont) return false;
    if (cont.empty) {
      replaceRange(start, s, '');
      return true;
    }
    replaceRange(s, s, `\n${cont.prefix}`);
    return true;
  }

  function trySolveLine() {
    const ed = els.editor;
    const { selectionStart: s, selectionEnd: e, value } = ed;
    if (s !== e) return false;
    const { start, end } = lineBounds(value, s);
    if (s !== end) return false;
    const line = value.slice(start, end);
    const res = calc.solveLine(line);
    if (!res) return false;
    replaceRange(end, end, (/\s$/.test(line) ? '' : ' ') + res.text);
    return true;
  }

  function shiftLines(dir) {
    const ed = els.editor;
    const { selectionStart: s, selectionEnd: e, value } = ed;
    const start = value.lastIndexOf('\n', s - 1) + 1;
    let end = value.indexOf('\n', e > s ? e - 1 : e);
    if (end < 0) end = value.length;
    const block = value.slice(start, end);
    const out = block.split('\n').map((l) => (dir > 0 ? `  ${l}` : l.replace(/^( {1,2}|\t)/, ''))).join('\n');
    if (out === block) return;
    if (s === e) {
      const delta = out.length - block.length;
      const caretPos = Math.max(start, s + delta);
      replaceRange(start, end, out, caretPos);
    } else {
      replaceRange(start, end, out, start, start + out.length);
    }
  }

  function toggleTaskAtCaret() {
    const ed = els.editor;
    const { selectionStart: s, value } = ed;
    const { start, end } = lineBounds(value, s);
    const line = value.slice(start, end);
    const next = T.toggleTask(line);
    replaceRange(start, end, next, Math.min(start + next.length, s + (next.length - line.length)));
  }

  /** Toggle a task box from the preview without stealing focus. */
  function toggleTaskLine(lineIdx) {
    const note = active();
    if (!isEditable(note)) return;
    const ed = els.editor;
    const value = ed.value;
    let start = 0;
    for (let i = 0; i < lineIdx; i++) {
      start = value.indexOf('\n', start) + 1;
      if (start === 0) return;
    }
    let end = value.indexOf('\n', start);
    if (end < 0) end = value.length;
    const line = value.slice(start, end);
    if (!T.isTask(line)) return;
    ed.setRangeText(T.toggleTask(line), start, end, 'preserve');
    ed.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function scrollToOffset(pos) {
    const c = caret.coords(els.editor, pos);
    const ed = els.editor;
    if (c.top < 0 || c.top > ed.clientHeight - c.height * 2) ed.scrollTop += c.top - ed.clientHeight * 0.3;
  }

  function selectRange(start, end, { keepFocusOn } = {}) {
    const ed = els.editor;
    ed.focus();
    ed.setSelectionRange(start, end);
    scrollToOffset(start);
    if (keepFocusOn) keepFocusOn.focus();
    scheduleStatus();
  }

  function gotoLine(lineIdx) {
    const value = els.editor.value;
    let pos = 0;
    for (let i = 0; i < lineIdx && pos !== -1; i++) pos = value.indexOf('\n', pos) + 1 || -1;
    if (pos < 0) pos = value.length;
    selectRange(pos, pos);
  }

  function insertText(text) {
    const ed = els.editor;
    replaceRange(ed.selectionStart, ed.selectionEnd, text);
  }

  function onEditorInput() {
    const note = active();
    if (!isEditable(note)) return;
    const value = els.editor.value;
    if (value.length > store.LIMITS.body) {
      toast('This note has reached the size limit.', 'error');
      return;
    }
    note.updated = Date.now();
    if (note.cipher) {
      S.plain.set(note.id, value);
      queueSeal(note);
    } else {
      note.history = store.addSnapshot(note.history, note.body, note.updated);
      note.body = value;
      schedulePersist();
    }
    S.lastActive = Date.now();
    schedulePreview();
    scheduleStatus();
    scheduleListRefresh();
    scheduleSecretScan();
    updateSlash();
    if (!els.findbar.hidden) scheduleFind();
  }

  let listTimer = 0;
  function scheduleListRefresh() {
    clearTimeout(listTimer);
    listTimer = setTimeout(() => {
      renderList();
      renderTags();
      document.title = `${titleOf(active())} | CyberPad`;
    }, 300);
  }

  function onEditorKeydown(e) {
    const sl = S.slash;
    if (sl.open) {
      const n = sl.items.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        sl.idx = (sl.idx + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
        renderSlash();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptSlash(sl.idx); return; }
      if (e.key === 'Escape') { e.preventDefault(); closeSlash(); return; }
    }

    if (S.settings.sound && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat
      && (e.key.length === 1 || e.key === 'Enter' || e.key === 'Backspace')) {
      sound.key(e.key === 'Enter' ? 'enter' : e.key === ' ' ? 'space' : 'key');
    }

    if (e.key === 'Escape') { S.tabEscape = true; return; }
    const escaped = S.tabEscape;
    S.tabEscape = false;

    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (escaped) return; // Esc then Tab moves focus out of the editor.
      e.preventDefault();
      const ed = els.editor;
      if (e.shiftKey) shiftLines(-1);
      else if (trySolveLine()) { /* inserted the result */ }
      else if (ed.value.slice(ed.selectionStart, ed.selectionEnd).includes('\n')) shiftLines(1);
      else replaceRange(ed.selectionStart, ed.selectionEnd, '  ');
      return;
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      toggleTaskAtCaret();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && !e.isComposing) {
      if (continueList()) e.preventDefault();
    }
  }

  /** Pasting a URL over selected text turns it into a Markdown link. */
  function onEditorPaste(e) {
    const ed = els.editor;
    if (ed.selectionStart === ed.selectionEnd || !e.clipboardData) return;
    const pasted = e.clipboardData.getData('text/plain').trim();
    const href = markdown.safeUrl(pasted);
    if (!href || pasted.length > 2000) return;
    const sel = ed.value.slice(ed.selectionStart, ed.selectionEnd);
    if (sel.includes('\n') || sel.length > 300) return;
    e.preventDefault();
    replaceRange(ed.selectionStart, ed.selectionEnd, `[${sel}](${href})`);
  }

  // ------------------------------------------------------------ slash menu

  function updateSlash() {
    const ed = els.editor;
    const s = ed.selectionStart;
    if (s !== ed.selectionEnd || document.activeElement !== ed) { closeSlash(); return; }
    const v = ed.value;
    const from = Math.max(0, s - 14);
    const m = /\/([a-z0-9]{0,12})$/i.exec(v.slice(from, s));
    if (!m) { closeSlash(); return; }
    const at = from + m.index;
    if (at > 0 && !/\s/.test(v[at - 1])) { closeSlash(); return; }
    const q = m[1].toLowerCase();
    const items = T.SLASH.filter((c) => c.name.startsWith(q));
    if (!items.length) { closeSlash(); return; }
    const sl = S.slash;
    if (!sl.open || sl.query !== q) sl.idx = 0;
    Object.assign(sl, { open: true, items, start: at, query: q });
    renderSlash();
  }

  function renderSlash() {
    const sl = S.slash;
    els.slash.replaceChildren(...sl.items.map((c, i) => h('div', {
      class: 'slash-item', role: 'option', 'data-idx': i, 'aria-selected': String(i === sl.idx), id: `slash-${c.name}`,
    }, h('span', { class: 'name' }, `/${c.name}`), h('span', { class: 'desc' }, c.desc))));
    els.slash.hidden = false;
    els.editor.setAttribute('aria-activedescendant', `slash-${sl.items[sl.idx].name}`);
    const c = caret.coords(els.editor, sl.start);
    const r = els.editor.getBoundingClientRect();
    const box = els.slash.getBoundingClientRect();
    let top = r.top + c.top + c.height + 4;
    if (top + box.height > window.innerHeight - 8) top = Math.max(8, r.top + c.top - box.height - 4);
    const left = Math.min(Math.max(8, r.left + c.left), window.innerWidth - box.width - 8);
    els.slash.style.top = `${top}px`;
    els.slash.style.left = `${left}px`;
    const sel = els.slash.querySelector('[aria-selected="true"]');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  function closeSlash() {
    if (!S.slash.open) return;
    S.slash.open = false;
    els.slash.hidden = true;
    els.editor.removeAttribute('aria-activedescendant');
  }

  const slashCtx = () => ({ now: new Date(), uuid: () => crypto.randomUUID() });

  /** Inserts a slash expansion. Block templates always start on a line of their own. */
  function insertExpansion(ex, start, end) {
    let { text, caret: at } = ex;
    const v = els.editor.value;
    if (ex.block && start > 0 && v[start - 1] !== '\n') {
      while (start > 0 && (v[start - 1] === ' ' || v[start - 1] === '\t')) start--; // no trailing spaces left behind
      if (start > 0 && v[start - 1] !== '\n') {
        text = `\n${text}`;
        at += 1;
      }
    }
    replaceRange(start, end, text, start + at);
  }

  function insertSlash(name) {
    const ex = T.expandSlash(name, slashCtx());
    if (ex) insertExpansion(ex, els.editor.selectionStart, els.editor.selectionEnd);
  }

  function acceptSlash(i) {
    const sl = S.slash;
    const cmd = sl.items[i];
    if (!cmd) return;
    const ex = T.expandSlash(cmd.name, slashCtx());
    const start = sl.start;
    const end = els.editor.selectionStart;
    closeSlash();
    insertExpansion(ex, start, end);
    closeSlash();
  }

  // ---------------------------------------------------------- find/replace

  function findPattern(flagsExtra = '') {
    const q = els.findInput.value;
    if (!q) return null;
    const src = S.find.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(src, `${S.find.case ? '' : 'i'}${S.find.regex ? 'm' : ''}${flagsExtra}`);
  }

  function computeMatches() {
    const f = S.find;
    f.matches = [];
    f.idx = -1;
    f.capped = false;
    let re;
    try {
      re = findPattern('g');
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      els.findCount.textContent = 'Invalid pattern';
      return;
    }
    if (!re) { els.findCount.textContent = ''; return; }
    const text = els.editor.value;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      if (f.matches.length >= 10000) { f.capped = true; break; }
      f.matches.push([m.index, m.index + m[0].length]);
    }
    const s = els.editor.selectionStart;
    const e = els.editor.selectionEnd;
    f.idx = f.matches.findIndex(([a, b]) => a === s && b === e);
    updateFindCount();
  }

  let findTimer = 0;
  function scheduleFind() {
    clearTimeout(findTimer);
    findTimer = setTimeout(computeMatches, 150);
  }

  function updateFindCount() {
    const f = S.find;
    if (!els.findInput.value) els.findCount.textContent = '';
    else if (!f.matches.length) els.findCount.textContent = 'No matches';
    else els.findCount.textContent = `${f.idx >= 0 ? f.idx + 1 : '-'} of ${f.matches.length}${f.capped ? '+' : ''}`;
  }

  function openFind(focusReplace = false) {
    const note = active();
    if (!isEditable(note)) return;
    els.findbar.hidden = false;
    const ed = els.editor;
    const sel = ed.value.slice(ed.selectionStart, ed.selectionEnd);
    if (sel && !sel.includes('\n') && sel.length <= 200) els.findInput.value = sel;
    const target = focusReplace ? els.replaceInput : els.findInput;
    target.focus();
    target.select();
    computeMatches();
  }

  function closeFind() {
    els.findbar.hidden = true;
    els.editor.focus();
  }

  function findStep(dir, keepFocusOn) {
    if (els.findbar.hidden) { openFind(); return; }
    computeMatches();
    const f = S.find;
    if (!f.matches.length) return;
    const ed = els.editor;
    let i;
    if (dir > 0) {
      i = f.matches.findIndex(([a]) => a >= ed.selectionEnd);
      if (i < 0) i = 0;
    } else {
      i = -1;
      for (let k = f.matches.length - 1; k >= 0; k--) if (f.matches[k][1] <= ed.selectionStart) { i = k; break; }
      if (i < 0) i = f.matches.length - 1;
    }
    f.idx = i;
    selectRange(f.matches[i][0], f.matches[i][1], { keepFocusOn });
    updateFindCount();
  }

  function replacementFor(matched) {
    const repl = els.replaceInput.value;
    if (!S.find.regex) return repl;
    return matched.replace(findPattern(), repl);
  }

  function replaceOne() {
    computeMatches();
    const f = S.find;
    if (f.idx < 0) { findStep(1, els.replaceInput); return; }
    const [s, e] = f.matches[f.idx];
    const repl = replacementFor(els.editor.value.slice(s, e));
    replaceRange(s, e, repl, s + repl.length);
    findStep(1, els.replaceInput);
  }

  function replaceAll() {
    computeMatches();
    const count = S.find.matches.length;
    if (!count) { toast('Nothing to replace.'); return; }
    const re = findPattern('g');
    const value = els.editor.value;
    const repl = els.replaceInput.value;
    const out = S.find.regex ? value.replace(re, repl) : value.replace(re, () => repl);
    replaceRange(0, value.length, out, 0);
    computeMatches();
    toast(`Replaced ${count}${S.find.capped ? '+' : ''} match${count === 1 ? '' : 'es'}. Press Ctrl+Z to undo.`);
  }

  // --------------------------------------------------------------- palette

  function commandList() {
    const note = active();
    const editable = isEditable(note);
    const C = (group, title, run, keys, when = true) => ({ group, title, run, keys, when });
    const tf = (title, key) => C('Transform', title, () => applyTransform(T.TRANSFORMS[key], title), null, editable);
    const sx = (title, key) => C('Security', title, () => applyTransform(secops.TRANSFORMS[key], title), null, editable);
    return [
      C('Note', 'New note', newNote, 'Alt N'),
      C('Note', 'Open today’s log', openDaily, 'Alt T'),
      C('Note', note && note.pinned ? 'Unpin note' : 'Pin note', togglePin, 'Alt P', !!note),
      C('Note', 'Duplicate note', duplicateNote, null, editable && !note.cipher),
      C('Note', 'Show version history', showHistory, null, editable),
      C('Note', 'Go to heading', () => setTimeout(() => openPalette('@'), 0), '@', editable),
      C('Note', 'Delete note', deleteNote, null, !!note),
      C('File', 'Export note as Markdown', exportNote, null, editable),
      C('File', 'Export backup of all notes', exportBackup),
      C('File', 'Export encrypted backup of all notes', exportEncryptedBackup),
      C('File', 'Import a file', () => els.fileInput.click()),
      C('View', 'Layout: Write only', () => setView('edit'), null, S.settings.view !== 'edit'),
      C('View', 'Layout: Split', () => setView('split'), null, S.settings.view !== 'split'),
      C('View', 'Layout: Read only', () => setView('preview'), null, S.settings.view !== 'preview'),
      C('View', 'Show or hide note list', toggleSidebar, 'Ctrl B'),
      C('View', 'Zen mode', toggleZen, 'Alt Z'),
      C('View', 'Find and replace', () => openFind(), 'Ctrl F', editable),
      ...store.THEMES.filter((t) => t !== S.settings.theme).map((t) => C('Theme', `Theme: ${THEME_NAMES[t]}`, () => setTheme(t))),
      C('View', S.settings.crt ? 'Turn off CRT effect' : 'Turn on CRT effect', toggleCrt),
      C('View', S.settings.sound ? 'Turn off typing sounds' : 'Turn on typing sounds', toggleSound),
      C('View', S.settings.boot ? 'Skip the boot screen on start' : 'Show the boot screen on start', toggleBoot),
      C('View', 'Keyboard shortcuts', showShortcuts, 'F1'),
      C('View', 'About CyberPad', showAbout, null, platform.isDesktop),
      C('Insert', 'Insert date', () => insertText(T.ymd(new Date())), '/date', editable),
      C('Insert', 'Insert time', () => insertText(T.hm(new Date())), '/time', editable),
      C('Insert', 'Insert table', () => insertText(T.expandSlash('table', {}).text), '/table', editable),
      C('Templates', 'Insert pentest finding', () => insertSlash('finding'), '/finding', editable),
      C('Templates', 'Insert IOC table', () => insertSlash('ioc'), '/ioc', editable),
      C('Templates', 'Insert incident timeline (UTC)', () => insertSlash('timeline'), '/timeline', editable),
      C('Templates', 'Insert UTC timestamp', () => insertSlash('utc'), '/utc', editable),
      tf('UPPERCASE', 'upper'),
      tf('lowercase', 'lower'),
      tf('Title Case', 'title'),
      tf('Sort lines', 'sortLines'),
      tf('Reverse lines', 'reverseLines'),
      tf('Remove duplicate lines', 'dedupeLines'),
      tf('Remove empty lines', 'removeEmptyLines'),
      tf('Trim trailing spaces', 'trimTrailing'),
      tf('Number lines', 'numberLines'),
      tf('Base64 encode', 'base64Encode'),
      tf('Base64 decode', 'base64Decode'),
      tf('URL encode', 'urlEncode'),
      tf('URL decode', 'urlDecode'),
      tf('Format JSON', 'jsonPretty'),
      tf('Minify JSON', 'jsonMinify'),
      C('Tools', 'Calculate selection', calcSelection, null, editable),
      C('Tools', 'Sum numbers in selection', sumSelection, null, editable),
      C('Tools', 'Start 25-minute focus timer', () => startTimer(25, 'Focus')),
      C('Tools', 'Start 5-minute break timer', () => startTimer(5, 'Break')),
      C('Tools', 'Stop timer', () => stopTimer(false), null, !!S.timer),
      C('Vault', 'Encrypt note', encryptActive, null, editable && !note.cipher),
      C('Vault', 'Remove encryption', decryptActive, null, editable && !!note.cipher),
      C('Vault', 'Lock encrypted notes', () => lockAll(), 'Alt L', S.keys.size > 0),
      C('Vault', `Auto-lock after ${S.settings.autoLockMinutes} min idle: change`, cycleAutoLock),
      C('Vault', S.settings.lockOnHide ? 'Stop locking encrypted notes when the tab is hidden' : 'Lock encrypted notes when the tab is hidden', toggleLockOnHide),
      C('Vault', S.settings.clearClipboard ? 'Stop clearing the clipboard after copying from encrypted notes' : 'Clear the clipboard 30 s after copying from encrypted notes', toggleClearClipboard),
      C('Security', 'Extract IOCs', showIocs, null, editable),
      sx('Defang IOCs', 'defang'),
      sx('Refang IOCs', 'refang'),
      C('Security', 'Scan note for secrets', () => showSecretFindings(false), null, editable),
      C('Security', 'Mask secrets in note', maskSecretsActive, null, editable),
      C('Security', 'Hash selection (SHA-1, SHA-256, SHA-384, SHA-512)', hashSelection, null, editable),
      C('Security', 'Hash a file', () => els.hashFileInput.click()),
      C('Security', 'Decode JWT', decodeJwtDialog, null, editable),
      C('Security', 'Convert timestamp', timestampDialog, null, editable),
      C('Security', 'CVSS 3.1 calculator', () => cvssDialog()),
      C('Security', 'Subnet calculator (IPv4 and IPv6)', subnetDialog),
      sx('Hex encode', 'hexEncode'),
      sx('Hex decode', 'hexDecode'),
      sx('HTML entity encode', 'htmlEncode'),
      sx('HTML entity decode', 'htmlDecode'),
      sx('ROT13', 'rot13'),
    ].filter((c) => c.when);
  }

  function paletteItems(query) {
    const q = query.trim();
    if (q.startsWith('@')) {
      const note = active();
      if (!isEditable(note)) return [];
      const hq = q.slice(1).trim();
      return T.headings(els.editor.value)
        .map((hd) => ({ group: 'Headings', title: `${'  '.repeat(hd.level - 1)}${hd.text}`, keys: `Ln ${hd.line + 1}`, run: () => gotoLine(hd.line), score: hq ? T.fuzzyScore(hq, hd.text) : 1 }))
        .filter((i) => i.score > 0);
    }
    const cmds = commandList();
    const notes = sortedNotes().map((n) => ({ group: 'Notes', title: titleOf(n), keys: T.relativeTime(n.updated), run: () => openNote(n.id), id: n.id }));
    if (!q) {
      return [...notes.filter((n) => n.id !== S.activeId).slice(0, 5).map((n) => ({ ...n, group: 'Recent notes' })), ...cmds];
    }
    return [...cmds, ...notes]
      .map((i) => ({ ...i, score: Math.max(T.fuzzyScore(q, i.title), T.fuzzyScore(q, `${i.group} ${i.title}`) - 50) }))
      .filter((i) => i.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 60);
  }

  // Chromium resets a textarea's selection when a modal <dialog> closes and
  // hands focus back to it, so dialogs snapshot and restore it themselves.
  function saveEditorSelection() {
    const ed = els.editor;
    return { start: ed.selectionStart, end: ed.selectionEnd, dir: ed.selectionDirection, top: ed.scrollTop };
  }

  function restoreEditorSelection(sel) {
    if (!sel || els.editor.hidden) return;
    els.editor.setSelectionRange(sel.start, sel.end, sel.dir);
    els.editor.scrollTop = sel.top;
  }

  function openPalette(prefill = '') {
    closeSlash();
    if (els.modal.open) return;
    if (!els.palette.open) {
      S.paletteSel = saveEditorSelection();
      els.palette.showModal();
    }
    els.paletteInput.value = prefill;
    S.pal.idx = 0;
    renderPalette();
    els.paletteInput.focus();
    els.paletteInput.setSelectionRange(prefill.length, prefill.length);
  }

  function renderPalette() {
    const q = els.paletteInput.value;
    const items = paletteItems(q);
    S.pal.items = items;
    S.pal.idx = Math.min(S.pal.idx, Math.max(0, items.length - 1));
    const frag = document.createDocumentFragment();
    let group = null;
    const grouped = !q.trim() || q.trim().startsWith('@');
    items.forEach((item, i) => {
      if (grouped && item.group !== group) {
        group = item.group;
        frag.append(h('li', { class: 'palette-group', role: 'presentation' }, group));
      }
      frag.append(h('li', {
        class: 'palette-item', role: 'option', id: `pal-${i}`, 'data-idx': i, 'aria-selected': String(i === S.pal.idx),
      },
      h('span', { class: 'label' }, item.title),
      !grouped ? h('span', { class: 'hint' }, item.group) : null,
      item.keys ? h('kbd', null, item.keys) : null));
    });
    if (!items.length) {
      frag.append(h('li', { class: 'palette-empty' }, q.trim().startsWith('@') ? 'This note has no headings. Start a line with # to make one.' : 'Nothing matches. Try another word.'));
    }
    els.paletteList.replaceChildren(frag);
    els.paletteInput.setAttribute('aria-activedescendant', items.length ? `pal-${S.pal.idx}` : '');
    const sel = els.paletteList.querySelector('[aria-selected="true"]');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  // Chromium fires the dialog 'close' event a few hundred ms after close(), and
  // resets the editor selection in between, so restore it synchronously here.
  function closePalette() {
    if (!els.palette.open) return;
    const sel = S.paletteSel;
    S.paletteSel = null;
    els.palette.close();
    if (sel && !els.modal.open && isEditable(active())) {
      els.editor.focus();
      restoreEditorSelection(sel);
    }
  }

  function runPaletteItem(i) {
    const item = S.pal.items[i];
    if (!item) return;
    closePalette(); // commands act on the selection the user had
    item.run();
  }

  function applyTransform(fn, name) {
    const note = active();
    if (!isEditable(note) || typeof fn !== 'function') return;
    const ed = els.editor;
    let s = ed.selectionStart;
    let e = ed.selectionEnd;
    const whole = s === e;
    if (whole) { s = 0; e = ed.value.length; }
    let out;
    try {
      out = fn(ed.value.slice(s, e));
    } catch (err) {
      if (!(err instanceof T.TransformError) && !(err instanceof secops.SecOpsError)) throw err;
      toast(err.message, 'error');
      return;
    }
    if (out.length > store.LIMITS.body) { toast('The result would be too long for one note.', 'error'); return; }
    replaceRange(s, e, out, s, s + out.length);
    toast(`${name}: applied to ${whole ? 'the whole note' : 'the selection'}.`);
  }

  function selectedText() {
    const ed = els.editor;
    return ed.value.slice(ed.selectionStart, ed.selectionEnd);
  }

  function calcSelection() {
    const sel = selectedText().trim();
    if (!sel) { toast('Select a sum first, like 12 * (3 + 4).'); return; }
    try {
      const value = calc.evaluate(sel.replace(/=\s*$/, ''));
      const ed = els.editor;
      replaceRange(ed.selectionEnd, ed.selectionEnd, ` = ${calc.format(value)}`);
    } catch (err) {
      if (!(err instanceof calc.CalcError)) throw err;
      toast(`That selection is not a sum I can work out: ${err.message}.`, 'error');
    }
  }

  function sumSelection() {
    const ns = T.numberStats(selectedText());
    if (!ns) { toast('Select some text that contains numbers.'); return; }
    toast(`${ns.count} numbers: sum ${calc.format(ns.sum)}, average ${calc.format(ns.avg)}, min ${calc.format(ns.min)}, max ${calc.format(ns.max)}.`);
  }

  // -------------------------------------------------------- security tools

  /** The selection, or the whole note when nothing is selected. */
  function scopeText() {
    const ed = els.editor;
    const whole = ed.selectionStart === ed.selectionEnd;
    return { text: whole ? ed.value : ed.value.slice(ed.selectionStart, ed.selectionEnd), whole };
  }

  function copyRow(label, value) {
    const btn = h('button', { type: 'button', class: 'chip' }, 'Copy');
    btn.addEventListener('click', () => copyText(value));
    return h('div', { class: 'result-row' }, h('span', { class: 'result-label' }, label), h('pre', { class: 'result-value' }, value), btn);
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  // IOC extractor --------------------------------------------------------

  async function showIocs() {
    const note = active();
    if (!isEditable(note)) return;
    const { text, whole } = scopeText();
    const where = whole ? 'this note' : 'the selection';
    const iocs = secops.extractIocs(text);
    const total = secops.iocCount(iocs);
    if (!total) { toast(`No IOCs found in ${where}.`); return; }

    const defangBox = h('input', { type: 'checkbox', checked: true });
    const list = h('div', { class: 'result-list' });
    const fill = () => {
      const def = defangBox.checked;
      list.replaceChildren(...secops.IOC_TYPES
        .filter(([k]) => iocs[k].length)
        .map(([k, label]) => copyRow(`${label} (${iocs[k].length})`, iocs[k].map((v) => (def ? secops.defangValue(k, v) : v)).join('\n'))));
    };
    defangBox.addEventListener('change', fill);
    fill();

    const res = await showDialog({
      title: `${plural(total, 'IOC')} found in ${where}`,
      className: 'wide',
      body: [h('label', { class: 'check' }, defangBox, 'Defang values, so they are safe to paste into tickets and chat'), list],
      actions: [
        { label: 'Close', value: null },
        { label: 'Download CSV', value: 'csv' },
        { label: 'Open as new note', value: 'note', className: 'btn-primary' },
      ],
    });
    const defanged = defangBox.checked;
    const stamp = new Date().toISOString();
    if (res === 'csv') {
      const saved = await exportOut('iocCsv', `iocs-${T.slugify(titleOf(note))}-${stamp.slice(0, 10)}.csv`, secops.iocsToCsv(iocs, { defanged }), 'text/csv;charset=utf-8');
      if (saved) toast(`Saved ${saved}. Cells that a spreadsheet could run as formulas are escaped.`);
    } else if (res === 'note') {
      addNote(secops.iocsToMarkdown(iocs, { defanged, source: titleOf(note), when: `${stamp.slice(0, 16).replace('T', ' ')} UTC` }));
    }
  }

  // Secret scanner -------------------------------------------------------

  let secretTimer = 0;
  function scheduleSecretScan() {
    clearTimeout(secretTimer);
    secretTimer = setTimeout(runSecretScan, 700);
  }

  const findingSignature = (findings) => findings.map((f) => `${f.id}:${f.value}`).join('\u0000');

  /** Warn when a plain-text note looks like it holds credentials. */
  function runSecretScan() {
    clearTimeout(secretTimer);
    const note = active();
    if (!isEditable(note) || note.cipher) {
      S.secretFindings = [];
      els.secretAlert.hidden = true;
      return;
    }
    const findings = secops.scanSecrets(els.editor.value);
    S.secretFindings = findings;
    if (!findings.length || S.secretIgnored.get(note.id) === findingSignature(findings)) {
      els.secretAlert.hidden = true;
      return;
    }
    const kinds = [...new Set(findings.map((f) => f.label))];
    const msg = `This note is saved as plain text and seems to contain ${findings.length === 1 ? 'a secret' : `${findings.length} secrets`}: `
      + `${kinds.slice(0, 3).join(', ')}${kinds.length > 3 ? `, and ${kinds.length - 3} more kinds` : ''}.`;
    if (els.secretAlertText.textContent !== msg) els.secretAlertText.textContent = msg;
    els.secretAlert.hidden = false;
  }

  function ignoreSecrets() {
    const note = active();
    if (!note) return;
    S.secretIgnored.set(note.id, findingSignature(S.secretFindings));
    els.secretAlert.hidden = true;
    toast('Warning hidden for now. It comes back if new secrets appear in this note.');
  }

  async function maskSecretsActive() {
    const note = active();
    if (!isEditable(note)) return;
    const value = els.editor.value;
    const findings = secops.scanSecrets(value);
    if (!findings.length) { toast('No likely secrets found in this note.'); return; }
    const ok = await confirmDialog(
      `Mask ${plural(findings.length, 'secret')}?`,
      'Each one is replaced with a [REDACTED] marker, and the same values are removed from this note’s version history. Rotate the real credentials as well: copies saved before now, such as exported backups, still contain them.',
      'Mask secrets',
      true,
    );
    if (!ok) return;
    if (active() !== note || !isEditable(note) || els.editor.value !== value) { toast('The note changed while the dialog was open. Run the scan again.', 'error'); return; }
    const masked = secops.maskSecrets(value, findings);
    const values = findings.map((f) => f.value);
    // Update the stored copy first, so no history snapshot of the unmasked text is taken.
    if (note.cipher) {
      S.plain.set(note.id, masked);
    } else {
      note.body = masked;
      note.history = note.history.map((snap) => ({ t: snap.t, body: secops.scrubValues(snap.body, values) }));
    }
    replaceRange(0, value.length, masked, 0);
    persistNow();
    runSecretScan();
    toast(`Masked ${plural(findings.length, 'secret')}. Remember to rotate them.`);
  }

  async function showSecretFindings() {
    const note = active();
    if (!isEditable(note)) return;
    const findings = secops.scanSecrets(els.editor.value);
    if (!findings.length) { toast('No likely secrets found in this note.'); return; }
    const encrypted = !!note.cipher;
    const list = h('ul', { class: 'finding-list' }, findings.map((f) => {
      const b = h('button', { type: 'button', title: 'Select it in the editor' },
        h('span', { class: 'line' }, `Ln ${f.line}`),
        h('span', { class: 'kind' }, f.label),
        h('span', { class: 'masked' }, f.preview));
      b.addEventListener('click', () => {
        if (finishCurrentDialog) finishCurrentDialog(null);
        selectRange(f.start, f.end);
      });
      return h('li', null, b);
    }));
    const res = await showDialog({
      title: `${plural(findings.length, 'likely secret')} in this note`,
      className: 'wide',
      body: [
        h('p', null, encrypted
          ? 'This note is encrypted, so these values are only stored as ciphertext.'
          : `This note is saved as plain text ${platform.isDesktop ? 'in the data folder' : 'in browser storage'}. Encrypt it, or mask the values and rotate the real credentials.`),
        list,
        h('p', null, 'Detection is pattern-based: it can miss secrets and flag harmless text. Values are masked here and never logged.'),
      ],
      actions: [
        { label: 'Close', value: null },
        { label: 'Mask all', value: 'mask', className: 'btn-danger' },
        ...(encrypted ? [] : [{ label: 'Encrypt note', value: 'encrypt', className: 'btn-primary' }]),
      ],
    });
    if (res === 'mask') maskSecretsActive();
    else if (res === 'encrypt') encryptActive();
  }

  // Hashes ---------------------------------------------------------------

  const MAX_HASH_FILE = 256 * 1024 * 1024;

  function showHashDialog(title, detail, hashes) {
    showDialog({
      title,
      className: 'wide',
      body: [
        h('p', null, `${detail} SHA-1 is only for matching existing indicators. MD5 is not offered because browsers do not provide it, and this app does not ship its own hash code.`),
        h('div', { class: 'result-list' }, Object.entries(hashes).map(([k, v]) => copyRow(k, v))),
      ],
      actions: [{ label: 'Close', value: null, className: 'btn-primary' }],
    });
  }

  async function hashSelection() {
    const { text, whole } = scopeText();
    if (!text) { toast('There is nothing to hash yet.'); return; }
    let hashes;
    try {
      hashes = await secops.hashText(text);
    } catch (err) {
      if (!(err instanceof secops.SecOpsError)) throw err;
      toast(err.message, 'error');
      return;
    }
    showHashDialog(`Hashes of ${whole ? 'the whole note' : 'the selection'}`, `Input: ${new TextEncoder().encode(text).length.toLocaleString()} bytes of UTF-8 text.`, hashes);
  }

  async function hashFile(file) {
    if (!file) return;
    if (file.size > MAX_HASH_FILE) { toast('That file is larger than 256 MB, the limit for hashing in the browser.', 'error'); return; }
    toast(`Hashing ${file.name}…`);
    let hashes;
    try {
      hashes = await secops.hashBytes(await file.arrayBuffer());
    } catch (err) {
      if (err instanceof secops.SecOpsError) toast(err.message, 'error');
      else { console.error(err); toast('That file could not be read.', 'error'); }
      return;
    }
    showHashDialog(`Hashes of ${file.name}`, `Input: ${file.size.toLocaleString()} bytes. The file was only read, never opened or run, and nothing was uploaded.`, hashes);
  }

  // JWT ------------------------------------------------------------------

  function decodeJwtDialog() {
    const { text } = scopeText();
    const token = secops.findJwt(text) || text.trim();
    if (!token) { toast('Select a JWT, or put one in the note.'); return; }
    let r;
    try {
      r = secops.decodeJwt(token);
    } catch (err) {
      if (!(err instanceof secops.SecOpsError)) throw err;
      toast(err.message, 'error');
      return;
    }
    const badges = [];
    if (r.expired === true) badges.push(h('span', { class: 'badge bad' }, 'Expired'));
    if (r.expired === false) badges.push(h('span', { class: 'badge good' }, 'Not expired'));
    if (r.notYetValid) badges.push(h('span', { class: 'badge bad' }, 'Not valid yet'));
    if (!r.signed || (r.alg || '').toLowerCase() === 'none') badges.push(h('span', { class: 'badge bad' }, 'Unsigned (alg: none)'));
    const claimNames = { iat: 'Issued at', nbf: 'Not before', exp: 'Expires' };
    showDialog({
      title: `Decoded JWT${r.alg ? ` (${r.alg})` : ''}`,
      className: 'wide',
      body: [
        h('p', null, 'Decoded only. The signature was not verified, so treat these claims as untrusted.'),
        badges.length ? h('p', null, badges.flatMap((b, i) => (i ? [' ', b] : [b]))) : null,
        h('div', { class: 'result-list' },
          copyRow('Header', JSON.stringify(r.header, null, 2)),
          copyRow('Payload', JSON.stringify(r.payload, null, 2)),
          Object.entries(r.claims).map(([k, iso]) => copyRow(`${claimNames[k]} (${k})`, `${iso}\n${new Date(iso).toLocaleString()} local`))),
      ],
      actions: [{ label: 'Close', value: null, className: 'btn-primary' }],
    });
  }

  // Timestamps -----------------------------------------------------------

  function tokenAtCaret() {
    const ed = els.editor;
    const v = ed.value;
    const s = ed.selectionStart;
    let a = s;
    let b = s;
    while (a > 0 && s - a < 64 && /[\w:.+-]/.test(v[a - 1])) a--;
    while (b < v.length && b - s < 64 && /[\w:.+-]/.test(v[b])) b++;
    return v.slice(a, b);
  }

  function timestampDialog() {
    const input = (selectedText() || tokenAtCaret()).trim();
    if (!input) { toast('Put the cursor on a timestamp, or select one.'); return; }
    let r;
    try {
      r = secops.convertTimestamp(input);
    } catch (err) {
      if (!(err instanceof secops.SecOpsError)) throw err;
      toast(err.message, 'error');
      return;
    }
    showDialog({
      title: 'Timestamp',
      className: 'wide',
      body: [
        h('p', null, `Read "${input}" as ${r.kind}.`),
        h('div', { class: 'result-list' },
          copyRow('UTC (ISO 8601)', r.iso),
          copyRow('Local time', `${r.date.toLocaleString()} (${T.relativeTime(r.unixMs)})`),
          copyRow('Unix seconds', String(r.unixSeconds)),
          copyRow('Unix milliseconds', String(r.unixMs)),
          copyRow('Windows FILETIME / AD', r.filetime.toString())),
      ],
      actions: [{ label: 'Close', value: null, className: 'btn-primary' }],
    });
  }

  // CVSS -----------------------------------------------------------------

  const DEFAULT_CVSS = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N';

  /** A vector in the selection, or on the caret's line, with its range in the note. */
  function vectorInEditor() {
    const ed = els.editor;
    const v = ed.value;
    let from;
    let text;
    let caretAt = -1;
    if (ed.selectionStart !== ed.selectionEnd) {
      from = ed.selectionStart;
      text = v.slice(from, ed.selectionEnd);
    } else {
      const b = lineBounds(v, ed.selectionStart);
      from = b.start;
      text = v.slice(b.start, b.end);
      caretAt = ed.selectionStart - b.start;
    }
    const found = cvss.findVectors(text);
    const hit = found.find((f) => caretAt >= f.index && caretAt <= f.index + f.vector.length) || found[0];
    return hit ? { vector: hit.vector, start: from + hit.index, end: from + hit.index + hit.vector.length } : null;
  }

  function locateVector(vector) {
    const at = els.editor.value.indexOf(vector);
    return at < 0 ? null : { vector, start: at, end: at + vector.length };
  }

  async function cvssDialog(initial) {
    const editable = isEditable(active());
    let target = null;
    if (editable) target = initial ? locateVector(initial) : vectorInEditor();
    const input = h('input', { type: 'text', class: 'cvss-input', maxlength: cvss.MAX_VECTOR, autocomplete: 'off', 'aria-label': 'CVSS vector' });
    input.spellcheck = false;
    input.value = initial || (target && target.vector) || DEFAULT_CVSS;
    const copyBtn = h('button', { type: 'button', class: 'chip' }, 'Copy');
    const err = h('p', { class: 'form-error', role: 'alert' });
    const scoreNum = h('span', { class: 'cvss-score-num' });
    const scoreSev = h('span', { class: 'sev' });
    const sub = h('span', { class: 'cvss-sub' });
    const radios = new Map();
    let state = null; // last valid result

    const update = (fromInput) => {
      let r;
      try {
        r = cvss.calculate(input.value);
      } catch (e) {
        if (!(e instanceof cvss.CvssError)) throw e;
        err.textContent = e.message;
        return;
      }
      err.textContent = '';
      state = r;
      if (!fromInput) input.value = r.vector;
      for (const [k, opts] of radios) {
        const cur = Object.prototype.hasOwnProperty.call(r.metrics, k) ? r.metrics[k] : 'X';
        for (const [val, el] of Object.entries(opts)) el.checked = val === cur;
      }
      scoreNum.textContent = r.base.toFixed(1);
      scoreSev.textContent = r.baseSeverity;
      scoreSev.className = `sev sev-${r.baseSeverity.toLowerCase()}`;
      const extra = [`Impact ${r.impact.toFixed(1)}`, `Exploitability ${r.exploitability.toFixed(1)}`];
      if (r.temporal !== null) extra.push(`Temporal ${r.temporal.toFixed(1)} ${r.temporalSeverity}`);
      if (r.environmental !== null) extra.push(`Environmental ${r.environmental.toFixed(1)} ${r.environmentalSeverity}`);
      sub.textContent = extra.join(', ');
    };

    const setMetric = (k, val) => {
      const from = state || cvss.calculate(DEFAULT_CVSS);
      input.value = cvss.buildVector(from.version, { ...from.metrics, [k]: val });
      update(false);
    };

    const fieldsets = (keys) => keys.map((k) => {
      const def = cvss.METRICS[k];
      const opts = {};
      const row = h('div', { class: 'cvss-opts' });
      for (const [val, label] of Object.entries(def.values)) {
        const radio = h('input', { type: 'radio', name: `cvss-${k}`, value: val });
        radio.addEventListener('change', () => setMetric(k, val));
        opts[val] = radio;
        row.append(h('label', { title: `${k}:${val}` }, radio, h('span', null, label)));
      }
      radios.set(k, opts);
      return h('fieldset', { class: 'cvss-metric' }, h('legend', null, `${def.name} (${k})`), row);
    });

    input.addEventListener('input', () => update(true));
    copyBtn.addEventListener('click', () => { if (state && !err.textContent) copyText(state.vector); else input.focus(); });

    const definedIn = (keys) => keys.some((k) => new RegExp(`/${k}:[^X/]`).test(input.value));
    const temporal = h('details', { class: 'cvss-more' }, h('summary', null, 'Temporal metrics'), h('div', { class: 'cvss-grid' }, fieldsets(cvss.TEMPORAL)));
    const env = h('details', { class: 'cvss-more' }, h('summary', null, 'Environmental metrics'), h('div', { class: 'cvss-grid' }, fieldsets(cvss.ENVIRONMENTAL)));
    temporal.open = definedIn(cvss.TEMPORAL);
    env.open = definedIn(cvss.ENVIRONMENTAL);

    const actions = [{ label: 'Close', value: null }];
    if (editable) actions.push({ label: target ? 'Update in note' : 'Insert at cursor', submit: true, className: 'btn-primary' });
    const promise = showDialog({
      title: 'CVSS 3.1 calculator',
      className: 'wide cvss',
      initialFocus: '.cvss-input',
      body: [
        h('div', { class: 'cvss-vector-row' }, input, copyBtn),
        err,
        h('div', { class: 'cvss-score', 'aria-live': 'polite' }, scoreNum, scoreSev, sub),
        h('div', { class: 'cvss-grid' }, fieldsets(cvss.BASE)),
        temporal,
        env,
      ],
      actions,
      onSubmit: () => {
        if (!state || err.textContent) { input.focus(); return undefined; }
        return state.vector;
      },
    });
    update(true);
    const result = await promise;
    if (!result || !editable) return;
    if (target && els.editor.value.slice(target.start, target.end) === target.vector) {
      if (result !== target.vector) replaceRange(target.start, target.end, result);
    } else {
      insertText(result);
    }
  }

  // Subnets --------------------------------------------------------------

  /** A network in the selection, or on the caret's line. */
  function networkInEditor() {
    if (!isEditable(active())) return '';
    const sel = selectedText().trim();
    if (sel) {
      if (sel.length <= netcalc.MAX_INPUT) {
        try {
          netcalc.calculate(sel);
          return sel;
        } catch (err) {
          if (!(err instanceof netcalc.NetError)) throw err;
        }
      }
      const inSel = netcalc.findNetworks(sel)[0];
      if (inSel) return inSel.value;
    }
    const ed = els.editor;
    const b = lineBounds(ed.value, ed.selectionStart);
    const found = netcalc.findNetworks(ed.value.slice(b.start, b.end));
    const caretAt = ed.selectionStart - b.start;
    const hit = found.find((f) => caretAt >= f.index && caretAt <= f.index + f.value.length) || found[0];
    return hit ? hit.value : '';
  }

  async function subnetDialog() {
    const editable = isEditable(active());
    const input = h('input', { type: 'text', class: 'net-input', maxlength: netcalc.MAX_INPUT, autocomplete: 'off', placeholder: '192.168.10.0/24 or 2001:db8::/48', 'aria-label': 'Address or network' });
    input.spellcheck = false;
    input.value = networkInEditor();
    const err = h('p', { class: 'form-error', role: 'alert' });
    const rows = h('div', { class: 'result-list compact' });
    const check = h('input', { type: 'text', class: 'net-input', maxlength: 45, autocomplete: 'off', placeholder: 'Is this address in the network?', 'aria-label': 'Address to check' });
    check.spellcheck = false;
    const checkOut = h('span', { class: 'net-check', 'aria-live': 'polite' });
    let state = null;

    const runCheck = () => {
      const a = check.value.trim();
      checkOut.className = 'net-check';
      if (!a || !state) { checkOut.textContent = ''; return; }
      try {
        const inside = netcalc.contains(state, a);
        checkOut.textContent = inside ? `Inside ${state.cidr}` : `Outside ${state.cidr}`;
        checkOut.className = `net-check badge ${inside ? 'good' : 'bad'}`;
      } catch (e) {
        if (!(e instanceof netcalc.NetError)) throw e;
        checkOut.textContent = e.message;
      }
    };

    const update = () => {
      state = null;
      err.textContent = '';
      if (!input.value.trim()) {
        rows.replaceChildren(h('p', { class: 'muted' }, 'Enter an IPv4 or IPv6 address with a prefix length or netmask.'));
        runCheck();
        return;
      }
      let r;
      try {
        r = netcalc.calculate(input.value);
      } catch (e) {
        if (!(e instanceof netcalc.NetError)) throw e;
        err.textContent = e.message;
        rows.replaceChildren();
        runCheck();
        return;
      }
      state = r;
      const list = [['Network (CIDR)', r.cidr]];
      if (r.family === 4) {
        list.push(['Netmask', r.netmask], ['Wildcard mask', r.wildcard], ['Usable host range', `${r.first} - ${r.last}`]);
        if (r.broadcast) list.push(['Broadcast', r.broadcast]);
        const p2p = r.prefix === 31 ? ' (point-to-point link, RFC 3021)' : '';
        list.push(['Hosts', `${Number(r.usable).toLocaleString()} usable of ${Number(r.total).toLocaleString()}${p2p}`]);
      } else {
        list.push(['Prefix mask', r.netmask], ['Address range', `${r.first} - ${r.last}`], ['Addresses', `2^${r.totalPower} = ${BigInt(r.total).toLocaleString()}`], ['Expanded address', r.expanded]);
      }
      list.push(['Address type', r.type]);
      rows.replaceChildren(...list.map(([k, v]) => copyRow(k, v)));
      runCheck();
    };

    input.addEventListener('input', update);
    check.addEventListener('input', runCheck);
    const actions = [{ label: 'Close', value: null }];
    if (editable) actions.push({ label: 'Insert summary', submit: true, className: 'btn-primary' });
    const promise = showDialog({
      title: 'Subnet calculator',
      className: 'wide',
      initialFocus: '.net-input',
      body: [
        input,
        err,
        rows,
        h('div', { class: 'net-check-row' }, check, checkOut),
      ],
      actions,
      onSubmit: () => {
        if (!state) { input.focus(); return undefined; }
        return netcalc.summary(state);
      },
    });
    update();
    const result = await promise;
    if (!result || !isEditable(active())) return;
    const { end } = lineBounds(els.editor.value, els.editor.selectionEnd);
    replaceRange(end, end, `\n${result}`, end + 1 + result.length);
  }

  // -------------------------------------------------------------- settings

  function saveSettings() {
    applySettings();
    schedulePersist();
  }

  function setView(view) {
    S.settings.view = view;
    saveSettings();
    renderPreview();
  }

  function cycleView() {
    const v = store.VIEWS;
    setView(v[(v.indexOf(S.settings.view) + 1) % v.length]);
  }

  function setTheme(theme) {
    if (!store.THEMES.includes(theme)) return; // allow-list: the value comes from the UI
    S.settings.theme = theme;
    saveSettings();
  }

  function toggleCrt() { S.settings.crt = !S.settings.crt; saveSettings(); }

  function toggleSound() {
    S.settings.sound = !S.settings.sound;
    saveSettings();
    if (S.settings.sound) sound.key('key');
    toast(S.settings.sound ? 'Typing sounds on.' : 'Typing sounds off.');
  }

  function toggleBoot() {
    S.settings.boot = !S.settings.boot;
    saveSettings();
    toast(S.settings.boot ? 'The boot screen will show on start.' : 'The boot screen is skipped on start.');
  }

  function cycleAutoLock() {
    const a = store.AUTOLOCK;
    S.settings.autoLockMinutes = a[(a.indexOf(S.settings.autoLockMinutes) + 1) % a.length];
    saveSettings();
    updateStatus();
    toast(`Encrypted notes now lock after ${S.settings.autoLockMinutes} min without activity.`);
  }

  function setDrawer(open) {
    els.app.classList.toggle('sidebar-open', open);
    els.scrim.hidden = !open;
    applySettings();
  }

  function toggleSidebar() {
    if (narrow.matches) { setDrawer(!els.app.classList.contains('sidebar-open')); return; }
    S.settings.sidebar = !S.settings.sidebar;
    saveSettings();
  }

  function toggleZen() {
    const on = els.app.classList.toggle('zen');
    if (on) toast('Zen mode on. Press Alt+Z to leave.');
    if (isEditable(active())) els.editor.focus();
  }

  // ------------------------------------------------------------- dialogs

  let finishCurrentDialog = null;

  function showDialog({ title, body = [], actions, className = '', initialFocus, onSubmit }) {
    return new Promise((resolve) => {
      if (els.palette.open) { S.paletteSel = null; els.palette.close(); }
      if (finishCurrentDialog) finishCurrentDialog(null); // cancel a dialog that is still open
      const dlg = els.modal;
      const back = document.activeElement;
      const editorSel = back === els.editor ? saveEditorSelection() : null;
      dlg.className = `modal ${className}`.trim();
      const form = h('form', { class: 'modal-form', autocomplete: 'off' });
      const actionsEl = h('div', { class: 'modal-actions' });
      let settled = false;
      // Esc, backdrop click or a programmatic close(). Close events are queued,
      // so one that arrives while a newer dialog is open belongs to an older one.
      const onClose = () => {
        if (dlg.open) return;
        finish(null);
      };
      // Clean up synchronously so a dialog opened right after this one is never touched.
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (finishCurrentDialog === finish) finishCurrentDialog = null;
        dlg.removeEventListener('close', onClose);
        if (dlg.open) dlg.close();
        dlg.replaceChildren();
        if (back && document.contains(back) && !back.hidden) back.focus();
        if (back === els.editor) restoreEditorSelection(editorSel);
        resolve(value);
      };
      for (const a of actions) {
        const btn = h('button', { type: a.submit ? 'submit' : 'button', class: a.className || 'btn' }, a.label);
        if (!a.submit) btn.addEventListener('click', () => finish(a.value));
        actionsEl.append(btn);
      }
      form.append(h('div', { class: 'modal-body' }, h('h2', { id: 'modal-title' }, title), body), actionsEl);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!onSubmit) { finish(true); return; }
        const result = await onSubmit(form);
        if (result !== undefined) finish(result);
      });
      dlg.replaceChildren(form);
      dlg.addEventListener('close', onClose);
      finishCurrentDialog = finish;
      dlg.showModal();
      const first = (initialFocus && form.querySelector(initialFocus)) || form.querySelector('input, button[type="submit"]') || form.querySelector('button');
      if (first) first.focus();
    });
  }

  function confirmDialog(title, message, confirmLabel, danger = false) {
    return showDialog({
      title,
      className: danger ? 'danger' : '',
      body: [h('p', null, message)],
      actions: [
        { label: 'Cancel', value: false },
        { label: confirmLabel, submit: true, className: danger ? 'btn-danger' : 'btn-primary' },
      ],
    }).then((v) => v === true);
  }

  async function showHistory() {
    const note = active();
    if (!isEditable(note)) return;
    if (note.cipher) { toast('Version history is off for encrypted notes, so no plaintext copies are kept.'); return; }
    if (!note.history.length) { toast('No earlier versions yet. A version is kept at most once a minute while you write.'); return; }
    const items = [...note.history].reverse();
    let selected = 0;
    const view = h('pre', { class: 'history-view', tabindex: 0 });
    const list = h('ul', { class: 'history-list' });
    const select = (i) => {
      selected = i;
      view.textContent = items[i].body;
      list.querySelectorAll('button').forEach((b, j) => b.setAttribute('aria-current', String(j === i)));
    };
    items.forEach((snap, i) => {
      const st = T.stats(snap.body);
      const b = h('button', { type: 'button' }, new Date(snap.t).toLocaleString(), h('span', { class: 'meta' }, `${st.words} words, ${T.relativeTime(snap.t)}`));
      b.addEventListener('click', () => select(i));
      list.append(h('li', null, b));
    });
    select(0);
    const res = await showDialog({
      title: `Earlier versions of "${titleOf(note)}"`,
      className: 'wide',
      body: [h('div', { class: 'history' }, list, view)],
      actions: [
        { label: 'Close', value: null },
        { label: 'Restore this version', value: 'restore', className: 'btn-primary' },
      ],
    });
    if (res !== 'restore' || active() !== note) return;
    note.history = store.addSnapshot(note.history, note.body, Date.now(), true);
    replaceRange(0, els.editor.value.length, items[selected].body, 0);
    persistNow();
    toast('Version restored. The text it replaced is in the history too.');
  }

  function showAbout() {
    showDialog({
      title: 'About CyberPad',
      body: [
        h('p', null, S.host.version ? `CyberPad ${S.host.version}` : 'CyberPad'),
        h('p', null, `Notes are saved in ${S.host.dataDir || 'the data folder'}`),
      ],
      actions: [{ label: 'Close', value: null, className: 'btn-primary' }],
    });
  }

  function showShortcuts() {
    const rows = [
      ['Ctrl K', 'Command palette'], ['Ctrl K, then @', 'Jump to a heading'], ['Alt N', 'New note'], ['Alt T', 'Today’s log'],
      ['Alt P', 'Pin or unpin note'], ['Ctrl S', 'Save now'], ['Ctrl E', 'Switch Write / Split / Read'], ['Ctrl B', 'Show or hide note list'],
      ['Ctrl F', 'Find'], ['Ctrl H', 'Find and replace'], ['F3 / Shift F3', 'Next / previous match'], ['Alt Z', 'Zen mode'],
      ['Alt L', 'Lock encrypted notes'], ['Alt I', 'Extract IOCs from the note or selection'], ['/', 'Quick inserts (at the start of a word)'], ['Tab after "="', 'Work out the sum on that line'],
      ['Ctrl Enter', 'Make a task, or tick it'], ['Tab / Shift Tab', 'Indent / outdent'], ['Esc, then Tab', 'Move focus out of the editor'],
      ['Paste a URL on a selection', 'Make a link'],
    ];
    showDialog({
      title: 'Keyboard shortcuts',
      body: [h('dl', { class: 'shortcuts' }, rows.map(([k, d]) => [h('dt', null, h('kbd', null, k)), h('dd', null, d)]))],
      actions: [{ label: 'Close', value: null, className: 'btn-primary' }],
    });
  }

  // -------------------------------------------------------- import/export

  /** Sends a file through the platform. Resolves to the saved name, or null when cancelled or failed (failures toast a reason, never content). */
  async function exportOut(kind, suggestedName, text, mime) {
    try {
      const res = await platform.exportFile({ kind, suggestedName, text, mime });
      return res && res.saved ? (res.name || suggestedName) : null;
    } catch (err) {
      const reason = err instanceof PlatformError ? err.reason : null;
      console.error('export failed', reason || (err && err.name));
      toast(reason === 'too-large'
        ? 'That file is over 64 MB, so it could not be exported.'
        : `Export failed (${SAVE_REASON[reason] || 'unexpected error'}).`, 'error');
      return null;
    }
  }

  async function exportNote() {
    const note = active();
    if (!isEditable(note)) return;
    if (note.cipher) {
      const ok = await confirmDialog('Export without encryption?', 'The exported file will contain the note as plain text.', 'Export plain text', true);
      if (!ok) return;
      if (!isEditable(note)) { toast('The note was locked. Unlock it and try again.', 'error'); return; }
    }
    const saved = await exportOut('note', `${T.slugify(titleOf(note))}.md`, bodyOf(note), 'text/markdown;charset=utf-8');
    if (saved) toast(`Saved ${saved}.`);
  }

  async function exportBackup() {
    await flushSeals();
    const saved = await exportOut('backup', `cyberpad-backup-${T.ymd(new Date())}.json`, store.makeBackup(S.notes), 'application/json;charset=utf-8');
    if (saved) toast(`Saved ${saved}. Backup of ${plural(S.notes.length, 'note')} exported. Encrypted notes stay encrypted, the rest is plain text. Use "Export encrypted backup" to protect all of it.`);
  }

  async function exportEncryptedBackup() {
    await flushSeals();
    const fields = newPassphraseFields('bak');
    const err = h('p', { class: 'form-error', role: 'alert' });
    const file = await showDialog({
      title: 'Export encrypted backup',
      initialFocus: '#bak-pass',
      body: [
        h('p', null, `All ${plural(S.notes.length, 'note')} go into one file sealed with AES-256-GCM under this passphrase. Notes that are already encrypted keep their own passphrase inside it. Without this passphrase the backup cannot be restored.`),
        ...fields.nodes,
        err,
      ],
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Export encrypted backup', submit: true, className: 'btn-primary' },
      ],
      onSubmit: async (form) => {
        const problem = fields.problem();
        if (problem) { err.textContent = problem; return undefined; }
        const btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        btn.textContent = 'Encrypting…';
        try {
          const keyInfo = await vault.createKey(fields.pass1.value);
          const text = store.makeEncryptedBackup(await vault.seal(keyInfo, store.makeBackup(S.notes), 'backup'));
          if (text.length > store.LIMITS.backupBytes) {
            err.textContent = 'This backup would be larger than the 50 MB import limit, so it could not be restored. Nothing was exported.';
            return undefined;
          }
          return text;
        } catch (e) {
          if (e instanceof vault.VaultError || e instanceof store.StoreError) err.textContent = e.message;
          else { console.error(e); err.textContent = 'Encryption failed in this browser. Nothing was exported.'; }
          return undefined;
        } finally {
          fields.clear();
          btn.disabled = false;
          btn.textContent = 'Export encrypted backup';
        }
      },
    });
    if (!file) return;
    const saved = await exportOut('encryptedBackup', `cyberpad-backup-${T.ymd(new Date())}.encrypted.json`, file, 'application/json;charset=utf-8');
    if (saved) toast(`Saved ${saved}. Encrypted backup of ${plural(S.notes.length, 'note')}.`);
  }

  /** Asks for an encrypted backup's passphrase. Resolves to the decrypted text, or null. */
  function unlockBackupDialog(name, cipher) {
    const pass = h('input', { type: 'password', autocomplete: 'current-password', maxlength: 1024, id: 'bak-unlock' });
    const err = h('p', { class: 'form-error', role: 'alert' });
    return showDialog({
      title: 'Unlock encrypted backup',
      initialFocus: '#bak-unlock',
      body: [
        h('p', null, `"${name}" is an encrypted CyberPad backup. Enter the passphrase it was exported with.`),
        h('label', { class: 'field' }, h('span', null, 'Backup passphrase'), pass),
        err,
      ],
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Unlock and import', submit: true, className: 'btn-primary' },
      ],
      onSubmit: async (form) => {
        const btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        btn.textContent = 'Unlocking…';
        try {
          const { text } = await vault.unlock(pass.value, cipher, 'backup');
          pass.value = '';
          return text;
        } catch (e) {
          if (e instanceof vault.VaultError) err.textContent = e.message;
          else { console.error(e); err.textContent = 'Unlocking failed in this browser.'; }
          pass.select();
          return undefined;
        } finally {
          btn.disabled = false;
          btn.textContent = 'Unlock and import';
        }
      },
    });
  }

  /** Returns the envelope of an encrypted backup, or null if the text is not one. */
  function encryptedBackupIn(text) {
    try {
      return store.parseEncryptedBackup(text);
    } catch (err) {
      if (err instanceof store.StoreError && err.message === 'not-encrypted-backup') return null;
      throw err; // damaged encrypted backups are reported, never imported as text
    }
  }

  async function importFiles(files) {
    let lastId = null;
    let count = 0;
    for (const file of files.slice(0, 20)) {
      try {
        const ext = store.checkImportFile(file.name, file.size);
        let text = store.decodeImportBytes(await file.arrayBuffer());
        if (ext === 'json') {
          const mergeIn = (incoming) => {
            const merged = store.mergeNotes(S.notes, incoming);
            S.notes = merged.notes;
            count += merged.added;
            if (merged.added) lastId = S.notes[S.notes.length - 1].id;
            toast(`Imported ${merged.added} note${merged.added === 1 ? '' : 's'} from ${file.name}${merged.skipped ? `; ${merged.skipped} skipped because the note limit was reached` : ''}.`);
          };
          const cipher = encryptedBackupIn(text);
          if (cipher) {
            const plain = await unlockBackupDialog(file.name, cipher);
            if (plain === null) continue; // cancelled
            let incoming;
            try {
              incoming = store.parseBackup(plain);
            } catch (err) {
              if (!(err instanceof store.StoreError)) throw err;
              throw new store.StoreError('The backup decrypted, but its contents are not a valid CyberPad backup.');
            }
            mergeIn(incoming);
            continue;
          }
          try {
            mergeIn(store.parseBackup(text));
            continue;
          } catch (err) {
            if (!(err instanceof store.StoreError)) throw err;
            text = `\`\`\`json\n${text}\n\`\`\``; // ordinary JSON file: keep it as a code block
          }
        }
        if (text.length > store.LIMITS.body) throw new store.StoreError('That file is too long for one note.');
        if (S.notes.length >= store.LIMITS.notes) throw new store.StoreError('The note limit has been reached.');
        const n = store.createNote(text);
        S.notes.push(n);
        lastId = n.id;
        count++;
      } catch (err) {
        if (!(err instanceof store.StoreError)) throw err;
        toast(`${file.name}: ${err.message}`, 'error');
      }
    }
    if (!count) return;
    persistNow();
    S.meta.clear();
    renderAll();
    if (lastId) openNote(lastId);
    if (files.length === 1 && !files[0].name.toLowerCase().endsWith('.json')) toast(`Imported ${files[0].name}.`);
  }

  // ---------------------------------------------------------------- timer

  function startTimer(minutes, label) {
    stopTimer(true);
    S.timer = { end: Date.now() + minutes * 60000, label, id: setInterval(tickTimer, 1000) };
    tickTimer();
    toast(`${label} timer started: ${minutes} minutes.`);
  }

  function tickTimer() {
    if (!S.timer) return;
    const left = S.timer.end - Date.now();
    if (left <= 0) {
      const { label } = S.timer;
      stopTimer(true);
      sound.chime();
      toast(label === 'Focus' ? 'Focus session done. Take a short break.' : 'Break is over.');
      return;
    }
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    els.stTimer.textContent = `${S.timer.label} ${m}:${String(s).padStart(2, '0')}`;
    els.stTimer.hidden = false;
  }

  function stopTimer(silent) {
    if (S.timer) clearInterval(S.timer.id);
    const had = !!S.timer;
    S.timer = null;
    els.stTimer.hidden = true;
    if (!silent && had) toast('Timer stopped.');
  }

  // ---------------------------------------------------------------- toast

  function toast(message, kind = 'info') {
    const t = h('div', { class: kind === 'error' ? 'toast error' : 'toast' }, message);
    els.toasts.append(t);
    while (els.toasts.children.length > 4) els.toasts.firstElementChild.remove();
    setTimeout(() => t.remove(), kind === 'error' ? 7000 : 3500);
  }

  function copyText(text) {
    if (!navigator.clipboard) { toast('Copying is not available here. Select the text and press Ctrl+C.', 'error'); return; }
    navigator.clipboard.writeText(text).then(
      () => { if (!noteSensitiveCopy()) toast('Copied to the clipboard.'); },
      (err) => { console.error(err); toast('Copy failed. Select the text and press Ctrl+C.', 'error'); },
    );
  }

  // Text copied while an unlocked encrypted note is open is cleared from the
  // clipboard after CLIP_CLEAR_MS. Browsers only allow clipboard writes while the
  // page has focus, so a clear that comes due in the background runs on return.
  // The clipboard is never read: it is overwritten even if something else was
  // copied since, which is the documented trade-off.
  const CLIP_CLEAR_MS = 30000;
  const clip = { pending: false, timer: 0 };

  /** Call after any copy. Returns true when a clear was scheduled (and announced). */
  function noteSensitiveCopy() {
    const note = active();
    if (!S.settings.clearClipboard || !note || !note.cipher || isLocked(note)) return false;
    const first = !clip.pending;
    clip.pending = true;
    clearTimeout(clip.timer);
    clip.timer = setTimeout(() => { clip.timer = 0; clearClipboardNow(); }, CLIP_CLEAR_MS);
    if (first) toast(`Copied from an encrypted note. The clipboard is cleared in ${CLIP_CLEAR_MS / 1000} seconds.`);
    return true;
  }

  async function clearClipboardNow() {
    if (!clip.pending || !navigator.clipboard || !document.hasFocus()) return; // retried on focus
    clearTimeout(clip.timer);
    clip.timer = 0;
    try {
      await navigator.clipboard.writeText('');
      clip.pending = false;
      toast('Clipboard cleared. It held text from an encrypted note.');
    } catch (err) {
      // NotAllowedError means the page lost focus mid-call; the focus handler retries.
      if (!(err && err.name === 'NotAllowedError')) { console.error(err); toast('The clipboard could not be cleared. Copy something else over it.', 'error'); }
    }
  }

  function toggleClearClipboard() {
    S.settings.clearClipboard = !S.settings.clearClipboard;
    if (!S.settings.clearClipboard) { clip.pending = false; clearTimeout(clip.timer); clip.timer = 0; }
    saveSettings();
    toast(S.settings.clearClipboard
      ? 'Text copied from encrypted notes is now cleared from the clipboard after 30 seconds.'
      : 'The clipboard is no longer cleared after copying from encrypted notes.');
  }

  function toggleLockOnHide() {
    S.settings.lockOnHide = !S.settings.lockOnHide;
    saveSettings();
    toast(S.settings.lockOnHide
      ? 'Encrypted notes now lock when you switch away from this tab.'
      : 'Encrypted notes no longer lock when the tab is hidden. They still lock after the idle time.');
  }

  // ----------------------------------------------------------------- boot

  function bootSequence() {
    return new Promise((resolve) => {
      if (!S.settings.boot || reducedMotion.matches) { resolve(); return; }
      const kb = Math.max(1, Math.round((S.lastStateChars * 2) / 1024));
      const encrypted = S.notes.filter((n) => n.cipher).length;
      const tagCount = new Set(S.notes.flatMap((n) => metaOf(n).tags)).size;
      const lines = [
        [['CYBERPAD', 'hot'], ['  local notes terminal']],
        [['reading storage ......... '], ['ok', 'ok'], [`  ${S.notes.length} notes, ${kb} KB`]],
        [['cipher module ........... '], ['ok', 'ok'], [`  AES-256-GCM, ${encrypted} sealed`]],
        [['indexing tags ........... '], ['ok', 'ok'], [`  ${tagCount} tags`]],
        [['screen .................. '], ['ok', 'ok'], [`  ${THEME_NAMES[S.settings.theme].toLowerCase()} display`]],
        [['ready ']],
      ];
      els.bootLog.replaceChildren();
      els.boot.hidden = false;
      let i = 0;
      let done = false;
      let timer = 0;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        window.removeEventListener('keydown', finish, true);
        window.removeEventListener('pointerdown', finish, true);
        els.boot.classList.add('fade');
        setTimeout(() => {
          els.boot.hidden = true;
          els.boot.classList.remove('fade');
          els.wordmark.classList.add('glitch');
          setTimeout(() => els.wordmark.classList.remove('glitch'), 500);
          resolve();
        }, 260);
      };
      const step = () => {
        if (done) return;
        if (i < lines.length) {
          const row = h('div', null, lines[i].map(([t, cls]) => (cls ? h('span', { class: cls }, t) : t)));
          if (i === lines.length - 1) row.append(h('span', { class: 'cursor-block' }));
          els.bootLog.append(row);
          i++;
          timer = setTimeout(step, i === lines.length ? 420 : 130);
        } else {
          finish();
        }
      };
      window.addEventListener('keydown', finish, true);
      window.addEventListener('pointerdown', finish, true);
      step();
    });
  }

  // --------------------------------------------------------------- events

  function onGlobalKeydown(e) {
    S.lastActive = Date.now();
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (els.modal.open) return;

    if (mod && !e.altKey && (k === 'k' || (e.shiftKey && k === 'p'))) {
      e.preventDefault();
      if (els.palette.open) closePalette(); else openPalette();
      return;
    }
    if (els.palette.open) return;

    if (mod && !e.altKey && k === 's') {
      e.preventDefault();
      flushSeals().then(() => persistNow()).then((ok) => { if (ok) toast('Saved.'); });
      return;
    }
    if (mod && !e.altKey && !e.shiftKey && k === 'e') { e.preventDefault(); cycleView(); return; }
    if (mod && !e.altKey && !e.shiftKey && k === 'b') { e.preventDefault(); toggleSidebar(); return; }
    if (mod && !e.altKey && !e.shiftKey && k === 'f') { e.preventDefault(); openFind(); return; }
    if (mod && !e.altKey && !e.shiftKey && k === 'h') { e.preventDefault(); openFind(true); return; }
    if (e.key === 'F3' || (mod && !e.altKey && k === 'g')) { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); return; }
    if (e.key === 'F1') { e.preventDefault(); showShortcuts(); return; }

    if (e.altKey && !mod && !e.shiftKey) {
      const actions = { KeyN: newNote, KeyT: openDaily, KeyP: togglePin, KeyL: () => lockAll(), KeyZ: toggleZen, KeyI: showIocs };
      const fn = actions[e.code];
      if (fn) { e.preventDefault(); fn(); }
    }
  }

  function wireEvents() {
    const ed = els.editor;
    ed.addEventListener('input', onEditorInput);
    ed.addEventListener('keydown', onEditorKeydown);
    ed.addEventListener('paste', onEditorPaste);
    ['keyup', 'mouseup', 'select', 'focus'].forEach((t) => ed.addEventListener(t, scheduleStatus));
    ed.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== ed) closeSlash(); }, 120));
    ed.addEventListener('mousedown', closeSlash);
    ed.addEventListener('scroll', () => {
      if (S.slash.open) renderSlash();
      if (S.settings.view !== 'split') return;
      const max = ed.scrollHeight - ed.clientHeight;
      const pmax = els.previewPane.scrollHeight - els.previewPane.clientHeight;
      if (max > 0 && pmax > 0) els.previewPane.scrollTop = (ed.scrollTop / max) * pmax;
    }, { passive: true });

    els.slash.addEventListener('mousedown', (e) => {
      const item = e.target.closest('.slash-item');
      if (!item) return;
      e.preventDefault();
      acceptSlash(Number(item.dataset.idx));
    });

    els.preview.addEventListener('click', (e) => {
      const box = e.target.closest('input[type="checkbox"][data-line]');
      if (box) { toggleTaskLine(Number(box.dataset.line)); return; }
      const wiki = e.target.closest('a[data-wiki]');
      if (wiki) { e.preventDefault(); openOrCreateByTitle(wiki.dataset.wiki); return; }
      const tag = e.target.closest('a[data-tag]');
      if (tag) { e.preventDefault(); setTag(tag.dataset.tag); return; }
      const copy = e.target.closest('button[data-copy]');
      if (copy) { copyText(copy.parentElement.querySelector('code').textContent); return; }
      const sev = e.target.closest('button[data-cvss]');
      if (sev) cvssDialog(sev.dataset.cvss);
    });

    els.backlinks.addEventListener('click', (e) => {
      const b = e.target.closest('[data-open]');
      if (b) openNote(b.dataset.open);
    });

    els.noteList.addEventListener('click', (e) => {
      const b = e.target.closest('.note-item');
      if (b) openNote(b.dataset.id);
    });

    els.tagList.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tag]');
      if (b) setTag(b.dataset.tag);
    });
    els.btnClearFilter.addEventListener('click', () => setTag(S.tag));

    els.search.addEventListener('input', () => { S.query = els.search.value.slice(0, 200); renderList(); });
    els.search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = visibleNotes()[0];
        if (first) openNote(first.id);
      } else if (e.key === 'Escape') {
        els.search.value = '';
        S.query = '';
        renderList();
      }
    });

    els.btnNew.addEventListener('click', newNote);
    els.btnSidebar.addEventListener('click', toggleSidebar);
    els.scrim.addEventListener('click', () => setDrawer(false));
    els.themeSelect.addEventListener('change', () => setTheme(els.themeSelect.value));
    els.btnCrt.addEventListener('click', toggleCrt);
    els.btnSound.addEventListener('click', toggleSound);
    els.btnPalette.addEventListener('click', () => openPalette());
    document.querySelectorAll('.segmented [data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

    els.unlockForm.addEventListener('submit', onUnlockSubmit);

    // find bar
    els.findInput.addEventListener('input', computeMatches);
    els.findInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1, els.findInput); }
      if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
    });
    els.replaceInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); if (mod(e)) replaceAll(); else replaceOne(); }
      if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
    });
    const flip = (btn, key) => btn.addEventListener('click', () => {
      S.find[key] = !S.find[key];
      btn.setAttribute('aria-pressed', String(S.find[key]));
      computeMatches();
    });
    flip(els.findCase, 'case');
    flip(els.findRegex, 'regex');
    $('find-next').addEventListener('click', () => findStep(1));
    $('find-prev').addEventListener('click', () => findStep(-1));
    $('find-replace').addEventListener('click', replaceOne);
    $('find-replace-all').addEventListener('click', replaceAll);
    $('find-close').addEventListener('click', closeFind);

    // palette
    els.paletteInput.addEventListener('input', () => { S.pal.idx = 0; renderPalette(); });
    els.paletteInput.addEventListener('keydown', (e) => {
      const n = S.pal.items.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (n) { S.pal.idx = (S.pal.idx + (e.key === 'ArrowDown' ? 1 : -1) + n) % n; renderPalette(); }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        runPaletteItem(S.pal.idx);
      }
    });
    els.paletteList.addEventListener('click', (e) => {
      const item = e.target.closest('.palette-item');
      if (item) runPaletteItem(Number(item.dataset.idx));
    });
    els.palette.addEventListener('click', (e) => { if (e.target === els.palette) closePalette(); });
    els.palette.addEventListener('cancel', (e) => { e.preventDefault(); closePalette(); });
    // Fallback for any close path that skipped closePalette(): restore only if the
    // selection is still pending, so a late event never steals focus or moves the caret.
    els.palette.addEventListener('close', () => {
      const sel = S.paletteSel;
      S.paletteSel = null;
      if (sel && !els.palette.open && !els.modal.open && isEditable(active())) {
        els.editor.focus();
        restoreEditorSelection(sel);
      }
    });
    els.modal.addEventListener('click', (e) => { if (e.target === els.modal) els.modal.close(); });

    // import
    els.hashFileInput.addEventListener('change', () => {
      const file = els.hashFileInput.files[0];
      els.hashFileInput.value = '';
      hashFile(file);
    });
    $('secret-encrypt').addEventListener('click', encryptActive);
    $('secret-mask').addEventListener('click', maskSecretsActive);
    $('secret-review').addEventListener('click', showSecretFindings);
    $('secret-ignore').addEventListener('click', ignoreSecrets);

    els.fileInput.addEventListener('change', () => {
      const files = [...els.fileInput.files];
      els.fileInput.value = '';
      importFiles(files);
    });
    let dragDepth = 0;
    const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { e.preventDefault(); dragDepth++; els.dropzone.hidden = false; } });
    window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; els.dropzone.hidden = true; } });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      els.dropzone.hidden = true;
      importFiles([...e.dataTransfer.files]);
    });

    document.addEventListener('keydown', onGlobalKeydown);
    document.addEventListener('pointerdown', () => { S.lastActive = Date.now(); }, { passive: true });

    // The desktop host asks for a flush before closing instead.
    if (!platform.isDesktop) {
      window.addEventListener('beforeunload', (e) => {
        if (S.saveTimer) persistNow();
        if (S.sealTimers.size || S.sealing.size) {
          for (const id of [...S.sealTimers.keys()]) sealNow(id);
          e.preventDefault();
          e.returnValue = '';
        }
      });
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        if (S.saveTimer) persistNow();
        for (const id of [...S.sealTimers.keys()]) sealNow(id);
        if (S.settings.lockOnHide && S.keys.size) lockAll('Encrypted notes were locked because the tab was hidden.');
      }
    });
    document.addEventListener('copy', noteSensitiveCopy);
    document.addEventListener('cut', noteSensitiveCopy);
    window.addEventListener('focus', () => { if (clip.pending && !clip.timer) clearClipboardNow(); });
    if (!platform.isDesktop) {
      window.addEventListener('storage', (e) => {
        if (e.key === store.STORAGE_KEY) toast('Your notes were changed in another tab. Reload this page before editing here, or one tab will overwrite the other.', 'error');
      });
    }
    narrow.addEventListener('change', () => setDrawer(false));
  }

  const mod = (e) => e.ctrlKey || e.metaKey;

  // ----------------------------------------------------------------- init

  async function init() {
    const { firstRun } = await load();
    if (platform.isDesktop) {
      platform.onFlushRequest(async () => { await flushSeals(); await persistNow(); });
    }
    wireEvents();
    renderAll();
    setSaveState('saved');
    if (firstRun) persistNow();
    setInterval(() => {
      els.stClock.textContent = T.hm(new Date());
      const limit = S.settings.autoLockMinutes * 60000;
      if (S.keys.size && Date.now() - S.lastActive > limit) {
        lockAll(`Encrypted notes locked after ${S.settings.autoLockMinutes} min without activity.`);
      }
    }, 15000);
    await bootSequence();
    const note = active();
    if (isEditable(note)) els.editor.focus();
    else els.unlockPass.focus();
  }

  init();
})();
