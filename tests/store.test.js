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
  assert.deepEqual(notes[0], { id: ID, body: 'ok', cipher: null, pinned: false, created: 7, updated: 7, history: [{ t: 5, body: 'old' }] });
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
