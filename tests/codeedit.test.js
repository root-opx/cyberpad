'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/core/codeedit.js');
const store = require('../js/core/store.js');

// Text is written with markers: ¦ is the caret, « and » are the selection ends.
function parse(marked) {
  let text = '';
  let start = -1;
  let end = -1;
  for (const ch of marked) {
    if (ch === '¦') { start = text.length; end = start; } else if (ch === '«') start = text.length;
    else if (ch === '»') end = text.length;
    else text += ch;
  }
  assert.ok(start >= 0 && end >= start, `bad markers in ${JSON.stringify(marked)}`);
  return { text, start, end };
}
const render = (text, s, e) => (s === e ? text.slice(0, s) + '¦' + text.slice(s) : text.slice(0, s) + '«' + text.slice(s, e) + '»' + text.slice(e));

/** Applies a result to the text; returns the new text with markers, or null when the result is null. */
function apply(text, r) {
  if (r === null) return null;
  const next = text.slice(0, r.start) + r.insert + text.slice(r.end);
  assert.ok(r.selStart >= 0 && r.selStart <= r.selEnd && r.selEnd <= next.length, 'selection outside the new text');
  return render(next, r.selStart, r.selEnd);
}
const run = (fn, marked, ...args) => {
  const { text, start, end } = parse(marked);
  return apply(text, fn(text, start, end, ...args));
};
const enter = (marked, id) => run(C.enter, marked, id);
const tab = (marked, id, shift = false) => run(C.tab, marked, id, shift);
const back = (marked, id) => run(C.backspace, marked, id);
const closer = (marked, id, typed) => run(C.closer, marked, id, typed);

// A table of [before, after] pairs for one rule and one language.
const table = (name, id, fn, rows) => {
  for (const [before, after] of rows) {
    test(`${name} (${id}): ${JSON.stringify(before)} gives ${JSON.stringify(after)}`, () => {
      assert.equal(fn(before, id), after);
    });
  }
};

// ---- the table of languages ----

test('LANGUAGES ids equal store.LANGS in the same order', () => {
  assert.deepEqual(C.LANGUAGES.map((l) => l.id), [...store.LANGS]);
});

test('LANGUAGES: the array and every entry and its lists are frozen; units are valid', () => {
  assert.equal(Object.isFrozen(C.LANGUAGES), true);
  for (const l of C.LANGUAGES) {
    assert.equal(Object.isFrozen(l), true, l.id);
    assert.equal(Object.isFrozen(l.openers), true, l.id);
    assert.equal(Object.isFrozen(l.closers), true, l.id);
    assert.ok(['  ', '    ', '\t'].includes(l.unit), l.id);
    assert.equal(typeof l.name, 'string');
  }
});

test('LANGUAGES: the spec table, row by row', () => {
  const row = (l) => [l.id, l.name, l.unit, l.openers.join(' '), l.closers.join(' ')];
  assert.deepEqual(C.LANGUAGES.map(row), [
    ['bash', 'Bash', '  ', 'then do else { (', '} )'],
    ['c', 'C', '    ', '{ ( [', '} ) ]'],
    ['cpp', 'C++', '    ', '{ ( [', '} ) ]'],
    ['csharp', 'C#', '    ', '{ ( [', '} ) ]'],
    ['css', 'CSS', '  ', '{', '}'],
    ['go', 'Go', '\t', '{ ( [', '} ) ]'],
    ['html', 'HTML', '  ', '', ''],
    ['java', 'Java', '    ', '{ ( [', '} ) ]'],
    ['javascript', 'JavaScript', '  ', '{ ( [', '} ) ]'],
    ['json', 'JSON', '  ', '{ [', '} ]'],
    ['powershell', 'PowerShell', '    ', '{ (', '} )'],
    ['python', 'Python', '    ', ':', ''],
    ['rust', 'Rust', '    ', '{ ( [', '} ) ]'],
    ['sql', 'SQL', '    ', '(', ')'],
    ['typescript', 'TypeScript', '  ', '{ ( [', '} ) ]'],
    ['yaml', 'YAML', '  ', ':', ''],
  ]);
});

test('language() returns the entry for each id and null for hostile ids', () => {
  for (const id of store.LANGS) assert.equal(C.language(id).id, id);
  for (const id of ['__proto__', 'constructor', 'toString', 'Python', 'PYTHON', ' python', '', null, undefined, 5, {}, [], ['python']]) {
    assert.equal(C.language(id), null, JSON.stringify(id));
  }
});

test('hostile ids give null from all four functions', () => {
  for (const id of ['__proto__', 'constructor', 'Python', '', null, 5, undefined, {}]) {
    assert.equal(C.enter('a:', 2, 2, id), null);
    assert.equal(C.tab('a', 0, 0, id, false), null);
    assert.equal(C.tab('    a', 0, 0, id, true), null);
    assert.equal(C.backspace('    ', 4, 4, id), null);
    assert.equal(C.closer('    ', 4, 4, id, '}'), null);
  }
});

