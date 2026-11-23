/*
 * Per-note encryption with the Web Crypto API.
 *   Key derivation: PBKDF2-HMAC-SHA256, 600k iterations, 16-byte random salt.
 *   Cipher: AES-256-GCM, fresh random 12-byte IV for every seal.
 * Derived keys are non-extractable CryptoKeys; passphrases are never stored.
 * Envelopes carry a version field so the scheme can be rotated later.
 */
(function (root, factory) {
  'use strict';
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else (root.NP = root.NP || {}).vault = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = 1;
  const KDF = 'PBKDF2-SHA256';
  const DEFAULT_ITERATIONS = 600000;
  const MIN_ITERATIONS = 100000;
  const MAX_ITERATIONS = 5000000;
  const MIN_PASSPHRASE = 8;
  const MAX_PASSPHRASE = 1024;
  // Protocol constants bound into every ciphertext as AES-GCM additional data,
  // one per purpose, so a backup can never be decrypted as a note or vice versa.
  // The note value keeps the app's original name on purpose: changing it would
  // make existing encrypted notes unreadable.
  const AAD = Object.freeze({
    note: new TextEncoder().encode('neonpad:v1'),
    backup: new TextEncoder().encode('cyberpad:backup:v1'),
  });

  function aadFor(purpose) {
    if (!Object.prototype.hasOwnProperty.call(AAD, purpose)) throw new VaultError('Unknown encryption purpose.');
    return AAD[purpose];
  }

  class VaultError extends Error {}

  function cryptoApi() {
    const c = globalThis.crypto;
    if (!c || !c.subtle || typeof c.getRandomValues !== 'function') {
      throw new VaultError('Encryption is unavailable in this browser context.');
    }
    return c;
  }

  function toB64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  function fromB64(s) {
    if (typeof s !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) {
      throw new VaultError('Encrypted data is damaged.');
    }
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function checkPassphrase(passphrase) {
    if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE) {
      throw new VaultError(`Use a passphrase of at least ${MIN_PASSPHRASE} characters.`);
    }
    if (passphrase.length > MAX_PASSPHRASE) throw new VaultError('That passphrase is too long.');
  }

  async function deriveKey(passphrase, salt, iterations) {
    checkPassphrase(passphrase);
    if (!Number.isSafeInteger(iterations) || iterations < 1) throw new VaultError('Invalid key settings.');
    const { subtle } = cryptoApi();
    const base = await subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  /** Create a fresh key (new random salt) from a passphrase. */
  async function createKey(passphrase, iterations = DEFAULT_ITERATIONS) {
    const salt = cryptoApi().getRandomValues(new Uint8Array(16));
    const key = await deriveKey(passphrase, salt, iterations);
    return { key, salt: toB64(salt), iterations };
  }

  /** Encrypt text with an unlocked key. A new IV is generated every time. */
  async function seal(keyInfo, plaintext, purpose = 'note') {
    const c = cryptoApi();
    const additionalData = aadFor(purpose);
    const iv = c.getRandomValues(new Uint8Array(12));
    const ct = await c.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, keyInfo.key, new TextEncoder().encode(plaintext));
    return { v: VERSION, kdf: KDF, iter: keyInfo.iterations, salt: keyInfo.salt, iv: toB64(iv), data: toB64(new Uint8Array(ct)) };
  }

  function checkEnvelope(env) {
    if (!env || env.v !== VERSION || env.kdf !== KDF) throw new VaultError('This note was encrypted with an unsupported format.');
  }

  async function open(keyInfo, env, purpose = 'note') {
    checkEnvelope(env);
    const additionalData = aadFor(purpose);
    const { subtle } = cryptoApi();
    let pt;
    try {
      pt = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(env.iv), additionalData }, keyInfo.key, fromB64(env.data));
    } catch (err) {
      if (err && err.name === 'OperationError') throw new VaultError('Wrong passphrase, or the encrypted data is damaged.');
      throw err;
    }
    return new TextDecoder().decode(pt);
  }

  /** Derive the key stored in an envelope's parameters and decrypt it. */
  async function unlock(passphrase, env, purpose = 'note') {
    checkEnvelope(env);
    aadFor(purpose);
    if (!Number.isSafeInteger(env.iter) || env.iter < MIN_ITERATIONS || env.iter > MAX_ITERATIONS) {
      throw new VaultError('This note has unsafe key settings and was not opened.');
    }
    const key = await deriveKey(passphrase, fromB64(env.salt), env.iter);
    const keyInfo = { key, salt: env.salt, iterations: env.iter };
    const text = await open(keyInfo, env, purpose);
    return { keyInfo, text };
  }

  /** Rough strength hint for the UI. Not a security control. */
  function strength(p) {
    if (typeof p !== 'string' || p.length < MIN_PASSPHRASE) return { level: 0, label: `At least ${MIN_PASSPHRASE} characters` };
    let classes = 0;
    if (/[a-z]/.test(p)) classes++;
    if (/[A-Z]/.test(p)) classes++;
    if (/\d/.test(p)) classes++;
    if (/[^A-Za-z0-9]/.test(p)) classes++;
    const score = p.length + classes * 3;
    if (score >= 26) return { level: 3, label: 'Strong' };
    if (score >= 18) return { level: 2, label: 'Fair' };
    return { level: 1, label: 'Weak: longer is better' };
  }

  return {
    VERSION, KDF, DEFAULT_ITERATIONS, MIN_ITERATIONS, MAX_ITERATIONS, MIN_PASSPHRASE,
    VaultError, createKey, seal, open, unlock, strength,
  };
});
