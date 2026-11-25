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
    return language(id);
  }

  const lineStart = (text, pos) => (pos === 0 ? 0 : text.lastIndexOf('\n', pos - 1) + 1);
  const lineEnd = (text, pos) => {
    const i = text.indexOf('\n', pos);
    return i === -1 ? text.length : i;
  };
  const isWs = (c) => c === ' ' || c === '\t';
  const isWordChar = (c) => c !== undefined && /[A-Za-z0-9_]/.test(c);

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

  /** The opener that the text before the caret ends in (trailing spaces ignored), or ''. */
  function openerBefore(text, ls, start, lang) {
    let e = start;
    while (e > ls && isWs(text[e - 1])) e -= 1;
    for (const o of lang.openers) {
      if (e - o.length < ls || text.slice(e - o.length, e) !== o) continue;
      if (/^[a-z]+$/.test(o) && isWordChar(text[e - o.length - 1])) continue; // `redo` is not `do`
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
    if (removed.every((n) => n === 0)) return null;
    const insert = lines.map((l, i) => text.slice(l.ls + removed[i], l.le)).join('\n');
    // A position inside a removed indentation goes to the start of its line, never before it.
    const shiftPos = (p) => p - lines.reduce((sum, l, i) => sum + Math.min(removed[i], Math.max(0, p - l.ls)), 0);
    return { start: first, end: lines[lines.length - 1].le, insert, selStart: shiftPos(start), selEnd: shiftPos(end) };
  }

  function tab(text, start, end, id, shift) {
    const lang = check(text, start, end, id);
    if (!lang) return null;
    if (shift) return dedentLines(text, start, end, lang);
    const nl = text.indexOf('\n', start);
    if (nl !== -1 && nl < end) return indentLines(text, start, end, lang);
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
