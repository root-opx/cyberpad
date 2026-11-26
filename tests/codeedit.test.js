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
    ['batch', 'Batch', '    ', '(', ')'],
    ['ruby', 'Ruby', '  ', 'then do else begin { ( [', '} ) ]'],
    ['php', 'PHP', '    ', '{ ( [ :', '} ) ]'],
    ['lua', 'Lua', '  ', 'then do else repeat { (', '} )'],
    ['perl', 'Perl', '    ', '{ ( [', '} ) ]'],
    ['xml', 'XML', '  ', '', ''],
    ['ini', 'INI and TOML', '  ', '', ''],
    ['plain', 'Plain text', '    ', '', ''],
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

const hostileLines = [
  ['javascript', '/*'.repeat(500000)],
  ['css', '/*' + ' '.repeat(1000000) + 'x'],
  ['rust', '/*' + ' '.repeat(1000000) + 'x'],
  ['javascript', '"'.repeat(1000000)],
  ['javascript', '/'.repeat(1000000)],
  ['python', '#'.repeat(1000000)],
  ['python', ' '.repeat(1000000)],
  ['javascript', ' '.repeat(1000000)],
];
for (const [id, t] of hostileLines) {
  test(`Enter (${id}) on a 1,000,000-char hostile line (${JSON.stringify(t.slice(0, 4))}...) takes under 100 ms`, () => {
    const t0 = process.hrtime.bigint();
    const r = C.enter(t, t.length, t.length, id);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(r && r.insert.startsWith('\n'));
    assert.ok(ms < 100, `took ${ms} ms`);
  });
}

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

// ---- the eight added languages and the comment markers ----

test('LANGUAGES: comment markers for all 24 languages', () => {
  const line = { python: '#', bash: '#', powershell: '#', yaml: '#', ruby: '#', perl: '#', ini: '#', c: '//', cpp: '//', csharp: '//', go: '//', java: '//', javascript: '//', typescript: '//', rust: '//', php: '//', sql: '--', lua: '--', batch: 'REM ' };
  const cb = ['/*', '*/'];
  const block = { css: cb, c: cb, cpp: cb, csharp: cb, go: cb, java: cb, javascript: cb, typescript: cb, rust: cb, html: ['<!--', '-->'], xml: ['<!--', '-->'] };
  assert.equal(C.LANGUAGES.length, 24);
  for (const l of C.LANGUAGES) {
    assert.equal(l.lineComment, line[l.id] === undefined ? null : line[l.id], l.id);
    assert.deepEqual(l.blockComment === null ? null : [...l.blockComment], block[l.id] || null, l.id);
    if (l.blockComment) assert.equal(Object.isFrozen(l.blockComment), true, l.id);
  }
  for (const id of ['json', 'plain']) assert.ok(C.language(id).lineComment === null && C.language(id).blockComment === null, id);
});

table('enter', 'ruby', enter, [
  ['def f¦', 'def f\n¦'],
  ['if x then¦', 'if x then\n  ¦'],
  ['x.each do¦', 'x.each do\n  ¦'],
  ['begin¦', 'begin\n  ¦'],
  ['else¦', 'else\n  ¦'],
  ['redo¦', 'redo\n¦'],
  ['h = {¦', 'h = {\n  ¦'],
  ['a = [¦]', 'a = [\n  ¦\n]'],
  ['  foo # then¦', '  foo # then\n  ¦'],
]);
table('enter', 'php', enter, [
  ['if ($a) {¦', 'if ($a) {\n    ¦'],
  ['if ($a):¦', 'if ($a):\n    ¦'],
  ['$a = [¦', '$a = [\n    ¦'],
  ['echo 1; // {¦', 'echo 1; // {\n¦'],
]);
table('enter', 'lua', enter, [
  ['if x then¦', 'if x then\n  ¦'],
  ['for i=1,2 do¦', 'for i=1,2 do\n  ¦'],
  ['repeat¦', 'repeat\n  ¦'],
  ['else¦', 'else\n  ¦'],
  ['t = {¦', 't = {\n  ¦'],
  ['x = 1 -- do¦', 'x = 1 -- do\n¦'],
  ['function f()¦', 'function f()\n¦'],
]);
table('enter', 'perl', enter, [
  ['sub f {¦', 'sub f {\n    ¦'],
  ['my @a = (¦)', 'my @a = (\n    ¦\n)'],
  ['print 1; # {¦', 'print 1; # {\n¦'],
]);
table('enter', 'batch', enter, [
  ['if x (¦', 'if x (\n    ¦'],
  ['echo hi¦', 'echo hi\n¦'],
  ['    echo (¦', '    echo (\n        ¦'],
]);
table('enter', 'xml', enter, [['<a>¦', '<a>\n¦'], ['  <a>¦', '  <a>\n  ¦']]);
table('enter', 'ini', enter, [['[sec]¦', '[sec]\n¦'], ['  k = v¦', '  k = v\n  ¦'], ['a = {¦', 'a = {\n¦']]);
table('enter', 'plain', enter, [['    hello {¦', '    hello {\n    ¦'], ['x:¦', 'x:\n¦']]);

