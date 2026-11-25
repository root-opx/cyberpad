'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../js/core/store.js');

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const ENV = { v: 1, kdf: 'PBKDF2-SHA256', iter: 600000, salt: 'AAAAAAAAAAAAAAAAAAAAAA==', iv: 'AAAAAAAAAAAAAAAA', data: 'AAAA' };

test('round-trips a valid state', () => {
  const note = store.createNote('# hi', 1000, ID);
  const text = store.serialize({ notes: [note], settings: store.DEFAULT_SETTINGS, activeId: ID });
  const back = store.parseStored(text);
  assert.equal(back.error, null);
  assert.deepEqual(back.notes, [note]);
  assert.equal(back.activeId, ID);
});

test('corrupt or foreign data falls back safely', () => {
  assert.equal(store.parseStored('{not json').error, 'corrupt');
  assert.equal(store.parseStored('{"v":99}').error, 'unsupported');
  assert.deepEqual(store.parseStored('').notes, []);
});

test('invalid notes are dropped, not repaired into something unsafe', () => {
  const raw = {
    v: 1,
    notes: [
      { id: '../../etc', body: 'bad id' },
      { id: ID, body: 'x'.repeat(store.LIMITS.body + 1) },
      { id: ID, cipher: { ...ENV, iter: 10 } },
      { id: ID, body: 'ok', pinned: 'yes', history: [{ t: 'now', body: 1 }, { t: 5, body: 'old' }] },
      { id: ID, body: 'duplicate id' },
      null, 42, 'string',
    ],
  };
  const { notes } = store.validateState(raw, 7);
  assert.equal(notes.length, 1);
  assert.deepEqual(notes[0], { id: ID, body: 'ok', cipher: null, pinned: false, created: 7, updated: 7, history: [{ t: 5, body: 'old' }], file: null, folder: '' });
});

test('encrypted notes never keep plaintext body or history', () => {
  const n = store.validateNote({ id: ID, body: 'leaked plaintext', cipher: ENV, history: [{ t: 1, body: 'old plaintext' }] });
  assert.equal(n.body, '');
  assert.deepEqual(n.history, []);
  const text = store.serialize({ notes: [{ ...n, body: 'in-memory plaintext' }], settings: store.DEFAULT_SETTINGS, activeId: null });
  assert.ok(!text.includes('plaintext'));
});

test('prototype pollution keys are ignored', () => {
  const back = store.parseStored('{"v":1,"__proto__":{"polluted":true},"settings":{"__proto__":{"x":1},"theme":"evil"},"notes":[]}');
  assert.equal({}.polluted, undefined);
  assert.equal(back.settings.theme, 'neon');
  assert.equal(Object.getPrototypeOf(back.settings), Object.prototype);
});

test('settings are allow-listed', () => {
  const s = store.validateState({ v: 1, settings: { theme: 'amber', view: 'nope', crt: 'true', autoLockMinutes: 7 } }).settings;
  assert.deepEqual(s, { ...store.DEFAULT_SETTINGS, theme: 'amber' });
});

test('renamed theme and legacy backups still load', () => {
  assert.equal(store.validateState({ v: 1, settings: { theme: 'phosphor' } }).settings.theme, 'terminal');
  assert.equal(store.validateState({ v: 1, settings: { theme: 'terminal' } }).settings.theme, 'terminal');
  assert.equal(store.validateState({ v: 1, settings: { theme: 'constructor' } }).settings.theme, 'neon');
  const legacy = JSON.stringify({ app: 'neonpad', v: 1, notes: [store.createNote('old', 1, ID)] });
  assert.equal(store.parseBackup(legacy).length, 1);
  assert.throws(() => store.parseBackup(JSON.stringify({ app: 'otherapp', v: 1, notes: [] })), store.StoreError);
  assert.equal(store.STORAGE_KEY, 'cyberpad.v1');
  assert.deepEqual(store.LEGACY_STORAGE_KEYS, ['neonpad.v1']);
});

test('history snapshots are throttled and bounded', () => {
  let h = [];
  h = store.addSnapshot(h, 'a', 0);
  h = store.addSnapshot(h, 'b', 1000);           // too soon
  h = store.addSnapshot(h, 'b', 61000);
  h = store.addSnapshot(h, 'b', 200000);         // unchanged
  assert.deepEqual(h.map((s) => s.body), ['a', 'b']);
  for (let i = 0; i < 50; i++) h = store.addSnapshot(h, `v${i}`, 0, true);
  assert.equal(h.length, store.LIMITS.history);
});

