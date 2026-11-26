'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../js/core/highlight.js');

const INIT = H.initialState();

/** text -> [[type, substring], ...] */
function tk(lang, text, state = INIT) {
  const r = H.tokenizeLine(lang, text, state);
  return r.tokens.map((t) => [t.type, text.slice(t.start, t.end)]);
}
/** Thread the state through several lines; returns the pairs per line and the final state. */
function thread(lang, lines) {
  let st = INIT;
  const out = [];
  for (const l of lines) {
    const r = H.tokenizeLine(lang, l, st);
    out.push(r.tokens.map((t) => [t.type, l.slice(t.start, t.end)]));
    st = r.state;
  }
  return { out, state: st };
}
function checkInvariants(text, tokens) {
  let last = 0;
  for (const t of tokens) {
    assert.ok(Number.isInteger(t.start) && Number.isInteger(t.end), 'integer bounds');
    assert.ok(t.end > t.start, 'non-empty');
    assert.ok(t.start >= last, 'ordered, non-overlapping');
    assert.ok(t.end <= text.length, 'inside the line');
    assert.ok(['comment', 'string', 'keyword', 'number', 'constant', 'tag', 'attr', 'section', 'variable'].includes(t.type), 'known type ' + t.type);
    last = t.end;
  }
}

const COLOURED = H.LANGUAGE_IDS.filter((l) => l !== 'plain');

test('LANGUAGE_IDS is frozen and has exactly the 24 ids in order', () => {
  assert.deepEqual([...H.LANGUAGE_IDS], [
    'bash', 'c', 'cpp', 'csharp', 'css', 'go', 'html', 'java', 'javascript', 'json', 'powershell', 'python', 'rust', 'sql',
    'typescript', 'yaml', 'batch', 'ruby', 'php', 'lua', 'perl', 'xml', 'ini', 'plain',
  ]);
  assert.equal(H.LANGUAGE_IDS.length, 24);
  assert.ok(Object.isFrozen(H.LANGUAGE_IDS));
  assert.equal(COLOURED.length, 23);
});

test('initialState and sameState work by value', () => {
  assert.equal(typeof H.initialState(), 'string');
  assert.ok(H.sameState(H.initialState(), H.initialState()));
  assert.ok(!H.sameState(H.initialState(), 'bc'));
  assert.ok(H.sameState('bc', 'b' + 'c'));
});

// ------------------------------------------------------- per-language cases