test('closers: brackets for ruby, php, lua, perl; ) for batch; none for xml, ini, plain', () => {
  assert.equal(closer('  ¦', 'ruby', '}'), '}¦');
  assert.equal(closer('    ¦', 'php', ')'), ')¦');
  assert.equal(closer('  ¦', 'lua', '}'), '}¦');
  assert.equal(closer('    ¦', 'perl', ']'), ']¦');
  assert.equal(closer('    ¦', 'batch', ')'), ')¦');
  assert.equal(closer('    ¦', 'lua', ']'), null);
  assert.equal(closer('    ¦', 'batch', '}'), null);
  for (const id of ['xml', 'ini', 'plain']) for (const ch of ['}', ')', ']']) assert.equal(closer('    ¦', id, ch), null, `${id} ${ch}`);
});

test('units: the new languages indent with their unit on Tab', () => {
  const units = { batch: 4, ruby: 2, php: 4, lua: 2, perl: 4, xml: 2, ini: 2, plain: 4 };
  for (const [id, n] of Object.entries(units)) assert.equal(tab('¦x', id), `${' '.repeat(n)}¦x`, id);
});

// ---- toggleComment, duplicateLines, moveLines ----

const tc = (marked, id) => run(C.toggleComment, marked, id);
const dup = (marked, id = '') => run(C.duplicateLines, marked, id);
const mv = (marked, id, d) => run(C.moveLines, marked, id, d);
const applyRaw = (text, r) => text.slice(0, r.start) + r.insert + text.slice(r.end);

