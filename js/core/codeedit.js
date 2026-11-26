/*
 * Script-mode editing rules: the language table and pure functions that decide what Enter, Tab,
 * Shift+Tab, Backspace and a typed closer do. Each returns null (let the browser do its default) or
 * { start, end, insert, selStart, selEnd }: replace [start, end) of the text with `insert`, then select
 * [selStart, selEnd) in the result. Only the lines involved are looked at, never the whole text.
 */
(function (root, factory) {
  'use strict';
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else (root.NP = root.NP || {}).codeedit = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TWO = '  ';
  const FOUR = '    ';
  const BRACES = ['{', '(', '['];
  const CLOSERS3 = ['}', ')', ']'];
  const MATCH = Object.freeze({ '{': '}', '(': ')', '[': ']' });
  const TAB_UNIT_SPACES = 4; // a tab unit still removes up to this many leading spaces on Shift+Tab

  const C_BLOCK = Object.freeze(['/*', '*/']);
  const HTML_BLOCK = Object.freeze(['<!--', '-->']);
  // lineComment: string or null. blockComment: [open, close] or null.
  const entry = (id, name, unit, openers, closers, lineComment = null, blockComment = null) => Object.freeze({
    id, name, unit, openers: Object.freeze([...openers]), closers: Object.freeze([...closers]), lineComment, blockComment,
  });

  const LANGUAGES = Object.freeze([
    entry('bash', 'Bash', TWO, ['then', 'do', 'else', '{', '('], ['}', ')'], '#'),
    entry('c', 'C', FOUR, BRACES, CLOSERS3, '//', C_BLOCK),
    entry('cpp', 'C++', FOUR, BRACES, CLOSERS3, '//', C_BLOCK),
    entry('csharp', 'C#', FOUR, BRACES, CLOSERS3, '//', C_BLOCK),
    entry('css', 'CSS', TWO, ['{'], ['}'], null, C_BLOCK),
    entry('go', 'Go', '\t', BRACES, CLOSERS3, '//', C_BLOCK),
    entry('html', 'HTML', TWO, [], [], null, HTML_BLOCK),
    entry('java', 'Java', FOUR, BRACES, CLOSERS3, '//', C_BLOCK),
    entry('javascript', 'JavaScript', TWO, BRACES, CLOSERS3, '//', C_BLOCK),
    entry('json', 'JSON', TWO, ['{', '['], ['}', ']']),
    entry('powershell', 'PowerShell', FOUR, ['{', '('], ['}', ')'], '#'),
    entry('python', 'Python', FOUR, [':'], [], '#'),
    entry('rust', 'Rust', FOUR, BRACES, CLOSERS3, '//', C_BLOCK),
    entry('sql', 'SQL', FOUR, ['('], [')'], '--'),
    entry('typescript', 'TypeScript', TWO, BRACES, CLOSERS3, '//', C_BLOCK),
    entry('yaml', 'YAML', TWO, [':'], [], '#'),
    entry('batch', 'Batch', FOUR, ['('], [')'], 'REM '),
    entry('ruby', 'Ruby', TWO, ['then', 'do', 'else', 'begin', ...BRACES], CLOSERS3, '#'),
    entry('php', 'PHP', FOUR, [...BRACES, ':'], CLOSERS3, '//'),
    entry('lua', 'Lua', TWO, ['then', 'do', 'else', 'repeat', '{', '('], ['}', ')'], '--'),
    entry('perl', 'Perl', FOUR, BRACES, CLOSERS3, '#'),
    entry('xml', 'XML', TWO, [], [], null, HTML_BLOCK),
    entry('ini', 'INI and TOML', TWO, [], [], '#'),
    entry('plain', 'Plain text', FOUR, [], []),
  ]);

  /** The table entry for an id, or null. Compared with ===, so '__proto__' and 'Python' never match. */
  function language(id) {
    if (typeof id !== 'string') return null;
    for (const l of LANGUAGES) if (l.id === id) return l;
    return null;
  }

  /** The language when every argument is usable, else null. */
  function check(text, start, end, id) {
    if (typeof text !== 'string') return null;
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
    if (start < 0 || start > end || end > text.length) return null;
    if (splitsPair(text, start) || splitsPair(text, end)) return null; // never create a lone surrogate
    return language(id);
  }

  /** True when pos sits between a high and a low surrogate. */
  function splitsPair(text, pos) {
    if (pos <= 0 || pos >= text.length) return false;
    const hi = text.charCodeAt(pos - 1);
    const lo = text.charCodeAt(pos);
    return hi >= 0xD800 && hi <= 0xDBFF && lo >= 0xDC00 && lo <= 0xDFFF;
  }

  const lineStart = (text, pos) => (pos === 0 ? 0 : text.lastIndexOf('\n', pos - 1) + 1);
  const lineEnd = (text, pos) => {
    const i = text.indexOf('\n', pos);
    return i === -1 ? text.length : i;
  };
  const isWs = (c) => c === ' ' || c === '\t';

  /** Length of the run of spaces and tabs at text[from..limit). */
  function wsRun(text, from, limit) {
    let i = from;
    while (i < limit && isWs(text[i])) i += 1;
    return i - from;
  }

  /** How many leading characters Shift+Tab removes from the line starting at ls (not past `limit`). */
  function removable(text, ls, limit, lang) {
    if (ls < limit && text[ls] === '\t') return 1;
    const max = lang.unit === '\t' ? TAB_UNIT_SPACES : lang.unit.length;
    let n = 0;
    while (n < max && ls + n < limit && text[ls + n] === ' ') n += 1;
    return n;
  }

  const BLOCK_COMMENT = Object.freeze(['c', 'cpp', 'csharp', 'css', 'go', 'java', 'javascript', 'typescript', 'rust']);

  /**
   * `s` (the line before the caret) without a trailing comment. Conservative: a marker counts only when
   * the quote characters before it, counted naively, are even in number for both " and '.
   */
  function stripComment(s, lang) {
    const line = lang.id === 'batch' ? null : lang.lineComment; // a batch REM only starts a line
    // One linear pass: only the LAST `/*` can open a block comment that runs to the end of the line.
    let end = s.length;
    while (end > 0 && isWs(s[end - 1])) end -= 1;
    let c = -1;
    if (BLOCK_COMMENT.includes(lang.id) && end >= 4 && s[end - 1] === '/' && s[end - 2] === '*') {
      const k = s.lastIndexOf('/*', end - 4);
      if (k !== -1 && s.indexOf('*/', k + 2) === end - 2) c = k;
    }
    if (!line && c === -1) return s;
    let dq = 0;
    let sq = 0;
    for (let i = 0; i < s.length; i += 1) {
      const ch = s[i];
      if (ch === '"') dq += 1;
      else if (ch === "'") sq += 1;
      else if (dq % 2 === 0 && sq % 2 === 0) {
        if (line && s.startsWith(line, i) && (line !== '#' || i === 0 || isWs(s[i - 1]))) return s.slice(0, i);
        if (i === c) return s.slice(0, i);
      }
    }
    return s;
  }

  /** The opener that the code before the caret ends in (comment and trailing spaces ignored), or ''. */
  function openerBefore(text, ls, start, lang) {
    let s = stripComment(text.slice(ls, start), lang);
    let e = s.length;
    while (e > 0 && isWs(s[e - 1])) e -= 1;
    s = s.slice(0, e);
    if (lang.id === 'yaml' && /(^|[ \t])[|>][-+]?$/.test(s)) return '|'; // a block scalar header
    for (const o of lang.openers) {
      if (s.length < o.length || !s.endsWith(o)) continue;
      if (/^[a-z]+$/.test(o)) {
        // a whole shell word: `redo`, `$do` and `/tmp/then` are not openers
        const prev = s[s.length - o.length - 1];
        if (prev !== undefined && !isWs(prev) && prev !== ';') continue;
      }
      return o;
    }
    return '';
  }

  function enter(text, start, end, id) {
    const lang = check(text, start, end, id);
    if (!lang) return null;
    const ls = lineStart(text, start);
    const indent = text.slice(ls, ls + wsRun(text, ls, start)); // only what is left of the caret
    const opener = openerBefore(text, ls, start, lang);
    const inner = indent + (opener ? lang.unit : '');
    const between = opener !== '' && MATCH[opener] !== undefined && text[end] === MATCH[opener];
    const caret = start + 1 + inner.length;
    return {
      start, end,
      insert: '\n' + inner + (between ? '\n' + indent : ''),
      selStart: caret, selEnd: caret,
    };
  }

  /** The first and last line starts touched by the selection (a line it only reaches at column 0 is not touched). */
  function touched(text, start, end) {
    const first = lineStart(text, start);
    let last = lineStart(text, end);
    if (end > start && last === end) last = lineStart(text, end - 1);
    return { first, last };
  }

  /** Lines from the one starting at `first` to the one starting at `last`: { ls, le }, le before the '\n' (a '\r' stays inside). */
  function linesOf(text, first, last) {
    const out = [];
    let ls = first;
    for (;;) {
      const le = lineEnd(text, ls);
      out.push({ ls, le });
      if (ls >= last || le >= text.length) break;
      ls = le + 1;
    }
    return out;
  }

  const isBlank = (text, l) => l.le === l.ls || (l.le === l.ls + 1 && text[l.ls] === '\r');

  function indentLines(text, start, end, lang) {
    const { first, last } = touched(text, start, end);
    const lines = linesOf(text, first, last);
    const added = lines.map((l) => (isBlank(text, l) ? 0 : lang.unit.length)); // empty lines stay empty
    const insert = lines.map((l, i) => (added[i] ? lang.unit : '') + text.slice(l.ls, l.le)).join('\n');
    const shiftPos = (p) => p + lines.reduce((sum, l, i) => (l.ls <= p ? sum + added[i] : sum), 0);
    return { start: first, end: lines[lines.length - 1].le, insert, selStart: shiftPos(start), selEnd: shiftPos(end) };
  }

  function dedentLines(text, start, end, lang) {
    const { first, last } = touched(text, start, end);
    const lines = linesOf(text, first, last);
    const removed = lines.map((l) => removable(text, l.ls, l.le, lang));
    // Nothing to remove: still handled (a no-op), or the browser would move focus out of the editor.
    if (removed.every((n) => n === 0)) return { start, end: start, insert: '', selStart: start, selEnd: end };
    const insert = lines.map((l, i) => text.slice(l.ls + removed[i], l.le)).join('\n');
    // A position inside a removed indentation goes to the start of its line, never before it.
    const shiftPos = (p) => p - lines.reduce((sum, l, i) => sum + Math.min(removed[i], Math.max(0, p - l.ls)), 0);
    return { start: first, end: lines[lines.length - 1].le, insert, selStart: shiftPos(start), selEnd: shiftPos(end) };
  }

  function tab(text, start, end, id, shift) {
    const lang = check(text, start, end, id);
    if (!lang) return null;
    if (shift !== undefined && typeof shift !== 'boolean') return null;
    if (shift === true) return dedentLines(text, start, end, lang);
    const nl = text.indexOf('\n', start);
    if (nl !== -1 && nl < end) return indentLines(text, start, end, lang);
    if (end > start) {
      // The line's whole text selected (from column 0 or the first non-blank): indent it, never replace it.
      const ls = lineStart(text, start);
      let le = lineEnd(text, start);
      if (le > ls && text[le - 1] === '\r') le -= 1;
      if (start <= ls + wsRun(text, ls, le) && end >= le) return indentLines(text, start, end, lang);
    }
    let insert = lang.unit;
    if (lang.unit !== '\t') {
      // A tab in the indentation counts as advancing to the next stop of one unit.
      const n = lang.unit.length;
      let col = 0;
      for (let i = lineStart(text, start); i < start; i += 1) col = text[i] === '\t' ? col + n - (col % n) : col + 1;
      insert = ' '.repeat(n - (col % n));
    }
    const caret = start + insert.length;
    return { start, end, insert, selStart: caret, selEnd: caret };
  }

  function backspace(text, start, end, id) {
    const lang = check(text, start, end, id);
    if (!lang || start !== end || lang.unit === '\t') return null;
    const ls = lineStart(text, start);
    const col = start - ls;
    if (col === 0) return null;
    for (let i = ls; i < start; i += 1) if (text[i] !== ' ') return null;
    const n = lang.unit.length;
    const to = ls + Math.floor((col - 1) / n) * n; // the previous indent stop
    return { start: to, end: start, insert: '', selStart: to, selEnd: to };
  }

  function closer(text, start, end, id, typed) {
    const lang = check(text, start, end, id);
    if (!lang || start !== end || typeof typed !== 'string' || !lang.closers.includes(typed)) return null;
    const ls = lineStart(text, start);
    let le = lineEnd(text, start);
    if (le > ls && text[le - 1] === '\r') le -= 1; // a CRLF line ends before its '\r'
    if (wsRun(text, ls, le) !== le - ls) return null; // the line holds only whitespace
    const cut = removable(text, ls, start, lang); // up to one unit of the indentation left of the caret
    const caret = start - cut + 1;
    return { start: ls, end: start, insert: text.slice(ls + cut, start) + typed, selStart: caret, selEnd: caret };
  }

  // ---- comment toggle, duplicate line, move line -------------------------------------------------

  /** True when start/end are usable positions in text (integers, ordered, in range, not inside a surrogate pair). */
  function posOk(text, start, end) {
    if (typeof text !== 'string') return false;
    if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
    if (start < 0 || start > end || end > text.length) return false;
    return !(splitsPair(text, start) || splitsPair(text, end));
  }

  /** '' (a Markdown note) is allowed for the line helpers; otherwise the id must be a known language. */
  const lineIdOk = (id) => id === '' || language(id) !== null;

  /** Where a position goes after the edits [{ at, del, ins }] (ascending, not overlapping) in the old text. */
  function mapPos(p, edits) {
    let r = p;
    for (const ed of edits) {
      if (p >= ed.at + ed.del) r += ed.ins - ed.del;
      else if (p > ed.at) r -= p - ed.at;
    }
    return r;
  }

  const isBlankRun = (text, ls, le) => {
    const w = wsRun(text, ls, le);
    return ls + w === le || (ls + w === le - 1 && text[le - 1] === '\r');
  };

  /** Length of the line comment marker at pos (the first non-blank character of a line), plus one space; 0 if none. */
  function markerLen(text, pos, le, lang) {
    const withSpace = (n) => n + (pos + n < le && text[pos + n] === ' ' ? 1 : 0);
    if (lang.id === 'batch') {
      if (text.startsWith('::', pos)) return withSpace(2);
      if (text.slice(pos, pos + 3).toLowerCase() === 'rem') {
        const nx = text[pos + 3];
        if (pos + 3 >= le || nx === ' ' || nx === '\t' || nx === '\r') return withSpace(3);
      }
      return 0;
    }
    if (lang.id === 'ini' && text[pos] === ';') return withSpace(1);
    const m = lang.lineComment.trimEnd();
    return text.startsWith(m, pos) ? withSpace(m.length) : 0;
  }

  const noop = (start, end) => ({ start, end: start, insert: '', selStart: start, selEnd: end });

  function toggleLineComment(text, start, end, lang) {
    const { first, last } = touched(text, start, end);
    const lines = linesOf(text, first, last);
    const info = [];
    let allCommented = true;
    let common = null; // the indentation shared by every non-blank line
    // A shebang (#! on the block's first line, in a # language) is neither a comment nor commentable.
    const shebang = lang.lineComment === '#' && text.startsWith('#!', first);
    for (const l of lines) {
      if (isBlankRun(text, l.ls, l.le) || (shebang && l.ls === first)) { info.push(null); continue; }
      const w = wsRun(text, l.ls, l.le);
      const len = markerLen(text, l.ls + w, l.le, lang);
      if (len === 0) allCommented = false;
      info.push({ w, len });
      if (common === null) common = text.slice(l.ls, l.ls + w);
      else {
        let k = 0;
        while (k < common.length && k < w && common[k] === text[l.ls + k]) k += 1;
        common = common.slice(0, k);
      }
    }
    if (common === null) return noop(start, end); // nothing but blank lines
    const marker = lang.lineComment.endsWith(' ') ? lang.lineComment : `${lang.lineComment} `;
    const edits = [];
    const out = lines.map((l, i) => {
      const inf = info[i];
      if (!inf) return text.slice(l.ls, l.le);
      if (allCommented) {
        const at = l.ls + inf.w;
        edits.push({ at, del: inf.len, ins: 0 });
        return text.slice(l.ls, at) + text.slice(at + inf.len, l.le);
      }
      const at = l.ls + common.length;
      edits.push({ at, del: 0, ins: marker.length });
      return text.slice(l.ls, at) + marker + text.slice(at, l.le);
    });
    return { start: first, end: lines[lines.length - 1].le, insert: out.join('\n'), selStart: mapPos(start, edits), selEnd: mapPos(end, edits) };
  }

  function toggleBlockComment(text, start, end, lang) {
    const [open, close] = lang.blockComment;
    let a = start;
    let b = end;
    if (start === end) {
      const ls = lineStart(text, start);
      const le = lineEnd(text, start);
      a = ls + wsRun(text, ls, le);
      b = le;
      while (b > a && (isWs(text[b - 1]) || text[b - 1] === '\r')) b -= 1;
    } else {
      while (a < b && (isWs(text[a]) || text[a] === '\n' || text[a] === '\r')) a += 1;
      while (b > a && (isWs(text[b - 1]) || text[b - 1] === '\n' || text[b - 1] === '\r')) b -= 1;
    }
    if (a >= b) return noop(start, end);
    // Already wrapped: the markers are inside the range, or just outside it.
    let ra = -1;
    let rb = -1;
    let d1 = 0;
    let d2 = 0;
    if (b - a >= open.length + close.length && text.startsWith(open, a) && text.startsWith(close, b - close.length)) {
      ra = a; rb = b;
      d1 = open.length + (a + open.length < b - close.length && text[a + open.length] === ' ' ? 1 : 0);
      d2 = close.length + (b - close.length - 1 >= a + d1 && text[b - close.length - 1] === ' ' ? 1 : 0);
    } else if (a - open.length - 1 >= 0 && text.startsWith(`${open} `, a - open.length - 1) && text.startsWith(` ${close}`, b)) {
      ra = a - open.length - 1; rb = b + close.length + 1;
      d1 = open.length + 1; d2 = close.length + 1;
    }
    // Two spans are not one: another opener or closer inside means the ends belong to different comments.
    const hasMarker = (from, to) => { const t = text.slice(from, to); return t.includes(open) || t.includes(close); };
    if (ra !== -1) {
      if (ra === a ? hasMarker(a + open.length, b - close.length) : hasMarker(a, b)) return noop(start, end);
      const edits = [{ at: ra, del: d1, ins: 0 }, { at: rb - d2, del: d2, ins: 0 }];
      return {
        start: ra, end: rb, insert: text.slice(ra + d1, rb - d2),
        selStart: mapPos(start, edits), selEnd: mapPos(end, edits),
      };
    }
    // Wrapping what already holds an opener or closer would nest or end early (in XML and HTML any -- is unsafe).
    if (hasMarker(a, b) || (lang.blockComment === HTML_BLOCK && text.slice(a, b).includes('--'))) return noop(start, end);
    const o = `${open} `;
    const c = ` ${close}`;
    const edits = [{ at: a, del: 0, ins: o.length }, { at: b, del: 0, ins: c.length }];
    const insert = o + text.slice(a, b) + c;
    if (start === end) {
      const p = mapPos(start, edits);
      return { start: a, end: b, insert, selStart: p, selEnd: p };
    }
    return { start: a, end: b, insert, selStart: start, selEnd: end + o.length + c.length };
  }

  /**
   * Comment or uncomment the touched lines with the language's line comment; a language with only a block
   * comment wraps or unwraps the selection (or the line's text); one with neither gets a no-op result.
   */
  function toggleComment(text, start, end, id) {
    const lang = check(text, start, end, id);
    if (!lang) return null;
    if (lang.lineComment) return toggleLineComment(text, start, end, lang);
    if (lang.blockComment) return toggleBlockComment(text, start, end, lang);
    return noop(start, end);
  }

  /** Copies the touched lines directly below them; the selection moves to the copy. */
  function duplicateLines(text, start, end, id) {
    if (!posOk(text, start, end) || !lineIdOk(id)) return null;
    const { first, last } = touched(text, start, end);
    const lastLe = lineEnd(text, last);
    const block = text.slice(first, lastLe);
    const shift = block.length + 1;
    return { start: lastLe, end: lastLe, insert: `\n${block}`, selStart: start + shift, selEnd: end + shift };
  }

  /** Swaps the touched lines with the line above (-1) or below (1); a no-op result at the first or last line. */
  function moveLines(text, start, end, id, direction) {
    if (!posOk(text, start, end) || !lineIdOk(id)) return null;
    if (direction !== -1 && direction !== 1) return null;
    const { first, last } = touched(text, start, end);
    const lastLe = lineEnd(text, last);
    // Model: the text is a list of lines separated by LF. A final newline leaves an empty last line that can be
    // swapped with the line before it (so up-then-down and down-then-up always restore the text), but is never
    // itself moved: a caret on it, or a move below it, is a no-op.
    if (first > 0 && first === text.length && text[first - 1] === '\n') return noop(start, end);
    const block = linesOf(text, first, last);
    let nb;
    if (direction === -1) {
      if (first === 0) return noop(start, end);
      nb = { ls: lineStart(text, first - 1), le: first - 1 };
    } else {
      if (lastLe >= text.length) return noop(start, end);
      nb = { ls: lastLe + 1, le: lineEnd(text, lastLe + 1) };
    }
    // Each line is content plus its own end ('\r' or nothing). Contents move, line ends stay in place, so a
    // CRLF text whose final line has no '\r' keeps that shape.
    const rec = (l) => {
      const crlf = l.le > l.ls && text[l.le - 1] === '\r';
      return { ls: l.ls, c: text.slice(l.ls, crlf ? l.le - 1 : l.le), e: crlf ? '\r' : '' };
    };
    const B = block.map(rec);
    const N = rec(nb);
    // A block that ends in an empty line cannot move onto the last line: that empty line would become the final
    // empty line after a newline, which cannot be selected, so the move could not be undone. A no-op.
    if (direction === 1 && nb.le === text.length && B[B.length - 1].c === '') return noop(start, end);
    const old = direction === -1 ? [N, ...B] : [...B, N];
    const contents = direction === -1 ? [...B, N] : [N, ...B];
    const regionStart = old[0].ls;
    const regionEnd = direction === -1 ? lastLe : nb.le;
    const lines = contents.map((r, i) => ({ c: r.c, e: old[i].e }));
    const newLs = [];
    let at = regionStart;
    for (const l of lines) { newLs.push(at); at += l.c.length + l.e.length + 1; }
    const mapIn = (p) => {
      let src = B[0];
      for (const r of B) if (r.ls <= p) src = r;
      const ni = contents.indexOf(src);
      const off = p - src.ls;
      const room = lines[ni].c.length + lines[ni].e.length;
      return newLs[ni] + Math.min(off, off <= src.c.length ? src.c.length : room);
    };
    const mapEnd = (p) => {
      if (p === lastLe + 1) {
        // the selection ended at column 0 of the line after the block: it still does
        return direction === 1 ? Math.min(regionEnd + 1, text.length) : newLs[lines.length - 1];
      }
      return mapIn(p);
    };
    return {
      start: regionStart, end: regionEnd,
      insert: lines.map((l) => l.c + l.e).join('\n'),
      selStart: mapIn(start), selEnd: start === end ? mapIn(start) : mapEnd(end),
    };
  }

  return { LANGUAGES, language, enter, tab, backspace, closer, toggleComment, duplicateLines, moveLines };
});