test('bad arguments give null and never throw', () => {
  const bad = [
    ['not a string', [null, 0, 0]], ['number text', [5, 0, 0]], ['undefined text', [undefined, 0, 0]],
    ['NaN', ['ab', NaN, 1]], ['fraction', ['ab', 0.5, 1]], ['string pos', ['ab', '0', '1']], ['negative', ['ab', -1, 0]],
    ['past the end', ['ab', 0, 3]], ['start past the end', ['ab', 3, 3]], ['start > end', ['ab', 2, 1]], ['Infinity', ['ab', 0, Infinity]],
    ['missing', ['ab']],
  ];
  for (const [name, args] of bad) {
    const [t, s, e] = args;
    assert.equal(C.enter(t, s, e, 'javascript'), null, name);
    assert.equal(C.tab(t, s, e, 'javascript', false), null, name);
    assert.equal(C.tab(t, s, e, 'javascript', true), null, name);
    assert.equal(C.backspace(t, s, e, 'python'), null, name);
    assert.equal(C.closer(t, s, e, 'javascript', '}'), null, name);
  }
});

// ---- Enter ----

const enterRows = {
  python: [
    ['x = 1¦', 'x = 1\n¦'],
    ['if x:¦', 'if x:\n    ¦'],
    ['if x:   ¦', 'if x:   \n    ¦'],
    ['    if x:¦', '    if x:\n        ¦'],
    ['    y = 1¦', '    y = 1\n    ¦'],
    ['    foo(a,¦ b)', '    foo(a,\n    ¦ b)'],
    ['if x:¦ y', 'if x:\n    ¦ y'],
    ['¦', '\n¦'],
    ['¦x', '\n¦x'],
    ['{¦}', '{\n¦}'], // no closer pairing in Python, and no opener either
    ['a: b¦', 'a: b\n¦'],
  ],
  javascript: [
    ['const a = 1;¦', 'const a = 1;\n¦'],
    ['if (x) {¦', 'if (x) {\n  ¦'],
    ['if (x) {  ¦', 'if (x) {  \n  ¦'],
    ['  if (x) {¦', '  if (x) {\n    ¦'],
    ['  foo(¦', '  foo(\n    ¦'],
    ['  const a = [¦', '  const a = [\n    ¦'],
    ['  {¦}', '  {\n    ¦\n  }'],
    ['  foo(¦)', '  foo(\n    ¦\n  )'],
    ['  [¦]', '  [\n    ¦\n  ]'],
    ['  {¦)', '  {\n    ¦)'], // not the matching closer
    ['  {¦ }', '  {\n    ¦ }'], // the closer must follow at once
    ['a{b¦c}', 'a{b\n¦c}'], // not right after an opener
    ['if (a) { x¦ }', 'if (a) { x\n¦ }'],
    ['x = {¦}', 'x = {\n  ¦\n}'],
  ],
  go: [
    ['func main() {¦', 'func main() {\n\t¦'],
    ['\tif x {¦', '\tif x {\n\t\t¦'],
    ['\tfoo()¦', '\tfoo()\n\t¦'],
    ['\tx := []int{¦}', '\tx := []int{\n\t\t¦\n\t}'],
    ['\t  x¦', '\t  x\n\t  ¦'], // mixed whitespace is copied as it is
  ],
  bash: [
    ['if [ -f a ]; then¦', 'if [ -f a ]; then\n  ¦'],
    ['if x; then   ¦', 'if x; then   \n  ¦'],
    ['for i in a b; do¦', 'for i in a b; do\n  ¦'],
    ['else¦', 'else\n  ¦'],
    ['  else¦', '  else\n    ¦'],
    ['f() {¦', 'f() {\n  ¦'],
    ['f() {¦}', 'f() {\n  ¦\n}'],
    ['x=(¦)', 'x=(\n  ¦\n)'],
    ['redo¦', 'redo\n¦'],
    ['done¦', 'done\n¦'],
    ['undo¦', 'undo\n¦'],
    ['elsewhere¦', 'elsewhere\n¦'],
    ['echo do_it¦', 'echo do_it\n¦'],
    ['x=1; do¦', 'x=1; do\n  ¦'],
    ['then¦', 'then\n  ¦'],
    ['a;then¦', 'a;then\n  ¦'],
    ['  fi¦', '  fi\n  ¦'],
    ['[ x ]¦', '[ x ]\n¦'], // [ is not an opener in Bash
  ],
};
for (const [id, rows] of Object.entries(enterRows)) table('Enter', id, enter, rows);