const CASES = {
  python: [
    ['# note', [['comment', '# note']]],
    ['x = "a" + \'b\'', [['string', '"a"'], ['string', "'b'"]]],
    ['n = 0x1F + 1_000.5', [['number', '0x1F'], ['number', '1_000.5']]],
    ['@app.route', [['keyword', '@app.route']]],
    ['s = rb"x" + F\'y\'', [['string', 'rb"x"'], ['string', "F'y'"]]],
    ['x = None', [['constant', 'None']]],
    ['"""doc""" # c', [['string', '"""doc"""'], ['comment', '# c']]],
  ],
  javascript: [
    ['// note', [['comment', '// note']]],
    ['const s = "a"', [['keyword', 'const'], ['string', '"a"']]],
    ['x = 1.5e3 + 0xff', [['number', '1.5e3'], ['number', '0xff']]],
    ['a = `t ${x} u`', [['string', '`t ${x} u`']]],
    ['x = /re/', []],
    ['/* a */ y', [['comment', '/* a */']]],
    ['v = null', [['constant', 'null']]],
  ],
  typescript: [
    ['// note', [['comment', '// note']]],
    ['let s: string = "a"', [['keyword', 'let'], ['keyword', 'string'], ['string', '"a"']]],
    ['interface Foo {}', [['keyword', 'interface']]],
    ['x = 1_000', [['number', '1_000']]],
    ['x = `a`', [['string', '`a`']]],
  ],
  c: [
    ['// note', [['comment', '// note']]],
    ['char *s = "a";', [['keyword', 'char'], ['string', '"a"']]],
    ['x = 0xFF + 1.5f;', [['number', '0xFF'], ['number', '1.5f']]],
    ['#include <stdio.h>', [['keyword', '#include'], ['string', '<stdio.h>']]],
    ['  #define X 1', [['keyword', '#define'], ['number', '1']]],
    ['x = NULL;', [['constant', 'NULL']]],
  ],
  cpp: [
    ['// note', [['comment', '// note']]],
    ['std::string s = "a";', [['string', '"a"']]],
    ['p = nullptr;', [['constant', 'nullptr']]],
    ['#include "a.h"', [['keyword', '#include'], ['string', '"a.h"']]],
    ['template <class T> int x = 3;', [['keyword', 'template'], ['keyword', 'class'], ['keyword', 'int'], ['number', '3']]],
  ],
  csharp: [
    ['// note', [['comment', '// note']]],
    ['var s = @"C:\\x\\y";', [['keyword', 'var'], ['string', '@"C:\\x\\y"']]],
    ['var t = @"a""b";', [['keyword', 'var'], ['string', '@"a""b"']]],
    ['int n = 42;', [['keyword', 'int'], ['number', '42']]],
    ['var @class = 1;', [['keyword', 'var'], ['number', '1']]],
    ['x = null;', [['constant', 'null']]],
  ],
  java: [
    ['// note', [['comment', '// note']]],
    ['String s = "a";', [['string', '"a"']]],
    ['public static int n = 1_000;', [['keyword', 'public'], ['keyword', 'static'], ['keyword', 'int'], ['number', '1_000']]],
    ['char c = \'x\';', [['keyword', 'char'], ['string', "'x'"]]],
    ['String t = """a', [['string', '"""a']]],
    ['x = true;', [['constant', 'true']]],
  ],
  go: [
    ['// note', [['comment', '// note']]],
    ['s := "a"', [['string', '"a"']]],
    ['func main() {}', [['keyword', 'func']]],
    ['x := 0x1F', [['number', '0x1F']]],
    ['s := `raw \\n`', [['string', '`raw \\n`']]],
    ['x = nil', [['constant', 'nil']]],
  ],
  rust: [
    ['// note', [['comment', '// note']]],
    ['let s = "a";', [['keyword', 'let'], ['string', '"a"']]],
    ['let r = r"a\\b";', [['keyword', 'let'], ['string', 'r"a\\b"']]],
    ['let r = r#"a"b"#;', [['keyword', 'let'], ['string', 'r#"a"b"#']]],
    ["fn f<'a>(x: &'a str) {}", [['keyword', 'fn']]],
    ["let c = 'x'; let n = 1_000u32;", [['keyword', 'let'], ['string', "'x'"], ['keyword', 'let'], ['number', '1_000u32']]],
  ],
  php: [
    ['// note', [['comment', '// note']]],
    ['# note', [['comment', '# note']]],
    ['$a = "x";', [['variable', '$a'], ['string', '"x"']]],
    ['ECHO $b, 12;', [['keyword', 'ECHO'], ['variable', '$b'], ['number', '12']]],
    ['/* c */ $d', [['comment', '/* c */'], ['variable', '$d']]],
    ['x = NULL;', [['constant', 'NULL']]],
  ],
  bash: [
    ['# note', [['comment', '# note']]],
    ['echo "hi"', [['keyword', 'echo'], ['string', '"hi"']]],
    ['x=42', [['number', '42']]],
    ['echo $HOME ${a} $# a#b', [['keyword', 'echo'], ['variable', '$HOME'], ['variable', '${a}'], ['variable', '$#']]],
    ["echo '# not a comment'", [['keyword', 'echo'], ['string', "'# not a comment'"]]],
    ['ls; # real', [['comment', '# real']]],
    ["echo 'a\\' b", [['keyword', 'echo'], ['string', "'a\\'"]]],
  ],
  powershell: [
    ['# note', [['comment', '# note']]],
    ['<# c #> $x', [['comment', '<# c #>'], ['variable', '$x']]],
    ['Write-Host "hi" $x', [['keyword', 'Write-Host'], ['string', '"hi"'], ['variable', '$x']]],
    ['RETURN returned', [['keyword', 'RETURN']]],
    ['$env:PATH -eq 1', [['variable', '$env:PATH'], ['keyword', '-eq'], ['number', '1']]],
    ['"a`"b" \'it\'\'s\'', [['string', '"a`"b"'], ['string', "'it''s'"]]],
  ],
  batch: [
    ['rem hi', [['comment', 'rem hi']]],
    ['  @REM hi', [['comment', '@REM hi']]],
    [':: hi', [['comment', ':: hi']]],
    ['echo %PATH% %%a %1', [['keyword', 'echo'], ['variable', '%PATH%'], ['variable', '%%a'], ['variable', '%1']]],
    [':loop', [['section', ':loop']]],
    ['IF exist x goto loop', [['keyword', 'IF'], ['keyword', 'exist'], ['keyword', 'goto']]],
    ['set n=5', [['keyword', 'set'], ['number', '5']]],
    ['echo "a rem b"', [['keyword', 'echo'], ['string', '"a rem b"']]],
  ],
  sql: [
    ['-- note', [['comment', '-- note']]],
    ["SELECT 'it''s' FROM t", [['keyword', 'SELECT'], ['string', "'it''s'"], ['keyword', 'FROM']]],
    ['limit 10 offset 0x1', [['keyword', 'limit'], ['number', '10'], ['keyword', 'offset'], ['number', '0x1']]],
    ['/* c */ select', [['comment', '/* c */'], ['keyword', 'select']]],
    ['x is NULL', [['keyword', 'is'], ['constant', 'NULL']]],
  ],
  ruby: [
    ['# note', [['comment', '# note']]],
    ['puts "a"', [['keyword', 'puts'], ['string', '"a"']]],
    ['@x = $y + @@z', [['variable', '@x'], ['variable', '$y'], ['variable', '@@z']]],
    ['n = 3.14', [['number', '3.14']]],
    ['x = nil', [['constant', 'nil']]],
  ],
  perl: [
    ['# note', [['comment', '# note']]],
    ['my $x = @y;', [['keyword', 'my'], ['variable', '$x'], ['variable', '@y']]],
    ['print "a", 3;', [['keyword', 'print'], ['string', '"a"'], ['number', '3']]],
    ['$#a + $0', [['variable', '$#'], ['variable', '$0']]],
    ['x = undef', [['constant', 'undef']]],
  ],
  lua: [
    ['-- note', [['comment', '-- note']]],
    ["x = 'a'", [['string', "'a'"]]],
    ['local t = [[long]]', [['keyword', 'local'], ['string', '[[long]]']]],
    ['local n = 3', [['keyword', 'local'], ['number', '3']]],
    ['--[[ c ]] x', [['comment', '--[[ c ]]']]],
    ['x = [==[a]]b]==]', [['string', '[==[a]]b]==]']]],
    ['x = nil', [['constant', 'nil']]],
  ],
  html: [
    ['<!-- c -->', [['comment', '<!-- c -->']]],
    ['<a href="x" id=\'y\'>', [['tag', '<a'], ['attr', 'href'], ['string', '"x"'], ['attr', 'id'], ['string', "'y'"], ['tag', '>']]],
    ['text <b>bold</b> end', [['tag', '<b'], ['tag', '>'], ['tag', '</b'], ['tag', '>']]],
    ['<br/>', [['tag', '<br'], ['tag', '/>']]],
    ['<!DOCTYPE html>', [['tag', '<!DOCTYPE'], ['attr', 'html'], ['tag', '>']]],
    ['1 < 2 and 3 > 2', []],
    ['<p class="a>b">', [['tag', '<p'], ['attr', 'class'], ['string', '"a>b"'], ['tag', '>']]],
  ],
  xml: [
    ['<!-- c -->', [['comment', '<!-- c -->']]],
    ['<?xml version="1.0"?>', [['tag', '<?xml'], ['attr', 'version'], ['string', '"1.0"'], ['tag', '?>']]],
    ['<ns:a b:c="1"/>', [['tag', '<ns:a'], ['attr', 'b:c'], ['string', '"1"'], ['tag', '/>']]],
  ],
  css: [
    ['/* c */', [['comment', '/* c */']]],
    ['a:hover { color: #fff; margin: -10px 1.5em }', [['section', 'a:hover'], ['attr', 'color'], ['number', '#fff'], ['attr', 'margin'], ['number', '-10px'], ['number', '1.5em']]],
    ['@media (max-width: 600px) {', [['section', '@media (max-width: 600px)']]],
    ['p { content: "x"; font-family: a1 }', [['section', 'p'], ['attr', 'content'], ['string', '"x"'], ['attr', 'font-family']]],
    ['.a, #b > c', [['section', '.a, #b > c']]],
    ['@import url(x.css);', [['section', '@import url(x.css)']]],
  ],
  json: [
    ['{"a": "b", "n": -1.5, "t": true, "x": null, "e": 2e3}', [['attr', '"a"'], ['string', '"b"'], ['attr', '"n"'], ['number', '-1.5'], ['attr', '"t"'], ['constant', 'true'], ['attr', '"x"'], ['constant', 'null'], ['attr', '"e"'], ['number', '2e3']]],
    ['["x", "a\\"b" , false]', [['string', '"x"'], ['string', '"a\\"b"'], ['constant', 'false']]],
    ['"k" :1', [['attr', '"k"'], ['number', '1']]],
    ['"http://x": "// not a comment"', [['attr', '"http://x"'], ['string', '"// not a comment"']]],
  ],
  yaml: [
    ['# note', [['comment', '# note']]],
    ['name: "x"', [['attr', 'name'], ['string', '"x"']]],
    ['key: true', [['attr', 'key'], ['constant', 'true']]],
    ['  - item: 5', [['attr', 'item'], ['number', '5']]],
    ['---', [['section', '---']]],
    ['...', [['section', '...']]],
    ['a: trueish # c', [['attr', 'a'], ['comment', '# c']]],
    ['"q k": \'it\'\'s\'', [['attr', '"q k"'], ['string', "'it''s'"]]],
    ['url: http://x/#frag', [['attr', 'url']]],
    ['- yes', [['constant', 'yes']]],
    ['v: 1.2.3', [['attr', 'v']]],
  ],
  ini: [
    ['# note', [['comment', '# note']]],
    ['  ; note', [['comment', '; note']]],
    ['[core]', [['section', '[core]']]],
    ['name = "x"', [['attr', 'name'], ['string', '"x"']]],
    ['debug = true', [['attr', 'debug'], ['constant', 'true']]],
    ['port: 80', [['attr', 'port'], ['number', '80']]],
    ['mode = trueish', [['attr', 'mode']]],
  ],
};

