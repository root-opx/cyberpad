'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../js/core/texttools.js');

test('stats and position', () => {
  assert.deepEqual(T.stats('hello world\nsecond line'), { chars: 23, words: 4, lines: 2, readingMinutes: 1 });
  assert.deepEqual(T.stats(''), { chars: 0, words: 0, lines: 1, readingMinutes: 0 });
  assert.deepEqual(T.position('ab\ncd', 4), { line: 2, col: 2 });
});

test('deriveTitle skips markup and blank lines', () => {
  assert.equal(T.deriveTitle('\n\n# Shopping list\n- eggs'), 'Shopping list');
  assert.equal(T.deriveTitle('- [ ] call mom'), 'call mom');
  assert.equal(T.deriveTitle('```\ncode'), 'code');
  assert.equal(T.deriveTitle('   '), 'Untitled');
});

test('extractTags ignores code and hex colours', () => {
  const body = '#Work notes #idea\n`#notatag`\n```\n#alsonot\n```\ncolour #ff00aa and (#urgent)';
  assert.deepEqual(T.extractTags(body), ['idea', 'urgent', 'work']);
});

test('extractWikiLinks and headings', () => {
  assert.deepEqual(T.extractWikiLinks('see [[Ideas]] and [[Plan|the plan]]'), ['Ideas', 'Plan']);
  assert.deepEqual(T.headings('# A\n```\n# not\n```\n## B'), [{ level: 1, text: 'A', line: 0 }, { level: 2, text: 'B', line: 4 }]);
});

test('list continuation', () => {
  assert.deepEqual(T.listContinuation('- item'), { prefix: '- ', empty: false });
  assert.deepEqual(T.listContinuation('  - [x] done'), { prefix: '  - [ ] ', empty: false });
  assert.deepEqual(T.listContinuation('9. step'), { prefix: '10. ', empty: false });
  assert.deepEqual(T.listContinuation('- [ ]'), { prefix: '- [ ] ', empty: true });
  assert.deepEqual(T.listContinuation('> quote'), { prefix: '> ', empty: false });
  assert.equal(T.listContinuation('plain'), null);
});

test('toggleTask cycles states', () => {
  assert.equal(T.toggleTask('- [ ] a'), '- [x] a');
  assert.equal(T.toggleTask('- [x] a'), '- [ ] a');
  assert.equal(T.toggleTask('- a'), '- [ ] a');
  assert.equal(T.toggleTask('  a'), '  - [ ] a');
});

test('transforms', () => {
  const X = T.TRANSFORMS;
  assert.equal(X.title('hello wORLD'), 'Hello World');
  assert.equal(X.sortLines('b\na10\na2'), 'a2\na10\nb');
  assert.equal(X.dedupeLines('a\nb\na'), 'a\nb');
  assert.equal(X.base64Decode(X.base64Encode('héllo ✓')), 'héllo ✓');
  assert.equal(X.jsonMinify('{ "a": [1, 2] }'), '{"a":[1,2]}');
  assert.throws(() => X.jsonPretty('{nope}'), T.TransformError);
  assert.throws(() => X.base64Decode('***'), T.TransformError);
  assert.throws(() => X.base64Decode('/w=='), T.TransformError); // 0xFF is not UTF-8
  assert.throws(() => X.urlDecode('%E0%A4%A'), T.TransformError);
});

test('numberStats', () => {
  assert.deepEqual(T.numberStats('3 apples, 4.5 kg, -1.5'), { count: 3, sum: 6, avg: 2, min: -1.5, max: 4.5 });
  assert.equal(T.numberStats('none here v2'), null);
});

test('slash expansions', () => {
  const ctx = { now: new Date(2026, 10, 23, 9, 5), uuid: () => 'fixed-uuid' };
  assert.deepEqual(T.expandSlash('date', ctx), { text: '2026-11-23', caret: 10, block: false });
  assert.deepEqual(T.expandSlash('time', ctx), { text: '09:05', caret: 5, block: false });
  assert.equal(T.expandSlash('week', ctx).text, 'Week 48, 2026');
  const table = T.expandSlash('table', ctx);
  assert.equal(table.text.slice(table.caret - 2, table.caret + 2), '|  |'); // caret inside first body cell
  assert.equal(T.expandSlash('nope', ctx), null);
  const cred = T.expandSlash('credentials', ctx);
  assert.equal(cred.text, T.credentialsTemplate(ctx.now));
  assert.equal(cred.block, true);
  assert.ok(T.SLASH.some((c) => c.name === 'credentials' && c.desc === 'New encrypted credentials note'));
});

test('slash list: /ctf and /writeup are listed, and the page (not texttools) expands them', () => {
  const ctx = { now: new Date(2026, 10, 23, 9, 5), uuid: () => 'fixed-uuid' };
  assert.ok(T.SLASH.some((c) => c.name === 'ctf' && c.desc === 'CTF challenge template'));
  assert.ok(T.SLASH.some((c) => c.name === 'writeup' && c.desc === 'CTF writeup template'));
  assert.equal(T.expandSlash('ctf', ctx), null);
  assert.equal(T.expandSlash('writeup', ctx), null);
  assert.equal(new Set(T.SLASH.map((c) => c.name)).size, T.SLASH.length);
});

test('fuzzyScore ranks substring and subsequence matches', () => {
  assert.ok(T.fuzzyScore('new', 'New note') > T.fuzzyScore('new', 'Renew everything'));
  assert.ok(T.fuzzyScore('nn', 'New note') > 0);
  assert.equal(T.fuzzyScore('xyz', 'New note'), -1);
});

test('slugify', () => {
  assert.equal(T.slugify('Café Plans: 2026!'), 'cafe-plans-2026');
  assert.equal(T.slugify('***'), 'note');
});

test('engagement templates and UTC stamps', () => {
  const { parse } = require('../js/core/markdown.js');
  const now = new Date(Date.UTC(2026, 10, 23, 14, 5, 12));
  assert.equal(T.utcStamp(now), '2026-11-23 14:05:12 UTC');
  assert.equal(T.utcStamp(now, false), '2026-11-23 14:05 UTC');
  assert.deepEqual(T.expandSlash('utc', { now }), { text: '2026-11-23 14:05:12 UTC', caret: 23, block: false });

  const f = T.expandSlash('finding', { now });
  assert.equal(f.block, true);
  assert.equal(f.text.slice(0, f.caret), '## Finding: ');
  assert.match(f.text, /- \*\*Reported:\*\* 2026-11-23 14:05 UTC/);
  assert.deepEqual(parse(f.text).filter((b) => b.type === 'heading').map((b) => b.level), [2, 3, 3, 3, 3, 3, 3]);

  for (const name of ['ioc', 'timeline']) {
    const ex = T.expandSlash(name, { now });
    assert.equal(ex.block, true);
    const [table] = parse(ex.text);
    assert.equal(table.type, 'table', name);
    assert.equal(ex.text.slice(ex.caret - 2, ex.caret), '| ');
  }
  assert.match(T.expandSlash('timeline', { now }).text, /\| 2026-11-23 14:05:12 UTC \| {2}\|/);
  assert.equal(T.expandSlash('nope', { now }), null);
});

