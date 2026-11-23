'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vault = require('../js/core/vault.js');

const ITER = vault.MIN_ITERATIONS; // keep tests fast; the app uses DEFAULT_ITERATIONS

test('seal and unlock round-trip', async () => {
  const k = await vault.createKey('correct horse battery', ITER);
  const env = await vault.seal(k, 'secret ✓ text');
  assert.equal(env.v, 1);
  assert.equal(env.kdf, 'PBKDF2-SHA256');
  assert.ok(!env.data.includes('secret'));
  const { text, keyInfo } = await vault.unlock('correct horse battery', env);
  assert.equal(text, 'secret ✓ text');
  assert.equal(await vault.open(keyInfo, await vault.seal(keyInfo, 'again')), 'again');
});

test('every seal uses a fresh IV', async () => {
  const k = await vault.createKey('correct horse battery', ITER);
  const a = await vault.seal(k, 'same');
  const b = await vault.seal(k, 'same');
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.data, b.data);
});

test('wrong passphrase fails closed', async () => {
  const k = await vault.createKey('correct horse battery', ITER);
  const env = await vault.seal(k, 'secret');
  await assert.rejects(vault.unlock('wrong passphrase!', env), vault.VaultError);
});

test('tampered ciphertext is rejected', async () => {
  const k = await vault.createKey('correct horse battery', ITER);
  const env = await vault.seal(k, 'secret');
  const bytes = Buffer.from(env.data, 'base64');
  bytes[0] ^= 1;
  await assert.rejects(vault.open(k, { ...env, data: bytes.toString('base64') }), vault.VaultError);
});

test('short passphrases and unsafe envelopes are refused', async () => {
  await assert.rejects(vault.createKey('short', ITER), vault.VaultError);
  const k = await vault.createKey('correct horse battery', ITER);
  const env = await vault.seal(k, 'secret');
  await assert.rejects(vault.unlock('correct horse battery', { ...env, iter: 1 }), vault.VaultError);
  await assert.rejects(vault.unlock('correct horse battery', { ...env, v: 2 }), vault.VaultError);
  await assert.rejects(vault.unlock('correct horse battery', { ...env, iv: '!!' }), vault.VaultError);
});

test('strength hint', () => {
  assert.equal(vault.strength('abc').level, 0);
  assert.equal(vault.strength('abcdefgh').level, 1);
  assert.equal(vault.strength('Tr0ub4dor&3-long-phrase').level, 3);
});

test('backup and note ciphertexts are bound to their purpose', async () => {
  const k = await vault.createKey('correct horse battery', ITER);
  const backup = await vault.seal(k, '{"app":"cyberpad"}', 'backup');
  const { text } = await vault.unlock('correct horse battery', backup, 'backup');
  assert.equal(text, '{"app":"cyberpad"}');
  // A backup cannot be opened as a note, nor a note as a backup.
  await assert.rejects(vault.unlock('correct horse battery', backup), vault.VaultError);
  const note = await vault.seal(k, 'note body');
  await assert.rejects(vault.open(k, note, 'backup'), vault.VaultError);
  await assert.rejects(vault.seal(k, 'x', 'toString'), vault.VaultError);
  await assert.rejects(vault.unlock('correct horse battery', backup, '__proto__'), vault.VaultError);
});
