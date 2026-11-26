/* CyberPad application controller. */
(function () {
  'use strict';

  const { calc, markdown, text: T, codeedit, vault, store, secops, cvss, netcalc, dom, caret, sound, renderMarkdown } = window.NP;
  const { h } = dom;
  const highlight = window.NP.highlight;
  const ctf = window.NP.ctf;
  const { PlatformError } = window.NP.platformFactory;
  const platform = window.NP.platformFactory.createPlatform(window);
  const $ = (id) => document.getElementById(id);

  const els = {
    app: $('app'), sidebar: $('sidebar'), scrim: $('scrim'), workspace: $('workspace'),
    editor: $('editor'), editorPane: document.querySelector('.pane-editor'), preview: $('preview'), previewPane: document.querySelector('.pane-preview'), backlinks: $('backlinks'),
    lockscreen: $('lockscreen'), unlockForm: $('unlock-form'), unlockPass: $('unlock-pass'), unlockError: $('unlock-error'), unlockBtn: $('unlock-btn'),
    search: $('search'), noteList: $('note-list'), tagList: $('tag-list'), filterRow: $('filter-row'), filterLabel: $('filter-label'),
    btnClearFilter: $('btn-clear-filter'), btnNew: $('btn-new'), btnSidebar: $('btn-sidebar'), themeSelect: $('theme-select'),
    btnCrt: $('btn-crt'), btnSound: $('btn-sound'), btnPalette: $('btn-palette'),
    findbar: $('findbar'), findInput: $('find-input'), replaceInput: $('replace-input'), findCase: $('find-case'),
    findRegex: $('find-regex'), findCount: $('find-count'),
    stSave: $('st-save'), stSaveText: $('st-save-text'), stPos: $('st-pos'), stWords: $('st-words'), stLang: $('st-lang'), stSel: $('st-sel'),
    stLock: $('st-lock'), stTimer: $('st-timer'), stClock: $('st-clock'),
    slash: $('slash'), seltools: $('seltools'), statusbar: $('statusbar'), palette: $('palette'), paletteInput: $('palette-input'), paletteList: $('palette-list'),
    paletteSections: $('palette-sections'), paletteStatus: $('palette-status'), paletteFoot: $('palette-foot'),
    modal: $('modal'), toasts: $('toasts'), boot: $('boot'), bootLog: $('boot-log'), dropzone: $('dropzone'),
    fileInput: $('file-input'), hashFileInput: $('hash-file-input'), wordmark: document.querySelector('.wordmark-text'),
    secretAlert: $('secret-alert'), secretAlertText: $('secret-alert-text'),
    gutter: $('gutter'), gutterMirror: $('gutter-mirror'), hl: $('hl'),
  };

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const narrow = window.matchMedia('(max-width: 760px)');
  // Absent in some environments: System then behaves as Light.
  const darkScheme = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  const THEME_NAMES = { system: 'System', light: 'Light', dark: 'Dark', neon: 'Neon', amber: 'Amber', terminal: 'Terminal green' };

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

  const MIGRATION_LINE = 'Moving from the browser version? Export a backup there (Command palette → Export backup of all notes), then import it here.';
  const welcomeText = () => (platform.isDesktop
    ? WELCOME
      .replace('A notepad that lives in this browser.', 'A notepad that lives on this computer.')
      .replace(/\n#welcome$/, `\n${MIGRATION_LINE}\n\n#welcome`)
    : WELCOME);
  const where = () => (platform.isDesktop ? 'on this computer' : 'in this browser');

  const S = {
    notes: [],
    settings: store.validateSettings(null), // fresh defaults, with their own collapsedFolders array
    activeId: null,
    hostTheme: null,
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
    changeSeq: 0,           // bumped on every change that needs saving
    savedSeq: 0,            // changeSeq covered by the last successful save
    sealFailed: new Set(),  // note ids whose latest edits could not be encrypted, so they are not in any save
    lastStateChars: 0,
    legacyKey: null,
    host: { version: null, dataDir: null },
    storageOk: true,
    timer: null,
    lastActive: Date.now(),
    unlockFails: 0,
    unlockBlockedUntil: 0,
    unlockBusy: false,
    pendingDelete: null,    // the latest deleted note, kept for undo: { note, index, link, blankId, timer, toastEl }
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
  /** The last arrow typed, so one Backspace can give back the characters that made it. */
  let arrowMemo = null;

  /** A script note is one with a language; its text is code, never Markdown. */
  const isScript = (n) => !!(n && n.lang);
  const langName = (n) => { const l = isScript(n) ? codeedit.language(n.lang) : null; return l ? l.name : ''; };

  /** The title of a script note: its first non-empty line as written, capped like other titles. */
  function scriptTitle(body) {
    for (const raw of body.split('\n', 50)) {
      const t = raw.trim();
      if (t) return t.length > 80 ? `${t.slice(0, 79)}…` : t;
    }
    return 'Untitled';
  }

  function metaOf(n) {
    const body = bodyOf(n);
    const cached = S.meta.get(n.id);
    if (cached && cached.body === body && cached.script === isScript(n)) return cached;
    let m;
    if (body == null) m = { body, title: 'Encrypted note', tags: [], links: [] };
    else if (isScript(n)) m = { body, title: scriptTitle(body), tags: [], links: [] };
    else m = { body, title: T.deriveTitle(body), tags: T.extractTags(body), links: T.extractWikiLinks(body).map((l) => l.toLowerCase()) };
    m.script = isScript(n);
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
    } else if (err instanceof PlatformError && err.userFacing) {
      // The host's reason is a short, safe sentence (never note content), shown as text.
      setSaveState('error', 'Save failed');
      toast(`Not saved: ${err.message} Export a backup from the command palette to keep your notes safe.`, 'error');
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
    const seq = S.changeSeq;
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
    S.savedSeq = seq;
    syncLinkedFiles();
    if (S.legacyKey) {
      // The data now lives under the new key, so the old copy can go.
      platform.removeLegacy(S.legacyKey);
      S.legacyKey = null;
    }
    if (!pendingWrites() && !S.saveDirty) setSaveState('saved');
    return true;
  }

  /** Records a change that needs saving; it stays unsaved until a save that started after it succeeds. */
  function markChanged() {
    S.changeSeq += 1;
  }

  /** True while a change has not reached a successful save, or is still waiting to be encrypted or saved. */
  function hasUnsavedChanges() {
    return S.changeSeq !== S.savedSeq || pendingWrites() || [...S.sealFailed].some((id) => noteById(id));
  }

  /** The state changed: save it now. */
  function persistNow() {
    markChanged();
    return saveNow();
  }

  /**
   * Saves now without recording a change. At most one save is in flight: a
   * call during a save marks the state dirty and the running loop saves once
   * more. The promise resolves after that last save, with whether it succeeded.
   */
  function saveNow() {
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
    markChanged();
    setSaveState('writing');
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(saveNow, 400);
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
    let resave = false;
    if (unreadable && S.storageOk) {
      // The browser keeps the raw string; the desktop host renames whichever files exist.
      const canKeep = platform.isDesktop || typeof loaded.main === 'string';
      let kept = false;
      if (canKeep) {
        try { await platform.quarantine(loaded.main); kept = true; } catch (err) {
          console.error('quarantine failed', err instanceof PlatformError ? err.reason : (err && err.name));
        }
        // The notes in memory are valid whether or not the files were set aside: write them back as notes.json.
        resave = platform.isDesktop && source !== 'none';
      }
      // The unreadable legacy copy could not be kept, so it is the only raw copy: the first save must not remove it.
      if (!kept) S.legacyKey = null;
      const place = platform.isDesktop ? 'in the data folder' : 'in browser storage';
      setTimeout(() => toast(kept
        ? (source === 'main'
          ? `The backup copy could not be read. It was kept ${place}.`
          : `Saved notes could not be read. The unreadable copy was kept ${place}.`)
        : 'Saved notes could not be read, and the unreadable copy could not be kept.', 'error'), 0);
    }
    S.notes = state.notes;
    S.settings = state.settings;
    S.activeId = state.activeId;
    const firstRun = (S.notes.length === 0 && !unreadable) || !!S.legacyKey;
    if (!S.notes.length) S.notes.push(store.createNote(welcomeText()));
    if (!active()) S.activeId = sortedNotes()[0].id;
    if (!loaded.storageOk) setTimeout(() => toast('This browser is blocking storage, so notes will be lost when you close the tab.', 'error'), 0);
    return { firstRun, resave, source };
  }

  // ------------------------------------------------------------ encryption

  function queueSeal(note) {
    markChanged();
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
      S.sealFailed.delete(id);
      persistNow();
    }).catch((err) => {
      S.sealFailed.add(id);
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
    // A dialog that lists text from encrypted notes (flags found in all notes) is marked sensitive and closes on any lock.
    if (finishCurrentDialog && (dialogSensitive || (n && n.cipher))) finishCurrentDialog(null);
    if (els.palette.open) closePalette();
    S.keys.clear();
    S.plain.clear();
    S.meta.clear();
    closeSlash();
    hideSeltools();
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

  /**
   * The passphrase dialog shared by Encrypt note and the credentials note. It
   * derives a key, runs `prepare()` (return false to stop and seal nothing),
   * then seals `plain()` and hands the result to `commit(keyInfo, cipher, plain)`
   * inside the same step. Resolves with the dialog result (true after a seal).
   * Nothing is stored here; the caller decides what to do with the result.
   */
  async function sealWithNewPassphrase({ title, intro, submitLabel, failureText, idPrefix, plain, prepare, commit, onError }) {
    const fields = newPassphraseFields(idPrefix);
    const { pass1, pass2 } = fields;
    const err = h('p', { class: 'form-error', role: 'alert' });
    return showDialog({
      title,
      initialFocus: `#${idPrefix}-pass`,
      body: [
        h('p', null, intro),
        ...fields.nodes,
        err,
      ],
      actions: [
        { label: 'Cancel', value: null },
        { label: submitLabel, submit: true, className: 'btn-primary' },
      ],
      onSubmit: async (form) => {
        const problem = fields.problem();
        if (problem) { err.textContent = problem; return undefined; }
        const btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        btn.textContent = 'Encrypting…';
        try {
          const keyInfo = await vault.createKey(pass1.value);
          if (prepare && (await prepare()) === false) return null;
          const text = plain();
          const cipher = await vault.seal(keyInfo, text);
          commit(keyInfo, cipher, text);
          return true;
        } catch (e) {
          if (e instanceof vault.VaultError) err.textContent = e.message;
          else { console.error(e); err.textContent = failureText; }
          if (onError) onError();
          btn.disabled = false;
          btn.textContent = submitLabel;
          return undefined;
        } finally {
          pass1.value = '';
          pass2.value = '';
        }
      },
    });
  }

  async function encryptActive() {
    const note = active();
    if (!isEditable(note)) return;
    if (note.cipher) { toast('This note is already encrypted.'); return; }

    let plainFile = null; // the text file this note was linked to, unlinked before any ciphertext exists
    let unlinkFailed = false;

    const ok = await sealWithNewPassphrase({
      title: 'Encrypt this note',
      intro: 'Only an encrypted copy will be saved, and its version history is deleted. If you forget the passphrase, nobody can recover the note.',
      submitLabel: 'Encrypt note',
      failureText: 'Encryption failed in this browser. The note was not changed.',
      idPrefix: 'enc',
      plain: () => note.body,
      prepare: async () => {
        if (!(platform.isDesktop && note.file)) return true;
        // A .txt/.md link must be gone before the first ciphertext exists; if it can't be removed, seal nothing.
        const link = note.file;
        try {
          await platform.unlinkFile(link.linkId);
        } catch (e) {
          // A link the host does not know is already gone there: that counts as unlinked.
          if (!FL.isUnknownLink(e)) {
            console.error('unlink failed', errName(e));
            unlinkFailed = true;
            return false;
          }
        }
        dropLink(note);
        plainFile = link;
        return true;
      },
      commit: (keyInfo, cipher, plain) => {
        note.cipher = cipher;
        note.body = '';
        note.history = [];
        S.keys.set(note.id, keyInfo);
        S.plain.set(note.id, plain);
      },
      onError: () => {
        if (plainFile) { persistNow(); renderList(); updateStatus(); } // the link is already gone: keep that on disk
      },
    });
    if (unlinkFailed) {
      toast('The link to the file could not be removed, so the note was not encrypted. Try again, or unlink it first.', 'error');
      return;
    }
    if (ok) {
      persistNow();
      renderAll();
      if (plainFile) noticePlainFileLeft(note, plainFile);
      else toast('Note encrypted. Only the encrypted copy is saved.');
    }
  }

  /**
   * A new encrypted note holding the credentials template. The body lives only
   * in a local variable until it is sealed; the note record is created after
   * the seal, with the cipher set and an empty stored body. Cancel or failure
   * adds and saves nothing.
   */
  async function newCredentialsNote() {
    if (S.notes.length >= store.LIMITS.notes) {
      toast(`You have reached ${store.LIMITS.notes} notes. Delete some to make room.`, 'error');
      return;
    }
    let sealed = null;
    const ok = await sealWithNewPassphrase({
      title: 'New encrypted credentials note',
      intro: 'This creates a new note that is encrypted before it is saved. A forgotten passphrase cannot be recovered.',
      submitLabel: 'Create note',
      failureText: 'The note was not created.',
      idPrefix: 'cred',
      plain: () => T.credentialsTemplate(new Date()),
      commit: (keyInfo, cipher, plain) => { sealed = { keyInfo, cipher, plain }; },
    });
    if (!ok || !sealed) return;
    if (S.notes.length >= store.LIMITS.notes) { // the list may have grown while the dialog was open
      toast(`You have reached ${store.LIMITS.notes} notes. Delete some to make room.`, 'error');
      return;
    }
    const current = active();
    const n = store.createNote('');
    n.cipher = sealed.cipher;
    n.folder = store.cleanFolder(current ? current.folder : '');
    S.notes.push(n);
    S.keys.set(n.id, sealed.keyInfo);
    S.plain.set(n.id, sealed.plain);
    S.query = '';
    S.tag = null; // the new note has no tag, so a tag filter would hide it
    els.search.value = '';
    openNote(n.id);
    renderTags();
    persistNow();
    renderAll();
    toast('Credentials note created. Only the encrypted copy is saved.');
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
    // Drop a .cpnote link in the same step, so plain text can never be written into it.
    const cpFile = platform.isDesktop && note.file ? note.file : null;
    if (cpFile) dropLink(note);
    persistNow();
    renderAll();
    if (!cpFile) { toast('Encryption removed.'); return; }
    forgetHostLink(cpFile.linkId); // best effort: a failure is left for the next prune
    toast(`Encryption removed. ${cpFile.name} keeps the last encrypted copy and is no longer linked to this note.`, 'info',
      [{ label: 'Save as file…', fn: () => saveAsFileFor(note) }]);
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

  // Desktop: the Windows title bar follows the theme. Sent once per change, not on every settings save.
  // A failure is not shown: the bar keeps its previous colour, and forgetting the sent value retries next time.
  // The theme on screen: the setting, or for System the operating system's current choice.
  function screenTheme() { return store.resolveTheme(S.settings.theme, !!(darkScheme && darkScheme.matches)); }

  function syncHostTheme() {
    const theme = screenTheme();
    if (!platform.isDesktop || S.hostTheme === theme) return;
    S.hostTheme = theme;
    platform.setHostTheme(theme).catch((err) => {
      console.error('theme sync failed', err instanceof PlatformError ? err.reason : (err && err.name));
      if (S.hostTheme === theme) S.hostTheme = null;
    });
  }

  // The theme SETTING (one of the six names, nothing else) is kept as a start-up hint for js/early-theme.js.
  let storedThemeHint = null;
  function rememberTheme(setting) {
    if (storedThemeHint === setting) return;
    storedThemeHint = setting;
    try {
      localStorage.setItem('cyberpad.theme', setting);
    } catch (e) {
      // Storage may be unavailable (blocked, full); the value is only a start-up hint, so it is dropped silently.
    }
  }

  function applySettings() {
    const s = S.settings;
    document.documentElement.dataset.theme = screenTheme();
    rememberTheme(s.theme);
    document.body.classList.toggle('crt', s.crt);
    els.app.classList.toggle('no-sidebar', !s.sidebar);
    els.workspace.dataset.view = s.view;
    document.querySelectorAll('.segmented [data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === s.view)));
    els.themeSelect.value = s.theme;
    els.btnCrt.setAttribute('aria-pressed', String(s.crt));
    els.btnSound.setAttribute('aria-pressed', String(s.sound));
    els.btnSidebar.setAttribute('aria-expanded', String(narrow.matches ? els.app.classList.contains('sidebar-open') : s.sidebar));
    syncHostTheme();
  }

  const EDITOR_PLACEHOLDER = els.editor.placeholder;

  function renderEditor() {
    hideSeltools();
    const note = active();
    const locked = !note || isLocked(note);
    els.lockscreen.hidden = !locked;
    els.editor.hidden = locked;
    if (locked) {
      clearHl(); // before anything else: a locked note's text must not stay in the layer
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
    els.editorPane.classList.toggle('is-script', isScript(note));
    els.editor.placeholder = isScript(note) ? 'Start typing.' : EDITOR_PLACEHOLDER;
    document.title = note ? `${titleOf(note)} | CyberPad` : 'CyberPad';
    g.hold = false;
    updateGutter();
    updateHl();
  }

  // ------------------------------------------------------ line-number gutter
  //
  // The gutter is a static element beside the textarea. Script notes never wrap, so row k is line k and the visible
  // rows follow from scrollTop, line height and top padding. Wrapped notes (setting "every note") need to know where
  // each line starts: an off-screen mirror with the editor's content width holds one block per line, and the block
  // tops are read from it. The mirror holds note text, so it is emptied (clearMirror) whenever the note locks or
  // changes, the gutter turns off or hides, the editor is not on screen, and before printing. It is bounded by the
  // 3,000-line cap, reuses its per-line blocks (only changed lines are rewritten) and is remeasured at most ~5 times a second.
  const GUTTER_OVERSCAN = 6;
  const GUTTER_WRAP_MAX = 3000;
  const GUTTER_WRAP_CHARS = 200000; // a wrapped note longer than this is not measured either
  const GUTTER_MEASURE_GAP = 200; // ms between two measurements while typing
  const g = { on: false, wrapped: false, tooLong: '', hold: false, noteId: null, lines: 1, digits: 0, caret: 1, tops: null, key: '', raf: 0, timer: 0, last: 0, blocks: [], text: [], pool: [], rowN: [] };

  function countLines(v) {
    let n = 1;
    for (let i = v.indexOf('\n'); i !== -1; i = v.indexOf('\n', i + 1)) n++;
    return n;
  }

  /** 1-based line number of a character offset. */
  function lineAt(v, pos) {
    let n = 1;
    for (let i = v.indexOf('\n'); i !== -1 && i < pos; i = v.indexOf('\n', i + 1)) n++;
    return n;
  }

  function gutterWanted(note) {
    if (!isEditable(note)) return false;
    const m = S.settings.lineNumbers;
    return m === 'all' || (m === 'script' && isScript(note));
  }

  function clearMirror() {
    clearTimeout(g.timer);
    g.timer = 0;
    els.gutterMirror.replaceChildren();
    g.blocks = [];
    g.text = [];
    g.tops = null;
    g.key = '';
    clearHl(); // the colouring layer holds note text too: the two are always emptied together
  }

  function clearRows() {
    els.gutter.replaceChildren();
    g.pool = [];
    g.rowN = [];
  }

  function gutterKey(cs, w) {
    return [w, cs.fontSize, cs.fontFamily, cs.fontWeight, cs.letterSpacing, cs.wordSpacing, cs.tabSize, cs.lineHeight, cs.paddingLeft, cs.paddingRight].join('|');
  }

  /** Re-reads the note and the setting: decides whether the gutter shows, its width and what the mirror holds. */
  function updateGutter() {
    const note = active();
    const id = note ? note.id : null;
    if (id !== g.noteId) { clearMirror(); g.noteId = id; }
    const want = gutterWanted(note);
    g.wrapped = want && !isScript(note);
    g.tooLong = '';
    let on = want;
    if (want) {
      g.lines = countLines(els.editor.value);
      if (g.wrapped && g.lines > GUTTER_WRAP_MAX) g.tooLong = 'lines';
      else if (g.wrapped && els.editor.value.length > GUTTER_WRAP_CHARS) g.tooLong = 'chars';
      if (g.tooLong) on = false;
    }
    g.on = on;
    if (on) {
      const digits = Math.max(2, String(g.lines).length);
      if (digits !== g.digits) {
        g.digits = digits;
        els.editorPane.style.setProperty('--gutter-w', `calc(${digits}ch + 1.5rem)`);
      }
      g.caret = lineAt(els.editor.value, els.editor.selectionStart);
      if (!g.wrapped) clearMirror();
    } else {
      clearMirror();
      clearRows();
      els.editorPane.style.removeProperty('--gutter-w');
      g.digits = 0;
    }
    els.editorPane.classList.toggle('has-gutter', on);
    if (on) drawGutter();
  }

  /** Wrapped notes: one block per line in the mirror, then each block's top. */
  function measureGutter() {
    clearTimeout(g.timer);
    g.timer = 0;
    g.last = performance.now();
    const ed = els.editor;
    const mirror = els.gutterMirror;
    if (g.hold || !g.on || !g.wrapped || !ed.clientWidth) { clearMirror(); return; }
    const cs = getComputedStyle(ed);
    const w = ed.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    const st = mirror.style;
    for (const p of ['fontFamily', 'fontSize', 'fontStyle', 'fontWeight', 'fontVariant', 'fontStretch', 'letterSpacing', 'wordSpacing', 'tabSize', 'textIndent', 'textTransform', 'lineHeight', 'direction', 'whiteSpace', 'overflowWrap', 'wordBreak']) st[p] = cs[p];
    st.width = `${Math.max(0, w)}px`;
    st.setProperty('--mlh', cs.lineHeight);
    const lines = ed.value.split('\n');
    while (g.blocks.length > lines.length) g.blocks.pop().remove();
    const fresh = [];
    for (let i = 0; i < lines.length; i++) {
      if (i >= g.blocks.length) {
        const b = h('div');
        b.textContent = lines[i]; // text only, never markup
        g.blocks.push(b);
        fresh.push(b);
      } else if (g.text[i] !== lines[i]) {
        g.blocks[i].textContent = lines[i];
      }
    }
    if (fresh.length) mirror.append(...fresh);
    g.text = lines;
    const base = mirror.getBoundingClientRect().top;
    const tops = new Float64Array(lines.length);
    for (let i = 0; i < tops.length; i++) tops[i] = g.blocks[i].getBoundingClientRect().top - base;
    g.tops = tops;
    g.key = gutterKey(cs, ed.clientWidth);
  }

  /** At most about 5 measurements a second: the first one at once, the rest after the gap. */
  function scheduleMeasure() {
    if (!g.on || !g.wrapped || g.timer) return;
    const wait = GUTTER_MEASURE_GAP - (performance.now() - g.last);
    if (wait <= 0) { measureGutter(); return; }
    g.timer = setTimeout(() => { g.timer = 0; measureGutter(); scheduleGutterDraw(); }, wait);
  }

  function scheduleGutterDraw() {
    if (g.raf || !g.on) return;
    g.raf = requestAnimationFrame(drawGutter);
  }

  /**
   * The real distance between two lines of an unwrapped (script) note. The engine lays lines out on a 1/64 px grid,
   * so it can differ from the computed line height by a few thousandths of a pixel: over 20,000 lines that is a
   * whole row. When the text is taller than the box, the pitch is taken from the textarea's own height instead.
   * The gutter and the colouring layer both use this one measurement.
   */
  function scriptPitch(ed, cs, lh, padTop, lines) {
    const sh = ed.scrollHeight;
    if (sh > ed.clientHeight && lines > 1) {
      const p = (sh - padTop - (parseFloat(cs.paddingBottom) || 0)) / lines;
      if (p > lh * 0.95 && p < lh * 1.05) return p;
    }
    return lh;
  }

  /** Draws the numbers that can be seen, plus a little overscan. */
  function drawGutter() {
    g.raf = 0;
    if (!g.on || g.hold) return;
    const ed = els.editor;
    if (!ed.clientHeight || !ed.clientWidth) { clearRows(); clearMirror(); return; } // editor not on screen
    const cs = getComputedStyle(ed);
    let lh = parseFloat(cs.lineHeight);
    if (!(lh > 0)) lh = parseFloat(cs.fontSize) * 1.7;
    const padTop = parseFloat(cs.paddingTop) || 0;
    if (g.wrapped && (!g.tops || g.key !== gutterKey(cs, ed.clientWidth))) measureGutter();
    const st = ed.scrollTop;
    const view = ed.clientHeight;
    const gut = els.gutter;
    let used = 0;
    const put = (n, y) => {
      let row = g.pool[used];
      if (!row) {
        row = h('div', { class: 'ln' });
        g.pool.push(row);
        g.rowN.push(0);
        gut.appendChild(row);
      }
      if (g.rowN[used] !== n) { row.textContent = String(n); g.rowN[used] = n; }
      row.classList.toggle('cur', n === g.caret);
      row.style.top = `${y}px`;
      used++;
    };
    if (!g.wrapped) {
      const pitch = scriptPitch(ed, cs, lh, padTop, g.lines);
      const first = Math.max(0, Math.floor((st - padTop) / pitch) - GUTTER_OVERSCAN);
      const last = Math.min(g.lines - 1, Math.ceil((st + view - padTop) / pitch) + GUTTER_OVERSCAN);
      for (let k = first; k <= last; k++) put(k + 1, padTop + k * pitch - st);
    } else if (g.tops) {
      const tops = g.tops;
      const n = Math.min(g.lines, tops.length);
      const v0 = st - padTop;
      let lo = 0;
      let hi = n;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (tops[mid] > v0 - lh) hi = mid; else lo = mid + 1; }
      for (let k = Math.max(0, lo - GUTTER_OVERSCAN); k < n && tops[k] <= v0 + view + lh * GUTTER_OVERSCAN; k++) put(k + 1, padTop + tops[k] - st);
    }
    while (g.pool.length > used) { g.pool.pop().remove(); g.rowN.pop(); }
  }

  function onGutterInput() {
    g.hold = false;
    const note = active();
    if (!gutterWanted(note)) return;
    const v = els.editor.value;
    const lines = countLines(v);
    const tooLong = isScript(note) ? '' : lines > GUTTER_WRAP_MAX ? 'lines' : v.length > GUTTER_WRAP_CHARS ? 'chars' : '';
    if (tooLong !== g.tooLong || (g.on && Math.max(2, String(lines).length) !== g.digits)) { updateGutter(); return; }
    g.lines = lines;
    g.caret = lineAt(v, els.editor.selectionStart);
    scheduleMeasure();
    scheduleGutterDraw();
  }

  function onGutterCaret() {
    if (!g.on) return;
    const c = lineAt(els.editor.value, els.editor.selectionStart);
    if (c === g.caret) return;
    g.caret = c;
    scheduleGutterDraw();
  }

  // ------------------------------------------------------ syntax colouring layer
  //
  // A static <pre> behind the editor draws the note's text in colour at the same place as the editor's own text, which
  // is transparent while the layer shows. Script notes do not wrap, so each line is one row, and only the rows on
  // screen (plus a little overscan) exist. Everything the layer knows lives in `hl`; clearHl() empties it all, and
  // clearMirror() calls it, so the layer is emptied on every path the gutter's measuring copy is: lock, note switch,
  // delete, language change, setting off, printing, editor off screen.
  //
  // Tokenizer states are remembered for every 200th line (`sts`) next to those lines' offsets (`offs`). To draw from
  // line L the nearest remembered line at or before L is tokenized forward (at most 200 lines, a "chunk"). Chunks keep
  // offsets and tokens only, never the text, which is sliced from the editor's own value when needed. An edit forgets
  // everything from its first changed line (found from the beforeinput caret; unknown edits forget from line 0).
  // Catching up to a viewport far past the remembered lines happens in slices of HL_SLICE_CHUNKS chunks (5,000 lines)
  // per timer tick (about a millisecond of work each); until then those rows are drawn uncoloured.
  const HL_STEP = 200;
  const HL_MAX_LINES = 200000;
  const HL_SLICE_CHUNKS = 25;
  const HL_SYNC_CHUNKS = 6; // a gap this small is filled before drawing; a bigger one is caught up in slices
  const HL_OVERSCAN = 3;
  const HL_CHUNK_CACHE = 48;
  const HL_TOKEN_TYPES = new Set(['comment', 'string', 'keyword', 'number', 'constant', 'tag', 'attr', 'section', 'variable']);
  const HL_SIMPLE_EDITS = new Set(['insertText', 'insertLineBreak', 'insertParagraph', 'insertFromPaste', 'insertReplacementText', 'insertCompositionText', 'deleteContentBackward', 'deleteContentForward', 'deleteByCut']);
  const hl = {
    on: false, lang: '', noteId: null, lines: 1, len: 0,
    offs: [0], sts: [highlight.initialState()], chunks: new Map(), rows: new Map(),
    box: null, rowFirst: -1, rowLast: -1, dirtyFrom: Infinity, dirtyLines: new Set(), pending: null,
    want: 0, buildTimer: 0, matchRaf: 0, match: null, marks: new Map(), key: '', pitch: '', sbw: -1, sbh: -1,
  };

  /** The one place that shows or hides the layer: the class shows it and makes the editor's own text transparent. */
  function setHlActive(on) {
    hl.on = on;
    els.editorPane.classList.toggle('hl-on', on);
  }

  /** Empties the layer and forgets everything about the text. Safe to call at any time. */
  function clearHl() {
    clearTimeout(hl.buildTimer);
    cancelAnimationFrame(hl.matchRaf);
    hl.buildTimer = 0;
    hl.matchRaf = 0;
    setHlActive(false);
    els.hl.replaceChildren();
    hl.box = null;
    hl.rows = new Map();
    hl.chunks = new Map();
    hl.offs = [0];
    hl.sts = [highlight.initialState()];
    hl.marks = new Map();
    hl.match = null;
    hl.dirtyLines = new Set();
    hl.dirtyFrom = Infinity;
    hl.pending = null;
    hl.rowFirst = -1;
    hl.rowLast = -1;
    hl.noteId = null;
    hl.lang = '';
    hl.key = '';
    hl.pitch = '';
    hl.sbw = -1;
    hl.sbh = -1;
    hl.len = 0;
    hl.lines = 1;
  }

  function hlWanted(note) {
    return !!note && isEditable(note) && isScript(note) && note.lang !== 'plain' && S.settings.syntaxColors
      && !g.hold && highlight.LANGUAGE_IDS.includes(note.lang) && !els.editor.hidden;
  }

  /** Forget everything from `line` on (its start offset and state, and so everything before it, stay valid). */
  function hlInvalidate(line) {
    const c = Math.floor(line / HL_STEP);
    if (hl.offs.length > c + 1) hl.offs.length = c + 1;
    if (hl.sts.length > c + 1) hl.sts.length = c + 1;
    for (const k of [...hl.chunks.keys()]) if (k >= c) hl.chunks.delete(k);
    if (line < hl.dirtyFrom) hl.dirtyFrom = line;
  }

  /** Remembers the offsets of every 200th line up to chunk c. False when the text has fewer lines. */
  function hlExtendOffs(v, c) {
    while (hl.offs.length <= c) {
      let pos = hl.offs[hl.offs.length - 1];
      for (let i = 0; i < HL_STEP; i++) {
        const e = v.indexOf('\n', pos);
        if (e < 0) return false;
        pos = e + 1;
      }
      hl.offs.push(pos);
    }
    return true;
  }

  /** Tokenizes chunk c (its offset and state must be remembered). A full chunk also remembers where the next one starts. */
  function hlCompute(v, c) {
    const starts = [];
    const ends = [];
    const toks = [];
    const ins = [];
    let pos = hl.offs[c];
    let st = hl.sts[c];
    let full = true;
    for (let i = 0; i < HL_STEP; i++) {
      let e = v.indexOf('\n', pos);
      const lastLine = e < 0;
      if (lastLine) e = v.length;
      const r = highlight.tokenizeLine(hl.lang, v.slice(pos, e), st);
      starts.push(pos);
      ends.push(e);
      toks.push(r.tokens);
      ins.push(st);
      st = r.state;
      if (lastLine) { full = false; break; }
      pos = e + 1;
    }
    if (full) {
      if (hl.offs.length === c + 1) hl.offs.push(pos);
      if (hl.sts.length === c + 1) hl.sts.push(st);
    }
    return { starts, ends, toks, ins };
  }

  /** Makes sure the state at the start of chunk c is known, tokenizing at most maxChunks chunks to get there. */
  function hlEnsureStates(v, c, maxChunks) {
    if (hl.sts.length > c) return true;
    if (c - (hl.sts.length - 1) > maxChunks) return false;
    while (hl.sts.length <= c) {
      const k = hl.sts.length - 1;
      if (!hlExtendOffs(v, k)) return false;
      const before = hl.sts.length;
      hlCompute(v, k);
      if (hl.sts.length === before) return false; // the text ended
    }
    return true;
  }

  /** Chunk c with tokens, or null when its state is not known yet (the caller draws it uncoloured). */
  function hlChunk(v, c) {
    let ch = hl.chunks.get(c);
    if (ch) return ch;
    if (!hlExtendOffs(v, c) || !hlEnsureStates(v, c, HL_SYNC_CHUNKS)) return null;
    ch = hlCompute(v, c);
    if (hl.chunks.size >= HL_CHUNK_CACHE) hl.chunks.clear();
    hl.chunks.set(c, ch);
    return ch;
  }

  /** Where the lines of chunk c start and end, without tokens. Null when the text has no such chunk. */
  function hlPlainChunk(v, c) {
    if (!hlExtendOffs(v, c)) return null;
    const starts = [];
    const ends = [];
    let pos = hl.offs[c];
    for (let i = 0; i < HL_STEP; i++) {
      let e = v.indexOf('\n', pos);
      const lastLine = e < 0;
      if (lastLine) e = v.length;
      starts.push(pos);
      ends.push(e);
      if (lastLine) break;
      pos = e + 1;
    }
    return { starts, ends, toks: null, ins: null };
  }

  /** A lower bound for the line holding offset pos, from the remembered offsets (at most 200 newlines are counted). */
  function hlLineBound(v, pos) {
    const offs = hl.offs;
    let lo = 0;
    let hi = offs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offs[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    let line = lo * HL_STEP;
    let p = offs[lo];
    for (let i = 0; i < HL_STEP; i++) {
      const e = v.indexOf('\n', p);
      if (e < 0 || e >= pos) break;
      line++;
      p = e + 1;
    }
    return line;
  }

  /** One row: the line's text as text nodes and <span class="tok-…"> elements, never markup. */
  function hlRow(text, toks, marks) {
    const row = h('div', { class: 'hl-row' });
    const piece = (s, e, type, mark) => {
      if (e <= s) return;
      const str = text.slice(s, e);
      if (!type && !mark) row.appendChild(document.createTextNode(str));
      else row.appendChild(h('span', { class: [type ? `tok-${type}` : '', mark ? 'hl-match' : ''].filter(Boolean).join(' ') }, str));
    };
    const push = (s, e, type) => {
      let a = s;
      if (marks) {
        for (const m of marks) {
          if (m >= a && m < e) { piece(a, m, type, false); piece(m, m + 1, type, true); a = m + 1; }
        }
      }
      piece(a, e, type, false);
    };
    let pos = 0;
    if (toks) {
      for (const t of toks) {
        push(pos, t.start, '');
        push(t.start, t.end, HL_TOKEN_TYPES.has(t.type) ? t.type : '');
        pos = t.end;
      }
    }
    push(pos, text.length, '');
    return row;
  }

  /** Copies the editor's text metrics to the layer when they change, and keeps it clear of the editor's scrollbars. */
  function hlSyncStyle(ed, cs, pitch) {
    const key = [cs.fontFamily, cs.fontSize, cs.fontWeight, cs.fontStyle, cs.letterSpacing, cs.wordSpacing, cs.tabSize, cs.lineHeight].join('|');
    if (key !== hl.key) {
      hl.key = key;
      const st = els.hl.style;
      for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'wordSpacing', 'tabSize', 'lineHeight']) st[p] = cs[p];
    }
    const p = `${pitch}px`;
    if (p !== hl.pitch) { hl.pitch = p; els.hl.style.setProperty('--hl-pitch', p); }
    const sbw = ed.offsetWidth - ed.clientWidth;
    const sbh = ed.offsetHeight - ed.clientHeight;
    if (sbw !== hl.sbw) { hl.sbw = sbw; els.hl.style.right = `${sbw}px`; }
    if (sbh !== hl.sbh) { hl.sbh = sbh; els.hl.style.bottom = `${sbh}px`; }
  }

  /** Draws the visible rows. Rows below dirtyFrom (and the dirty ones) are rebuilt; the others are only moved. */
  function drawHl() {
    if (!hl.on) return;
    const ed = els.editor;
    if (!ed.clientHeight || !ed.clientWidth) { clearHl(); return; } // editor not on screen
    const cs = getComputedStyle(ed);
    let lh = parseFloat(cs.lineHeight);
    if (!(lh > 0)) lh = parseFloat(cs.fontSize) * 1.7;
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padLeft = parseFloat(cs.paddingLeft) || 0;
    const pitch = scriptPitch(ed, cs, lh, padTop, hl.lines);
    hlSyncStyle(ed, cs, pitch);
    const st = ed.scrollTop;
    const first = Math.max(0, Math.floor((st - padTop) / pitch) - HL_OVERSCAN);
    const last = Math.min(hl.lines - 1, Math.ceil((st + ed.clientHeight - padTop) / pitch) + HL_OVERSCAN);
    if (!hl.box) { hl.box = h('div', { class: 'hl-rows' }); els.hl.appendChild(hl.box); }
    hl.box.style.top = `${padTop + first * pitch - st}px`;
    hl.box.style.left = `${padLeft - ed.scrollLeft}px`;
    const rebuildAll = hl.dirtyFrom !== Infinity || hl.dirtyLines.size > 0;
    if (!rebuildAll && first === hl.rowFirst && last === hl.rowLast) return; // only moved
    let v = null;
    const rows = [];
    const fresh = new Map();
    let plain = false;
    let needChunk = -1;
    for (let k = first; k <= last; k++) {
      const old = hl.rows.get(k);
      if (old && k < hl.dirtyFrom && !hl.dirtyLines.has(k)) { rows.push(old); fresh.set(k, old); continue; }
      if (v === null) v = ed.value;
      const c = Math.floor(k / HL_STEP);
      let ch = hlChunk(v, c);
      if (!ch) {
        ch = hlPlainChunk(v, c);
        if (ch) { plain = true; needChunk = Math.max(needChunk, c); }
      }
      const j = k - c * HL_STEP;
      if (!ch || j >= ch.starts.length) break; // past the end of the text
      const row = hlRow(v.slice(ch.starts[j], ch.ends[j]), ch.toks ? ch.toks[j] : null, hl.marks.get(k) || null);
      rows.push(row);
      fresh.set(k, row);
    }
    hl.rows = fresh;
    hl.box.replaceChildren(...rows);
    hl.rowFirst = first;
    hl.rowLast = last;
    hl.dirtyFrom = Infinity;
    hl.dirtyLines.clear();
    if (plain) {
      hl.want = needChunk;
      if (!hl.buildTimer) hl.buildTimer = setTimeout(hlBuildStep, 0);
    }
  }

  /** One slice of catching up: tokenizes up to 5,000 lines towards the viewport, then redraws or schedules the next slice (a timer, so catching up does not wait for frames). */
  function hlBuildStep() {
    hl.buildTimer = 0;
    if (!hl.on) return;
    const v = els.editor.value;
    if (v.length !== hl.len) return; // an edit is about to rebuild everything anyway
    let n = 0;
    while (hl.sts.length <= hl.want && n < HL_SLICE_CHUNKS) {
      const k = hl.sts.length - 1;
      if (!hlExtendOffs(v, k)) break;
      const before = hl.sts.length;
      hlCompute(v, k);
      if (hl.sts.length === before) break;
      n++;
    }
    if (hl.sts.length > hl.want) {
      hl.dirtyFrom = 0; // the rows drawn uncoloured are redrawn
      drawHl();
    } else if (n === HL_SLICE_CHUNKS) {
      hl.buildTimer = setTimeout(hlBuildStep, 0);
    }
  }

  /** Decides whether the layer shows for the open note, and (re)builds it from scratch when it does. */
  function updateHl() {
    const note = active();
    const ed = els.editor;
    if (!hlWanted(note) || !ed.clientHeight || !ed.clientWidth) { if (hl.on || hl.noteId) clearHl(); return; }
    const v = ed.value;
    const lines = g.on && !g.wrapped && g.noteId === note.id ? g.lines : countLines(v);
    if (lines > HL_MAX_LINES) { if (hl.on || hl.noteId) clearHl(); return; }
    if (!hl.on || hl.noteId !== note.id || hl.lang !== note.lang) clearHl();
    hl.noteId = note.id;
    hl.lang = note.lang;
    hl.lines = lines;
    hl.len = v.length;
    hlInvalidate(0);
    setHlActive(true);
    drawHl();
    scheduleBracket();
  }

  /** The line the edit about to happen starts on is remembered, so its input event forgets only from there. */
  function onHlBeforeInput(e) {
    if (!hl.on) return;
    if (!HL_SIMPLE_EDITS.has(e.inputType)) { hl.pending = 0; return; }
    hl.pending = hlLineBound(els.editor.value, Math.max(0, els.editor.selectionStart - 1));
  }

  function onHlInput() {
    const note = active();
    if (!hlWanted(note)) { if (hl.on || hl.noteId) clearHl(); return; }
    if (!hl.on) { updateHl(); return; }
    const v = els.editor.value;
    const lines = g.on && !g.wrapped ? g.lines : countLines(v);
    if (lines > HL_MAX_LINES) { clearHl(); return; }
    hl.lines = lines;
    hl.len = v.length;
    hlInvalidate(hl.pending === null ? 0 : hl.pending);
    hl.pending = null;
    drawHl();
    scheduleBracket();
  }

  function onHlScroll() {
    if (hl.on) drawHl();
  }

  /** The editor was resized or shown again: redraw, or build the layer if it should show and does not. */
  function hlRefresh() {
    if (hl.on) drawHl();
    else if (hlWanted(active())) updateHl();
  }

  // Matching bracket: the two brackets get an outline in the layer. One search per animation frame.
  function scheduleBracket() {
    if (!hl.on || hl.matchRaf) return;
    hl.matchRaf = requestAnimationFrame(updateBracket);
  }

  /** The line and column of offset pos, and the chunk its line is in. */
  function hlLocate(v, pos) {
    for (;;) {
      const next = hl.offs.length;
      if (!hlExtendOffs(v, next) || hl.offs[next] > pos) break;
    }
    const line = hlLineBound(v, pos);
    const c = Math.floor(line / HL_STEP);
    let start = hl.offs[c];
    for (let i = c * HL_STEP; i < line; i++) start = v.indexOf('\n', start) + 1;
    return { line, column: pos - start, c };
  }

  function hlFindMatch(v, pos) {
    const bracket = (ch) => ch === '(' || ch === ')' || ch === '[' || ch === ']' || ch === '{' || ch === '}';
    if (!bracket(v[pos - 1]) && !bracket(v[pos])) return null;
    const at = hlLocate(v, pos);
    if (!hlEnsureStates(v, at.c, HL_SYNC_CHUNKS)) return null;
    const chunkOf = (i) => (i >= 0 && i < hl.lines ? hlChunk(v, Math.floor(i / HL_STEP)) : null);
    const getLine = (i) => {
      const ch = chunkOf(i);
      const j = i - Math.floor(i / HL_STEP) * HL_STEP;
      return ch && j < ch.starts.length ? v.slice(ch.starts[j], ch.ends[j]) : null;
    };
    const stateAt = (i) => {
      const ch = chunkOf(i);
      const j = i - Math.floor(i / HL_STEP) * HL_STEP;
      return ch && j < ch.ins.length ? ch.ins[j] : undefined;
    };
    return highlight.matchBracket(getLine, hl.lines, at.line, at.column, hl.lang, stateAt);
  }

  function updateBracket() {
    hl.matchRaf = 0;
    if (!hl.on) return;
    const ed = els.editor;
    let next = null;
    if (ed.selectionStart === ed.selectionEnd) next = hlFindMatch(ed.value, ed.selectionStart);
    const old = hl.match;
    const same = (a, b) => (a === null && b === null) || (a !== null && b !== null
      && a.open.line === b.open.line && a.open.column === b.open.column && a.close.line === b.close.line && a.close.column === b.close.column);
    if (same(old, next)) return;
    for (const m of [old, next]) if (m) { hl.dirtyLines.add(m.open.line); hl.dirtyLines.add(m.close.line); }
    hl.match = next;
    hl.marks = new Map();
    if (next) {
      for (const p of [next.open, next.close]) {
        const cols = hl.marks.get(p.line) || [];
        cols.push(p.column);
        cols.sort((a, b) => a - b);
        hl.marks.set(p.line, cols);
      }
    }
    drawHl();
  }

  function toggleSyntaxColors() {
    S.settings.syntaxColors = !S.settings.syntaxColors;
    saveSettings();
    updateHl();
    toast(S.settings.syntaxColors ? 'Syntax colouring on.' : 'Syntax colouring off.');
  }

  function lineNumbersTitle() {
    const m = S.settings.lineNumbers;
    const name = m === 'all' ? 'every note' : m === 'off' ? 'off' : 'script notes only';
    const hidden = g.tooLong === 'chars' ? ' (hidden in this note: too long to measure)' : g.tooLong ? ' (hidden in this note: more than 3,000 lines)' : '';
    return `Line numbers: ${name}${hidden} (change)`;
  }

  function cycleLineNumbers() {
    const a = store.LINE_NUMBERS;
    S.settings.lineNumbers = a[(a.indexOf(S.settings.lineNumbers) + 1) % a.length];
    saveSettings();
    updateGutter();
    const m = S.settings.lineNumbers;
    toast(`Line numbers: ${m === 'all' ? 'every note' : m === 'off' ? 'off' : 'script notes only'}.`);
  }

  const LIST_CAP = 500;
  const LOOSE_RESERVE = 50; // rows kept for the newest notes without a folder, so open folders cannot use up the cap
  const isFlatList = () => !!(S.query.trim() || S.tag);

  /** One sidebar row: the note button plus its delete button. `grouped` rows sit under a folder header and can be dragged. */
  function noteRow(n, q, grouped) {
    const m = metaOf(n);
    const mark = n.pinned ? '◆' : n.cipher ? (isLocked(n) ? '▣' : '□') : isScript(n) ? '›' : '';
    const scriptMark = isScript(n) && (n.pinned || n.cipher); // the pin or lock takes the mark column; the title then carries the script sign
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
    const linked = platform.isDesktop && !!n.file;
    const states = [grouped && n.folder && `in ${n.folder}`, n.pinned && 'pinned', n.cipher && (isLocked(n) ? 'encrypted, locked' : 'encrypted, unlocked'), isScript(n) && `script, ${langName(n)}`, linked && 'linked to a file'].filter(Boolean).join(', ');
    // In the flat (search or tag) list there are no headers, so the row names its folder.
    const folderTag = !grouped && n.folder ? h('span', { class: 'note-folder' }, n.folder) : null;
    const li = h('li', { class: grouped && n.folder ? 'note-row in-folder' : 'note-row', 'data-id': n.id, 'data-group': grouped ? n.folder : null },
      h('button', {
        type: 'button',
        class: 'note-item',
        'data-id': n.id,
        'aria-current': String(n.id === S.activeId),
      },
      h('span', { class: 'note-mark', 'aria-hidden': 'true' }, mark),
      h('span', { class: 'note-title' }, scriptMark ? h('span', { class: 'note-file', 'aria-hidden': 'true' }, '›') : null, linked ? h('span', { class: 'note-file', 'aria-hidden': 'true' }, '⇄') : null, m.title,
        states ? h('span', { class: 'sr-only' }, ` (${states})`) : null),
      h('span', { class: 'note-meta' }, h('span', null, T.relativeTime(n.updated)), folderTag, extra)),
      h('button', { type: 'button', class: 'note-del', 'data-id': n.id, 'aria-label': `Delete ${m.title}` }, '×'));
    // draggable is not in the h() allow-list and the allow-list is deliberately not widened: it is set as a property, and the value is a fixed boolean, never data.
    if (grouped) li.draggable = true;
    return li;
  }

  function renderList() {
    dragId = null; // a drag cannot outlive the rows it started from
    const list = visibleNotes();
    const q = S.query.trim();
    const flat = isFlatList();
    const frag = document.createDocumentFragment();
    if (!list.length) {
      frag.append(h('li', { class: 'empty-list' }, S.query || S.tag ? 'No notes match. Clear the filter, or press Alt+N to start one.' : 'No notes yet. Press Alt+N to start one.'));
    }
    let rows = 0;
    let omitted = 0;
    const add = (n, grouped, limit = LIST_CAP) => {
      if (rows < limit) { frag.append(noteRow(n, q, grouped)); rows += 1; } else omitted += 1;
    };
    if (flat) {
      for (const n of list) add(n, false);
    } else {
      const byFolder = new Map();
      const loose = [];
      for (const n of list) {
        if (!n.folder) { loose.push(n); continue; }
        if (!byFolder.has(n.folder)) byFolder.set(n.folder, []);
        byFolder.get(n.folder).push(n);
      }
      const closed = new Set(S.settings.collapsedFolders);
      const folderLimit = LIST_CAP - Math.min(LOOSE_RESERVE, loose.length);
      for (const f of store.folderList(S.notes)) {
        const open = !closed.has(f.name);
        frag.append(h('li', { class: 'folder-li', 'data-group': f.name },
          h('button', { type: 'button', class: 'folder-head', 'aria-expanded': String(open), 'data-folder': f.name },
            h('span', { class: 'folder-caret', 'aria-hidden': 'true' }, open ? '▾' : '▸'),
            h('span', { class: 'folder-name' }, f.name),
            h('span', { class: 'count' }, f.count))));
        if (open) for (const n of byFolder.get(f.name) || []) add(n, true, folderLimit);
      }
      for (const n of loose) add(n, true);
    }
    if (omitted) {
      frag.append(h('li', { class: 'empty-list' }, omitted === 1
        ? '1 more note not shown. Search to find it.'
        : `${omitted} more notes not shown. Search to find them.`));
    }
    els.noteList.replaceChildren(frag);
    els.filterRow.hidden = !S.tag;
    els.filterLabel.textContent = S.tag ? `Tagged #${S.tag}` : '';
  }

  // ---------------------------------------------------------------- folders

  const folderHeadFor = (name) => [...els.noteList.querySelectorAll('.folder-head')].find((b) => b.dataset.folder === name) || null;

  /** Forget closed-state for folders that no longer exist. Always a new array: the settings object never shares one. */
  function pruneCollapsed() {
    const live = new Set(store.folderList(S.notes).map((f) => f.name));
    S.settings.collapsedFolders = S.settings.collapsedFolders.filter((name) => live.has(name));
  }

  function toggleFolder(name) {
    if (!store.folderList(S.notes).some((f) => f.name === name)) return;
    const closed = S.settings.collapsedFolders;
    S.settings.collapsedFolders = closed.includes(name) ? closed.filter((x) => x !== name) : [...closed, name];
    pruneCollapsed();
    saveSettings();
    renderList();
    const head = folderHeadFor(name);
    if (head) head.focus();
  }

  function expandFolder(name) {
    if (name && S.settings.collapsedFolders.includes(name)) S.settings.collapsedFolders = S.settings.collapsedFolders.filter((x) => x !== name);
  }

  /** Puts a note in a folder ('' for none). Returns whether anything changed. `name` is already cleaned. */
  function setNoteFolder(note, name) {
    if (note.folder === name) return false;
    note.folder = name;
    if (note.id === S.activeId) expandFolder(name);
    pruneCollapsed();
    persistNow();
    renderList();
    return true;
  }

  const FOLDER_NAME_MSG = `Folder names are 1 to ${store.LIMITS.folderName} characters, without / or \\, line breaks or invisible characters.`;
  const FOLDER_LIMIT_MSG = `You already have ${store.LIMITS.folders} folders. Move the note into one of them.`;

  /** Dialog with a name box and the existing folders as buttons. Resolves to the cleaned name, or null when cancelled. */
  function folderNameDialog({ title, label, initial, submit, checkLimit }) {
    const folders = store.folderList(S.notes);
    const input = h('input', { type: 'text', id: 'folder-name', maxlength: store.LIMITS.folderName, autocomplete: 'off', value: initial });
    const err = h('p', { class: 'form-error', role: 'alert' });
    const choices = folders.length
      ? h('div', { class: 'folder-choices', role: 'group', 'aria-label': 'Existing folders' }, folders.map((f) => {
        const b = h('button', { type: 'button', class: 'chip' }, f.name);
        b.addEventListener('click', () => { input.value = f.name; err.textContent = ''; input.focus(); });
        return b;
      }))
      : null;
    input.addEventListener('focus', () => input.select(), { once: true });
    return showDialog({
      title,
      initialFocus: '#folder-name',
      body: [h('label', { class: 'field' }, h('span', null, label), input), choices, err],
      actions: [{ label: 'Cancel', value: null }, { label: submit, submit: true, className: 'btn-primary' }],
      onSubmit: () => {
        const name = store.cleanFolder(input.value);
        if (!name) { err.textContent = FOLDER_NAME_MSG; input.focus(); return undefined; }
        if (checkLimit && !folders.some((f) => f.name === name) && folders.length >= store.LIMITS.folders) {
          err.textContent = FOLDER_LIMIT_MSG;
          input.focus();
          return undefined;
        }
        return name;
      },
    });
  }

  // Notes whose language the user picked (language dialog or "Back to a Markdown note"). Saving such a note under another
  // file type keeps that choice. Kept for this session only, never saved.
  const langByHand = new Set();

  /** Re-renders everything a language change touches. */
  function refreshAfterLang(note) {
    if (note.id !== S.activeId) return;
    renderEditor();
    renderList();
    renderTags();
    renderPreview();
    updateStatus();
  }

  /** Switches a note between Markdown (`''`) and a script language. The text, its history and its date are not touched. */
  function setNoteLang(note, id, byHand = false) {
    if (!note || !isEditable(note) || (id !== '' && !codeedit.language(id))) return;
    closeSlash();
    arrowMemo = null;
    note.lang = id;
    if (byHand) langByHand.add(note.id);
    persistNow();
    refreshAfterLang(note);
    toast(id ? `Script mode: ${codeedit.language(id).name}.` : 'Back to a Markdown note.');
  }

  async function chooseLanguage() {
    const note = active();
    if (!isEditable(note)) return;
    const choice = (id, label) => {
      const on = note.lang === id;
      const b = h('button', { type: 'button', class: 'chip lang-choice', 'data-lang': id, 'aria-pressed': String(on) },
        on ? h('span', { 'aria-hidden': 'true' }, '●') : null, label);
      b.addEventListener('click', () => { if (finishCurrentDialog) finishCurrentDialog({ id }); });
      return b;
    };
    const picked = await showDialog({
      title: 'Script mode',
      initialFocus: '.lang-choice[aria-pressed="true"]',
      body: [
        h('p', null, 'Pick the language this note is written in. Tab, Enter and Backspace then indent the way it expects. The text does not change.'),
        h('div', { class: 'lang-choices', role: 'group', 'aria-label': 'Language' },
          choice('', 'Markdown note (no script mode)'),
          codeedit.LANGUAGES.map((l) => choice(l.id, l.name))),
      ],
      actions: [{ label: 'Cancel', value: null }],
    });
    if (!picked || active() !== note) return;
    setNoteLang(note, picked.id, true);
  }

  async function moveToFolder() {
    const note = active();
    if (!note) return;
    const name = await folderNameDialog({ title: 'Move to folder', label: 'Folder name', initial: note.folder, submit: 'Move', checkLimit: true });
    if (!name || !noteById(note.id)) return;
    if (setNoteFolder(note, name)) toast(`Moved to ${name}.`);
  }

  function removeFromFolder() {
    const note = active();
    if (!note || !note.folder) return;
    const old = note.folder;
    if (setNoteFolder(note, '')) toast(`Removed from ${old}.`);
  }

  async function renameFolder() {
    const note = active();
    if (!note || !note.folder) return;
    const old = note.folder;
    const name = await folderNameDialog({ title: 'Rename folder', label: 'Folder name', initial: old, submit: 'Rename', checkLimit: false });
    if (!name || name === old) return;
    const merging = S.notes.some((n) => n.folder === name);
    if (merging && !(await confirmDialog(`Merge into "${name}"?`, `Every note in "${old}" moves into "${name}".`, 'Merge folders'))) return;
    const wasClosed = S.settings.collapsedFolders.includes(old);
    for (const n of S.notes) if (n.folder === old) n.folder = name;
    if (wasClosed && !merging) S.settings.collapsedFolders = [...S.settings.collapsedFolders, name];
    pruneCollapsed();
    persistNow();
    renderList();
    toast(`Renamed to ${name}.`);
  }

  // Drag a note row onto a folder header (or onto the loose notes) to move it. The id lives here, never in dataTransfer text.
  let dragId = null;

  function clearDropMarks() {
    els.noteList.classList.remove('drop-loose');
    for (const el of els.noteList.querySelectorAll('.drop-target')) el.classList.remove('drop-target');
  }

  function dropGroup(e) {
    const li = e.target instanceof Element ? e.target.closest('li[data-group]') : null;
    return li && els.noteList.contains(li) ? li : null;
  }

  function wireFolderDrag() {
    const list = els.noteList;
    list.addEventListener('dragstart', (e) => {
      const row = e.target instanceof Element ? e.target.closest('.note-row') : null;
      if (!row || isFlatList() || !e.dataTransfer) { dragId = null; return; }
      dragId = row.dataset.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/x-cyberpad-note', '1'); // a marker only (some browsers need data to start a drag)
    });
    list.addEventListener('dragover', (e) => {
      if (!dragId || isFlatList()) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      clearDropMarks();
      const li = dropGroup(e);
      if (li && li.dataset.group) li.classList.add('drop-target');
      else list.classList.add('drop-loose');
    });
    list.addEventListener('dragleave', (e) => { if (!e.relatedTarget || !list.contains(e.relatedTarget)) clearDropMarks(); });
    list.addEventListener('drop', (e) => {
      if (!dragId) return;
      e.preventDefault();
      const id = dragId;
      dragId = null;
      clearDropMarks();
      if (isFlatList()) return;
      const li = dropGroup(e);
      const group = li ? li.dataset.group : '';
      const note = noteById(id);
      if (!note) return;
      // Only an existing folder or no folder is a target, so no name is typed or created here.
      if (group && !store.folderList(S.notes).some((f) => f.name === group)) return;
      const old = note.folder;
      if (setNoteFolder(note, group)) toast(group ? `Moved to ${group}.` : `Removed from ${old}.`);
    });
    list.addEventListener('dragend', () => { dragId = null; clearDropMarks(); });
    // Whatever happens to a drag elsewhere, the id does not stay behind (after the list's own drop handler has run).
    document.addEventListener('dragend', () => { dragId = null; clearDropMarks(); }, true);
    document.addEventListener('drop', () => setTimeout(() => { dragId = null; clearDropMarks(); }, 0), true);
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

  function renderPreview(force = false) {
    clearTimeout(previewTimer);
    const note = active();
    if ((S.settings.view === 'edit' && !force) || !note) {
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
    if (isScript(note)) {
      // One code block: the text is a text node, never parsed, and a script note has no backlinks.
      els.preview.replaceChildren(body.trim()
        ? h('pre', { 'data-lang': langName(note) },
          h('button', { type: 'button', class: 'copy-btn', 'data-copy': '' }, 'Copy'),
          h('code', null, body))
        : h('p', { class: 'preview-empty' }, 'Nothing here yet. The preview fills in as you write.'));
      els.backlinks.replaceChildren();
      return;
    }
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
    const lang = isEditable(note) ? langName(note) : '';
    els.stLang.hidden = !lang;
    if (els.stLang.textContent !== lang) {
      els.stLang.textContent = lang;
      els.stLang.setAttribute('aria-label', `${lang}. Change script language.`);
    }
    const unlocked = S.keys.size;
    els.stLock.hidden = !unlocked && !(note && note.cipher);
    els.stLock.textContent = note && note.cipher
      ? (isLocked(note) ? 'Encrypted, locked' : `Encrypted, auto-locks after ${S.settings.autoLockMinutes} min idle`)
      : `${unlocked} encrypted note${unlocked === 1 ? '' : 's'} unlocked`;
    els.stClock.textContent = T.hm(new Date());
    renderFileUi();
  }

  // ---------------------------------------------------------- note actions

  function openNote(id, { focus = true } = {}) {
    if (!noteById(id)) return;
    closeSlash();
    hideSeltools();
    arrowMemo = null;
    S.activeId = id;
    expandFolder(noteById(id).folder); // opening a note shows the folder it is in
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

  function addNote(body, caretPos, folder = '', lang = '') {
    if (S.notes.length >= store.LIMITS.notes) {
      toast(`You have reached ${store.LIMITS.notes} notes. Delete some to make room.`, 'error');
      return null;
    }
    const n = store.createNote(body);
    n.folder = store.cleanFolder(folder);
    n.lang = codeedit.language(lang) ? lang : '';
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
    const note = active();
    const folder = note ? note.folder : ''; // a new note joins the folder of the note that was open
    if (S.tag) addNote(`\n\n#${S.tag}`, 0, folder);
    else addNote('', 0, folder);
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
    const open = active();
    if (addNote(body, body.length, open ? open.folder : '')) toast(`Created "${title}".`);
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
    addNote(note.body, undefined, note.folder, note.lang);
  }

  const UNDO_MS = 10000;

  /**
   * Makes the pending delete final. Only now is the host told to forget a linked file, and only when no note on the
   * page holds that link (another note may have taken it over during the undo window). Best effort: a failure is left for the next prune.
   */
  function finalizePendingDelete() {
    const p = S.pendingDelete;
    if (!p) return;
    S.pendingDelete = null;
    clearTimeout(p.timer);
    if (p.toastEl) p.toastEl.remove();
    if (platform.isDesktop) forgetFileState(p.note.id);
    if (p.link && !noteByLink(p.link.linkId)) forgetHostLink(p.link.linkId);
  }

  /**
   * Puts the pending delete back. Returns whether the note is back. A refusal (the id exists, the note limit) ends the
   * pending delete with a plain reason: nothing the user can do within the window would make a retry work.
   */
  function undoDelete(p = S.pendingDelete, { fromList = false } = {}) {
    if (!p || S.pendingDelete !== p) return false; // already final
    if (noteById(p.note.id)) { finalizePendingDelete(); toast('That note is already back.'); return false; }
    if (S.notes.length >= store.LIMITS.notes) {
      finalizePendingDelete();
      toast('You have the maximum number of notes. Delete one and import your backup to get this note back.', 'error');
      return false;
    }
    S.pendingDelete = null;
    clearTimeout(p.timer);
    if (p.toastEl) p.toastEl.remove();
    const note = p.note;
    const notes = [];
    // Another note took this note's file link during the window: the note returns unlinked, so one file keeps one note.
    if (note.file && noteByLink(note.file.linkId)) {
      note.file = null;
      if (platform.isDesktop) forgetFileState(note.id);
      notes.push('Its file is now linked to another note.');
    }
    // The 101st distinct folder is not allowed: the note returns with no folder.
    if (note.folder && !S.notes.some((n) => n.folder === note.folder) && store.folderList(S.notes).length >= store.LIMITS.folders) {
      note.folder = '';
      notes.push(`It is back without its folder, because you already have ${store.LIMITS.folders} folders.`);
    }
    // The blank note made when the last note was deleted goes, unless the user has started using it.
    const blank = p.blankId ? noteById(p.blankId) : null;
    if (blank && !blank.body && !blank.lang && !blank.cipher && !blank.pinned && !blank.folder && !blank.file && !blank.history.length && blank.updated === blank.created) {
      S.notes = S.notes.filter((n) => n.id !== blank.id);
      S.meta.delete(blank.id);
    }
    S.notes.splice(Math.min(p.index, S.notes.length), 0, note); // an encrypted note has no key in S.keys, so it returns locked
    S.query = '';
    els.search.value = '';
    openNote(note.id, { focus: !fromList }); // renders the list, editor and preview; from the list, focus stays in the list
    renderTags();
    persistNow();
    if (fromList) {
      const row = [...els.noteList.querySelectorAll('.note-item')].find((b) => b.dataset.id === note.id);
      if (row) row.focus();
    }
    if (notes.length) toast(`Note restored. ${notes.join(' ')}`);
    return true;
  }

  /**
   * A file link held only by the pending delete: the host still has it, so the page must not treat it as free.
   * The note is restored (one link per file), and its holder is returned; null when the link is not the pending note's.
   */
  function restorePendingHolding(linkId) {
    const p = S.pendingDelete;
    if (!p || !p.link || p.link.linkId !== linkId) return null;
    // Whether or not the note can come back, this delete must not drop the link: the file is being opened or linked again.
    p.link = null;
    return undoDelete(p) ? noteByLink(linkId) : null;
  }

  async function deleteNote(note = active()) {
    if (!note) return;
    const fromList = els.noteList.contains(document.activeElement);
    const link = platform.isDesktop && note.file ? note.file : null;
    const ok = await confirmDialog(`Delete "${titleOf(note)}"?`, `You can undo this for ${UNDO_MS / 1000} seconds. After that the note is gone, so export a backup first if you might need it later.${link ? ' The file stays where it is.' : ''}`, 'Delete note', true);
    if (!ok || !noteById(note.id)) return;
    // Pending edits of an unlocked encrypted note are sealed first, so Undo brings back its latest text.
    if (note.cipher) { await flushSeals(); if (!noteById(note.id)) return; }
    finalizePendingDelete(); // only the latest delete can be undone
    const wasOpen = S.activeId === note.id;
    const rowIds = [...els.noteList.querySelectorAll('.note-item')].map((b) => b.dataset.id);
    const at = rowIds.indexOf(note.id);
    clearTimeout(S.sealTimers.get(note.id));
    S.sealTimers.delete(note.id);
    const index = S.notes.findIndex((n) => n.id === note.id);
    S.notes = S.notes.filter((n) => n.id !== note.id);
    S.keys.delete(note.id);
    S.plain.delete(note.id);
    S.meta.delete(note.id);
    let blankId = null;
    if (!S.notes.length) { const blank = store.createNote(''); blankId = blank.id; S.notes.push(blank); }
    pruneCollapsed();
    persistNow();
    if (wasOpen || !noteById(S.activeId)) {
      openNote(sortedNotes()[0].id, { focus: !fromList }); // the normal open path; the list keeps focus when the delete came from it
      renderAll();
    } else { // another note was deleted: the open note's editor is left alone
      renderList();
      renderTags();
      updateStatus();
    }
    const p = { note, index, link, blankId, timer: 0, toastEl: null };
    S.pendingDelete = p;
    p.toastEl = toast('Note deleted. Press Ctrl+Z in the list or choose Undo.', 'info', [{ label: 'Undo', fn: () => undoDelete(p) }]);
    p.timer = setTimeout(finalizePendingDelete, UNDO_MS);
    if (fromList) { // focus moves to the neighbouring row: the next one, else the previous one, else New note
      const rows = [...els.noteList.querySelectorAll('.note-item')];
      const pick = [rowIds[at + 1], rowIds[at - 1]].filter((id) => id && id !== note.id)
        .map((id) => rows.find((b) => b.dataset.id === id)).find(Boolean);
      (pick || els.btnNew).focus();
    }
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
  let programmaticInsert = false; // set while replaceRange runs, so its input event never counts as typing
  function replaceRange(start, end, text, caretStart = start + text.length, caretEnd = caretStart) {
    programmaticInsert = true;
    try {
      replaceRangeNow(start, end, text, caretStart, caretEnd);
    } finally {
      programmaticInsert = false;
    }
  }

  function replaceRangeNow(start, end, text, caretStart, caretEnd) {
    const ed = els.editor;
    ed.focus();
    setSel(start, end);
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
    setSel(caretStart, caretEnd);
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
    setSel(start, end);
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

  function onEditorInput(e) {
    const note = active();
    if (!isEditable(note)) return;
    arrowMemo = null;
    const value = els.editor.value;
    if (value.length > store.LIMITS.body) {
      toast('This note has reached the size limit.', 'error');
      return;
    }
    // "->" becomes an arrow as it is typed. The replacement raises its own input event, which does the rest once.
    if (S.settings.arrows && !isScript(note) && !programmaticInsert && e && e.inputType === 'insertText' && !e.isComposing
      && typeof e.data === 'string' && e.data.length === 1
      && els.editor.selectionStart === els.editor.selectionEnd) {
      const r = T.arrowReplacement(value, els.editor.selectionStart, e.data);
      if (r) {
        const original = value.slice(r.start, r.end);
        replaceRange(r.start, r.end, r.insert);
        arrowMemo = { pos: r.start, original, insert: r.insert };
        return;
      }
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
    if (platform.isDesktop && !files.applying) files.lastInput.set(note.id, S.lastActive);
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

    // Backspace right after an automatic arrow gives back the typed characters; any other key forgets it.
    const memo = arrowMemo;
    if (!['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) arrowMemo = null;
    if (memo && e.key === 'Backspace' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !e.isComposing) {
      const ed = els.editor;
      if (ed.selectionStart === memo.pos + 1 && ed.selectionEnd === memo.pos + 1
        && ed.value.slice(memo.pos, memo.pos + 1) === memo.insert) {
        e.preventDefault();
        replaceRange(memo.pos, memo.pos + 1, memo.original);
        arrowMemo = null;
        return;
      }
    }

    if (e.key === 'Escape') { hideSeltools(); S.tabEscape = true; return; }
    if (selKeyDown(e)) hideSeltools();
    const escaped = S.tabEscape;
    S.tabEscape = false;

    const note = active();
    if (lineEditKeydown(e, note)) return;
    if (isScript(note)) { scriptKeydown(e, note, escaped); return; }

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

  // ------------------------------------------------------ line editing (comment, duplicate, move, go to line)

  /**
   * Runs a codeedit line command on the editor's selection as one undo step. Script notes pass their language; Markdown
   * notes pass '' (duplicate and move only). Returns false when the command does not apply.
   */
  function applyLineEdit(kind, dir = 0) {
    const note = active();
    const ed = els.editor;
    if (!isEditable(note) || ed.hidden) return false;
    const { selectionStart: s, selectionEnd: t, value } = ed;
    const id = isScript(note) ? note.lang : '';
    let r = null;
    if (kind === 'comment') r = id ? codeedit.toggleComment(value, s, t, id) : null;
    else if (kind === 'duplicate') r = codeedit.duplicateLines(value, s, t, id);
    else if (kind === 'move') r = codeedit.moveLines(value, s, t, id, dir);
    if (!r) return false;
    // A result that leaves the text as it is only moves the selection: nothing is edited, nothing is dispatched.
    if (value.slice(r.start, r.end) === r.insert) { setSel(r.selStart, r.selEnd); return true; }
    if (value.length - (r.end - r.start) + r.insert.length > store.LIMITS.body) { toast('The result would be too long for one note.', 'error'); return true; }
    replaceRange(r.start, r.end, r.insert, r.selStart, r.selEnd);
    return true;
  }

  /**
   * Ctrl+/, Ctrl+Shift+D, Alt+Up, Alt+Down and Ctrl+G in the editor. Returns true when the key was used. Ctrl+G stays
   * "Find next" while the find bar is open.
   */
  function lineEditKeydown(e, note) {
    if (e.isComposing || e.keyCode === 229 || !isEditable(note)) return false;
    const mod = e.ctrlKey || e.metaKey;
    let done = false;
    if (mod && !e.altKey && (e.key === '/' || e.code === 'Slash' || e.code === 'NumpadDivide')) {
      if (!isScript(note)) return false;
      applyLineEdit('comment');
      done = true;
    } else if (mod && !e.altKey && e.shiftKey && e.key.toLowerCase() === 'd') {
      applyLineEdit('duplicate');
      done = true;
    } else if (e.altKey && !mod && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      applyLineEdit('move', e.key === 'ArrowUp' ? -1 : 1);
      done = true;
    } else if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'g' && els.findbar.hidden) {
      gotoLineDialog();
      done = true;
    }
    if (done) { e.preventDefault(); e.stopPropagation(); }
    return done;
  }

  /** Go to line…: a number from 1 to the note's line count. */
  async function gotoLineDialog() {
    const note = active();
    if (!isEditable(note)) return;
    const total = countLines(els.editor.value);
    const input = h('input', { type: 'number', id: 'goto-line', autocomplete: 'off' });
    // Fixed values and a line count (an integer), set as properties: SAFE_ATTR does not list min, max or inputmode.
    input.min = '1';
    input.max = String(total);
    input.inputMode = 'numeric';
    const err = h('p', { class: 'form-error', role: 'alert' });
    const pending = showDialog({
      title: 'Go to line',
      initialFocus: '#goto-line',
      body: [h('label', { class: 'field' }, h('span', null, 'Line number'), input), err],
      actions: [{ label: 'Cancel', value: null }, { label: 'Go', submit: true, className: 'btn-primary' }],
      onSubmit: () => {
        const raw = input.value.trim();
        const n = /^\d{1,9}$/.test(raw) ? Number(raw) : NaN;
        if (!(n >= 1 && n <= total)) {
          err.textContent = `Enter a line number from 1 to ${total}.`;
          input.focus();
          return undefined;
        }
        return n;
      },
    });
    // The page checks the number itself and shows its own message; the browser's built-in bubble would replace it.
    if (input.form) input.form.noValidate = true;
    const n = await pending;
    if (typeof n !== 'number' || active() !== note || !isEditable(note)) return;
    gotoLine(n - 1);
  }

  /**
   * Indentation keys in a script note: the language rules decide, the browser's undo stack keeps each result as
   * one step. Nothing else (lists, tasks, calculator) runs in a script note.
   */
  function scriptKeydown(e, note, escaped) {
    if (e.isComposing || e.keyCode === 229) return;
    // AltGr arrives as Ctrl+Alt on Windows and types the brace on many keyboard layouts.
    // That exception covers the closer characters only, never Tab, Enter or Backspace.
    const isCloser = e.key === '}' || e.key === ')' || e.key === ']';
    const altGr = isCloser && typeof e.getModifierState === 'function' && e.getModifierState('AltGraph');
    if (!altGr && (e.ctrlKey || e.altKey || e.metaKey)) return;
    const ed = els.editor;
    const { selectionStart: s, selectionEnd: t, value } = ed;
    let r = null;
    if (e.key === 'Tab') {
      if (escaped) return; // Esc then Tab moves focus out of the editor.
      e.preventDefault(); // Tab never leaves the editor, even when there is nothing to indent or remove.
      r = codeedit.tab(value, s, t, note.lang, e.shiftKey);
    } else if (e.key === 'Enter') r = codeedit.enter(value, s, t, note.lang);
    else if (e.key === 'Backspace') r = codeedit.backspace(value, s, t, note.lang);
    else if (isCloser) r = codeedit.closer(value, s, t, note.lang, e.key);
    if (!r) return;
    e.preventDefault();
    // A result that leaves the text as it is only moves the selection: nothing is edited, nothing is dispatched.
    if (value.slice(r.start, r.end) === r.insert) { setSel(r.selStart, r.selEnd); return; }
    replaceRange(r.start, r.end, r.insert, r.selStart, r.selEnd);
  }

  /** Pasting a URL over selected text turns it into a Markdown link. */
  function onEditorPaste(e) {
    if (isScript(active())) return; // code stays as pasted
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

  // ------------------------------------------------------------ selection toolbar
  //
  // A row of buttons above a finished selection. It holds labels only, never note text: it is built when it shows
  // and emptied when it hides. It never takes focus by itself (mousedown on it is cancelled); Alt+F10 moves focus in.

  const SEL_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];
  let selMouseDown = false;  // the mouse button went down in the editor and is not up yet
  let selKeyHeld = '';       // a selection key (Shift+arrow, Ctrl+A) is down: show the toolbar when it comes up
  let selSnapshot = null;    // the editor selection, kept while focus is inside the toolbar
  let selQuietUntil = 0;     // our own edits can scroll the editor: its scroll events do not hide the toolbar until then
  let selProgAt = 0;         // when code last set the selection, so the `select` event it causes is not the user's
  let selTimer = 0;
  let selBuiltFor = '';

  /** setSelectionRange for code: its `select` event must not pop the toolbar up. */
  function setSel(start, end, dir) {
    selProgAt = performance.now();
    els.editor.setSelectionRange(start, end, dir);
  }

  function selKeyDown(e) {
    const mod = e.ctrlKey || e.metaKey;
    return (e.shiftKey && !mod && SEL_KEYS.includes(e.key)) || (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'a');
  }

  function toggleSelectionToolbar() {
    S.settings.selectionToolbar = !S.settings.selectionToolbar;
    saveSettings();
    if (!S.settings.selectionToolbar) hideSeltools();
    toast(S.settings.selectionToolbar ? 'Selection toolbar on.' : 'Selection toolbar off.');
  }

  /** What each formatting action does to the editor text: a texttools or codeedit result, or null. */
  function formatResult(kind, note, value, s, t) {
    switch (kind) {
      case 'bold': return T.toggleWrap(value, s, t, '**');
      case 'italic': return T.toggleWrap(value, s, t, '*');
      case 'strike': return T.toggleWrap(value, s, t, '~~');
      case 'mark': return T.toggleWrap(value, s, t, '==');
      case 'code': return T.toggleWrap(value, s, t, '`');
      case 'link': return T.makeLink(value, s, t);
      case 'quote': return T.toggleLinePrefix(value, s, t, '> ');
      case 'list': return T.toggleLinePrefix(value, s, t, '- ');
      case 'comment': return codeedit.toggleComment(value, s, t, note.lang);
      case 'indent': return codeedit.tab(value, s, t, note.lang, false);
      case 'outdent': return codeedit.tab(value, s, t, note.lang, true);
      default: return null;
    }
  }

  const SCRIPT_FORMATS = ['comment', 'indent', 'outdent'];

  /**
   * Applies a formatting action to the editor's current text and selection as one undo step. The Format palette
   * section and the selection toolbar share it. With an empty selection toggleWrap inserts an empty pair of markers.
   */
  function formatAction(kind) {
    const note = active();
    const ed = els.editor;
    if (!isEditable(note) || ed.hidden || isScript(note) !== SCRIPT_FORMATS.includes(kind)) return false;
    const { selectionStart: s, selectionEnd: t, value } = ed;
    const r = formatResult(kind, note, value, s, t);
    if (!r) return false;
    // A result that leaves the text as it is only moves the selection: nothing is edited, nothing is dispatched.
    if (value.slice(r.start, r.end) === r.insert) { setSel(r.selStart, r.selEnd); return true; }
    if (value.length - (r.end - r.start) + r.insert.length > store.LIMITS.body) { toast('The result would be too long for one note.', 'error'); return true; }
    replaceRange(r.start, r.end, r.insert, r.selStart, r.selEnd);
    return true;
  }

  /** The buttons for a note: [id, visible label, accessible name, extra class]. */
  function seltoolSpecs(note) {
    if (!isScript(note)) {
      return [['bold', 'B', 'Bold', 'seltool-bold'], ['italic', 'I', 'Italic', 'seltool-italic'], ['strike', 'S', 'Strikethrough', 'seltool-strike'],
        ['mark', 'Mark', 'Highlight', ''], ['code', 'Code', 'Code', ''], ['link', 'Link', 'Link', ''], ['quote', 'Quote', 'Quote', ''],
        ['list', 'List', 'Bulleted list', ''], ['decode', 'Decode…', 'Decode or encode', '']];
    }
    const lang = codeedit.language(note.lang);
    const specs = [];
    if (lang && (lang.lineComment || lang.blockComment)) specs.push(['comment', 'Comment', 'Comment or uncomment', '']);
    specs.push(['indent', 'Indent', 'Indent', ''], ['outdent', 'Outdent', 'Outdent', ''], ['decode', 'Decode…', 'Decode or encode', '']);
    return specs;
  }

  function seltoolsWanted(inToolbarOk) {
    const ed = els.editor;
    const focused = document.activeElement === ed || (inToolbarOk && els.seltools.contains(document.activeElement));
    return S.settings.selectionToolbar && isEditable(active()) && !ed.hidden && !selMouseDown && focused
      && ed.selectionStart !== ed.selectionEnd && !els.modal.open && !els.palette.open && !S.slash.open;
  }

  function hideSeltools() {
    clearTimeout(selTimer);
    const box = els.seltools;
    if (!box || (box.hidden && !box.firstChild)) return;
    box.hidden = true;
    box.replaceChildren();
    selBuiltFor = '';
    selSnapshot = null;
  }

  function scheduleSeltools(delay = 0) {
    clearTimeout(selTimer);
    selTimer = setTimeout(showSeltools, delay);
  }

  function showSeltools() {
    clearTimeout(selTimer);
    if (!seltoolsWanted(true)) { hideSeltools(); return; }
    const box = els.seltools;
    const note = active();
    const specs = seltoolSpecs(note);
    const built = specs.map((x) => x[0]).join();
    if (selBuiltFor !== built) {
      box.replaceChildren(...specs.map(([act, label, name, cls], i) => h('button', {
        type: 'button', class: `seltool ${cls}`.trim(), tabindex: i === 0 ? '0' : '-1', title: name, 'aria-label': name, 'data-act': act,
      }, label)));
      selBuiltFor = built;
    }
    box.hidden = false;
    placeSeltools();
  }

  function placeSeltools() {
    const box = els.seltools;
    if (narrow.matches) { // phones: a full-width row just above the status bar
      box.style.left = '';
      box.style.top = '';
      box.style.bottom = `${Math.max(0, Math.ceil(window.innerHeight - els.statusbar.getBoundingClientRect().top))}px`;
      return;
    }
    box.style.bottom = '';
    const ed = els.editor;
    const r = ed.getBoundingClientRect();
    const w = box.offsetWidth;
    const hgt = box.offsetHeight;
    const a = caret.coords(ed, ed.selectionStart);
    let top = r.top + a.top - hgt - 6;
    if (top < Math.max(8, r.top)) { // no room above the selection's start: go below its end
      const b = caret.coords(ed, ed.selectionEnd);
      top = r.top + b.top + b.height + 6;
    }
    top = Math.max(8, Math.min(top, window.innerHeight - hgt - 8));
    const left = Math.max(8, Math.min(r.left + a.left, window.innerWidth - w - 8));
    box.style.top = `${Math.floor(top)}px`;
    box.style.left = `${Math.floor(left)}px`;
  }

  function focusSeltoolButton(btns, i) {
    btns.forEach((b, k) => b.setAttribute('tabindex', k === i ? '0' : '-1'));
    btns[i].focus();
  }

  /** Alt+F10: focus moves to the first button. Returns false when the toolbar is not showing. */
  function focusSeltools() {
    const btns = [...els.seltools.querySelectorAll('button')];
    if (els.seltools.hidden || !btns.length) return false;
    selSnapshot = saveEditorSelection();
    focusSeltoolButton(btns, 0);
    return true;
  }

  /** Esc or Tab inside the toolbar: focus returns to the editor with its selection intact. */
  function leaveSeltools() {
    const sel = selSnapshot || saveEditorSelection();
    els.editor.focus();
    restoreEditorSelection(sel);
    selQuietUntil = performance.now() + 300;
    showSeltools();
  }

  function runSeltool(act, btn) {
    const ed = els.editor;
    const inToolbar = els.seltools.contains(document.activeElement);
    if (act === 'decode') {
      const text = ed.value.slice(ed.selectionStart, ed.selectionEnd);
      if (inToolbar) { const sel = saveEditorSelection(); ed.focus(); restoreEditorSelection(sel); } // a dialog gives focus back to the editor
      hideSeltools();
      openDecodeDialog(text);
      return;
    }
    formatAction(act);
    selQuietUntil = performance.now() + 300;
    if (inToolbar && btn.isConnected) btn.focus({ preventScroll: true });
    selSnapshot = saveEditorSelection();
    showSeltools(); // follow the new selection; the toolbar stays for the next button
  }

  function wireSeltools() {
    const ed = els.editor;
    const box = els.seltools;
    ed.addEventListener('mousedown', () => { selMouseDown = true; hideSeltools(); });
    document.addEventListener('mouseup', () => {
      if (!selMouseDown) return;
      selMouseDown = false;
      scheduleSeltools();
    });
    ed.addEventListener('keydown', (e) => { if (selKeyDown(e)) selKeyHeld = e.key.toLowerCase(); });
    ed.addEventListener('keyup', (e) => {
      if (selKeyHeld && e.key.toLowerCase() === selKeyHeld) { selKeyHeld = ''; scheduleSeltools(); return; }
      if (ed.selectionStart === ed.selectionEnd) hideSeltools();
    });
    ed.addEventListener('select', () => {
      if (selMouseDown || selKeyHeld || performance.now() - selProgAt < 300) return;
      scheduleSeltools(120);
    });
    ed.addEventListener('input', () => { if (!programmaticInsert) hideSeltools(); });
    ed.addEventListener('blur', (e) => {
      if (e.relatedTarget && box.contains(e.relatedTarget)) return;
      hideSeltools();
    });
    document.addEventListener('selectionchange', () => {
      if (!box.hidden && document.activeElement === ed && ed.selectionStart === ed.selectionEnd) hideSeltools();
    });
    window.addEventListener('resize', hideSeltools);

    box.addEventListener('mousedown', (e) => e.preventDefault()); // the editor keeps focus and its selection
    box.addEventListener('click', (e) => {
      const b = e.target instanceof Element ? e.target.closest('button[data-act]') : null;
      if (b) runSeltool(b.dataset.act, b);
    });
    box.addEventListener('focusout', (e) => {
      if (e.relatedTarget && (box.contains(e.relatedTarget) || e.relatedTarget === ed)) return;
      hideSeltools();
    });
    box.addEventListener('keydown', (e) => {
      const btns = [...box.querySelectorAll('button')];
      const i = btns.indexOf(document.activeElement);
      if (i < 0) return;
      const n = btns.length;
      let to = -1;
      if (e.key === 'ArrowRight') to = (i + 1) % n;
      else if (e.key === 'ArrowLeft') to = (i - 1 + n) % n;
      else if (e.key === 'Home') to = 0;
      else if (e.key === 'End') to = n - 1;
      if (to >= 0) { e.preventDefault(); focusSeltoolButton(btns, to); return; }
      if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); leaveSeltools(); }
    });
  }

  // ------------------------------------------------------------ slash menu

  function updateSlash() {
    if (isScript(active())) { closeSlash(); return; }
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
    hideSeltools();
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

  /** texttools expands every quick insert except the two CTF templates, which need ctf.js (loaded after it). */
  function expandSlashHere(name, ctx) {
    if (name === 'ctf') {
      const text = ctf.challengeTemplate({ name: 'Challenge name', event: '', category: 'misc', points: 0 });
      return { text, caret: text.indexOf('\n'), block: true }; // the caret ends the title line
    }
    if (name === 'writeup') {
      const text = ctf.writeupTemplate({ event: '', team: '', date: ctx.now });
      return { text, caret: text.indexOf('\n'), block: true };
    }
    return T.expandSlash(name, ctx);
  }

  function insertSlash(name) {
    const ex = expandSlashHere(name, slashCtx());
    if (ex) insertExpansion(ex, els.editor.selectionStart, els.editor.selectionEnd);
  }

  function acceptSlash(i) {
    const sl = S.slash;
    const cmd = sl.items[i];
    if (!cmd) return;
    const ex = expandSlashHere(cmd.name, slashCtx());
    const start = sl.start;
    const end = els.editor.selectionStart;
    closeSlash();
    const note = active();
    if (cmd.name === 'credentials' && note && !note.cipher) {
      // In a plain note the template is never inserted: drop the typed text and make the encrypted note.
      replaceRange(start, end, '');
      newCredentialsNote();
      return;
    }
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
    const markdownEditable = editable && !isScript(note);
    const C = (group, title, run, keys, when = true) => ({ group, title, run, keys, when });
    const tf = (title, key) => C('Transform', title, () => applyTransform(T.TRANSFORMS[key], title), null, editable);
    const sx = (title, key) => C('Security', title, () => applyTransform(secops.TRANSFORMS[key], title), null, editable);
    return [
      C('Note', 'New note', newNote, 'Alt N'),
      C('Note', 'Open today’s log', openDaily, 'Alt T'),
      C('Note', note && note.pinned ? 'Unpin note' : 'Pin note', togglePin, 'Alt P', !!note),
      C('Note', 'Duplicate note', duplicateNote, null, editable && !note.cipher),
      C('Note', 'Show version history', showHistory, null, editable),
      C('Note', 'Go to heading', () => setTimeout(() => openPalette('@'), 0), '@', editable && !isScript(note)),
      C('Note', 'Script mode: choose a language…', chooseLanguage, null, editable),
      C('Note', 'Back to a Markdown note', () => setNoteLang(active(), '', true), null, editable && isScript(note)),
      C('Note', 'Move to folder…', moveToFolder, null, !!note),
      C('Note', 'Remove from folder', removeFromFolder, null, !!(note && note.folder)),
      C('Note', 'Rename folder…', renameFolder, null, !!(note && note.folder)),
      C('Note', 'Undo delete', () => undoDelete(), null, !!S.pendingDelete),
      C('Note', 'Delete note', () => deleteNote(), null, !!note),
      C('File', 'Save', saveCommand, 'Ctrl S', platform.isDesktop && !!note),
      C('File', 'Save as file…', () => saveAsFileFor(active()), 'Ctrl Shift S', platform.isDesktop && !!note),
      C('File', 'Open file…', openFileCommand, 'Ctrl O', platform.isDesktop),
      C('File', 'Show file in folder', revealActive, null, platform.isDesktop && !!(note && note.file)),
      C('File', 'Unlink from file', unlinkActive, null, platform.isDesktop && !!(note && note.file)),
      C('File', 'Export note as Markdown', exportNote, null, editable),
      C('File', 'Export note as file', exportNoteFile, null, editable && isScript(note) && !platform.isDesktop),
      C('File', 'Export note as PDF', exportPdf, null, editable),
      C('File', 'Export backup of all notes', exportBackup),
      C('File', 'Export encrypted backup of all notes', exportEncryptedBackup),
      C('File', 'Import a file', () => els.fileInput.click()),
      C('Edit', 'Find and replace', () => openFind(), 'Ctrl F', editable),
      C('Edit', 'Go to line…', gotoLineDialog, 'Ctrl G', editable),
      C('Edit', 'Comment or uncomment lines', () => applyLineEdit('comment'), 'Ctrl /', editable && isScript(note)),
      C('Edit', 'Duplicate line', () => applyLineEdit('duplicate'), 'Ctrl Shift D', editable),
      C('Edit', 'Move line up', () => applyLineEdit('move', -1), 'Alt ↑', editable),
      C('Edit', 'Move line down', () => applyLineEdit('move', 1), 'Alt ↓', editable),
      C('Format', 'Bold', () => formatAction('bold'), null, markdownEditable),
      C('Format', 'Italic', () => formatAction('italic'), null, markdownEditable),
      C('Format', 'Strikethrough', () => formatAction('strike'), null, markdownEditable),
      C('Format', 'Highlight', () => formatAction('mark'), null, markdownEditable),
      C('Format', 'Code', () => formatAction('code'), null, markdownEditable),
      C('Format', 'Link', () => formatAction('link'), null, markdownEditable),
      C('Format', 'Quote', () => formatAction('quote'), null, markdownEditable),
      C('Format', 'Bulleted list', () => formatAction('list'), null, markdownEditable),
      C('View', 'Layout: Write only', () => setView('edit'), null, S.settings.view !== 'edit'),
      C('View', 'Layout: Split', () => setView('split'), null, S.settings.view !== 'split'),
      C('View', 'Layout: Read only', () => setView('preview'), null, S.settings.view !== 'preview'),
      C('View', 'Show or hide note list', toggleSidebar, 'Ctrl B'),
      C('View', 'Zen mode', toggleZen, 'Alt Z'),
      ...store.THEMES.filter((t) => t !== S.settings.theme).map((t) => C('Theme', `Theme: ${THEME_NAMES[t]}`, () => setTheme(t))),
      C('Settings', S.settings.crt ? 'Turn off CRT effect' : 'Turn on CRT effect', toggleCrt),
      C('Settings', S.settings.sound ? 'Turn off typing sounds' : 'Turn on typing sounds', toggleSound),
      C('Settings', S.settings.arrows ? 'Turn off arrow replacement' : 'Turn on arrow replacement', toggleArrows),
      C('Settings', lineNumbersTitle(), cycleLineNumbers),
      C('Settings', S.settings.syntaxColors ? 'Turn off syntax colouring' : 'Turn on syntax colouring', toggleSyntaxColors),
      C('Settings', S.settings.boot ? 'Skip the boot screen on start' : 'Show the boot screen on start', toggleBoot),
      C('Settings', S.settings.selectionToolbar ? 'Turn off the selection toolbar' : 'Turn on the selection toolbar', toggleSelectionToolbar),
      C('View', 'Keyboard shortcuts', showShortcuts, 'F1'),
      C('View', 'About CyberPad', showAbout, null, platform.isDesktop),
      C('Insert', 'Insert date', () => insertText(T.ymd(new Date())), '/date', editable),
      C('Insert', 'Insert time', () => insertText(T.hm(new Date())), '/time', editable),
      C('Insert', 'Insert table', () => insertText(T.expandSlash('table', {}).text), '/table', editable),
      C('Templates', 'Insert pentest finding', () => insertSlash('finding'), '/finding', editable),
      C('Templates', 'Insert IOC table', () => insertSlash('ioc'), '/ioc', editable),
      C('Templates', 'Insert incident timeline (UTC)', () => insertSlash('timeline'), '/timeline', editable),
      C('Templates', 'Insert UTC timestamp', () => insertSlash('utc'), '/utc', editable),
      C('Templates', 'New encrypted credentials note', newCredentialsNote, '/credentials'),
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
      C('CTF', 'New CTF challenge…', newChallengeDialog),
      C('CTF', 'Insert challenge template', () => insertSlash('ctf'), '/ctf', markdownEditable),
      C('CTF', 'Insert writeup template', () => insertSlash('writeup'), '/writeup', markdownEditable),
      C('CTF', 'Decode or encode…', () => openDecodeDialog()),
      C('CTF', 'Try common decodings', tryDecodingsCommand, null, editable),
      C('CTF', 'Find flags in this note', findFlagsHere, null, editable),
      C('CTF', 'Find flags in all notes', findFlagsEverywhere),
      C('CTF', 'Flag formats…', flagFormatsDialog),
      C('CTF', 'Build CTF report from this folder', buildReportCommand, null, !!(note && note.folder)),
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
      if (!isEditable(note) || isScript(note)) return [];
      const hq = q.slice(1).trim();
      return T.headings(els.editor.value)
        .map((hd) => ({ group: 'Headings', title: `${'  '.repeat(hd.level - 1)}${hd.text}`, keys: `Ln ${hd.line + 1}`, run: () => gotoLine(hd.line), score: hq ? T.fuzzyScore(hq, hd.text) : 1 }))
        .filter((i) => i.score > 0);
    }
    const cmds = commandList();
    const notes = sortedNotes().map((n) => ({ group: 'Notes', title: titleOf(n), keys: T.relativeTime(n.updated), run: () => openNote(n.id), id: n.id }));
    if (!q) {
      const browse = [...notes.filter((n) => n.id !== S.activeId).slice(0, 5).map((n) => ({ ...n, group: 'Recent notes' })), ...cmds];
      return T.paletteSections(browse).flatMap((s) => s.items);
    }
    return [...cmds, ...notes]
      .map((i) => ({ ...i, score: T.paletteScore(q, i) }))
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
    setSel(sel.start, sel.end, sel.dir);
    els.editor.scrollTop = sel.top;
  }

  function openPalette(prefill = '') {
    closeSlash();
    hideSeltools();
    if (els.modal.open) return;
    if (!els.palette.open) {
      S.paletteSel = saveEditorSelection();
      els.palette.showModal();
    }
    els.paletteInput.value = prefill;
    S.pal.idx = 0;
    S.pal.section = null;
    renderPalette();
    els.paletteInput.focus();
    els.paletteInput.setSelectionRange(prefill.length, prefill.length);
  }

  // The mode comes from the input on every render: '@' jumps to a heading,
  // other text filters, and an empty (or spaces-only) box browses by section.
  function paletteMode(q = els.paletteInput.value) {
    const t = q.trim();
    if (t.startsWith('@')) return 'heading';
    return t ? 'filter' : 'browse';
  }

  // Browse items are flat and ordered by section, so each section is one run.
  function paletteRanges(items) {
    const ranges = [];
    items.forEach((item, i) => {
      const name = T.sectionOf(item.group);
      const last = ranges[ranges.length - 1];
      if (last && last.name === name) last.end = i + 1;
      else ranges.push({ name, start: i, end: i + 1 });
    });
    return ranges;
  }

  function jumpPaletteSection(step) {
    const ranges = paletteRanges(S.pal.items);
    if (!ranges.length) return;
    const cur = ranges.findIndex((r) => S.pal.idx >= r.start && S.pal.idx < r.end);
    S.pal.idx = ranges[(cur + step + ranges.length) % ranges.length].start;
    renderPalette();
  }

  function renderPalette() {
    const q = els.paletteInput.value;
    const mode = paletteMode(q);
    const items = paletteItems(q);
    S.pal.items = items;
    S.pal.idx = Math.min(S.pal.idx, Math.max(0, items.length - 1));
    const browse = mode === 'browse';
    const ranges = browse ? paletteRanges(items) : [];
    const current = ranges.find((r) => S.pal.idx >= r.start && S.pal.idx < r.end) || null;
    const shown = current ? items.slice(current.start, current.end) : items;
    const offset = current ? current.start : 0;
    const frag = document.createDocumentFragment();
    let group = null;
    shown.forEach((item, k) => {
      const i = offset + k;
      if (mode === 'heading' && item.group !== group) {
        group = item.group;
        frag.append(h('li', { class: 'palette-group', role: 'presentation' }, group));
      }
      frag.append(h('li', {
        class: 'palette-item', role: 'option', id: `pal-${i}`, 'data-idx': i, 'aria-selected': String(i === S.pal.idx),
      },
      h('span', { class: 'label' }, item.title),
      mode === 'filter' ? h('span', { class: 'hint' }, T.sectionOf(item.group)) : null,
      item.keys ? h('kbd', null, item.keys) : null));
    });
    if (!items.length) {
      frag.append(h('li', { class: 'palette-empty' }, q.trim().startsWith('@') ? 'This note has no headings. Start a line with # to make one.' : 'Nothing matches. Try another word.'));
    }
    els.paletteList.replaceChildren(frag);
    els.paletteInput.setAttribute('aria-activedescendant', items.length ? `pal-${S.pal.idx}` : '');

    els.paletteSections.hidden = !browse;
    if (browse) {
      els.paletteSections.replaceChildren(...ranges.map((r) => h('button', {
        type: 'button', tabindex: '-1', class: 'palette-section', 'aria-pressed': String(r === current), 'data-start': r.start,
      },
      r.name,
      r.name === 'Recent notes' ? null : h('span', { class: 'count' }, String(r.end - r.start)))));
    } else {
      els.paletteSections.replaceChildren();
    }

    const name = current ? current.name : null;
    if (name !== S.pal.section) {
      S.pal.section = name;
      const n = current ? current.end - current.start : 0;
      const noun = name === 'Recent notes' ? (n === 1 ? 'note' : 'notes') : (n === 1 ? 'command' : 'commands');
      els.paletteStatus.textContent = current ? `${name}, ${n} ${noun}` : '';
    }

    els.paletteFoot.replaceChildren(...['↑ ↓ move', browse ? 'Tab next section' : null, 'Enter run', 'Esc close']
      .filter(Boolean).map((t) => h('span', null, t)));

    const sel = els.paletteList.querySelector('[aria-selected="true"]');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
    if (browse) {
      const pressed = els.paletteSections.querySelector('[aria-pressed="true"]');
      if (pressed) pressed.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
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
      addNote(secops.iocsToMarkdown(iocs, { defanged, source: titleOf(note), when: `${stamp.slice(0, 16).replace('T', ' ')} UTC` }), undefined, active() ? active().folder : '');
    }
  }

  // CTF helpers -----------------------------------------------------------
  //
  // Decoded text and note text reach the page only as text nodes or a form control's value, never as markup.
  // A dialog that holds text from an encrypted note is marked sensitive (see showDialog), so a lock closes and empties it.

  const CTF_EMPTY = 'Enter some text to convert.';
  const CTF_TOO_LONG = 'That text is too long to convert (limit 100,000 characters).';
  const CTF_FLAG_CAP = 200;
  const CTF_SLICE = 20; // notes searched per timer tick
  const FLAG_VIA = { plain: 'plain text', reversed: 'reversed', base64: 'inside Base64', base32: 'inside Base32', hex: 'inside hex' };

  /** What a dialog may change in the editor later: the note, its whole text and the range, as they were when it opened. */
  function ctfTarget() {
    const note = active();
    const ed = els.editor;
    if (!isEditable(note) || ed.hidden) return null;
    return { id: note.id, value: ed.value, start: ed.selectionStart, end: ed.selectionEnd, text: ed.value.slice(ed.selectionStart, ed.selectionEnd) };
  }

  /** Replace the saved selection, or add a line below the one it ended on. Refuses when the note or its text is not what it was. */
  function applyCtfOutput(target, action, output) {
    const note = active();
    const ed = els.editor;
    const done = action === 'replace' ? 'replaced' : 'inserted';
    if (!target || !note || note.id !== target.id || !isEditable(note) || ed.hidden || ed.value !== target.value) {
      toast(`The note changed, so nothing was ${done}.`, 'error');
      return;
    }
    const value = target.value;
    if (action === 'replace') {
      if (target.start === target.end) return;
      if (value.length - (target.end - target.start) + output.length > store.LIMITS.body) { toast('The result would be too long for one note.', 'error'); return; }
      replaceRange(target.start, target.end, output, target.start, target.start + output.length);
      return;
    }
    // A selection that ends right after a line break belongs to the line before it.
    const at = target.end > target.start && value[target.end - 1] === '\n' ? target.end - 1 : target.end;
    const { end } = lineBounds(value, at);
    if (value.length + 1 + output.length > store.LIMITS.body) { toast('The result would be too long for one note.', 'error'); return; }
    replaceRange(end, end, `\n${output}`, end + 1 + output.length);
  }

  function ctfCopyRow(label, value, fromEncrypted = false) {
    const btn = h('button', { type: 'button', class: 'chip', 'aria-label': `Copy ${label}` }, 'Copy');
    btn.addEventListener('click', () => copyText(value, fromEncrypted));
    return h('div', { class: 'result-row' }, h('span', { class: 'result-label' }, label), h('pre', { class: 'result-value' }, value), btn);
  }

  const codecName = (id) => { const c = ctf.CODECS.find((x) => x.id === id); return c ? c.name : id; };

  // Decode or encode… -----------------------------------------------------

  async function openDecodeDialog(selectionText) {
    void selectionText; // the editor's own selection is read (and kept) by ctfTarget
    const note = active();
    const target = ctfTarget();
    const initial = target ? target.text : '';
    const input = h('textarea', { id: 'decode-input', maxlength: ctf.LIMITS.input, autocomplete: 'off' });
    input.rows = 5;
    input.spellcheck = false;
    input.value = initial;
    const out = h('textarea', { id: 'decode-output', class: 'ctf-out' });
    out.rows = 5;
    out.readOnly = true;
    out.spellcheck = false;
    const status = h('p', { role: 'status', class: 'ctf-status' });
    const results = h('div', { class: 'result-list ctf-results', hidden: true });
    const outBox = h('label', { class: 'field' }, h('span', null, 'Output'), out);

    const st = { codec: ctf.CODECS[0], dir: 'decode', view: 'output' };
    const values = {}; // codec id -> { param id -> text typed }
    let overflow = false;
    let closed = false;
    let timer = 0;
    let output = '';

    const codecSelect = h('select', { id: 'decode-codec' }, ctf.CODECS.map((c) => h('option', { value: c.id }, `${c.group}: ${c.name}`)));
    const dirButtons = {};
    for (const [dir, label] of [['decode', 'Decode'], ['encode', 'Encode']]) {
      dirButtons[dir] = h('button', { type: 'button', class: 'chip', 'aria-pressed': 'false' }, label);
      dirButtons[dir].addEventListener('click', () => { st.dir = dir; refresh(); });
    }
    const dirRow = h('div', { class: 'decode-dir', role: 'group', 'aria-label': 'Direction' }, dirButtons.decode, dirButtons.encode);
    const codecRow = h('div', { class: 'decode-row' }, h('label', { class: 'field' }, h('span', null, 'Codec'), codecSelect), dirRow);
    const paramBox = h('div', { class: 'decode-params' });

    const paramsFor = (codec) => {
      const vals = values[codec.id] || {};
      const p = {};
      for (const def of codec.params || []) {
        const raw = vals[def.id] === undefined ? String(def.default) : vals[def.id];
        // A number the module checks itself: anything that is not a whole number becomes NaN and gets its message.
        p[def.id] = def.type === 'int' ? (/^-?\d{1,9}$/.test(raw.trim()) ? Number(raw.trim()) : NaN) : raw;
      }
      return p;
    };

    const buildParams = () => {
      const fields = (st.codec.params || []).map((def) => {
        const saved = (values[st.codec.id] || {})[def.id];
        const text = saved === undefined ? String(def.default) : saved;
        let control;
        if (def.type === 'choice') {
          control = h('select', { id: `decode-p-${def.id}` }, def.choices.map((c) => h('option', { value: c }, c === 'hex' ? 'Hex' : 'Text')));
          control.value = text;
        } else {
          control = h('input', { id: `decode-p-${def.id}`, type: def.type === 'int' ? 'number' : 'text', autocomplete: 'off' });
          if (def.type === 'int') {
            // Fixed numbers from the codec table, set as properties: SAFE_ATTR does not list min, max or step.
            control.min = String(def.min);
            control.max = String(def.max);
            control.step = '1';
            control.inputMode = 'numeric';
          } else {
            control.maxLength = def.max;
            control.spellcheck = false;
          }
          control.value = text;
        }
        const remember = () => {
          const v = values[st.codec.id] || (values[st.codec.id] = {});
          v[def.id] = control.value;
          schedule();
        };
        control.addEventListener(def.type === 'choice' ? 'change' : 'input', remember);
        return h('label', { class: 'field' }, h('span', null, def.label), control);
      });
      paramBox.replaceChildren(...fields);
      paramBox.hidden = !fields.length || st.view !== 'output';
    };

    const toolBtn = (label, onClick) => {
      const b = h('button', { type: 'button', class: 'btn' }, label);
      b.addEventListener('click', onClick);
      return b;
    };
    const copyBtn = toolBtn('Copy', () => { if (output) copyText(output); });
    const replaceBtn = target && target.text ? toolBtn('Replace selection', () => { if (output && finishCurrentDialog) finishCurrentDialog({ action: 'replace', output }); }) : null;
    const insertBtn = target ? toolBtn('Insert below', () => { if (output && finishCurrentDialog) finishCurrentDialog({ action: 'insert', output }); }) : null;
    const bruteBtns = {};
    for (const [view, label] of [['caesar', 'Caesar brute force'], ['xor', 'XOR brute force']]) {
      bruteBtns[view] = h('button', { type: 'button', class: 'btn', 'aria-pressed': 'false' }, label);
      bruteBtns[view].addEventListener('click', () => { st.view = st.view === view ? 'output' : view; refresh(); });
    }
    const tools = h('div', { class: 'decode-tools' }, copyBtn, replaceBtn, insertBtn, bruteBtns.caesar, bruteBtns.xor);

    function renderBrute(text) {
      let rows = [];
      let message = '';
      if (text === '') message = CTF_EMPTY;
      else if (text.length > ctf.LIMITS.input) message = CTF_TOO_LONG;
      else if (st.view === 'caesar') rows = ctf.caesarBruteForce(text).map((r) => [`Shift ${r.shift}`, r.output]);
      else rows = ctf.xorBruteForce(text).map((r) => [`Key 0x${r.keyHex}`, r.output]);
      results.replaceChildren(...rows.slice(0, ctf.LIMITS.results).map(([label, value]) => ctfCopyRow(label, value)));
      status.textContent = message || (rows.length ? '' : 'No results.');
    }

    function compute() {
      timer = 0;
      if (closed) return;
      const text = input.value;
      if (st.view !== 'output') { output = ''; renderBrute(text); updateTools(); return; }
      const fn = st.dir === 'decode' ? st.codec.decode : st.codec.encode;
      const res = fn ? fn(text, paramsFor(st.codec)) : { ok: false, message: 'This codec does not work that way.' };
      if (res.ok) {
        output = res.output;
        out.value = output;
        status.textContent = overflow ? `${CTF_TOO_LONG} The extra text was cut off.` : '';
      } else {
        output = '';
        out.value = '';
        status.textContent = res.message;
      }
      updateTools();
    }

    function schedule() {
      clearTimeout(timer);
      timer = setTimeout(compute, 150);
    }

    function updateTools() {
      const ready = st.view === 'output' && output !== '';
      copyBtn.disabled = !ready;
      if (replaceBtn) replaceBtn.disabled = !ready;
      if (insertBtn) insertBtn.disabled = !ready;
    }

    // Everything that depends on the codec, direction or view; then a fresh result.
    function refresh() {
      const c = st.codec;
      if (!c[st.dir]) st.dir = st.dir === 'decode' ? 'encode' : 'decode';
      for (const dir of ['decode', 'encode']) {
        dirButtons[dir].setAttribute('aria-pressed', String(st.dir === dir));
        dirButtons[dir].disabled = !c[dir];
      }
      for (const view of ['caesar', 'xor']) bruteBtns[view].setAttribute('aria-pressed', String(st.view === view));
      const brute = st.view !== 'output';
      outBox.hidden = brute;
      results.hidden = !brute;
      codecRow.hidden = brute;
      buildParams();
      clearTimeout(timer);
      compute();
    }

    codecSelect.addEventListener('change', () => {
      const c = ctf.CODECS.find((x) => x.id === codecSelect.value);
      if (!c) return;
      st.codec = c;
      refresh();
    });
    input.addEventListener('paste', (e) => {
      const pasted = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
      if (input.value.length - (input.selectionEnd - input.selectionStart) + pasted.length > ctf.LIMITS.input) overflow = true;
    });
    input.addEventListener('input', () => {
      if (input.value.length < ctf.LIMITS.input) overflow = false;
      schedule();
    });

    refresh();
    const res = await showDialog({
      title: 'Decode or encode',
      className: 'wide ctf',
      initialFocus: '#decode-input',
      sensitive: !!(note && note.cipher),
      body: [
        h('label', { class: 'field' }, h('span', null, 'Input'), input),
        codecRow, paramBox, outBox, results, status, tools,
      ],
      actions: [{ label: 'Close', value: null, className: 'btn-primary' }],
      onSubmit: () => undefined, // Enter in a field never closes this dialog
    });
    closed = true;
    clearTimeout(timer);
    if (res && (res.action === 'replace' || res.action === 'insert') && typeof res.output === 'string') applyCtfOutput(target, res.action, res.output);
  }

  // Try common decodings ---------------------------------------------------

  async function tryDecodingsCommand() {
    const target = ctfTarget();
    if (!target) return;
    let text = target.text;
    if (text === '') {
      const { start, end } = lineBounds(target.value, target.start);
      text = target.value.slice(start, end).trim();
    }
    if (!text.trim()) { toast('Select some text, or put the cursor on the line to decode.'); return; }
    if (text.length > ctf.LIMITS.input) { toast(CTF_TOO_LONG, 'error'); return; }
    const note = active();
    const status = h('p', { role: 'status', class: 'ctf-status' }, 'Decoding…');
    const list = h('div', { class: 'result-list ctf-results' });
    let closed = false;
    const pending = showDialog({
      title: 'Common decodings',
      className: 'wide ctf',
      sensitive: !!note.cipher,
      body: [status, list],
      actions: [{ label: 'Close', value: null, className: 'btn-primary' }],
    });
    // Let the dialog paint first: the search is bounded but can take a moment.
    setTimeout(() => {
      if (closed) return;
      let found = [];
      try {
        found = ctf.tryDecodings(text, S.settings.flagPrefixes);
      } catch (err) {
        console.error('decoding failed');
      }
      if (closed) return;
      const rows = found.slice(0, ctf.LIMITS.results);
      if (!rows.length) { status.textContent = 'Nothing readable came out of the common decodings.'; return; }
      status.textContent = `${plural(rows.length, 'result')}, best first.`;
      list.replaceChildren(...rows.map((r) => {
        const way = r.path.map(codecName).join(' → ') + (r.detail ? ` (${r.detail})` : '');
        const btns = h('div', { class: 'ctf-btns' });
        const add = (label, onClick) => { const b = h('button', { type: 'button', class: 'chip' }, label); b.addEventListener('click', onClick); btns.append(b); };
        add('Copy', () => copyText(r.output));
        if (target.text) add('Replace selection', () => { if (finishCurrentDialog) finishCurrentDialog({ action: 'replace', output: r.output }); });
        add('Insert below', () => { if (finishCurrentDialog) finishCurrentDialog({ action: 'insert', output: r.output }); });
        return h('div', { class: 'result-row' },
          h('span', { class: 'result-label' }, `${way}, ${Math.round(r.score * 100)}%`),
          h('pre', { class: 'result-value' }, r.output), btns);
      }));
    }, 0);
    const res = await pending;
    closed = true;
    if (res && (res.action === 'replace' || res.action === 'insert') && typeof res.output === 'string') applyCtfOutput(target, res.action, res.output);
  }

  // Flags ------------------------------------------------------------------

  function flagRow(f, id, fromEncrypted) {
    const line = h('button', { type: 'button', class: 'chip' }, `Line ${f.line}`);
    line.addEventListener('click', () => { if (finishCurrentDialog) finishCurrentDialog({ id, line: f.line }); });
    const copy = h('button', { type: 'button', class: 'chip', 'aria-label': `Copy flag on line ${f.line}` }, 'Copy');
    copy.addEventListener('click', () => copyText(f.flag, fromEncrypted));
    return h('div', { class: 'flag-row' }, h('code', { class: 'flag-code' }, f.flag), h('span', { class: 'flag-via' }, FLAG_VIA[f.via] || f.via), line, copy);
  }

  const NO_FLAGS = 'No flags found. Check Flag formats… if your CTF uses another prefix.';

  async function findFlagsHere() {
    const note = active();
    if (!isEditable(note) || els.editor.hidden) return;
    const body = bodyOf(note);
    if (typeof body !== 'string') return;
    const flags = ctf.findFlags(body, S.settings.flagPrefixes);
    const res = await showDialog({
      title: 'Flags in this note',
      className: 'wide ctf',
      sensitive: !!note.cipher,
      body: [
        h('p', { role: 'status', class: 'ctf-status' }, flags.length ? `${plural(flags.length, 'flag')} found` : NO_FLAGS),
        h('div', { class: 'result-list ctf-results' }, flags.map((f) => flagRow(f, note.id, false))),
      ],
      actions: [{ label: 'Close', value: null, className: 'btn-primary' }],
    });
    if (res && typeof res.line === 'number' && active() === note && isEditable(note)) gotoLine(res.line - 1);
  }

  async function findFlagsEverywhere() {
    const prefixes = S.settings.flagPrefixes;
    const all = sortedNotes();
    const skipped = all.filter(isLocked).length;
    const todo = all.filter((n) => !isLocked(n));
    const status = h('p', { role: 'status', class: 'ctf-status' }, 'Searching…');
    const groups = h('div', { class: 'result-list ctf-results' });
    const foot = h('p', { class: 'ctf-status' });
    let closed = false;
    // It lists titles and flags from unlocked encrypted notes: any lock closes and empties it.
    const pending = showDialog({
      title: 'Flags in all notes',
      className: 'wide ctf',
      sensitive: true,
      body: [status, groups, foot],
      actions: [{ label: 'Close', value: null, className: 'btn-primary' }],
    });
    let i = 0;
    let total = 0;
    let noteCount = 0;
    let capped = false;
    const finishSearch = () => {
      status.textContent = total ? `${plural(total, 'flag')} found in ${plural(noteCount, 'note')}` : NO_FLAGS;
      const bits = [];
      if (capped) bits.push(`Showing the first ${CTF_FLAG_CAP} flags.`);
      if (skipped) bits.push(`${skipped} locked note${skipped === 1 ? ' was' : 's were'} not searched.`);
      foot.textContent = bits.join(' ');
    };
    const step = () => {
      if (closed) return;
      const stop = Math.min(todo.length, i + CTF_SLICE);
      while (i < stop && !capped) {
        const n = todo[i++];
        const body = bodyOf(n);
        if (typeof body !== 'string' || body === '') continue;
        const flags = ctf.findFlags(body, prefixes);
        if (!flags.length) continue;
        const shown = flags.slice(0, CTF_FLAG_CAP - total);
        total += shown.length;
        noteCount++;
        if (total >= CTF_FLAG_CAP && (flags.length > shown.length || i < todo.length)) capped = true;
        const open = h('button', { type: 'button', class: 'chip flag-note' }, titleOf(n));
        open.addEventListener('click', () => { if (finishCurrentDialog) finishCurrentDialog({ id: n.id, line: 0 }); });
        groups.append(h('div', { class: 'flag-group' }, open, shown.map((f) => flagRow(f, n.id, !!n.cipher))));
      }
      if (i < todo.length && !capped) setTimeout(step, 0);
      else finishSearch();
    };
    setTimeout(step, 0);
    const res = await pending;
    closed = true;
    if (res && typeof res.id === 'string' && noteById(res.id)) {
      openNote(res.id);
      const n = active();
      if (res.line > 0 && n && n.id === res.id && isEditable(n)) gotoLine(res.line - 1);
    }
  }

  // Flag formats… ----------------------------------------------------------

  const PREFIX_RE = /^[A-Za-z0-9_]{1,20}$/;

  async function flagFormatsDialog() {
    const area = h('textarea', { id: 'flag-prefixes', maxlength: 1000, autocomplete: 'off' });
    area.rows = 8;
    area.spellcheck = false;
    area.value = S.settings.flagPrefixes.join('\n');
    const err = h('p', { class: 'form-error', role: 'alert' });
    const res = await showDialog({
      title: 'Flag formats',
      initialFocus: '#flag-prefixes',
      body: [
        h('label', { class: 'field' }, h('span', null, 'Flag prefixes, one per line'), area),
        h('p', null, 'A flag looks like prefix{...}. Letters, digits and underscores, up to 20 characters each, at most 30 prefixes.'),
        err,
      ],
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Reset to defaults', value: 'reset' },
        { label: 'Save', submit: true, className: 'btn-primary' },
      ],
      onSubmit: () => {
        const list = area.value.split(/\r\n|\r|\n/).map((l) => l.trim()).filter((l) => l !== '');
        if (list.some((l) => !PREFIX_RE.test(l))) { err.textContent = 'Each prefix can only contain letters, digits and underscores, up to 20 characters.'; area.focus(); return undefined; }
        if (list.length > ctf.LIMITS.prefixes) { err.textContent = 'Keep it to 30 prefixes at most.'; area.focus(); return undefined; }
        return { list };
      },
    });
    if (res === 'reset') {
      S.settings.flagPrefixes = ctf.DEFAULT_PREFIXES.slice();
      saveSettings();
      toast('Flag formats reset to defaults.');
    } else if (res && Array.isArray(res.list)) {
      S.settings.flagPrefixes = ctf.validatePrefixes(res.list);
      saveSettings();
      toast('Flag formats saved.');
    }
  }

  // New CTF challenge… -----------------------------------------------------

  async function newChallengeDialog() {
    const open = active();
    const event = h('input', { type: 'text', id: 'ctf-event', maxlength: store.LIMITS.folderName, autocomplete: 'off', value: open ? open.folder : '' });
    const name = h('input', { type: 'text', id: 'ctf-name', maxlength: 120, autocomplete: 'off' });
    const category = h('select', { id: 'ctf-category' }, ctf.CATEGORIES.map((c) => h('option', { value: c }, c)));
    const points = h('input', { type: 'number', id: 'ctf-points', autocomplete: 'off', value: '100' });
    // Fixed values, set as properties: SAFE_ATTR does not list min, max, step or inputmode.
    points.min = '0';
    points.max = '100000';
    points.step = '1';
    points.inputMode = 'numeric';
    const err = h('p', { class: 'form-error', role: 'alert' });
    const pending = showDialog({
      title: 'New CTF challenge',
      initialFocus: '#ctf-event',
      body: [
        h('label', { class: 'field' }, h('span', null, 'Event'), event),
        h('label', { class: 'field' }, h('span', null, 'Challenge name'), name),
        h('label', { class: 'field' }, h('span', null, 'Category'), category),
        h('label', { class: 'field' }, h('span', null, 'Points'), points),
        err,
      ],
      actions: [{ label: 'Cancel', value: null }, { label: 'Create challenge', submit: true, className: 'btn-primary' }],
      onSubmit: () => {
        const folder = store.cleanFolder(event.value);
        const folders = store.folderList(S.notes);
        if (!folder) { err.textContent = FOLDER_NAME_MSG; event.focus(); return undefined; }
        if (!folders.some((f) => f.name === folder) && folders.length >= store.LIMITS.folders) { err.textContent = FOLDER_LIMIT_MSG; event.focus(); return undefined; }
        const title = name.value.trim();
        if (!title) { err.textContent = 'Enter a challenge name.'; name.focus(); return undefined; }
        const raw = points.value.trim();
        const pts = /^\d{1,6}$/.test(raw) ? Number(raw) : NaN;
        if (!(pts >= 0 && pts <= 100000)) { err.textContent = 'Enter the points as a whole number from 0 to 100000.'; points.focus(); return undefined; }
        const cat = ctf.CATEGORIES.includes(category.value) ? category.value : 'misc';
        return { folder, title, cat, pts };
      },
    });
    // The page checks the numbers itself and shows its own messages; the browser's built-in bubble would replace them.
    if (points.form) points.form.noValidate = true;
    const res = await pending;
    if (!res) return;
    const created = addNote(ctf.challengeTemplate({ name: res.title, event: res.folder, category: res.cat, points: res.pts }), undefined, res.folder);
    if (created) toast(`Challenge note created in ${res.folder}.`);
  }

  // Build CTF report from this folder --------------------------------------

  function buildReportCommand() {
    const open = active();
    if (!open || !open.folder) return;
    const folder = open.folder;
    // An encrypted note, locked or not, is passed as a bare marker: its title, text and language are never read.
    const notes = sortedNotes().filter((n) => n.folder === folder).map((n) => (n.cipher
      ? { encrypted: true }
      : { title: titleOf(n), body: bodyOf(n), lang: n.lang || '', encrypted: false }));
    const rep = ctf.buildReport({ folder, notes, now: new Date() });
    const created = addNote(rep.body, undefined, folder);
    if (!created) return;
    const left = rep.leftOut.length;
    toast(`Report created with ${plural(rep.included, 'note')}.`
      + (rep.skippedEncrypted > 0 ? ` ${rep.skippedEncrypted} encrypted note${rep.skippedEncrypted === 1 ? ' was' : 's were'} left out.` : '')
      + (left > 0 ? ` ${left} note${left === 1 ? '' : 's'} did not fit.` : ''));
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

  function toggleArrows() {
    S.settings.arrows = !S.settings.arrows;
    saveSettings();
    toast(S.settings.arrows ? 'Arrow replacement on.' : 'Arrow replacement off.');
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
  let dialogSensitive = false; // the open dialog may show text from an encrypted note: any lock closes and empties it

  function showDialog({ title, body = [], actions, className = '', initialFocus, onSubmit, sensitive = false }) {
    return new Promise((resolve) => {
      hideSeltools();
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
        if (finishCurrentDialog === finish) { finishCurrentDialog = null; dialogSensitive = false; }
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
      dialogSensitive = !!sensitive;
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
      ['Ctrl /', 'Comment or uncomment lines (script notes)'], ['Ctrl Shift D', 'Duplicate the line or selected lines'],
      ['Alt ↑ / Alt ↓', 'Move the line or selected lines'], ['Ctrl G', 'Go to line (next match while the find bar is open)'],
      ['Paste a URL on a selection', 'Make a link'], ['Alt F10', 'Format toolbar (when text is selected)'],
      ['Delete', 'Delete the focused note in the list'], ['Ctrl Z', 'Undo the last delete (in the note list)'],
    ];
    if (platform.isDesktop) {
      rows.splice(rows.findIndex(([k]) => k === 'Ctrl S'), 1,
        ['Ctrl S', 'Save now, and to the linked file (or choose a file)'], ['Ctrl Shift S', 'Save as file'], ['Ctrl O', 'Open file']);
    }
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
      let message = `Export failed (${SAVE_REASON[reason] || 'unexpected error'}).`;
      if (reason === 'too-large') message = 'That file is over 64 MB, so it could not be exported.';
      // The host's reason is a short, safe sentence (never note content), shown as text.
      else if (err instanceof PlatformError && err.userFacing) message = `Not saved: ${err.message}`;
      toast(message, 'error');
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
    let text = bodyOf(note);
    if (isScript(note)) {
      // A fence longer than any run of backticks in the code cannot be closed by the code itself.
      let longest = 0;
      for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
      const fence = '`'.repeat(Math.max(3, longest + 1));
      text = `${fence}${note.lang}\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}\n`;
    }
    const saved = await exportOut('note', `${T.slugify(titleOf(note))}.md`, text, 'text/markdown;charset=utf-8');
    if (saved) toast(`Saved ${saved}.`);
  }

  /** Browser version: downloads a script note's text as it is, with the extension of its language (.txt for plain text). */
  async function exportNoteFile() {
    const note = active();
    if (!isEditable(note) || !isScript(note)) return;
    if (note.cipher) {
      const ok = await confirmDialog('Export without encryption?', 'The exported file will contain the note as plain text.', 'Export plain text', true);
      if (!ok) return;
      if (!isEditable(note)) { toast('The note was locked. Unlock it and try again.', 'error'); return; }
    }
    // An encrypted note's own extension would be .cpnote; this file is plain text, so it gets its language's extension.
    const ext = store.defaultExtFor({ lang: note.lang, cipher: null });
    const saved = await exportOut('note', `${T.slugify(titleOf(note)) || 'note'}.${ext}`, bodyOf(note), 'text/plain;charset=utf-8');
    if (saved) toast(`Saved ${saved}.`);
  }

  // Printing is the PDF route: the print stylesheet draws the preview on paper and the
  // user picks "Save as PDF" in the print dialog. Nothing is written anywhere new.
  async function exportPdf() {
    const note = active();
    if (!isEditable(note)) return;
    if (note.cipher) {
      const ok = await confirmDialog('Export this encrypted note as PDF?', 'The PDF is not encrypted. Anyone who can open it can read the note.', 'Export as PDF');
      if (!ok) return;
      if (active() !== note || !isEditable(note)) { toast('The note was locked. Unlock it and try again.', 'error'); return; }
    }
    prepareForPrint();
    printing = true;
    try {
      document.title = titleOf(note);
      toast('In the print dialog, choose Save as PDF.');
      window.print();
    } catch (e) {
      console.error('print failed', errName(e));
      afterPrint();
      toast('The print dialog could not be opened.', 'error');
      return;
    }
    // Fallback for an engine that fires no afterprint: restore when the window next regains focus.
    // Only added when afterprint has not already run.
    if (printing) {
      window.addEventListener('focus', afterPrint, { once: true });
      printFocusCleanup = () => window.removeEventListener('focus', afterPrint);
    }
  }

  // beforeprint/afterprint also cover Ctrl+P in a browser. In Write layout the preview is
  // normally empty, so it is filled for the print and emptied again afterwards. A locked
  // note is never rendered.
  let printForced = false;
  let printFocusCleanup = null;
  let printing = false;
  function prepareForPrint() {
    g.hold = true; // the measuring copy of the note must not exist while printing
    clearMirror();
    clearRows();
    const note = active();
    if (!isEditable(note)) return;
    if (S.settings.view === 'edit') printForced = true;
    renderPreview(true);
  }
  function afterPrint() {
    printing = false;
    g.hold = false;
    updateGutter();
    updateHl();
    if (printFocusCleanup) { printFocusCleanup(); printFocusCleanup = null; }
    const note = active();
    document.title = note ? `${titleOf(note)} | CyberPad` : 'CyberPad';
    if (printForced) { printForced = false; if (S.settings.view === 'edit') renderPreview(); }
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

  /** True when the text is JSON whose `app` field names CyberPad (or its old name): it claims to be a backup or note file. */
  function claimsBackup(text) {
    let raw;
    try { raw = JSON.parse(text); } catch (err) {
      if (err instanceof SyntaxError) return false;
      throw err;
    }
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw) && (raw.app === 'cyberpad' || raw.app === 'neonpad');
  }

  async function importFiles(files) {
    let lastId = null;
    let count = 0;
    let textNotes = 0;
    for (const file of files.slice(0, 20)) {
      try {
        const ext = store.checkImportFile(file.name, file.size);
        const text = store.decodeImportBytes(await file.arrayBuffer());
        const type = store.fileTypeOf(ext);
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
            // A file that says it is a CyberPad backup but fails validation is reported, never imported as text.
            if (claimsBackup(text)) throw new store.StoreError('That file says it is a CyberPad backup, but it is damaged or not valid, so it was not imported.');
            // Any other JSON (or text that does not parse) is an ordinary file: it becomes a JSON note below.
          }
        }
        if (text.length > store.LIMITS.body) throw new store.StoreError('That file is too long for one note.');
        if (S.notes.length >= store.LIMITS.notes) throw new store.StoreError('The note limit has been reached.');
        const n = store.createNote(text);
        n.lang = type ? type.lang : '';
        S.notes.push(n);
        lastId = n.id;
        count++;
        textNotes++;
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
    if (files.length === 1 && textNotes === 1) toast(`Imported ${files[0].name}.`);
  }

  // --------------------------------------------------------- linked files
  // Desktop only. A note can be linked to a .txt/.md/.cpnote file that receives every saved change. The page
  // knows only note.file = { linkId, name, format }; the host owns the paths. Encrypted notes go to files as
  // their persisted ciphertext only (filelink.fileTextOf). Logs carry error types, never text or file names.

  const FL = window.NP.filelink;
  const FILE_REASON = { timeout: 'the app did not answer in time', 'too-large': 'the note is too large for a file' };
  const FILE_LABEL = {
    pending: 'Checking file…', unknown: 'File not checked yet', saving: 'Saving to file…', saved: 'Saved to file',
    changed: 'File changed elsewhere', missing: 'File not found',
  };
  const BAR_STATES = ['changed', 'missing', 'failed'];
  const MAX_CHECK_ROUNDS = 3;

  const files = {
    tracker: FL.createTracker(), // note id -> file text last confirmed written, read or opened
    queue: FL.createWriteQueue(writeLinked),
    status: new Map(),    // note id -> { state, reason, paused }; state is a FILE_LABEL key or 'failed'
    outcome: new Map(),   // note id -> outcome of the last write: 'written' | 'conflict' | 'missing' | 'failed'
    lastInput: new Map(), // note id -> time of the last editor input in that note
    manual: new Map(),    // note id -> force flag of a write the user asked for (Save, Retry, Keep mine)
    adopt: new Map(),     // note id -> file text the note adopted, to confirm with a non-forced write of exactly it
    hold: new Set(),      // note ids whose link is moving to a new file (Save as): no writes meanwhile
    ready: false,         // startup checks done: automatic writes and focus checks may run
    started: false,       // the page is ready to open files the host has queued
    checking: false,
    checkAgain: false,
    opening: false,
    openWanted: false,    // the host asked for an openFile that has not been sent yet
    applying: false,      // the page itself is replacing editor text, which is not typing
  };
  const fileUi = { status: null, name: null, state: null, bar: null, text: null, actions: null, key: null };

  const errName = (err) => (err instanceof PlatformError ? err.reason : (err && err.name));
  const noteByLink = (linkId) => S.notes.find((n) => n.file && n.file.linkId === linkId) || null;
  const linkedTo = (id, linkId) => { const n = noteById(id); return !!(n && n.file && n.file.linkId === linkId); };
  const fileStatusOf = (id) => files.status.get(id) || { state: 'unknown', reason: null, paused: false };
  const msSinceInput = (id) => Date.now() - (files.lastInput.get(id) || 0);

  /** A short reason fit to show: the host's own sentence, a FileLinkError message, or a generic phrase. */
  function fileReason(err) {
    if ((err instanceof PlatformError && err.userFacing) || err instanceof FL.FileLinkError) return err.message;
    return FILE_REASON[err instanceof PlatformError ? err.reason : ''] || 'the app could not reach the file';
  }

  function fileTextOrNull(note) {
    try { return FL.fileTextOf(note); } catch (err) {
      if (err instanceof FL.FileLinkError) return null;
      throw err;
    }
  }

  /** Changes not yet confirmed in the file. For encrypted notes a pending or failed seal counts too. */
  function unwritten(note) {
    if (note.cipher && (S.sealTimers.has(note.id) || S.sealing.has(note.id) || S.sealFailed.has(note.id))) return true;
    const text = fileTextOrNull(note);
    return text === null || files.tracker.hasUnwritten(note.id, text);
  }

  /** Automatic writes wait for the user's choice after a conflict, a missing file or an unreadable file. */
  function writesPaused(id) {
    const st = fileStatusOf(id);
    return st.state === 'changed' || st.state === 'missing' || st.paused === true;
  }

  function setFileStatus(id, state, reason = null, paused = false) {
    files.status.set(id, { state, reason, paused });
    if (id === S.activeId) renderFileUi();
  }

  /**
   * The user's note now holds the file's text (reload, "Use the file's version", an equal file at startup or on
   * open). Reading never confirms content on the host, so adopt it with a non-forced write of exactly that text:
   * the host takes the file as it is when the bytes match, and reports a conflict if it changed again meanwhile.
   */
  function adoptFile(note, text) {
    files.adopt.set(note.id, text);
    requestWrite(note.id);
  }

  function confirmInSync(note) {
    const text = fileTextOrNull(note);
    if (text !== null) files.tracker.confirm(note.id, text);
    setFileStatus(note.id, 'saved');
  }

  function forgetFileState(id) {
    files.tracker.forget(id);
    files.status.delete(id);
    files.outcome.delete(id);
    files.manual.delete(id);
    files.adopt.delete(id);
    files.lastInput.delete(id);
  }

  /** Removes the link on the page only; callers tell the host. */
  function dropLink(note) {
    note.file = null;
    forgetFileState(note.id);
    if (note.id === S.activeId) renderFileUi();
  }

  /**
   * Best-effort host unlink; a failure leaves an orphan link that the next startup prune removes. A link the host
   * does not know is already unlinked there, so that is not a failure.
   */
  function forgetHostLink(linkId) {
    platform.unlinkFile(linkId).catch((err) => {
      if (!FL.isUnknownLink(err)) console.error('unlink failed', errName(err));
    });
  }

  function hasUnwrittenFiles() {
    // Paused writes (conflict, missing, damaged or mismatched file) and a link being moved never count as written,
    // whatever the last write's outcome was.
    return platform.isDesktop && S.notes.some((n) => n.file && unwritten(n)
      && (writesPaused(n.id) || files.hold.has(n.id) || files.outcome.get(n.id) !== 'written'));
  }

  // ---- writing

  function requestWrite(id, manual = false, force = false) {
    if (manual) files.manual.set(id, force || files.manual.get(id) === true);
    files.queue.request(id);
  }

  /** The write queue's writer: one write per note at a time. Reports its own failures (the queue ignores them). */
  async function writeLinked(id) {
    const adopting = files.adopt.has(id);
    const adoptText = files.adopt.get(id);
    const manual = adopting || files.manual.has(id);
    const force = !adopting && files.manual.get(id) === true; // an adoption is never forced
    files.manual.delete(id);
    files.adopt.delete(id);
    const note = noteById(id);
    if (!platform.isDesktop || !note || !note.file || files.hold.has(id)) return;
    if (!manual && writesPaused(id)) return;
    // Fail closed: never put plain text into a .cpnote, nor ciphertext into a text file.
    if ((note.file.format === 'cpnote') !== (note.cipher !== null)) {
      setFileStatus(id, 'failed', 'the file format does not match this note', true);
      return;
    }
    let text;
    try {
      text = adopting ? adoptText : FL.fileTextOf(note);
    } catch (err) {
      if (!(err instanceof FL.FileLinkError)) console.error('file write failed', errName(err));
      setFileStatus(id, 'failed', fileReason(err));
      return;
    }
    if (!manual && !files.tracker.hasUnwritten(id, text)) return;
    const { linkId } = note.file;
    setFileStatus(id, 'saving');
    try {
      const outcome = await platform.writeFile(linkId, text, force);
      if (!linkedTo(id, linkId)) return;
      files.outcome.set(id, outcome);
      if (outcome === 'written') {
        // A .cpnote adopted as formatted elsewhere still holds this note: track the note's own text, so no rewrite follows.
        const same = adopting && FL.matchesFile(note, text) ? fileTextOrNull(note) : null;
        files.tracker.confirm(id, same !== null ? same : text);
        setFileStatus(id, 'saved');
      } else {
        setFileStatus(id, outcome === 'conflict' ? 'changed' : 'missing');
      }
    } catch (err) {
      console.error('file write failed', errName(err));
      if (!linkedTo(id, linkId)) return;
      files.outcome.set(id, 'failed');
      setFileStatus(id, 'failed', fileReason(err));
    }
  }

  /** After a successful notes.json save: send every linked note whose file text is not confirmed yet. */
  function syncLinkedFiles(always = false) {
    if (!platform.isDesktop || (!files.ready && !always)) return;
    for (const n of S.notes) {
      if (!n.file || files.hold.has(n.id) || writesPaused(n.id)) continue;
      const text = fileTextOrNull(n);
      if (text !== null && !files.tracker.hasUnwritten(n.id, text)) continue;
      requestWrite(n.id);
    }
  }

  // ---- checking and reloading

  /**
   * Statuses for these links, or null when the check failed. The host refuses a whole batch if one id is
   * unknown to it (for example a racing unlink): then each link is asked alone, and one it refuses reads as missing.
   */
  async function fileStatuses(ids) {
    try {
      return await platform.checkFiles(ids);
    } catch (err) {
      console.error('file check failed', errName(err));
      if (!(err instanceof PlatformError) || err.reason !== 'host') return null;
      if (ids.length === 1) return { [ids[0]]: 'missing' };
    }
    const out = {};
    for (const id of ids) {
      try {
        Object.assign(out, await platform.checkFiles([id]));
      } catch (err) {
        if (err instanceof PlatformError && err.reason === 'host') out[id] = 'missing';
        else console.error('file check failed', errName(err));
      }
    }
    return out;
  }

  /** Puts a file's text into its note: plain text through the edit path (old text into history), .cpnote as a locked cipher. */
  async function replaceWithFileText(note, text) {
    if ((note.file && note.file.format === 'cpnote') !== (note.cipher !== null)) throw new FL.FileLinkError('The file format does not match this note.');
    if (note.cipher) {
      const cipher = FL.parseCpnote(text);
      clearTimeout(S.sealTimers.get(note.id));
      S.sealTimers.delete(note.id);
      const sealing = S.sealing.get(note.id);
      if (sealing) await sealing; // a seal finishing later must not overwrite the file's version
      if (!noteById(note.id) || !note.cipher) throw new FL.FileLinkError('The note changed while the file was read.');
      if (note.id === S.activeId && finishCurrentDialog) finishCurrentDialog(null); // it may show the old plaintext
      note.cipher = cipher;
      note.body = '';
      note.history = [];
      note.updated = Date.now();
      S.keys.delete(note.id);
      S.plain.delete(note.id);
      S.meta.delete(note.id);
      S.sealFailed.delete(note.id);
      persistNow();
      if (note.id === S.activeId) { closeSlash(); renderAll(); } else renderList();
    } else {
      if (text.length > store.LIMITS.body) throw new FL.FileLinkError('That file is too long for one note.');
      replaceNoteBody(note, text);
    }
    adoptFile(note, text);
  }

  function replaceNoteBody(note, text) {
    const now = Date.now();
    note.history = store.addSnapshot(note.history, note.body, now, true);
    if (note.id === S.activeId && isEditable(note)) {
      files.applying = true;
      try { replaceRange(0, els.editor.value.length, text, 0); } finally { files.applying = false; }
    }
    note.body = text;
    note.updated = now;
    persistNow();
    if (note.id === S.activeId) {
      renderEditor();
      renderPreview();
      updateStatus();
      runSecretScan();
      if (!els.findbar.hidden) computeMatches();
    }
    renderList();
    renderTags();
  }

  function damagedFile(note, err) {
    setFileStatus(note.id, 'failed', err.message, true);
    toast(`Not saved to file: ${err.message}`, 'error');
  }

  /** Reads the linked file into the note. `silent` (a focus check) backs off to the conflict bar if the note changed meanwhile. */
  async function reloadFromFile(note, linkId, silent) {
    let res;
    try {
      res = await platform.readFile(linkId);
    } catch (err) {
      console.error('file read failed', errName(err));
      if (!silent && linkedTo(note.id, linkId)) toast(`The file could not be read: ${fileReason(err)}`, 'error');
      return false;
    }
    if (!linkedTo(note.id, linkId)) return false;
    const { name } = note.file;
    if (res.missing) { setFileStatus(note.id, 'missing'); return false; }
    if (FL.matchesFile(note, res.text)) { adoptFile(note, res.text); return true; }
    if (silent && FL.decide({ status: 'changed', hasUnwritten: unwritten(note), msSinceInput: msSinceInput(note.id) }) !== 'reload') {
      setFileStatus(note.id, 'changed');
      return false;
    }
    try {
      await replaceWithFileText(note, res.text);
    } catch (err) {
      if (!(err instanceof FL.FileLinkError)) throw err;
      damagedFile(note, err);
      return false;
    }
    if (silent) toast(`Reloaded ${name} from disk.`);
    return true;
  }

  async function actOnStatus(note, linkId, status) {
    if (!linkedTo(note.id, linkId) || !status || status === 'unknown') return;
    if (status === 'ok') {
      // The file is there and unchanged: a missing or unchecked link can resume.
      if (['missing', 'unknown', 'pending'].includes(fileStatusOf(note.id).state)) {
        if (unwritten(note)) { setFileStatus(note.id, 'unknown'); requestWrite(note.id); } else setFileStatus(note.id, 'saved');
      }
      return;
    }
    const decision = FL.decide({ status, hasUnwritten: unwritten(note), msSinceInput: msSinceInput(note.id) });
    if (decision === 'missing') setFileStatus(note.id, 'missing');
    else if (decision === 'conflict') setFileStatus(note.id, 'changed');
    else if (decision === 'reload') await reloadFromFile(note, linkId, true);
  }

  /** On window focus: check every linked file and act per decide(). One check at a time; a request meanwhile runs once more. */
  async function checkLinkedFiles() {
    if (!platform.isDesktop || !files.ready) return;
    if (files.checking) { files.checkAgain = true; return; }
    files.checking = true;
    try {
      for (let round = 0; round < MAX_CHECK_ROUNDS; round++) {
        files.checkAgain = false;
        const pairs = S.notes.filter((n) => n.file).map((n) => [n, n.file.linkId]);
        if (!pairs.length) break;
        const statuses = await fileStatuses(pairs.map(([, linkId]) => linkId));
        if (statuses) for (const [n, linkId] of pairs) await actOnStatus(n, linkId, statuses[linkId]);
        if (!files.checkAgain) break;
      }
    } catch (err) {
      console.error('file check failed', errName(err));
    } finally {
      files.checking = false;
    }
  }

  /** Startup: prune orphan links, then seed each linked note's state from its file, one at a time. */
  async function startLinkedFiles(source) {
    if (!platform.isDesktop) return;
    const fromDisk = source === 'main' || source === 'backup';
    const pairs = S.notes.filter((n) => n.file).map((n) => [n, n.file.linkId]);
    try {
      if (fromDisk && S.storageOk) {
        try {
          await platform.pruneLinks([...new Set(pairs.map(([, linkId]) => linkId))]);
        } catch (err) {
          console.error('link prune failed', errName(err));
        }
      }
      if (fromDisk && pairs.length) await seedLinkedFiles(pairs, source);
    } catch (err) {
      console.error('file check failed', errName(err));
    } finally {
      files.ready = true;
      syncLinkedFiles();
    }
  }

  async function seedLinkedFiles(pairs, source) {
    for (const [n] of pairs) setFileStatus(n.id, 'pending');
    const statuses = await fileStatuses(pairs.map(([, linkId]) => linkId));
    for (const [n, linkId] of pairs) {
      if (!linkedTo(n.id, linkId)) continue;
      const status = statuses ? statuses[linkId] : undefined;
      if (status === 'missing') setFileStatus(n.id, 'missing');
      else if (status === 'ok' || status === 'changed') await seedOne(n, linkId, status, source);
      if (linkedTo(n.id, linkId) && fileStatusOf(n.id).state === 'pending') setFileStatus(n.id, 'unknown');
    }
  }

  /** Reads one linked file at startup and acts per FL.seedAction (after a backup restore, never writes over a different file). */
  async function seedOne(note, linkId, status, source) {
    let res;
    try {
      res = await platform.readFile(linkId);
    } catch (err) {
      console.error('file read failed', errName(err));
      return;
    }
    if (!linkedTo(note.id, linkId)) return;
    const equal = !res.missing && FL.matchesFile(note, res.text);
    let matchesLast;
    if (!res.missing && status === 'changed' && !equal && source === 'main') matchesLast = await noteMatchesLastWrite(note, linkId);
    if (!linkedTo(note.id, linkId)) return;
    const action = FL.seedAction({ status: res.missing ? 'missing' : status, equal, source, matchesLast });
    if (action === 'missing') setFileStatus(note.id, 'missing');
    else if (action === 'confirm') confirmInSync(note); // the file still holds what CyberPad last wrote or adopted
    else if (action === 'adopt') adoptFile(note, res.text); // changed elsewhere to exactly the note's text: adopt it
    else if (action === 'write') { setFileStatus(note.id, 'unknown'); requestWrite(note.id); } // the note is newer, e.g. a close timed out
    else if (action === 'reload') await reloadAtStartup(note, res.text);
    else if (action === 'conflict') setFileStatus(note.id, 'changed');
  }

  /**
   * Asks the host whether the note's text is exactly what CyberPad last wrote to this file (or the user adopted). True
   * means the note has nothing unwritten, so a file edited while CyberPad was closed can be taken silently. Any failure
   * or a change to the note while asking is false (the conflict bar then asks).
   */
  async function noteMatchesLastWrite(note, linkId) {
    const text = fileTextOrNull(note);
    if (text === null) return false;
    try {
      const match = await platform.matchesLastWrite(linkId, text);
      if (match !== true || !linkedTo(note.id, linkId) || fileTextOrNull(note) !== text) return false;
      // An encrypted note unlocked and edited meanwhile has plaintext not yet sealed into its cipher.
      return !(note.cipher && (S.sealTimers.has(note.id) || S.sealing.has(note.id) || S.sealFailed.has(note.id)));
    } catch (err) {
      console.error('last write check failed', errName(err));
      return false;
    }
  }

  /** The silent reload at startup: the file's text replaces the note's; adoption (a non-forced write) confirms it. */
  async function reloadAtStartup(note, text) {
    const { name } = note.file;
    try {
      await replaceWithFileText(note, text);
    } catch (err) {
      if (!(err instanceof FL.FileLinkError)) throw err;
      damagedFile(note, err);
      return;
    }
    toast(`Reloaded ${name} from disk.`);
  }

  // ---- commands

  /** Ctrl+S on the desktop: save notes.json, then write a linked note now, or choose a file for an unlinked one. */
  function saveCommand() {
    const note = active();
    flushSeals().then(() => saveNow()).then((ok) => {
      if (ok) toast('Saved.');
      if (!note || !noteById(note.id)) return undefined;
      if (note.file) { requestWrite(note.id, true, false); return undefined; }
      return saveAsFileFor(note);
    });
  }

  function suggestedNameFor(note, format, copy) {
    const current = note.file && note.file.format === format ? note.file.name : null;
    if (!copy && current && current.length <= 120) return current;
    return FL.suggestedFileName(copy ? `${titleOf(note)} copy` : titleOf(note), format);
  }

  function reportFileError(err, prefix) {
    console.error('file action failed', errName(err));
    if (err instanceof PlatformError && err.userFacing && err.linkId) {
      const holder = noteByLink(err.linkId) || restorePendingHolding(err.linkId);
      toast('That file is already linked to another note.', 'error', holder ? [{ label: 'Show it', fn: () => openNote(holder.id) }] : null);
    } else {
      toast(`${prefix}: ${fileReason(err)}`, 'error');
    }
  }

  /**
   * Save as file…: link the note to a file the user picks (on a linked note the link moves; the old file stays).
   * With `copy`, the file is a one-off copy and the note keeps its current link.
   */
  async function saveAsFileFor(note, { copy = false } = {}) {
    if (!platform.isDesktop || !note || !noteById(note.id) || files.hold.has(note.id)) return;
    await flushSeals();
    if (S.sealFailed.has(note.id)) { toast('The latest changes could not be encrypted, so they were not saved to a file. Press Ctrl+S to retry.', 'error'); return; }
    // The host's dialog offers this type first, then every supported type; the reply says what the user picked.
    const format = store.defaultExtFor(note);
    if (!noteById(note.id) || !FL.formatsFor(note).includes(format)) return;
    let relinkId = !copy && note.file ? note.file.linkId : null;
    files.hold.add(note.id);
    try {
      if (relinkId) await files.queue.idle(); // the write in flight to the old file finishes first
      const suggestedName = suggestedNameFor(note, format, copy);
      let text;
      let res;
      for (let attempt = 0; ; attempt++) {
        // Re-check after every await: the note may have been deleted, encrypted, decrypted or unlinked meanwhile,
        // and plain text must never go into a .cpnote (nor ciphertext into a text file).
        const linkNow = note.file ? note.file.linkId : null;
        if (!noteById(note.id) || !FL.formatsFor(note).includes(format) || (!copy && relinkId !== linkNow)) {
          toast('The note changed before it could be saved, so nothing was saved. Try again.', 'error');
          return;
        }
        text = FL.fileTextOf(note);
        try {
          res = await platform.saveAsFile({ format, suggestedName, text, relinkId });
          break;
        } catch (err) {
          // The host does not know this link (stale): drop it, then save as a new link once.
          // The re-check above then refuses if the note was linked elsewhere meanwhile.
          if (!relinkId || attempt > 0 || !FL.isUnknownLink(err)) throw err;
          if (linkedTo(note.id, relinkId)) {
            dropLink(note);
            persistNow();
            renderList();
            updateStatus();
          }
          relinkId = null;
        }
      }
      if (!res.linked) return;
      if (copy) {
        forgetHostLink(res.linkId); // a copy is not linked: the note stays with its own file
        toast(`Saved a copy as ${res.name}.`);
        return;
      }
      if (!noteById(note.id) || !FL.formatsFor(note).includes(res.format)) { forgetHostLink(res.linkId); return; }
      note.file = { linkId: res.linkId, name: res.name, format: res.format };
      // Saved under another type than offered: the note's mode follows it, unless the user set the language by hand.
      const type = store.fileTypeOf(res.format);
      const modeChanged = res.format !== format && !note.cipher && !langByHand.has(note.id) && !!type && type.lang !== note.lang;
      if (modeChanged) note.lang = type.lang;
      files.tracker.confirm(note.id, text);
      files.outcome.set(note.id, 'written');
      setFileStatus(note.id, 'saved');
      persistNow();
      if (modeChanged) refreshAfterLang(note);
      renderList();
      updateStatus();
      toast(`Saved to ${res.name}. Every change now goes to this file too.`);
    } catch (err) {
      if (err instanceof FL.FileLinkError) toast(`Not saved to file: ${err.message}`, 'error');
      else reportFileError(err, 'Not saved to file');
    } finally {
      files.hold.delete(note.id);
      syncLinkedFiles();
    }
  }

  /** After encrypting a note that was linked to a .txt/.md file: that file still holds plain text. */
  async function noticePlainFileLeft(note, file) {
    const choice = await showDialog({
      title: 'Note encrypted',
      body: [h('p', null, `Only the encrypted copy is saved. The note is no longer linked to ${file.name}, which still holds the last saved text as plain text. CyberPad never deletes your files, so delete it yourself if you no longer need it.`)],
      actions: [
        { label: 'Close', value: null },
        { label: 'Save as encrypted file…', value: 'save', className: 'btn-primary' },
      ],
    });
    if (choice === 'save') saveAsFileFor(note);
  }

  async function unlinkActive() {
    const note = active();
    if (!platform.isDesktop || !note || !note.file) return;
    const { linkId, name } = note.file;
    dropLink(note); // on the page first, so nothing more is written
    persistNow();
    renderList();
    updateStatus();
    forgetHostLink(linkId);
    toast(`Unlinked from ${name}. The note and the file both stay.`);
  }

  async function revealActive() {
    const note = active();
    if (!platform.isDesktop || !note || !note.file) return;
    try {
      await platform.revealFile(note.file.linkId);
    } catch (err) {
      reportFileError(err, 'The file could not be shown');
    }
  }

  async function useFileVersion(id, linkId) {
    const note = noteById(id);
    if (!linkedTo(id, linkId)) return;
    const ok = await reloadFromFile(note, linkId, false);
    if (!ok) return;
    toast(note.cipher
      ? 'The note now holds the file’s version. Unlock it with that version’s passphrase.'
      : 'The note now holds the file’s version. The text it replaced is in the version history.');
  }

  // ---- opening

  function openFileCommand() {
    if (!platform.isDesktop || files.opening) return;
    runOpen();
  }

  /** Host-queued opens (command line, second instance): one openFile per request, never while a CyberPad dialog is open. */
  function drainOpens() {
    if (!files.openWanted || !files.started || files.opening) return;
    if (els.modal.open || els.palette.open) return; // retried when that dialog closes
    files.openWanted = false;
    runOpen();
  }

  async function runOpen() {
    files.opening = true;
    try {
      const res = await platform.openFile();
      if (res.opened) await adoptOpened(res);
    } catch (err) {
      reportFileError(err, 'Not opened');
    } finally {
      files.opening = false;
      setTimeout(drainOpens, 0);
    }
  }

  async function adoptOpened(res) {
    if (res.alreadyLinked) {
      const holder = noteByLink(res.linkId) || restorePendingHolding(res.linkId);
      if (holder) { await showOpenedNote(holder, res); return; }
    }
    if (S.notes.length >= store.LIMITS.notes) {
      toast(`You have reached ${store.LIMITS.notes} notes, so ${res.name} was not opened. Delete some to make room.`, 'error');
      if (!res.alreadyLinked) forgetHostLink(res.linkId);
      return;
    }
    let note;
    try {
      note = FL.noteFromFile(res);
    } catch (err) {
      if (!(err instanceof FL.FileLinkError)) throw err;
      toast(`${res.name} was not opened: ${err.message}`, 'error');
      if (!res.alreadyLinked) forgetHostLink(res.linkId);
      return;
    }
    S.notes.push(note);
    confirmInSync(note);
    S.query = '';
    els.search.value = '';
    openNote(note.id);
    renderTags();
    persistNow();
    toast(note.cipher ? `Opened ${res.name}. Unlock it with its passphrase.` : `Opened ${res.name}. Every change is saved to it too.`);
  }

  /** The opened file is already linked to a note: show that note, and bring in the file's text if it changed. */
  async function showOpenedNote(note, res) {
    openNote(note.id);
    if (FL.matchesFile(note, res.text)) { adoptFile(note, res.text); return; }
    if (FL.decide({ status: 'changed', hasUnwritten: unwritten(note), msSinceInput: msSinceInput(note.id) }) !== 'reload') {
      setFileStatus(note.id, 'changed');
      return;
    }
    try {
      await replaceWithFileText(note, res.text);
      toast(`Reloaded ${res.name} from disk.`);
    } catch (err) {
      if (!(err instanceof FL.FileLinkError)) throw err;
      damagedFile(note, err);
    }
  }

  // ---- status line and file bar

  function setupFileUi() {
    if (!platform.isDesktop) return;
    fileUi.name = h('span', { class: 'st-file-name' });
    fileUi.state = h('span', { class: 'st-file-state' });
    fileUi.status = h('span', { class: 'st st-file', hidden: true }, fileUi.name, fileUi.state);
    els.stSave.after(fileUi.status);
    fileUi.text = h('span', { class: 'alert-text' });
    fileUi.actions = h('span', { class: 'alert-actions' });
    fileUi.bar = h('div', { class: 'alertbar filebar', role: 'alert', hidden: true },
      h('span', { class: 'filebar-mark', 'aria-hidden': 'true' }, '⇄'), fileUi.text, fileUi.actions);
    els.secretAlert.after(fileUi.bar);
  }

  const fileLabel = (st) => (st.state === 'failed' ? `Not saved to file: ${st.reason || 'unexpected error'}` : FILE_LABEL[st.state] || FILE_LABEL.unknown);

  function renderFileUi() {
    if (!fileUi.status) return;
    const note = active();
    if (!note || !note.file) {
      fileUi.status.hidden = true;
      fileUi.bar.hidden = true;
      fileUi.key = null;
      return;
    }
    const st = fileStatusOf(note.id);
    const label = fileLabel(st);
    fileUi.status.hidden = false;
    fileUi.status.dataset.state = st.state;
    if (fileUi.name.textContent !== note.file.name) fileUi.name.textContent = note.file.name;
    if (fileUi.state.textContent !== label) fileUi.state.textContent = label;
    const key = BAR_STATES.includes(st.state) ? [note.id, note.file.linkId, note.file.name, st.state, st.reason].join('\u0000') : null;
    if (key === fileUi.key) return;
    fileUi.key = key;
    if (!key) { fileUi.bar.hidden = true; fileUi.actions.replaceChildren(); return; }
    const { id } = note;
    const { linkId, name } = note.file;
    const act = (text, fn) => {
      const b = h('button', { type: 'button', class: 'chip' }, text);
      b.addEventListener('click', () => runBarAction(fn));
      return b;
    };
    const saveAs = act('Save as file…', () => saveAsFileFor(noteById(id)));
    const retry = act('Retry', () => { if (linkedTo(id, linkId)) requestWrite(id, true, false); });
    if (st.state === 'changed') {
      fileUi.text.textContent = `${name} was changed outside CyberPad. Choose which version to keep.`;
      fileUi.actions.replaceChildren(
        act('Keep mine', () => { if (linkedTo(id, linkId)) requestWrite(id, true, true); }),
        act("Use the file's version", () => useFileVersion(id, linkId)),
        act('Save mine as a copy…', () => saveAsFileFor(noteById(id), { copy: true })),
      );
    } else if (st.state === 'missing') {
      fileUi.text.textContent = `${name} can’t be found. It may have been moved, renamed or deleted. The note is safe in CyberPad, and CyberPad never recreates the file. If the file comes back unchanged, saving to it resumes on its own.`;
      fileUi.actions.replaceChildren(saveAs, act('Unlink', () => { if (linkedTo(id, linkId)) unlinkActive(); }), retry);
    } else {
      fileUi.text.textContent = `${label}${/[.!?]$/.test(label) ? '' : '.'} The note is safe in CyberPad.`;
      fileUi.actions.replaceChildren(retry, saveAs);
    }
    fileUi.bar.hidden = false;
  }

  /** Runs a file bar action with its buttons disabled, so a double click can't start it twice. */
  function runBarAction(fn) {
    const buttons = [...fileUi.actions.querySelectorAll('button')];
    buttons.forEach((b) => { b.disabled = true; });
    Promise.resolve()
      .then(fn)
      .catch((err) => console.error('file action failed', errName(err)))
      .finally(() => {
        buttons.forEach((b) => { b.disabled = false; });
        fileUi.key = null;
        renderFileUi();
      });
  }

  function wireFileEvents() {
    if (!platform.isDesktop) return;
    window.addEventListener('focus', () => { checkLinkedFiles(); });
    // Host-queued opens wait for CyberPad's own dialogs.
    els.modal.addEventListener('close', () => setTimeout(drainOpens, 0));
    els.palette.addEventListener('close', () => setTimeout(drainOpens, 0));
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

  /** `actions` is an optional list of { label, fn } shown as buttons; a click closes the toast and runs fn. */
  function toast(message, kind = 'info', actions = null) {
    const t = h('div', { class: kind === 'error' ? 'toast error' : 'toast' }, message);
    const buttons = Array.isArray(actions) ? actions.slice(0, 3) : [];
    if (buttons.length) {
      t.classList.add('has-actions');
      const row = h('span', { class: 'toast-actions' });
      for (const a of buttons) {
        const b = h('button', { type: 'button', class: 'chip' }, a.label);
        b.addEventListener('click', () => { t.remove(); a.fn(); });
        row.append(b);
      }
      t.append(row);
    }
    els.toasts.append(t);
    while (els.toasts.children.length > 4) els.toasts.firstElementChild.remove();
    setTimeout(() => t.remove(), buttons.length ? 12000 : (kind === 'error' ? 7000 : 3500));
    return t;
  }

  /** `fromEncrypted`: the text came from an encrypted note other than the open one, so the clipboard is cleared all the same. */
  function copyText(text, fromEncrypted = false) {
    if (!navigator.clipboard) { toast('Copying is not available here. Select the text and press Ctrl+C.', 'error'); return; }
    navigator.clipboard.writeText(text).then(
      () => { if (!noteSensitiveCopy(fromEncrypted)) toast('Copied to the clipboard.'); },
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
  function noteSensitiveCopy(force = false) {
    const note = active();
    if (!S.settings.clearClipboard) return false;
    if (!force && (!note || !note.cipher || isLocked(note))) return false;
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
        [['screen .................. '], ['ok', 'ok'], [`  ${THEME_NAMES[screenTheme()].toLowerCase()} display`]],
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
      if (!platform.isDesktop) flushSeals().then(() => saveNow()).then((ok) => { if (ok) toast('Saved.'); });
      else if (e.shiftKey) saveAsFileFor(active());
      else saveCommand();
      return;
    }
    if (platform.isDesktop && mod && !e.altKey && !e.shiftKey && k === 'o') { e.preventDefault(); openFileCommand(); return; }
    if (mod && !e.altKey && !e.shiftKey && k === 'e') { e.preventDefault(); cycleView(); return; }
    if (mod && !e.altKey && !e.shiftKey && k === 'b') { e.preventDefault(); toggleSidebar(); return; }
    if (mod && !e.altKey && !e.shiftKey && k === 'f') { e.preventDefault(); openFind(); return; }
    if (mod && !e.altKey && !e.shiftKey && k === 'h') { e.preventDefault(); openFind(true); return; }
    if (e.key === 'F3' || (mod && !e.altKey && k === 'g')) { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); return; }
    if (e.key === 'F1') { e.preventDefault(); showShortcuts(); return; }

    if (e.altKey && !mod && !e.shiftKey && e.key === 'F10') {
      if (focusSeltools()) e.preventDefault();
      return;
    }
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
    els.stLang.addEventListener('click', chooseLanguage);
    wireSeltools();
    ['keyup', 'mouseup', 'select', 'focus'].forEach((t) => ed.addEventListener(t, scheduleStatus));
    ed.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== ed) closeSlash(); }, 120));
    ed.addEventListener('mousedown', () => { arrowMemo = null; closeSlash(); });
    ed.addEventListener('input', onGutterInput);
    ed.addEventListener('beforeinput', onHlBeforeInput);
    ed.addEventListener('input', onHlInput); // after onGutterInput: the layer reuses the gutter's line count
    ['keyup', 'mouseup', 'select', 'focus'].forEach((t) => ed.addEventListener(t, scheduleBracket));
    ['keyup', 'mouseup', 'select', 'focus'].forEach((t) => ed.addEventListener(t, onGutterCaret));
    document.addEventListener('selectionchange', () => { if (document.activeElement === ed) { onGutterCaret(); scheduleBracket(); } });
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => { if (g.on) drawGutter(); hlRefresh(); }).observe(ed);
    ed.addEventListener('scroll', () => {
      scheduleGutterDraw();
      onHlScroll();
      if (performance.now() > selQuietUntil) hideSeltools();
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
      const t = e.target instanceof Element ? e.target : null;
      if (!t) return;
      const del = t.closest('.note-del');
      if (del) { const n = noteById(del.dataset.id); if (n) deleteNote(n); return; }
      const head = t.closest('.folder-head');
      if (head) { toggleFolder(head.dataset.folder); return; }
      const b = t.closest('.note-item');
      if (b) openNote(b.dataset.id);
    });
    els.noteList.addEventListener('keydown', (e) => {
      if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && S.pendingDelete) {
        e.preventDefault();
        undoDelete(undefined, { fromList: true });
        return;
      }
      if (e.key !== 'Delete' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const b = e.target instanceof Element ? e.target.closest('.note-item') : null;
      const n = b ? noteById(b.dataset.id) : null;
      if (n) { e.preventDefault(); deleteNote(n); }
    });
    wireFolderDrag();

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
      } else if (e.key === 'Tab') {
        // Focus never leaves the search box; Tab only jumps sections in browse mode.
        e.preventDefault();
        if (paletteMode() === 'browse') jumpPaletteSection(e.shiftKey ? -1 : 1);
      } else if (paletteMode() === 'browse' && (e.key === 'PageDown' || e.key === 'PageUp')) {
        e.preventDefault();
        jumpPaletteSection(e.key === 'PageUp' ? -1 : 1);
      }
    });
    // mousedown must not take focus from the input, so keys keep working
    els.paletteSections.addEventListener('mousedown', (e) => e.preventDefault());
    els.paletteSections.addEventListener('click', (e) => {
      const btn = e.target.closest('.palette-section');
      if (!btn) return;
      S.pal.idx = Number(btn.dataset.start);
      renderPalette();
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
        if (S.saveTimer) saveNow();
        if (S.sealTimers.size || S.sealing.size) {
          for (const id of [...S.sealTimers.keys()]) sealNow(id);
          e.preventDefault();
          e.returnValue = '';
        }
      });
    }
    window.addEventListener('pagehide', finalizePendingDelete);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        finalizePendingDelete();
        if (S.saveTimer) saveNow();
        for (const id of [...S.sealTimers.keys()]) sealNow(id);
        if (S.settings.lockOnHide && S.keys.size) lockAll('Encrypted notes were locked because the tab was hidden.');
      }
    });
    window.addEventListener('beforeprint', prepareForPrint);
    window.addEventListener('afterprint', afterPrint);
    document.addEventListener('copy', noteSensitiveCopy);
    document.addEventListener('cut', noteSensitiveCopy);
    window.addEventListener('focus', () => { if (clip.pending && !clip.timer) clearClipboardNow(); });
    if (!platform.isDesktop) {
      window.addEventListener('storage', (e) => {
        if (e.key === store.STORAGE_KEY) toast('Your notes were changed in another tab. Reload this page before editing here, or one tab will overwrite the other.', 'error');
      });
    }
    narrow.addEventListener('change', () => setDrawer(false));
    // Registered once. It only matters while the setting is System.
    if (darkScheme) darkScheme.addEventListener('change', () => { if (S.settings.theme === 'system') applySettings(); });
    wireFileEvents();
  }

  const mod = (e) => e.ctrlKey || e.metaKey;

  // ----------------------------------------------------------------- init

  async function init() {
    // Registered before the first await: the host may ask as soon as the page has loaded. Opens wait for `files.started`.
    if (platform.isDesktop) platform.onOpenRequested(() => { files.openWanted = true; drainOpens(); });
    const { firstRun, resave, source } = await load();
    if (platform.isDesktop) {
      // Resolves true only when every change is saved, in notes.json and in linked files; false makes the host ask before closing.
      platform.onFlushRequest(async () => {
        finalizePendingDelete();
        await flushSeals();
        if (await saveNow()) syncLinkedFiles(true);
        await files.queue.idle();
        return !hasUnsavedChanges() && !hasUnwrittenFiles();
      });
    }
    wireEvents();
    setupFileUi();
    renderAll();
    setSaveState('saved');
    // After a quarantine attempt the notes kept in memory may exist nowhere on disk: write them straight back
    // (as a change, so closing asks if that write fails). A first run only stores the welcome note.
    if (resave) persistNow();
    else if (firstRun) saveNow();
    startLinkedFiles(source);
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
    files.started = true;
    drainOpens();
  }

  init();
})();