test('sectionOf merges Theme, Templates and Transform and leaves the rest', () => {
  assert.equal(T.sectionOf('Theme'), 'Settings');
  assert.equal(T.sectionOf('Templates'), 'Insert');
  assert.equal(T.sectionOf('Transform'), 'Text');
  for (const g of ['Note', 'File', 'Edit', 'Format', 'Text', 'Insert', 'View', 'Settings', 'Tools', 'CTF', 'Vault', 'Security', 'Recent notes']) assert.equal(T.sectionOf(g), g);
  assert.equal(T.sectionOf('__proto__'), '__proto__');
});

test('paletteSections orders, merges, drops empty sections and keeps item order', () => {
  const items = [
    { group: 'Security', title: 's1' }, { group: 'Templates', title: 't1' }, { group: 'Note', title: 'n1' },
    { group: 'Insert', title: 'i1' }, { group: 'Theme', title: 'th1' }, { group: 'Recent notes', title: 'r1' },
    { group: 'View', title: 'v1' }, { group: 'Transform', title: 'x1' },
  ];
  const out = T.paletteSections(items);
  assert.deepEqual(out.map((s) => s.name), ['Recent notes', 'Note', 'Text', 'Insert', 'View', 'Settings', 'Security']);
  assert.deepEqual(out.find((s) => s.name === 'Insert').items.map((i) => i.title), ['t1', 'i1']);
  assert.deepEqual(out.find((s) => s.name === 'Settings').items.map((i) => i.title), ['th1']);
  assert.equal(items.length, 8);
});

test('paletteSections handles no items, one section and unknown groups', () => {
  assert.deepEqual(T.paletteSections([]), []);
  assert.deepEqual(T.paletteSections([{ group: 'Vault', title: 'a' }]).map((s) => s.name), ['Vault']);
  const out = T.paletteSections([{ group: 'Zed', title: 'z' }, { group: 'Note', title: 'n' }, { group: 'constructor', title: 'c' }]);
  assert.deepEqual(out.map((s) => s.name), ['Note', 'Zed', 'constructor']);
});

test('paletteScore still matches old group names and also the new section names', () => {
  const upper = { group: 'Transform', title: 'UPPERCASE' };
  const finding = { group: 'Templates', title: 'Insert pentest finding' };
  const amber = { group: 'Theme', title: 'Theme: Amber' };
  assert.ok(T.paletteScore('transform', upper) > 0);
  assert.ok(T.paletteScore('text', upper) > 0);
  assert.ok(T.paletteScore('templates', finding) > 0);
  assert.ok(T.paletteScore('theme', amber) > 0);
  assert.ok(T.paletteScore('settings', amber) > 0);
  assert.ok(T.paletteScore('settings', { group: 'Settings', title: 'Turn on CRT effect' }) > 0);
  assert.ok(T.paletteScore('zzzz', upper) <= 0);
  assert.equal(T.paletteScore('upper', upper), T.fuzzyScore('upper', 'UPPERCASE'));
});

const type = (before, ch, after = '') => T.arrowReplacement(before + ch + after, before.length + 1, ch);

test('arrowReplacement turns typed ASCII arrows into real ones', () => {
  assert.deepEqual(type('a -', '>'), { start: 2, end: 4, insert: '→' });
  assert.deepEqual(type('-', '>'), { start: 0, end: 2, insert: '→' });
  assert.deepEqual(type('x <', '-'), { start: 2, end: 4, insert: '←' });
  assert.deepEqual(type('a =', '>'), { start: 2, end: 4, insert: '⇒' });
  assert.deepEqual(type('a ←', '>'), { start: 2, end: 4, insert: '↔' });
  assert.deepEqual(type('a -', '>', ' b'), { start: 2, end: 4, insert: '→' });
});

test('arrowReplacement leaves look-alikes alone', () => {
  for (const [before, ch] of [['--', '>'], ['<!--', '>'], ['<-', '>'], ['cat <<', '-'], ['a ==', '>'], ['a <=', '>'], ['a >=', '>'], ['a !=', '>'], ['', '>'], ['a', '>'], ['a -', 'x'], ['a -', '']]) {
    assert.equal(type(before, ch), null, `${before}${ch}`);
  }
  assert.equal(T.arrowReplacement('->', 5, '>'), null);
  assert.equal(T.arrowReplacement('->', -1, '>'), null);
  assert.equal(T.arrowReplacement(null, 2, '>'), null);
});

test('arrowReplacement never fires in code', () => {
  assert.equal(type('```\nptr-', '>'), null);
  assert.equal(type('~~~sh\na -', '>'), null);
  assert.equal(type('use `a-', '>'), null);
  assert.deepEqual(type('```\ncode\n```\nprose -', '>'), { start: 19, end: 21, insert: '→' });
  assert.equal(type('```\na\n```\nb\n```\nc -', '>'), null);
  assert.deepEqual(type('`done` then -', '>'), { start: 12, end: 14, insert: '→' });
  assert.equal(T.inCodeAt('   ```\nx', 8), true);
  assert.equal(T.inCodeAt('    ```\nx', 9), false);
});

test('credentialsTemplate is the agreed table with today as the review date', () => {
  const out = T.credentialsTemplate(new Date(2026, 10, 25));
  assert.equal(out, '# Credentials\n\n| System | Username | Password | URL | Notes |\n| --- | --- | --- | --- | --- |\n|  |  |  |  |  |\n\nLast reviewed: 2026-11-25\n');
});

test('inCodeAt: a four-backtick fence opens code and any later fence line of three or more backticks closes it', () => {
  assert.equal(T.inCodeAt('````\nx', 6), true);
  assert.equal(T.inCodeAt('````\nx\n````\ny', 13), false);
  assert.equal(T.inCodeAt('````\nx\n```\nz', 12), false); // current behaviour: the fence length is not matched
});

