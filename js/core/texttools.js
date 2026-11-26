/*
 * Pure text helpers: stats, titles, tags, links, list editing, transforms,
 * slash-command expansions and fuzzy matching.
 */
(function (root, factory) {
  'use strict';
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else (root.NP = root.NP || {}).text = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_TAGS = 200;
  const MAX_HEADINGS = 500;
  const MAX_LINKS = 500;

  class TransformError extends Error {}

  const pad = (n, w = 2) => String(n).padStart(w, '0');

  function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function hm(d) { return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }

  /** UTC timestamps for incident timelines: 2026-11-23 14:05:12 UTC. */
  function utcStamp(d, seconds = true) {
    const iso = d.toISOString();
    return `${iso.slice(0, 10)} ${iso.slice(11, seconds ? 19 : 16)} UTC`;
  }

  // Engagement templates. `caret` marks where typing continues.
  function findingTemplate(now) {
    const head = '## Finding: ';
    const text = [
      head,
      '',
      '- **Severity:** ',
      '- **CVSS 3.1:** ',
      '- **CWE:** ',
      '- **Affected assets:** ',
      '- **Status:** Open',
      `- **Reported:** ${utcStamp(now, false)}`,
      '',
      '### Description',
      '',
      '',
      '### Steps to reproduce',
      '1. ',
      '',
      '### Evidence',
      '',
      '',
      '### Impact',
      '',
      '',
      '### Remediation',
      '',
      '',
      '### References',
      '- ',
      '',
    ].join('\n');
    return { text, caret: head.length, block: true };
  }

  function iocTableTemplate(now) {
    const header = '| Type | Value (defanged) | First seen (UTC) | Source | Notes |\n| --- | --- | --- | --- | --- |\n| ';
    return { text: `${header} | | ${utcStamp(now, false)} | | |\n`, caret: header.length, block: true };
  }

  function timelineTemplate(now) {
    const header = `| Time (UTC) | Event | Source |\n| --- | --- | --- |\n| ${utcStamp(now)} | `;
    return { text: `${header} | |\n`, caret: header.length, block: true };
  }

  function isoWeek(d) {
    const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    return Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  }

  function countChar(text, ch, end = text.length) {
    let n = 0;
    let i = text.indexOf(ch);
    while (i !== -1 && i < end) { n++; i = text.indexOf(ch, i + 1); }
    return n;
  }

  function stats(text) {
    const words = (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) || []).length;
    return {
      chars: text.length,
      words,
      lines: countChar(text, '\n') + 1,
      readingMinutes: words === 0 ? 0 : Math.max(1, Math.round(words / 230)),
    };
  }

  /** Line (1-based) and column (1-based) of a caret offset. */
  function position(text, offset) {
    const line = countChar(text, '\n', offset) + 1;
    const col = offset - (text.lastIndexOf('\n', offset - 1) + 1) + 1;
    return { line, col };
  }

  function deriveTitle(body) {
    if (typeof body !== 'string') return 'Untitled';
    const lines = body.split('\n', 50);
    for (const raw of lines) {
      const t = raw
        .replace(/^\s*#{1,6}\s+/, '')
        .replace(/^\s*>\s?/, '')
        .replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/, '')
        .trim();
      if (t && !/^(`{3,}|~{3,}|[-*_]{3,})$/.test(t)) return t.length > 80 ? `${t.slice(0, 79)}…` : t;
    }
    return 'Untitled';
  }

  function stripCode(text) {
    return text.replace(/^\s{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s{0,3}\1[^\n]*$/gm, '').replace(/`[^`\n]+`/g, '');
  }

  const TAG_RE = /(^|[\s(])#([\p{L}][\p{L}\p{N}_-]{0,49})/gu;

  function extractTags(text) {
    const tags = new Set();
    for (const m of stripCode(text).matchAll(TAG_RE)) {
      if (/^(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(m[2])) continue;
      tags.add(m[2].toLowerCase());
      if (tags.size >= MAX_TAGS) break;
    }
    return [...tags].sort();
  }

  function extractWikiLinks(text) {
    const out = [];
    for (const m of stripCode(text).matchAll(/\[\[([^[\]\n|]{1,200})(?:\|[^[\]\n]{1,200})?\]\]/g)) {
      const target = m[1].trim();
      if (target) out.push(target);
      if (out.length >= MAX_LINKS) break;
    }
    return out;
  }

  function headings(text) {
    const out = [];
    const lines = text.split('\n');
    let fence = null;
    for (let i = 0; i < lines.length && out.length < MAX_HEADINGS; i++) {
      const f = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[i]);
      if (f) {
        if (!fence) fence = f[1][0];
        else if (f[1][0] === fence) fence = null;
        continue;
      }
      if (fence) continue;
      const m = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
      if (m) out.push({ level: m[1].length, text: m[2], line: i });
    }
    return out;
  }

  /** What to insert after Enter on a list/quote line, or null. */
  function listContinuation(line) {
    let m = /^(\s*)([-*+])\s+(\[[ xX]\](?:\s+|$))?(.*)$/.exec(line);
    if (m) return { prefix: `${m[1]}${m[2]} ${m[3] ? '[ ] ' : ''}`, empty: m[4].trim() === '' };
    m = /^(\s*)(\d{1,9})([.)])\s+(\[[ xX]\](?:\s+|$))?(.*)$/.exec(line);
    if (m) return { prefix: `${m[1]}${Number(m[2]) + 1}${m[3]} ${m[4] ? '[ ] ' : ''}`, empty: m[5].trim() === '' };
    m = /^(\s*>\s?)(.*)$/.exec(line);
    if (m) return { prefix: m[1], empty: m[2].trim() === '' };
    return null;
  }

  const TASK_RE = /^(\s*(?:[-*+]|\d{1,9}[.)])\s+)\[([ xX])\](.*)$/;

  function isTask(line) { return TASK_RE.test(line); }

  function toggleTask(line) {
    let m = TASK_RE.exec(line);
    if (m) return `${m[1]}[${m[2] === ' ' ? 'x' : ' '}]${m[3]}`;
    m = /^(\s*(?:[-*+]|\d{1,9}[.)])\s+)(.*)$/.exec(line);
    if (m) return `${m[1]}[ ] ${m[2]}`;
    m = /^(\s*)(.*)$/.exec(line);
    return `${m[1]}- [ ] ${m[2]}`;
  }

  // ---- transforms -------------------------------------------------------

  const lines = (s) => s.split('\n');
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

  function bytesToBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  function base64ToBytes(b64) {
    let s = b64.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new TransformError('That is not valid Base64.');
    s = s.replace(/=+$/, '');
    if (s.length % 4 === 1) throw new TransformError('That is not valid Base64.');
    s += '='.repeat((4 - (s.length % 4)) % 4);
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  const TRANSFORMS = {
    upper: (s) => s.toUpperCase(),
    lower: (s) => s.toLowerCase(),
    title: (s) => s.replace(/[\p{L}][\p{L}'’]*/gu, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()),
    sortLines: (s) => lines(s).sort(collator.compare).join('\n'),
    reverseLines: (s) => lines(s).reverse().join('\n'),
    dedupeLines: (s) => [...new Set(lines(s))].join('\n'),
    removeEmptyLines: (s) => lines(s).filter((l) => l.trim() !== '').join('\n'),
    trimTrailing: (s) => s.replace(/[ \t]+$/gm, ''),
    numberLines: (s) => lines(s).map((l, i) => `${i + 1}. ${l}`).join('\n'),
    base64Encode: (s) => bytesToBase64(new TextEncoder().encode(s)),
    base64Decode: (s) => {
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(base64ToBytes(s));
      } catch (err) {
        if (err instanceof TransformError) throw err;
        if (err instanceof TypeError || (err && err.name === 'InvalidCharacterError')) {
          throw new TransformError('That Base64 does not decode to text.');
        }
        throw err;
      }
    },
    urlEncode: (s) => encodeURIComponent(s),
    urlDecode: (s) => {
      try { return decodeURIComponent(s); } catch (err) {
        if (err instanceof URIError) throw new TransformError('That text has a broken % escape.');
        throw err;
      }
    },
    jsonPretty: (s) => jsonRoundTrip(s, 2),
    jsonMinify: (s) => jsonRoundTrip(s, 0),
  };

  function jsonRoundTrip(s, indent) {
    try { return JSON.stringify(JSON.parse(s), null, indent); } catch (err) {
      if (err instanceof SyntaxError) throw new TransformError(`That is not valid JSON: ${err.message}`);
      throw err;
    }
  }

  function numberStats(s) {
    const nums = (s.match(/(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])/g) || []).slice(0, 100000).map(Number);
    if (!nums.length) return null;
    const sum = nums.reduce((a, b) => a + b, 0);
    return { count: nums.length, sum, avg: sum / nums.length, min: Math.min(...nums.slice(0, 50000)), max: Math.max(...nums.slice(0, 50000)) };
  }

  function slugify(s) {
    const slug = s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    return slug || 'note';
  }

  // ---- arrows and code detection ----------------------------------------

  const FENCE_RE = /^ {0,3}(```|~~~)/;

  /** True when the caret sits inside a fenced block or an open inline code span on its line. */
  function inCodeAt(text, caret) {
    if (typeof text !== 'string' || !Number.isSafeInteger(caret) || caret < 0 || caret > text.length) return false;
    const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
    let fences = 0;
    for (const line of text.slice(0, lineStart).split('\n')) if (FENCE_RE.test(line)) fences++;
    if (fences % 2 === 1) return true;
    return countChar(text.slice(lineStart, caret), '`') % 2 === 1;
  }

  /** The range to replace after `typed` went in just before `caret`, or null. */
  function arrowReplacement(text, caret, typed) {
    if (typeof text !== 'string' || typeof typed !== 'string' || !Number.isSafeInteger(caret) || caret < 2 || caret > text.length) return null;
    const a = text[caret - 2];
    const b = text[caret - 3];
    let insert = null;
    if (typed === '>') {
      if (a === '-' && b !== '-' && b !== '<') insert = '→';
      else if (a === '←') insert = '↔';
      else if (a === '=' && !['=', '<', '>', '!'].includes(b)) insert = '⇒';
    } else if (typed === '-' && a === '<' && b !== '<') insert = '←';
    if (insert === null || inCodeAt(text, caret)) return null;
    return { start: caret - 2, end: caret, insert };
  }

  function credentialsTemplate(now) {
    return [
      '# Credentials',
      '',
      '| System | Username | Password | URL | Notes |',
      '| --- | --- | --- | --- | --- |',
      '|  |  |  |  |  |',
      '',
      `Last reviewed: ${ymd(now)}`,
      '',
    ].join('\n');
  }

  // ---- slash commands ---------------------------------------------------

  const SLASH = [
    { name: 'date', desc: 'Today’s date', expand: (c) => ymd(c.now) },
    { name: 'time', desc: 'Current time', expand: (c) => hm(c.now) },
    { name: 'now', desc: 'Date and time', expand: (c) => `${ymd(c.now)} ${hm(c.now)}` },
    { name: 'iso', desc: 'ISO 8601 timestamp', expand: (c) => c.now.toISOString() },
    { name: 'unix', desc: 'Unix timestamp', expand: (c) => String(Math.floor(c.now.getTime() / 1000)) },
    { name: 'week', desc: 'ISO week number', expand: (c) => `Week ${isoWeek(c.now)}, ${c.now.getFullYear()}` },
    { name: 'utc', desc: 'UTC timestamp for timelines', expand: (c) => utcStamp(c.now) },
    { name: 'finding', desc: 'Pentest finding template', expand: (c) => findingTemplate(c.now) },
    { name: 'ioc', desc: 'IOC tracking table', expand: (c) => iocTableTemplate(c.now) },
    { name: 'timeline', desc: 'Incident timeline table (UTC)', expand: (c) => timelineTemplate(c.now) },
    { name: 'credentials', desc: 'New encrypted credentials note', expand: (c) => { const text = credentialsTemplate(c.now); return { text, caret: text.length, block: true }; } },
    { name: 'todo', desc: 'Task item', expand: () => '- [ ] ' },
    { name: 'h1', desc: 'Big heading', expand: () => '# ' },
    { name: 'h2', desc: 'Section heading', expand: () => '## ' },
    { name: 'h3', desc: 'Small heading', expand: () => '### ' },
    { name: 'quote', desc: 'Quote block', expand: () => '> ' },
    { name: 'code', desc: 'Code block', expand: () => ({ text: '```\n\n```', caret: 4 }) },
    { name: 'table', desc: 'Two-column table', expand: () => {
      const text = '| Column | Column |\n| --- | --- |\n|  |  |';
      return { text, caret: text.lastIndexOf('|  |') + 2 };
    } },
    { name: 'hr', desc: 'Divider line', expand: () => '---\n' },
    { name: 'link', desc: 'Web link', expand: () => ({ text: '[](https://)', caret: 1 }) },
    { name: 'wiki', desc: 'Link to another note', expand: () => ({ text: '[[]]', caret: 2 }) },
    { name: 'uuid', desc: 'Random UUID', expand: (c) => c.uuid() },
    { name: 'lorem', desc: 'Placeholder paragraph', expand: () => 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.' },
  ];

  function expandSlash(name, ctx) {
    const cmd = SLASH.find((c) => c.name === name);
    if (!cmd) return null;
    const r = cmd.expand(ctx);
    return typeof r === 'string' ? { text: r, caret: r.length, block: false } : { block: false, ...r };
  }

  // ---- fuzzy matching ---------------------------------------------------

  function fuzzyScore(query, text) {
    const q = query.toLowerCase().trim();
    if (!q) return 0;
    const t = text.toLowerCase().slice(0, 300);
    const idx = t.indexOf(q);
    if (idx >= 0) return 1000 - idx * 2 + (idx === 0 ? 200 : 0) - (t.length - q.length) * 0.1;
    let score = 0;
    let ti = 0;
    let streak = 0;
    for (const ch of q) {
      if (ch === ' ') continue;
      const found = t.indexOf(ch, ti);
      if (found < 0) return -1;
      streak = found === ti ? streak + 1 : 0;
      score += 10 + streak * 5 - Math.min(found - ti, 10);
      if (found === 0 || /[\s\-_/]/.test(t[found - 1])) score += 8;
      ti = found + 1;
    }
    return score;
  }

  // ---- palette sections -------------------------------------------------

  const PALETTE_SECTIONS = Object.freeze(['Recent notes', 'Note', 'File', 'Edit', 'Format', 'Text', 'Insert', 'View', 'Settings', 'Tools', 'CTF', 'Vault', 'Security']);
  const SECTION_RENAMES = new Map([['Theme', 'Settings'], ['Templates', 'Insert'], ['Transform', 'Text']]);

  function sectionOf(group) {
    return SECTION_RENAMES.has(group) ? SECTION_RENAMES.get(group) : group;
  }

  function paletteSections(items) {
    const bySection = new Map();
    for (const item of items) {
      const name = sectionOf(item.group);
      if (!bySection.has(name)) bySection.set(name, []);
      bySection.get(name).push(item);
    }
    const known = PALETTE_SECTIONS.filter((name) => bySection.has(name));
    const extra = [...bySection.keys()].filter((name) => !PALETTE_SECTIONS.includes(name));
    return [...known, ...extra].map((name) => ({ name, items: bySection.get(name) }));
  }

  function paletteScore(query, item) {
    return Math.max(
      fuzzyScore(query, item.title),
      fuzzyScore(query, `${item.group} ${item.title}`) - 50,
      fuzzyScore(query, `${sectionOf(item.group)} ${item.title}`) - 50,
    );
  }

  function relativeTime(ts, now = Date.now()) {
    const s = Math.round((now - ts) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    if (s < 172800) return 'yesterday';
    return ymd(new Date(ts));
  }

  // ---- selection formatting (the selection toolbar) -----------------------------------------------
  // Each function returns null for unusable arguments, else { start, end, insert, selStart, selEnd }: replace
  // [start, end) of the text with `insert`, then select [selStart, selEnd) in the result. Never throws.

  const WRAP_MARKERS = Object.freeze(['**', '*', '~~', '==', '`']);
  const LINE_PREFIXES = Object.freeze(['> ', '- ']);

  function posOk(text, start, end) {
    if (typeof text !== 'string' || !Number.isInteger(start) || !Number.isInteger(end)) return false;
    if (start < 0 || start > end || end > text.length) return false;
    const splits = (p) => {
      if (p <= 0 || p >= text.length) return false;
      const hi = text.charCodeAt(p - 1);
      const lo = text.charCodeAt(p);
      return hi >= 0xD800 && hi <= 0xDBFF && lo >= 0xDC00 && lo <= 0xDFFF;
    };
    return !(splits(start) || splits(end));
  }

  const isSpaceCh = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
  const noEdit = (start, end) => ({ start, end: start, insert: '', selStart: start, selEnd: end });
  const lineStartOf = (text, pos) => (pos === 0 ? 0 : text.lastIndexOf('\n', pos - 1) + 1);
  const lineEndOf = (text, pos) => {
    const i = text.indexOf('\n', pos);
    return i === -1 ? text.length : i;
  };

  /** Where a position goes after the edits [{ at, del, ins }] (ascending, not overlapping). */
  function mapPos(p, edits) {
    let r = p;
    for (const ed of edits) {
      if (p >= ed.at + ed.del) r += ed.ins - ed.del;
      else if (p > ed.at) r -= p - ed.at;
    }
    return r;
  }

  /** Length of the run of ch ending just before `to` (going left) or starting at `from` (going right). */
  function runLeft(text, to, ch) {
    let n = 0;
    while (to - n - 1 >= 0 && text[to - n - 1] === ch) n += 1;
    return n;
  }
  function runRight(text, from, ch) {
    let n = 0;
    while (from + n < text.length && text[from + n] === ch) n += 1;
    return n;
  }

  /** True when [a, b) itself starts and ends with the marker (a single '*' must not be half of '**'). */
  function wrappedInside(text, a, b, m) {
    if (b - a < 2 * m.length || !text.startsWith(m, a) || !text.startsWith(m, b - m.length)) return false;
    if (m !== '*') return true;
    const l = runRight(text, a, '*');
    const r = runLeft(text, b, '*');
    return l < b - a && Math.min(l, r) % 2 === 1;
  }

  /** True when the marker sits immediately left of a and right of b. */
  function wrappedOutside(text, a, b, m) {
    if (a < m.length || !text.startsWith(m, a - m.length) || !text.startsWith(m, b)) return false;
    if (m !== '*') return true;
    return Math.min(runLeft(text, a, '*'), runRight(text, b, '*')) % 2 === 1;
  }

  function longestRun(s, ch) {
    let best = 0;
    let cur = 0;
    for (let i = 0; i < s.length; i += 1) {
      cur = s[i] === ch ? cur + 1 : 0;
      if (cur > best) best = cur;
    }
    return best;
  }

  /** A fenced block around the whole lines touched by [a, b), or the fence removed when it is already there. */
  function toggleFence(text, start, end, a, b) {
    const ls = lineStartOf(text, a);
    const le = lineEndOf(text, b);
    const isFence = (from, to) => {
      let f = from;
      let t = to;
      while (f < t && isSpaceCh(text[f])) f += 1;
      while (t > f && isSpaceCh(text[t - 1])) t -= 1;
      if (t - f < 3) return 0;
      for (let i = f; i < t; i += 1) if (text[i] !== '`') return 0;
      return t - f;
    };
    // Inside: first and last line of the range are fences. Outside: the lines just above and below are.
    const firstEnd = lineEndOf(text, ls);
    const lastStart = lineStartOf(text, le);
    let ua = -1;
    let ub = -1;
    let innerA = 0;
    let innerB = 0;
    if (firstEnd < lastStart && isFence(ls, firstEnd) && isFence(lastStart, le) >= isFence(ls, firstEnd)) {
      ua = ls; ub = le; innerA = firstEnd + 1; innerB = lastStart - 1;
    } else if (ls > 0 && le < text.length) {
      const pls = lineStartOf(text, ls - 1);
      const nle = lineEndOf(text, le + 1);
      const f1 = isFence(pls, ls - 1);
      if (f1 && isFence(le + 1, nle) >= f1) { ua = pls; ub = nle; innerA = ls; innerB = le; }
    }
    if (ua !== -1) {
      const edits = [{ at: ua, del: innerA - ua, ins: 0 }, { at: innerB, del: ub - innerB, ins: 0 }];
      return {
        start: ua, end: ub, insert: text.slice(innerA, innerB),
        selStart: mapPos(start, edits), selEnd: mapPos(end, edits),
      };
    }
    const inner = text.slice(ls, le);
    const fence = '`'.repeat(Math.max(3, longestRun(inner, '`') + 1));
    const insert = `${fence}\n${inner}\n${fence}`;
    return { start: ls, end: le, insert, selStart: ls, selEnd: ls + insert.length };
  }

  /**
   * Wraps the selection in a marker (** * ~~ == `), or removes the marker when it is already there (inside the
   * selection or just outside it). Whitespace at the selection's edges stays outside. Several lines: each
   * non-blank line is wrapped on its own, except for ` which makes a fenced block.
   */
  function toggleWrap(text, start, end, marker) {
    if (!posOk(text, start, end) || typeof marker !== 'string' || !WRAP_MARKERS.includes(marker)) return null;
    const m = marker;
    if (start === end) {
      const caret = start + m.length;
      return { start, end, insert: m + m, selStart: caret, selEnd: caret };
    }
    let a = start;
    let b = end;
    while (a < b && isSpaceCh(text[a])) a += 1;
    while (b > a && isSpaceCh(text[b - 1])) b -= 1;
    if (a >= b) return noEdit(start, end);
    const multi = text.indexOf('\n', a) !== -1 && text.indexOf('\n', a) < b;
    if (multi && m === '`') return toggleFence(text, start, end, a, b);
    if (!multi) {
      if (wrappedInside(text, a, b, m)) {
        const edits = [{ at: a, del: m.length, ins: 0 }, { at: b - m.length, del: m.length, ins: 0 }];
        return { start: a, end: b, insert: text.slice(a + m.length, b - m.length), selStart: mapPos(start, edits), selEnd: mapPos(end, edits) };
      }
      if (wrappedOutside(text, a, b, m)) {
        const ra = a - m.length;
        const rb = b + m.length;
        const edits = [{ at: ra, del: m.length, ins: 0 }, { at: b, del: m.length, ins: 0 }];
        return { start: ra, end: rb, insert: text.slice(a, b), selStart: mapPos(start, edits), selEnd: mapPos(end, edits) };
      }
      return { start: a, end: b, insert: m + text.slice(a, b) + m, selStart: start, selEnd: end + 2 * m.length };
    }
    // several lines: the covered part of each non-blank line, trimmed
    const segs = [];
    let ls = a;
    for (;;) {
      const nl = text.indexOf('\n', ls);
      let sa = ls;
      let sb = nl === -1 || nl > b ? b : nl;
      while (sa < sb && isSpaceCh(text[sa])) sa += 1;
      while (sb > sa && isSpaceCh(text[sb - 1])) sb -= 1;
      if (sa < sb) segs.push({ a: sa, b: sb });
      if (nl === -1 || nl >= b) break;
      ls = nl + 1;
    }
    const allWrapped = segs.every((s) => wrappedInside(text, s.a, s.b, m));
    const edits = [];
    let out = '';
    let at = a;
    let added = 0;
    for (const s of segs) {
      out += text.slice(at, s.a);
      if (allWrapped) {
        edits.push({ at: s.a, del: m.length, ins: 0 }, { at: s.b - m.length, del: m.length, ins: 0 });
        out += text.slice(s.a + m.length, s.b - m.length);
      } else if (wrappedInside(text, s.a, s.b, m)) {
        out += text.slice(s.a, s.b); // already wrapped: left as it is, never doubled
      } else {
        added += 2 * m.length;
        out += m + text.slice(s.a, s.b) + m;
      }
      at = s.b;
    }
    out += text.slice(at, b);
    if (allWrapped) return { start: a, end: b, insert: out, selStart: mapPos(start, edits), selEnd: mapPos(end, edits) };
    return { start: a, end: b, insert: out, selStart: start, selEnd: end + added };
  }

  /** Adds `prefix` ('> ' or '- ') to every touched line, or removes it when every non-blank touched line has it. */
  function toggleLinePrefix(text, start, end, prefix) {
    if (!posOk(text, start, end) || typeof prefix !== 'string' || !LINE_PREFIXES.includes(prefix)) return null;
    const first = lineStartOf(text, start);
    let lastStart = lineStartOf(text, end);
    if (end > start && lastStart === end) lastStart = lineStartOf(text, end - 1);
    const lines = [];
    let ls = first;
    for (;;) {
      const le = lineEndOf(text, ls);
      let w = 0;
      while (ls + w < le && (text[ls + w] === ' ' || text[ls + w] === '\t')) w += 1;
      const blank = ls + w === le || (ls + w === le - 1 && text[le - 1] === '\r');
      lines.push({ ls, le, w, blank, has: !blank && text.startsWith(prefix, ls + w) });
      if (ls >= lastStart || le >= text.length) break;
      ls = le + 1;
    }
    const lived = lines.filter((l) => !l.blank);
    const remove = lived.length > 0 && lived.every((l) => l.has);
    if (lived.length === 0 && lines.length > 1) return noEdit(start, end);
    const edits = [];
    const out = lines.map((l) => {
      if (remove) {
        if (l.blank) return text.slice(l.ls, l.le);
        const at = l.ls + l.w;
        edits.push({ at, del: prefix.length, ins: 0 });
        return text.slice(l.ls, at) + text.slice(at + prefix.length, l.le);
      }
      if (l.blank && lines.length > 1) return text.slice(l.ls, l.le); // blank lines in a block stay blank
      edits.push({ at: l.ls, del: 0, ins: prefix.length });
      return prefix + text.slice(l.ls, l.le);
    });
    return { start: first, end: lines[lines.length - 1].le, insert: out.join('\n'), selStart: mapPos(start, edits), selEnd: mapPos(end, edits) };
  }

  function isHttpUrl(s) {
    if (s.length < 8 || s.length > 2000) return false;
    const head = s.slice(0, 8).toLowerCase();
    if (!(head.startsWith('http://') || head === 'https://')) return false;
    for (let i = 0; i < s.length; i += 1) {
      const c = s.charCodeAt(i);
      if (c <= 0x20 || c === 0x7f || s[i] === '(' || s[i] === ')') return false;
    }
    return s.length > (head === 'https://' ? 8 : 7);
  }

  /** `sel` becomes [sel](url) with url selected; an empty selection gives [text](url); a URL becomes [text](URL). */
  function makeLink(text, start, end) {
    if (!posOk(text, start, end)) return null;
    let a = start;
    let b = end;
    while (a < b && isSpaceCh(text[a])) a += 1;
    while (b > a && isSpaceCh(text[b - 1])) b -= 1;
    if (a === b) a = b = start;
    const sel = text.slice(a, b);
    if (sel.includes('\n') || sel.includes('[') || sel.includes(']')) return noEdit(start, end); // not a valid link label
    if (sel === '') {
      // nothing but (at most) whitespace selected: the whitespace stays, the link goes after it
      return { start: end, end, insert: '[text](url)', selStart: end + 1, selEnd: end + 5 };
    }
    if (isHttpUrl(sel)) {
      return { start: a, end: b, insert: `[text](${sel})`, selStart: a + 1, selEnd: a + 5 };
    }
    const from = a + sel.length + 3;
    return { start: a, end: b, insert: `[${sel}](url)`, selStart: from, selEnd: from + 3 };
  }

  return {
    TransformError, TRANSFORMS, SLASH,
    toggleWrap, toggleLinePrefix, makeLink,
    ymd, hm, utcStamp, isoWeek, stats, position, deriveTitle, extractTags, extractWikiLinks, headings,
    inCodeAt, arrowReplacement, credentialsTemplate, listContinuation, isTask, toggleTask, numberStats, slugify, expandSlash, fuzzyScore, relativeTime,
    PALETTE_SECTIONS, sectionOf, paletteSections, paletteScore,
  };
});
