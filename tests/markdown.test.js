'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, parseInline, safeUrl } = require('../js/core/markdown.js');

const textOf = (nodes) => nodes.map((n) => (n.type === 'text' || n.type === 'code' ? n.value : n.children ? textOf(n.children) : '')).join('');

test('parses headings, paragraphs and code fences', () => {
  const ast = parse('# Title\n\nHello\nworld\n\n```js\nconst a = 1;\n```');
  assert.equal(ast[0].type, 'heading');
  assert.equal(ast[0].level, 1);
  assert.equal(ast[1].type, 'paragraph');
  assert.deepEqual(ast[1].children.map((n) => n.type), ['text', 'br', 'text']);
  assert.deepEqual(ast[2], { type: 'code', lang: 'js', text: 'const a = 1;', line: 5 });
});

test('parses task lists with source line numbers', () => {
  const ast = parse('intro\n\n- [ ] one\n- [x] two\n- plain');
  const list = ast[1];
  assert.equal(list.type, 'list');
  assert.deepEqual(list.items.map((i) => [i.task, i.line]), [[false, 2], [true, 3], [null, 4]]);
});

test('parses tables with alignment', () => {
  const ast = parse('| a | b |\n| :-- | --: |\n| 1 | 2 |');
  assert.equal(ast[0].type, 'table');
  assert.deepEqual(ast[0].aligns, ['left', 'right']);
  assert.equal(ast[0].rows.length, 1);
});

test('parses inline marks, wiki links and tags', () => {
  const nodes = parseInline('**bold** *it* ~~gone~~ ==hi== `x` [[Ideas|my ideas]] #todo #ff00aa');
  const types = nodes.filter((n) => n.type !== 'text').map((n) => n.type);
  assert.deepEqual(types, ['strong', 'em', 'del', 'mark', 'code', 'wiki', 'tag']);
  const wiki = nodes.find((n) => n.type === 'wiki');
  assert.deepEqual([wiki.target, wiki.label], ['Ideas', 'my ideas']);
});

test('raw HTML is kept as plain text, never markup', () => {
  const payload = '<img src=x onerror=alert(1)><script>alert(1)</script>';
  const ast = parse(payload);
  assert.equal(ast[0].type, 'paragraph');
  assert.equal(textOf(ast[0].children), payload);
});

test('only http, https and mailto links become links', () => {
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', '//evil.example', 'file:///etc/passwd']) {
    assert.equal(safeUrl(bad), null, bad);
    const nodes = parseInline(`[click](${bad})`);
    assert.ok(!nodes.some((n) => n.type === 'link'), bad);
  }
  assert.equal(safeUrl('https://example.com/a b'), null);
  assert.equal(safeUrl('https://example.com/x'), 'https://example.com/x');
  assert.equal(parseInline('see https://example.com/page.').find((n) => n.type === 'link').href, 'https://example.com/page');
});

test('very long lines are not inline-parsed (bounded work)', () => {
  const long = '**a'.repeat(3000);
  const nodes = parseInline(long);
  assert.deepEqual(nodes, [{ type: 'text', value: long }]);
});

test('deeply nested quotes are bounded', () => {
  const ast = parse('>'.repeat(50) + ' deep');
  let depth = 0;
  let node = ast[0];
  while (node && node.type === 'quote') { depth++; node = node.children[0]; }
  assert.ok(depth <= 9);
});

test('escaped characters stay literal', () => {
  assert.equal(textOf(parseInline('\\*not em\\* \\#nottag')), '*not em* #nottag');
});

test('CVE, CWE and ATT&CK IDs become reference links with fixed URLs', () => {
  const nodes = parseInline('cve-2021-44228, T1059.001, TA0001 and CWE-079.');
  const refs = nodes.filter((n) => n.type === 'ref');
  assert.deepEqual(refs.map((r) => [r.kind, r.id, r.href]), [
    ['cve', 'CVE-2021-44228', 'https://nvd.nist.gov/vuln/detail/CVE-2021-44228'],
    ['technique', 'T1059.001', 'https://attack.mitre.org/techniques/T1059/001/'],
    ['tactic', 'TA0001', 'https://attack.mitre.org/tactics/TA0001/'],
    ['cwe', 'CWE-079', 'https://cwe.mitre.org/data/definitions/79.html'],
  ]);
  assert.equal(textOf(nodes), 'cve-2021-44228, T1059.001, TA0001 and CWE-079.');
});

test('reference IDs need word boundaries and stay out of code', () => {
  for (const src of ['XCVE-2024-1234', 'CVE-2024-12', 'T12345', 'aT1059', 't1059', 'CVE-2024-1234x', '`CVE-2024-1234`']) {
    assert.ok(!parseInline(src).some((n) => n.type === 'ref'), src);
  }
});

test('refUrl only accepts known kinds and full IDs', () => {
  const { refUrl } = require('../js/core/markdown.js');
  assert.equal(refUrl('cve', 'CVE-2024-3094'), 'https://nvd.nist.gov/vuln/detail/CVE-2024-3094');
  assert.equal(refUrl('cve', 'CVE-2024-3094/../../x'), null);
  assert.equal(refUrl('cve', 'CVE-24-1'), null);
  assert.equal(refUrl('__proto__', 'CVE-2024-3094'), null);
  assert.equal(refUrl('technique', 'T1059.001?x=1'), null);
  assert.equal(refUrl('cwe', 42), null);
});

test('link labels never contain nested links, tags or references', () => {
  const [link] = parseInline('[CVE-2024-3094 #tag https://x.example CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H](https://example.com)');
  assert.equal(link.type, 'link');
  assert.deepEqual(link.children, [{ type: 'text', value: 'CVE-2024-3094 #tag https://x.example CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }]);
  const [strongLink] = parseInline('[**T1059**](https://example.com)');
  assert.equal(strongLink.children[0].type, 'strong');
  assert.deepEqual(strongLink.children[0].children, [{ type: 'text', value: 'T1059' }]);
});

test('CVSS vectors become cvss nodes', () => {
  const v = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H';
  const nodes = parseInline(`Score ${v}, done`);
  assert.deepEqual(nodes[1], { type: 'cvss', vector: v });
  assert.ok(!parseInline(`x${v}`).some((n) => n.type === 'cvss'));
});
