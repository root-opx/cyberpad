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

  const entry = (id, name, unit, openers, closers) => Object.freeze({
    id, name, unit, openers: Object.freeze([...openers]), closers: Object.freeze([...closers]),
  });

  const LANGUAGES = Object.freeze([
    entry('bash', 'Bash', TWO, ['then', 'do', 'else', '{', '('], ['}', ')']),
    entry('c', 'C', FOUR, BRACES, CLOSERS3),
    entry('cpp', 'C++', FOUR, BRACES, CLOSERS3),
    entry('csharp', 'C#', FOUR, BRACES, CLOSERS3),
    entry('css', 'CSS', TWO, ['{'], ['}']),
    entry('go', 'Go', '\t', BRACES, CLOSERS3),
    entry('html', 'HTML', TWO, [], []),
    entry('java', 'Java', FOUR, BRACES, CLOSERS3),
    entry('javascript', 'JavaScript', TWO, BRACES, CLOSERS3),
    entry('json', 'JSON', TWO, ['{', '['], ['}', ']']),
    entry('powershell', 'PowerShell', FOUR, ['{', '('], ['}', ')']),
    entry('python', 'Python', FOUR, [':'], []),
    entry('rust', 'Rust', FOUR, BRACES, CLOSERS3),
    entry('sql', 'SQL', FOUR, ['('], [')']),
    entry('typescript', 'TypeScript', TWO, BRACES, CLOSERS3),
    entry('yaml', 'YAML', TWO, [':'], []),
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

  const LINE_COMMENT = Object.freeze({
    c: '//', cpp: '//', csharp: '//', go: '//', java: '//', javascript: '//', typescript: '//', rust: '//',
    python: '#', yaml: '#', bash: '#', powershell: '#', sql: '--',
  });
  const BLOCK_COMMENT = Object.freeze(['c', 'cpp', 'csharp', 'css', 'go', 'java', 'javascript', 'typescript', 'rust']);

  /**
   * `s` (the line before the caret) without a trailing comment. Conservative: a marker counts only when
   * the quote characters before it, counted naively, are even in number for both " and '.
   */
  function stripComment(s, lang) {
    const line = LINE_COMMENT[lang.id];
    const block = BLOCK_COMMENT.includes(lang.id);
    let dq = 0;
    let sq = 0;
    for (let i = 0; i < s.length; i += 1) {
      const c = s[i];
      if (c === '"') dq += 1;
      else if (c === "'") sq += 1;
      else if (dq % 2 === 0 && sq % 2 === 0) {
        if (line && s.startsWith(line, i) && (line !== '#' || i === 0 || isWs(s[i - 1]))) return s.slice(0, i);
        if (block && s.startsWith('/*', i)) {
          const rest = s.slice(i).replace(/[ \t]+$/, '');
          if (rest.length >= 4 && rest.endsWith('*/') && rest.indexOf('*/', 2) === rest.length - 2) return s.slice(0, i);
        }
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

  return { LANGUAGES, language, enter, tab, backspace, closer };
});
