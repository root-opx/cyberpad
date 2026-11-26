/*
 * CTF helpers: codecs (encode/decode), readable-text scoring, a bounded
 * "try common decodings" search, a flag finder, challenge and writeup
 * templates, and a report builder. Pure functions, no DOM.
 *
 * The text handled here is hostile (pasted from challenges), so everything is
 * bounded and nothing throws on bad input. No regular expression is ever built
 * from input; matching is done with index loops.
 */
(function (root, factory) {
  'use strict';
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else (root.NP = root.NP || {}).ctf = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LIMITS = Object.freeze({
    input: 100000, output: 1000000, results: 30, resultChars: 2000, layers: 3, flagBody: 200, prefixes: 30,
  });
  const CATEGORIES = Object.freeze(['web', 'pwn', 'crypto', 'reversing', 'forensics', 'stego', 'osint', 'misc', 'mobile', 'hardware']);
  const DEFAULT_PREFIXES = Object.freeze(['flag', 'ctf', 'HTB', 'picoCTF', 'THM', 'DUCTF']);

  const BASE58_MAX_CHARS = 2000;
  const MAX_FLAG_RESULTS = 200;
  const MAX_FLAG_SCAN = 5000000; // findFlags only looks at the first 5,000,000 characters
  const MAX_ENCODED_RUNS = 200;
  const MAX_RUN_CHARS = 4096;
  const MIN_RUN_CHARS = 16;
  const SEARCH_MAX_ATTEMPTS = 400;
  const SEARCH_MAX_CHARS = 20000000;
  const READABLE_THRESHOLD = 0.7;
  const REPORT_SOFT_LIMIT = 950000;
  const REPORT_HARD_LIMIT = 1000000;
  const FIELD_MAX = 120;

  const DUMP_NOTE = 'Not valid UTF-8 text. Raw bytes as hex:';
  const MSG_TOO_LONG = 'That text is too long to convert (limit 100,000 characters).';
  const MSG_OUT_TOO_LONG = 'That result is too long to show (limit 1,000,000 characters).';
  const MSG_EMPTY = 'Enter some text to convert.';

  class CodecError extends Error {}

  const encoderUtf8 = new TextEncoder();
  const decoderFatal = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const decoderLoose = new TextDecoder('utf-8', { ignoreBOM: true });

  const HEX = '0123456789abcdef';

  // ------------------------------------------------------------ byte helpers

  function toBytes(text) { return encoderUtf8.encode(text); }

  function hexOf(bytes) {
    const parts = [];
    for (let i = 0; i < bytes.length; i++) parts.push(HEX[bytes[i] >> 4] + HEX[bytes[i] & 15]);
    return parts.join('');
  }

  /** Bytes as text; bytes that are not UTF-8 become a note line plus a hex dump (16 bytes per line). */
  function fromBytes(bytes) {
    try {
      return decoderFatal.decode(bytes);
    } catch (err) {
      const lines = [DUMP_NOTE];
      for (let i = 0; i < bytes.length; i += 16) {
        const row = [];
        const end = Math.min(bytes.length, i + 16);
        for (let j = i; j < end; j++) row.push(HEX[bytes[j] >> 4] + HEX[bytes[j] & 15]);
        lines.push(row.join(' '));
      }
      return lines.join('\n');
    }
  }

  function isSpaceCode(c) { return c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0xfeff || c === 0x2028 || c === 0x2029; }

  function stripSpace(text) {
    let out = '';
    let from = 0;
    for (let i = 0; i < text.length; i++) {
      if (isSpaceCode(text.charCodeAt(i))) {
        if (i > from) out += text.slice(from, i);
        from = i + 1;
      }
    }
    return from === 0 ? text : out + text.slice(from);
  }

  function isBlank(text) {
    for (let i = 0; i < text.length; i++) if (!isSpaceCode(text.charCodeAt(i))) return false;
    return true;
  }

  function lookupTable(alphabet) {
    const t = new Int16Array(128).fill(-1);
    for (let i = 0; i < alphabet.length; i++) t[alphabet.charCodeAt(i)] = i;
    return t;
  }

  // ------------------------------------------------- generic bit-group codecs

  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const T64 = lookupTable(B64);
  const T64URL = lookupTable(B64URL);
  const T32 = lookupTable(B32);
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const T58 = lookupTable(B58);
  const Z85 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#';
  const TZ85 = lookupTable(Z85);

  function encodeBits(bytes, alphabet, bits) {
    const mask = (1 << bits) - 1;
    const out = [];
    let acc = 0;
    let n = 0;
    for (let i = 0; i < bytes.length; i++) {
      acc = (acc << 8) | bytes[i];
      n += 8;
      while (n >= bits) {
        n -= bits;
        out.push(alphabet[(acc >> n) & mask]);
      }
      acc &= (1 << n) - 1;
    }
    if (n > 0) out.push(alphabet[(acc << (bits - n)) & mask]);
    return out.join('');
  }

  function decodeBits(str, table, bits, label, foldCase) {
    const out = new Uint8Array(Math.floor((str.length * bits) / 8));
    let acc = 0;
    let n = 0;
    let o = 0;
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (foldCase && c >= 97 && c <= 122) c -= 32;
      const v = c < 128 ? table[c] : -1;
      if (v < 0) throw new CodecError(`That is not valid ${label}.`);
      acc = (acc << bits) | v;
      n += bits;
      if (n >= 8) {
        n -= 8;
        out[o++] = (acc >> n) & 255;
      }
      acc &= (1 << n) - 1;
    }
    if (n >= bits) throw new CodecError(`That is not valid ${label}.`);
    return out.subarray(0, o);
  }

  function trimPadding(str, max) {
    let end = str.length;
    while (end > 0 && str.charCodeAt(end - 1) === 61) end--;
    if (str.length - end > max) throw new CodecError('That has too much "=" padding.');
    return str.slice(0, end);
  }

  function base64Bytes(text, urlSafe) {
    const s = trimPadding(stripSpace(text), 2);
    return decodeBits(s, urlSafe ? T64URL : T64, 6, urlSafe ? 'Base64 (URL-safe)' : 'Base64', false);
  }

  function base64Encode(bytes) {
    const s = encodeBits(bytes, B64, 6);
    return s + '='.repeat((4 - (s.length % 4)) % 4);
  }

  function base32Bytes(text) {
    return decodeBits(trimPadding(stripSpace(text), 6), T32, 5, 'Base32', true);
  }

  function base32Encode(bytes) {
    const s = encodeBits(bytes, B32, 5);
    return s + '='.repeat((8 - (s.length % 8)) % 8);
  }

  function hexBytes(text) {
    const s = stripSpace(text);
    if (s.length % 2) throw new CodecError('That hex has an odd number of digits.');
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) {
      const a = hexVal(s.charCodeAt(i * 2));
      const b = hexVal(s.charCodeAt(i * 2 + 1));
      if (a < 0 || b < 0) throw new CodecError('That is not valid hex.');
      out[i] = (a << 4) | b;
    }
    return out;
  }

  function hexVal(c) {
    if (c >= 48 && c <= 57) return c - 48;
    if (c >= 97 && c <= 102) return c - 87;
    if (c >= 65 && c <= 70) return c - 55;
    return -1;
  }

  function base58Bytes(text) {
    const s = stripSpace(text);
    if (s.length > BASE58_MAX_CHARS) throw new CodecError('That text is too long for Base58 (limit 2,000 characters).');
    let n = 0n;
    let zeros = 0;
    let leading = true;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      const v = c < 128 ? T58[c] : -1;
      if (v < 0) throw new CodecError('That is not valid Base58.');
      if (leading && v === 0) zeros++; else leading = false;
      n = n * 58n + BigInt(v);
    }
    let hex = n === 0n ? '' : n.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    const body = hex.length / 2;
    const out = new Uint8Array(zeros + body);
    for (let i = 0; i < body; i++) out[zeros + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  function base58Encode(bytes) {
    if (bytes.length > BASE58_MAX_CHARS * 4) throw new CodecError('That text is too long for Base58 (limit 2,000 characters).');
    let zeros = 0;
    while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
    const hex = hexOf(bytes.subarray(zeros));
    let n = hex === '' ? 0n : BigInt('0x' + hex);
    const digits = [];
    while (n > 0n) {
      digits.push(B58[Number(n % 58n)]);
      n /= 58n;
    }
    return '1'.repeat(zeros) + digits.reverse().join('');
  }

  function ascii85Encode(bytes) {
    const out = [];
    for (let i = 0; i < bytes.length; i += 4) {
      const n = Math.min(4, bytes.length - i);
      let v = 0;
      for (let j = 0; j < 4; j++) v = v * 256 + (j < n ? bytes[i + j] : 0);
      if (n === 4 && v === 0) { out.push('z'); continue; }
      const d = [0, 0, 0, 0, 0];
      for (let j = 4; j >= 0; j--) { d[j] = v % 85; v = Math.floor(v / 85); }
      for (let j = 0; j <= n; j++) out.push(String.fromCharCode(33 + d[j]));
    }
    return out.join('');
  }

  function ascii85Bytes(text) {
    let s = stripSpace(text);
    if (s.startsWith('<~')) s = s.slice(2);
    if (s.endsWith('~>')) s = s.slice(0, -2);
    const out = [];
    let group = [];
    const flush = (count) => {
      let v = 0;
      for (let j = 0; j < 5; j++) v = v * 85 + (j < count ? group[j] : 84);
      if (v > 0xffffffff) throw new CodecError('That is not valid Ascii85.');
      const bytes = [Math.floor(v / 16777216) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
      const keep = count === 5 ? 4 : count - 1;
      for (let j = 0; j < keep; j++) out.push(bytes[j]);
    };
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 122) { // 'z'
        if (group.length) throw new CodecError('That is not valid Ascii85.');
        out.push(0, 0, 0, 0);
      } else if (c >= 33 && c <= 117) {
        group.push(c - 33);
        if (group.length === 5) { flush(5); group = []; }
      } else {
        throw new CodecError('That is not valid Ascii85.');
      }
    }
    if (group.length === 1) throw new CodecError('That is not valid Ascii85.');
    if (group.length) flush(group.length);
    return Uint8Array.from(out);
  }

  function z85Encode(bytes) {
    if (bytes.length % 4) throw new CodecError('Z85 needs text that is a multiple of 4 bytes long.');
    const out = [];
    for (let i = 0; i < bytes.length; i += 4) {
      let v = ((bytes[i] * 256 + bytes[i + 1]) * 256 + bytes[i + 2]) * 256 + bytes[i + 3];
      const d = [0, 0, 0, 0, 0];
      for (let j = 4; j >= 0; j--) { d[j] = Z85[v % 85]; v = Math.floor(v / 85); }
      out.push(d.join(''));
    }
    return out.join('');
  }

  function z85Bytes(text) {
    const s = stripSpace(text);
    if (s.length % 5) throw new CodecError('Z85 text must be a multiple of 5 characters long.');
    const out = new Uint8Array((s.length / 5) * 4);
    for (let i = 0; i < s.length; i += 5) {
      let v = 0;
      for (let j = 0; j < 5; j++) {
        const c = s.charCodeAt(i + j);
        const d = c < 128 ? TZ85[c] : -1;
        if (d < 0) throw new CodecError('That is not valid Z85.');
        v = v * 85 + d;
      }
      if (v > 0xffffffff) throw new CodecError('That is not valid Z85.');
      const o = (i / 5) * 4;
      out[o] = Math.floor(v / 16777216) & 255;
      out[o + 1] = (v >>> 16) & 255;
      out[o + 2] = (v >>> 8) & 255;
      out[o + 3] = v & 255;
    }
    return out;
  }

  function binaryBytes(text) {
    const s = stripSpace(text);
    if (s.length % 8) throw new CodecError('Binary text must come in groups of 8 digits.');
    const out = new Uint8Array(s.length / 8);
    for (let i = 0; i < out.length; i++) {
      let v = 0;
      for (let j = 0; j < 8; j++) {
        const c = s.charCodeAt(i * 8 + j);
        if (c !== 48 && c !== 49) throw new CodecError('That is not valid binary (only 0 and 1).');
        v = (v << 1) | (c - 48);
      }
      out[i] = v;
    }
    return out;
  }

  function binaryEncode(bytes) {
    const parts = [];
    for (let i = 0; i < bytes.length; i++) parts.push(bytes[i].toString(2).padStart(8, '0'));
    return parts.join(' ');
  }

  /** Split on whitespace and commas (empty pieces dropped). */
  function tokens(text) {
    const out = [];
    let from = -1;
    for (let i = 0; i <= text.length; i++) {
      const c = i < text.length ? text.charCodeAt(i) : 32;
      const sep = c === 44 || isSpaceCode(c);
      if (sep) {
        if (from >= 0) { out.push(text.slice(from, i)); from = -1; }
      } else if (from < 0) from = i;
    }
    return out;
  }

  function numberListBytes(text, radix, label) {
    const list = tokens(text);
    if (!list.length) throw new CodecError(MSG_EMPTY);
    const out = new Uint8Array(list.length);
    const maxDigit = 48 + radix; // exclusive
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (t.length > 3) throw new CodecError(`That is not a valid ${label} byte list (each number is 0 to 255).`);
      let v = 0;
      for (let j = 0; j < t.length; j++) {
        const c = t.charCodeAt(j);
        if (c < 48 || c >= maxDigit) throw new CodecError(`That is not a valid ${label} byte list.`);
        v = v * radix + (c - 48);
      }
      if (v > 255) throw new CodecError(`That is not a valid ${label} byte list (each number is 0 to 255).`);
      out[i] = v;
    }
    return out;
  }

  /** Hex or Base64 (auto-detected; hex wins when both fit). Returns null when it is neither. */
  function parseBinaryText(text) {
    const s = stripSpace(text);
    if (!s) return null;
    try { return hexBytes(s); } catch (e) { /* not hex */ }
    let std = true;
    let url = true;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 43 || c === 47) url = false;
      else if (c === 45 || c === 95) std = false;
    }
    try {
      if (std) return base64Bytes(s, false);
      if (url) return base64Bytes(s, true);
    } catch (e) { /* not base64 */ }
    return null;
  }

  // ----------------------------------------------------------- text codecs

  const NAMED_ENTITIES = new Map([
    ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"], ['nbsp', ' '], ['copy', '©'],
    ['reg', '®'], ['hellip', '…'], ['mdash', '—'], ['ndash', '–'], ['lsquo', '‘'],
    ['rsquo', '’'], ['ldquo', '“'], ['rdquo', '”'], ['euro', '€'], ['trade', '™'],
  ]);

  function htmlEncode(text) {
    let out = '';
    let from = 0;
    for (let i = 0; i < text.length; i++) {
      let rep = null;
      switch (text.charCodeAt(i)) {
        case 38: rep = '&amp;'; break;
        case 60: rep = '&lt;'; break;
        case 62: rep = '&gt;'; break;
        case 34: rep = '&quot;'; break;
        case 39: rep = '&#39;'; break;
        default: break;
      }
      if (rep) { out += text.slice(from, i) + rep; from = i + 1; }
    }
    return out + text.slice(from);
  }

  function htmlDecode(text) {
    let out = '';
    let from = 0;
    let i = text.indexOf('&');
    while (i !== -1) {
      let semi = -1;
      for (let j = i + 1; j < text.length && j <= i + 10; j++) {
        if (text.charCodeAt(j) === 59) { semi = j; break; }
      }
      let rep = null;
      if (semi > i + 1) {
        const body = text.slice(i + 1, semi);
        if (body.charCodeAt(0) === 35) {
          const hex = body.charCodeAt(1) === 120 || body.charCodeAt(1) === 88;
          const digits = body.slice(hex ? 2 : 1);
          let v = 0;
          let valid = digits.length >= 1 && digits.length <= 7;
          for (let k = 0; valid && k < digits.length; k++) {
            const d = hex ? hexVal(digits.charCodeAt(k)) : (digits.charCodeAt(k) >= 48 && digits.charCodeAt(k) <= 57 ? digits.charCodeAt(k) - 48 : -1);
            if (d < 0) valid = false; else v = v * (hex ? 16 : 10) + d;
          }
          if (valid && v >= 1 && v <= 0x10ffff && !(v >= 0xd800 && v <= 0xdfff)) rep = String.fromCodePoint(v);
        } else if (NAMED_ENTITIES.has(body)) {
          rep = NAMED_ENTITIES.get(body);
        }
      }
      if (rep !== null) {
        out += text.slice(from, i) + rep;
        from = semi + 1;
        i = text.indexOf('&', from);
      } else {
        i = text.indexOf('&', i + 1);
      }
    }
    return out + text.slice(from);
  }

  function unicodeEscapeEncode(text) {
    const out = [];
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c >= 0x20 && c <= 0x7e && c !== 0x5c) out.push(text[i]);
      else out.push('\\u' + c.toString(16).padStart(4, '0'));
    }
    return out.join('');
  }

  function unicodeEscapeDecode(text) {
    const out = [];
    let i = 0;
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === 92 && i + 1 < text.length) {
        const k = text.charCodeAt(i + 1);
        if (k === 117 && text.charCodeAt(i + 2) === 123) { // \u{...}
          let j = i + 3;
          let v = 0;
          while (j < text.length && j < i + 10 && hexVal(text.charCodeAt(j)) >= 0) { v = v * 16 + hexVal(text.charCodeAt(j)); j++; }
          if (j > i + 3 && text.charCodeAt(j) === 125 && v <= 0x10ffff) { out.push(String.fromCodePoint(v)); i = j + 1; continue; }
        } else if (k === 117 && fourHex(text, i + 2)) {
          out.push(String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16)));
          i += 6;
          continue;
        } else if (k === 120 && hexVal(text.charCodeAt(i + 2)) >= 0 && hexVal(text.charCodeAt(i + 3)) >= 0) {
          out.push(String.fromCharCode(hexVal(text.charCodeAt(i + 2)) * 16 + hexVal(text.charCodeAt(i + 3))));
          i += 4;
          continue;
        }
      }
      out.push(text[i]);
      i++;
    }
    return out.join('');
  }

  function fourHex(text, at) {
    if (at + 4 > text.length) return false;
    for (let j = 0; j < 4; j++) if (hexVal(text.charCodeAt(at + j)) < 0) return false;
    return true;
  }

  // --------------------------------------------------------------- ciphers

  function mapCodes(text, fn) {
    const out = new Array(text.length);
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      const r = fn(c);
      out[i] = r === c ? text[i] : String.fromCharCode(r);
    }
    return out.join('');
  }

  function shiftLetter(c, shift) {
    if (c >= 65 && c <= 90) return 65 + ((c - 65 + shift) % 26);
    if (c >= 97 && c <= 122) return 97 + ((c - 97 + shift) % 26);
    return c;
  }

  const rot13 = (t) => mapCodes(t, (c) => shiftLetter(c, 13));
  const rot47 = (t) => mapCodes(t, (c) => (c >= 33 && c <= 126 ? 33 + ((c - 33 + 47) % 94) : c));
  const atbash = (t) => mapCodes(t, (c) => {
    if (c >= 65 && c <= 90) return 90 - (c - 65);
    if (c >= 97 && c <= 122) return 122 - (c - 97);
    return c;
  });
  const caesar = (t, shift) => mapCodes(t, (c) => shiftLetter(c, shift));
  const reverseText = (t) => Array.from(t).reverse().join('');

  function swapCase(text) {
    const out = [];
    for (const ch of text) {
      const lo = ch.toLowerCase();
      const up = ch.toUpperCase();
      let r = ch;
      if (ch !== up) { if (up.length === ch.length && up.toLowerCase() === ch) r = up; } else if (ch !== lo) { if (lo.length === ch.length && lo.toUpperCase() === ch) r = lo; }
      out.push(r);
    }
    return out.join('');
  }

  function paramsOf(params) { return params !== null && typeof params === 'object' ? params : {}; }

  function intParam(params, name, label, min, max) {
    const v = paramsOf(params)[name];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      throw new CodecError(`${label} must be a whole number from ${min} to ${max}.`);
    }
    return v;
  }

  function vigenere(text, params, sign) {
    const key = paramsOf(params).key;
    if (typeof key !== 'string' || key.length < 1 || key.length > 64) throw new CodecError('The key must be 1 to 64 letters (A to Z).');
    const shifts = [];
    for (let i = 0; i < key.length; i++) {
      const c = key.charCodeAt(i) | 32;
      if (c < 97 || c > 122 || key.charCodeAt(i) > 127) throw new CodecError('The key must be 1 to 64 letters (A to Z).');
      shifts.push(c - 97);
    }
    let k = 0;
    return mapCodes(text, (c) => {
      const isLetter = (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
      if (!isLetter) return c;
      const s = (sign * shifts[k % shifts.length] + 26) % 26;
      k++;
      return shiftLetter(c, s);
    });
  }

  function railOrder(n, rails) {
    const rows = Array.from({ length: rails }, () => []);
    let r = 0;
    let dir = 1;
    for (let i = 0; i < n; i++) {
      rows[r].push(i);
      if (r === 0) dir = 1; else if (r === rails - 1) dir = -1;
      r += dir;
    }
    return [].concat(...rows);
  }

  function railFence(text, params, decode) {
    const rails = intParam(params, 'rails', 'Rails', 2, 10);
    const chars = Array.from(text);
    const order = railOrder(chars.length, rails);
    const out = new Array(chars.length);
    for (let k = 0; k < order.length; k++) {
      if (decode) out[order[k]] = chars[k]; else out[k] = chars[order[k]];
    }
    return out.join('');
  }

  const MORSE = {
    A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..',
    M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-',
    Y: '-.--', Z: '--..', 0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...',
    8: '---..', 9: '----.', '.': '.-.-.-', ',': '--..--', '?': '..--..', "'": '.----.', '!': '-.-.--', '(': '-.--.', ')': '-.--.-',
    '&': '.-...', ':': '---...', ';': '-.-.-.', '=': '-...-', '+': '.-.-.', '-': '-....-', _: '..--.-', '"': '.-..-.', $: '...-..-',
    '@': '.--.-.',
  };
  const MORSE_REVERSE = new Map(Object.entries(MORSE).map(([k, v]) => [v, k]));

  function morseEncode(text) {
    const words = [];
    let word = [];
    for (let i = 0; i <= text.length; i++) {
      const c = i < text.length ? text.charCodeAt(i) : 32;
      if (isSpaceCode(c)) {
        if (word.length) { words.push(word.join(' ')); word = []; }
        continue;
      }
      const ch = c < 128 ? String.fromCharCode(c).toUpperCase() : '';
      const code = Object.prototype.hasOwnProperty.call(MORSE, ch) ? MORSE[ch] : undefined;
      if (code === undefined) throw new CodecError(`Morse code cannot represent "${text[i]}".`);
      word.push(code);
    }
    if (!words.length) throw new CodecError(MSG_EMPTY);
    return words.join(' / ');
  }

  function morseDecode(text) {
    const words = [];
    let word = '';
    let cur = '';
    let pending = false;
    const endLetter = () => {
      if (!cur) return;
      const ch = MORSE_REVERSE.get(cur);
      if (ch === undefined) throw new CodecError('That is not valid Morse code.');
      word += ch;
      cur = '';
    };
    for (let i = 0; i <= text.length; i++) {
      const c = i < text.length ? text.charCodeAt(i) : 32;
      if (c === 46 || c === 45) {
        cur += text[i];
        if (cur.length > 7) throw new CodecError('That is not valid Morse code.');
        pending = true;
      } else if (c === 47 || isSpaceCode(c)) {
        endLetter();
        if (c === 47 && word) { words.push(word); word = ''; }
      } else {
        throw new CodecError('That is not valid Morse code (use dots, dashes, spaces and /).');
      }
    }
    if (word) words.push(word);
    if (!pending || !words.length) throw new CodecError('That is not valid Morse code.');
    return words.join(' ');
  }

  // ------------------------------------------------------------------- xor

  function xorKey(params) {
    const p = paramsOf(params);
    const format = p.keyFormat === undefined ? 'text' : p.keyFormat;
    if (format !== 'text' && format !== 'hex') throw new CodecError('Key format must be "text" or "hex".');
    if (typeof p.key !== 'string') throw new CodecError('The key must be 1 to 256 bytes.');
    if (p.key.length > 1024) throw new CodecError('The key must be 1 to 256 bytes.');
    let bytes;
    if (format === 'hex') {
      const s = stripSpace(p.key);
      if (!s.length || s.length % 2 || s.length > 512) throw new CodecError('The hex key must be 1 to 256 bytes of hex digits.');
      try { bytes = hexBytes(s); } catch (e) { throw new CodecError('The hex key must be 1 to 256 bytes of hex digits.'); }
    } else {
      bytes = toBytes(p.key);
    }
    if (bytes.length < 1 || bytes.length > 256) throw new CodecError('The key must be 1 to 256 bytes.');
    return bytes;
  }

  function xorBytes(bytes, key) {
    const out = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ key[i % key.length];
    return out;
  }

  // ---------------------------------------------------------------- codecs

  function result(output) { return { ok: true, output }; }
  function failure(message) { return { ok: false, message }; }

  /** Wrap an implementation (text, params) -> string so it validates, never throws and respects the limits. */
  function wrap(impl, decoding) {
    return function run(text, params) {
      try {
        if (typeof text !== 'string') return failure(MSG_EMPTY);
        if (text.length > LIMITS.input) return failure(MSG_TOO_LONG);
        if (text === '' || (decoding && isBlank(text))) return failure(MSG_EMPTY);
        const out = impl(text, params);
        if (typeof out !== 'string') return failure('That text could not be converted.');
        if (out.length > LIMITS.output) return failure(MSG_OUT_TOO_LONG);
        return result(out);
      } catch (err) {
        if (err instanceof CodecError) return failure(err.message);
        return failure('That text could not be converted.');
      }
    };
  }

  const enc = (fn) => wrap((t, p) => fn(toBytes(t), p), false);
  const dec = (fn) => wrap((t, p) => fromBytes(fn(t, p)), true);
  const txtEnc = (fn) => wrap(fn, false);
  const txtDec = (fn) => wrap(fn, true);

  function define(id, name, group, fns, params) {
    const c = { id, name, group };
    if (fns.encode) c.encode = fns.encode;
    if (fns.decode) c.decode = fns.decode;
    if (params) c.params = Object.freeze(params.map((p) => Object.freeze(p)));
    return Object.freeze(c);
  }

  const symmetric = (fn) => ({ encode: txtEnc(fn), decode: txtDec(fn) });

  const CODECS = Object.freeze([
    define('base64', 'Base64', 'Base', { encode: enc(base64Encode), decode: dec((t) => base64Bytes(t, false)) }),
    define('base64url', 'Base64 (URL-safe)', 'Base', { encode: enc((b) => encodeBits(b, B64URL, 6)), decode: dec((t) => base64Bytes(t, true)) }),
    define('base32', 'Base32', 'Base', { encode: enc(base32Encode), decode: dec(base32Bytes) }),
    define('base58', 'Base58', 'Base', { encode: enc(base58Encode), decode: dec(base58Bytes) }),
    define('ascii85', 'Ascii85', 'Base', { encode: enc(ascii85Encode), decode: dec(ascii85Bytes) }),
    define('z85', 'Z85', 'Base', { encode: enc(z85Encode), decode: dec(z85Bytes) }),
    define('hex', 'Hex', 'Bytes', { encode: enc(hexOf), decode: dec(hexBytes) }),
    define('binary', 'Binary', 'Bytes', { encode: enc(binaryEncode), decode: dec(binaryBytes) }),
    define('octal', 'Octal bytes', 'Bytes', {
      encode: enc((b) => Array.from(b, (x) => x.toString(8).padStart(3, '0')).join(' ')),
      decode: dec((t) => numberListBytes(t, 8, 'octal')),
    }),
    define('decimal', 'Decimal bytes', 'Bytes', {
      encode: enc((b) => Array.from(b).join(' ')),
      decode: dec((t) => numberListBytes(t, 10, 'decimal')),
    }),
    define('url', 'URL encoding', 'Text', {
      encode: txtEnc((t) => {
        try { return encodeURIComponent(t); } catch (e) { throw new CodecError('That text has characters that cannot be URL-encoded.'); }
      }),
      decode: txtDec((t) => {
        try { return decodeURIComponent(t); } catch (e) { throw new CodecError('That text has a broken % escape.'); }
      }),
    }),
    define('htmlEntities', 'HTML entities', 'Text', { encode: txtEnc(htmlEncode), decode: txtDec(htmlDecode) }),
    define('unicodeEscape', 'Unicode escapes', 'Text', { encode: txtEnc(unicodeEscapeEncode), decode: txtDec(unicodeEscapeDecode) }),
    define('rot13', 'ROT13', 'Ciphers', symmetric(rot13)),
    define('rot47', 'ROT47', 'Ciphers', symmetric(rot47)),
    define('atbash', 'Atbash', 'Ciphers', symmetric(atbash)),
    define('caesar', 'Caesar', 'Ciphers', {
      encode: txtEnc((t, p) => caesar(t, intParam(p, 'shift', 'Shift', 1, 25))),
      decode: txtDec((t, p) => caesar(t, 26 - intParam(p, 'shift', 'Shift', 1, 25))),
    }, [{ id: 'shift', label: 'Shift', type: 'int', min: 1, max: 25, default: 3 }]),
    define('vigenere', 'Vigenère', 'Ciphers', {
      encode: txtEnc((t, p) => vigenere(t, p, 1)),
      decode: txtDec((t, p) => vigenere(t, p, -1)),
    }, [{ id: 'key', label: 'Key (letters)', type: 'text', min: 1, max: 64, default: '' }]),
    define('railFence', 'Rail fence', 'Ciphers', {
      encode: txtEnc((t, p) => railFence(t, p, false)),
      decode: txtDec((t, p) => railFence(t, p, true)),
    }, [{ id: 'rails', label: 'Rails', type: 'int', min: 2, max: 10, default: 3 }]),
    define('xor', 'XOR', 'Ciphers', {
      encode: wrap((t, p) => { const key = xorKey(p); return hexOf(xorBytes(toBytes(t), key)); }, false),
      decode: wrap((t, p) => {
        const key = xorKey(p);
        const bytes = parseBinaryText(t);
        if (!bytes) throw new CodecError('XOR input must be hex or Base64.');
        return fromBytes(xorBytes(bytes, key));
      }, true),
    }, [
      { id: 'key', label: 'Key', type: 'text', min: 1, max: 256, default: '' },
      { id: 'keyFormat', label: 'Key format', type: 'choice', choices: Object.freeze(['text', 'hex']), default: 'text' },
    ]),
    define('reverse', 'Reverse text', 'Other', symmetric(reverseText)),
    define('swapCase', 'Swap case', 'Other', symmetric(swapCase)),
    define('morse', 'Morse code', 'Other', { encode: txtEnc(morseEncode), decode: txtDec(morseDecode) }),
  ]);

  const BY_ID = new Map(CODECS.map((c) => [c.id, c]));

  // --------------------------------------------------------------- scoring

  const FREQ = {
    e: 12.7, t: 9.1, a: 8.2, o: 7.5, i: 7.0, n: 6.7, s: 6.3, h: 6.1, r: 6.0, d: 4.3, l: 4.0, c: 2.8, u: 2.8, m: 2.4, w: 2.4,
    f: 2.2, g: 2.0, y: 2.0, p: 1.9, b: 1.5, v: 1.0, k: 0.8, j: 0.15, x: 0.15, q: 0.1, z: 0.07,
  };
  const WEIGHT = (() => {
    const w = new Float64Array(128);
    for (let c = 32; c < 127; c++) w[c] = 0.4;
    w[32] = 1;
    for (const ch of '.,\'"!?-:;()') w[ch.charCodeAt(0)] = 0.6;
    for (let c = 48; c < 58; c++) w[c] = 0.5;
    for (const k of Object.keys(FREQ)) {
      const v = Math.min(1, 0.15 + FREQ[k] * 0.12);
      w[k.charCodeAt(0)] = v;
      w[k.toUpperCase().charCodeAt(0)] = v;
    }
    w[9] = w[10] = w[13] = 0.6;
    return w;
  })();
  const COMMON_PAIRS = new Set(('th he in er an re on at en nd ti es or te of ed is it al ar st to nt ng se ha as ou io le ve co me de hi ri ro ic ne ea ra ce li ch ll be ma si om ur')
    .split(' ').map((p) => ((p.charCodeAt(0) - 97) << 5) | (p.charCodeAt(1) - 97)));
  const COMMON_WORDS = new Set('the and of to a in is it you that he was for on are with as his they be at one have this from or had by not but what all were we when your can said there use an each which she do how their if will up'.split(' ').filter((w) => w.length <= 4));
  const FREQ_LETTER = (() => {
    const t = new Uint8Array(128);
    for (let c = 65; c <= 90; c++) { t[c] = 1; t[c + 32] = 1; }
    return t;
  })();
  const SCORE_SAMPLE = 4000;
  const FLAG_SCORE_SAMPLE = 20000;

  function rawScore(text) {
    const n = Math.min(text.length, SCORE_SAMPLE);
    if (!n) return 0;
    let sum = 0;
    let letters = 0;
    let symbols = 0;
    for (let i = 0; i < n; i++) {
      const c = text.charCodeAt(i);
      if (c < 128) {
        sum += WEIGHT[c];
        if (WEIGHT[c] === 0.4) symbols++; // printable ASCII that is not a letter, digit, space or common punctuation
        else if (FREQ_LETTER[c]) letters++;
      }
    }
    let v = (sum / n - 0.55) / 0.25;
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    // Real prose is full of common letter pairs; shifted or random letters are not.
    let pairs = 0;
    let common = 0;
    let prev = -1;
    for (let i = 0; i < n; i++) {
      const c = text.charCodeAt(i) | 32;
      const letter = c >= 97 && c <= 122;
      if (letter && prev >= 0) {
        pairs++;
        if (COMMON_PAIRS.has(((prev - 97) << 5) | (c - 97))) common++;
      }
      prev = letter ? c : -1;
    }
    if (pairs >= 6) {
      const f = (common / pairs - 0.2) / 0.2;
      v *= f < 0 ? 0 : f > 1 ? 1 : f;
    }
    const alpha = (letters / n - 0.3) / 0.3; // mostly letters
    v *= alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    v *= Math.max(0, 1 - (3 * symbols) / n); // few stray symbols
    // Common short English words (a mild factor: technical text without them still passes).
    let words = 0;
    let commonWords = 0;
    let start = -1;
    for (let i = 0; i <= n; i++) {
      const c = i < n ? text.charCodeAt(i) | 32 : 0;
      if (c >= 97 && c <= 122) { if (start < 0) start = i; } else if (start >= 0) {
        words++;
        if (i - start <= 4 && COMMON_WORDS.has(text.slice(start, i).toLowerCase())) commonWords++;
        start = -1;
      }
    }
    if (words >= 4) {
      const w = commonWords / words / 0.15;
      v *= 0.75 + 0.25 * (w > 1 ? 1 : w);
    }
    return v;
  }

  function printableShare(text) {
    const n = Math.min(text.length, SCORE_SAMPLE);
    if (!n) return 0;
    let ok = 0;
    for (let i = 0; i < n; i++) {
      const c = text.charCodeAt(i);
      if ((c >= 32 && c < 127) || c === 9 || c === 10 || c === 13) ok++;
    }
    return ok / n;
  }

  /** Readability in [0, 1]: weighted share of printable ASCII (common English letters and spaces count most), plus a bonus for a flag. */
  function readableScore(text, prefixes) {
    if (typeof text !== 'string' || text === '') return 0;
    let s = rawScore(text);
    const head = text.length > FLAG_SCORE_SAMPLE ? text.slice(0, FLAG_SCORE_SAMPLE) : text;
    if (findFlags(head, prefixes).length) s = 0.8 + 0.2 * s;
    return s;
  }

  // ----------------------------------------------------------------- flags

  function validatePrefixes(list) {
    const out = [];
    if (Array.isArray(list)) {
      const seen = new Set();
      const max = Math.min(list.length, 10000);
      for (let i = 0; i < max && out.length < LIMITS.prefixes; i++) {
        const p = list[i];
        if (typeof p !== 'string' || !/^[A-Za-z0-9_]{1,20}$/.test(p)) continue;
        const key = p.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(p);
      }
    }
    return out.length ? out : DEFAULT_PREFIXES.slice();
  }

  function isWordCode(c) { return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95; }
  const LETTER_OR_DIGIT = /^[\p{L}\p{N}]$/u;

  /** True when the character that ends just before `idx` is a letter, digit or underscore. */
  function wordBefore(text, idx) {
    const c = text.charCodeAt(idx - 1);
    if (c < 128) return isWordCode(c);
    if (c >= 0xdc00 && c <= 0xdfff && idx >= 2) {
      const h = text.charCodeAt(idx - 2);
      if (h >= 0xd800 && h <= 0xdbff) return LETTER_OR_DIGIT.test(text.slice(idx - 2, idx));
    }
    return LETTER_OR_DIGIT.test(text[idx - 1]);
  }

  /** True when the character that starts at `idx` is a letter, digit or underscore. */
  function wordAt(text, idx) {
    const c = text.charCodeAt(idx);
    if (c < 128) return isWordCode(c);
    if (c >= 0xd800 && c <= 0xdbff && idx + 1 < text.length) {
      const l = text.charCodeAt(idx + 1);
      if (l >= 0xdc00 && l <= 0xdfff) return LETTER_OR_DIGIT.test(text.slice(idx, idx + 2));
    }
    return LETTER_OR_DIGIT.test(text[idx]);
  }

  function isBreak(c) { return c === 10 || c === 13 || c === 0x2028 || c === 0x2029; }

  function prefixMap(prefixes) {
    return new Map(prefixes.map((p) => [p.toLowerCase(), p]));
  }

  /** Calls found(flag, prefix, position) for each plain flag in `text`, in order, until it returns false. */
  function scanPlain(text, map, found) {
    let b = text.indexOf('{');
    while (b !== -1) {
      let s = b;
      while (s > 0 && b - s < 21 && isWordCode(text.charCodeAt(s - 1))) s--;
      const len = b - s;
      if (len >= 1 && len <= 20 && !(s > 0 && wordBefore(text, s))) {
        const prefix = map.get(text.slice(s, b).toLowerCase());
        if (prefix !== undefined) {
          const lim = Math.min(text.length, b + LIMITS.flagBody + 2);
          let e = b + 1;
          let closed = false;
          while (e < lim) {
            const c = text.charCodeAt(e);
            if (c === 125) { closed = e > b + 1; break; }
            if (c === 123 || isBreak(c)) break;
            e++;
          }
          if (closed && found(text.slice(s, e + 1), prefix, s) === false) return;
        }
      }
      b = text.indexOf('{', b + 1);
    }
  }

  /** Same as scanPlain but for the text read backwards: `}body{xiferp`. Reported flags are in reading order. */
  function scanReversed(text, map, found) {
    let c = text.indexOf('}');
    while (c !== -1) {
      const lim = Math.min(text.length, c + LIMITS.flagBody + 2);
      let e = c + 1;
      let open = false;
      while (e < lim) {
        const ch = text.charCodeAt(e);
        if (ch === 123) { open = e > c + 1; break; }
        if (ch === 125 || isBreak(ch)) break;
        e++;
      }
      if (open) {
        let w = e + 1;
        while (w < text.length && w - (e + 1) < 21 && isWordCode(text.charCodeAt(w))) w++;
        const len = w - (e + 1);
        if (len >= 1 && len <= 20 && !(w < text.length && wordAt(text, w))) {
          const prefix = map.get(Array.from(text.slice(e + 1, w)).reverse().join('').toLowerCase());
          if (prefix !== undefined && found(Array.from(text.slice(c, w)).reverse().join(''), prefix, c) === false) return;
        }
      }
      c = text.indexOf('}', c + 1);
    }
  }

  /** Returns a function mapping a position to its 1-based line; cheap for positions that only increase. */
  function makeLiner(text) {
    let pos = 0;
    let line = 1;
    let nl = text.indexOf('\n');
    return (target) => {
      if (target < pos) { pos = 0; line = 1; nl = text.indexOf('\n'); }
      while (nl !== -1 && nl < target) { line++; pos = nl + 1; nl = text.indexOf('\n', pos); }
      return line;
    };
  }

  const RUN_TABLE = (() => {
    const t = new Uint8Array(128);
    for (const a of [B64, B64URL]) for (let i = 0; i < a.length; i++) t[a.charCodeAt(i)] = 1;
    return t;
  })();

  function runBytes(run) {
    const found = [];
    let allHex = true;
    let std = true;
    let url = true;
    let b32 = true;
    for (let i = 0; i < run.length; i++) {
      const c = run.charCodeAt(i);
      if (hexVal(c) < 0) allHex = false;
      if (c === 43 || c === 47) url = false;
      if (c === 45 || c === 95) std = false;
      const u = c >= 97 && c <= 122 ? c - 32 : c;
      if (!((u >= 65 && u <= 90) || (u >= 50 && u <= 55))) b32 = false;
    }
    try {
      if (allHex) found.push({ via: 'hex', bytes: hexBytes(run.length % 2 ? run.slice(0, -1) : run) });
      if (b32) {
        let n = run.length;
        const r = n % 8;
        if (r === 1 || r === 3 || r === 6) n -= 1;
        found.push({ via: 'base32', bytes: decodeBits(run.slice(0, n), T32, 5, 'Base32', true) });
      }
      if (std || url) {
        const n = run.length - (run.length % 4 === 1 ? 1 : 0);
        found.push({ via: 'base64', bytes: decodeBits(run.slice(0, n), std ? T64 : T64URL, 6, 'Base64', false) });
      }
    } catch (e) { /* skip undecodable runs */ }
    return found;
  }

  /** Flags in text. Searches only the first 5,000,000 characters. Up to 200 results, unique by flag + via. */
  function findFlags(text, prefixes, options) {
    const out = [];
    if (typeof text !== 'string' || text === '') return out;
    const t = text.length > MAX_FLAG_SCAN ? text.slice(0, MAX_FLAG_SCAN) : text;
    const map = prefixMap(validatePrefixes(prefixes));
    const plainOnly = !!(options && options.plainOnly);
    const seen = new Set();
    const add = (flag, prefix, lineOf, via) => {
      const key = via + '\u0000' + flag;
      if (seen.has(key)) return true;
      seen.add(key);
      out.push({ flag, prefix, line: lineOf(), via });
      return out.length < MAX_FLAG_RESULTS;
    };

    let liner = makeLiner(t);
    scanPlain(t, map, (flag, prefix, pos) => add(flag, prefix, () => liner(pos), 'plain'));
    if (plainOnly || out.length >= MAX_FLAG_RESULTS) return out;

    liner = makeLiner(t);
    scanReversed(t, map, (flag, prefix, pos) => add(flag, prefix, () => liner(pos), 'reversed'));
    if (out.length >= MAX_FLAG_RESULTS) return out;

    liner = makeLiner(t);
    let runs = 0;
    let i = 0;
    while (i < t.length && runs < MAX_ENCODED_RUNS && out.length < MAX_FLAG_RESULTS) {
      const c = t.charCodeAt(i);
      if (c >= 128 || !RUN_TABLE[c]) { i++; continue; }
      const start = i;
      while (i < t.length && t.charCodeAt(i) < 128 && RUN_TABLE[t.charCodeAt(i)]) i++;
      if (i - start < MIN_RUN_CHARS) continue;
      runs++;
      const run = t.slice(start, Math.min(i, start + MAX_RUN_CHARS));
      const line = () => liner(start);
      for (const cand of runBytes(run)) {
        const decoded = decoderLoose.decode(cand.bytes);
        scanPlain(decoded, map, (flag, prefix) => add(flag, prefix, line, cand.via));
      }
    }
    return out;
  }

  // --------------------------------------------------------- brute forcing

  function cap(text) { return text.length > LIMITS.resultChars ? text.slice(0, LIMITS.resultChars) : text; }

  function caesarBruteForce(text) {
    if (typeof text !== 'string' || text === '' || text.length > LIMITS.input) return [];
    const head = cap(text);
    const out = [];
    for (let shift = 1; shift <= 25; shift++) out.push({ shift, output: caesar(head, 26 - shift) });
    return out;
  }

  function xorCandidates(bytes, count) {
    const head = bytes.subarray(0, LIMITS.resultChars);
    const all = [];
    const key = new Uint8Array(1);
    for (let k = 0; k < 256; k++) {
      key[0] = k;
      const output = decoderLoose.decode(xorBytes(head, key));
      all.push({ key: k, keyHex: HEX[k >> 4] + HEX[k & 15], output, score: rawScore(output) });
    }
    all.sort((a, b) => b.score - a.score || a.key - b.key);
    return count ? all.slice(0, count) : all;
  }

  function xorBruteForce(text) {
    if (typeof text !== 'string' || text === '' || text.length > LIMITS.input) return [];
    const bytes = parseBinaryText(text) || toBytes(text);
    if (!bytes.length) return [];
    return xorCandidates(bytes, 10);
  }

  // ------------------------------------------------------- common decodings

  const ENCODING_IDS = ['base64', 'base64url', 'base32', 'base58', 'ascii85', 'z85', 'hex', 'binary', 'octal', 'decimal', 'url', 'htmlEntities', 'unicodeEscape', 'morse'];
  const CIPHER_IDS = ['rot13', 'rot47', 'atbash', 'reverse'];

  /**
   * Try the parameterless decoders up to 3 layers deep (breadth first). Caesar and single-byte XOR are leaf steps.
   * Bounded by a hard budget of 400 decoder attempts and 20,000,000 characters processed.
   */
  function tryDecodings(text, prefixes) {
    if (typeof text !== 'string' || text === '' || text.length > LIMITS.input) return [];
    const pf = validatePrefixes(prefixes);
    const map = prefixMap(pf);
    const seen = new Set([text]);
    const shownOutputs = new Set(); // results are also unique after the 2,000-character cap
    const results = [];
    let attempts = 0;
    let chars = 0;
    const spend = (n) => {
      if (attempts >= SEARCH_MAX_ATTEMPTS || chars + n > SEARCH_MAX_CHARS) return false;
      attempts++;
      chars += n;
      return true;
    };
    const hasFlag = (s) => {
      let hit = false;
      scanPlain(s, map, () => { hit = true; return false; });
      return hit;
    };

    const queue = [{ text, path: [], readable: rawScore(text) >= READABLE_THRESHOLD }];
    const accept = (output, path, detail) => {
      if (seen.has(output)) return;
      seen.add(output);
      const flag = hasFlag(output);
      const raw = rawScore(output);
      const score = flag ? 0.8 + 0.2 * raw : raw;
      const readable = score >= READABLE_THRESHOLD;
      const shown = cap(output);
      if ((readable || flag) && !shownOutputs.has(shown)) {
        shownOutputs.add(shown);
        const item = { path, output: shown, score };
        if (detail) item.detail = detail;
        results.push(item);
      }
      return { flag, readable };
    };

    outer:
    for (let qi = 0; qi < queue.length; qi++) {
      const node = queue[qi];
      const ids = node.readable ? ENCODING_IDS : ENCODING_IDS.concat(CIPHER_IDS);
      for (const id of ids) {
        if (!spend(node.text.length)) break outer;
        const r = BY_ID.get(id).decode(node.text);
        if (!r.ok || r.output === node.text || r.output.startsWith(DUMP_NOTE)) continue;
        const path = node.path.concat(id);
        const info = accept(r.output, path);
        if (info && !info.flag && path.length < LIMITS.layers && printableShare(r.output) >= 0.9) {
          queue.push({ text: r.output, path, readable: info.readable });
        }
      }
      // Leaf steps: they are results only and never explored further.
      if (spend(Math.min(node.text.length, LIMITS.resultChars) * 25)) {
        const head = cap(node.text);
        for (let shift = 1; shift <= 25; shift++) accept(caesar(head, 26 - shift), node.path.concat('caesar'), `shift ${shift}`);
      } else break;
      if (spend(LIMITS.resultChars * 256)) {
        const bytes = parseBinaryText(node.text);
        if (bytes && bytes.length) {
          for (const c of xorCandidates(bytes, 0)) accept(c.output, node.path.concat('xor'), `key 0x${c.keyHex}`);
        }
      } else break;
    }

    results.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.join('>').localeCompare(b.path.join('>')));
    return results.slice(0, LIMITS.results);
  }

  // ------------------------------------------------------------- templates

  /** One line, control characters to spaces, trimmed, at most 120 characters. */
  function field(value) {
    if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
    if (typeof value !== 'string') return '';
    let s = value.length > 4 * FIELD_MAX ? value.slice(0, 4 * FIELD_MAX) : value;
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      out += (c < 32 || c === 127 || c === 0x85 || c === 0x2028 || c === 0x2029) ? ' ' : s[i];
    }
    s = out.trim();
    if (s.length > FIELD_MAX) {
      let cut = FIELD_MAX;
      const last = s.charCodeAt(cut - 1);
      if (last >= 0xd800 && last <= 0xdbff) cut--; // do not split a surrogate pair
      s = s.slice(0, cut).trimEnd();
    }
    return s;
  }

  function line(label, value) { return value ? `- ${label}: ${value}` : `- ${label}:`; }

  function challengeTemplate(opts) {
    const o = paramsOf(opts);
    const name = field(o.name) || 'Untitled challenge';
    const lowerCat = field(o.category).toLowerCase();
    const category = CATEGORIES.includes(lowerCat) ? lowerCat : 'misc';
    const p = o.points;
    const points = typeof p === 'number' && Number.isInteger(p) && p >= 0 && p <= 100000 ? p : 0;
    return [
      `# ${name}`, '',
      line('Event', field(o.event)),
      `- Category: ${category}`,
      `- Points: ${points}`,
      '- Status: unsolved',
      '- Flag:', '',
      '## Description', '',
      '## Files and endpoints', '',
      '## Recon', '',
      '## Solution', '',
      '## Solve script', '',
      '## Notes', '',
    ].join('\n');
  }

  function pad2(n) { return String(n).padStart(2, '0'); }
  function dateText(d) {
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
    return `${String(d.getFullYear()).padStart(4, '0')}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function writeupTemplate(opts) {
    const o = paramsOf(opts);
    const event = field(o.event);
    return [
      `# ${event ? `${event} writeup` : 'CTF writeup'}`, '',
      line('Event', event),
      line('Date', dateText(o.date)),
      line('Team', field(o.team)), '',
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
    ].join('\n');
  }

  // ------------------------------------------------------ challenge parsing

  const PARSE_LINES = 40;
  const PARSE_CHARS = 200000;

  function startsWithCI(s, prefix) {
    return s.length >= prefix.length && s.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();
  }

  /** Read a challenge note made from the template, or null when it has no `- Category:` line in its first 40 lines. */
  function parseChallenge(body) {
    if (typeof body !== 'string') return null;
    const text = body.length > PARSE_CHARS ? body.slice(0, PARSE_CHARS) : body;
    const found = {};
    let pos = 0;
    for (let n = 0; n < PARSE_LINES && pos <= text.length; n++) {
      let end = text.indexOf('\n', pos);
      if (end === -1) end = text.length;
      let ln = text.slice(pos, end);
      if (ln.endsWith('\r')) ln = ln.slice(0, -1);
      pos = end + 1;
      if (ln.startsWith('# ')) { if (found.name === undefined) found.name = ln.slice(2); continue; }
      for (const key of ['Event', 'Category', 'Points', 'Status', 'Flag']) {
        const label = `- ${key}:`;
        if (found[key] === undefined && startsWithCI(ln, label)) { found[key] = ln.slice(label.length); break; }
      }
    }
    if (found.Category === undefined) return null;
    const rawCat = field(found.Category);
    const cat = rawCat.toLowerCase();
    const category = CATEGORIES.includes(cat) ? cat : rawCat;
    const ptsText = field(found.Points);
    let points = 0;
    if (ptsText.length >= 1 && ptsText.length <= 6) {
      let ok = true;
      for (let i = 0; i < ptsText.length; i++) if (ptsText.charCodeAt(i) < 48 || ptsText.charCodeAt(i) > 57) ok = false;
      if (ok && Number(ptsText) <= 100000) points = Number(ptsText);
    }
    const status = field(found.Status);
    const flag = field(found.Flag);
    return {
      name: field(found.name), event: field(found.Event), category, points, status, flag,
      solved: startsWithCI(status, 'solved') || flag !== '',
    };
  }

  // ---------------------------------------------------------------- report

  function fenceOpen(ln) {
    let i = 0;
    while (i < ln.length && i < 3 && ln[i] === ' ') i++;
    const ch = ln[i];
    if (ch !== '`' && ch !== '~') return null;
    let n = 0;
    while (ln[i + n] === ch) n++;
    if (n < 3) return null;
    if (ch === '`' && ln.indexOf('`', i + n) !== -1) return null;
    return { ch, n };
  }

  function fenceCloses(ln, f) {
    let i = 0;
    while (i < ln.length && i < 3 && ln[i] === ' ') i++;
    let n = 0;
    while (ln[i + n] === f.ch) n++;
    if (n < f.n) return false;
    for (let j = i + n; j < ln.length; j++) if (ln[j] !== ' ' && ln[j] !== '\t') return false;
    return true;
  }

  /** Move every Markdown heading down one level (capped at six), leaving fenced code alone. */
  function demoteHeadings(body) {
    const lines = body.split('\n');
    let fence = null;
    for (let k = 0; k < lines.length; k++) {
      const ln = lines[k];
      if (fence) { if (fenceCloses(ln, fence)) fence = null; continue; }
      const open = fenceOpen(ln);
      if (open) { fence = open; continue; }
      let i = 0;
      while (i < ln.length && i < 3 && ln[i] === ' ') i++;
      let h = 0;
      while (ln[i + h] === '#') h++;
      if (h >= 1 && h <= 6 && (i + h === ln.length || ln[i + h] === ' ' || ln[i + h] === '\t' || ln[i + h] === '\r')) {
        if (h < 6) lines[k] = ln.slice(0, i) + '#' + ln.slice(i);
      }
    }
    return lines.join('\n');
  }

  function cell(value) {
    let out = '';
    for (let i = 0; i < value.length; i++) {
      const c = value[i];
      out += c === '|' ? '\\|' : (c === '\n' || c === '\r') ? ' ' : c;
    }
    return out;
  }

  function fenceFor(script) {
    let longest = 0;
    let run = 0;
    for (let i = 0; i < script.length; i++) {
      if (script.charCodeAt(i) === 96) { run++; if (run > longest) longest = run; } else run = 0;
    }
    return '`'.repeat(Math.max(3, longest + 1));
  }

  function langLabel(lang) {
    let out = '';
    for (let i = 0; i < lang.length && out.length < 20; i++) {
      const c = lang.charCodeAt(i);
      if (isWordCode(c) || c === 43 || c === 35 || c === 45 || c === 46) out += lang[i];
    }
    return out || 'text';
  }

  const LIST_LINES = 100;

  function titleList(titles) {
    const shown = titles.slice(0, LIST_LINES).map((t) => `- ${t}`);
    if (titles.length > LIST_LINES) shown.push(`- and ${titles.length - LIST_LINES} more`);
    return shown.join('\n');
  }

  /**
   * Build the CTF report note for a folder. Encrypted notes are never read: only their titles are listed.
   * `notes` is an array of { title, body, lang, encrypted }.
   */
  function buildReport(opts) {
    const o = paramsOf(opts);
    const folder = field(o.folder) || 'Untitled folder';
    const title = `CTF report: ${folder}`;
    const skippedEncrypted = [];
    const challenges = [];
    const scripts = [];
    const list = Array.isArray(o.notes) ? o.notes.slice(0, 10000) : [];
    list.forEach((n, index) => {
      if (n === null || typeof n !== 'object') return;
      const noteTitle = field(n.title) || 'Untitled';
      if (n.encrypted) { skippedEncrypted.push(noteTitle); return; } // never touch the body
      const body = typeof n.body === 'string' ? n.body : '';
      if (body.startsWith('# CTF report: ')) return; // an earlier report in the same folder is not a challenge
      const parsed = parseChallenge(body);
      if (parsed) {
        challenges.push({ index, title: noteTitle, body, info: parsed });
      } else if (typeof n.lang === 'string' && n.lang !== '' && body !== '') {
        scripts.push({ index, title: noteTitle, body, lang: langLabel(n.lang) });
      }
    });
    challenges.sort((a, b) => {
      const ca = a.info.category.toLowerCase();
      const cb = b.info.category.toLowerCase();
      if (ca !== cb) return ca < cb ? -1 : 1;
      const na = (a.info.name || a.title).toLowerCase();
      const nb = (b.info.name || b.title).toLowerCase();
      if (na !== nb) return na < nb ? -1 : 1;
      return a.index - b.index;
    });

    // Add notes in order (challenges, then scripts) until the next one would pass the soft limit.
    let used = 0;
    const leftOut = [];
    const rows = [];
    const sections = [];
    const scriptBlocks = [];
    let full = false;
    let solved = 0;
    let points = 0;
    let possible = 0;
    let included = 0;
    for (const ch of challenges) {
      const i = ch.info;
      const row = `| ${cell(i.name || ch.title)} | ${cell(i.category)} | ${i.points} | ${cell(i.status || 'unsolved')} | ${i.flag ? 'yes' : 'no'} |`;
      const section = demoteHeadings(ch.body.trimEnd());
      const cost = row.length + section.length + 10;
      if (full || used + cost > REPORT_SOFT_LIMIT) { full = true; leftOut.push(ch.title); continue; }
      used += cost;
      rows.push(row);
      sections.push(section);
      included++;
      possible += i.points;
      if (i.solved) { solved++; points += i.points; }
    }
    for (const sc of scripts) {
      const fence = fenceFor(sc.body);
      const block = `### ${sc.title}\n\n${fence}${sc.lang}\n${sc.body.endsWith('\n') ? sc.body : sc.body + '\n'}${fence}`;
      if (full || used + block.length + 4 > REPORT_SOFT_LIMIT) { full = true; leftOut.push(sc.title); continue; }
      used += block.length + 4;
      scriptBlocks.push(block);
      included++;
    }

    const parts = [`# ${title}`, ''];
    const date = dateText(o.now);
    if (date) parts.push(`Date: ${date}`, '');
    parts.push('## Results', '');
    if (rows.length) {
      parts.push('| Challenge | Category | Points | Status | Flag found |', '| --- | --- | ---: | --- | --- |', ...rows, '');
      parts.push(`**Solved:** ${solved} of ${rows.length}. **Points:** ${points} of ${possible}.`, '');
    } else {
      parts.push('No challenges were found in this folder.', '');
    }
    sections.forEach((s) => { parts.push(s, ''); });
    if (scriptBlocks.length) parts.push('## Solve scripts', '', scriptBlocks.join('\n\n'), '');
    if (skippedEncrypted.length) parts.push('## Not included (encrypted)', '', titleList(skippedEncrypted), '');
    if (leftOut.length) parts.push('## Left out (report too long)', '', titleList(leftOut), '');
    let reportBody = parts.join('\n');
    if (reportBody.length > REPORT_HARD_LIMIT) reportBody = reportBody.slice(0, REPORT_HARD_LIMIT); // unreachable in practice
    return { title, body: reportBody, included, skippedEncrypted, leftOut };
  }

  return {
    LIMITS, CATEGORIES, DEFAULT_PREFIXES, DUMP_NOTE, CODECS,
    caesarBruteForce, xorBruteForce, readableScore, tryDecodings,
    validatePrefixes, findFlags,
    challengeTemplate, writeupTemplate, parseChallenge, buildReport,
  };
});