test('Enter in the middle of a line splits it and keeps the indent', () => {
  assert.equal(enter('    foo(¦bar)', 'python'), '    foo(\n    ¦bar)');
  assert.equal(enter('  a = ¦b + c', 'javascript'), '  a = \n  ¦b + c');
});

test('Enter with the caret inside the indentation copies only the whitespace left of the caret', () => {
  assert.equal(enter('  ¦  x', 'python'), '  \n  ¦  x');
  assert.equal(enter('¦    x', 'python'), '\n¦    x');
});

test('Enter on a whitespace-only line keeps that whitespace and adds no indent', () => {
  assert.equal(enter('    ¦', 'python'), '    \n    ¦');
});

test('Enter on a later line looks only at its own line', () => {
  assert.equal(enter('if x:\n    y = 1¦', 'python'), 'if x:\n    y = 1\n    ¦');
  assert.equal(enter('def f():\n    if x:¦', 'python'), 'def f():\n    if x:\n        ¦');
});

test('Enter with a selection inside one line replaces it (opener rule uses the text before the selection)', () => {
  assert.equal(enter('  foo(«abc»)', 'javascript'), '  foo(\n    ¦\n  )'); // the selection is gone, so ")" follows
  assert.equal(enter('  a «b c» d', 'javascript'), '  a \n  ¦ d');
});

test('Enter with a selection across lines replaces it and takes the indent from the line of the selection start', () => {
  assert.equal(enter('    a«bc\n  de»f', 'python'), '    a\n    ¦f');
  assert.equal(enter('if x:«\nfoo\nbar»', 'python'), 'if x:\n    ¦');
  assert.equal(enter('  f(«\n  a\n  »)', 'javascript'), '  f(\n    ¦\n  )');
});

test('Enter with the whole text selected replaces it all', () => {
  assert.equal(enter('«a\nb»', 'python'), '\n¦');
});

test('Enter in an empty text', () => {
  assert.equal(enter('¦', 'javascript'), '\n¦');
});

test('Enter for HTML and JSON: no opener for HTML, brace and bracket for JSON', () => {
  assert.equal(enter('<div>¦', 'html'), '<div>\n¦');
  assert.equal(enter('  <div>¦', 'html'), '  <div>\n  ¦');
  assert.equal(enter('{¦}', 'json'), '{\n  ¦\n}');
  assert.equal(enter('  "a": [¦', 'json'), '  "a": [\n    ¦');
  assert.equal(enter('(¦', 'json'), '(\n¦');
});

test('Enter for YAML adds an indent after a colon', () => {
  assert.equal(enter('key:¦', 'yaml'), 'key:\n  ¦');
  assert.equal(enter('  key:   ¦', 'yaml'), '  key:   \n    ¦');
});

test('Enter for SQL, CSS, Rust and PowerShell follow their tables', () => {
  assert.equal(enter('SELECT (¦)', 'sql'), 'SELECT (\n    ¦\n)');
  assert.equal(enter('a {¦}', 'css'), 'a {\n  ¦\n}');
  assert.equal(enter('fn f() {¦}', 'rust'), 'fn f() {\n    ¦\n}');
  assert.equal(enter('if ($x) {¦', 'powershell'), 'if ($x) {\n    ¦');
  assert.equal(enter('x[¦', 'powershell'), 'x[\n¦'); // [ is not a PowerShell opener
});

test('Enter with CRLF text: a \\r after the caret stays where it is; a \\r before the caret is not an opener', () => {
  const t = 'if x:\r\n  y';
  const r = C.enter(t, 5, 5, 'python');
  assert.equal(apply(t, r), 'if x:\n    ¦\r\n  y');
  // The caret between the \r and the \n: the text before it ends in \r, which is not an opener.
  assert.equal(enter('if x:\r¦\ny', 'python'), 'if x:\r\n¦\ny');
  // Leading whitespace on a CRLF line is copied without the \r of the previous line.
  assert.equal(enter('  a\r\n  b¦', 'python'), '  a\r\n  b\n  ¦');
});

test('Enter: one result shape, selection collapsed at the end of the indented middle line', () => {
  const t = '  {}';
  assert.deepEqual(C.enter(t, 3, 3, 'javascript'), { start: 3, end: 3, insert: '\n    \n  ', selStart: 8, selEnd: 8 });
});

test('Enter with a tab character in Go copies it, and a tab-indented JavaScript line copies its tabs', () => {
  assert.equal(enter('\t\tx¦', 'javascript'), '\t\tx\n\t\t¦');
  assert.equal(enter('\tif (x) {¦', 'javascript'), '\tif (x) {\n\t  ¦');
});

// ---- Tab ----