test('backup import validates and re-ids collisions', () => {
  const existing = [store.createNote('mine', 1, ID)];
  const backup = store.makeBackup([store.createNote('theirs', 2, ID)]);
  const incoming = store.parseBackup(backup);
  const merged = store.mergeNotes(existing, incoming);
  assert.equal(merged.notes.length, 2);
  assert.notEqual(merged.notes[1].id, ID);
  assert.throws(() => store.parseBackup('{"hello":1}'), store.StoreError);
  assert.throws(() => store.parseBackup('nope'), store.StoreError);
});

test('import file checks: extension allow-list, double extensions, size', () => {
  assert.equal(store.checkImportFile('notes.md', 10), 'md');
  assert.equal(store.checkImportFile('my.meeting.notes.txt', 10), 'txt');
  for (const bad of ['run.exe', 'page.html', 'noext', 'evil.html.md', 'x.js.txt', '']) {
    assert.throws(() => store.checkImportFile(bad, 10), store.StoreError, bad);
  }
  assert.throws(() => store.checkImportFile('big.txt', store.LIMITS.importBytes + 1), store.StoreError);
  assert.throws(() => store.checkImportFile('a.txt', -1), store.StoreError);
});

test('import decoding rejects non-UTF-8 and binary', () => {
  assert.equal(store.decodeImportBytes(new TextEncoder().encode('﻿hi\r\nthere')), 'hi\nthere');
  assert.throws(() => store.decodeImportBytes(new Uint8Array([0xff, 0xfe, 0x00])), store.StoreError);
  assert.throws(() => store.decodeImportBytes(new Uint8Array([0x61, 0x00, 0x62])), store.StoreError);
});

test('encrypted backup files round-trip and reject anything else', () => {
  const env = { v: 1, kdf: 'PBKDF2-SHA256', iter: 600000, salt: 'c2FsdHNhbHRzYWx0c2FsdA==', iv: 'aXZpdml2aXZpdml2', data: 'Y2lwaGVydGV4dA==' };
  const file = store.makeEncryptedBackup(env, 1700000000000);
  const parsed = JSON.parse(file);
  assert.equal(parsed.kind, 'encrypted-backup');
  assert.ok(!('notes' in parsed));
  assert.deepEqual(store.parseEncryptedBackup(file), env);

  // Plain backups and other JSON are "not an encrypted backup", so the plain path handles them.
  const notEnc = (t) => assert.throws(() => store.parseEncryptedBackup(t), (e) => e instanceof store.StoreError && e.message === 'not-encrypted-backup');
  notEnc(store.makeBackup([]));
  notEnc('{"hello": 1}');
  notEnc('not json');
  notEnc('[]');
  // Something claiming to be an encrypted backup but damaged is reported as damaged.
  const damaged = (patch) => assert.throws(
    () => store.parseEncryptedBackup(JSON.stringify({ ...parsed, ...patch })),
    (e) => e instanceof store.StoreError && /damaged/.test(e.message),
  );
  damaged({ cipher: { ...env, iter: 10 } });
  damaged({ cipher: { ...env, data: 'not base64!' } });
  damaged({ cipher: { ...env, kdf: 'MD5' } });
  damaged({ cipher: null });
  damaged({ v: 2 });
  assert.throws(() => store.makeEncryptedBackup({ ...env, iv: '' }), store.StoreError);
});

test('vault settings are validated booleans that default to on', () => {
  assert.equal(store.DEFAULT_SETTINGS.lockOnHide, true);
  assert.equal(store.DEFAULT_SETTINGS.clearClipboard, true);
  const s = store.validateState({ v: 1, settings: { lockOnHide: 'false', clearClipboard: 0 } }).settings;
  assert.equal(s.lockOnHide, true);
  assert.equal(s.clearClipboard, true);
  const off = store.validateState({ v: 1, settings: { lockOnHide: false, clearClipboard: false } }).settings;
  assert.equal(off.lockOnHide, false);
  assert.equal(off.clearClipboard, false);
});

const VALID_COPY = () => store.serialize({ notes: [store.createNote('hello', 1000, ID)], settings: { ...store.DEFAULT_SETTINGS }, activeId: ID });

test('pickState prefers a valid main copy', () => {
  const r = store.pickState(VALID_COPY(), VALID_COPY());
  assert.equal(r.source, 'main');
  assert.equal(r.unreadable, false);
  assert.equal(r.state.notes.length, 1);
});

test('pickState falls back to backup when main is damaged', () => {
  for (const bad of ['', '   ', '{"v":1,"notes":[', '\uFEFFgarbage', 'null', '[]']) {
    const r = store.pickState(bad, VALID_COPY());
    assert.equal(r.source, 'backup', JSON.stringify(bad));
    assert.equal(r.unreadable, true, JSON.stringify(bad));
    assert.equal(r.state.notes.length, 1);
  }
});

test('pickState uses backup without a warning when main is missing', () => {
  const r = store.pickState(null, VALID_COPY());
  assert.equal(r.source, 'backup');
  assert.equal(r.unreadable, false);
});