test('every coloured language has cases', () => {
  for (const l of COLOURED) assert.ok(CASES[l] && CASES[l].length >= 3, l);
});

for (const lang of Object.keys(CASES)) {
  test(`${lang}: comments, strings, numbers and special constructs`, () => {
    for (const [text, expected] of CASES[lang]) {
      assert.deepEqual(tk(lang, text), expected, `${lang}: ${text}`);
    }
  });
}

// keyword vs an identifier that merely contains it
const KW = {
  python: ['return', 'returned'], javascript: ['return', 'returned'], typescript: ['return', 'returned'],
  c: ['return', 'returned'], cpp: ['return', 'returned'], csharp: ['return', 'returned'], java: ['return', 'returned'],
  go: ['func', 'funcs'], rust: ['fn', 'fns'], php: ['if', 'iffy'], bash: ['if', 'iffy'], powershell: ['if', 'iffy'],
  batch: ['if', 'iffy'], sql: ['select', 'selected'], ruby: ['if', 'iffy'], perl: ['if', 'iffy'], lua: ['if', 'iffy'],
};
for (const lang of Object.keys(KW)) {
  test(`${lang}: keyword is not matched inside an identifier`, () => {
    const [kw, ident] = KW[lang];
    assert.deepEqual(tk(lang, `${kw} ${ident} x${kw} ${kw}_`), [['keyword', kw]]);
  });
}
test('constants are whole-word matches too (yaml, ini, json, css have no keywords)', () => {
  assert.deepEqual(tk('yaml', 'a: nullable'), [['attr', 'a']]);
  assert.deepEqual(tk('ini', 'a = falsey'), [['attr', 'a']]);
  assert.deepEqual(tk('json', '[nullx, truex]'), []);
  assert.deepEqual(tk('python', 'Nonexistent = True'), [['constant', 'True']]);
  assert.deepEqual(tk('css', 'a { color: red }'), [['section', 'a'], ['attr', 'color']]);
});

