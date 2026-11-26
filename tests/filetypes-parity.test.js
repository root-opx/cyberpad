'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const store = require('../js/core/store.js');
const highlight = require('../js/core/highlight.js');
const codeedit = require('../js/core/codeedit.js');

/**
 * Reads the host's table (FileTypes.cs) as text. The shape is: ("Group", new[] { "ext", ... }), one tuple per group.
 * Strict on purpose: if the file's shape changes, this fails loudly instead of comparing a partial table.
 */
function hostTable() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'CyberPad.Desktop', 'Files', 'FileTypes.cs'), 'utf8');
  const start = src.indexOf('Table =');
  assert.ok(start > 0, 'Table declaration not found');
  const open = src.indexOf('{', start);
  const end = src.indexOf('\n    };', open);
  assert.ok(open > 0 && end > open, 'Table block not found');
  const block = src.slice(open, end);

  const groupRe = /\(\s*"([^"]+)"\s*,\s*new\[\]\s*\{([^}]*)\}\s*\)/g;
  const entries = [];
  let groups = 0;
  let m;
  while ((m = groupRe.exec(block)) !== null) {
    groups += 1;
    const wires = m[2].match(/"[^"]*"/g) || [];
    const rest = m[2].replace(/"[^"]*"/g, '').replace(/[\s,]/g, '');
    assert.equal(rest, '', `unexpected text in group ${m[1]}`);
    for (const w of wires) {
      const ext = w.slice(1, -1);
      assert.match(ext, /^[a-z0-9]+$/, `non-canonical extension ${ext}`);
      entries.push({ ext, group: m[1] });
    }
  }
  // Nothing that looks like a tuple may have been skipped: count the opening of each group and every quoted string.
  assert.equal((block.match(/\(\s*"/g) || []).length, groups, 'a group line was not parsed');
  assert.equal((block.match(/"[^"]*"/g) || []).length, groups + entries.length, 'a quoted entry was not parsed');
  return entries;
}

test('host table has exactly 69 entries', () => {
  assert.equal(hostTable().length, 69);
});

test('host and page tables list the same extensions in the same order', () => {
  assert.deepEqual(hostTable().map((e) => e.ext), [...store.FILE_FORMATS]);
});

test('host and page tables put every extension in the same group', () => {
  const host = hostTable();
  assert.equal(host.length, store.FILE_TYPES.length);
  host.forEach((e, i) => assert.equal(e.group, store.FILE_TYPES[i].group, `group of ${e.ext}`));
});

test('highlight, store and codeedit agree on the language ids', () => {
  assert.deepEqual([...highlight.LANGUAGE_IDS], [...store.LANGS]);
  assert.deepEqual(codeedit.LANGUAGES.map((l) => l.id), [...store.LANGS]);
});
