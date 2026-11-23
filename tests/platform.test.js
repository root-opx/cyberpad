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
  fake.reply({ type: 'exportFailed', id: lastId(fake), reason: 'nope' });
  await assert.rejects(failed, (e) => e.reason === 'host');
});

test('flush handler that throws still posts flushed', async (t) => {
  t.mock.method(console, 'error', () => {});
  const fake = fakeWebview();
  const p = createPlatform(env({ chrome: fake.chrome }));
  p.onFlushRequest(async () => { throw new Error('x'); });
  fake.reply({ type: 'flush' });
  await tick(); await tick();
  assert.ok(fake.posted.some((m) => m.type === 'flushed'));
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
