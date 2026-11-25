'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../js/core/filelink.js');

const ENV = { v: 1, kdf: 'PBKDF2-SHA256', iter: 600000, salt: 'AAAAAAAAAAAAAAAAAAAAAA==', iv: 'AAAAAAAAAAAAAAAA', data: 'AAAA' };
const plain = (body) => ({ id: 'x', body, cipher: null });
const secret = { id: 'x', body: 'SECRET', cipher: ENV };
const DAMAGED = 'This .cpnote file is damaged or not a CyberPad note.';
const cp = (o) => JSON.stringify({ app: 'cyberpad', kind: 'note', v: 1, cipher: ENV, ...o });

test('fileTextOf: plain note yields the body', () => {
  assert.equal(F.fileTextOf(plain('hello\nworld')), 'hello\nworld');
});

test('fileTextOf: encrypted note yields cpnote JSON without plaintext', () => {
  const t = F.fileTextOf(secret);
  assert.ok(!t.includes('SECRET'));
  assert.equal(t, JSON.stringify({ app: 'cyberpad', kind: 'note', v: 1, cipher: ENV }));
  assert.deepEqual(JSON.parse(t), { app: 'cyberpad', kind: 'note', v: 1, cipher: ENV });
});

test('fileTextOf: refuses an encrypted note without a cipher', () => {
  for (const c of [undefined, {}, 'x', 5]) assert.throws(() => F.fileTextOf({ id: 'x', body: '', cipher: c }), F.FileLinkError);
});

test('parseCpnote accepts its own output and rejects damage', () => {
  assert.deepEqual(F.parseCpnote(F.fileTextOf(secret)), ENV);
  const bad = [
    '{', '', 'null', '[]', '"x"', '7',
    cp({ app: 'other' }), cp({ kind: 'backup' }), cp({ v: 2 }), cp({ v: '1' }),
    cp({ cipher: { ...ENV, iter: 1 } }), cp({ cipher: null }), cp({ cipher: 'x' }),
    cp({ extra: true }),
    JSON.stringify({ app: 'cyberpad', kind: 'note', v: 1 }),
  ];
  for (const t of bad) {
    assert.throws(() => F.parseCpnote(t), (e) => e instanceof F.FileLinkError && e.message === DAMAGED, t);
  }
  assert.throws(() => F.parseCpnote(undefined), F.FileLinkError);
});

test('formatsFor follows encryption state', () => {
  assert.deepEqual(F.formatsFor(plain('a')), ['txt', 'md']);
  assert.deepEqual(F.formatsFor(secret), ['cpnote']);
});

test('suggestedFileName slugs, caps and falls back', () => {
  assert.equal(F.suggestedFileName('Hello World!', 'md'), 'hello-world.md');
  assert.equal(F.suggestedFileName('Plan', 'txt'), 'plan.txt');
  assert.equal(F.suggestedFileName('Plan', 'cpnote'), 'plan.cpnote');
  assert.equal(F.suggestedFileName('', 'txt'), 'note.txt');
  assert.equal(F.suggestedFileName('!!!', 'md'), 'note.md');
  for (const f of ['txt', 'md', 'cpnote']) {
    const n = F.suggestedFileName('a'.repeat(500), f);
    assert.ok(n.length <= 120 && n.endsWith('.' + f));
  }
  assert.throws(() => F.suggestedFileName('x', 'html'), F.FileLinkError);
  assert.throws(() => F.suggestedFileName('x', undefined), F.FileLinkError);
});

test('decide: changed file, nothing unwritten, idle 2s reloads', () => {
  assert.equal(F.decide({ status: 'changed', hasUnwritten: false, msSinceInput: 2000 }), 'reload');
  assert.equal(F.decide({ status: 'changed', hasUnwritten: false, msSinceInput: 99999 }), 'reload');
});

test('decide: recent typing with a changed file asks', () => {
  assert.equal(F.decide({ status: 'changed', hasUnwritten: false, msSinceInput: 1999 }), 'conflict');
});

test('decide: unwritten changes with a changed file asks', () => {
  assert.equal(F.decide({ status: 'changed', hasUnwritten: true, msSinceInput: 99999 }), 'conflict');
});

test('decide: missing and unknown', () => {
  assert.equal(F.decide({ status: 'missing', hasUnwritten: true, msSinceInput: 0 }), 'missing');
  assert.equal(F.decide({ status: 'unknown', hasUnwritten: true, msSinceInput: 0 }), 'none');
  assert.equal(F.decide({ status: 'ok', hasUnwritten: true, msSinceInput: 0 }), 'none');
  assert.equal(F.decide({ status: 'bogus', hasUnwritten: false, msSinceInput: 99999 }), 'none');
});