// markers inside strings
const MARKER = {
  python: ['x = "http://x" # real', 2], javascript: ['x = "http://x" // real', 2], typescript: ['x = "http://x" // real', 2],
  c: ['x = "http://x"; // real', 2], cpp: ['x = "http://x"; // real', 2], csharp: ['x = "http://x"; // real', 2],
  java: ['x = "http://x"; // real', 2], go: ['x = "http://x" // real', 2], rust: ['x = "http://x"; // real', 2],
  php: ['$x = "http://x"; # real', 3], bash: ['echo "http://x" # real', 3], powershell: ['"http://x" # real', 2],
  sql: ["select 'a -- b' -- real", 3], ruby: ['x = "http://x" # real', 2], perl: ['$x = "http://x"; # real', 3],
  lua: ['x = "a -- b" -- real', 2],
};
for (const lang of Object.keys(MARKER)) {
  test(`${lang}: a string containing the comment marker stays one string`, () => {
    const [text] = MARKER[lang];
    const t = tk(lang, text);
    const strings = t.filter((x) => x[0] === 'string');
    assert.equal(strings.length, 1);
    assert.ok(/^["'].*["']$/.test(strings[0][1]));
    assert.equal(t.filter((x) => x[0] === 'comment').length, 1);
    assert.equal(t[t.length - 1][1].endsWith('real'), true);
  });
}
test('hash inside quotes, comment markers in strings (spec examples)', () => {
  assert.deepEqual(tk('python', "x = '# not a comment'"), [['string', "'# not a comment'"]]);
  assert.deepEqual(tk('javascript', 'u = "http://x"'), [['string', '"http://x"']]);
  assert.deepEqual(tk('yaml', 'a: "x # y"'), [['attr', 'a'], ['string', '"x # y"']]);
  assert.deepEqual(tk('json', '{"u": "http://x"}'), [['attr', '"u"'], ['string', '"http://x"']]);
  assert.deepEqual(tk('css', 'a { content: "/* x */" }'), [['section', 'a'], ['attr', 'content'], ['string', '"/* x */"']]);
  assert.deepEqual(tk('html', '<a title="<!-- x -->">'), [['tag', '<a'], ['attr', 'title'], ['string', '"<!-- x -->"'], ['tag', '>']]);
});

test('an escaped quote inside a string does not end it', () => {
  for (const lang of ['python', 'javascript', 'typescript', 'c', 'cpp', 'csharp', 'java', 'go', 'rust', 'php', 'bash', 'ruby', 'perl', 'lua', 'json']) {
    const t = tk(lang, '"a\\"b" 7');
    assert.deepEqual(t[0], [lang === 'json' ? 'string' : 'string', '"a\\"b"'], lang);
  }
  assert.deepEqual(tk('python', "'a\\'b'"), [['string', "'a\\'b'"]]);
  assert.deepEqual(tk('powershell', '"a`"b"'), [['string', '"a`"b"']]);
  assert.deepEqual(tk('sql', "'a''b'"), [['string', "'a''b'"]]);
});

test('an unterminated single-line string ends at the line end and does not leak', () => {
  const langs = ['python', 'javascript', 'typescript', 'c', 'cpp', 'csharp', 'java', 'go', 'rust', 'php', 'bash', 'powershell', 'batch', 'sql', 'ruby', 'perl', 'lua'];
  for (const lang of langs) {
    const q = lang === 'csharp' ? '@"' : '"';
    const r = H.tokenizeLine(lang, `x = ${q}abc 12`, INIT);
    assert.equal(r.state, INIT, lang);
    const last = r.tokens[r.tokens.length - 1];
    assert.equal(last.type, 'string', lang);
    assert.equal(last.end, `x = ${q}abc 12`.length, lang);
    const next = H.tokenizeLine(lang, 'y = 7', r.state);
    assert.ok(next.tokens.some((t) => t.type === 'number'), lang);
  }
  for (const lang of ['json', 'yaml', 'ini']) {
    const r = H.tokenizeLine(lang, 'k = "abc', INIT);
    assert.equal(r.state, INIT);
  }
  assert.equal(H.tokenizeLine('javascript', "x = 'abc", INIT).state, INIT);
  assert.equal(H.tokenizeLine('python', "x = 'abc", INIT).state, INIT);
  assert.equal(H.tokenizeLine('css', 'a { content: "abc', INIT).state, 'css');
  assert.equal(H.tokenizeLine('html', '<a b="c', INIT).state, 'tq"');
});

// ----------------------------------------------------- multi-line constructs

test('block comments across three lines (C family, CSS-free)', () => {
  for (const lang of ['c', 'cpp', 'csharp', 'java', 'go', 'rust', 'php', 'javascript', 'typescript', 'sql']) {
    const r = thread(lang, ['x /* a', 'middle "not string"', 'end */ 1']);
    assert.deepEqual(r.out[0], [['comment', '/* a']], lang);
    assert.deepEqual(r.out[1], [['comment', 'middle "not string"']], lang);
    assert.deepEqual(r.out[2], [['comment', 'end */'], ['number', '1']], lang);
    assert.equal(r.state, INIT, lang);
    assert.equal(H.tokenizeLine(lang, 'x /* a', INIT).state, 'bc', lang);
  }
});

test('python triple-quoted strings across three lines', () => {
  const r = thread('python', ['x = """a', '# not a comment', 'b""" + 1']);
  assert.deepEqual(r.out[0], [['string', '"""a']]);
  assert.deepEqual(r.out[1], [['string', '# not a comment']]);
  assert.deepEqual(r.out[2], [['string', 'b"""'], ['number', '1']]);
  assert.equal(r.state, INIT);
  const s = thread('python', ["y = '''q", "r''' z = 'x'"]);
  assert.deepEqual(s.out[1], [['string', "r'''"], ['string', "'x'"]]);
  assert.equal(H.tokenizeLine('python', 'y = f"""a', INIT).state, 'td');
  assert.equal(H.tokenizeLine('python', "y = '''a", INIT).state, 'ts');
  // an escaped quote does not close a triple quote early
  assert.deepEqual(tk('python', 'a\\""" x', 'td'), [['string', 'a\\""" x']]);
});

test('JavaScript template literal across three lines', () => {
  const r = thread('javascript', ['x = `a', '// not a comment ${b}', 'c` + 1']);
  assert.deepEqual(r.out[0], [['string', '`a']]);
  assert.deepEqual(r.out[1], [['string', '// not a comment ${b}']]);
  assert.deepEqual(r.out[2], [['string', 'c`'], ['number', '1']]);
  assert.equal(r.state, INIT);
  assert.deepEqual(tk('typescript', 'a \\` b` 7', 'tl'), [['string', 'a \\` b`'], ['number', '7']]);
});

test('Go raw string across lines', () => {
  const r = thread('go', ['s := `a', '// x', 'b` + 1']);
  assert.deepEqual(r.out[1], [['string', '// x']]);
  assert.deepEqual(r.out[2], [['string', 'b`'], ['number', '1']]);
  assert.equal(r.state, INIT);
});

test('Java text block across lines', () => {
  const r = thread('java', ['String s = """', '  hi // x', '  """;']);
  assert.deepEqual(r.out[1], [['string', '  hi // x']]);
  assert.equal(r.state, INIT);
});

test('HTML comment and a tag split across lines', () => {
  const c = thread('html', ['a <!-- x', '<b> y', '--> <i>']);
  assert.deepEqual(c.out[0], [['comment', '<!-- x']]);
  assert.deepEqual(c.out[1], [['comment', '<b> y']]);
  assert.deepEqual(c.out[2], [['comment', '-->'], ['tag', '<i'], ['tag', '>']]);
  const t = thread('html', ['<div', '  class="a"', '  id=b', '  data-x="long', 'value">', 'text</div>']);
  assert.deepEqual(t.out[0], [['tag', '<div']]);
  assert.deepEqual(t.out[1], [['attr', 'class'], ['string', '"a"']]);
  assert.deepEqual(t.out[2], [['attr', 'id'], ['attr', 'b']]);
  assert.deepEqual(t.out[3], [['attr', 'data-x'], ['string', '"long']]);
  assert.deepEqual(t.out[4], [['string', 'value"'], ['tag', '>']]);
  assert.deepEqual(t.out[5], [['tag', '</div'], ['tag', '>']]);
  assert.equal(t.state, INIT);
  assert.equal(H.tokenizeLine('html', '<div', INIT).state, 'tag');
  assert.equal(H.tokenizeLine('xml', '<!-- x', INIT).state, 'hc');
});

test('HTML: script and style contents are not parsed', () => {
  const r = thread('html', ['<script>', 'if (a < b) { x = "<b>"; }', '</script>']);
  assert.deepEqual(r.out[0], [['tag', '<script'], ['tag', '>']]);
  assert.deepEqual(r.out[2], [['tag', '</script'], ['tag', '>']]);
});

test('CSS block across lines, with comments in and out of the block', () => {
  const r = thread('css', ['a {', '  color: red; /* c', '  still */ margin: 0', '}', 'b { }']);
  assert.deepEqual(r.out[0], [['section', 'a']]);
  assert.deepEqual(r.out[1], [['attr', 'color'], ['comment', '/* c']]);
  assert.deepEqual(r.out[2], [['comment', '  still */'], ['attr', 'margin'], ['number', '0']]);
  assert.deepEqual(r.out[3], []);
  assert.deepEqual(r.out[4], [['section', 'b']]);
  assert.equal(r.state, INIT);
  assert.equal(H.tokenizeLine('css', 'a {', INIT).state, 'css');
  assert.equal(H.tokenizeLine('css', 'a { /* x', INIT).state, 'cbc');
  assert.equal(H.tokenizeLine('css', '/* x', INIT).state, 'bc');
  assert.deepEqual(tk('css', 'color: red; }', 'css'), [['attr', 'color']]);
  const c = thread('css', ['/* a', 'b */ p { }']);
  assert.deepEqual(c.out[1], [['comment', 'b */'], ['section', 'p']]);
});

test('CSS: rules nested inside @media are selectors, not properties', () => {
  const r = thread('css', ['@media print {', '  a { color: red }', '}']);
  assert.deepEqual(r.out[1], [['section', 'a'], ['attr', 'color']]);
  assert.equal(r.state, INIT);
});

test('Lua long comment and long string across three lines', () => {
  const r = thread('lua', ['x = 1 --[[ a', 'b "c" ]]', 'y = 2']);
  assert.deepEqual(r.out[0], [['number', '1'], ['comment', '--[[ a']]);
  assert.deepEqual(r.out[1], [['comment', 'b "c" ]]']]);
  assert.deepEqual(r.out[2], [['number', '2']]);
  const l = thread('lua', ['s = [==[a', ']] b', ']==] .. 1']);
  assert.deepEqual(l.out[1], [['string', ']] b']]);
  assert.deepEqual(l.out[2], [['string', ']==]'], ['number', '1']]);
  assert.equal(l.state, INIT);
  assert.equal(H.tokenizeLine('lua', 'a --[==[ x', INIT).state, 'lc2');
  assert.equal(H.tokenizeLine('lua', 'a [[ x', INIT).state, 'ls0');
  assert.deepEqual(tk('lua', 'a --[ not long'), [['comment', '--[ not long']]);
});

test('PowerShell block comment across three lines', () => {
  const r = thread('powershell', ['$a = 1 <# x', 'if ($b) { } # no', '#> $c']);
  assert.deepEqual(r.out[0], [['variable', '$a'], ['number', '1'], ['comment', '<# x']]);
  assert.deepEqual(r.out[1], [['comment', 'if ($b) { } # no']]);
  assert.deepEqual(r.out[2], [['comment', '#>'], ['variable', '$c']]);
  assert.equal(r.state, INIT);
  assert.equal(H.tokenizeLine('powershell', '<# x', INIT).state, 'bc');
});

test('states are by value and limited to the language; foreign states are ignored', () => {
  assert.equal(H.tokenizeLine('python', 'x # y', 'bc').state, INIT);
  assert.deepEqual(tk('python', '1 # c', 'bc'), [['number', '1'], ['comment', '# c']]);
  assert.deepEqual(tk('javascript', '1', { evil: true }), [['number', '1']]);
  assert.deepEqual(tk('json', '1', 'td'), [['number', '1']]);
  assert.ok(H.sameState(H.tokenizeLine('c', '/* a', INIT).state, H.tokenizeLine('java', '/* b', INIT).state));
});

// -------------------------------------------------- unknown input, limits

test('unknown language, plain and hostile arguments return no tokens and pass the state through', () => {
  for (const lang of ['plain', 'nope', '', '__proto__', 'constructor', 'toString', 'hasOwnProperty', null, undefined, 5, {}, []]) {
    const r = H.tokenizeLine(lang, 'if (x) "a" // 1', 'bc');
    assert.deepEqual(r.tokens, []);
    assert.equal(r.state, 'bc');
  }
  for (const line of [null, undefined, 5, {}, [], ['a']]) {
    const r = H.tokenizeLine('javascript', line, 'tl');
    assert.deepEqual(r.tokens, []);
    assert.equal(r.state, 'tl');
  }
  assert.deepEqual(H.tokenizeLine('javascript', 'x', undefined).tokens, []);
  assert.doesNotThrow(() => H.tokenizeLine());
});

test('a line over 20,000 characters is not coloured and the state resets to initialState()', () => {
  const ok = 'a'.repeat(19999) + '1';
  assert.equal(ok.length, 20000);
  const r20000 = H.tokenizeLine('javascript', '/*'.repeat(10000), INIT);
  assert.equal(r20000.state, 'bc');
  const long = '/*' + 'x'.repeat(20000);
  const r = H.tokenizeLine('javascript', long, 'bc');
  assert.deepEqual(r.tokens, []);
  assert.equal(r.state, INIT);
  assert.deepEqual(H.tokenizeLine('python', 'x'.repeat(20001), 'td'), { tokens: [], state: INIT });
});

test('state of plain text and bad lang is the state passed in (not normalised)', () => {
  assert.equal(H.tokenizeLine('plain', 'x', 'zzz').state, 'zzz');
});

// -------------------------------------------------------------- performance

const NASTY = {
  dq: '"', sq: "'", bt: '`', slash: '/', star: '*', cstart: '/*', hash: '#', dash: '-', lt: '<', brace: '{',
  bslash: '\\', space: ' ', a: 'a', dqbs: '"\\',
};
const timings = [];
test('performance: 20,000-character awkward lines finish under 50 ms in every language', () => {
  for (const lang of COLOURED) {
    for (const [name, unit] of Object.entries(NASTY)) {
      const line = unit.repeat(Math.ceil(20000 / unit.length)).slice(0, 20000);
      assert.equal(line.length, 20000);
      for (const st of [INIT]) {
        const t0 = process.hrtime.bigint();
        const r = H.tokenizeLine(lang, line, st);
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        timings.push([ms, lang, name]);
        checkInvariants(line, r.tokens);
        assert.ok(ms < 50, `${lang} ${name}: ${ms.toFixed(1)} ms`);
      }
    }
  }
  timings.sort((a, b) => b[0] - a[0]);
  console.log(`slowest: ${timings[0][1]} ${timings[0][2]} ${timings[0][0].toFixed(2)} ms over ${timings.length} cases`);
});

test('performance: more awkward shapes (variables, percent, brackets, equals, dots)', () => {
  const shapes = ['$', '${', '%', '%a', '@', ':', '=', '.', '1', '0x', '1e', '<!--', '-->', '[', '[=', '[[', ']]', 'r#', "'a", '$(', '<#', '#>', '"""', "'''", '~', '- ', '# ', ': '];
  for (const lang of COLOURED) {
    for (const unit of shapes) {
      const line = unit.repeat(Math.ceil(20000 / unit.length)).slice(0, 20000);
      const t0 = process.hrtime.bigint();
      const r = H.tokenizeLine(lang, line, INIT);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      checkInvariants(line, r.tokens);
      assert.ok(ms < 50, `${lang} ${JSON.stringify(unit)}: ${ms.toFixed(1)} ms`);
    }
  }
});

test('performance: carried-in multi-line states on a long line are also linear', () => {
  const line = '"\\'.repeat(10000);
  for (const [lang, st] of [['python', 'td'], ['javascript', 'tl'], ['go', 'gb'], ['lua', 'lc3'], ['c', 'bc'], ['html', 'hc'], ['html', 'tq"'], ['css', 'cbc']]) {
    const t0 = process.hrtime.bigint();
    const r = H.tokenizeLine(lang, line, st);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    checkInvariants(line, r.tokens);
    assert.ok(ms < 50, `${lang} ${st}: ${ms.toFixed(1)} ms`);
  }
});

// --------------------------------------------------------------------- fuzz

test('fuzz: tokens never overlap, never exceed the line, never empty; never throws', () => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const alphabet = ['"', "'", '`', '/', '*', '#', '-', '<', '>', '{', '}', '\\', '$', '%', '@', ':', '=', '[', ']', '(', ')', '!', '?', ';',
    'a', 'b', 'e', 'i', 'f', 'r', 'x', 'if', 'rem', '0', '1', '9', ' ', ' ', '\t'];
  const pool = ['0'];
  for (let k = 0; k < 20000; k++) {
    const lang = H.LANGUAGE_IDS[Math.floor(rnd() * H.LANGUAGE_IDS.length)];
    const len = Math.floor(rnd() * 40);
    let s = '';
    for (let j = 0; j < len; j++) s += alphabet[Math.floor(rnd() * alphabet.length)];
    const st = pool[Math.floor(rnd() * pool.length)];
    const r = H.tokenizeLine(lang, s, st);
    checkInvariants(s, r.tokens);
    assert.equal(typeof r.state, 'string');
    if (pool.length < 200 && !pool.includes(r.state)) pool.push(r.state);
    // Re-running is deterministic and does not mutate anything.
    assert.deepEqual(H.tokenizeLine(lang, s, st), r);
  }
  assert.ok(pool.length > 5, 'saw several states: ' + pool.join(','));
});

// ------------------------------------------------------------ matchBracket

function doc(text, lang = 'javascript') {
  const lines = text.split('\n');
  const states = [INIT];
  for (let i = 0; i < lines.length; i++) states.push(H.tokenizeLine(lang, lines[i], states[i]).state);
  return { lang, lines, getLine: (i) => lines[i], count: lines.length, stateAt: (i) => states[i] };
}
function mb(text, line, column, lang = 'javascript') {
  const d = doc(text, lang);
  return H.matchBracket(d.getLine, d.count, line, column, lang, d.stateAt);
}
const pos = (l, c) => ({ line: l, column: c });

test('matchBracket: adjacent pairs and the three bracket kinds', () => {
  assert.deepEqual(mb('()', 0, 1), { open: pos(0, 0), close: pos(0, 1) });
  assert.deepEqual(mb('()', 0, 2), { open: pos(0, 0), close: pos(0, 1) });
  assert.deepEqual(mb('[]', 0, 1), { open: pos(0, 0), close: pos(0, 1) });
  assert.deepEqual(mb('{}', 0, 0), { open: pos(0, 0), close: pos(0, 1) });
  assert.deepEqual(mb('a(b)c', 0, 2), { open: pos(0, 1), close: pos(0, 3) });
  assert.equal(mb('abc', 0, 1), null);
});

test('matchBracket: nested pairs, mixed kinds, either direction', () => {
  const t = 'f(a[1], {b: (2)})';
  assert.deepEqual(mb(t, 0, 2), { open: pos(0, 1), close: pos(0, 16) });
  assert.deepEqual(mb(t, 0, 17), { open: pos(0, 1), close: pos(0, 16) });
  assert.deepEqual(mb(t, 0, 3), { open: pos(0, 3), close: pos(0, 5) });
  assert.deepEqual(mb(t, 0, 9), { open: pos(0, 8), close: pos(0, 15) });
  assert.deepEqual(mb('((x))', 0, 1), { open: pos(0, 0), close: pos(0, 4) });
  assert.deepEqual(mb('((x))', 0, 2), { open: pos(0, 1), close: pos(0, 3) });
  // different kinds do not interfere with the count
  assert.deepEqual(mb('( [ ) ]', 0, 1), { open: pos(0, 0), close: pos(0, 4) });
});

test('matchBracket: across lines, both directions', () => {
  const t = 'if (a) {\n  b(\n    c\n  );\n}';
  assert.deepEqual(mb(t, 0, 8), { open: pos(0, 7), close: pos(4, 0) });
  assert.deepEqual(mb(t, 4, 1), { open: pos(0, 7), close: pos(4, 0) });
  assert.deepEqual(mb(t, 1, 4), { open: pos(1, 3), close: pos(3, 2) });
  assert.deepEqual(mb(t, 3, 3), { open: pos(1, 3), close: pos(3, 2) });
});

test('matchBracket: brackets in strings and comments are ignored', () => {
  assert.deepEqual(mb('f(")" + a)', 0, 2), { open: pos(0, 1), close: pos(0, 9) });
  assert.deepEqual(mb('f(a /* ) */ )', 0, 2), { open: pos(0, 1), close: pos(0, 12) });
  assert.deepEqual(mb('f(a // )\n)', 0, 2), { open: pos(0, 1), close: pos(1, 0) });
  assert.equal(mb('f(")")', 0, 4), null, 'caret next to a string bracket: not a bracket');
  assert.equal(mb('"("', 0, 2), null);
  assert.equal(mb('// (', 0, 4), null);
  assert.equal(mb('x /* ( */', 0, 6), null);
  // multi-line template literal: bracket on a middle line is inside the string
  const t = 'f(`a\n)\n` )';
  assert.deepEqual(mb(t, 0, 2), { open: pos(0, 1), close: pos(2, 2) });
  // python comment with hash, lua long comment
  assert.deepEqual(mb('f(a # )\n)', 0, 2, 'python'), { open: pos(0, 1), close: pos(1, 0) });
  assert.deepEqual(mb('f(a --[[ )\n ]] )', 0, 2, 'lua'), { open: pos(0, 1), close: pos(1, 4) });
});

test('matchBracket: unbalanced input gives null', () => {
  assert.equal(mb('(', 0, 1), null);
  assert.equal(mb(')', 0, 0), null);
  assert.equal(mb('(()', 0, 0), null);
  assert.deepEqual(mb('(()', 0, 1), { open: pos(0, 1), close: pos(0, 2) }, 'falls back to the bracket after the caret');
  assert.equal(mb('(]', 0, 1), null);
  assert.equal(mb('a\n(\nb', 1, 1), null);
});

test('matchBracket: caret between )( prefers the bracket before the caret', () => {
  assert.deepEqual(mb('(a)(b)', 0, 3), { open: pos(0, 0), close: pos(0, 2) });
  assert.deepEqual(mb('(a)(b)', 0, 2), { open: pos(0, 0), close: pos(0, 2) });
  assert.deepEqual(mb('(a)(b)', 0, 4), { open: pos(0, 3), close: pos(0, 5) });
  // the bracket before the caret has no partner: fall back to the one after
  assert.deepEqual(mb(')(a)', 0, 1), { open: pos(0, 1), close: pos(0, 3) });
});

test('matchBracket: the 5,000-line cap', () => {
  const lines = ['('];
  for (let i = 0; i < 6000; i++) lines.push('x');
  lines[5000] = ')';
  const get = (i) => lines[i];
  assert.deepEqual(H.matchBracket(get, lines.length, 0, 1, 'c', () => INIT), { open: pos(0, 0), close: pos(5000, 0) });
  lines[5000] = 'x';
  lines[5001] = ')';
  assert.equal(H.matchBracket(get, lines.length, 0, 1, 'c', () => INIT), null);
  // backwards
  const back = ['('];
  for (let i = 0; i < 6000; i++) back.push('x');
  back[6000] = ')';
  assert.deepEqual(H.matchBracket((i) => back[i], back.length, 5000, 0, 'c'), null);
  assert.equal(H.matchBracket((i) => back[i], back.length, 6000, 1, 'c'), null);
  back[6000] = 'x'; back[1000] = '(';
  back[5999] = ')'; back[0] = 'x';
  assert.deepEqual(H.matchBracket((i) => back[i], back.length, 5999, 1, 'c'), { open: pos(1000, 0), close: pos(5999, 0) });
});

test('matchBracket: 200,000 lines of "(" returns null quickly', () => {
  const N = 200000;
  const t0 = process.hrtime.bigint();
  const r = H.matchBracket(() => '(', N, 0, 1, 'javascript', () => INIT);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(r, null);
  assert.ok(ms < 200, `took ${ms.toFixed(1)} ms`);
  const t1 = process.hrtime.bigint();
  assert.equal(H.matchBracket(() => ')', N, N - 1, 1, 'javascript', () => INIT), null);
  assert.ok(Number(process.hrtime.bigint() - t1) / 1e6 < 200);
});

test('matchBracket: very long lines stay bounded', () => {
  const big = '(' + '"a" '.repeat(5000) + '(';
  const t0 = process.hrtime.bigint();
  assert.equal(H.matchBracket(() => big, 3000, 0, 1, 'javascript', () => INIT), null);
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 1000);
});

