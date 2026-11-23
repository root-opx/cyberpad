/*
 * Minimal Markdown parser that produces a plain-object syntax tree.
 * It never produces HTML: the UI renders the tree with DOM APIs and text
 * nodes, so raw HTML in a note is always shown as text.
 */
(function (root, factory) {
  'use strict';
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else (root.NP = root.NP || {}).markdown = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_INLINE_LINE = 5000;   // longer lines are shown as plain text
  const MAX_INLINE_DEPTH = 6;
  const MAX_QUOTE_DEPTH = 8;
  const MAX_TABLE_COLUMNS = 50;

  const RE = {
    fence: /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]{0,30})\s*$/,
    heading: /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/,
    hr: /^\s{0,3}([-*_])(\s*\1){2,}\s*$/,
    quote: /^\s{0,3}>\s?(.*)$/,
    ul: /^(\s*)([-*+])\s+(\[([ xX])\](?:\s+|$))?(.*)$/,
    ol: /^(\s*)(\d{1,9})[.)]\s+(\[([ xX])\](?:\s+|$))?(.*)$/,
    tableSep: /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/,
  };

  /** Allow only http(s) and mailto links. Returns a normalized href or null. */
  function safeUrl(raw) {
    if (typeof raw !== 'string') return null;
    const s = raw.trim();
    if (!/^(https?:\/\/|mailto:)/i.test(s) || /[\s\u0000-\u001f\u007f]/.test(s)) return null;
    try {
      const u = new URL(s);
      if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'mailto:') return null;
      return u.href;
    } catch (err) {
      if (err instanceof TypeError) return null;
      throw err;
    }
  }

  /**
   * Builds the reference URL for a CVE, CWE or MITRE ATT&CK ID. The ID must match
   * its full pattern, so nothing from the note can change the host or path shape.
   */
  const REF_PATTERNS = {
    cve: /^CVE-\d{4}-\d{4,7}$/,
    cwe: /^CWE-\d{1,5}$/,
    technique: /^T\d{4}(?:\.\d{3})?$/,
    tactic: /^TA\d{4}$/,
  };

  function refUrl(kind, rawId) {
    if (typeof rawId !== 'string' || !Object.prototype.hasOwnProperty.call(REF_PATTERNS, kind)) return null;
    const id = rawId.toUpperCase();
    if (!REF_PATTERNS[kind].test(id)) return null;
    switch (kind) {
      case 'cve': return `https://nvd.nist.gov/vuln/detail/${id}`;
      case 'cwe': return `https://cwe.mitre.org/data/definitions/${Number(id.slice(4))}.html`;
      case 'technique': return `https://attack.mitre.org/techniques/${id.replace('.', '/')}/`;
      default: return `https://attack.mitre.org/tactics/${id}/`;
    }
  }

  const REF_TITLES = { cve: 'on NVD', cwe: 'on MITRE CWE', technique: 'on MITRE ATT&CK', tactic: 'on MITRE ATT&CK' };

  /** Hex colour codes like #ff00aa are not tags. */
  function isTagName(name) {
    return !/^(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(name);
  }

  function matchAt(re, src, i) {
    re.lastIndex = i;
    return re.exec(src);
  }

  const INLINE = {
    code: /`([^`\n]+)`/y,
    wiki: /\[\[([^[\]\n|]{1,200})(?:\|([^[\]\n]{1,200}))?\]\]/y,
    link: /\[([^\]\n]{1,500})\]\(([^()\s]{1,2000})\)/y,
    strong: /\*\*(?=\S)([^\n]*?\S)\*\*/y,
    strongU: /__(?=\S)([^\n]*?\S)__/y,
    del: /~~(?=\S)([^\n]*?\S)~~/y,
    mark: /==(?=\S)([^\n]*?\S)==/y,
    em: /\*(?=[^\s*])([^*\n]*?[^\s*])\*/y,
    emU: /_(?=[^\s_])([^_\n]*?[^\s_])_(?![\p{L}\p{N}])/uy,
    tag: /#([\p{L}][\p{L}\p{N}_-]{0,49})/uy,
    url: /https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"*_~]/y,
    cve: /CVE-\d{4}-\d{4,7}(?![\p{L}\p{N}])/iuy,
    cwe: /CWE-\d{1,5}(?![\p{L}\p{N}])/iuy,
    attack: /T(A?)\d{4}(?:\.\d{3})?(?![\p{L}\p{N}])/uy,
    cvss: /CVSS:\d{1,2}\.\d{1,2}(?:\/[A-Z]{1,3}:[A-Z]){1,40}(?![\p{L}\p{N}:/])/uy,
  };

  const ESCAPABLE = /[\\`*_~[\]()#=!|>-]/;
  const WORDY = /[\p{L}\p{N}]/u;

  // noLinks is set inside a link's label: nested anchors are invalid HTML, so
  // no wiki links, tags, autolinks or references are produced there.
  function parseInline(src, depth, noLinks = false) {
    if (src.length > MAX_INLINE_LINE || depth > MAX_INLINE_DEPTH) return [{ type: 'text', value: src }];
    const out = [];
    let buf = '';
    let i = 0;
    const flush = () => { if (buf) { out.push({ type: 'text', value: buf }); buf = ''; } };
    const push = (node, len) => { flush(); out.push(node); i += len; };

    while (i < src.length) {
      const ch = src[i];
      const prev = i > 0 ? src[i - 1] : '';
      let m;

      if (ch === '\\' && i + 1 < src.length && ESCAPABLE.test(src[i + 1])) {
        buf += src[i + 1];
        i += 2;
        continue;
      }
      if (ch === '`' && (m = matchAt(INLINE.code, src, i))) {
        push({ type: 'code', value: m[1] }, m[0].length);
        continue;
      }
      if (!noLinks && ch === '[' && src[i + 1] === '[' && (m = matchAt(INLINE.wiki, src, i))) {
        const target = m[1].trim();
        if (target) {
          push({ type: 'wiki', target, label: (m[2] || m[1]).trim() }, m[0].length);
          continue;
        }
      }
      if (!noLinks && ch === '[' && (m = matchAt(INLINE.link, src, i))) {
        const href = safeUrl(m[2]);
        if (href) {
          push({ type: 'link', href, children: parseInline(m[1], depth + 1, true) }, m[0].length);
          continue;
        }
      }
      if (ch === '*' && src[i + 1] === '*' && (m = matchAt(INLINE.strong, src, i))) {
        push({ type: 'strong', children: parseInline(m[1], depth + 1, noLinks) }, m[0].length);
        continue;
      }
      if (ch === '_' && src[i + 1] === '_' && !WORDY.test(prev) && (m = matchAt(INLINE.strongU, src, i))) {
        push({ type: 'strong', children: parseInline(m[1], depth + 1, noLinks) }, m[0].length);
        continue;
      }
      if (ch === '~' && src[i + 1] === '~' && (m = matchAt(INLINE.del, src, i))) {
        push({ type: 'del', children: parseInline(m[1], depth + 1, noLinks) }, m[0].length);
        continue;
      }
      if (ch === '=' && src[i + 1] === '=' && (m = matchAt(INLINE.mark, src, i))) {
        push({ type: 'mark', children: parseInline(m[1], depth + 1, noLinks) }, m[0].length);
        continue;
      }
      if (ch === '*' && (m = matchAt(INLINE.em, src, i))) {
        push({ type: 'em', children: parseInline(m[1], depth + 1, noLinks) }, m[0].length);
        continue;
      }
      if (ch === '_' && !WORDY.test(prev) && (m = matchAt(INLINE.emU, src, i))) {
        push({ type: 'em', children: parseInline(m[1], depth + 1, noLinks) }, m[0].length);
        continue;
      }
      if (!noLinks && ch === '#' && (prev === '' || /[\s(]/.test(prev)) && (m = matchAt(INLINE.tag, src, i)) && isTagName(m[1])) {
        push({ type: 'tag', name: m[1].toLowerCase() }, m[0].length);
        continue;
      }
      if (!noLinks && ch === 'h' && !WORDY.test(prev) && (m = matchAt(INLINE.url, src, i))) {
        const href = safeUrl(m[0]);
        if (href) {
          push({ type: 'link', href, children: [{ type: 'text', value: m[0] }] }, m[0].length);
          continue;
        }
      }
      if (!noLinks && !WORDY.test(prev) && (ch === 'C' || ch === 'c' || ch === 'T')) {
        if (ch === 'C' && src.startsWith('CVSS:', i) && (m = matchAt(INLINE.cvss, src, i))) {
          push({ type: 'cvss', vector: m[0] }, m[0].length);
          continue;
        }
        let kind = null;
        if (ch === 'T') { if ((m = matchAt(INLINE.attack, src, i))) kind = m[1] ? 'tactic' : 'technique'; }
        else if ((m = matchAt(INLINE.cve, src, i))) kind = 'cve';
        else if ((m = matchAt(INLINE.cwe, src, i))) kind = 'cwe';
        const href = kind && refUrl(kind, m[0]);
        if (href) {
          const id = m[0].toUpperCase();
          push({ type: 'ref', kind, id, href, title: `Open ${id} ${REF_TITLES[kind]}`, children: [{ type: 'text', value: m[0] }] }, m[0].length);
          continue;
        }
      }
      buf += ch;
      i++;
    }
    flush();
    return out;
  }

  function inline(text) {
    return parseInline(text, 0);
  }

  function inlineLines(lines) {
    const out = [];
    lines.forEach((line, idx) => {
      if (idx > 0) out.push({ type: 'br' });
      out.push(...inline(line.trim()));
    });
    return out;
  }

  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    return s.split(/(?<!\\)\|/).slice(0, MAX_TABLE_COLUMNS).map((c) => c.trim().replace(/\\\|/g, '|'));
  }

  function isTableStart(lines, i) {
    return lines[i].includes('|') && i + 1 < lines.length && lines[i + 1].includes('-') && RE.tableSep.test(lines[i + 1]);
  }

  function startsBlock(lines, i) {
    const line = lines[i];
    return RE.fence.test(line) || RE.heading.test(line) || RE.hr.test(line) || RE.quote.test(line)
      || RE.ul.test(line) || RE.ol.test(line) || isTableStart(lines, i);
  }

  function parseBlocks(lines, offset, depth) {
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      let m;

      if ((m = RE.fence.exec(line))) {
        const fenceChar = m[1][0];
        const fenceLen = m[1].length;
        const start = i;
        const body = [];
        i++;
        while (i < lines.length) {
          const t = lines[i].trim();
          if (t.length >= fenceLen && t[0] === fenceChar && t === fenceChar.repeat(t.length)) break;
          body.push(lines[i]);
          i++;
        }
        blocks.push({ type: 'code', lang: m[2] || '', text: body.join('\n'), line: offset + start });
        i++; // skip closing fence (or move past the end)
        continue;
      }

      if ((m = RE.heading.exec(line))) {
        blocks.push({ type: 'heading', level: m[1].length, children: inline(m[2]), line: offset + i });
        i++;
        continue;
      }

      if (RE.hr.test(line)) {
        blocks.push({ type: 'hr' });
        i++;
        continue;
      }

      if (RE.quote.test(line)) {
        const start = i;
        const inner = [];
        while (i < lines.length && (m = RE.quote.exec(lines[i]))) { inner.push(m[1]); i++; }
        const children = depth < MAX_QUOTE_DEPTH
          ? parseBlocks(inner, offset + start, depth + 1)
          : [{ type: 'paragraph', children: [{ type: 'text', value: inner.join('\n') }] }];
        blocks.push({ type: 'quote', children });
        continue;
      }

      if (RE.ul.test(line) || RE.ol.test(line)) {
        const ordered = !RE.ul.test(line);
        const re = ordered ? RE.ol : RE.ul;
        const start = ordered ? Number.parseInt(RE.ol.exec(line)[2], 10) : 1;
        const items = [];
        while (i < lines.length && (m = re.exec(lines[i]))) {
          const indent = Math.min(6, Math.floor(m[1].replace(/\t/g, '    ').length / 2));
          items.push({
            indent,
            task: m[3] ? m[4].toLowerCase() === 'x' : null,
            line: offset + i,
            children: inline(m[5]),
          });
          i++;
        }
        blocks.push({ type: 'list', ordered, start, items });
        continue;
      }

      if (isTableStart(lines, i)) {
        const header = splitRow(line);
        const aligns = splitRow(lines[i + 1]).map((c) => {
          if (c.startsWith(':') && c.endsWith(':')) return 'center';
          if (c.endsWith(':')) return 'right';
          return 'left';
        });
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
          rows.push(splitRow(lines[i]).map(inline));
          i++;
        }
        blocks.push({ type: 'table', header: header.map(inline), aligns, rows });
        continue;
      }

      const para = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) { para.push(lines[i]); i++; }
      blocks.push({ type: 'paragraph', children: inlineLines(para) });
    }
    return blocks;
  }

  function parse(src) {
    const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    return parseBlocks(lines, 0, 0);
  }

  return { parse, parseInline: inline, safeUrl, isTagName, refUrl };
});
