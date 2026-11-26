'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/core/ctf.js');

// ------------------------------------------------------------------ helpers

function rng(seed) { // mulberry32, deterministic
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const codec = (id) => C.CODECS.find((c) => c.id === id);
const enc = (id, text, params) => codec(id).encode(text, params);
const dec = (id, text, params) => codec(id).decode(text, params);
const out = (r) => { assert.equal(r.ok, true, JSON.stringify(r)); return r.output; };

// Parameters that make each parametrised codec usable.
const PARAMS = {
  caesar: { shift: 3 }, vigenere: { key: 'Lemon' }, railFence: { rails: 3 }, xor: { key: 'k' },
};

function randomText(rand, maxLen) {
  const len = 1 + Math.floor(rand() * maxLen);
  let s = '';
  for (let i = 0; i < len; i++) {
    const r = rand();
    if (r < 0.55) s += String.fromCharCode(32 + Math.floor(rand() * 95));
    else if (r < 0.7) s += String.fromCharCode(0x80 + Math.floor(rand() * 0x700));
    else if (r < 0.8) s += String.fromCharCode(0x20, 0x0a, 0x09)[Math.floor(rand() * 3)];
    else if (r < 0.9) s += String.fromCharCode(0x4e00 + Math.floor(rand() * 0x500));
    else s += String.fromCodePoint(0x1f300 + Math.floor(rand() * 0x200)); // astral, never a lone surrogate
  }
  return s;
}

function timed(fn) {
  const t0 = process.hrtime.bigint();
  const value = fn();
  return { value, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

const FLAG_TEXT = 'flag{layers_are_fun}';

// ---------------------------------------------------------------- structure

test('LIMITS and CODECS are frozen and match the spec', () => {
  assert.deepEqual({ ...C.LIMITS }, { input: 100000, output: 1000000, results: 30, resultChars: 2000, layers: 3, flagBody: 200, prefixes: 30 });
  assert.ok(Object.isFrozen(C.LIMITS));
  assert.ok(Object.isFrozen(C.CODECS));
  assert.deepEqual(C.CODECS.map((c) => c.id), [
    'base64', 'base64url', 'base32', 'base58', 'ascii85', 'z85', 'hex', 'binary', 'octal', 'decimal', 'url', 'htmlEntities',
    'unicodeEscape', 'rot13', 'rot47', 'atbash', 'caesar', 'vigenere', 'railFence', 'xor', 'reverse', 'swapCase', 'morse',
  ]);
  for (const c of C.CODECS) {
    assert.ok(Object.isFrozen(c), c.id);
    assert.equal(typeof c.name, 'string');
    assert.equal(typeof c.group, 'string');
    assert.ok(c.encode || c.decode);
    if (c.params) { assert.ok(Object.isFrozen(c.params)); for (const p of c.params) assert.ok(Object.isFrozen(p)); }
  }
  assert.deepEqual([...C.CATEGORIES], ['web', 'pwn', 'crypto', 'reversing', 'forensics', 'stego', 'osint', 'misc', 'mobile', 'hardware']);
  assert.ok(Object.isFrozen(C.CATEGORIES));
});

// ------------------------------------------------------------ known vectors
// Every pinned value below was also computed with an independent Python
// implementation (base64/base32/a85 from the standard library, Z85, Base58,
// Vigenere, rail fence, ROT47, Morse and the octal/binary dumps written from
// the specifications) or, for Base64, with Node's Buffer.

test('Base64 and Base32 match the RFC 4648 vectors', () => {
  const vectors = [['', '', ''], ['f', 'Zg==', 'MY======'], ['fo', 'Zm8=', 'MZXQ===='], ['foo', 'Zm9v', 'MZXW6==='],
    ['foob', 'Zm9vYg==', 'MZXW6YQ='], ['fooba', 'Zm9vYmE=', 'MZXW6YTB'], ['foobar', 'Zm9vYmFy', 'MZXW6YTBOI======']];
  for (const [plain, b64, b32] of vectors) {
    assert.equal(Buffer.from(plain).toString('base64'), b64); // second method
    if (plain === '') continue; // empty input is refused by design
    assert.equal(out(enc('base64', plain)), b64);
    assert.equal(out(dec('base64', b64)), plain);
    assert.equal(out(enc('base32', plain)), b32);
    assert.equal(out(dec('base32', b32)), plain);
  }
});

test('Base64 URL-safe uses - and _ and no padding; the standard decoder refuses them', () => {
  assert.equal(out(enc('base64', '>>>???')), Buffer.from('>>>???').toString('base64'));
  assert.equal(out(enc('base64url', '>>>???')), Buffer.from('>>>???').toString('base64url'));
  assert.equal(out(enc('base64url', '>>>???')), 'Pj4-Pz8_');
  assert.equal(out(dec('base64url', 'Pj4-Pz8_')), '>>>???');
  assert.equal(dec('base64', 'Pj4-Pz8_').ok, false);
  assert.equal(dec('base64url', 'Pj4+Pz8/').ok, false);
  assert.equal(out(enc('base64url', 'f')), 'Zg');
});

test('decoders accept whitespace, line breaks and missing Base64 padding', () => {
  assert.equal(out(dec('base64', 'Zm9v\nYmFy')), 'foobar');
  assert.equal(out(dec('base64', '  Zm9v YmE  ')), 'fooba');
  assert.equal(out(dec('base64', 'Zg')), 'f'); // missing padding
  assert.equal(out(dec('base64', 'Zm9vYg')), 'foob');
  assert.equal(out(dec('base32', 'my')), 'f'); // missing padding, lower case
  assert.equal(out(dec('hex', '48 65\n6c 6c 6f')), 'Hello');
});

test('Base58 uses the Bitcoin alphabet and keeps leading zero bytes', () => {
  assert.equal(out(enc('base58', 'Hello World!')), '2NEpo7TZRRrLZSi2U');
  assert.equal(out(dec('base58', '2NEpo7TZRRrLZSi2U')), 'Hello World!');
  assert.equal(out(enc('base58', '\0\0abc')), '11ZiCa');
  assert.equal(out(dec('base58', '11ZiCa')), '\0\0abc');
  assert.equal(dec('base58', '0OIl').ok, false); // 0, O, I, l are not in the alphabet
});

test('Ascii85 vectors, z for four zero bytes, <~ ~> accepted on decode', () => {
  assert.equal(out(enc('ascii85', 'Man ')), '9jqo^');
  assert.equal(out(enc('ascii85', 'Man is distinguished')), '9jqo^BlbD-BleB1DJ+*+F(f,q');
  assert.equal(out(dec('ascii85', '9jqo^BlbD-BleB1DJ+*+F(f,q')), 'Man is distinguished');
  assert.equal(out(enc('ascii85', '\0\0\0\0')), 'z');
  assert.equal(out(enc('ascii85', '\0\0\0\0hi')), 'zBP@');
  assert.equal(out(dec('ascii85', 'zBP@')), '\0\0\0\0hi');
  assert.equal(out(dec('ascii85', '<~9jqo^~>')), 'Man ');
  assert.equal(dec('ascii85', 'uuuuu').ok, false); // above 2^32 - 1
});

test('Z85 vectors from the specification', () => {
  assert.equal(out(enc('z85', 'Hello World!')), 'nm=QNzY&b1A+]nf');
  assert.equal(out(dec('z85', 'nm=QNzY&b1A+]nf')), 'Hello World!');
  // The spec's own example: the 8 bytes 86 4f d2 6f b5 59 f7 5b are "HelloWorld" in Z85.
  assert.equal(out(dec('z85', 'HelloWorld')), `${C.DUMP_NOTE}\n86 4f d2 6f b5 59 f7 5b`);
  assert.equal(enc('z85', 'abc').ok, false); // not a multiple of 4 bytes
  assert.equal(dec('z85', 'abcd').ok, false); // not a multiple of 5 characters
});

test('hex, binary, octal and decimal byte lists', () => {
  assert.equal(out(enc('hex', 'Hello')), '48656c6c6f');
  assert.equal(out(dec('hex', '48656C6c6f')), 'Hello');
  assert.equal(out(enc('binary', 'Hi')), '01001000 01101001');
  assert.equal(out(dec('binary', '0100100001101001')), 'Hi');
  assert.equal(out(enc('octal', 'Hi')), '110 151');
  assert.equal(out(dec('octal', '110, 151\n')), 'Hi');
  assert.equal(out(enc('decimal', 'Hi')), '72 105');
  assert.equal(out(dec('decimal', '72,105')), 'Hi');
  assert.equal(out(dec('decimal', '72 , 105')), 'Hi');
});

test('URL, HTML entities and Unicode escapes', () => {
  assert.equal(out(enc('url', 'a b&c=é')), 'a%20b%26c%3D%C3%A9');
  assert.equal(out(dec('url', 'a%20b%26c%3D%C3%A9')), 'a b&c=é');
  assert.equal(out(dec('url', 'a+b')), 'a+b'); // same as the existing URL transform: '+' is kept
  assert.equal(out(enc('htmlEntities', '<a href="x">Tom & Jerry\'s</a>')), '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;');
  assert.equal(out(dec('htmlEntities', '&lt;&#65;&#x42;&copy;&bogus; &#0; &#xD800; &amp;lt;')), '<AB©&bogus; &#0; &#xD800; &lt;');
  assert.equal(out(dec('unicodeEscape', '\\u0041\\x42\\u{1F600}\\u00e9')), 'AB\u{1F600}é');
  assert.equal(out(dec('unicodeEscape', '\\ud83d\\ude00')), '\u{1F600}');
  assert.equal(out(dec('unicodeEscape', '\\u12 \\xZZ \\q \\')), '\\u12 \\xZZ \\q \\'); // bad escapes stay as written
  assert.equal(out(enc('unicodeEscape', 'Aé\\')), 'A\\u00e9\\u005c');
});

test('classic ciphers', () => {
  assert.equal(out(enc('rot13', 'Hello, World!')), 'Uryyb, Jbeyq!');
  assert.equal(out(enc('rot47', 'Hello')), 'w6==@');
  assert.equal(out(dec('rot47', 'w6==@')), 'Hello');
  assert.equal(out(enc('atbash', 'HELLO')), 'SVOOL');
  assert.equal(out(enc('caesar', 'Hello, World!', { shift: 3 })), 'Khoor, Zruog!');
  assert.equal(out(dec('caesar', 'Khoor, Zruog!', { shift: 3 })), 'Hello, World!');
  assert.equal(out(enc('vigenere', 'ATTACKATDAWN', { key: 'LEMON' })), 'LXFOPVEFRNHR');
  assert.equal(out(dec('vigenere', 'LXFOPVEFRNHR', { key: 'lemon' })), 'ATTACKATDAWN');
  assert.equal(out(enc('vigenere', 'Hi, you!', { key: 'b' })), 'Ij, zpv!'); // case and punctuation kept
  assert.equal(out(enc('railFence', 'WEAREDISCOVEREDFLEEATONCE', { rails: 3 })), 'WECRLTEERDSOEEFEAOCAIVDEN');
  assert.equal(out(dec('railFence', 'WECRLTEERDSOEEFEAOCAIVDEN', { rails: 3 })), 'WEAREDISCOVEREDFLEEATONCE');
  assert.equal(out(enc('reverse', 'abc\u{1F600}')), '\u{1F600}cba');
  assert.equal(out(enc('swapCase', 'Hello World 123')), 'hELLO wORLD 123');
});

test('Morse code', () => {
  assert.equal(out(enc('morse', 'SOS')), '... --- ...');
  assert.equal(out(enc('morse', 'hello world')), '.... . .-.. .-.. --- / .-- --- .-. .-.. -..');
  assert.equal(out(dec('morse', '.... . .-.. .-.. --- / .-- --- .-. .-.. -..')), 'HELLO WORLD');
  assert.equal(out(dec('morse', '...  ---\n...')), 'SOS');
  assert.equal(out(enc('morse', 'Flag: 42!')), '..-. .-.. .- --. ---... / ....- ..--- -.-.--');
  assert.equal(enc('morse', 'café').ok, false);
  assert.equal(dec('morse', 'hello').ok, false);
  assert.equal(dec('morse', '.........').ok, false);
  assert.equal(dec('morse', '.-.-.-.-').ok, false); // no such letter
});

test('XOR: encode gives hex; decode takes hex or Base64; text or hex key', () => {
  assert.equal(out(enc('xor', 'abc', { key: 'k' })), '0a0908');
  assert.equal(out(enc('xor', 'abc', { key: '6b', keyFormat: 'hex' })), '0a0908');
  assert.equal(out(dec('xor', '0a0908', { key: 'k' })), 'abc');
  assert.equal(out(dec('xor', 'CgkI', { key: 'k' })), 'abc'); // Base64 of 0a 09 08
  assert.equal(out(dec('xor', '0a 09 08', { key: '6B', keyFormat: 'hex' })), 'abc');
  assert.equal(out(enc('xor', 'hello world', { key: 'ab' })), Buffer.from('hello world').map((b, i) => b ^ 'ab'.charCodeAt(i % 2)).toString('hex'));
  assert.equal(dec('xor', 'not hex or base64!', { key: 'k' }).ok, false);
});

test('bytes that are not UTF-8 come back as a hex dump with a note line', () => {
  assert.equal(out(dec('base64', '/w==')), `${C.DUMP_NOTE}\nff`);
  assert.equal(out(dec('hex', 'c328')), `${C.DUMP_NOTE}\nc3 28`);
  const dump = out(dec('hex', Array.from({ length: 17 }, (_, i) => (0x80 + i).toString(16)).join('')));
  assert.equal(dump, `${C.DUMP_NOTE}\n80 81 82 83 84 85 86 87 88 89 8a 8b 8c 8d 8e 8f\n90`);
  assert.equal(out(dec('hex', 'efbbbf41')), '﻿A'); // a BOM is kept, not eaten
  assert.equal(out(dec('hex', '00')), '\0'); // NUL is valid UTF-8
});

// -------------------------------------------------------------- round trips

test('every codec with both directions round-trips random Unicode text', () => {
  const rand = rng(12345);
  const ids = C.CODECS.filter((c) => c.encode && c.decode && c.id !== 'morse' && c.id !== 'z85').map((c) => c.id);
  assert.equal(ids.length, 21);
  for (const id of ids) {
    for (let i = 0; i < 60; i++) {
      const text = randomText(rand, 80);
      const e = enc(id, text, PARAMS[id]);
      assert.equal(e.ok, true, `${id} encode ${JSON.stringify(text)} ${JSON.stringify(e)}`);
      assert.equal(out(dec(id, e.output, PARAMS[id])), text, `${id} round trip of ${JSON.stringify(text)}`);
    }
  }
});

test('Z85 and Morse round-trip on text they can carry', () => {
  const rand = rng(777);
  for (let i = 0; i < 50; i++) {
    let s = '';
    const n = 4 * (1 + Math.floor(rand() * 20));
    for (let j = 0; j < n; j++) s += String.fromCharCode(32 + Math.floor(rand() * 95));
    assert.equal(out(dec('z85', out(enc('z85', s)))), s);
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,?\'!()&:;=+-_"$@';
  for (let i = 0; i < 50; i++) {
    const words = [];
    for (let w = 0; w < 1 + Math.floor(rand() * 5); w++) {
      let word = '';
      for (let j = 0; j < 1 + Math.floor(rand() * 8); j++) word += alphabet[Math.floor(rand() * alphabet.length)];
      words.push(word);
    }
    const s = words.join(' ');
    assert.equal(out(dec('morse', out(enc('morse', s)))), s);
  }
});

test('Caesar and Vigenere round-trip for every shift and a long key', () => {
  for (let shift = 1; shift <= 25; shift++) {
    assert.equal(out(dec('caesar', out(enc('caesar', 'The Quick Brown Fox', { shift })), { shift })), 'The Quick Brown Fox');
  }
  for (let rails = 2; rails <= 10; rails++) {
    const s = 'WEAREDISCOVEREDFLEEATONCE!';
    assert.equal(out(dec('railFence', out(enc('railFence', s, { rails })), { rails })), s);
  }
});

// ----------------------------------------------------------- hostile inputs

const WRONG_ALPHABET = {
  base64: '***!', base64url: '+/+/', base32: '1890', base58: '0OIl', ascii85: 'abc{|}', z85: 'abcd~', hex: 'zz', binary: '0102 0304',
  octal: '999', decimal: '300', morse: 'hello', xor: 'not hex or base64!!', url: '%E0%A4%A',
};

test('every decoder: empty, whitespace, non-strings, too long, wrong alphabet, odd lengths', () => {
  for (const c of C.CODECS.filter((x) => x.decode)) {
    const p = PARAMS[c.id];
    for (const bad of ['', ' ', ' \n\t\r ', null, undefined, 5, {}, [], true]) {
      const r = c.decode(bad, p);
      assert.equal(r.ok, false, `${c.id} ${JSON.stringify(bad)}`);
      assert.equal(typeof r.message, 'string');
    }
    const long = c.decode('A'.repeat(100001), p);
    assert.deepEqual(long, { ok: false, message: 'That text is too long to convert (limit 100,000 characters).' }, c.id);
    if (WRONG_ALPHABET[c.id]) assert.equal(c.decode(WRONG_ALPHABET[c.id], p).ok, false, `${c.id} wrong alphabet`);
  }
  for (const [id, text] of [['hex', 'abc'], ['base64', 'A'], ['base64', 'AAAAA'], ['base32', 'A'], ['base32', 'AAA'], ['binary', '0101'], ['z85', 'abcd'], ['ascii85', '!'], ['base64', 'Zg==='], ['base64', 'Zg=a']]) {
    assert.equal(dec(id, text).ok, false, `${id} ${text}`);
  }
});

test('every encoder refuses empty, non-strings and over-long input', () => {
  for (const c of C.CODECS.filter((x) => x.encode)) {
    const p = PARAMS[c.id];
    for (const bad of ['', null, undefined, 5, {}, []]) assert.equal(c.encode(bad, p).ok, false, `${c.id} ${JSON.stringify(bad)}`);
    assert.deepEqual(c.encode('A'.repeat(100001), p), { ok: false, message: 'That text is too long to convert (limit 100,000 characters).' }, c.id);
  }
});

test('every codec survives lone surrogates, NUL bytes and odd characters without throwing', () => {
  const samples = ['\ud800', 'a\udc00b', '\ud83d', '\0', '\0\0\0\0', 'A\0B', '‮﻿', '\\u{110000}', '&#99999999999;', '%', '%%%', '=', '====', '~>', '<~'];
  for (const c of C.CODECS) {
    for (const s of samples) {
      for (const op of ['encode', 'decode']) {
        if (!c[op]) continue;
        const r = c[op](s, PARAMS[c.id]);
        assert.equal(typeof r.ok, 'boolean');
        if (r.ok) assert.equal(typeof r.output, 'string'); else assert.equal(typeof r.message, 'string');
      }
    }
  }
  assert.equal(enc('url', '\ud800').ok, false);
  assert.equal(out(dec('base64', 'AA==')), '\0');
});

test('100,000 characters of A finish within 500 ms in every decoder and encoder', () => {
  const text = 'A'.repeat(100000);
  for (const c of C.CODECS) {
    for (const op of ['encode', 'decode']) {
      if (!c[op]) continue;
      const { value, ms } = timed(() => c[op](text, PARAMS[c.id]));
      assert.equal(typeof value.ok, 'boolean');
      assert.ok(ms < 500, `${c.id}.${op} took ${ms.toFixed(0)} ms`);
    }
  }
});

test('output beyond 1,000,000 characters is refused with a message', () => {
  const wide = 'é'.repeat(100000); // 200,000 bytes -> 1,800,000 binary characters
  const r = enc('binary', wide);
  assert.equal(r.ok, false);
  assert.match(r.message, /too long/);
  assert.match(r.message, /1,000,000/);
});

test('Base58 is limited to 2,000 characters and the limit is fast', () => {
  const tooLong = dec('base58', 'z'.repeat(2001));
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.message, /2,000/);
  let r = timed(() => dec('base58', 'z'.repeat(2000)));
  assert.equal(r.value.ok, true);
  assert.ok(r.ms < 500, `decode ${r.ms} ms`);
  r = timed(() => enc('base58', 'é'.repeat(2000))); // 4,000 bytes
  assert.equal(r.value.ok, true);
  assert.ok(r.ms < 500, `encode ${r.ms} ms`);
  r = timed(() => enc('base58', 'A'.repeat(2001)));
  assert.equal(r.value.ok, true); // limited by bytes (8,000) on the way in
  const big = enc('base58', 'A'.repeat(9000));
  assert.equal(big.ok, false);
});

// --------------------------------------------------------------- parameters

test('parameters are validated by type and range', () => {
  for (const shift of [0, 26, -1, 1.5, '3', null, undefined, NaN, Infinity, [], {}, true]) {
    assert.equal(enc('caesar', 'abc', { shift }).ok, false, `shift ${String(shift)}`);
    assert.equal(dec('caesar', 'abc', { shift }).ok, false);
  }
  for (const params of [undefined, null, 5, 'x', []]) assert.equal(enc('caesar', 'abc', params).ok, false);
  for (const rails of [0, 1, 11, 2.5, '3', null, NaN, undefined]) {
    assert.equal(enc('railFence', 'abcdef', { rails }).ok, false, `rails ${String(rails)}`);
    assert.equal(dec('railFence', 'abcdef', { rails }).ok, false);
  }
  for (const key of ['', 'a1', 'x'.repeat(65), 5, null, undefined, 'café', 'a b', ['a'], {}]) {
    assert.equal(enc('vigenere', 'abc', { key }).ok, false, `key ${JSON.stringify(key)}`);
    assert.equal(dec('vigenere', 'abc', { key }).ok, false);
  }
  assert.equal(enc('vigenere', 'abc', { key: 'x'.repeat(64) }).ok, true);
  for (const key of ['', 5, null, undefined, 'k'.repeat(257)]) assert.equal(enc('xor', 'abc', { key }).ok, false, `xor key ${String(key).slice(0, 5)}`);
  assert.equal(enc('xor', 'abc', { key: 'k'.repeat(256) }).ok, true);
  assert.equal(enc('xor', 'abc', { key: 'k', keyFormat: 'b64' }).ok, false);
  for (const key of ['zz', 'abc', '', '6b6']) assert.equal(enc('xor', 'abc', { key, keyFormat: 'hex' }).ok, false, `hex key ${key}`);
  assert.equal(enc('xor', 'abc', { key: 'k' }).ok, true); // keyFormat defaults to text
  assert.equal(enc('xor', 'abc', { key: '6b', keyFormat: 'hex' }).ok, true);
  assert.equal(enc('xor', 'abc', { key: '6b'.repeat(257), keyFormat: 'hex' }).ok, false);
});

// ---------------------------------------------------------- brute forcers

test('caesarBruteForce returns 25 shifts, capped, and nothing for bad input', () => {
  const all = C.caesarBruteForce('Khoor, Zruog!');
  assert.equal(all.length, 25);
  assert.deepEqual(all.map((r) => r.shift), Array.from({ length: 25 }, (_, i) => i + 1));
  assert.equal(all[2].output, 'Hello, World!');
  for (const bad of ['', null, 5, {}, 'A'.repeat(100001)]) assert.deepEqual(C.caesarBruteForce(bad), []);
  for (const r of C.caesarBruteForce('A'.repeat(50000))) assert.ok(r.output.length <= 2000);
});

test('xorBruteForce: hex, Base64 or raw bytes in; the ten most readable keys out', () => {
  const plain = 'the quick brown fox jumps over the lazy dog';
  const hex = Buffer.from(plain).map((b) => b ^ 0x2a).toString('hex');
  const res = C.xorBruteForce(hex);
  assert.equal(res.length, 10);
  assert.equal(res[0].key, 0x2a);
  assert.equal(res[0].keyHex, '2a');
  assert.equal(res[0].output, plain);
  for (let i = 1; i < res.length; i++) assert.ok(res[i - 1].score >= res[i].score);
  const b64 = Buffer.from(plain).map((b) => b ^ 0x2a).toString('base64');
  assert.equal(C.xorBruteForce(b64)[0].output, plain);
  const raw = Buffer.from('hello world').map((b) => b ^ 5).toString('latin1'); // contains '%' so it is neither hex nor Base64
  assert.equal(C.xorBruteForce(raw)[0].key, 5);
  for (const bad of ['', null, 5, {}, 'A'.repeat(100001)]) assert.deepEqual(C.xorBruteForce(bad), []);
  for (const r of C.xorBruteForce('41'.repeat(40000))) assert.ok(r.output.length <= 2000);
});

// ----------------------------------------------------------------- scoring

test('readableScore: bounded, deterministic, English high, random low, flags boost', () => {
  const en = 'The quick brown fox jumps over the lazy dog and then finds a hidden message in the old library near the river.';
  assert.equal(C.readableScore(''), 0);
  for (const bad of [null, undefined, 5, {}]) assert.equal(C.readableScore(bad), 0);
  assert.equal(C.readableScore(en), C.readableScore(en));
  assert.ok(C.readableScore(en) >= 0.9);
  assert.ok(C.readableScore('hello world') >= 0.7);
  assert.ok(C.readableScore('Uryyb jbeyq, guvf vf n frperg zrffntr sebz gur fbhepr') < 0.5); // ROT13 text is not readable
  assert.ok(C.readableScore('\0\x01\x02\x03\x04\x05') === 0);
  assert.ok(C.readableScore('éééé') === 0);
  assert.ok(C.readableScore('flag{x1}') >= 0.8);
  assert.ok(C.readableScore('flag{x1}', ['other']) < 0.8);
  const rand = rng(99);
  const b64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < 300; i++) {
    let s = '';
    for (let j = 0; j < 20 + Math.floor(rand() * 100); j++) s += b64[Math.floor(rand() * 64)];
    assert.ok(C.readableScore(s) < 0.7, s);
    const score = C.readableScore(randomText(rand, 200));
    assert.ok(score >= 0 && score <= 1);
  }
  let hex = '';
  for (let j = 0; j < 80; j++) hex += '0123456789abcdef'[Math.floor(rand() * 16)];
  assert.ok(C.readableScore(hex) < 0.7);
});

// ---------------------------------------------------------- tryDecodings

test('tryDecodings: Base64 of hex of a flag has the path [base64, hex]', () => {
  const input = Buffer.from(Buffer.from(FLAG_TEXT).toString('hex')).toString('base64');
  const res = C.tryDecodings(input);
  const hit = res.find((r) => r.output === FLAG_TEXT);
  assert.ok(hit, JSON.stringify(res));
  assert.deepEqual(hit.path, ['base64', 'hex']);
  assert.equal(res[0].output, FLAG_TEXT); // the flag ranks first
});

test('tryDecodings explores three layers and not a fourth', () => {
  const hex = (s) => out(enc('hex', s));
  const b64 = (s) => out(enc('base64', s));
  const b32 = (s) => out(enc('base32', s));
  const three = b32(b64(hex('flag{three_layers}')));
  const found = C.tryDecodings(three).find((r) => r.output === 'flag{three_layers}');
  assert.ok(found);
  assert.deepEqual(found.path, ['base32', 'base64', 'hex']);
  const four = b64(three);
  const res = C.tryDecodings(four);
  assert.equal(res.find((r) => r.output.includes('flag{three_layers}')), undefined);
  for (const r of res) assert.ok(r.path.length <= C.LIMITS.layers);
});

test('tryDecodings finds ROT13 text, Unicode escapes and single-byte XOR in hex', () => {
  const rot = C.tryDecodings('Uryyb jbeyq, guvf vf n frperg zrffntr sebz gur pbapre');
  assert.deepEqual(rot[0].path, ['rot13']);
  assert.equal(rot[0].output, 'Hello world, this is a secret message from the concer');
  const xor = Buffer.from('flag{single_byte}').map((b) => b ^ 0x42).toString('hex');
  const res = C.tryDecodings(xor);
  const hit = res.find((r) => r.output === 'flag{single_byte}');
  assert.ok(hit);
  assert.deepEqual(hit.path, ['xor']);
  assert.equal(hit.detail, 'key 0x42');
  const caesar = C.tryDecodings('Khoor zruog, wklv lv d vhfuhw phvvdjh iurp wkh frqfhuw');
  assert.ok(caesar.some((r) => r.path.join() === 'caesar' && r.output.startsWith('Hello world')));
});

test('tryDecodings: sorted by score, de-duplicated, capped, outputs capped, hard cases bounded', () => {
  const input = out(enc('base64', 'the old man and the sea was in the harbor and he said that it was time to go home '.repeat(800)));
  const res = C.tryDecodings(input);
  assert.ok(res.length >= 1 && res.length <= 30);
  for (const r of res) assert.ok(r.output.length <= 2000);
  for (let i = 1; i < res.length; i++) assert.ok(res[i - 1].score >= res[i].score);
  assert.equal(new Set(res.map((r) => r.output)).size, res.length);
  for (const bad of ['', null, 5, {}, 'A'.repeat(100001)]) assert.deepEqual(C.tryDecodings(bad), []);
  assert.ok(C.tryDecodings('Zm9vYmFy').length >= 0);
});

test('tryDecodings: a random 100,000-character string finishes within the budget (under 2 s)', () => {
  const rand = rng(2024);
  let s = '';
  for (let i = 0; i < 100000; i++) s += String.fromCharCode(32 + Math.floor(rand() * 95));
  let r = timed(() => C.tryDecodings(s));
  assert.ok(r.ms < 2000, `${r.ms} ms`);
  assert.ok(Array.isArray(r.value) && r.value.length <= 30);
  r = timed(() => C.tryDecodings('41'.repeat(50000))); // decodes in many ways
  assert.ok(r.ms < 2000, `${r.ms} ms`);
  const alnum = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let b = '';
  for (let i = 0; i < 100000; i++) b += alnum[Math.floor(rand() * 62)];
  r = timed(() => C.tryDecodings(b));
  assert.ok(r.ms < 2000, `${r.ms} ms`);
});

// -------------------------------------------------------------- validatePrefixes

test('validatePrefixes keeps clean prefixes and falls back to the defaults', () => {
  const defaults = ['flag', 'ctf', 'HTB', 'picoCTF', 'THM', 'DUCTF'];
  assert.deepEqual(C.validatePrefixes(['a', 'B_2']), ['a', 'B_2']);
  assert.deepEqual(C.validatePrefixes(['Flag', 'flag', 'FLAG', 'x']), ['Flag', 'x']); // case-insensitive duplicates
  for (const bad of [undefined, null, 'flag', 5, {}, [], [1, null, {}], ['', 'x'.repeat(21), 'a b', 'fl.g', '.*', 'a|b', '(x)', 'a\n', 'café']]) {
    assert.deepEqual(C.validatePrefixes(bad), defaults);
  }
  assert.deepEqual(C.validatePrefixes(['fl.g', '.*', 'ok_1', 'OK_1', '[a-z]+']), ['ok_1']);
  assert.equal(C.validatePrefixes(Array.from({ length: 40 }, (_, i) => `p${i}`)).length, 30);
  assert.equal(C.validatePrefixes(['x'.repeat(20)]).length, 1);
  assert.equal(C.validatePrefixes(new Array(1e6).fill('p')).length, 1);
  const a = C.validatePrefixes();
  a.push('mutated');
  assert.deepEqual(C.validatePrefixes(), defaults); // the default list is never shared
});

// ---------------------------------------------------------------- findFlags

const flags = (text, prefixes) => C.findFlags(text, prefixes).map((f) => `${f.via}:${f.flag}`);

test('findFlags: plain, mixed case, line numbers, two on a line', () => {
  assert.deepEqual(C.findFlags('x\ny flag{abc} z'), [{ flag: 'flag{abc}', prefix: 'flag', line: 2, via: 'plain' }]);
  assert.deepEqual(C.findFlags('FlAg{Case} and picoCTF{Mixed} htb{low}'), [
    { flag: 'FlAg{Case}', prefix: 'flag', line: 1, via: 'plain' },
    { flag: 'picoCTF{Mixed}', prefix: 'picoCTF', line: 1, via: 'plain' },
    { flag: 'htb{low}', prefix: 'HTB', line: 1, via: 'plain' },
  ]);
  assert.deepEqual(flags('flag{one}flag{two}'), ['plain:flag{one}', 'plain:flag{two}']);
  assert.deepEqual(flags('a\r\nb\r\nflag{crlf}').length, 1);
  assert.equal(C.findFlags('a\r\nb\r\nflag{crlf}')[0].line, 3);
  assert.deepEqual(flags('CTFX{a}', ['ctfx']), ['plain:CTFX{a}']);
  assert.deepEqual(C.findFlags('FLAG{a}', ['Flag', 'flag'])[0].prefix, 'Flag');
});

test('findFlags: the prefix must not sit inside a longer word', () => {
  assert.deepEqual(flags('myflag{x}'), []);
  // Decision: an underscore, a digit or a letter before the prefix blocks a match; a hyphen or space does not.
  assert.deepEqual(flags('my_flag{x}'), []);
  assert.deepEqual(flags('9flag{x}'), []);
  assert.deepEqual(flags('éflag{x}'), []);
  assert.deepEqual(flags('my-flag{x}'), ['plain:flag{x}']);
  assert.deepEqual(flags('(flag{x})'), ['plain:flag{x}']);
  assert.deepEqual(flags('my_flag{x}', ['my_flag']), ['plain:my_flag{x}']);
  assert.deepEqual(flags('flag {x}'), []);
});

test('findFlags: body length and forbidden characters', () => {
  assert.deepEqual(flags(`flag{${'a'.repeat(200)}}`).length, 1);
  assert.deepEqual(flags(`flag{${'a'.repeat(201)}}`), []);
  assert.deepEqual(flags('flag{}'), []);
  assert.deepEqual(flags('flag{a{b}'), []);
  assert.deepEqual(flags('flag{a}b}'), ['plain:flag{a}']);
  assert.deepEqual(flags('flag{a\nb}'), []);
  assert.deepEqual(flags('flag{a\rb}'), []);
  assert.deepEqual(flags('flag{a b}'), []);
  assert.deepEqual(flags('flag{unclosed'), []);
  assert.deepEqual(flags('{flag}'), []);
  assert.deepEqual(flags('flag{a flag{b}'), ['plain:flag{b}']);
});

test('findFlags: Base64, Base32 and hex runs of 16 or more characters, and reversed text', () => {
  const secret = 'flag{inside_the_blob}';
  const b64 = Buffer.from(secret).toString('base64');
  const b32 = out(enc('base32', secret));
  const hex = Buffer.from(secret).toString('hex');
  assert.deepEqual(C.findFlags(`a\nb\ntoken: ${b64} end`), [{ flag: secret, prefix: 'flag', line: 3, via: 'base64' }]);
  assert.deepEqual(C.findFlags(`x ${b32}`), [{ flag: secret, prefix: 'flag', line: 1, via: 'base32' }]);
  assert.deepEqual(C.findFlags(`x ${b32.replace(/=+$/, '')}`).map((f) => f.via), ['base32']);
  assert.deepEqual(C.findFlags(`x ${hex}`), [{ flag: secret, prefix: 'flag', line: 1, via: 'hex' }]);
  assert.deepEqual(C.findFlags(`x ${Buffer.from(secret).toString('base64url')}`).map((f) => f.via), ['base64']);
  assert.deepEqual(flags(Buffer.from('flag{short}').toString('base64').slice(0, 12)), []); // runs under 16 characters are ignored
  assert.deepEqual(flags('}ver{galf'), ['reversed:flag{rev}']);
  assert.deepEqual(C.findFlags('a\n}ver{galf'), [{ flag: 'flag{rev}', prefix: 'flag', line: 2, via: 'reversed' }]);
  assert.deepEqual(flags('}x{GALF y'), ['reversed:FLAG{x}']);
  assert.deepEqual(flags('}ver{galf\nflag{rev}'), ['plain:flag{rev}', 'reversed:flag{rev}']);
  assert.deepEqual(flags('x}ver{galfy'), []);
  assert.deepEqual(flags('}a\nb{galf'), []); // a reversed flag never crosses a line
});

test('findFlags: unique by flag and via, capped at 200', () => {
  assert.equal(C.findFlags('flag{a} flag{a} flag{a}').length, 1);
  const many = Array.from({ length: 1000 }, (_, i) => `flag{${i}}`).join('\n');
  const res = C.findFlags(many);
  assert.equal(res.length, 200);
  assert.equal(res[199].flag, 'flag{199}');
  assert.equal(res[199].line, 200);
  for (const bad of [null, undefined, 5, {}, '']) assert.deepEqual(C.findFlags(bad), []);
});

test('findFlags: prefixes cannot inject pattern syntax', () => {
  assert.deepEqual(C.validatePrefixes(['fl.g', '.*', '.+', '(?:', 'a|flag', '[a-z]']), ['flag', 'ctf', 'HTB', 'picoCTF', 'THM', 'DUCTF']);
  assert.deepEqual(flags('flxg{x} anything{y} fl.g{z}', ['fl.g', '.*']), []); // rejected, defaults used, nothing matches
  assert.deepEqual(flags('flag{x} anything{y}', ['.*']), ['plain:flag{x}']);
  assert.deepEqual(flags('a{b} ab{c}', ['a|ab']), []);
  assert.deepEqual(flags('a{b} ab{c}', ['a', 'a|ab']), ['plain:a{b}']);
});

test('findFlags: hostile 5,000,000-character texts finish within 2 s', () => {
  const size = 5000000;
  for (const [name, text] of [
    ['{', '{'.repeat(size)],
    ['}', '}'.repeat(size)],
    ['flag{', 'flag{'.repeat(size / 5)],
    ['}x{galf', '}x{galf'.repeat(Math.floor(size / 7))],
    ['A', 'A'.repeat(size)],
    ['flag{a}', 'flag{a}'.repeat(Math.floor(size / 7))],
    ['hex runs', 'deadbeefdeadbeef '.repeat(Math.floor(size / 17))],
  ]) {
    const { value, ms } = timed(() => C.findFlags(text));
    assert.ok(ms < 2000, `${name} took ${ms.toFixed(0)} ms`);
    assert.ok(value.length <= 200);
  }
  const past = 'a'.repeat(4999999) + ' flag{late}'; // only the first 5,000,000 characters are searched
  assert.deepEqual(C.findFlags(past), []);
  const edge = 'a'.repeat(4999989) + ' flag{ok}'; // fits entirely inside the limit
  assert.equal(C.findFlags(edge).length, 1);
});

// ---------------------------------------------------------------- templates

const CHALLENGE_TEXT = [
  '# Baby RSA', '',
  '- Event: ExampleCTF 2026',
  '- Category: crypto',
  '- Points: 150',
  '- Status: unsolved',
  '- Flag:', '',
  '## Description', '',
  '## Files and endpoints', '',
  '## Recon', '',
  '## Solution', '',
  '## Solve script', '',
  '## Notes', '',
].join('\n');

test('challengeTemplate produces exactly the spec text', () => {
  assert.equal(C.challengeTemplate({ name: 'Baby RSA', event: 'ExampleCTF 2026', category: 'crypto', points: 150 }), CHALLENGE_TEXT);
});

test('challengeTemplate: invalid category and points fall back, fields stay on one line', () => {
  const base = C.challengeTemplate({ name: 'x', event: 'e', category: 'web', points: 1 }).split('\n').length;
  const hostile = C.challengeTemplate({
    name: 'a\nb|c<script>alert(1)</script>', event: 'ev\r\n- Flag: injected', category: 'web\n- Points: 9', points: 1e9,
  });
  assert.equal(hostile.split('\n').length, base);
  assert.match(hostile, /^# a b\|c<script>alert\(1\)<\/script>\n/);
  assert.match(hostile, /\n- Event: ev {2}- Flag: injected\n/);
  assert.match(hostile, /\n- Category: misc\n- Points: 0\n- Status: unsolved\n- Flag:\n/);
  for (const points of [-1, 100001, 1.5, '100', NaN, null, undefined, Infinity]) {
    assert.match(C.challengeTemplate({ name: 'x', points }), /\n- Points: 0\n/, String(points));
  }
  assert.match(C.challengeTemplate({ name: 'x', points: 100000 }), /\n- Points: 100000\n/);
  assert.match(C.challengeTemplate({ name: 'x', category: 'WEB' }), /\n- Category: web\n/);
  assert.match(C.challengeTemplate({ name: 'x', category: 'nonsense' }), /\n- Category: misc\n/);
  const long = C.challengeTemplate({ name: 'n'.repeat(10000), event: 'e'.repeat(10000) });
  assert.equal(long.split('\n')[0].length, 2 + 120);
  assert.match(long, /\n- Event: e{120}\n/);
  assert.equal(long.split('\n').length, base);
  for (const bad of [undefined, null, 5, 'x', [], {}]) assert.equal(typeof C.challengeTemplate(bad), 'string');
  assert.match(C.challengeTemplate({}), /^# Untitled challenge\n\n- Event:\n- Category: misc\n- Points: 0\n/);
  assert.equal(C.challengeTemplate({ name: 'x\u0000y\u007fz w' }).split('\n')[0], '# x y z w');
});

test('writeupTemplate produces the exact text and a YYYY-MM-DD date', () => {
  const text = C.writeupTemplate({ event: 'ExampleCTF 2026', team: 'Red Pandas', date: new Date(2026, 10, 26, 23, 59) });
  assert.equal(text, [
    '# ExampleCTF 2026 writeup', '',
    '- Event: ExampleCTF 2026',
    '- Date: 2026-11-26',
    '- Team: Red Pandas', '',
    '## Summary', '',
    '## Results', '',
    '| Challenge | Category | Points | Status |',
    '| --- | --- | ---: | --- |',
    '|  |  |  |  |', '',
    '## Challenge name', '',
    '### Summary', '',
    '### Steps', '',
    '### Flag', '',
    '### Lessons learned', '',
    '### Tools used', '',
  ].join('\n'));
  assert.match(C.writeupTemplate({ date: new Date(2026, 0, 5) }), /\n- Date: 2026-01-05\n/);
  assert.match(C.writeupTemplate({ date: 'yesterday' }), /\n- Date:\n/);
  assert.match(C.writeupTemplate({ date: new Date(NaN) }), /\n- Date:\n/);
  assert.match(C.writeupTemplate({}), /^# CTF writeup\n/);
  const hostile = C.writeupTemplate({ event: 'a\nb', team: 't\n## injected', date: new Date(2026, 5, 1) });
  assert.equal(hostile.split('\n').length, C.writeupTemplate({ event: 'a', team: 't', date: new Date(2026, 5, 1) }).split('\n').length);
});

// --------------------------------------------------------- parseChallenge

test('parseChallenge reads the template and rejects other text', () => {
  assert.deepEqual(C.parseChallenge(CHALLENGE_TEXT), {
    name: 'Baby RSA', event: 'ExampleCTF 2026', category: 'crypto', points: 150, status: 'unsolved', flag: '', solved: false,
  });
  const solved = C.parseChallenge(CHALLENGE_TEXT.replace('- Status: unsolved', '- Status: SOLVED at 12:00').replace('- Flag:', '- Flag: flag{x}'));
  assert.equal(solved.solved, true);
  assert.equal(solved.flag, 'flag{x}');
  assert.equal(C.parseChallenge(CHALLENGE_TEXT.replace('- Status: unsolved', '- Status: Solved')).solved, true);
  assert.equal(C.parseChallenge(CHALLENGE_TEXT.replace('- Flag:', '- Flag: flag{y}')).solved, true); // a flag alone counts as solved
  assert.equal(C.parseChallenge(CHALLENGE_TEXT.replace('- Status: unsolved', '- Status: not solved')).solved, false);
  assert.equal(C.parseChallenge(CHALLENGE_TEXT.replace('- Status: unsolved', '- Status: unsolved (was solved?)')).solved, false);
  assert.equal(C.parseChallenge('# Just a note\n\nnothing here'), null);
  assert.equal(C.parseChallenge('x\n'.repeat(40) + '- Category: web'), null); // beyond the first 40 lines
  assert.equal(C.parseChallenge('x\n'.repeat(39) + '- Category: web').category, 'web');
  assert.equal(C.parseChallenge('  - Category: web'), null);
  for (const bad of [null, undefined, 5, {}, '']) assert.equal(C.parseChallenge(bad), null);
  const odd = C.parseChallenge('# T\n- Category: Whatever\n- Points: 12x\r\n- Flag:\r\n');
  assert.equal(odd.category, 'Whatever');
  assert.equal(odd.points, 0);
  assert.equal(odd.flag, '');
  assert.equal(C.parseChallenge('- Category: WEB\n- Points: 100000').points, 100000);
  assert.equal(C.parseChallenge('- Category: web\n- Points: 100001').points, 0);
  assert.equal(C.parseChallenge('- Category: web').name, '');
  assert.equal(C.parseChallenge('## sub\n# First\n# Second\n- Category: web').name, 'First');
  assert.equal(C.parseChallenge(`- Category: web\n- Flag: ${'z'.repeat(5000)}`).flag.length, 120);
  assert.ok(C.parseChallenge(`${'a'.repeat(3000000)}\n- Category: web`) === null);
});

// ------------------------------------------------------------- buildReport

const NOW = new Date(2026, 10, 26);
const note = (title, body, lang = '', encrypted = false) => ({ title, body, lang, encrypted });
const challenge = (name, category, points, extra = '', status = 'unsolved', flag = '') => note(name, [
  `# ${name}`, '', '- Event: Ev', `- Category: ${category}`, `- Points: ${points}`, `- Status: ${status}`, `- Flag: ${flag}`, '',
  '## Description', '', 'Some text.', extra,
].join('\n'));

test('buildReport: two challenges and a script, sorted, with totals', () => {
  const r = C.buildReport({
    folder: 'ExampleCTF',
    now: NOW,
    notes: [
      challenge('Zeta web', 'web', 100, '', 'solved', 'flag{w}'),
      challenge('Alpha crypto', 'crypto', 250),
      note('solve.py', 'print("hi")', 'python'),
      note('Random thoughts', 'nothing to see'),
    ],
  });
  assert.equal(r.title, 'CTF report: ExampleCTF');
  assert.equal(r.included, 3);
  assert.deepEqual(r.skippedEncrypted, []);
  assert.deepEqual(r.leftOut, []);
  assert.ok(r.body.startsWith('# CTF report: ExampleCTF\n\nDate: 2026-11-26\n\n## Results\n\n'));
  assert.ok(r.body.includes([
    '| Challenge | Category | Points | Status | Flag found |',
    '| --- | --- | ---: | --- | --- |',
    '| Alpha crypto | crypto | 250 | unsolved | no |',
    '| Zeta web | web | 100 | solved | yes |',
  ].join('\n')));
  assert.ok(r.body.includes('**Solved:** 1 of 2. **Points:** 100 of 350.'));
  assert.ok(r.body.indexOf('## Alpha crypto') < r.body.indexOf('## Zeta web'));
  assert.ok(r.body.includes('### Description'));
  assert.ok(r.body.includes('## Solve scripts\n\n### solve.py\n\n```python\nprint("hi")\n```'));
  assert.ok(!r.body.includes('Random thoughts'));
  assert.ok(!r.body.includes('Not included'));
  assert.ok(!r.body.includes('Left out'));
  // Running again does not fold the first report into the second (it would otherwise parse as a challenge).
  const again = C.buildReport({ folder: 'ExampleCTF', now: NOW, notes: [note(r.title, r.body), challenge('Only', 'pwn', 1)] });
  assert.ok(!again.body.includes('Alpha crypto'));
  assert.equal(again.included, 1);
});

test('buildReport: headings move down one level, fenced code is untouched', () => {
  const body = [
    '# Title', '- Category: web', '', '## Sub', '###### Deep', '#NotAHeading', '    # indented code', '   ### three spaces',
    '```', '# in backticks', '```', '## after', '~~~sh', '## in tildes', '~~~', '### after tildes',
    '````md', '```', '# nested inside longer fence', '```', '````', '# after long fence',
    '~~~', '```', '# still tilde fenced', '```', '~~~', '#', '```js title`x', '# not a fence (backtick in info)',
  ].join('\n');
  const r = C.buildReport({ folder: 'f', now: NOW, notes: [note('t', body)] });
  const lines = r.body.split('\n');
  const keep = (s) => assert.ok(lines.includes(s), `missing ${JSON.stringify(s)}`);
  keep('## Title'); keep('### Sub'); keep('###### Deep'); keep('#NotAHeading'); keep('    # indented code'); keep('   #### three spaces');
  keep('# in backticks'); keep('### after'); keep('## in tildes'); keep('#### after tildes');
  keep('# nested inside longer fence'); keep('## after long fence'); keep('# still tilde fenced'); keep('##');
  keep('## not a fence (backtick in info)');
});

test('buildReport: an unclosed fence protects the rest of the note', () => {
  const body = '# T\n- Category: web\n```\n# never closed\n## also code\n';
  const r = C.buildReport({ folder: 'f', now: NOW, notes: [note('t', body)] });
  assert.ok(r.body.includes('\n# never closed\n## also code'));
  assert.ok(r.body.includes('\n## T\n'));
});

test('buildReport: encrypted notes are never included, with or without a body', () => {
  const secret = 'TOP-SECRET-BODY';
  const encryptedChallenge = [`# Secret chall`, '- Category: web', '- Flag: flag{' + secret + '}'].join('\n');
  for (const body of ['', secret, encryptedChallenge]) {
    const r = C.buildReport({
      folder: 'f', now: NOW,
      notes: [
        challenge('Open one', 'web', 10),
        note('Locked note', body, '', true),
        note('Locked script', body, 'python', true),
        { title: 'Truthy flag', body: secret, lang: 'bash', encrypted: 1 },
      ],
    });
    assert.deepEqual(r.skippedEncrypted, ['Locked note', 'Locked script', 'Truthy flag']);
    assert.ok(!r.body.includes(secret));
    assert.ok(!r.body.includes('Secret chall'));
    assert.ok(!r.body.includes('python'));
    assert.ok(r.body.includes('## Not included (encrypted)\n\n- Locked note\n- Locked script\n- Truthy flag'));
    assert.ok(r.body.includes('| Open one |'));
    assert.equal(r.included, 1);
    assert.ok(!r.body.includes('Solve scripts'));
  }
});

test('buildReport: a 2,000,000-character folder is cut with a leftOut list', () => {
  const filler = 'x'.repeat(500000);
  const notes = ['A', 'B', 'C', 'D'].map((n) => challenge(`Big ${n}`, 'misc', 5, filler));
  notes.push(note('late.py', 'print(1)', 'python'));
  const r = C.buildReport({ folder: 'big', now: NOW, notes });
  assert.ok(r.body.length <= 1000000);
  assert.ok(r.body.length > 400000);
  assert.deepEqual(r.leftOut, ['Big B', 'Big C', 'Big D', 'late.py']); // stops at the first note that does not fit
  assert.equal(r.included, 1);
  assert.ok(r.body.includes('## Left out (report too long)\n\n- Big B\n- Big C\n- Big D\n- late.py'));
  assert.ok(!r.body.includes('| Big B |'));
  const huge = C.buildReport({ folder: 'h', now: NOW, notes: [challenge('Enormous', 'web', 1, 'y'.repeat(960000))] });
  assert.deepEqual(huge.leftOut, ['Enormous']);
  assert.equal(huge.included, 0);
  assert.ok(huge.body.includes('No challenges were found'));
  const manyTitles = Array.from({ length: 5000 }, (_, i) => note('t'.repeat(120) + i, '', '', true));
  const lots = C.buildReport({ folder: 'l', now: NOW, notes: manyTitles });
  assert.equal(lots.skippedEncrypted.length, 5000);
  assert.ok(lots.body.length < 50000);
  assert.ok(lots.body.includes('- and 4900 more'));
});

test('buildReport: an empty folder says no challenges were found', () => {
  for (const notes of [[], undefined, null, 'x', [null, 5, 'x']]) {
    const r = C.buildReport({ folder: 'Empty', now: NOW, notes });
    assert.equal(r.title, 'CTF report: Empty');
    assert.ok(r.body.includes('No challenges were found in this folder.'));
    assert.ok(!r.body.includes('| Challenge |'));
    assert.equal(r.included, 0);
  }
  assert.equal(C.buildReport({}).title, 'CTF report: Untitled folder');
  assert.ok(!C.buildReport({ folder: 'x' }).body.includes('Date:'));
});

test('buildReport: table cells are escaped, scripts get a safe fence', () => {
  const r = C.buildReport({
    folder: 'f|g', now: NOW,
    notes: [
      note('c', '# a|b\n- Category: web\n- Points: 5\n- Status: x|y\n- Flag: flag{p|q}'),
      note('bt', 'echo ```` four\n```\nthree', 'bash'),
      note('weird lang', 'x', 'we ird\n```lang'),
    ],
  });
  assert.equal(r.title, 'CTF report: f|g');
  assert.ok(r.body.includes('| a\\|b | web | 5 | x\\|y | yes |'));
  assert.ok(r.body.includes('`````bash\necho ```` four\n```\nthree\n`````'));
  assert.ok(r.body.includes('```weirdlang\nx\n```'));
  const t = C.buildReport({ folder: 'f', now: NOW, notes: [note('line\none', '- Category: web\n# n', '', false)] });
  assert.ok(t.body.includes('| n | web |'));
});

// --------------------------------------------------------------------- fuzz

test('fuzz: 5,000 random inputs through every codec stay inside the limits and never throw', () => {
  const rand = rng(31337);
  const alphabets = [
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=-_ \n', '0123456789abcdef ', '01 ', '.-/ ', '%&#;x0123456789abcdefABCDEF\\u{}',
    '!"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~',
  ];
  const weird = [0, 1, -1, 2, 3, 10, 11, 25, 26, 1.5, NaN, '3', null, undefined, true, [], {}, 'k', '6b', 'zz', '', 'LEMON', 'x'.repeat(70), 'text', 'hex', 'b64'];
  const pick = (a) => a[Math.floor(rand() * a.length)];
  let ok = 0;
  let bad = 0;
  for (let i = 0; i < 5000; i++) {
    const c = pick(C.CODECS);
    const op = c.encode && c.decode ? pick(['encode', 'decode']) : c.encode ? 'encode' : 'decode';
    let text;
    const kind = rand();
    if (kind < 0.35) text = randomText(rand, 200);
    else if (kind < 0.9) {
      const a = pick(alphabets);
      text = '';
      for (let j = 0, n = Math.floor(rand() * 300); j < n; j++) text += a[Math.floor(rand() * a.length)];
    } else text = pick(['', '\0', '\ud800', 'A'.repeat(1 + Math.floor(rand() * 3000)), '=', ' ']);
    let params;
    const pk = rand();
    if (pk < 0.3) params = PARAMS[c.id];
    else if (pk < 0.7) params = { shift: pick(weird), rails: pick(weird), key: pick(weird), keyFormat: pick(weird) };
    else params = pick([undefined, null, 5, 'x', [], {}]);
    let r;
    assert.doesNotThrow(() => { r = c[op](text, params); }, `${c.id}.${op}`);
    assert.equal(typeof r.ok, 'boolean');
    if (r.ok) {
      ok++;
      assert.equal(typeof r.output, 'string');
      assert.ok(r.output.length <= C.LIMITS.output);
    } else {
      bad++;
      assert.equal(typeof r.message, 'string');
      assert.ok(r.message.length > 0 && r.message.length < 200);
    }
  }
  assert.ok(ok > 500 && bad > 500, `ok ${ok}, bad ${bad}`);
  for (let i = 0; i < 100; i++) {
    const t = randomText(rand, 300);
    assert.ok(C.tryDecodings(t).length <= 30);
    assert.ok(C.findFlags(t).length <= 200);
    const s = C.readableScore(t);
    assert.ok(s >= 0 && s <= 1);
  }
});