test('pickState reports none when both are unusable', () => {
  const bad = store.pickState('x', 'y');
  assert.equal(bad.source, 'none');
  assert.equal(bad.unreadable, true);
  assert.deepEqual(bad.state.notes, []);
  const none = store.pickState(null, null);
  assert.equal(none.source, 'none');
  assert.equal(none.unreadable, false);
});

test('pickState keeps a valid main and flags a damaged backup', () => {
  const r = store.pickState(VALID_COPY(), 'garbage');
  assert.equal(r.source, 'main');
  assert.equal(r.unreadable, true);
  assert.equal(r.state.notes.length, 1);
});

// ---- file links

const LINK = '0123456789abcdef0123456789abcdef';
const withFile = (file, extra = {}) => ({ id: ID, body: 'x', created: 1, updated: 1, file, ...extra });

test('validateNote keeps a valid file link and rebuilds it field by field', () => {
  const n = store.validateNote(withFile({ linkId: LINK, name: 'a.md', format: 'md', path: 'C:\\x' }));
  assert.deepEqual(n.file, { linkId: LINK, name: 'a.md', format: 'md' });
  assert.deepEqual(store.FILE_FORMATS, ['txt', 'md', 'cpnote']);
  assert.equal(store.createNote('a').file, null);
  assert.equal(store.validateNote({ id: ID, body: '' }).file, null);
  const round = store.parseStored(store.serialize({ notes: [n], settings: { ...store.DEFAULT_SETTINGS }, activeId: ID }));
  assert.deepEqual(round.notes[0].file, { linkId: LINK, name: 'a.md', format: 'md' });
});

test("validateNote drops a link whose format doesn't match encryption", () => {
  assert.equal(store.validateNote(withFile({ linkId: LINK, name: 'a.cpnote', format: 'cpnote' })).file, null);
  assert.equal(store.validateNote(withFile({ linkId: LINK, name: 'a.md', format: 'md' }, { body: '', cipher: ENV })).file, null);
  assert.equal(store.validateNote(withFile({ linkId: LINK, name: 'a.txt', format: 'txt' }, { body: '', cipher: ENV })).file, null);
  assert.deepEqual(store.validateNote(withFile({ linkId: LINK, name: 'a.cpnote', format: 'cpnote' }, { body: '', cipher: ENV })).file,
    { linkId: LINK, name: 'a.cpnote', format: 'cpnote' });
});

test('validateNote drops malformed links', () => {
  const bad = [
    { linkId: 'ABC', name: 'a.md', format: 'md' },
    { linkId: LINK.toUpperCase(), name: 'a.md', format: 'md' },
    { linkId: LINK, name: 'a/b', format: 'md' },
    { linkId: LINK, name: 'a\\b', format: 'md' },
    { linkId: LINK, name: '', format: 'md' },
    { linkId: LINK, name: 'x'.repeat(256), format: 'md' },
    { linkId: LINK, name: 'a\nb', format: 'md' },
    { linkId: LINK, name: 'a\u007fb', format: 'md' },
    { linkId: LINK, name: 5, format: 'md' },
    { linkId: LINK, name: 'a.md', format: 'html' },
    'string', [], 7, true,
  ];
  for (const f of bad) assert.equal(store.validateNote(withFile(f)).file, null, JSON.stringify(f));
  assert.equal(store.validateNote(withFile({ linkId: LINK, name: 'x'.repeat(255), format: 'txt' })).file.name.length, 255);
});

test('backups never carry file links', () => {
  const linked = store.validateNote(withFile({ linkId: LINK, name: 'a.md', format: 'md' }));
  const out = JSON.parse(store.makeBackup([linked]));
  assert.equal(out.notes[0].file, null);
  const crafted = JSON.stringify({ app: 'cyberpad', v: 1, notes: [withFile({ linkId: LINK, name: 'a.md', format: 'md' })] });
  assert.equal(store.parseBackup(crafted)[0].file, null);
});

test('mergeNotes strips links from incoming notes', () => {
  const linked = store.validateNote(withFile({ linkId: LINK, name: 'a.md', format: 'md' }));
  const r = store.mergeNotes([linked], [{ ...linked }, { ...linked, id: '1f8fad5b-d9cb-469f-a165-70867728950e' }]);
  assert.equal(r.notes[0].file.linkId, LINK);
  assert.equal(r.notes[1].file, null);
  assert.equal(r.notes[2].file, null);
});

test('validateNotes keeps a duplicate link id only on the first note', () => {
  const ID2 = '1f8fad5b-d9cb-469f-a165-70867728950e';
  const file = { linkId: LINK, name: 'a.md', format: 'md' };
  const notes = store.parseStored(JSON.stringify({ v: 1, notes: [
    { id: ID, body: 'a', created: 1, updated: 1, file },
    { id: ID2, body: 'b', created: 1, updated: 1, file },
  ] })).notes;
  assert.deepEqual(notes[0].file, file);
  assert.equal(notes[1].file, null);
});

