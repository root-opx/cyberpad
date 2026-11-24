'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlatform, PlatformError } = require('../js/platform.js');

const crypto = globalThis.crypto;

function fakeWebview() {
  const posted = [];
  let listener = null;
  const chrome = {
    webview: {
      postMessage: (m) => posted.push(m),
      addEventListener: (type, fn) => { if (type === 'message') listener = fn; },
    },
  };
  return { chrome, posted, reply: (obj) => listener({ data: obj }) };
}

function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

const env = (extra) => ({ crypto, setTimeout, clearTimeout, ...extra });
const lastId = (fake) => fake.posted[fake.posted.length - 1].id;
const tick = () => new Promise((r) => setImmediate(r));

test('detects desktop only when chrome.webview.postMessage exists', () => {
  const fake = fakeWebview();
  const d = createPlatform(env({ chrome: fake.chrome }));
  assert.equal(d.isDesktop, true);
  assert.equal(d.maxStateChars, 64 * 1024 * 1024);
  const b = createPlatform(env({ localStorage: fakeStorage() }));
  assert.equal(b.isDesktop, false);
  assert.equal(b.maxStateChars, Infinity);
  assert.equal(createPlatform(env({ chrome: { webview: {} } })).isDesktop, false);
});

test('desktop loadState sends load and resolves with the reply', async () => {
  const fake = fakeWebview();
  const p = createPlatform(env({ chrome: fake.chrome }));
  const promise = p.loadState();
  assert.equal(fake.posted[0].type, 'load');
  assert.match(fake.posted[0].id, /^[0-9a-f]{16}$/);
  fake.reply({ type: 'loaded', id: lastId(fake), main: 'm', backup: 'b', version: '1.0.0', dataDir: 'C:\\x' });
  const s = await promise;
  assert.deepEqual(s, { main: 'm', backup: 'b', legacyKey: null, storageOk: true, version: '1.0.0', dataDir: 'C:\\x' });
});

test('desktop saveState resolves on saved and rejects on saveFailed', async () => {
  const fake = fakeWebview();
  const p = createPlatform(env({ chrome: fake.chrome }));
  const ok = p.saveState('{}');
  assert.deepEqual(fake.posted[0], { type: 'save', id: lastId(fake), data: '{}' });
  fake.reply({ type: 'saved', id: lastId(fake) });
  await ok;
  const bad = p.saveState('{}');
  fake.reply({ type: 'saveFailed', id: lastId(fake), reason: 'Disk is full.' });
  await assert.rejects(bad, (e) => e instanceof PlatformError && e.reason === 'host' && e.message === 'Disk is full.');
  const rej = p.saveState('{}');
  fake.reply({ type: 'rejected', id: lastId(fake), reason: 'bad' });
  await assert.rejects(rej, (e) => e instanceof PlatformError && e.reason === 'host');
});

test('replies with unknown ids are ignored and requests time out', async () => {
  const fake = fakeWebview();
  const p = createPlatform(env({ chrome: fake.chrome }), { timeoutMs: 20 });
  const promise = p.saveState('{}');
  fake.reply({ type: 'saved', id: 'ffffffffffffffff' });
  await assert.rejects(promise, (e) => e instanceof PlatformError && e.reason === 'timeout');
});

test('saveState rejects oversize text without posting', async () => {
  const fake = fakeWebview();
  const p = createPlatform(env({ chrome: fake.chrome }));
  await assert.rejects(p.saveState('x'.repeat(p.maxStateChars + 1)), (e) => e.reason === 'too-large');
  assert.equal(fake.posted.length, 0);
});

test('desktop posts lone surrogates as U+FFFD', async () => {
  const fake = fakeWebview();
  const p = createPlatform(env({ chrome: fake.chrome }));
  const s = p.saveState('a\uD800b');
  assert.equal(fake.posted[0].data, 'a\uFFFDb');
  fake.reply({ type: 'saved', id: lastId(fake) });
  await s;
  const e = p.exportFile({ kind: 'note', suggestedName: 'n.md', text: 'a\uD800b', mime: 'text/markdown' });
  assert.equal(fake.posted[1].text, 'a\uFFFDb');
  assert.deepEqual(Object.keys(fake.posted[1]).sort(), ['id', 'kind', 'suggestedName', 'text', 'type']);
  fake.reply({ type: 'exported', id: lastId(fake), name: 'n.md' });
  assert.deepEqual(await e, { saved: true, name: 'n.md' });
});

