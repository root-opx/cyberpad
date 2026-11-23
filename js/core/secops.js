/*
 * Security analyst helpers: IOC extraction, defang/refang, secret scanning,
 * decoders and hashing. Pure functions (hashing uses Web Crypto), no DOM.
 */
(function (root, factory) {
  'use strict';
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else (root.NP = root.NP || {}).secops = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_INPUT = 1000000;
  const MAX_ITEMS = 5000;
  const MAX_FINDINGS = 200;

  class SecOpsError extends Error {}

  // ---------------------------------------------------------------- refang

  /** Undo common defanging so indicators can be parsed. */
  function refang(text) {
    return String(text)
      .replace(/\bh[x]{2}p(s?)(?=\[?:)/gi, 'http$1')
      .replace(/\bfxp(?=\[?:)/gi, 'ftp')
      .replace(/\[:\/\/\]/g, '://')
      .replace(/\[:\]/g, ':')
      .replace(/\s*\[dot\]\s*|\s*\(dot\)\s*|\s*\{dot\}\s*/gi, '.')
      .replace(/\[\.\]|\(\.\)|\{\.\}/g, '.')
      .replace(/\s*\[at\]\s*|\s*\(at\)\s*/gi, '@')
      .replace(/\[@\]|\(@\)|\{@\}/g, '@');
  }

  // ------------------------------------------------------------- patterns

  const URL_SRC = String.raw`\b(?:https?|ftp):\/\/[^\s<>"'\x60]+`;
  const EMAIL_SRC = String.raw`(?<![\w.%+-])[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}(?![\w-])`;
  const IPV4_SRC = String.raw`(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?!\.?\d)(?![\w])`;
  const DOMAIN_SRC = String.raw`(?<![\w.-])(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}(?![\w-])`;
  const IPV6_SRC = String.raw`(?<![\w:])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![\w:])`;

  const RE = {
    url: new RegExp(URL_SRC, 'gi'),
    email: new RegExp(EMAIL_SRC, 'g'),
    ipv4: new RegExp(IPV4_SRC, 'g'),
    domain: new RegExp(DOMAIN_SRC, 'g'),
    ipv6: new RegExp(IPV6_SRC, 'g'),
    md5: /\b[a-fA-F0-9]{32}\b/g,
    sha1: /\b[a-fA-F0-9]{40}\b/g,
    sha256: /\b[a-fA-F0-9]{64}\b/g,
    sha512: /\b[a-fA-F0-9]{128}\b/g,
    cve: /\bCVE-\d{4}-\d{4,7}\b/gi,
    attack: /\bT1\d{3}(?:\.\d{3})?\b/g,
  };

  // Generic TLDs worth recognising; any two-letter TLD is also accepted
  // unless it is a common file extension.
  const GENERIC_TLDS = new Set(('com net org edu gov mil int info biz name pro mobi aero coop museum io ai app dev xyz top online site ' +
    'club shop store tech cloud live link click work space website fun icu buzz monster rest bar cyou sbs support zip mov onion ' +
    'local lan internal arpa corp home lol vip win bid loan download stream racing review date party trade science men ' +
    'accountant cricket faith gdn host press services digital network email systems solutions agency company center today ' +
    'world news blog media group global finance money bank exchange crypto wiki page tools run one best life plus love').split(' '));
  const FILE_EXT_2 = new Set(['md', 'sh', 'py', 'rs', 'so', 'pl', 'ps', 'cs', 'ts', 'js', 'rb', 'gz', 'xz', 'db', 'hs', 'kt', 'vb', 'el', 'go', 'h', 'c']);

  function isLikelyDomain(d) {
    if (d.length > 253) return false;
    const labels = d.split('.');
    if (labels.length < 2) return false;
    const tld = labels[labels.length - 1].toLowerCase();
    if (!/^[a-z]{2,24}$/.test(tld)) return false;
    if (tld.length === 2) return !FILE_EXT_2.has(tld);
    return GENERIC_TLDS.has(tld);
  }

  function isIpv6(s) {
    if (s.length < 3 || s.length > 45) return false;
    const halves = s.split('::');
    if (halves.length > 2) return false;
    const groups = s.split(':').filter((g) => g !== '');
    if (!groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return false;
    if (halves.length === 2) return groups.length >= 1 && groups.length <= 7;
    return groups.length === 8 && !s.startsWith(':') && !s.endsWith(':');
  }

  function trimUrl(u) {
    let s = u.replace(/[.,;:!?'"*_~]+$/, '');
    // Drop an unbalanced closing bracket picked up from surrounding prose.
    while (/[)\]}>]$/.test(s)) {
      const close = s[s.length - 1];
      const open = { ')': '(', ']': '[', '}': '{', '>': '<' }[close];
      if (s.split(open).length >= s.split(close).length) break;
      s = s.slice(0, -1);
    }
    return s;
  }

  function collect(text, re, map) {
    const out = [];
    const seen = new Set();
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const v = map ? map(m[0]) : m[0];
      if (!v || seen.has(v)) continue;
      seen.add(v);
      out.push(v);
      if (out.length >= MAX_ITEMS) break;
    }
    return out;
  }

  const lower = (s) => s.toLowerCase();

  const IOC_TYPES = Object.freeze([
    ['urls', 'URLs'], ['domains', 'Domains'], ['ipv4', 'IPv4 addresses'], ['ipv6', 'IPv6 addresses'],
    ['emails', 'Email addresses'], ['md5', 'MD5 hashes'], ['sha1', 'SHA-1 hashes'], ['sha256', 'SHA-256 hashes'],
    ['sha512', 'SHA-512 hashes'], ['cves', 'CVE IDs'], ['attack', 'MITRE ATT&CK techniques'],
  ]);

  /** Pull indicators of compromise out of text (defanged input is accepted). */
  function extractIocs(input) {
    const text = refang(String(input).slice(0, MAX_INPUT));
    return {
      urls: collect(text, RE.url, trimUrl),
      domains: collect(text, RE.domain, (d) => (isLikelyDomain(d) ? d.toLowerCase() : null)),
      ipv4: collect(text, RE.ipv4),
      ipv6: collect(text, RE.ipv6, (s) => (isIpv6(s) ? s.toLowerCase() : null)),
      emails: collect(text, RE.email, lower),
      md5: collect(text, RE.md5, lower),
      sha1: collect(text, RE.sha1, lower),
      sha256: collect(text, RE.sha256, lower),
      sha512: collect(text, RE.sha512, lower),
      cves: collect(text, RE.cve, (s) => s.toUpperCase()),
      attack: collect(text, RE.attack),
    };
  }

  function iocCount(iocs) {
    return IOC_TYPES.reduce((n, [k]) => n + iocs[k].length, 0);
  }

  // ---------------------------------------------------------------- defang

  const dots = (s) => s.replace(/\./g, '[.]');

  function defangUrl(u) {
    const m = /^(https?|ftp)(:\/\/)([^/?#]*)(.*)$/i.exec(u);
    if (!m) return u;
    const scheme = m[1].toLowerCase() === 'ftp' ? 'fxp' : m[1].replace(/t/gi, 'x');
    return `${scheme}${m[2]}${dots(m[3])}${m[4]}`;
  }

  function defangValue(type, v) {
    switch (type) {
      case 'urls': return defangUrl(v);
      case 'domains': case 'ipv4': return dots(v);
      case 'ipv6': return v.replace(/:/g, '[:]');
      case 'emails': return v.replace('@', '[@]').replace(/\.(?=[^@]*$)/g, '[.]');
      default: return v;
    }
  }

  const DEFANG_RE = new RegExp(`(${URL_SRC})|(${EMAIL_SRC})|(${IPV4_SRC})|(${DOMAIN_SRC})`, 'gi');

  /** Make URLs, emails, IPs and domains in text safe to share (non-clickable). */
  function defang(text) {
    return String(text).replace(DEFANG_RE, (match, url, email, ip, domain) => {
      if (url) {
        const clean = trimUrl(url);
        return defangUrl(clean) + url.slice(clean.length);
      }
      if (email) return defangValue('emails', email);
      if (ip) return dots(ip);
      if (domain && isLikelyDomain(domain)) return dots(domain);
      return match;
    });
  }

  // ------------------------------------------------------------ IOC export

  /** CSV cell with quoting and spreadsheet formula-injection protection. */
  function csvCell(value) {
    let s = String(value);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) || s.startsWith("'") ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function iocsToCsv(iocs, { defanged = false } = {}) {
    const rows = ['type,value'];
    for (const [k] of IOC_TYPES) {
      for (const v of iocs[k]) rows.push(`${csvCell(k)},${csvCell(defanged ? defangValue(k, v) : v)}`);
    }
    return rows.join('\r\n');
  }

  function iocsToMarkdown(iocs, { defanged = false, source = '', when = '' } = {}) {
    const out = [`# IOCs${source ? ` from ${source}` : ''}`, ''];
    if (when) out.push(`Extracted ${when}${defanged ? ', defanged' : ''}.`, '');
    for (const [k, label] of IOC_TYPES) {
      if (!iocs[k].length) continue;
      out.push(`## ${label} (${iocs[k].length})`, '```', ...iocs[k].map((v) => (defanged ? defangValue(k, v) : v)), '```', '');
    }
    out.push('#ioc');
    return out.join('\n');
  }

  // --------------------------------------------------------- secret scanner

  const PEM = '(?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?';

  // Ordered from most to least specific: overlapping matches keep the first rule.
  const SECRET_RULES = Object.freeze([
    { id: 'private-key', label: 'Private key', re: new RegExp(`-----BEGIN ${PEM}-----(?:[\\s\\S]{0,20000}?-----END ${PEM}-----)?`, 'gd') },
    { id: 'aws-access-key', label: 'AWS access key ID', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/gd },
    { id: 'aws-secret-key', label: 'AWS secret access key', re: /\baws[\w .-]{0,20}?(?:secret|sk)[\w .-]{0,20}?["']?\s*[=:]\s*["']?([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+])/gid, group: 1 },
    { id: 'github-token', label: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/gd },
    { id: 'gitlab-token', label: 'GitLab token', re: /\bglpat-[A-Za-z0-9_-]{20,64}/gd },
    { id: 'slack-token', label: 'Slack token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,250}/gd },
    { id: 'slack-webhook', label: 'Slack webhook URL', re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,200}/gd },
    { id: 'google-api-key', label: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/gd },
    { id: 'stripe-key', label: 'Stripe secret key', re: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,247}\b/gd },
    { id: 'sk-api-key', label: 'API secret key (sk-)', re: /\bsk-(?:ant-[a-z0-9]{2,10}-|proj-)?[A-Za-z0-9_-]{20,250}/gd },
    { id: 'jwt', label: 'JSON Web Token', re: /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{10,}/gd },
    { id: 'azure-account-key', label: 'Azure storage account key', re: /AccountKey=([A-Za-z0-9+/=]{40,200})/gd, group: 1 },
    { id: 'url-password', label: 'Password in a URL', re: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@]{1,64}:([^\s@/]{3,128})@/gid, group: 1 },
    { id: 'assignment', label: 'Password or key assignment', re: /\b(?:password|passwd|pwd|pass|passphrase|secret|api[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|token)\b["']?\s*[:=]\s*["']?([^\s"'`,;]{6,200})/gid, group: 1 },
  ]);

  const PLACEHOLDER = /^(?:\*+|x+|•+|\.+|-+|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|%[^%]+%|\[redacted[^\]]*\]?|changeme|example\w*|placeholder|your[\w-]*|null|none|undefined|true|false|redacted)$/i;

  function maskValue(v) {
    if (v.length <= 8) return '•'.repeat(v.length);
    return `${v.slice(0, 4)}${'•'.repeat(Math.min(12, v.length - 6))}${v.slice(-2)}`;
  }

  /** Find likely credentials. Returns [{id, label, start, end, value, line, preview}]. */
  function scanSecrets(input) {
    const text = String(input).slice(0, MAX_INPUT);
    const found = [];
    for (const rule of SECRET_RULES) {
      rule.re.lastIndex = 0;
      for (const m of text.matchAll(rule.re)) {
        const g = rule.group || 0;
        const span = m.indices[g];
        if (!span) continue;
        const value = m[g];
        if (rule.id === 'assignment' && PLACEHOLDER.test(value)) continue;
        found.push({ id: rule.id, label: rule.label, start: span[0], end: span[1], value });
        if (found.length >= MAX_FINDINGS * 4) break;
      }
    }
    // Keep earlier (more specific) rules when ranges overlap.
    const accepted = [];
    for (const f of found) {
      if (!accepted.some((a) => f.start < a.end && a.start < f.end)) accepted.push(f);
    }
    accepted.sort((a, b) => a.start - b.start);
    return accepted.slice(0, MAX_FINDINGS).map((f) => ({
      ...f,
      line: countLines(text, f.start),
      preview: f.id === 'private-key' ? '-----BEGIN … PRIVATE KEY-----' : maskValue(f.value),
    }));
  }

  function countLines(text, end) {
    let n = 1;
    for (let i = text.indexOf('\n'); i !== -1 && i < end; i = text.indexOf('\n', i + 1)) n++;
    return n;
  }

  /** Replace each finding's range with a redaction marker. */
  function maskSecrets(text, findings) {
    let out = String(text);
    for (const f of [...findings].sort((a, b) => b.start - a.start)) {
      out = `${out.slice(0, f.start)}[REDACTED:${f.id}]${out.slice(f.end)}`;
    }
    return out;
  }

  /** Remove known secret values wherever they appear (used to scrub history). */
  function scrubValues(text, values) {
    let out = String(text);
    for (const v of values) if (v) out = out.split(v).join('[REDACTED]');
    return out;
  }

  // -------------------------------------------------------------- decoders

  function utf8Decode(bytes, what) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (err) {
      if (err instanceof TypeError) throw new SecOpsError(`That ${what} does not decode to UTF-8 text.`);
      throw err;
    }
  }

  function hexEncode(s) {
    return Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function hexDecode(s) {
    const clean = String(s).replace(/0x|\\x|[\s:,-]/gi, '');
    if (!/^(?:[0-9a-f]{2})*$/i.test(clean)) throw new SecOpsError('That is not valid hex: use pairs of 0-9 and a-f.');
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(clean.substr(i * 2, 2), 16);
    return utf8Decode(bytes, 'hex');
  }

  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const HTML_NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

  function htmlEncode(s) {
    return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
  }

  function htmlDecode(s) {
    return String(s).replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (m, body) => {
      if (body[0] === '#') {
        const cp = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
        if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) || cp === 0) return m;
        return String.fromCodePoint(cp);
      }
      const named = HTML_NAMED[body.toLowerCase()];
      return named === undefined ? m : named;
    });
  }

  function rot13(s) {
    return String(s).replace(/[a-z]/gi, (c) => {
      const base = c <= 'Z' ? 65 : 97;
      return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
    });
  }

  function base64UrlToBytes(part) {
    if (!/^[A-Za-z0-9_-]*$/.test(part)) throw new SecOpsError('That token has characters that are not Base64url.');
    let b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    if (b64.length % 4 === 1) throw new SecOpsError('That token has a broken Base64url segment.');
    b64 += '='.repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(b64);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }

  function parseJwtPart(part, name) {
    let json;
    try {
      json = JSON.parse(utf8Decode(base64UrlToBytes(part), name));
    } catch (err) {
      if (err instanceof SyntaxError) throw new SecOpsError(`The token's ${name} is not valid JSON.`);
      throw err;
    }
    if (json === null || typeof json !== 'object' || Array.isArray(json)) throw new SecOpsError(`The token's ${name} is not a JSON object.`);
    return json;
  }

  const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/;

  function findJwt(text) {
    const m = JWT_RE.exec(String(text));
    return m ? m[0] : null;
  }

  /** Decode (not verify) a JWT. */
  function decodeJwt(token, now = Date.now()) {
    const t = String(token).trim();
    if (t.length > 16384) throw new SecOpsError('That token is too long.');
    const parts = t.split('.');
    if (parts.length !== 3) throw new SecOpsError('A JWT has three parts separated by dots.');
    const header = parseJwtPart(parts[0], 'header');
    const payload = parseJwtPart(parts[1], 'payload');
    const claims = {};
    for (const k of ['iat', 'nbf', 'exp']) {
      if (Number.isFinite(payload[k]) && Math.abs(payload[k]) < 1e11) claims[k] = new Date(payload[k] * 1000).toISOString();
    }
    return {
      header,
      payload,
      signed: parts[2].length > 0,
      alg: typeof header.alg === 'string' ? header.alg : null,
      claims,
      expired: Number.isFinite(payload.exp) ? payload.exp * 1000 < now : null,
      notYetValid: Number.isFinite(payload.nbf) ? payload.nbf * 1000 > now : null,
    };
  }

  const FILETIME_EPOCH_OFFSET_MS = 11644473600000; // 1601-01-01 to 1970-01-01

  /** Interpret a timestamp: Unix s/ms/µs, Windows FILETIME / AD, or ISO/RFC date. */
  function convertTimestamp(input) {
    const s = String(input).trim();
    if (!s || s.length > 64) throw new SecOpsError('Select a single timestamp, like 1732370000 or 2026-11-23T10:00:00Z.');
    let ms;
    let kind;
    if (/^-?\d{1,11}$/.test(s)) { ms = Number(s) * 1000; kind = 'Unix seconds'; }
    else if (/^-?\d{12,14}$/.test(s)) { ms = Number(s); kind = 'Unix milliseconds'; }
    else if (/^\d{15,16}$/.test(s)) { ms = Number(s) / 1000; kind = 'Unix microseconds'; }
    else if (/^\d{17,18}$/.test(s)) { ms = Number(BigInt(s) / 10000n) - FILETIME_EPOCH_OFFSET_MS; kind = 'Windows FILETIME / Active Directory'; }
    else if (/\d{4}-\d{2}-\d{2}|[A-Za-z]{3},? \d{1,2} [A-Za-z]{3} \d{4}/.test(s)) { ms = Date.parse(s); kind = 'Date string'; }
    else throw new SecOpsError('That does not look like a timestamp.');
    if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) throw new SecOpsError('That timestamp is out of range.');
    const d = new Date(ms);
    return {
      kind,
      date: d,
      iso: d.toISOString(),
      unixSeconds: Math.floor(ms / 1000),
      unixMs: Math.round(ms),
      filetime: (BigInt(Math.round(ms)) + BigInt(FILETIME_EPOCH_OFFSET_MS)) * 10000n,
    };
  }

  // --------------------------------------------------------------- hashing

  const HASH_ALGOS = Object.freeze([['SHA-1', 'SHA-1'], ['SHA-256', 'SHA-256'], ['SHA-384', 'SHA-384'], ['SHA-512', 'SHA-512']]);

  const toHex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

  async function hashBytes(bytes) {
    const subtle = globalThis.crypto && globalThis.crypto.subtle;
    if (!subtle) throw new SecOpsError('Hashing is unavailable in this browser context.');
    const out = {};
    for (const [name, algo] of HASH_ALGOS) out[name] = toHex(await subtle.digest(algo, bytes));
    return out;
  }

  function hashText(text) {
    return hashBytes(new TextEncoder().encode(String(text)));
  }

  const TRANSFORMS = Object.freeze({
    defang,
    refang,
    hexEncode,
    hexDecode,
    htmlEncode,
    htmlDecode,
    rot13,
  });

  return {
    SecOpsError, IOC_TYPES, SECRET_RULES, TRANSFORMS, MAX_FINDINGS,
    refang, defang, defangValue, extractIocs, iocCount, iocsToCsv, iocsToMarkdown, csvCell,
    scanSecrets, maskSecrets, scrubValues,
    hexEncode, hexDecode, htmlEncode, htmlDecode, rot13, findJwt, decodeJwt, convertTimestamp,
    hashBytes, hashText,
  };
});