test('tracker confirms and detects unwritten text', () => {
  const t = F.createTracker();
  assert.equal(t.hasUnwritten('a', 'x'), true);
  t.confirm('a', 'x');
  assert.equal(t.hasUnwritten('a', 'x'), false);
  assert.equal(t.hasUnwritten('a', 'y'), true);
  assert.equal(t.hasUnwritten('b', 'x'), true);
  t.forget('a');
  assert.equal(t.hasUnwritten('a', 'x'), true);
});

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise((r) => setImmediate(r));

test('write queue coalesces and never overlaps', async () => {
  let running = 0, max = 0, calls = 0;
  const gates = [];
  const q = F.createWriteQueue(async () => {
    calls++; running++; max = Math.max(max, running);
    const d = deferred(); gates.push(d);
    await d.promise;
    running--;
  });
  q.request('a'); q.request('a'); q.request('a');
  await tick();
  assert.equal(calls, 1);
  gates[0].resolve(); await tick(); await tick();
  assert.equal(calls, 2);
  gates[1].resolve();
  await q.idle();
  assert.equal(calls, 2);
  assert.equal(max, 1);
});

test('write queue: different notes are independent', async () => {
  const seen = [];
  const q = F.createWriteQueue(async (id) => { seen.push(id); });
  q.request('a'); q.request('b');
  await q.idle();
  assert.deepEqual(seen.sort(), ['a', 'b']);
});

test('write queue survives a rejecting writer and still runs the follow-up', async () => {
  let calls = 0;
  const gate = deferred();
  const q = F.createWriteQueue(async () => {
    calls++;
    if (calls === 1) { await gate.promise; throw new Error('disk'); }
  });
  q.request('a'); q.request('a');
  await tick();
  gate.resolve();
  await q.idle();
  assert.equal(calls, 2);
  q.request('a');
  await q.idle();
  assert.equal(calls, 3);
});

test('write queue: idle resolves immediately when nothing is running', async () => {
  await F.createWriteQueue(async () => {}).idle();
});

test('matchesFile: plain notes compare text exactly', () => {
  assert.equal(F.matchesFile(plain('a\nb'), 'a\nb'), true);
  assert.equal(F.matchesFile(plain('a\nb'), 'a\nb\n'), false);
  assert.equal(F.matchesFile(plain('x'), undefined), false);
  assert.equal(F.matchesFile(plain('x'), 5), false);
});

test('matchesFile: encrypted notes compare envelopes, not JSON formatting', () => {
  assert.equal(F.matchesFile(secret, F.fileTextOf(secret)), true);
  const pretty = JSON.stringify({ cipher: { data: ENV.data, iv: ENV.iv, salt: ENV.salt, iter: ENV.iter, kdf: ENV.kdf, v: 1 }, v: 1, kind: 'note', app: 'cyberpad' }, null, 2);
  assert.equal(F.matchesFile(secret, pretty), true);
  assert.equal(F.matchesFile(secret, cp({ cipher: { ...ENV, data: 'BBBB' } })), false);
  assert.equal(F.matchesFile(secret, '{'), false);
  assert.equal(F.matchesFile(secret, 'SECRET'), false);
  assert.equal(F.matchesFile({ id: 'x', body: '', cipher: {} }, '{}'), false);
});

const LINK = 'a'.repeat(32);

test('noteFromFile: plain text becomes a linked plain note', () => {
  const n = F.noteFromFile({ linkId: LINK, name: 'notes.md', format: 'md', text: 'hello' }, 1000);
  assert.equal(n.body, 'hello');
  assert.equal(n.cipher, null);
  assert.deepEqual(n.history, []);
  assert.deepEqual(n.file, { linkId: LINK, name: 'notes.md', format: 'md' });
  assert.equal(n.created, 1000);
});

test('noteFromFile: .cpnote becomes a locked encrypted note with the envelope only', () => {
  const n = F.noteFromFile({ linkId: LINK, name: 'secret.cpnote', format: 'cpnote', text: F.fileTextOf(secret) });
  assert.deepEqual(n.cipher, ENV);
  assert.equal(n.body, '');
  assert.deepEqual(n.file, { linkId: LINK, name: 'secret.cpnote', format: 'cpnote' });
  assert.equal(F.matchesFile(n, F.fileTextOf(secret)), true);
});