test('Tab with a 4-space unit at columns 0, 1, 3 and 4 inserts up to the next stop', () => {
  assert.equal(tab('¦abc', 'python'), '    ¦abc');
  assert.equal(tab('a¦bc', 'python'), 'a   ¦bc');
  assert.equal(tab('abc¦', 'python'), 'abc ¦');
  assert.equal(tab('abcd¦', 'python'), 'abcd    ¦');
  assert.equal(tab('abcde¦', 'python'), 'abcde   ¦');
});

test('Tab with a 2-space unit', () => {
  assert.equal(tab('¦a', 'javascript'), '  ¦a');
  assert.equal(tab('a¦', 'javascript'), 'a ¦');
  assert.equal(tab('ab¦', 'javascript'), 'ab  ¦');
});

test('Tab counts the column from the start of its own line', () => {
  assert.equal(tab('abcdef\nx¦', 'python'), 'abcdef\nx   ¦');
  assert.equal(tab('abcdef\n¦', 'python'), 'abcdef\n    ¦');
});

test('Tab inserts one tab character for Go, wherever the caret is', () => {
  assert.equal(tab('¦a', 'go'), '\t¦a');
  assert.equal(tab('abc¦', 'go'), 'abc\t¦');
  assert.equal(tab('\tx¦', 'go'), '\tx\t¦');
});

test('Tab with a tab character in the leading whitespace of a 4-space language counts it as advancing to the next stop', () => {
  assert.equal(tab('\t¦x', 'python'), '\t    ¦x'); // a tab is column 4, so a full unit
  assert.equal(tab(' \t¦x', 'python'), ' \t    ¦x'); // space then tab is still column 4
  assert.equal(tab('  \t  ¦x', 'python'), '  \t    ¦x'); // column 6 -> stop 8: two spaces
  assert.equal(tab('\t \t¦', 'javascript'), '\t \t  ¦'); // 2-space unit: tab=2, space=3, tab=4 -> two more
});

test('Tab with an empty text', () => {
  assert.equal(tab('¦', 'python'), '    ¦');
  assert.equal(tab('¦', 'go'), '\t¦');
});

test('Tab with a selection inside one line replaces it with spaces up to the next stop from the selection start', () => {
  assert.equal(tab('ab«cd»ef', 'python'), 'ab  ¦ef');
  assert.equal(tab('x = «1»', 'javascript'), 'x =   ¦'); // column 4 is a stop: a full unit
  assert.equal(tab('a«bc»d', 'go'), 'a\t¦d');
});

test('Tab on a three-line selection indents each line by one unit and keeps the lines selected', () => {
  assert.equal(tab('«a\nb\nc»', 'python'), '    «a\n    b\n    c»');
  assert.equal(tab('x\n«a\n  b\nc»\ny', 'python'), 'x\n    «a\n      b\n    c»\ny');
  assert.equal(tab('«a\nb\nc»', 'javascript'), '  «a\n  b\n  c»');
  assert.equal(tab('«a\nb\nc»', 'go'), '\t«a\n\tb\n\tc»');
});

test('Tab on a multi-line selection that starts or ends mid-line indents the whole lines and shifts the selection', () => {
  assert.equal(tab('ab«c\nde»f', 'python'), '    ab«c\n    de»f');
});

test('Tab: a line the selection only ends at column 0 of is not touched', () => {
  assert.equal(tab('«a\nb\n»c', 'python'), '    «a\n    b\n»c');
  assert.equal(tab('«a\n»b', 'python'), '    «a\n»b');
});

test('Tab: a selection that starts at the end of a line also touches that line', () => {
  assert.equal(tab('a«\nb»', 'python'), '    a«\n    b»');
});

test('Tab on several lines leaves empty lines empty', () => {
  assert.equal(tab('«a\n\nb»', 'python'), '    «a\n\n    b»');
  assert.equal(tab('«a\r\n\r\nb»', 'python'), '    «a\r\n\r\n    b»');
});

test('Tab on a selection of the whole text', () => {
  assert.equal(tab('«a\nb»', 'python'), '    «a\n    b»');
  assert.equal(tab('«a»', 'python'), '    «a»'); // the whole line selected: indented, not replaced
  assert.equal(tab('«\n»', 'python'), '«\n»'); // only empty lines: nothing to indent
});

test('Tab on a multi-line CRLF selection keeps every \\r where it is', () => {
  const t = 'a\r\nb\r\nc';
  const r = C.tab(t, 0, t.length, 'python', false);
  assert.equal(t.slice(0, r.start) + r.insert + t.slice(r.end), '    a\r\n    b\r\n    c');
});

// ---- Shift+Tab ----

