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
  for (const g of ['Note', 'File', 'View', 'Insert', 'Tools', 'Vault', 'Security', 'Recent notes']) assert.equal(T.sectionOf(g), g);
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