table('toggleComment', 'python', tc, [
  ['x = 1¦', '# x = 1¦'],
  ['«x = 1»', '# «x = 1»'],
  ['    ¦x = 1', '    # ¦x = 1'],
  ['# x = 1¦', 'x = 1¦'],
  ['#x = 1¦', 'x = 1¦'],
  ['    # x = 1¦', '    x = 1¦'],
  ['«a\nb»', '# «a\n# b»'],
  ['«a\n\nb»', '# «a\n\n# b»'],
  ['«# a\n\n# b»', '«a\n\nb»'],
  ['«# a\nb»', '# «# a\n# b»'],
  ['«    a\n  b»', '«  #   a\n  # b»'],
  ['«a\nb\n»', '# «a\n# b\n»'],
  ['a\n«b»\nc', 'a\n# «b»\nc'],
  ['¦', '¦'],
  ['  ¦  ', '  ¦  '],
  ['«\n\n»', '«\n\n»'],
]);
table('toggleComment', 'javascript', tc, [
  ['¦foo()', '// ¦foo()'],
  ['// foo()¦', 'foo()¦'],
  ['//foo¦', 'foo¦'],
  ['«a\n  b»', '// «a\n//   b»'],
  ['  «a\n  b»', '  // «a\n  // b»'],
]);
table('toggleComment', 'sql', tc, [['«select 1»', '-- «select 1»'], ['-- select 1¦', 'select 1¦'], ['--select 1¦', 'select 1¦']]);
table('toggleComment', 'lua', tc, [['x = 1¦', '-- x = 1¦'], ['-- x = 1¦', 'x = 1¦']]);
table('toggleComment', 'batch', tc, [
  ['echo hi¦', 'REM echo hi¦'],
  ['REM echo hi¦', 'echo hi¦'],
  ['rem echo hi¦', 'echo hi¦'],
  ['Rem echo hi¦', 'echo hi¦'],
  [':: echo hi¦', 'echo hi¦'],
  ['  ::x¦', '  x¦'],
  ['REM¦', '¦'],
  ['REMARK x¦', 'REM REMARK x¦'],
  ['«echo a\n  echo b»', 'REM «echo a\nREM   echo b»'],
]);
table('toggleComment', 'ini', tc, [
  ['k = v¦', '# k = v¦'],
  ['; k = v¦', 'k = v¦'],
  ['# k = v¦', 'k = v¦'],
  ['«; a\n# b»', '«a\nb»'],
  ['«; a\nb»', '# «; a\n# b»'],
]);
table('toggleComment', 'html', tc, [
  ['«<p>x</p>»', '«<!-- <p>x</p> -->»'],
  ['<!-- <p>x</p> -->¦', '<p>x</p>¦'],
  ['  ¦<p>x</p>', '  <!-- ¦<p>x</p> -->'],
  ['<p>¦x</p>', '<!-- <p>¦x</p> -->'],
  ['<!-- «x» -->', '«x»'],
  ['<!--x-->¦', 'x¦'],
  ['«a\nb»', '«<!-- a\nb -->»'],
  ['«  a  »', '«  <!-- a -->  »'],
  ['¦', '¦'],
  ['  ¦', '  ¦'],
  ['«   »', '«   »'],
]);
table('toggleComment', 'xml', tc, [['«<a/>»', '«<!-- <a/> -->»'], ['<!-- <a/> -->¦', '<a/>¦']]);
table('toggleComment', 'css', tc, [['«a{}»', '«/* a{} */»'], ['/* a{} */¦', 'a{}¦'], ['  ¦color: red;', '  /* ¦color: red; */']]);
for (const id of ['json', 'plain']) {
  table('toggleComment', id, tc, [['«a»', '«a»'], ['x¦', 'x¦'], ['«a\nb»', '«a\nb»']]);
}

test('toggleComment: a language with neither marker gives a no-op result, not null', () => {
  const r = C.toggleComment('abc', 1, 2, 'json');
  assert.deepEqual(r, { start: 1, end: 1, insert: '', selStart: 1, selEnd: 2 });
});

test('toggleComment: only the lines involved are replaced', () => {
  const text = 'one\ntwo\nthree\nfour';
  const r = C.toggleComment(text, 5, 6, 'python');
  assert.deepEqual([r.start, r.end, r.insert], [4, 7, '# two']);
  assert.equal(applyRaw(text, r), 'one\n# two\nthree\nfour');
});

test('toggleComment: CRLF text keeps its line ends and blank CRLF lines are left alone', () => {
  const text = 'a\r\n\r\nb\r\n';
  const r = C.toggleComment(text, 0, text.length - 1, 'python');
  assert.equal(applyRaw(text, r), '# a\r\n\r\n# b\r\n');
  const back = C.toggleComment('# a\r\n\r\n# b\r\n', r.selStart, r.selEnd, 'python');
  assert.equal(applyRaw('# a\r\n\r\n# b\r\n', back), text);
});

