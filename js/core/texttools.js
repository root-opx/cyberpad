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

  const PALETTE_SECTIONS = Object.freeze(['Recent notes', 'Note', 'File', 'View', 'Insert', 'Text', 'Tools', 'Vault', 'Security']);
  const SECTION_RENAMES = new Map([['Theme', 'View'], ['Templates', 'Insert'], ['Transform', 'Text']]);

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

  return {
    TransformError, TRANSFORMS, SLASH,
    ymd, hm, utcStamp, isoWeek, stats, position, deriveTitle, extractTags, extractWikiLinks, headings,
    listContinuation, isTask, toggleTask, numberStats, slugify, expandSlash, fuzzyScore, relativeTime,
    PALETTE_SECTIONS, sectionOf, paletteSections, paletteScore,
  };
});