test('Shift+Tab removes one unit from the current line and keeps the caret on its text', () => {
  assert.equal(tab('    a¦b', 'python', true), 'a¦b');
  assert.equal(tab('        a¦', 'python', true), '    a¦');
  assert.equal(tab('    ¦a', 'python', true), '¦a');
  assert.equal(tab('x\n    a¦\ny', 'python', true), 'x\na¦\ny');
  assert.equal(tab('    a¦', 'javascript', true), '  a¦');
});

test('Shift+Tab with fewer spaces than one unit removes what there is', () => {
  assert.equal(tab('  a¦', 'python', true), 'a¦');
  assert.equal(tab(' a¦', 'python', true), 'a¦');
  assert.equal(tab(' a¦', 'javascript', true), 'a¦');
});

test('Shift+Tab removes a leading tab (one only) in a space-unit language', () => {
  assert.equal(tab('\ta¦', 'python', true), 'a¦');
  assert.equal(tab('\t\ta¦', 'python', true), '\ta¦');
  assert.equal(tab('\t    a¦', 'python', true), '    a¦'); // a tab first: only the tab goes
});

test('Shift+Tab in Go removes one tab, or up to four leading spaces', () => {
  assert.equal(tab('\t\ta¦', 'go', true), '\ta¦');
  assert.equal(tab('        a¦', 'go', true), '    a¦');
  assert.equal(tab('  a¦', 'go', true), 'a¦');
  assert.equal(tab('      a¦', 'go', true), '  a¦');
});

test('Shift+Tab with nothing to remove is handled as a no-op, so focus never leaves the editor', () => {
  assert.equal(tab('a¦', 'python', true), 'a¦');
  assert.equal(tab('¦', 'python', true), '¦');
  assert.equal(tab('«a\nb»', 'python', true), '«a\nb»');
  assert.deepEqual(C.tab('ab', 1, 2, 'python', true), { start: 1, end: 1, insert: '', selStart: 1, selEnd: 2 });
  assert.equal(tab('x\n  ¦a', 'go', true), 'x\n¦a'); // not null: two spaces are removable in Go
  assert.equal(tab('a ¦b', 'python', true), 'a ¦b'); // the space is not leading
});

test('Shift+Tab with the caret inside the indentation being removed clamps it to the line start', () => {
  assert.equal(tab('  ¦  a', 'python', true), '¦a');
  assert.equal(tab('¦    a', 'python', true), '¦a');
  assert.equal(tab(' ¦   a', 'python', true), '¦a');
  assert.equal(tab('x\n   ¦ a', 'python', true), 'x\n¦a');
  assert.equal(tab('  ¦        a', 'python', true), '¦      a'); // clamped to the line start, not left of it
});

test('Shift+Tab with a selection clamps both ends and keeps the rest', () => {
  assert.equal(tab('    «a\n    b»', 'python', true), '«a\nb»');
  assert.equal(tab('«  a\n    b»', 'python', true), '«a\nb»');
  assert.equal(tab('  «  a  »b', 'python', true), '«a  »b');
});

test('Shift+Tab undoes Tab exactly on a three-line selection, text and selection', () => {
  for (const id of ['python', 'javascript', 'go', 'bash']) {
    for (const before of ['«a\nb\nc»', 'x\n«a\n  b\nc»\ny', 'a«b\ncd\nef»g', '«a\n\nc»']) {
      assert.equal(tab(tab(before, id), id, true), before, `${id} ${JSON.stringify(before)}`);
    }
  }
});

test('Shift+Tab on several lines dedents each by its own amount', () => {
  assert.equal(tab('«      a\n  b\nc\n\td»', 'python', true), '«  a\nb\nc\nd»');
});

test('Shift+Tab does not touch a line the selection only reaches at column 0', () => {
  assert.equal(tab('«    a\n»    b', 'python', true), '«a\n»    b');
});

test('Shift+Tab with CRLF text keeps every \\r', () => {
  const t = '    a\r\n    b\r\n';
  const r = C.tab(t, 0, t.length, 'python', true);
  assert.equal(t.slice(0, r.start) + r.insert + t.slice(r.end), 'a\r\nb\r\n');
});

test('Tab result shapes', () => {
  assert.deepEqual(C.tab('ab', 1, 1, 'python', false), { start: 1, end: 1, insert: '   ', selStart: 4, selEnd: 4 });
  assert.deepEqual(C.tab('a\nb', 0, 3, 'python', false), { start: 0, end: 3, insert: '    a\n    b', selStart: 4, selEnd: 11 });
  assert.deepEqual(C.tab('  a', 2, 2, 'python', true), { start: 0, end: 3, insert: 'a', selStart: 0, selEnd: 0 });
});

// ---- Backspace ----