test('toggleComment: round trips restore text and selection exactly', () => {
  const samples = [
    'x = 1¦', '«x = 1»', '    ¦x', '«a\n  b»', '«a\n\nb»', '«  a\n    b»', '«\ta\n\tb»', '«a\nb\n»', '¦a\nb', 'x\n«  y\n  z»\nw',
    '«a  »', 'p\n  ¦q\nr', '«# a\nb»', '«a\n\n»', '«  \n  a\n  »', '«  a\n\n    b\n  c»', '¦', '«é😀a»',
  ];
  for (const { id } of C.LANGUAGES) {
    for (const marked of samples) {
      const { text, start, end } = parse(marked);
      const r1 = C.toggleComment(text, start, end, id);
      assert.ok(r1, `${id} ${JSON.stringify(marked)}`);
      const t1 = applyRaw(text, r1);
      const r2 = C.toggleComment(t1, r1.selStart, r1.selEnd, id);
      assert.ok(r2, `${id} ${JSON.stringify(marked)} second`);
      const t2 = applyRaw(t1, r2);
      const label = `${id} ${JSON.stringify(marked)}`;
      assert.equal(t2, text, label);
      assert.equal(r2.selStart, start, `${label} selStart`);
      assert.equal(r2.selEnd, end, `${label} selEnd`);
      if (id !== 'json' && id !== 'plain' && /\S/.test(text.replace(/[\n\r]/g, ''))) assert.notEqual(t1, text, label);
    }
  }
});

test('toggleComment: a selection ending at column 0 of the next line leaves that line alone', () => {
  for (const id of ['python', 'javascript', 'sql', 'batch', 'ini']) {
    const text = 'a\nb\nc';
    const r = C.toggleComment(text, 0, 4, id); // covers "a\nb\n"
    const out = applyRaw(text, r);
    assert.ok(out.endsWith('\nc'), id);
    assert.equal(out.split('\n').length, 3, id);
    assert.notEqual(out.split('\n')[1], 'b', id);
  }
});

test('toggleComment: hostile ids and bad arguments give null and never throw', () => {
  for (const id of ['__proto__', 'constructor', 'toString', 'Python', 'PYTHON', ' python', '', null, 5, undefined, {}, [], ['python']]) {
    assert.equal(C.toggleComment('a', 0, 1, id), null, JSON.stringify(id));
  }
  const pairText = 'a😀b';
  const bad = [
    [null, 0, 0], [5, 0, 0], [undefined, 0, 0], ['ab', NaN, 1], ['ab', 0.5, 1], ['ab', '0', '1'], ['ab', -1, 0], ['ab', 0, 3],
    ['ab', 3, 3], ['ab', 2, 1], ['ab', 0, Infinity], ['ab'], [pairText, 2, 2], [pairText, 1, 2], [pairText, 0, 2], [{}, 0, 0], [['a'], 0, 0],
  ];
  for (const [t, s, e] of bad) {
    for (const id of ['python', 'html', 'json']) assert.equal(C.toggleComment(t, s, e, id), null, `${JSON.stringify([t, s, e])} ${id}`);
  }
});

// duplicateLines

table('duplicateLines', 'python', dup, [
  ['a¦\nb', 'a\na¦\nb'],
  ['«a\nb»\nc', 'a\nb\n«a\nb»\nc'],
  ['a\nb¦', 'a\nb\nb¦'],
  ['a¦\n', 'a\na¦\n'],
  ['«a\n»b', 'a\n«a\n»b'],
  ['¦\nb', '\n¦\nb'],
  ['x\n  ¦y\nz', 'x\n  y\n  ¦y\nz'],
  ['a\n«b\nc»', 'a\nb\nc\n«b\nc»'],
  ['¦', '\n¦'],
]);
test('duplicateLines: works with any language id including plain, and with an empty id for a Markdown note', () => {
  for (const id of ['', ...store.LANGS]) assert.equal(dup('a¦\nb', id), 'a\na¦\nb', id);
});
test('duplicateLines: CRLF lines are copied whole and only the lines involved change', () => {
  const text = 'a\r\nb\r\nc';
  const r = C.duplicateLines(text, 4, 4, 'plain');
  assert.equal(applyRaw(text, r), 'a\r\nb\r\nb\r\nc');
  assert.deepEqual([r.start, r.end, r.insert], [5, 5, '\nb\r']);
});
test('duplicateLines: hostile ids, positions and surrogate splits give null', () => {
  for (const id of ['__proto__', 'Python', null, 5, undefined, {}, []]) assert.equal(C.duplicateLines('a', 0, 0, id), null, JSON.stringify(id));
  for (const [t, s, e] of [[null, 0, 0], ['ab', -1, 0], ['ab', 2, 1], ['ab', 0, 3], ['ab', 0.5, 1], ['ab', '0', 0], ['a😀', 2, 2], ['a😀', 1, 2]]) {
    assert.equal(C.duplicateLines(t, s, e, 'plain'), null, JSON.stringify([t, s, e]));
  }
});