test('exportFile resolves saved:false on exportCancelled and never times out', async () => {
  const fake = fakeWebview();
  const p = createPlatform(env({ chrome: fake.chrome }), { timeoutMs: 20 });
  const promise = p.exportFile({ kind: 'note', suggestedName: 'n.md', text: 't', mime: 'text/markdown' });
  await new Promise((r) => setTimeout(r, 60));
  fake.reply({ type: 'exportCancelled', id: lastId(fake) });
  assert.deepEqual(await promise, { saved: false, name: null });
  const failed = p.exportFile({ kind: 'note', suggestedName: 'n.md', text: 't', mime: 'text/markdown' });
  fake.reply({ type: 'exportFailed', id: lastId(fake), reason: 'Choose a folder outside the CyberPad data folder.' });
  await assert.rejects(failed, (e) => e instanceof PlatformError && e.reason === 'host'
    && e.message === 'Choose a folder outside the CyberPad data folder.' && e.userFacing === true);
});

test('host failure reasons are user-facing only for saveFailed and exportFailed', async () => {
  const fake = fakeWebview();
  const p = createPlatform(env({ chrome: fake.chrome }));
  const bad = p.saveState('{}');
  fake.reply({ type: 'saveFailed', id: lastId(fake), reason: 'The notes could not be saved to disk.' });
  await assert.rejects(bad, (e) => e.reason === 'host' && e.message === 'The notes could not be saved to disk.' && e.userFacing === true);
  const rej = p.saveState('{}');
  fake.reply({ type: 'rejected', id: lastId(fake), reason: 'unexpected field' });
  await assert.rejects(rej, (e) => e.reason === 'host' && e.userFacing === false);
  const noReason = p.saveState('{}');
  fake.reply({ type: 'saveFailed', id: lastId(fake) });
  await assert.rejects(noReason, (e) => e.reason === 'host' && e.userFacing === false);
  const tooLong = p.saveState('{}');
  fake.reply({ type: 'saveFailed', id: lastId(fake), reason: 'x'.repeat(301) });
  await assert.rejects(tooLong, (e) => e.reason === 'host' && e.userFacing === false && e.message.length < 301);
});

test('flush handler that throws posts flushFailed', async (t) => {
  t.mock.method(console, 'error', () => {});
  const fake = fakeWebview();
  const p = createPlatform(env({ chrome: fake.chrome }));
  p.onFlushRequest(async () => { throw new Error('x'); });
  fake.reply({ type: 'flush' });
  await tick(); await tick();
  assert.deepEqual(fake.posted, [{ type: 'flushFailed' }]);
});

test('flush handler resolving true posts flushed, exactly once per request', async () => {
  const fake = fakeWebview();
  const p = createPlatform(env({ chrome: fake.chrome }));
  p.onFlushRequest(async () => true);
  fake.reply({ type: 'flush' });
  await tick(); await tick();
  assert.deepEqual(fake.posted, [{ type: 'flushed' }]);
  fake.reply({ type: 'flush' });
  await tick(); await tick();
  assert.deepEqual(fake.posted, [{ type: 'flushed' }, { type: 'flushed' }]);
});

test('flush handler resolving false (or anything but true) posts flushFailed', async () => {
  const fake = fakeWebview();
  const p = createPlatform(env({ chrome: fake.chrome }));
  p.onFlushRequest(async () => false);
  fake.reply({ type: 'flush' });
  await tick(); await tick();
  p.onFlushRequest(async () => undefined);
  fake.reply({ type: 'flush' });
  await tick(); await tick();
  assert.deepEqual(fake.posted, [{ type: 'flushFailed' }, { type: 'flushFailed' }]);
});

test('flush with no handler registered yet posts flushed', async () => {
  const fake = fakeWebview();
  createPlatform(env({ chrome: fake.chrome }));
  fake.reply({ type: 'flush' });
  await tick(); await tick();
  assert.deepEqual(fake.posted, [{ type: 'flushed' }]);
});

