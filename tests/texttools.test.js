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
  assert.equal(T.sectionOf('Theme'), 'View');
  assert.equal(T.sectionOf('Templates'), 'Insert');
  assert.equal(T.sectionOf('Transform'), 'Text');
  for (const g of ['Note', 'File', 'View', 'Insert', 'Tools', 'CTF', 'Vault', 'Security', 'Recent notes']) assert.equal(T.sectionOf(g), g);
  assert.equal(T.sectionOf('__proto__'), '__proto__');
});

test('paletteSections orders, merges, drops empty sections and keeps item order', () => {
  const items = [
    { group: 'Security', title: 's1' }, { group: 'Templates', title: 't1' }, { group: 'Note', title: 'n1' },
    { group: 'Insert', title: 'i1' }, { group: 'Theme', title: 'th1' }, { group: 'Recent notes', title: 'r1' },
    { group: 'View', title: 'v1' }, { group: 'Transform', title: 'x1' },
  ];
  const out = T.paletteSections(items);
  assert.deepEqual(out.map((s) => s.name), ['Recent notes', 'Note', 'View', 'Insert', 'Text', 'Security']);
  assert.deepEqual(out.find((s) => s.name === 'Insert').items.map((i) => i.title), ['t1', 'i1']);
  assert.deepEqual(out.find((s) => s.name === 'View').items.map((i) => i.title), ['th1', 'v1']);
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
  assert.ok(T.paletteScore('view', amber) > 0);
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

test('PALETTE_SECTIONS: CTF sits between Tools and Vault; sectionOf keeps it', () => {
  assert.deepEqual([...T.PALETTE_SECTIONS], ['Recent notes', 'Note', 'File', 'View', 'Insert', 'Text', 'Tools', 'CTF', 'Vault', 'Security']);
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
  ['«*»', '«***»'],
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
    for (const body of ['foo', 'foo bar', 'é😀', 'a**b', 'a*b', '1 == 1', 'x`y']) {
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
  ['  ¦a', '>   ¦a'],
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