// moveLines

table('moveLines', 'python', (m, id) => mv(m, id, 1), [
  ['a\n¦b\nc', 'a\nc\n¦b'],
  ['a¦\nb\n', 'b\na¦\n'],
  ['a\n¦b\n', 'a\n\n¦b'], // b swaps with the final empty line (and back: see the property test)
  ['a\nb\nc¦', 'a\nb\nc¦'],
  ['a¦\nb', 'b\na¦'],
  ['«a\nb»\nc\nd', 'c\n«a\nb»\nd'],
  ['«a\nb\n»c\nd', 'c\n«a\nb\n»d'],
  ['a\nb\n¦', 'a\nb\n¦'],
  ['¦', '¦'],
  ['a\n  ¦b\n    c', 'a\n    c\n  ¦b'],
]);
table('moveLines', 'python', (m, id) => mv(m, id, -1), [
  ['a\n¦b\nc', '¦b\na\nc'],
  ['¦a\nb', '¦a\nb'],
  ['a\nb¦', 'b¦\na'],
  ['a\nb\n¦', 'a\nb\n¦'],
  ['a\n«b\nc\n»d', '«b\nc\n»a\nd'],
  ['a\n«b\nc»', '«b\nc»\na'],
  ['a\nb\nc¦\n', 'a\nc¦\nb\n'],
]);
test('moveLines: up then down (and down then up) restores text and selection; the final newline is kept or absent as before', () => {
  const samples = ['a\n¦b\nc', 'a\n«b\nc»\nd', 'a\nb\n¦c', 'x\n«y»\nz\n', 'a\n«b\nc\n»d\n', '\n¦\n\n', 'a\n  ¦b\n\n  c', 'é😀\n¦b😀\nc', 'a\r\n¦b\r\nc', 'a\r\n«b\r\nc»'];
  for (const marked of samples) {
    const { text, start, end } = parse(marked);
    for (const [d1, d2] of [[-1, 1], [1, -1]]) {
      const r1 = C.moveLines(text, start, end, 'plain', d1);
      const t1 = applyRaw(text, r1);
      assert.equal(t1.length, text.length, marked);
      assert.equal(t1.endsWith('\n'), text.endsWith('\n'), marked);
      assert.equal(t1.split('\n').length, text.split('\n').length, marked);
      if (t1 === text) continue; // a move past the end: nothing to undo
      const r2 = C.moveLines(t1, r1.selStart, r1.selEnd, 'plain', d2);
      assert.equal(applyRaw(t1, r2), text, `${marked} ${d1}`);
      if (t1 !== text) {
        assert.equal(r2.selStart, start, `${marked} ${d1} selStart`);
        assert.equal(r2.selEnd, end, `${marked} ${d1} selEnd`);
      }
    }
  }
});
test('moveLines: a move past the first or last line is a no-op result, not null', () => {
  assert.deepEqual(C.moveLines('a\nb', 0, 0, 'plain', -1), { start: 0, end: 0, insert: '', selStart: 0, selEnd: 0 });
  assert.deepEqual(C.moveLines('a\nb', 2, 3, 'plain', 1), { start: 2, end: 2, insert: '', selStart: 2, selEnd: 3 });
});
test('moveLines: CRLF text keeps its line ends, also when the final line has none', () => {
  assert.equal(applyRaw('a\r\nb', C.moveLines('a\r\nb', 0, 0, 'plain', 1)), 'b\r\na');
  assert.equal(applyRaw('a\r\nb', C.moveLines('a\r\nb', 3, 3, 'plain', -1)), 'b\r\na');
  assert.equal(applyRaw('a\r\nb\r\nc\r\n', C.moveLines('a\r\nb\r\nc\r\n', 3, 3, 'plain', 1)), 'a\r\nc\r\nb\r\n');
});
test('moveLines: only the lines involved are replaced', () => {
  const text = 'one\ntwo\nthree\nfour';
  const r = C.moveLines(text, 5, 5, 'plain', 1);
  assert.deepEqual([r.start, r.end, r.insert], [4, 13, 'three\ntwo']);
});
test('moveLines: any language id and the empty id work', () => {
  for (const id of ['', ...store.LANGS]) assert.equal(mv('a¦\nb', id, 1), 'b\na¦', id);
});
test('moveLines: direction must be exactly -1 or 1; hostile ids and positions give null', () => {
  for (const d of [0, 2, -2, '1', '-1', null, undefined, NaN, 1.5, true, [], {}, Infinity]) assert.equal(C.moveLines('a\nb', 0, 0, 'plain', d), null, String(d));
  for (const id of ['__proto__', 'Python', null, 5, undefined, {}, []]) assert.equal(C.moveLines('a\nb', 0, 0, id, 1), null, JSON.stringify(id));
  for (const [t, s, e] of [[null, 0, 0], [5, 0, 0], ['ab', -1, 0], ['ab', 2, 1], ['ab', 0, 3], ['ab', 0.5, 1], ['ab', '0', 0], ['a😀\nb', 2, 2], ['a😀\nb', 1, 2], ['ab', NaN, 0]]) {
    assert.equal(C.moveLines(t, s, e, 'plain', 1), null, JSON.stringify([t, s, e]));
  }
});