// ---- palette: the CTF section ----

test('PALETTE_SECTIONS: thirteen sections, Edit and Format after File, Settings after View, CTF between Tools and Vault', () => {
  assert.deepEqual([...T.PALETTE_SECTIONS], ['Recent notes', 'Note', 'File', 'Edit', 'Format', 'Text', 'Insert', 'View', 'Settings', 'Tools', 'CTF', 'Vault', 'Security']);
  assert.equal(Object.isFrozen(T.PALETTE_SECTIONS), true);
  assert.equal(T.sectionOf('CTF'), 'CTF');
  const out = T.paletteSections([{ group: 'Vault', title: 'v' }, { group: 'CTF', title: 'c' }, { group: 'Tools', title: 't' }, { group: 'Security', title: 's' }]);
  assert.deepEqual(out.map((s) => s.name), ['Tools', 'CTF', 'Vault', 'Security']);
});

// ---- selection formatting: toggleWrap, toggleLinePrefix, makeLink ----

// Text is written with markers: ¦ is the caret, « and » are the selection ends.
function mparse(marked) {
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
const mrender = (text, s, e) => (s === e ? `${text.slice(0, s)}¦${text.slice(s)}` : `${text.slice(0, s)}«${text.slice(s, e)}»${text.slice(e)}`);
const mapply = (text, r) => text.slice(0, r.start) + r.insert + text.slice(r.end);
function mrun(fn, marked, ...args) {
  const { text, start, end } = mparse(marked);
  const r = fn(text, start, end, ...args);
  if (r === null) return null;
  const next = mapply(text, r);
  assert.ok(r.selStart >= 0 && r.selStart <= r.selEnd && r.selEnd <= next.length, 'selection outside the new text');
  return mrender(next, r.selStart, r.selEnd);
}
const wrap = (marked, m) => mrun(T.toggleWrap, marked, m);
const pref = (marked, p) => mrun(T.toggleLinePrefix, marked, p);
const link = (marked) => mrun(T.makeLink, marked);

const wrapRows = (m, rows) => {
  for (const [before, after] of rows) {
    test(`toggleWrap ${m}: ${JSON.stringify(before)} gives ${JSON.stringify(after)}`, () => assert.equal(wrap(before, m), after));
  }
};

wrapRows('**', [
  ['¦', '**¦**'],
  ['x¦y', 'x**¦**y'],
  ['«foo»', '«**foo**»'],
  ['«**foo**»', '«foo»'],
  ['**«foo»**', '«foo»'],
  ['a **«foo»** b', 'a «foo» b'],
  ['«  foo  »', '«  **foo**  »'],
  ['«  **foo**  »', '«  foo  »'],
  ['«\nfoo\n»', '«\n**foo**\n»'],
  ['«a\nb»', '«**a**\n**b**»'],
  ['«a\n\nb»', '«**a**\n\n**b**»'],
  ['«**a**\n**b**»', '«a\nb»'],
  ['«**a**\nb»', '«**a**\n**b**»'],
  ['«   »', '«   »'],
  ['«a b»', '«**a b**»'],
  ['«***foo***»', '«*foo*»'],
  ['«a\r\nb»', '«**a**\r\n**b**»'],
]);
wrapRows('*', [
  ['¦', '*¦*'],
  ['«foo»', '«*foo*»'],
  ['«*foo*»', '«foo»'],
  ['*«foo»*', '«foo»'],
  ['«**foo**»', '«***foo***»'],
  ['«***foo***»', '«**foo**»'],
  ['**«foo»**', '**«*foo*»**'],
  ['«  foo »', '«  *foo* »'],
  ['«a\nb»', '«*a*\n*b*»'],
  ['«*a*\n*b*»', '«a\nb»'],
  ['«*»', '«*»'], // only marker characters: no wrap (see the marker-only tests below)
]);
wrapRows('~~', [['¦', '~~¦~~'], ['«foo»', '«~~foo~~»'], ['«~~foo~~»', '«foo»'], ['~~«foo»~~', '«foo»'], ['« foo »', '« ~~foo~~ »'], ['«a\nb»', '«~~a~~\n~~b~~»']]);
wrapRows('==', [['¦', '==¦=='], ['«foo»', '«==foo==»'], ['«==foo==»', '«foo»'], ['==«foo»==', '«foo»'], ['« foo »', '« ==foo== »'], ['«a\nb»', '«==a==\n==b==»']]);
wrapRows('`', [
  ['¦', '`¦`'],
  ['«foo»', '«`foo`»'],
  ['«`foo`»', '«foo»'],
  ['`«foo»`', '«foo»'],
  ['« foo »', '« `foo` »'],
  ['«a\nb»', '«```\na\nb\n```»'],
  ['«```\na\nb\n```»', '«a\nb»'],
  ['```\n«a\nb»\n```', '«a\nb»'],
  ['«a\n```\nb»', '«````\na\n```\nb\n````»'],
  ['«````\na\n```\nb\n````»', '«a\n```\nb»'],
  ['x «a\nb» y', '«```\nx a\nb y\n```»'],
]);

test('toggleWrap: round trips restore text and selection exactly, for every marker', () => {
  const samples = [
    '«foo»', '«foo bar»', '«  foo  »', '«\tfoo\n»', 'a «b» c', '«a\nb»', '«a\n\nb»', '«  a\n  b  »', '«é😀»', '¦', 'x¦y', '«a\r\nb»',
    '«*x*»', '«**x**»', '«~~x~~»', '«==x==»','«`x`»', '«x y z»',
  ];
  for (const m of ['**', '*', '~~', '==', '`']) {
    for (const marked of samples) {
      const { text, start, end } = mparse(marked);
      if (start === end) continue; // an empty selection only inserts a pair
      const r1 = T.toggleWrap(text, start, end, m);
      assert.ok(r1, `${m} ${marked}`);
      const t1 = mapply(text, r1);
      const r2 = T.toggleWrap(t1, r1.selStart, r1.selEnd, m);
      const label = `${m} ${JSON.stringify(marked)}`;
      assert.ok(r2, label);
      if (t1 === text) continue; // nothing to wrap
      const t2 = mapply(t1, r2);
      assert.equal(t2, text, label);
      assert.equal(r2.selStart, start, `${label} selStart`);
      assert.equal(r2.selEnd, end, `${label} selEnd`);
    }
  }
});

test('toggleWrap: wrapping and unwrapping the same text twice in a row always gets back to the text', () => {
  for (const m of ['**', '*', '~~', '==', '`']) {
    for (const body of ['foo', 'foo bar', 'é😀']) { // bodies holding the marker itself: see the separate-spans tests
      const text = `p ${body} q`;
      const start = 2;
      const end = 2 + body.length;
      const r1 = T.toggleWrap(text, start, end, m);
      const t1 = mapply(text, r1);
      assert.equal(t1, `p ${m}${body}${m} q`, `${m} ${body}`);
      const r2 = T.toggleWrap(t1, r1.selStart, r1.selEnd, m);
      assert.equal(mapply(t1, r2), text, `${m} ${body}`);
      assert.deepEqual([r2.selStart, r2.selEnd], [start, end], `${m} ${body}`);
    }
  }
});

test('toggleWrap: * on text wrapped in ** wraps it (italic) and never corrupts the bold markers', () => {
  const text = '**bold**';
  const r = T.toggleWrap(text, 0, text.length, '*');
  assert.equal(mapply(text, r), '***bold***');
  const r2 = T.toggleWrap('***bold***', 0, 10, '*');
  assert.equal(mapply('***bold***', r2), '**bold**');
  const r3 = T.toggleWrap('**bold**', 2, 6, '*');
  assert.equal(mapply('**bold**', r3), '***bold***');
  const r4 = T.toggleWrap('x **b** y', 4, 5, '**');
  assert.equal(mapply('x **b** y', r4), 'x b y');
});

test('toggleWrap: only the touched part changes', () => {
  const text = 'one two three';
  const r = T.toggleWrap(text, 4, 7, '**');
  assert.deepEqual([r.start, r.end, r.insert], [4, 7, '**two**']);
});

test('toggleWrap: bad arguments and markers outside the list give null and never throw', () => {
  for (const m of ['', '***', '_', '__', '```', '~', '=', 'x', '**\n', null, undefined, 5, {}, [], ['**'], '__proto__', ' *']) {
    assert.equal(T.toggleWrap('abc', 0, 3, m), null, JSON.stringify(m));
  }
  const pairText = 'a😀b';
  const bad = [
    [null, 0, 0], [5, 0, 0], [undefined, 0, 0], ['ab', NaN, 1], ['ab', 0.5, 1], ['ab', '0', '1'], ['ab', -1, 0], ['ab', 0, 3], ['ab', 3, 3],
    ['ab', 2, 1], ['ab', 0, Infinity], ['ab'], [pairText, 2, 2], [pairText, 1, 2], [pairText, 0, 2], [{}, 0, 0], [['a'], 0, 0],
  ];
  for (const [t, s, e] of bad) assert.equal(T.toggleWrap(t, s, e, '**'), null, JSON.stringify([t, s, e]));
});

// toggleLinePrefix

const prefRows = (p, rows) => {
  for (const [before, after] of rows) {
    test(`toggleLinePrefix ${JSON.stringify(p)}: ${JSON.stringify(before)} gives ${JSON.stringify(after)}`, () => assert.equal(pref(before, p), after));
  }
};
prefRows('> ', [
  ['a¦', '> a¦'],
  ['> a¦', 'a¦'],
  ['«a\nb»', '> «a\n> b»'],
  ['«> a\n> b»', '«a\nb»'],
  ['«> a\nb»', '> «> a\n> b»'],
  ['«a\n\nb»', '> «a\n\n> b»'],
  ['«> a\n\n> b»', '«a\n\nb»'],
  ['«a\nb\n»c', '> «a\n> b\n»c'],
  ['x\n«a»\ny', 'x\n> «a»\ny'],
  ['¦', '> ¦'],
  ['> ¦', '¦'],
  ['«\n\n»', '«\n\n»'],
  ['«a\r\nb»', '> «a\r\n> b»'],
  ['  ¦a', '  > ¦a'], // the prefix goes after the indentation
  ['«  > a»', '«  a»'],
]);
prefRows('- ', [
  ['a¦', '- a¦'],
  ['- a¦', 'a¦'],
  ['«a\nb»', '- «a\n- b»'],
  ['«- a\n- b»', '«a\nb»'],
  ['«- a\nb»', '- «- a\n- b»'],
  ['  - a¦', '  a¦'],
  ['«a\n\nb»', '- «a\n\n- b»'],
  ['¦', '- ¦'],
]);
test('toggleLinePrefix: round trips restore text and selection exactly', () => {
  const samples = ['a¦', '«a\nb»', '«a\n\nb»', '  ¦a', '«  a\n    b»', '«a\nb\n»c', 'x\n«a»\ny', '¦', '«é😀\nb»', '«a\r\nb»'];
  for (const p of ['> ', '- ']) {
    for (const marked of samples) {
      const { text, start, end } = mparse(marked);
      const r1 = T.toggleLinePrefix(text, start, end, p);
      const t1 = mapply(text, r1);
      const r2 = T.toggleLinePrefix(t1, r1.selStart, r1.selEnd, p);
      assert.equal(mapply(t1, r2), text, `${p} ${marked}`);
      assert.deepEqual([r2.selStart, r2.selEnd], [start, end], `${p} ${marked}`);
    }
  }
});
test('toggleLinePrefix: only the touched lines are replaced; prefixes outside the list give null', () => {
  const text = 'one\ntwo\nthree';
  const r = T.toggleLinePrefix(text, 5, 5, '> ');
  assert.deepEqual([r.start, r.end, r.insert], [4, 7, '> two']);
  for (const p of ['', '>', '-', '* ', '# ', '> > ', null, undefined, 5, {}, [], '__proto__']) assert.equal(T.toggleLinePrefix('a', 0, 0, p), null, JSON.stringify(p));
  for (const [t, s, e] of [[null, 0, 0], [5, 0, 0], ['ab', -1, 0], ['ab', 2, 1], ['ab', 0, 3], ['ab', 0.5, 1], ['ab', '0', 0], ['a😀', 2, 2], ['a😀', 1, 2], ['ab', NaN, 0]]) {
    assert.equal(T.toggleLinePrefix(t, s, e, '> '), null, JSON.stringify([t, s, e]));
  }
});

// makeLink

test('makeLink: selection, empty selection, URL selection', () => {
  assert.equal(link('«text»'), '[text](«url»)');
  assert.equal(link('a «two words» b'), 'a [two words](«url») b');
  assert.equal(link('¦'), '[«text»](url)');
  assert.equal(link('a¦b'), 'a[«text»](url)b');
  assert.equal(link('«https://example.com/x»'), '[«text»](https://example.com/x)');
  assert.equal(link('«http://example.com»'), '[«text»](http://example.com)');
  assert.equal(link('«HTTPS://EXAMPLE.COM»'), '[«text»](HTTPS://EXAMPLE.COM)');
  assert.equal(link('«  »'), '  [«text»](url)');
  assert.equal(link('«  word  »'), '  [word](«url»)  ');
  assert.equal(link('«  https://a.b/c  »'), '  [«text»](https://a.b/c)  ');
});
test('makeLink: what cannot be a link label is left alone; odd URLs become labels', () => {
  for (const marked of ['«a\nb»', '«a]b»', '«a[b»']) {
    const { text, start, end } = mparse(marked);
    assert.deepEqual(T.makeLink(text, start, end), { start, end: start, insert: '', selStart: start, selEnd: end }, marked);
  }
  assert.equal(link('«https://»'), '[https://](«url»)');
  assert.equal(link('«https://a b»'), '[https://a b](«url»)');
  assert.equal(link('«https://a(b)»'), '[https://a(b)](«url»)');
  assert.equal(link('«javascript:alert(1)»'), '[javascript:alert(1)](«url»)');
  assert.equal(link('«ftp://x.y»'), '[ftp://x.y](«url»)');
});
test('makeLink: bad arguments give null and never throw', () => {
  for (const [t, s, e] of [[null, 0, 0], [5, 0, 0], [undefined, 0, 0], ['ab', -1, 0], ['ab', 2, 1], ['ab', 0, 3], ['ab', 0.5, 1], ['ab', '0', 0], ['a😀', 2, 2], ['a😀', 1, 2], ['ab', NaN, 0], [{}, 0, 0], ['ab']]) {
    assert.equal(T.makeLink(t, s, e), null, JSON.stringify([t, s, e]));
  }
});

test('the selection helpers handle a 200,000-line text near its end within 50 ms', () => {
  const text = Array.from({ length: 200000 }, (_, i) => `line ${i}`).join('\n');
  const p = text.length - 3;
  const jobs = [
    () => T.toggleWrap(text, p, p + 2, '**'),
    () => T.toggleLinePrefix(text, p, p, '> '),
    () => T.makeLink(text, p, p + 2),
  ];
  for (const job of jobs) {
    job();
    const t0 = process.hrtime.bigint();
    const r = job();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(r);
    assert.ok(ms < 50, `${ms} ms`);
  }
});

// ---- review fixes: block syntax, direction, marker-only, spans, code, fences, links, indentation ----

// 1. Wrapping goes after the block prefix; fences, rules, table separators and blank lines are left alone.
for (const m of ['**', '*', '~~', '==']) {
  const w = (t) => wrap(t, m);
  test(`toggleWrap ${m}: a list, quote, heading, task or numbered line is wrapped after its prefix`, () => {
    assert.equal(w('«- one\n- two»'), `«- ${m}one${m}\n- ${m}two${m}»`);
    assert.equal(w('«# Title»'), `«# ${m}Title${m}»`);
    assert.equal(w('«> a»'), `«> ${m}a${m}»`);
    assert.equal(w('«> > a\n> b»'), `«> > ${m}a${m}\n> ${m}b${m}»`);
    assert.equal(w('«1. a\n22) b»'), `«1. ${m}a${m}\n22) ${m}b${m}»`);
    assert.equal(w('«- [ ] a\n- [x] b\n- [X] c»'), `«- [ ] ${m}a${m}\n- [x] ${m}b${m}\n- [X] ${m}c${m}»`);
    assert.equal(w('«  - a\n    + b»'), `«  - ${m}a${m}\n    + ${m}b${m}»`);
    assert.equal(w('«> - [ ] a»'), `«> - [ ] ${m}a${m}»`);
    assert.equal(w('«###### h»'), `«###### ${m}h${m}»`);
    assert.equal(w('«####### h»'), `«${m}####### h${m}»`); // seven # is not a heading marker
    assert.equal(w('«1234567890. x»'), `«${m}1234567890. x${m}»`); // ten digits are not an ordered marker
  });
  test(`toggleWrap ${m}: fence lines, fenced lines, rules, table separators and blank lines stay as they are`, () => {
    assert.equal(w('«```\ncode\n```»'), '«```\ncode\n```»');
    assert.equal(w('«~~~\ncode\n~~~»'), '«~~~\ncode\n~~~»');
    assert.equal(w('«a\n```js\nb\n```\nc»'), `«${m}a${m}\n\`\`\`js\nb\n\`\`\`\n${m}c${m}»`);
    assert.equal(w('«---\na\n***\n___\n- - -»'), `«---\n${m}a${m}\n***\n___\n- - -»`);
    assert.equal(w('«| --- | :-: |\na»'), `«| --- | :-: |\n${m}a${m}»`);
    assert.equal(w('«a\n\n  \nb»'), `«${m}a${m}\n\n  \n${m}b${m}»`);
  });
  test(`toggleWrap ${m}: a selection that starts inside a fenced block leaves the fenced lines alone`, () => {
    assert.equal(w('```\n«a\nb»\n```'), '```\n«a\nb»\n```');
    assert.equal(w('```\nx\n```\n«a\n```\nb\n```\nc»'), `\`\`\`\nx\n\`\`\`\n«${m}a${m}\n\`\`\`\nb\n\`\`\`\n${m}c${m}»`);
    assert.equal(w('~~~\n«a»\n~~~'), '~~~\n«a»\n~~~'); // one line starting at its first character
    assert.equal(w('```\nsome «word» here\n```'), `\`\`\`\nsome «${m}word${m}» here\n\`\`\``); // inside a line: as asked
  });
  test(`toggleWrap ${m}: one line selected from its first character skips the block prefix; inside a line it does not`, () => {
    assert.equal(w('«- item»'), `«- ${m}item${m}»`);
    assert.equal(w('- «item»'), `- «${m}item${m}»`);
    assert.equal(w(`«- ${m}item${m}»`), '«- item»');
    assert.equal(w('«-»'), `«${m}-${m}»`);
    assert.equal(w('«- »'), '«- »');
    assert.equal(w('«#»'), `«${m}#${m}»`);
  });
  test(`toggleWrap ${m}: wrap then unwrap restores prefixed text exactly`, () => {
    const samples = [
      '«- one\n- two»', '«# Title\n\ntext»', '«> a\n> > b»', '«1. a\n2. b»', '«- [ ] a\n  - [x] b»', '«a\n```\nb\n```\n---\nc»', '«- a\r\n- b»', '«| a |\n| - |\nz»',
    ];
    for (const marked of samples) {
      const { text, start, end } = mparse(marked);
      const r1 = T.toggleWrap(text, start, end, m);
      const t1 = mapply(text, r1);
      assert.notEqual(t1, text, marked);
      const r2 = T.toggleWrap(t1, r1.selStart, r1.selEnd, m);
      assert.equal(mapply(t1, r2), text, `${m} ${marked}`);
      assert.deepEqual([r2.selStart, r2.selEnd], [start, end], `${m} ${marked}`);
    }
  });
}
test('toggleWrap: the examples from the review', () => {
  assert.equal(wrap('«- one\n- two»', '**'), '«- **one**\n- **two**»');
  assert.equal(wrap('«# Title»', '=='), '«# ==Title==»');
  assert.equal(wrap('«> a»', '*'), '«> *a*»');
  assert.equal(wrap('«```\nx\n```»', '**'), '«```\nx\n```»');
});

// 2. The direction is decided once per call.
test('toggleWrap: a mixed selection is wrapped, and the next toggle unwraps every line (the typed markers go too)', () => {
  const t0 = '**a**\nb';
  const r1 = T.toggleWrap(t0, 0, t0.length, '**');
  const t1 = mapply(t0, r1);
  assert.equal(t1, '**a**\n**b**'); // only the unwrapped line changed
  const r2 = T.toggleWrap(t1, r1.selStart, r1.selEnd, '**');
  // Now the selection is uniform (every line wrapped), so it is unwrapped as a whole: the line that was wrapped
  // before the first toggle loses its markers too, but only because it is part of a uniform selection now.
  assert.equal(mapply(t1, r2), 'a\nb');
});
test('toggleWrap: a block where every line is wrapped is unwrapped; one plain line makes it a wrap of that line only', () => {
  assert.equal(wrap('«- **a**\n- **b**»', '**'), '«- a\n- b»');
  assert.equal(wrap('«- **a**\n- b\n- **c**»', '**'), '«- **a**\n- **b**\n- **c**»');
});

// 3. A selection of only marker characters is plain text.
test('toggleWrap: a selection of only marker characters is left alone, for every marker', () => {
  for (const [m, sel] of [['**', '**'], ['**', '****'], ['**', '*'], ['*', '*'], ['*', '**'], ['*', '****'], ['~~', '~~'], ['~~', '~'], ['==', '=='], ['==', '====']]) {
    for (const [pre, post] of [['', ''], ['a ', ' b'], ['  ', '']]) {
      const marked = `${pre}«${sel}»${post}`;
      assert.equal(wrap(marked, m), marked, `${m} ${marked}`);
    }
  }
  assert.equal(wrap('«**a»', '**'), '«****a**»'); // other characters next to markers are still wrapped
});

// 4. Two separate spans are not one.
test('toggleWrap: ends that belong to different spans give a no-op result, inside and outside the selection', () => {
  const same = (marked, m) => assert.equal(wrap(marked, m), marked, `${m} ${marked}`);
  same('«*b* c *d*»', '*');
  same('«**b** c **d**»', '**');
  same('«~~b~~ c ~~d~~»', '~~');
  same('«==b== c ==d==»', '==');
  same('*«b* c *d»*', '*');
  same('**«b** c **d»**', '**');
  same('«***b*** c ***d***»', '*');
  same('«- *b* c *d*»', '*');
  // one span with another kind of marker inside is still one span
  assert.equal(wrap('«*a **b** c*»', '*'), '«a **b** c»');
  assert.equal(wrap('«**a *b* c**»', '**'), '«a *b* c»');
  assert.equal(wrap('«***x***»', '**'), '«*x*»');
  // wrapping text that merely holds the marker is still possible; undoing it is a no-op (documented)
  const t = 'p a**b q';
  const r1 = T.toggleWrap(t, 2, 6, '**');
  assert.equal(mapply(t, r1), 'p **a**b** q');
  const r2 = T.toggleWrap('p **a**b** q', r1.selStart, r1.selEnd, '**');
  assert.equal(mapply('p **a**b** q', r2), 'p **a**b** q');
});

// 5. Inline code on text with backticks.
test('toggleWrap `: a longer run of backticks, padded when the text starts or ends with one', () => {
  assert.equal(wrap('«a`b»', '`'), '«``a`b``»');
  assert.equal(wrap('«`a»', '`'), '«`` `a ``»');
  assert.equal(wrap('«a`»', '`'), '«`` a` ``»');
  assert.equal(wrap('«a``b»', '`'), '«```a``b```»');
  assert.equal(wrap('«a`b``c»', '`'), '«```a`b``c```»');
  assert.equal(wrap('«``»', '`'), '«``` `` ```»');
  assert.equal(wrap('«x»', '`'), '«`x`»');
});
test('toggleWrap `: unwrapping recognises the long form and removes the padding it added', () => {
  assert.equal(wrap('«``a`b``»', '`'), '«a`b»');
  assert.equal(wrap('«`` `a ``»', '`'), '«`a»');
  assert.equal(wrap('«`` a` ``»', '`'), '«a`»');
  assert.equal(wrap('``«a`b»``', '`'), '«a`b»');
  assert.equal(wrap('«`a` and `b`»', '`'), '«`a` and `b`»'); // two code spans are not one
  for (const body of ['a`b', '`a', 'a`', 'a``b', '``', 'a b`c d', 'é`😀', '`a`b']) {
    const text = `p ${body} q`;
    const r1 = T.toggleWrap(text, 2, 2 + body.length, '`');
    const t1 = mapply(text, r1);
    const r2 = T.toggleWrap(t1, r1.selStart, r1.selEnd, '`');
    assert.equal(mapply(t1, r2), text, body);
    assert.deepEqual([r2.selStart, r2.selEnd], [2, 2 + body.length], body);
  }
});

// 6. Code between two fenced blocks must not merge them.
test('toggleWrap `: lines directly between two fenced blocks get their own fence', () => {
  const text = '```\nout\n```\nLine one\nLine two\n```\nout2\n```';
  const start = text.indexOf('Line one');
  const end = text.indexOf('\n```\nout2');
  const r = T.toggleWrap(text, start, end, '`');
  assert.equal(mapply(text, r), '```\nout\n```\n```\nLine one\nLine two\n```\n```\nout2\n```');
  // that new fence pair is the only one that comes off again
  const t1 = mapply(text, r);
  const r2 = T.toggleWrap(t1, r.selStart, r.selEnd, '`');
  assert.equal(mapply(t1, r2), text);
});
test('toggleWrap `: a fence pair around the selection is still removed, and a whole two-block selection is not unwrapped', () => {
  assert.equal(wrap('```\n«a\nb»\n```', '`'), '«a\nb»');
  assert.equal(wrap('x\n```\n«a\nb»\n```\ny', '`'), 'x\n«a\nb»\ny');
  assert.equal(wrap('«```\na\n```\nb\n```\nc\n```»', '`'), '«````\n```\na\n```\nb\n```\nc\n```\n````»');
  assert.equal(wrap('```\nx\n```\n```\n«a\nb»\n```', '`'), '```\nx\n```\n«a\nb»');
});
test('toggleWrap `: the fence count stops at 2,000,000 characters before the selection', () => {
  const filler = 'filler line\n'.repeat(190000); // about 2.2 million characters
  assert.ok(filler.length > 2000000);
  const text = `\`\`\`\n${filler}x\n\`\`\`\nA\nB\n\`\`\``;
  const start = text.indexOf('A\nB');
  // Beyond the limit nothing is counted: the fence above is assumed to open (an even count), so the pair is removed.
  const r = T.toggleWrap(text, start, start + 3, '`');
  assert.equal(r.insert, 'A\nB');
  // The same lines well inside the limit are counted: the fence above closes the first block, so A and B get a new one.
  const small = '```\nx\n```\nA\nB\n```';
  const r2 = T.toggleWrap(small, small.indexOf('A'), small.indexOf('A') + 3, '`');
  assert.ok(r2.insert.startsWith('```\nA\nB\n```'), JSON.stringify(r2.insert));
});

// 7. makeLink and a trailing backslash.
test('makeLink: a label ending in a backslash does not escape the closing bracket', () => {
  assert.equal(link('«a\\»'), '[a\\\\](«url»)');
  assert.equal(link('«a\\\\»'), '[a\\\\](«url»)'); // two already pair up
  assert.equal(link('«a\\\\\\»'), '[a\\\\\\\\](«url»)');
  assert.equal(link('«\\»'), '[\\\\](«url»)');
  assert.equal(link('«https://x.y/z\\»'), '[https://x.y/z\\\\](«url»)'); // not a usable URL: it becomes the label
  assert.equal(link('«a\\b»'), '[a\\b](«url»)');
});

// 8. toggleLinePrefix on indented lines.
test('toggleLinePrefix: the prefix goes after the indentation and comes off from there', () => {
  assert.equal(pref('«  item»', '- '), '«  - item»');
  assert.equal(pref('«  - item»', '- '), '«  item»');
  assert.equal(pref('«\titem\n  x»', '> '), '«\t> item\n  > x»');
  assert.equal(pref('«    > a\n  > b»', '> '), '«    a\n  b»');
  assert.equal(pref('  ¦', '- '), '  - ¦');
  assert.equal(pref('«  a\n\n    b»', '- '), '«  - a\n\n    - b»');
  for (const p of ['> ', '- ']) {
    for (const marked of ['«  a»', '«  a\n    b»', '  ¦a', '¦  a', ' ¦ a', '«\ta\n\tb»', '«  a\r\n  b»', 'x\n  «a»\ny']) {
      const { text, start, end } = mparse(marked);
      const r1 = T.toggleLinePrefix(text, start, end, p);
      const t1 = mapply(text, r1);
      const r2 = T.toggleLinePrefix(t1, r1.selStart, r1.selEnd, p);
      assert.equal(mapply(t1, r2), text, `${p} ${marked}`);
      assert.deepEqual([r2.selStart, r2.selEnd], [start, end], `${p} ${marked}`);
    }
  }
});

// ---- fuzz and property tests ----

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
const pick = (r, list) => list[Math.floor(r() * list.length)];

const WORDS = ['foo', 'bar', 'a', 'x y', 'é😀', '**', '*', '~~', '==', '`', '``', 'a**b', '*i*', '**b**', '~~s~~', '==h==', '`c`', '\\', ' ', '  ', '\t'];
const PREFIXES = ['', '', '', '- ', '* ', '+ ', '1. ', '12) ', '# ', '### ', '> ', '> > ', '- [ ] ', '- [x] ', '  - ', '    ', '> - ', '> # '];
const SPECIAL = ['```', '~~~', '---', '***', '___', '| --- | --- |', '| a | b |', '', '', '   ', '````', '```js'];
function randomMarkdown(r, fenceOk = true) {
  const n = 1 + Math.floor(r() * 7);
  const eol = r() < 0.2 ? '\r\n' : '\n';
  const specials = fenceOk ? SPECIAL : SPECIAL.filter((x) => !x.includes('`'));
  const lines = [];
  for (let i = 0; i < n; i += 1) {
    if (r() < 0.25) { lines.push(pick(r, specials)); continue; }
    let line = pick(r, PREFIXES);
    const k = Math.floor(r() * 4);
    for (let j = 0; j < k; j += 1) line += (j && r() < 0.7 ? ' ' : '') + pick(r, WORDS);
    lines.push(line);
  }
  return lines.join(eol) + (r() < 0.2 ? eol : '');
}
const pairSplit = (t, p) => p > 0 && p < t.length && t.charCodeAt(p - 1) >= 0xD800 && t.charCodeAt(p - 1) <= 0xDBFF && t.charCodeAt(p) >= 0xDC00 && t.charCodeAt(p) <= 0xDFFF;

test('fuzz toggleWrap: never throws, stays in bounds, only changes marker characters, restores plain text', () => {
  const r = rng(12345);
  let changed = 0;
  let restored = 0;
  for (const m of ['**', '*', '~~', '==', '`']) {
    const strip = m === '`' ? /[` \n]/g : new RegExp(`[${m[0] === '*' ? '\\*' : m[0]}]`, 'g');
    for (let i = 0; i < 4000; i += 1) {
      const text = randomMarkdown(r);
      let s = Math.floor(r() * (text.length + 1));
      let e = Math.floor(r() * (text.length + 1));
      if (s > e) [s, e] = [e, s];
      const res = T.toggleWrap(text, s, e, m);
      const label = `${m} ${JSON.stringify(text)} ${s} ${e}`;
      if (pairSplit(text, s) || pairSplit(text, e)) { assert.equal(res, null, label); continue; }
      assert.ok(res, label);
      assert.ok(res.start >= 0 && res.start <= res.end && res.end <= text.length, label);
      const t1 = mapply(text, res);
      assert.ok(res.selStart >= 0 && res.selStart <= res.selEnd && res.selEnd <= t1.length, label);
      assert.equal(t1.replace(strip, ''), text.replace(strip, ''), `only marker characters change: ${label}`);
      if (t1 === text) continue;
      changed += 1;
      // a selection with no marker character in it is plain: wrapping it and toggling again gives the text back
      const sel = text.slice(s, e);
      // (for ` also: no fence of the other kind around, whose block would make the new fence plain content)
      const plain = m === '`' ? !text.includes('`') && !text.includes('~~~') : !sel.includes(m[0]);
      if (!plain || s === e) continue; // an empty selection only inserts a pair
      const r2 = T.toggleWrap(t1, res.selStart, res.selEnd, m);
      assert.ok(r2, label);
      assert.equal(mapply(t1, r2), text, `round trip: ${label}`);
      restored += 1;
    }
  }
  assert.ok(changed > 1000 && restored > 500, `${changed} ${restored}`);
});