const backRows = {
  python: [
    ['    ¦', '¦'],
    ['        ¦', '    ¦'],
    ['      ¦', '    ¦'], // between stops: back to the previous one
    ['     ¦', '    ¦'],
    ['   ¦', '¦'],
    [' ¦', '¦'],
    ['x\n    ¦', 'x\n¦'],
    ['    ¦abc', '¦abc'],
    ['     ¦abc', '    ¦abc'],
  ],
  javascript: [
    ['  ¦', '¦'],
    ['    ¦', '  ¦'],
    ['   ¦', '  ¦'],
    ['     ¦x', '    ¦x'],
  ],
  bash: [
    ['  ¦', '¦'],
    ['      ¦', '    ¦'],
    ['   ¦', '  ¦'],
  ],
};
for (const [id, rows] of Object.entries(backRows)) table('Backspace', id, back, rows);

test('Backspace after text, at the start of a line, with a selection, or with a tab in the indent is left to the browser', () => {
  for (const id of ['python', 'javascript', 'bash']) {
    assert.equal(back('    a¦', id), null);
    assert.equal(back('    ab ¦', id), null);
    assert.equal(back('¦', id), null);
    assert.equal(back('¦    ', id), null);
    assert.equal(back('x\n¦', id), null);
    assert.equal(back('  «  »', id), null);
    assert.equal(back('«    »', id), null);
    assert.equal(back('\t¦', id), null);
    assert.equal(back('  \t  ¦', id), null);
  }
});

test('Backspace never acts in a tab-unit language (Go)', () => {
  assert.equal(back('\t¦', 'go'), null);
  assert.equal(back('    ¦', 'go'), null);
});

test('Backspace with CRLF text looks only at its own line', () => {
  assert.equal(back('a\r\n    ¦', 'python'), 'a\r\n¦');
  assert.equal(back('a\r¦\n', 'python'), null); // after the \r, which is not a space
});

test('Backspace result shape', () => {
  assert.deepEqual(C.backspace('x\n      ', 8, 8, 'python'), { start: 6, end: 8, insert: '', selStart: 6, selEnd: 6 });
});

// ---- A typed closer ----

const closerRows = {
  javascript: [
    ['  ¦', '}¦', '}'],
    ['    ¦', '  }¦', '}'],
    ['      ¦', '    )¦', ')'],
    ['x\n    ¦', 'x\n  ]¦', ']'],
    ['¦', '}¦', '}'],
    [' ¦', '}¦', '}'], // shorter than one unit: what there is is removed
    ['    ¦  ', '  }¦  ', '}'], // more whitespace after the caret stays
  ],
  python: [],
  go: [
    ['\t\t¦', '\t}¦', '}'],
    ['\t¦', '}¦', '}'],
    ['    ¦', '}¦', '}'], // up to four spaces count as one unit
    ['  ¦', '}¦', '}'],
    ['      ¦', '  }¦', '}'],
  ],
  bash: [
    ['    ¦', '  }¦', '}'],
    ['    ¦', '  )¦', ')'],
  ],
};
for (const [id, rows] of Object.entries(closerRows)) {
  for (const [before, after, typed] of rows) {
    test(`closer (${id}): typing ${typed} in ${JSON.stringify(before)} gives ${JSON.stringify(after)}`, () => {
      assert.equal(closer(before, id, typed), after);
    });
  }
}

test('a closer on a line with text, or with text after the caret, or with a selection, is left to the browser', () => {
  for (const id of ['javascript', 'go', 'bash', 'c']) {
    assert.equal(closer('  a¦', id, '}'), null);
    assert.equal(closer('  ¦a', id, '}'), null);
    assert.equal(closer('  ¦ a', id, '}'), null);
    assert.equal(closer('  «  »', id, '}'), null);
    assert.notEqual(closer('x\n  ¦', id, '}'), null); // an earlier line does not matter
  }
});

test('a closer for a language without closers (Python, YAML, HTML) is never handled', () => {
  for (const id of ['python', 'yaml', 'html']) {
    for (const ch of ['}', ')', ']']) assert.equal(closer('    ¦', id, ch), null);
  }
});

test('a character that is not one of the language\'s closers is never handled', () => {
  assert.equal(closer('    ¦', 'bash', ']'), null); // Bash has } and ) only
  assert.equal(closer('    ¦', 'css', ')'), null);
  assert.equal(closer('    ¦', 'sql', '}'), null);
  assert.equal(closer('    ¦', 'json', ')'), null);
  assert.equal(closer('    ¦', 'javascript', 'a'), null);
  assert.equal(closer('    ¦', 'javascript', ''), null);
  assert.equal(closer('    ¦', 'javascript', '}}'), null);
  assert.equal(closer('    ¦', 'javascript', null), null);
  assert.equal(closer('    ¦', 'javascript', 5), null);
  assert.equal(closer('    ¦', 'javascript'), null);
});