test('a flush reply whose post throws never becomes an unhandled rejection', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    let listener = null;
    const chrome = { webview: { postMessage: () => { throw new Error('gone'); }, addEventListener: (type, fn) => { listener = fn; } } };
    const p = createPlatform(env({ chrome }));
    p.onFlushRequest(async () => true);
    listener({ data: { type: 'flush' } });
    await tick(); await tick(); await tick();
    assert.equal(unhandled.length, 0);
    assert.ok(errors.mock.calls.length >= 1);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('browser loadState adopts legacy key and reports storage failures', async (t) => {
  t.mock.method(console, 'error', () => {});
  const p = createPlatform(env({ localStorage: fakeStorage({ 'neonpad.v1': 'old' }) }));
  const s = await p.loadState();
  assert.equal(s.main, 'old');
  assert.equal(s.legacyKey, 'neonpad.v1');
  assert.equal(s.storageOk, true);
  const boom = { getItem() { throw new Error('denied'); } };
  const s2 = await createPlatform(env({ localStorage: boom })).loadState();
  assert.equal(s2.storageOk, false);
  assert.equal(s2.main, null);
});

test('browser saveState maps quota errors', async () => {
  const ls = { setItem() { throw new DOMException('full', 'QuotaExceededError'); } };
  const p = createPlatform(env({ localStorage: ls }));
  await assert.rejects(p.saveState('x'), (e) => e instanceof PlatformError && e.reason === 'quota');
});

// ---- file bridge

const LK = '0123456789abcdef0123456789abcdef';
const desktop = (opts) => { const fake = fakeWebview(); return { fake, p: createPlatform(env({ chrome: fake.chrome }), opts) }; };

test('saveAsFile posts saveAsFile or relinkFile and maps fileLinked/fileCancelled', async () => {
  const { fake, p } = desktop({ timeoutMs: 20 });
  const a = p.saveAsFile({ format: 'md', suggestedName: 'n.md', text: 'a\ud800' });
  const m = fake.posted[0];
  assert.deepEqual(Object.keys(m).sort(), ['format', 'id', 'suggestedName', 'text', 'type']);
  assert.equal(m.type, 'saveAsFile');
  assert.equal(m.text, 'a�');
  await new Promise((r) => setTimeout(r, 50)); // no timeout: a dialog may stay open
  fake.reply({ type: 'fileLinked', id: m.id, linkId: LK, name: 'n.md', format: 'md' });
  assert.deepEqual(await a, { linked: true, linkId: LK, name: 'n.md', format: 'md' });

  const b = p.saveAsFile({ format: 'txt', suggestedName: 'n', text: 't', relinkId: LK });
  const r = fake.posted[1];
  assert.equal(r.type, 'relinkFile');
  assert.deepEqual(Object.keys(r).sort(), ['format', 'id', 'linkId', 'suggestedName', 'text', 'type']);
  assert.equal(r.linkId, LK);
  fake.reply({ type: 'fileCancelled', id: r.id });
  assert.deepEqual(await b, { linked: false });
});

test('malformed host replies are rejected', async () => {
  const { fake, p } = desktop();
  const bad = [
    { type: 'fileLinked', linkId: 'zz', name: 'n', format: 'md' },
    { type: 'fileLinked', linkId: LK, name: '', format: 'md' },
    { type: 'fileLinked', linkId: LK, name: 'n', format: 'html' },
    { type: 'fileLinked', linkId: LK, name: 'x'.repeat(256), format: 'md' },
    { type: 'fileLinked', linkId: LK, name: 'a/b', format: 'md' },
    { type: 'fileWritten' },
  ];
  for (const reply of bad) {
    const pr = p.saveAsFile({ format: 'md', suggestedName: 'n', text: 't' });
    fake.reply({ ...reply, id: lastId(fake) });
    await assert.rejects(pr, (e) => e instanceof PlatformError && e.message === 'unexpected reply');
  }
  const o = p.openFile();
  fake.reply({ type: 'fileOpened', id: lastId(fake), linkId: LK, name: 'n', format: 'md', text: 5, alreadyLinked: false });
  await assert.rejects(o, /unexpected reply/);
  const o2 = p.openFile();
  fake.reply({ type: 'fileOpened', id: lastId(fake), linkId: LK, name: 'n', format: 'md', text: 't', alreadyLinked: 'no' });
  await assert.rejects(o2, /unexpected reply/);
  const o3 = p.openFile();
  assert.deepEqual(Object.keys(fake.posted.at(-1)).sort(), ['id', 'type']);
  fake.reply({ type: 'fileOpened', id: lastId(fake), linkId: LK, name: 'n', format: 'cpnote', text: 't', alreadyLinked: true });
  assert.deepEqual(await o3, { opened: true, linkId: LK, name: 'n', format: 'cpnote', text: 't', alreadyLinked: true });
  const o4 = p.openFile();
  fake.reply({ type: 'fileCancelled', id: lastId(fake) });
  assert.deepEqual(await o4, { opened: false });
});

test('writeFile maps written/conflict/missing and fileFailed', async () => {
  const { fake, p } = desktop();
  for (const [type, want] of [['fileWritten', 'written'], ['fileConflict', 'conflict'], ['fileMissing', 'missing']]) {
    const pr = p.writeFile(LK, 'x', false);
    const m = fake.posted.at(-1);
    assert.deepEqual(Object.keys(m).sort(), ['force', 'id', 'linkId', 'text', 'type']);
    assert.equal(m.force, false);
    fake.reply({ type, id: m.id });
    assert.equal(await pr, want);
  }
  const f = p.writeFile(LK, 'x', true);
  assert.equal(fake.posted.at(-1).force, true);
  fake.reply({ type: 'fileFailed', id: lastId(fake), reason: "Couldn't write the file.", linkId: LK });
  await assert.rejects(f, (e) => e.userFacing === true && e.message === "Couldn't write the file." && e.linkId === LK);
  const g = p.writeFile(LK, 'x', false);
  fake.reply({ type: 'fileFailed', id: lastId(fake), reason: 'r', linkId: 'nope' });
  await assert.rejects(g, (e) => e.linkId === undefined && e.userFacing === true);
  const h = p.writeFile(LK, 'x', false);
  fake.reply({ type: 'fileFailed', id: lastId(fake), reason: 'x'.repeat(301) });
  await assert.rejects(h, (e) => e.userFacing === false);
  const r = p.writeFile(LK, 'x', false);
  fake.reply({ type: 'rejected', id: lastId(fake), reason: 'unknown link' });
  await assert.rejects(r, (e) => e.userFacing === false && e.message === 'unknown link');
});

test('writeFile uses a 60 s timeout, other calls the default, dialogs none', () => {
  const timers = [];
  const fake = fakeWebview();
  const p = createPlatform({ crypto, clearTimeout, chrome: fake.chrome, setTimeout: (fn, ms) => { timers.push(ms); return 1; } }, { timeoutMs: 1234 });
  p.writeFile(LK, 'x', false);
  p.readFile(LK);
  p.saveAsFile({ format: 'md', suggestedName: 'n', text: 't' });
  p.openFile();
  assert.deepEqual(timers, [60000, 1234]);
});

test('readFile, checkFiles, unlinkFile, revealFile, pruneLinks', async () => {
  const { fake, p } = desktop();
  const r = p.readFile(LK);
  assert.deepEqual(Object.keys(fake.posted.at(-1)).sort(), ['id', 'linkId', 'type']);
  fake.reply({ type: 'fileRead', id: lastId(fake), text: 'hi' });
  assert.deepEqual(await r, { missing: false, text: 'hi' });
  const r2 = p.readFile(LK);
  fake.reply({ type: 'fileMissing', id: lastId(fake) });
  assert.deepEqual(await r2, { missing: true });
  const r3 = p.readFile(LK);
  fake.reply({ type: 'fileRead', id: lastId(fake), text: 7 });
  await assert.rejects(r3, /unexpected reply/);

  const c = p.checkFiles([LK]);
  assert.deepEqual(fake.posted.at(-1).linkIds, [LK]);
  const other = 'ffffffffffffffffffffffffffffffff';
  fake.reply({ type: 'fileStatus', id: lastId(fake), statuses: { [LK]: 'changed', [other]: 'bogus', nothex: 'ok' } });
  assert.deepEqual(await c, { [LK]: 'changed' });
  const c2 = p.checkFiles([LK]);
  fake.reply({ type: 'fileStatus', id: lastId(fake), statuses: [] });
  await assert.rejects(c2, /unexpected reply/);
  await assert.rejects(p.checkFiles(['bad']), PlatformError);
  await assert.rejects(p.checkFiles([LK, LK]), PlatformError);
  await assert.rejects(p.checkFiles(Array.from({ length: 2001 }, (_, i) => i.toString(16).padStart(32, '0'))), PlatformError);

  for (const [fn, ok, call] of [['unlinkFile', 'fileUnlinked', () => p.unlinkFile(LK)], ['revealFile', 'fileRevealed', () => p.revealFile(LK)], ['pruneLinks', 'linksPruned', () => p.pruneLinks([LK])]]) {
    const pr = call();
    assert.equal(fake.posted.at(-1).type, fn);
    fake.reply({ type: ok, id: lastId(fake) });
    assert.equal(await pr, undefined);
  }
  await assert.rejects(p.unlinkFile('nope'), PlatformError);
});

test('onOpenRequested fires on openRequested without an id; a later handler replaces the earlier', () => {
  const { fake, p } = desktop();
  let a = 0; let b = 0;
  p.onOpenRequested(() => { a += 1; });
  fake.reply({ type: 'openRequested' });
  p.onOpenRequested(() => { b += 1; });
  fake.reply({ type: 'openRequested' });
  assert.deepEqual([a, b], [1, 1]);
  p.onOpenRequested(() => { throw new Error('boom'); });
  const orig = console.error; console.error = () => {};
  try { fake.reply({ type: 'openRequested' }); } finally { console.error = orig; }
  createPlatform(env({ localStorage: fakeStorage() })).onOpenRequested(() => {});
});

test('file methods reject in the browser', async () => {
  const p = createPlatform(env({ localStorage: fakeStorage() }));
  const calls = [
    () => p.saveAsFile({ format: 'md', suggestedName: 'n', text: 't' }), () => p.openFile(), () => p.writeFile(LK, 't', false),
    () => p.readFile(LK), () => p.checkFiles([LK]), () => p.unlinkFile(LK), () => p.revealFile(LK), () => p.pruneLinks([LK]),
  ];
  for (const c of calls) {
    await assert.rejects(c(), (e) => e instanceof PlatformError && e.reason === 'host' && e.message === 'Files are only available in the desktop app.');
  }
});