test('noteFromFile: refuses damaged, oversized and invalid files', () => {
  const ok = { linkId: LINK, name: 'a.txt', format: 'txt', text: 'x' };
  assert.throws(() => F.noteFromFile({ ...ok, format: 'cpnote', name: 'a.cpnote', text: '{' }), { message: DAMAGED });
  assert.throws(() => F.noteFromFile({ ...ok, text: 'x'.repeat(1000001) }), F.FileLinkError);
  assert.throws(() => F.noteFromFile({ ...ok, format: 'html' }), F.FileLinkError);
  assert.throws(() => F.noteFromFile({ ...ok, linkId: 'nope' }), F.FileLinkError);
  assert.throws(() => F.noteFromFile({ ...ok, name: 'a/b.txt' }), F.FileLinkError);
  assert.throws(() => F.noteFromFile({ ...ok, text: 7 }), F.FileLinkError);
  assert.throws(() => F.noteFromFile(null), F.FileLinkError);
  assert.equal(F.noteFromFile({ ...ok, text: 'x'.repeat(1000000) }).body.length, 1000000);
});

test('seedAction: a file equal to the note confirms when unchanged and adopts when changed', () => {
  for (const source of ['main', 'backup']) {
    assert.equal(F.seedAction({ status: 'ok', equal: true, source }), 'confirm');
    assert.equal(F.seedAction({ status: 'changed', equal: true, source }), 'adopt');
  }
});

test('seedAction: an unchanged file older than the note is written only after a normal load', () => {
  assert.equal(F.seedAction({ status: 'ok', equal: false, source: 'main' }), 'write');
  // Restored from notes.json.bak (or anything else): the file may be newer than the note, so ask.
  for (const source of ['backup', 'none', undefined, 'MAIN']) {
    assert.equal(F.seedAction({ status: 'ok', equal: false, source }), 'conflict', String(source));
  }
});

test('seedAction: a changed, different file is a conflict whatever the source', () => {
  for (const source of ['main', 'backup']) assert.equal(F.seedAction({ status: 'changed', equal: false, source }), 'conflict');
});

test('seedAction: a changed, different file reloads only when the note matches the last write and the load was normal', () => {
  assert.equal(F.seedAction({ status: 'changed', equal: false, source: 'main', matchesLast: true }), 'reload');
  assert.equal(F.seedAction({ status: 'changed', equal: false, source: 'backup', matchesLast: true }), 'conflict');
  for (const matchesLast of [false, undefined, 'yes', 1, null]) {
    assert.equal(F.seedAction({ status: 'changed', equal: false, source: 'main', matchesLast }), 'conflict', String(matchesLast));
  }
  // Unchanged behaviour around it.
  assert.equal(F.seedAction({ status: 'changed', equal: true, source: 'main', matchesLast: true }), 'adopt');
  assert.equal(F.seedAction({ status: 'ok', equal: false, source: 'main', matchesLast: true }), 'write');
  assert.equal(F.seedAction({ status: 'ok', equal: false, source: 'backup', matchesLast: true }), 'conflict');
  assert.equal(F.seedAction({ status: 'missing', equal: false, source: 'main', matchesLast: true }), 'missing');
  assert.equal(F.seedAction({ status: 'unknown', equal: false, source: 'main', matchesLast: true }), 'none');
});

test('seedAction: missing and unknown statuses', () => {
  for (const source of ['main', 'backup']) {
    assert.equal(F.seedAction({ status: 'missing', equal: false, source }), 'missing');
    assert.equal(F.seedAction({ status: 'unknown', equal: true, source }), 'none');
    assert.equal(F.seedAction({ status: 'bogus', equal: false, source }), 'none');
  }
  assert.equal(F.seedAction({ status: 'ok', equal: 'yes', source: 'main' }), 'write'); // only true counts as equal
});

class FakePlatformError extends Error {
  constructor(reason, message, userFacing = false) { super(message || reason); this.reason = reason; this.userFacing = userFacing; }
}

test('isUnknownLink: only the host rejection "unknown link" counts', () => {
  assert.equal(F.isUnknownLink(new FakePlatformError('host', 'unknown link')), true);
  assert.equal(F.isUnknownLink(new FakePlatformError('host', 'Unknown link')), false);
  assert.equal(F.isUnknownLink(new FakePlatformError('host', 'unknown link ')), false);
  assert.equal(F.isUnknownLink(new FakePlatformError('host', 'invalid linkId')), false);
  assert.equal(F.isUnknownLink(new FakePlatformError('timeout', 'unknown link')), false);
  // A user-facing failure (fileFailed) is never a stale-link signal, whatever its text.
  assert.equal(F.isUnknownLink(new FakePlatformError('host', 'unknown link', true)), false);
  assert.equal(F.isUnknownLink(new Error('unknown link')), false);
  for (const v of [null, undefined, 'unknown link', { reason: 'host', message: 'unknown link' }]) assert.equal(F.isUnknownLink(v), false);
});
