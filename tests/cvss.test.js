'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/core/cvss.js');

const V = (rest, version = '3.1') => `CVSS:${version}/${rest}`;

test('base scores match the FIRST / NVD reference values', () => {
  const cases = [
    ['AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', 9.8, 'Critical'],
    ['AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H', 10, 'Critical'],
    ['AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N', 6.1, 'Medium'],
    ['AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H', 7.8, 'High'],
    ['AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:N/A:N', 5.9, 'Medium'],
    ['AV:P/AC:H/PR:H/UI:R/S:U/C:L/I:N/A:N', 1.6, 'Low'],
    ['AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N', 0, 'None'],
  ];
  for (const [rest, score, sev] of cases) {
    const r = C.calculate(V(rest));
    assert.equal(r.base, score, rest);
    assert.equal(r.baseSeverity, sev, rest);
  }
  const r = C.calculate(V('AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'));
  assert.equal(r.impact, 5.9);
  assert.equal(r.exploitability, 3.9);
  assert.equal(r.temporal, null);
  assert.equal(r.environmental, null);
});

test('CVSS 3.0 vectors are scored with the 3.0 rounding', () => {
  const r = C.calculate(V('AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N', '3.0')); // Heartbleed
  assert.equal(r.version, '3.0');
  assert.equal(r.base, 7.5);
});

test('temporal and environmental scores', () => {
  const t = C.calculate(V('AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/E:P/RL:O/RC:C'));
  assert.equal(t.base, 9.8);
  assert.equal(t.temporal, 8.8);
  assert.equal(t.temporalSeverity, 'High');
  const e = C.calculate(V('AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/CR:L/IR:L/AR:L'));
  assert.equal(e.environmental, 8);
  const ms = C.calculate(V('AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/MS:C'));
  assert.equal(ms.environmental, 10);
  const lowered = C.calculate(V('AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/MAV:L/MC:N/MI:N/MA:N'));
  assert.equal(lowered.environmental, 0);
});

test('roundup follows the 3.1 specification', () => {
  assert.equal(C.roundup31(4.02), 4.1);
  assert.equal(C.roundup31(4.0), 4);
  assert.equal(C.roundup31(4.000000000000001), 4);
  assert.equal(C.roundup30(4.01), 4.1);
});

test('vectors are normalized to canonical order, and X values are dropped', () => {
  const r = C.calculate('  CVSS:3.1/A:H/I:H/C:H/S:U/UI:N/PR:N/AC:L/AV:N/E:X  ');
  assert.equal(r.vector, V('AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'));
  assert.equal(C.buildVector('3.1', { ...C.parse(r.vector).metrics, RL: 'O' }), V('AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/RL:O'));
  assert.throws(() => C.buildVector('3.1', { AV: 'N' }), C.CvssError);
  assert.throws(() => C.buildVector('3.1', { ...C.parse(r.vector).metrics, AV: 'Z' }), C.CvssError);
  assert.throws(() => C.buildVector('9.9', C.parse(r.vector).metrics), C.CvssError);
});

test('invalid vectors are rejected, never repaired', () => {
  const full = 'AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H';
  const bad = [
    null,
    42,
    '',
    '   ',
    full, // no CVSS: prefix
    V(full, '4.0'),
    V(full, '2.0'),
    V(`${full}/`), // trailing slash
    V(`${full}/AV:L`), // duplicate
    V(full.replace('AV:N', 'AV:Z')), // value outside the allow-list
    V(full.replace('/A:H', '')), // missing base metric
    V(`${full}/XX:N`), // unknown metric
    V(full.toLowerCase()),
    V(`${full}/<script>`),
    V(`${full}/__proto__:X`),
    V(`${full}/E:P`.padEnd(400, '/E:P')), // too long
  ];
  for (const b of bad) assert.throws(() => C.calculate(b), C.CvssError, String(b).slice(0, 60));
});

test('error messages stay short and name the problem', () => {
  assert.throws(() => C.parse(V(`AV:N/${'Q'.repeat(200)}`)), (e) => e instanceof C.CvssError && e.message.length < 120);
  assert.throws(() => C.parse(V('AV:N/AC:L')), /Missing base metrics: PR, UI, S, C, I, A/);
  assert.throws(() => C.parse(V('AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', '4.0')), /4\.0 vectors are not supported/);
});

test('findVectors locates vector-shaped strings with offsets and a cap', () => {
  const v = V('AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H');
  assert.deepEqual(C.findVectors(`Score: ${v}.`), [{ vector: v, index: 7 }]);
  assert.equal(C.findVectors(`${v} `.repeat(200)).length, 50);
  assert.deepEqual(C.findVectors(null), []);
});