test('performance: each new function on 200,000 lines with the caret near the end is under 50 ms', () => {
  const text = Array.from({ length: 200000 }, (_, i) => `    line ${i} of some code`).join('\n');
  const p = text.length - 30;
  const jobs = {
    toggleComment: () => C.toggleComment(text, p, p, 'python'),
    toggleCommentBlock: () => C.toggleComment(text, p, p, 'html'),
    duplicateLines: () => C.duplicateLines(text, p, p, 'plain'),
    moveUp: () => C.moveLines(text, p, p, 'plain', -1),
    moveDown: () => C.moveLines(text, p, p, 'plain', 1),
    moveDownFromTheMiddle: () => C.moveLines(text, text.length >> 1, text.length >> 1, 'plain', 1),
  };
  for (const [name, job] of Object.entries(jobs)) {
    job(); // warm up
    const t0 = process.hrtime.bigint();
    const r = job();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(r, name);
    assert.ok(ms < 50, `${name} took ${ms} ms`);
  }
});

// ---- review fixes: block comments, shebang, moveLines model ----

const rows = (id, fn, list) => { for (const [before, after] of list) assert.equal(fn(before, id), after, `${id} ${JSON.stringify(before)}`); };

// 4. A block comment is one span.
test('toggleComment: ends that belong to different block comments are not joined', () => {
  rows('html', tc, [
    ['«<!-- a --> b <!-- c -->»', '«<!-- a --> b <!-- c -->»'],
    ['«<!-- a --> b»', '«<!-- a --> b»'],
    ['«a <!-- b -->»', '«a <!-- b -->»'],
    ['<!-- «a --> b <!-- c» -->', '<!-- «a --> b <!-- c» -->'],
  ]);
  rows('css', tc, [
    ['«/* a */ b /* c */»', '«/* a */ b /* c */»'],
    ['«x /* y */»', '«x /* y */»'],
    ['«/* a */»', '«a»'],
  ]);
});
test('toggleComment: wrapping text that holds the opener or closer is a no-op result (and any -- in XML and HTML)', () => {
  rows('html', tc, [
    ['«a --> b»', '«a --> b»'],
    ['«a <!-- b»', '«a <!-- b»'],
    ['«a -- b»', '«a -- b»'],
    ['«a - b»', '«<!-- a - b -->»'],
  ]);
  rows('xml', tc, [['«<a x="--"/>»', '«<a x="--"/>»'], ['«<a/>»', '«<!-- <a/> -->»']]);
  rows('css', tc, [['«a */ b»', '«a */ b»'], ['«a /* b»', '«a /* b»'], ['«a -- b»', '«/* a -- b */»']]);
  const r = C.toggleComment('<!-- a --> b <!-- c -->', 0, 23, 'html');
  assert.deepEqual(r, { start: 0, end: 0, insert: '', selStart: 0, selEnd: 23 });
});

