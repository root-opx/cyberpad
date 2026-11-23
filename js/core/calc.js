/*
 * Safe arithmetic evaluator. Never uses eval/Function: input is tokenized and
 * parsed with a bounded recursive-descent parser over an allow-list of
 * operators, functions and constants.
 */
(function (root, factory) {
  'use strict';
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else (root.NP = root.NP || {}).calc = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_INPUT = 500;
  const MAX_DEPTH = 64;
  const MAX_ARGS = 100;

  class CalcError extends Error {}

  const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

  const CONSTANTS = Object.freeze({ pi: Math.PI, e: Math.E, tau: Math.PI * 2 });

  // name -> [arity (-1 = variadic, at least one), implementation]
  const FUNCTIONS = Object.freeze({
    sqrt: [1, Math.sqrt],
    abs: [1, Math.abs],
    round: [1, Math.round],
    floor: [1, Math.floor],
    ceil: [1, Math.ceil],
    sin: [1, Math.sin],
    cos: [1, Math.cos],
    tan: [1, Math.tan],
    ln: [1, Math.log],
    log: [1, Math.log10],
    exp: [1, Math.exp],
    pow: [2, Math.pow],
    min: [-1, Math.min],
    max: [-1, Math.max],
  });

  const NUMBER_RE = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
  const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/y;
  const OPERATORS = '+-*/%^(),';

  function tokenize(src) {
    const tokens = [];
    let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === ' ' || c === '\t') { i++; continue; }
      if ((c >= '0' && c <= '9') || c === '.') {
        NUMBER_RE.lastIndex = i;
        const m = NUMBER_RE.exec(src);
        if (!m) throw new CalcError('malformed number');
        tokens.push({ t: 'num', v: Number(m[0]) });
        i += m[0].length;
        continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        IDENT_RE.lastIndex = i;
        const m = IDENT_RE.exec(src);
        tokens.push({ t: 'id', v: m[0].toLowerCase() });
        i += m[0].length;
        continue;
      }
      if (c === '×') { tokens.push({ t: 'op', v: '*' }); i++; continue; }
      if (c === '÷') { tokens.push({ t: 'op', v: '/' }); i++; continue; }
      if (OPERATORS.includes(c)) { tokens.push({ t: 'op', v: c }); i++; continue; }
      throw new CalcError(`unexpected "${c}"`);
    }
    return tokens;
  }

  function evaluateTokens(tokens) {
    if (!tokens.length) throw new CalcError('empty expression');
    let pos = 0;
    let depth = 0;

    const isOp = (v) => pos < tokens.length && tokens[pos].t === 'op' && tokens[pos].v === v;
    const enter = () => { if (++depth > MAX_DEPTH) throw new CalcError('expression is nested too deeply'); };
    const leave = () => { depth--; };

    function expr() {
      let v = term();
      while (isOp('+') || isOp('-')) {
        const op = tokens[pos++].v;
        const r = term();
        v = op === '+' ? v + r : v - r;
      }
      return v;
    }

    function term() {
      let v = unary();
      while (isOp('*') || isOp('/') || isOp('%')) {
        const op = tokens[pos++].v;
        const r = unary();
        if (op === '*') v *= r;
        else if (op === '/') v /= r;
        else v %= r;
      }
      return v;
    }

    function unary() {
      enter();
      try {
        if (isOp('-')) { pos++; return -unary(); }
        if (isOp('+')) { pos++; return unary(); }
        return power();
      } finally { leave(); }
    }

    function power() {
      const base = primary();
      if (isOp('^')) { pos++; return Math.pow(base, unary()); }
      return base;
    }

    function primary() {
      const tok = tokens[pos];
      if (!tok) throw new CalcError('expression ends too early');
      if (tok.t === 'num') { pos++; return tok.v; }
      if (tok.t === 'id') {
        pos++;
        if (isOp('(')) {
          if (!has(FUNCTIONS, tok.v)) throw new CalcError(`unknown function "${tok.v}"`);
          pos++;
          const args = [];
          if (!isOp(')')) {
            enter();
            try {
              args.push(expr());
              while (isOp(',')) {
                pos++;
                if (args.length >= MAX_ARGS) throw new CalcError('too many arguments');
                args.push(expr());
              }
            } finally { leave(); }
          }
          if (!isOp(')')) throw new CalcError('missing ")"');
          pos++;
          const [arity, fn] = FUNCTIONS[tok.v];
          if (arity >= 0 && args.length !== arity) throw new CalcError(`${tok.v}() takes ${arity} argument${arity === 1 ? '' : 's'}`);
          if (arity < 0 && args.length === 0) throw new CalcError(`${tok.v}() needs at least one argument`);
          return fn(...args);
        }
        if (has(CONSTANTS, tok.v)) return CONSTANTS[tok.v];
        throw new CalcError(`unknown name "${tok.v}"`);
      }
      if (isOp('(')) {
        pos++;
        enter();
        let v;
        try { v = expr(); } finally { leave(); }
        if (!isOp(')')) throw new CalcError('missing ")"');
        pos++;
        return v;
      }
      throw new CalcError(`unexpected "${tok.v}"`);
    }

    const value = expr();
    if (pos !== tokens.length) throw new CalcError(`unexpected "${tokens[pos].v}"`);
    if (!Number.isFinite(value)) throw new CalcError('result is not a finite number');
    return value;
  }

  function evaluate(src) {
    if (typeof src !== 'string') throw new CalcError('expected text');
    if (src.length > MAX_INPUT) throw new CalcError('expression is too long');
    return evaluateTokens(tokenize(src));
  }

  /** True when tokens contain a binary operator or a function call. */
  function looksLikeMath(tokens) {
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.t === 'op' && '+-*/%^'.includes(t.v) && i > 0) return true;
      if (t.t === 'id' && tokens[i + 1] && tokens[i + 1].v === '(') return true;
    }
    return false;
  }

  function format(n) {
    if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
    return String(Number(n.toPrecision(12)));
  }

  const WORD_CHAR = /[A-Za-z0-9_.]/;

  /**
   * For a line ending in "=", find the longest trailing math expression and
   * evaluate it. Returns null when the line holds no math.
   */
  function solveLine(line) {
    if (typeof line !== 'string' || line.length > MAX_INPUT * 2) return null;
    const m = /^(.*?)\s*=\s*$/.exec(line);
    if (!m) return null;
    const before = m[1];
    for (let start = 0; start < before.length; start++) {
      if (start > 0 && WORD_CHAR.test(before[start - 1]) && WORD_CHAR.test(before[start])) continue;
      const candidate = before.slice(start).trim();
      if (!candidate) break;
      if (candidate.length > MAX_INPUT) continue;
      try {
        const tokens = tokenize(candidate);
        if (!looksLikeMath(tokens)) continue;
        const value = evaluateTokens(tokens);
        return { expression: candidate, value, text: format(value) };
      } catch (err) {
        if (!(err instanceof CalcError)) throw err;
        // Not a valid expression from this start position; try a shorter suffix.
      }
    }
    return null;
  }

  return { evaluate, solveLine, format, CalcError, MAX_INPUT };
});