test('a closer on a whitespace-only line with a tab: one tab goes in a space-unit language', () => {
  assert.equal(closer('\t\t¦', 'javascript', '}'), '\t}¦');
});

test('a closer with CRLF text: the \\r ends the line and is not text', () => {
  assert.equal(closer('a\r\n    ¦\r\nb', 'javascript', '}'), 'a\r\n  }¦\r\nb');
});

test('a closer with a selection spanning the whole text is not handled', () => {
  assert.equal(closer('«    »', 'javascript', '}'), null);
});

test('closer result shape', () => {
  assert.deepEqual(C.closer('a\n    ', 6, 6, 'javascript', '}'), { start: 2, end: 6, insert: '  }', selStart: 5, selEnd: 5 });
});

// ---- the fixed examples from the spec, per language ----

test('every language with openers: Enter after its first opener indents by its unit; HTML never does', () => {
  for (const l of C.LANGUAGES) {
    for (const o of l.openers) {
      const text = `x ${o}`;
      const r = C.enter(text, text.length, text.length, l.id);
      assert.equal(r.insert, '\n' + l.unit, `${l.id} ${o}`);
    }
    const none = C.enter('x', 1, 1, l.id);
    assert.equal(none.insert, '\n', l.id);
  }
});

// ---- review round 1 ----

test('Tab with the whole line selected from column 0 indents the line and keeps its text', () => {
  assert.equal(tab('«abcd»', 'python'), '    «abcd»');
  assert.equal(tab('x\n«abcd»\ny', 'go'), 'x\n\t«abcd»\ny');
  assert.equal(tab('«abcd»\r\nz', 'python'), '    «abcd»\r\nz');
});

test('Tab with a line selected from its first non-blank to its end indents the line', () => {
  assert.equal(tab('  «abcd»', 'python'), '      «abcd»');
  assert.equal(tab('«  abcd»', 'python'), '    «  abcd»');
});

test('Tab with a partial selection inside one line still replaces it with spaces', () => {
  assert.equal(tab('«abc»d', 'python'), '    ¦d'); // from column 0 but not to the end of the line
  assert.equal(tab('a«bcd»', 'python'), 'a   ¦'); // not from the first character
  assert.equal(tab('ab«c»d', 'python'), 'ab  ¦d');
});

test('positions that split a surrogate pair give null from all four functions', () => {
  const t = '  \u{1F600}  ';
  const mid = 3; // between the two halves
  for (const [s, e] of [[mid, mid], [0, mid], [mid, t.length]]) {
    assert.equal(C.enter(t, s, e, 'javascript'), null);
    assert.equal(C.tab(t, s, e, 'javascript', false), null);
    assert.equal(C.tab(t, s, e, 'javascript', true), null);
    assert.equal(C.backspace(t, s, e, 'javascript'), null);
    assert.equal(C.closer(t, s, e, 'javascript', '}'), null);
  }
  assert.ok(C.enter(t, 2, 2, 'javascript'));
  assert.ok(C.enter(t, 4, 4, 'javascript'));
  assert.equal(enter('😀 {¦}', 'javascript'), '😀 {\n  ¦\n}');
});

test('tab: shift must be a boolean or undefined; anything else gives null', () => {
  assert.ok(C.tab('  a', 2, 2, 'python', undefined));
  assert.ok(C.tab('  a', 2, 2, 'python', false));
  assert.ok(C.tab('  a', 2, 2, 'python', true));
  for (const s of [1, 0, 'true', null, {}, []]) assert.equal(C.tab('  a', 2, 2, 'python', s), null, JSON.stringify(s));
});