test('cleanFolder accepts a tidy name and rejects everything else', () => {
  assert.equal(store.cleanFolder('  Client   work '), 'Client work');
  assert.equal(store.cleanFolder('a'.repeat(40)), 'a'.repeat(40));
  for (const bad of ['', '   ', 'a'.repeat(41), 'a/b', 'a\\b', 'a\u0008b', 'a\nb', '​', '​‍', '⁠ ﻿', '\u0085', 'a\u0000b', 'a\u007fb', 7, null, undefined, {}, ['x'], true]) {
    assert.equal(store.cleanFolder(bad), '');
  }
  assert.equal(store.cleanFolder('__proto__'), '__proto__');
  assert.equal(store.cleanFolder('A​B'), 'A​B');
});

test('mergeNotes does not push the folder count past the limit', () => {
  const mk = (i, folder) => ({ ...store.createNote('n', 1, `id-${String(i).padStart(8, '0')}`), folder });
  const existing = Array.from({ length: store.LIMITS.folders }, (_, i) => mk(i, `F${i}`));
  const incoming = [mk(500, 'Brand new'), mk(501, 'F7'), mk(502, 'Brand new')];
  const r = store.mergeNotes(existing, incoming);
  const byId = (id) => r.notes.find((n) => n.id === id);
  assert.equal(byId('id-00000500').folder, '');
  assert.equal(byId('id-00000501').folder, 'F7');
  assert.equal(byId('id-00000502').folder, '');
  assert.equal(store.folderList(r.notes).length, store.LIMITS.folders);
});

test('notes keep a valid folder through validate, serialize and backup', () => {
  const n = { ...store.createNote('hi', 1000, 'a'.repeat(32)), folder: 'Clients' };
  assert.equal(store.createNote('x').folder, '');
  const state = store.validateState(JSON.parse(store.serialize({ notes: [n], settings: store.DEFAULT_SETTINGS, activeId: n.id })));
  assert.equal(state.notes[0].folder, 'Clients');
  assert.equal(store.parseBackup(store.makeBackup([n]))[0].folder, 'Clients');
});

test('data written before folders existed loads with no folder', () => {
  const old = { v: 1, activeId: null, settings: { theme: 'amber' }, notes: [{ id: 'b'.repeat(32), body: 'old', pinned: true, created: 1, updated: 2, history: [] }] };
  const state = store.validateState(old);
  assert.equal(state.notes.length, 1);
  assert.equal(state.notes[0].folder, '');
  assert.equal(state.notes[0].pinned, true);
  assert.equal(state.settings.arrows, true);
  assert.deepEqual(state.settings.collapsedFolders, []);
});

test('bad folder values are dropped, the note is kept', () => {
  const mk = (i, folder) => ({ id: String(i).padStart(32, '0'), body: 'x', created: 1, updated: 1, folder });
  const notes = store.validateNotes([mk(1, 'a/b'), mk(2, 5), mk(3, 'x'.repeat(5000)), mk(4, 'line\nbreak'), mk(5, 'Fine')], 10);
  assert.deepEqual(notes.map((n) => n.folder), ['', '', '', '', 'Fine']);
});

test('at most 100 distinct folders survive validation', () => {
  const list = Array.from({ length: 120 }, (_, i) => ({ id: String(i).padStart(32, '0'), body: 'x', created: 1, updated: 1, folder: `F${i}` }));
  const notes = store.validateNotes(list, 10);
  assert.equal(notes.length, 120);
  assert.equal(new Set(notes.map((n) => n.folder).filter(Boolean)).size, 100);
  assert.equal(notes[100].folder, '');
});

test('folderList counts and sorts, ignoring case', () => {
  const f = (folder) => ({ ...store.createNote('x'), folder });
  assert.deepEqual(store.folderList([f('beta'), f('Alpha'), f(''), f('beta'), f('alpha')]),
    [{ name: 'Alpha', count: 1 }, { name: 'alpha', count: 1 }, { name: 'beta', count: 2 }]);
  assert.deepEqual(store.folderList([]), []);
});

test('collapsedFolders and arrows settings are validated', () => {
  const s = store.validateSettings({ arrows: false, collapsedFolders: ['A', 'A', 'b/c', 9, ' x', 'B'] });
  assert.equal(s.arrows, false);
  assert.deepEqual(s.collapsedFolders, ['A', 'B']);
  assert.deepEqual(store.validateSettings({ arrows: 'no', collapsedFolders: 'A' }).collapsedFolders, []);
  assert.equal(store.validateSettings({ arrows: 'no' }).arrows, true);
});
