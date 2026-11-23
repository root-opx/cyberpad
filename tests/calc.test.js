'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate, solveLine, format, CalcError } = require('../js/core/calc.js');

test('evaluates arithmetic with precedence', () => {
  assert.equal(evaluate('1 + 2 * 3'), 7);
  assert.equal(evaluate('(1 + 2) * 3'), 9);
  assert.equal(evaluate('2 ^ 3 ^ 2'), 512);
  assert.equal(evaluate('-2 ^ 2'), -4);
  assert.equal(evaluate('10 % 4'), 2);
  assert.equal(evaluate('6 × 7 ÷ 2'), 21);
});

test('supports allow-listed functions and constants', () => {
  assert.equal(evaluate('sqrt(16) + abs(-2)'), 6);
  assert.equal(evaluate('max(1, 9, 4)'), 9);
  assert.ok(Math.abs(evaluate('2 * pi') - Math.PI * 2) < 1e-12);
});

test('formats floating point noise away', () => {
  assert.equal(format(evaluate('0.1 + 0.2')), '0.3');
  assert.equal(format(48), '48');
});

test('rejects anything outside the grammar', () => {
  for (const bad of ['alert(1)', 'constructor', '__proto__', 'toString()', 'process.exit()', '1 +', '2 ** 3', '"a"', '1/0', 'x = 1', 'max()', 'pow(2)']) {
    assert.throws(() => evaluate(bad), CalcError, bad);
  }
});

test('bounds input length and nesting depth', () => {
  assert.throws(() => evaluate('1+'.repeat(300) + '1'), CalcError);
  assert.throws(() => evaluate('('.repeat(100) + '1' + ')'.repeat(100)), CalcError);
  assert.throws(() => evaluate('-'.repeat(200) + '1'), CalcError);
});

test('solveLine finds the trailing expression before =', () => {
  assert.deepEqual(solveLine('Budget: 1280 * 0.15 =').text, '192');
  assert.equal(solveLine('- [ ] Write a sum ending in = and press Tab: 12*4 =').text, '48');
  assert.equal(solveLine('x = 3 + 4 =').text, '7');
  assert.equal(solveLine('total sqrt(81) = ').text, '9');
});

test('solveLine ignores lines without math', () => {
  assert.equal(solveLine('hello world ='), null);
  assert.equal(solveLine('version 2 ='), null);
  assert.equal(solveLine('no equals sign 1+1'), null);
  assert.equal(solveLine('x'.repeat(5000) + '1+1 ='), null);
});