// 10. A shebang is neither a comment nor commentable.
test('toggleComment: a #! first line is skipped both ways and does not count for the all-commented decision', () => {
  for (const id of ['python', 'bash']) {
    rows(id, tc, [
      ['«#!/usr/bin/env x\na = 1\nb = 2»', '«#!/usr/bin/env x\n# a = 1\n# b = 2»'],
      ['«#!/usr/bin/env x\n# a = 1\n# b = 2»', '«#!/usr/bin/env x\na = 1\nb = 2»'],
      ['«#!/usr/bin/env x\n# a = 1\nb = 2»', '«#!/usr/bin/env x\n# # a = 1\n# b = 2»'],
      ['«#!/bin/sh»', '«#!/bin/sh»'],
      ['#!/bin/sh¦', '#!/bin/sh¦'],
      ['«#!/bin/sh\n\n»', '«#!/bin/sh\n\n»'],
      ['«#!/bin/sh\n  a»', '«#!/bin/sh\n  # a»'],
      ['«# comment\na»', '# «# comment\n# a»'], // only #! is special
    ]);
  }
  // not on the first line of the block: a plain comment line
  rows('python', tc, [['a\n«#!x»', 'a\n«#!x»'], ['«a\n#!x»', '# «a\n# #!x»']]);
  // other languages are not affected
  rows('sql', tc, [['«#!x\ny»', '-- «#!x\n-- y»']]);
  const r = C.toggleComment('#!/bin/sh\nx', 0, 11, 'bash');
  assert.equal(applyRaw('#!/bin/sh\nx', r), '#!/bin/sh\n# x');
});

// 9. moveLines: the text is a list of lines separated by LF; a final newline leaves an empty last line.
table('moveLines', 'plain', (m, id) => mv(m, id, -1), [
  ['a\n\n¦b', 'a\n¦b\n'],
  ['a\n\n¦b\n', 'a\n¦b\n\n'],
  ['a\n¦\nb', '¦\na\nb'],
]);
table('moveLines', 'plain', (m, id) => mv(m, id, 1), [
  ['a\n¦b\n', 'a\n\n¦b'],
  ['a\nb¦\n\n', 'a\n\nb¦\n'],
  ['a\n\n¦', 'a\n\n¦'], // the final empty line itself never moves
  ['a\n¦\nb\n', 'a\nb\n¦\n'],
]);
test('moveLines: the last line up over a blank line and back down restores the text, LF and CRLF', () => {
  for (const eol of ['\n', '\r\n']) {
    const text = `a${eol}${eol}b`;
    const at = text.length - 1;
    const r1 = C.moveLines(text, at, at, 'plain', -1);
    const t1 = applyRaw(text, r1);
    assert.equal(t1, `a${eol}b${eol}`, JSON.stringify(eol));
    const r2 = C.moveLines(t1, r1.selStart, r1.selEnd, 'plain', 1);
    assert.equal(applyRaw(t1, r2), text, JSON.stringify(eol));
    assert.deepEqual([r2.selStart, r2.selEnd], [at, at]);
  }
});