test('matchBracket: missing or odd stateAt is treated as the initial state', () => {
  const lines = ['x = `a', ')', '` (b)'];
  const get = (i) => lines[i];
  // without the carried state line 2 starts in the initial state, so its backtick opens a template literal
  assert.equal(H.matchBracket(get, 3, 2, 3, 'javascript', undefined), null);
  assert.equal(H.matchBracket(get, 3, 2, 3, 'javascript', () => undefined), null);
  assert.equal(H.matchBracket(get, 3, 2, 3, 'javascript', () => { throw new Error('x'); }), null);
  assert.deepEqual(H.matchBracket(get, 3, 2, 3, 'javascript', (i) => ['0', 'tl', 'tl'][i]), { open: pos(2, 2), close: pos(2, 4) });
});

test('matchBracket: unknown language still matches (nothing is a string or comment)', () => {
  assert.deepEqual(mb('f(")")', 0, 1, 'plain'), { open: pos(0, 1), close: pos(0, 3) });
  assert.deepEqual(mb('f(")")', 0, 1, 'javascript'), { open: pos(0, 1), close: pos(0, 5) });
  assert.deepEqual(mb('(a)', 0, 1, 'nope'), { open: pos(0, 0), close: pos(0, 2) });
});

test('matchBracket: hostile arguments return null and never throw', () => {
  const get = (i) => ['(a)', 'b'][i];
  const bad = [undefined, null, NaN, Infinity, -1, 1.5, '1', {}, [], 1e12, 2 ** 53];
  for (const v of bad) {
    if (!Number.isInteger(v) || v < 1) assert.equal(H.matchBracket(get, v, 0, 1, 'c', () => INIT), null);
    assert.equal(H.matchBracket(get, 2, v, 1, 'c', () => INIT), null);
    assert.equal(H.matchBracket(get, 2, 0, v, 'c', () => INIT), null);
  }
  assert.equal(H.matchBracket(null, 2, 0, 1, 'c'), null);
  assert.equal(H.matchBracket('x', 2, 0, 1, 'c'), null);
  assert.equal(H.matchBracket(get, 0, 0, 0, 'c'), null);
  assert.equal(H.matchBracket(get, 2, 2, 0, 'c'), null);
  assert.equal(H.matchBracket(get, 2, 0, 4, 'c'), null);
  assert.equal(H.matchBracket(() => 5, 2, 0, 0, 'c'), null);
  assert.equal(H.matchBracket(() => { throw new Error('x'); }, 2, 0, 0, 'c'), null);
  assert.equal(H.matchBracket(() => null, 2, 0, 0, 'c'), null);
  assert.deepEqual(H.matchBracket(get, 2, 0, 1, undefined, undefined), { open: pos(0, 0), close: pos(0, 2) });
  assert.deepEqual(H.matchBracket(get, 2, 0, 1, {}, 5), { open: pos(0, 0), close: pos(0, 2) });
  assert.doesNotThrow(() => H.matchBracket());
  // a line that goes missing during the scan is skipped
  const holes = ['(', null, undefined, 7, ')'];
  assert.deepEqual(H.matchBracket((i) => holes[i], 5, 0, 1, 'c'), { open: pos(0, 0), close: pos(4, 0) });
});