test('fuzz toggleLinePrefix: never throws, stays in bounds, only changes the prefix, twice restores', () => {
  const r = rng(777);
  let changed = 0;
  for (const p of ['> ', '- ']) {
    for (let i = 0; i < 4000; i += 1) {
      const text = randomMarkdown(r);
      let s = Math.floor(r() * (text.length + 1));
      let e = Math.floor(r() * (text.length + 1));
      if (s > e) [s, e] = [e, s];
      const res = T.toggleLinePrefix(text, s, e, p);
      const label = `${p} ${JSON.stringify(text)} ${s} ${e}`;
      if (pairSplit(text, s) || pairSplit(text, e)) { assert.equal(res, null, label); continue; }
      assert.ok(res, label);
      const t1 = mapply(text, res);
      assert.ok(res.start >= 0 && res.start <= res.end && res.end <= text.length, label);
      assert.ok(res.selStart >= 0 && res.selStart <= res.selEnd && res.selEnd <= t1.length, label);
      const strip = /[>\- ]/g;
      assert.equal(t1.replace(strip, ''), text.replace(strip, ''), label);
      if (t1 === text) continue;
      changed += 1;
      // Exceptions: a prefix followed by more indentation comes off and goes back after that indentation; a prefix
      // that is there twice loses one per toggle; a line of only the prefix becomes blank.
      if (new RegExp(`(^|\\n)[ \\t]*${p}([ \\t]|${p}|\\r?\\n|$)`).test(text)) continue;
      // A selection that ended just after a removed prefix now ends at column 0, and that line is no longer touched.
      if (res.selEnd > res.selStart && t1[res.selEnd - 1] === '\n' && text[e - 1] !== '\n') continue;
      const r2 = T.toggleLinePrefix(t1, res.selStart, res.selEnd, p);
      assert.equal(mapply(t1, r2), text, `round trip: ${label}`);
    }
  }
  assert.ok(changed > 3000, String(changed));
});