// A seeded generator keeps the property test repeatable.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// The line numbers (0-based) a selection touches, by the same rule the functions use: a selection that ends at
// column 0 of a line does not touch that line.
function touchedLines(text, s, e) {
  const index = (p) => { let n = 0; for (let i = 0; i < p; i += 1) if (text[i] === '\n') n += 1; return n; };
  const first = index(s);
  let last = index(e);
  if (e > s && (e === 0 || text[e - 1] === '\n')) last -= 1;
  return [first, Math.max(first, last)];
}
test('property: moveLines up-then-down and down-then-up restore 50,000 random texts, LF and CRLF, with and without a final newline', () => {
  // Lines of random letters or empty, one line ending per text. A lone \r inside a line is left out: it is neither
  // a line end for this function nor a character the editors produce.
  const r = rng(2026);
  let moved = 0;
  let noops = 0;
  for (let i = 0; i < 50000; i += 1) {
    const eol = r() < 0.35 ? '\r\n' : '\n';
    const n = 1 + Math.floor(r() * 6);
    const lines = [];
    for (let k = 0; k < n; k += 1) {
      let line = '';
      if (r() < 0.65) for (let j = 0, len = 1 + Math.floor(r() * 3); j < len; j += 1) line += 'abcdefgh'[Math.floor(r() * 8)];
      lines.push(line);
    }
    const text = lines.join(eol) + (r() < 0.4 ? eol : '');
    let s = Math.floor(r() * (text.length + 1));
    let e = r() < 0.5 ? s : Math.floor(r() * (text.length + 1));
    if (s > e) [s, e] = [e, s];
    const label = `${JSON.stringify(text)} ${s} ${e}`;
    const [f, l] = touchedLines(text, s, e);
    const total = text.split('\n').length;
    for (const d of [-1, 1]) {
      const r1 = C.moveLines(text, s, e, 'plain', d);
      assert.ok(r1, label);
      const t1 = applyRaw(text, r1);
      assert.equal(t1.length, text.length, `${label} ${d}`);
      assert.equal(t1.split('\n').length, total, `${label} ${d}`);
      if (r1.insert === '' && r1.start === r1.end) {
        // a no-op result: only at the first line (up), the last line (down) or on the final empty line itself
        const finalEmpty = text.endsWith('\n') && f === total - 1;
        // (a block ending in an empty line does not move onto the last line: it could not come back)
        const lastLine = text.split('\n')[l];
        const blanksBeforeFinal = d === 1 && l === total - 2 && (lastLine === '' || lastLine === '\r');
        assert.ok(finalEmpty || blanksBeforeFinal || (d === -1 && f === 0) || (d === 1 && l === total - 1), `${label} ${d}`);
        assert.equal(t1, text, label);
        noops += 1;
        continue;
      }
      moved += 1;
      assert.ok(r1.selStart >= 0 && r1.selStart <= r1.selEnd && r1.selEnd <= t1.length, `${label} ${d}`);
      assert.deepEqual(touchedLines(t1, r1.selStart, r1.selEnd), [f + d, l + d], `selection follows the lines: ${label} ${d}`);
      const r2 = C.moveLines(t1, r1.selStart, r1.selEnd, 'plain', -d);
      assert.ok(r2 && !(r2.insert === '' && r2.start === r2.end), `the way back is possible: ${label} ${d}`);
      assert.equal(applyRaw(t1, r2), text, `restores: ${label} ${d}`);
      assert.deepEqual(touchedLines(applyRaw(t1, r2), r2.selStart, r2.selEnd), [f, l], `selection comes back: ${label} ${d}`);
    }
  }
  assert.ok(moved > 30000 && noops > 1000, `${moved} ${noops}`);
});

// ---- performance guards (best of three) ----

const bestOf = (n, fn) => {
  let best = Infinity;
  for (let i = 0; i < n; i += 1) {
    const t0 = process.hrtime.bigint();
    fn();
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return best;
};
test('performance: moveLines and toggleComment on 200,000 lines are under 200 ms', () => {
  const text = Array.from({ length: 200000 }, (_, i) => `    line ${i} of some code`).join('\n');
  const lastStart = text.lastIndexOf('\n') + 1;
  const jobs = {
    moveDown: () => C.moveLines(text, 0, lastStart - 1, 'plain', 1),
    moveUp: () => C.moveLines(text, 20, text.length, 'plain', -1),
    commentPython: () => C.toggleComment(text, 0, text.length, 'python'),
    commentCss: () => C.toggleComment(text, 0, text.length, 'css'),
  };
  for (const [name, job] of Object.entries(jobs)) {
    const ms = bestOf(3, () => assert.ok(job(), name));
    assert.ok(ms < 200, `${name} ${ms} ms`);
  }
  const commented = applyRaw(text, C.toggleComment(text, 0, text.length, 'python'));
  const ms = bestOf(3, () => assert.ok(C.toggleComment(commented, 0, commented.length, 'python')));
  assert.ok(ms < 200, `uncomment ${ms} ms`);
});
