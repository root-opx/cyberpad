'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const store = require('../js/core/store.js');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'js', 'early-theme.js'), 'utf8');

// Runs the early script in a bare context holding only the fake browser objects it may touch.
// `stored` is what localStorage returns (undefined: no item); `dark` is the prefers-color-scheme state;
// `opts` can make storage throw or remove matchMedia.
function run(stored, dark, opts = {}) {
  const root = { dataset: { theme: 'neon' } };
  const calls = [];
  const sandbox = {
    document: { documentElement: root },
    localStorage: {
      getItem(key) {
        calls.push(key);
        if (opts.storageThrows) throw new Error('SecurityError');
        return stored === undefined ? null : stored;
      },
    },
    matchMedia: (q) => ({ matches: q === '(prefers-color-scheme: dark)' && dark }),
  };
  if (opts.noMatchMedia) delete sandbox.matchMedia;
  if (opts.storageGetterThrows) {
    delete sandbox.localStorage;
    Object.defineProperty(sandbox, 'localStorage', { get() { throw new Error('SecurityError'); } });
  }
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox); // must not throw
  return { theme: root.dataset.theme, calls };
}

test('each stored setting gives the right data-theme for both colour schemes', () => {
  const cases = [
    ['neon', 'neon', 'neon'], ['amber', 'amber', 'amber'], ['terminal', 'terminal', 'terminal'],
    ['light', 'light', 'light'], ['dark', 'dark', 'dark'],
    ['system', 'light', 'dark'], // [setting, when the OS is light, when the OS is dark]
  ];
  for (const [setting, whenLight, whenDark] of cases) {
    assert.equal(run(setting, false).theme, whenLight, `${setting} / light OS`);
    assert.equal(run(setting, true).theme, whenDark, `${setting} / dark OS`);
  }
});

test('it reads only the cyberpad.theme key', () => {
  assert.deepEqual(run('light', false).calls, ['cyberpad.theme']);
});

test('a missing, unknown or hostile value leaves data-theme untouched', () => {
  for (const bad of [undefined, '', 'solarized', '__proto__', 'constructor', 'toString', 'Light', 'LIGHT', ' light', 'light ', 'light\0', '#fafaf7', 'x'.repeat(10000)]) {
    assert.equal(run(bad, true).theme, 'neon', JSON.stringify(String(bad).slice(0, 20)));
  }
});

test('localStorage throwing, on access or on read, leaves data-theme untouched', () => {
  assert.equal(run('light', false, { storageThrows: true }).theme, 'neon');
  assert.equal(run('light', false, { storageGetterThrows: true }).theme, 'neon');
});

test('system with matchMedia missing resolves to light (the page default of an unknown OS choice is the light screen)', () => {
  // Documented choice: without matchMedia the OS preference is unknown; the app itself treats that as "not dark", so light.
  assert.equal(run('system', true, { noMatchMedia: true }).theme, 'light');
  assert.equal(run('dark', true, { noMatchMedia: true }).theme, 'dark');
});

test('matchMedia throwing never lets an exception escape', () => {
  const root = { dataset: { theme: 'neon' } };
  const sandbox = {
    document: { documentElement: root },
    localStorage: { getItem: () => 'system' },
    matchMedia() { throw new Error('boom'); },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);
  assert.equal(root.dataset.theme, 'light');
});

test('the early script leaks no globals', () => {
  const sandbox = { document: { documentElement: { dataset: {} } }, localStorage: { getItem: () => 'dark' }, matchMedia: () => ({ matches: false }) };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const before = Object.keys(sandbox).sort();
  vm.runInContext(SOURCE, sandbox);
  assert.deepEqual(Object.keys(sandbox).sort(), before);
});

test('its allow-list equals store.THEMES, so the two cannot drift', () => {
  // The early script exposes nothing; the list is its only array literal of quoted names.
  const m = /\[\s*((?:'[a-z]+'\s*,?\s*)+)\]/.exec(SOURCE);
  assert.ok(m, 'allow-list literal found');
  const names = [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
  assert.deepEqual([...names].sort(), [...store.THEMES].sort());
  assert.ok(/Object\.freeze/.test(SOURCE), 'the list is frozen');
});