const commentRows = [
  ['python', 'if x:  # check¦', 'if x:  # check\n    ¦'],
  ['python', '# if x:¦', '# if x:\n¦'],
  ['python', 'x = "#"¦', 'x = "#"\n¦'],
  ['python', 'x = "#":¦', 'x = "#":\n    ¦'],
  ['python', 'x = "a # b":¦', 'x = "a # b":\n    ¦'],
  ['python', 'f(a#b:¦', 'f(a#b:\n    ¦'], // a # not after whitespace is no comment; the colon still opens
  ['javascript', 'if (x) { // c¦', 'if (x) { // c\n  ¦'],
  ['javascript', 'if (x) { /* c */¦', 'if (x) { /* c */\n  ¦'],
  ['javascript', 'if (x) { /* c */  ¦', 'if (x) { /* c */  \n  ¦'],
  ['javascript', 'x = 1; // {¦', 'x = 1; // {\n¦'],
  ['javascript', 'url = "http://x"¦', 'url = "http://x"\n¦'],
  ['javascript', 'url = "http://x" + f(¦', 'url = "http://x" + f(\n  ¦'],
  ['javascript', 'a /* x */ b /* y */¦', 'a /* x */ b /* y */\n¦'],
  ['javascript', 'a /* x */ b {¦', 'a /* x */ b {\n  ¦'],
  ['javascript', 'a { /* x */ y /* z */¦', 'a { /* x */ y /* z */\n¦'],
  ['css', 'a { /* c */¦', 'a { /* c */\n  ¦'],
  ['css', 'a { // not a comment¦', 'a { // not a comment\n¦'],
  ['c', 'int f() { // c¦', 'int f() { // c\n    ¦'],
  ['go', 'func f() { // c¦', 'func f() { // c\n\t¦'],
  ['sql', 'SELECT ( -- c¦', 'SELECT ( -- c\n    ¦'],
  ['bash', 'if x; then # c¦', 'if x; then # c\n  ¦'],
  ['bash', 'echo ok # then¦', 'echo ok # then\n¦'],
  ['powershell', 'if ($x) { # c¦', 'if ($x) { # c\n    ¦'],
  ['yaml', 'key: # c¦', 'key: # c\n  ¦'],
  ['yaml', 'key: "a # b":¦', 'key: "a # b":\n  ¦'],
];
for (const [id, before, after] of commentRows) {
  test(`Enter (${id}) ignores a trailing comment: ${JSON.stringify(before)}`, () => {
    assert.equal(enter(before, id), after);
  });
}

test('Enter with an apostrophe or an odd number of quotes does not strip, and never throws', () => {
  assert.equal(enter("echo don't # then¦", 'bash'), "echo don't # then\n  ¦"); // odd ': not stripped, so it ends in then
  assert.equal(enter('x = "a // b {¦', 'javascript'), 'x = "a // b {\n  ¦');
});

test('Bash word openers must be whole shell words', () => {
  for (const [before, after] of [
    ['echo $do¦', 'echo $do\n¦'], ['cd /tmp/then¦', 'cd /tmp/then\n¦'], ['redo¦', 'redo\n¦'], ['done¦', 'done\n¦'],
    ['x-else¦', 'x-else\n¦'], ['# do¦', '# do\n¦'],
    ['if x; then¦', 'if x; then\n  ¦'], ['while true; do¦', 'while true; do\n  ¦'], ['do¦', 'do\n  ¦'], ['\telse¦', '\telse\n\t  ¦'],
  ]) assert.equal(enter(before, 'bash'), after, before);
});

test('YAML block scalar headers indent the next line', () => {
  for (const h of ['|', '>', '|-', '>-', '|+', '>+']) {
    assert.equal(enter(`run: ${h}¦`, 'yaml'), `run: ${h}\n  ¦`, h);
  }
  assert.equal(enter('  run: |  ¦', 'yaml'), '  run: |  \n    ¦');
  assert.equal(enter('- |¦', 'yaml'), '- |\n  ¦');
  assert.equal(enter('x: a|¦', 'yaml'), 'x: a|\n¦');
  assert.equal(enter('x: a>¦', 'yaml'), 'x: a>\n¦');
  assert.equal(enter('run: |¦', 'python'), 'run: |\n¦');
});

test('Enter on a whitespace-only line keeps the indentation for the new line and leaves the old line whitespace as it is', () => {
  const t = '    ';
  const r = C.enter(t, 4, 4, 'python');
  assert.equal(t.slice(0, r.start) + r.insert + t.slice(r.end), '    \n    ');
});

test('Enter does its comment stripping on its own line only (a 200,000-char line stays quick)', () => {
  const t = 'x = "' + '#'.repeat(200000);
  const t0 = process.hrtime.bigint();
  C.enter(t, t.length, t.length, 'python');
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 100);
});

// ---- cost ----

test('Enter on a 200,000-line text with the caret near the end returns quickly (it does not scan the whole text)', () => {
  const lines = [];
  for (let i = 0; i < 200000; i += 1) lines.push(i % 3 === 0 ? '    value = compute(i):' : '    x');
  lines[lines.length - 3] = '    if ready:';
  const text = lines.join('\n');
  const caret = text.length - lines[lines.length - 1].length - lines[lines.length - 2].length - 2;
  const t0 = process.hrtime.bigint();
  let r;
  for (let i = 0; i < 20; i += 1) r = C.enter(text, caret, caret, 'python');
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 20;
  assert.ok(r && r.insert.startsWith('\n'), 'a result');
  assert.ok(ms < 50, `took ${ms} ms`);
  const t1 = process.hrtime.bigint();
  C.tab(text, caret, caret, 'python', false);
  C.tab(text, caret, caret, 'python', true);
  C.backspace(text, caret, caret, 'python');
  C.closer(text, caret, caret, 'javascript', '}');
  assert.ok(Number(process.hrtime.bigint() - t1) / 1e6 < 50, 'the others are quick too');
});