test('fuzz makeLink: never throws, stays in bounds, keeps the label, never ends it with an escaping backslash', () => {
  const r = rng(99);
  let links = 0;
  for (let i = 0; i < 6000; i += 1) {
    const text = randomMarkdown(r, false);
    let s = Math.floor(r() * (text.length + 1));
    let e = Math.floor(r() * (text.length + 1));
    if (s > e) [s, e] = [e, s];
    const res = T.makeLink(text, s, e);
    const label = `${JSON.stringify(text)} ${s} ${e}`;
    if (pairSplit(text, s) || pairSplit(text, e)) { assert.equal(res, null, label); continue; }
    assert.ok(res, label);
    const t1 = mapply(text, res);
    assert.ok(res.selStart >= 0 && res.selStart <= res.selEnd && res.selEnd <= t1.length, label);
    if (res.insert === '') continue;
    links += 1;
    const close = res.insert.lastIndexOf('](');
    assert.ok(res.insert.startsWith('[') && res.insert.endsWith(')') && close > 0, `${JSON.stringify(res.insert)} ${label}`);
    const lbl = res.insert.slice(1, close);
    let slashes = 0;
    while (slashes < lbl.length && lbl[lbl.length - 1 - slashes] === '\\') slashes += 1;
    assert.equal(slashes % 2, 0, `${JSON.stringify(res.insert)} ${label}`);
    const picked = t1.slice(res.selStart, res.selEnd);
    assert.ok(['url', 'text'].includes(picked), label);
    const trimmed = text.slice(s, e).trim();
    if (trimmed && !/^https?:\/\//i.test(trimmed)) assert.ok(res.insert.startsWith(`[${trimmed}`), label);
  }
  assert.ok(links > 1000, String(links));
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
test('performance: toggleWrap on a 1,000,000-character single-line selection is under 100 ms', () => {
  const text = 'lorem ipsum '.repeat(83334); // one line, about a million characters
  for (const m of ['**', '`']) {
    const ms = bestOf(3, () => assert.ok(T.toggleWrap(text, 0, text.length, m)));
    assert.ok(ms < 100, `${m} ${ms} ms`);
  }
});
test('performance: toggleWrap on a 100,000-line selection is under 500 ms', () => {
  const text = Array.from({ length: 100000 }, (_, i) => `- item ${i} with **some** words`).join('\n');
  const ms = bestOf(3, () => assert.ok(T.toggleWrap(text, 0, text.length, '*')));
  assert.ok(ms < 500, `${ms} ms`);
  const plain = Array.from({ length: 100000 }, (_, i) => `> # line ${i}`).join('\n');
  const ms2 = bestOf(3, () => assert.ok(T.toggleWrap(plain, 0, plain.length, '==')));
  assert.ok(ms2 < 500, `${ms2} ms`);
});
test('performance: the fence pre-scan over 2,000,000 characters before the selection is under 200 ms', () => {
  const unit = '```\ncode line\n```\nsome ordinary text here\n';
  for (const copies of [50000, 45000]) { // 2,100,000 characters (over the limit) and 1,890,000 (under it)
    const head = unit.repeat(copies);
    const text = `${head}alpha\nbeta\ngamma`;
    for (const m of ['**', '`']) {
      const ms = bestOf(3, () => assert.ok(T.toggleWrap(text, head.length, text.length, m)));
      assert.ok(ms < 200, `${m} ${head.length} ${ms} ms`);
    }
  }
  const blank = '\n'.repeat(1900000);
  const t2 = `${blank}alpha\nbeta`;
  const ms = bestOf(3, () => assert.ok(T.toggleWrap(t2, blank.length, t2.length, '**')));
  assert.ok(ms < 200, `${ms} ms`);
});
