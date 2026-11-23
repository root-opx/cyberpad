/*
 * CVSS v3.0 / v3.1 vector parsing and scoring (base, temporal, environmental),
 * following the FIRST specification. Vectors are validated strictly against an
 * allow-list of metrics and values; anything else is rejected, never repaired.
 */
(function (root, factory) {
  'use strict';
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else (root.NP = root.NP || {}).cvss = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class CvssError extends Error {
    constructor(message) { super(message); this.name = 'CvssError'; }
  }

  const MAX_VECTOR = 300;
  const MAX_FOUND = 50;
  const VERSIONS = ['3.0', '3.1'];
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  const CIA = { N: 'None', L: 'Low', H: 'High' };
  const REQ = { X: 'Not defined', L: 'Low', M: 'Medium', H: 'High' };
  const withX = (values) => ({ X: 'Not defined', ...values });

  /** Every metric the spec defines, in its canonical vector order. */
  const METRICS = {
    AV: { group: 'base', name: 'Attack vector', values: { N: 'Network', A: 'Adjacent', L: 'Local', P: 'Physical' } },
    AC: { group: 'base', name: 'Attack complexity', values: { L: 'Low', H: 'High' } },
    PR: { group: 'base', name: 'Privileges required', values: { N: 'None', L: 'Low', H: 'High' } },
    UI: { group: 'base', name: 'User interaction', values: { N: 'None', R: 'Required' } },
    S: { group: 'base', name: 'Scope', values: { U: 'Unchanged', C: 'Changed' } },
    C: { group: 'base', name: 'Confidentiality', values: CIA },
    I: { group: 'base', name: 'Integrity', values: CIA },
    A: { group: 'base', name: 'Availability', values: CIA },
    E: { group: 'temporal', name: 'Exploit code maturity', values: { X: 'Not defined', U: 'Unproven', P: 'Proof of concept', F: 'Functional', H: 'High' } },
    RL: { group: 'temporal', name: 'Remediation level', values: { X: 'Not defined', O: 'Official fix', T: 'Temporary fix', W: 'Workaround', U: 'Unavailable' } },
    RC: { group: 'temporal', name: 'Report confidence', values: { X: 'Not defined', U: 'Unknown', R: 'Reasonable', C: 'Confirmed' } },
    CR: { group: 'environmental', name: 'Confidentiality requirement', values: REQ },
    IR: { group: 'environmental', name: 'Integrity requirement', values: REQ },
    AR: { group: 'environmental', name: 'Availability requirement', values: REQ },
    MAV: { group: 'environmental', name: 'Modified attack vector', values: withX({ N: 'Network', A: 'Adjacent', L: 'Local', P: 'Physical' }) },
    MAC: { group: 'environmental', name: 'Modified attack complexity', values: withX({ L: 'Low', H: 'High' }) },
    MPR: { group: 'environmental', name: 'Modified privileges required', values: withX({ N: 'None', L: 'Low', H: 'High' }) },
    MUI: { group: 'environmental', name: 'Modified user interaction', values: withX({ N: 'None', R: 'Required' }) },
    MS: { group: 'environmental', name: 'Modified scope', values: withX({ U: 'Unchanged', C: 'Changed' }) },
    MC: { group: 'environmental', name: 'Modified confidentiality', values: withX(CIA) },
    MI: { group: 'environmental', name: 'Modified integrity', values: withX(CIA) },
    MA: { group: 'environmental', name: 'Modified availability', values: withX(CIA) },
  };
  const ORDER = Object.keys(METRICS);
  const BASE = ORDER.filter((k) => METRICS[k].group === 'base');
  const TEMPORAL = ORDER.filter((k) => METRICS[k].group === 'temporal');
  const ENVIRONMENTAL = ORDER.filter((k) => METRICS[k].group === 'environmental');

  const W = {
    AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
    AC: { L: 0.77, H: 0.44 },
    PR_U: { N: 0.85, L: 0.62, H: 0.27 },
    PR_C: { N: 0.85, L: 0.68, H: 0.5 },
    UI: { N: 0.85, R: 0.62 },
    CIA: { H: 0.56, L: 0.22, N: 0 },
    E: { X: 1, H: 1, F: 0.97, P: 0.94, U: 0.91 },
    RL: { X: 1, U: 1, W: 0.97, T: 0.96, O: 0.95 },
    RC: { X: 1, C: 1, R: 0.96, U: 0.92 },
    REQ: { X: 1, H: 1.5, M: 1, L: 0.5 },
  };

  /** CVSS 3.1 Roundup: avoids floating-point surprises (spec Appendix A). */
  function roundup31(x) {
    const i = Math.round(x * 100000);
    return i % 10000 === 0 ? i / 100000 : (Math.floor(i / 10000) + 1) / 10;
  }
  function roundup30(x) { return Math.ceil(x * 10) / 10; }
  const round1 = (x) => Math.round(x * 10) / 10;

  function severity(score) {
    if (score === 0) return 'None';
    if (score < 4) return 'Low';
    if (score < 7) return 'Medium';
    if (score < 9) return 'High';
    return 'Critical';
  }

  const clip = (s) => (s.length > 20 ? `${s.slice(0, 20)}…` : s);

  function parse(input) {
    if (typeof input !== 'string') throw new CvssError('The vector must be text.');
    const s = input.trim();
    if (!s) throw new CvssError('Enter a CVSS vector, for example CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H.');
    if (s.length > MAX_VECTOR) throw new CvssError('That is too long to be a CVSS vector.');
    const head = /^CVSS:(\d{1,2}\.\d{1,2})\//.exec(s);
    if (!head) throw new CvssError('A CVSS vector starts with "CVSS:3.1/" or "CVSS:3.0/".');
    if (head[1] === '4.0') throw new CvssError('CVSS 4.0 vectors are not supported yet. Only CVSS 3.0 and 3.1 can be scored.');
    if (!VERSIONS.includes(head[1])) throw new CvssError(`CVSS ${head[1]} is not supported. Use version 3.0 or 3.1.`);
    const metrics = Object.create(null);
    for (const part of s.slice(head[0].length).split('/')) {
      const kv = /^([A-Z]{1,3}):([A-Z])$/.exec(part);
      if (!kv) throw new CvssError(`"${clip(part)}" is not a valid metric. Each part looks like AV:N.`);
      const [, key, val] = kv;
      if (!hasOwn(METRICS, key)) throw new CvssError(`${key} is not a CVSS 3 metric.`);
      if (hasOwn(metrics, key)) throw new CvssError(`${key} appears more than once.`);
      const allowed = METRICS[key].values;
      if (!hasOwn(allowed, val)) throw new CvssError(`${val} is not a valid value for ${key} (${METRICS[key].name}). Use ${Object.keys(allowed).join(', ')}.`);
      metrics[key] = val;
    }
    const missing = BASE.filter((k) => !hasOwn(metrics, k));
    if (missing.length) throw new CvssError(`Missing base metric${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`);
    return { version: head[1], metrics };
  }

  /** Canonical vector string. Optional metrics set to X (not defined) are left out. */
  function buildVector(version, metrics) {
    if (!VERSIONS.includes(version)) throw new CvssError(`CVSS ${String(version).slice(0, 10)} is not supported.`);
    const parts = [];
    for (const k of ORDER) {
      const v = hasOwn(metrics, k) ? metrics[k] : undefined;
      if (v === undefined || (v === 'X' && METRICS[k].group !== 'base')) {
        if (METRICS[k].group === 'base') throw new CvssError(`Missing base metric: ${k}.`);
        continue;
      }
      if (!hasOwn(METRICS[k].values, v)) throw new CvssError(`${String(v).slice(0, 5)} is not a valid value for ${k}.`);
      parts.push(`${k}:${v}`);
    }
    return `CVSS:${version}/${parts.join('/')}`;
  }

  function calculate(vector) {
    const { version, metrics: m } = parse(vector);
    const ru = version === '3.1' ? roundup31 : roundup30;
    const g = (k) => (hasOwn(m, k) ? m[k] : 'X');

    const changed = m.S === 'C';
    const iss = 1 - (1 - W.CIA[m.C]) * (1 - W.CIA[m.I]) * (1 - W.CIA[m.A]);
    const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15) : 6.42 * iss;
    const exploitability = 8.22 * W.AV[m.AV] * W.AC[m.AC] * (changed ? W.PR_C : W.PR_U)[m.PR] * W.UI[m.UI];
    const base = impact <= 0 ? 0 : ru(Math.min((changed ? 1.08 : 1) * (impact + exploitability), 10));

    const tMul = W.E[g('E')] * W.RL[g('RL')] * W.RC[g('RC')];
    const hasTemporal = TEMPORAL.some((k) => g(k) !== 'X');
    const temporal = ru(base * tMul);

    // Environmental: modified metrics fall back to the base value when not defined.
    const mod = (k) => (g(`M${k}`) !== 'X' ? m[`M${k}`] : m[k]);
    const mChanged = mod('S') === 'C';
    const miss = Math.min(1
      - (1 - W.REQ[g('CR')] * W.CIA[mod('C')])
      * (1 - W.REQ[g('IR')] * W.CIA[mod('I')])
      * (1 - W.REQ[g('AR')] * W.CIA[mod('A')]), 0.915);
    let mImpact;
    if (!mChanged) mImpact = 6.42 * miss;
    else if (version === '3.1') mImpact = 7.52 * (miss - 0.029) - 3.25 * Math.pow(miss * 0.9731 - 0.02, 13);
    else mImpact = 7.52 * (miss - 0.029) - 3.25 * Math.pow(miss - 0.02, 15);
    const mExpl = 8.22 * W.AV[mod('AV')] * W.AC[mod('AC')] * (mChanged ? W.PR_C : W.PR_U)[mod('PR')] * W.UI[mod('UI')];
    const hasEnv = ENVIRONMENTAL.some((k) => g(k) !== 'X');
    const environmental = mImpact <= 0 ? 0 : ru(ru(Math.min((mChanged ? 1.08 : 1) * (mImpact + mExpl), 10)) * tMul);

    return {
      version,
      metrics: { ...m },
      vector: buildVector(version, m),
      base,
      baseSeverity: severity(base),
      impact: round1(Math.max(impact, 0)),
      exploitability: round1(exploitability),
      temporal: hasTemporal ? temporal : null,
      temporalSeverity: hasTemporal ? severity(temporal) : null,
      environmental: hasEnv ? environmental : null,
      environmentalSeverity: hasEnv ? severity(environmental) : null,
    };
  }

  /** Vector-shaped strings in text, with their offsets. Not validated: use calculate(). */
  function findVectors(text) {
    const out = [];
    if (typeof text !== 'string') return out;
    const re = /CVSS:\d{1,2}\.\d{1,2}(?:\/[A-Z]{1,3}:[A-Z]){1,40}/g;
    let m;
    while ((m = re.exec(text)) && out.length < MAX_FOUND) out.push({ vector: m[0], index: m.index });
    return out;
  }

  return {
    CvssError, METRICS, ORDER, BASE, TEMPORAL, ENVIRONMENTAL, VERSIONS, MAX_VECTOR,
    parse, buildVector, calculate, severity, findVectors, roundup31, roundup30,
  };
});
