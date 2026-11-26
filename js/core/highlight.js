/*
 * Line tokenizer and bracket matching for syntax colouring. Pure: no DOM, no
 * dependencies. One left-to-right character pass per line (no backtracking),
 * so tokenizeLine is O(line length). State carried between lines is a short
 * string drawn from a small fixed set per language ('0' is the default state).
 */
(function (root, factory) {
  'use strict';
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else (root.NP = root.NP || {}).highlight = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_LINE = 20000;           // longer lines are not coloured
  const MAX_SCAN_LINES = 5000;      // matchBracket gives up after this many lines
  const MAX_SCAN_CHARS = 2000000;   // ... or after this many characters

  const LANGUAGE_IDS = Object.freeze([
    'bash', 'c', 'cpp', 'csharp', 'css', 'go', 'html', 'java', 'javascript', 'json', 'powershell',
    'python', 'rust', 'sql', 'typescript', 'yaml', 'batch', 'ruby', 'php', 'lua', 'perl', 'xml', 'ini', 'plain',
  ]);

  const INITIAL = '0';
  const initialState = () => INITIAL;
  const sameState = (a, b) => a === b;

  const isDigit = (c) => c >= '0' && c <= '9';
  const isLetter = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
  const isIdStart = (c) => isLetter(c) || c === '_' || c > '\x7f';
  const isIdChar = (c) => isLetter(c) || c === '_' || isDigit(c) || c > '\x7f';
  const isWs = (c) => c === ' ' || c === '\t';
  const W = (s) => new Set(s.split(' '));

  // ---------------------------------------------------------------- numbers

  /** End of a number literal starting at a digit (hex/bin/oct, floats, exponent, suffix). */
  function numEnd(s, i) {
    const n = s.length;
    let j = i;
    if (s[j] === '0' && 'xXbBoO'.indexOf(s[j + 1]) >= 0 && s[j + 1] !== undefined) {
      j += 2;
      while (j < n && (isIdChar(s[j]))) j++;
      return j;
    }
    while (j < n && (isDigit(s[j]) || s[j] === '_')) j++;
    if (s[j] === '.' && isDigit(s[j + 1])) {
      j++;
      while (j < n && (isDigit(s[j]) || s[j] === '_')) j++;
    }
    if (s[j] === 'e' || s[j] === 'E') {
      let k = j + 1;
      if (s[k] === '+' || s[k] === '-') k++;
      if (isDigit(s[k])) { j = k; while (j < n && isDigit(s[j])) j++; }
    }
    while (j < n && isIdChar(s[j])) j++;
    return j;
  }

  // ------------------------------------------------- generic "code" scanner

  const CPP_KW = 'auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while';

  const CODE = {
    python: {
      line: ['#'], quotes: '"\'', esc: '"\'', triple: '"\'', pyStr: true, decorator: true,
      kw: W('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case'),
      cst: W('None True False'),
    },
    javascript: {
      line: ['//'], block: ['/*', '*/'], quotes: '"\'', esc: '"\'', tmpl: true, dollarId: true,
      kw: W('break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new of return super switch this throw try typeof var void while with yield async await static'),
      cst: W('true false null undefined NaN Infinity'),
    },
    typescript: {
      line: ['//'], block: ['/*', '*/'], quotes: '"\'', esc: '"\'', tmpl: true, dollarId: true,
      kw: W('break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new of return super switch this throw try typeof var void while with yield async await static interface type enum implements namespace abstract readonly declare public private protected as is keyof infer satisfies unknown never any string number boolean'),
      cst: W('true false null undefined NaN Infinity'),
    },
    c: {
      line: ['//'], block: ['/*', '*/'], quotes: '"\'', esc: '"\'', directive: true,
      kw: W(CPP_KW), cst: W('NULL true false'),
    },
    cpp: {
      line: ['//'], block: ['/*', '*/'], quotes: '"\'', esc: '"\'', directive: true,
      kw: W(CPP_KW + ' bool catch class constexpr delete explicit friend mutable namespace new noexcept operator private protected public template this throw try typename using virtual override final static_cast dynamic_cast reinterpret_cast const_cast'),
      cst: W('NULL true false nullptr'),
    },
    csharp: {
      line: ['//'], block: ['/*', '*/'], quotes: '"\'', esc: '"\'', csVerb: true,
      kw: W('abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new object operator out override params private protected public readonly ref return sbyte sealed short sizeof static string struct switch this throw try typeof uint ulong unchecked unsafe ushort using var virtual void volatile while async await'),
      cst: W('true false null'),
    },
    java: {
      line: ['//'], block: ['/*', '*/'], quotes: '"\'', esc: '"\'', triple: '"', dollarId: true,
      kw: W('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while var record'),
      cst: W('true false null'),
    },
    go: {
      line: ['//'], block: ['/*', '*/'], quotes: '"\'', esc: '"\'', goRaw: true,
      kw: W('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var'),
      cst: W('true false nil iota'),
    },
    rust: {
      line: ['//'], block: ['/*', '*/'], quotes: '"\'', esc: '"\'', rustRaw: true, rustChar: true,
      kw: W('as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while'),
      cst: W('true false'),
    },
    php: {
      line: ['//', '#'], block: ['/*', '*/'], quotes: '"\'', esc: '"\'', dollar: true, ci: true,
      kw: W('abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list namespace new or print private protected public require require_once return static switch throw trait try unset use var while xor yield'),
      cst: W('true false null'),
    },
    bash: {
      line: ['#'], hashWord: true, quotes: '"\'', esc: '"', dollar: true, dollarSpecial: true,
      kw: W('if then else elif fi for while until do done case esac function in return exit echo export local select time read cd source alias set unset shift break continue trap eval exec printf declare readonly test'),
      cst: W('true false'),
    },
    powershell: {
      line: ['#'], hashWord: true, block: ['<#', '#>'], quotes: '"\'', esc: '"', dbl: '"\'', escChar: '`',
      dollar: true, dollarSpecial: true, psColon: true, ci: true, idHyphen: true, psOps: true,
      kw: W('if elseif else switch foreach for while do until break continue return function param begin process end try catch finally throw trap exit class using in filter workflow'),
      cst: W('true false null'),
      verbs: W('get set new remove write read invoke import export select where foreach sort out add clear test start stop copy move rename join split format convert compare measure enable disable register unregister wait'),
    },
    batch: {
      line: [], quotes: '"', esc: '', batch: true, ci: true,
      kw: W('echo set if else for in do goto call exit setlocal endlocal not exist equ neq lss leq gtr geq off on defined errorlevel pause cd dir copy move del type start shift pushd popd title cls'),
      cst: W('nul'),
    },
    sql: {
      line: ['--'], block: ['/*', '*/'], quotes: '"\'', esc: '', dbl: '"\'', ci: true,
      kw: W('select from where insert into values update set delete create table drop alter add index primary key foreign references join inner left right outer full cross on group by order having limit offset union all distinct as and or not in is like between exists case when then else end asc desc begin commit rollback grant revoke view database default unique check constraint top'),
      cst: W('null true false'),
    },
    ruby: {
      line: ['#'], quotes: '"\'', esc: '"\'', dollar: true, atVar: 'ruby',
      kw: W('alias and begin break case class def defined? do else elsif end ensure for if in module next not or redo rescue retry return self super then undef unless until when while yield puts require'),
      cst: W('true false nil'),
    },
    perl: {
      line: ['#'], quotes: '"\'', esc: '"\'', dollar: true, dollarSpecial: true, atVar: 'perl',
      kw: W('my our local sub use no package if elsif else unless while until for foreach return last next redo do eval die print require and or not qw'),
      cst: W('undef'),
    },
    lua: {
      line: ['--'], quotes: '"\'', esc: '"\'', luaLong: true,
      kw: W('and break do else elseif end for function goto if in local not or repeat return then until while'),
      cst: W('true false nil'),
    },
  };

  /** Per-language set of valid carried states, derived from the config. */
  function statesOf(cfg) {
    const s = new Set([INITIAL]);
    if (cfg.block) s.add('bc');
    if (cfg.triple) { if (cfg.triple.indexOf('"') >= 0) s.add('td'); if (cfg.triple.indexOf("'") >= 0) s.add('ts'); }
    if (cfg.tmpl) s.add('tl');
    if (cfg.goRaw) s.add('gb');
    if (cfg.luaLong) for (let l = 0; l <= 3; l++) { s.add('lc' + l); s.add('ls' + l); }
    return s;
  }

  const MULTI_CLOSE = { td: '"""', ts: "'''", tl: '`' };

  const BRACKET_OPEN_PS_OPS = W('eq ne gt lt ge le like notlike match notmatch contains notcontains in notin replace is isnot as and or not xor band bor split join');

  function scan(cfg, line, st, add) {
    const n = line.length;
    let i = 0;
    let state = INITIAL;
    let seen = false;
    const hasLine = cfg.line.length > 0;
    const idS = (c) => isIdStart(c) || (cfg.dollarId === true && c === '$');
    const idC = (c) => isIdChar(c) || (cfg.dollarId === true && c === '$');

    const endOf = (s, from) => {
      const k = s.slice(0, 2);
      let e;
      if (k === 'bc') {
        e = line.indexOf(cfg.block[1], from);
        return e < 0 ? -1 : e + cfg.block[1].length;
      }
      if (k === 'gb') { e = line.indexOf('`', from); return e < 0 ? -1 : e + 1; }
      if (k === 'lc' || k === 'ls') {
        const close = ']' + '='.repeat(s.charCodeAt(2) - 48) + ']';
        e = line.indexOf(close, from);
        return e < 0 ? -1 : e + close.length;
      }
      const q = MULTI_CLOSE[k];
      for (let j = from; j < n; j++) {
        const c = line[j];
        if (c === '\\') j++;
        else if (c === q[0] && line.startsWith(q, j)) return j + q.length;
      }
      return -1;
    };
    const multi = (s, type, tok, from) => {
      const e = endOf(s, from);
      if (e < 0) { add(tok, n, type); state = s; i = n; } else { add(tok, e, type); i = e; }
    };
    const typeOfState = (s) => (s === 'bc' || s[0] === 'l' && s[1] === 'c' ? 'comment' : 'string');

    const scanStr = (qi, q) => {
      const dbl = cfg.dbl && cfg.dbl.indexOf(q) >= 0;
      const esc = cfg.esc && cfg.esc.indexOf(q) >= 0;
      const ec = cfg.escChar || '\\';
      let j = qi + 1;
      while (j < n) {
        const c = line[j];
        if (c === q) {
          if (dbl && line[j + 1] === q) { j += 2; continue; }
          return j + 1;
        }
        if (esc && c === ec) j += 2; else j++;
      }
      return n;
    };

    const doString = (tok, qi, q) => {
      if (q === '`') {
        if (cfg.tmpl) { multi('tl', 'string', tok, qi + 1); return true; }
        if (cfg.goRaw) { multi('gb', 'string', tok, qi + 1); return true; }
        return false;
      }
      if (cfg.triple && cfg.triple.indexOf(q) >= 0 && line.startsWith(q + q + q, qi)) {
        multi(q === '"' ? 'td' : 'ts', 'string', tok, qi + 3);
        return true;
      }
      if (cfg.rustChar && q === "'") {
        let e;
        if (line[qi + 1] === '\\') e = scanStr(qi, q);
        else if (line[qi + 2] === "'") e = qi + 3;
        else { i = qi + 1; return true; } // a lifetime such as 'a: not a string
        add(tok, e, 'string');
        i = e;
        return true;
      }
      const e = scanStr(qi, q);
      add(tok, e, 'string');
      i = e;
      return true;
    };

    // Continue a construct carried over from the previous line.
    if (st !== INITIAL) multi(st, typeOfState(st), 0, 0);

    // Batch: whole-line comments and labels.
    if (cfg.batch && state === INITIAL && i === 0) {
      let k = 0;
      while (k < n && isWs(line[k])) k++;
      const s0 = k;
      if (line[k] === '@') k++;
      if (line.startsWith('::', k)) { add(s0, n, 'comment'); return INITIAL; }
      if (line.substr(k, 3).toLowerCase() === 'rem' && (k + 3 >= n || isWs(line[k + 3]))) {
        add(s0, n, 'comment');
        return INITIAL;
      }
      if (line[k] === ':' && k + 1 < n && !isWs(line[k + 1])) {
        let e = k + 1;
        while (e < n && !isWs(line[e])) e++;
        add(k, e, 'section');
        i = e;
        seen = true;
      }
    }

    while (i < n) {
      const c = line[i];
      if (c === ' ' || c === '\t') { i++; continue; }
      const first = !seen;
      seen = true;

      if (hasLine) {
        let lc = null;
        for (let m = 0; m < cfg.line.length; m++) {
          const mk = cfg.line[m];
          if (c === mk[0] && line.startsWith(mk, i)) { lc = mk; break; }
        }
        if (lc !== null) {
          if (cfg.hashWord && lc === '#' && i > 0 && !isWs(line[i - 1]) && ';&|('.indexOf(line[i - 1]) < 0) {
            i++;
            continue;
          }
          if (cfg.luaLong) {
            let k = i + 2;
            if (line[k] === '[') {
              k++;
              let lvl = 0;
              while (line[k] === '=' && lvl <= 3) { lvl++; k++; }
              if (line[k] === '[' && lvl <= 3) { multi('lc' + lvl, 'comment', i, k + 1); continue; }
            }
          }
          add(i, n, 'comment');
          i = n;
          continue;
        }
      }
      if (cfg.block && c === cfg.block[0][0] && line.startsWith(cfg.block[0], i)) {
        multi('bc', 'comment', i, i + cfg.block[0].length);
        continue;
      }
      if (cfg.directive && c === '#' && first) {
        let j = i + 1;
        while (j < n && isWs(line[j])) j++;
        let k = j;
        while (k < n && isLetter(line[k])) k++;
        if (k > j) {
          add(i, k, 'keyword');
          const w = line.slice(j, k);
          i = k;
          if (w === 'include' || w === 'import') {
            while (i < n && isWs(line[i])) i++;
            if (line[i] === '<') {
              const e = line.indexOf('>', i);
              const end = e < 0 ? n : e + 1;
              add(i, end, 'string');
              i = end;
            }
          }
          continue;
        }
        i++;
        continue;
      }

      // Variables.
      if (cfg.dollar && c === '$') {
        const d = line[i + 1];
        let e = i;
        if (d === '{') {
          const k = line.indexOf('}', i + 2);
          e = k < 0 ? n : k + 1;
        } else if (isIdStart(d)) {
          e = i + 2;
          while (e < n) {
            if (isIdChar(line[e])) e++;
            else if (cfg.psColon && line[e] === ':' && isIdStart(line[e + 1])) e += 2;
            else break;
          }
        } else if (isDigit(d)) {
          e = i + 2;
          while (e < n && isDigit(line[e])) e++;
        } else if (cfg.dollarSpecial && d !== undefined && '?#@$!*-&'.indexOf(d) >= 0) {
          e = i + 2;
        }
        if (e > i) { add(i, e, 'variable'); i = e; } else i++;
        continue;
      }
      if (cfg.atVar && c === '@') {
        let k = i + 1;
        if (cfg.atVar === 'ruby' && line[k] === '@') k++;
        if (isIdStart(line[k])) {
          let e = k + 1;
          while (e < n && isIdChar(line[e])) e++;
          add(i, e, 'variable');
          i = e;
        } else i++;
        continue;
      }
      if (cfg.batch && c === '%') {
        let e = -1;
        if (line[i + 1] === '%' && isIdChar(line[i + 2])) e = i + 3;
        else if (isDigit(line[i + 1]) || line[i + 1] === '~') {
          e = i + 2;
          while (e < n && (isIdChar(line[e]) || line[e] === '~')) e++;
        } else {
          let j = i + 1;
          while (j < n && line[j] !== '%' && !isWs(line[j])) j++;
          if (line[j] === '%' && j > i + 1) e = j + 1;
        }
        if (e > i) { add(i, e, 'variable'); i = e; } else i++;
        continue;
      }

      // Strings.
      if (cfg.quotes.indexOf(c) >= 0 || (c === '`' && (cfg.tmpl || cfg.goRaw))) {
        if (doString(i, i, c)) continue;
      }
      if (cfg.luaLong && c === '[') {
        let k = i + 1;
        let lvl = 0;
        while (line[k] === '=' && lvl <= 3) { lvl++; k++; }
        if (line[k] === '[' && lvl <= 3) { multi('ls' + lvl, 'string', i, k + 1); continue; }
        i++;
        continue;
      }
      if (c === '@') {
        if (cfg.decorator && first && isIdStart(line[i + 1])) {
          let e = i + 2;
          while (e < n && (isIdChar(line[e]) || line[e] === '.')) e++;
          add(i, e, 'keyword');
          i = e;
          continue;
        }
        if (cfg.csVerb) {
          if (line[i + 1] === '"') {
            let j = i + 2;
            while (j < n) {
              if (line[j] === '"') { if (line[j + 1] === '"') j += 2; else { j++; break; } } else j++;
            }
            add(i, j, 'string');
            i = j;
            continue;
          }
          if (isIdStart(line[i + 1])) {
            let e = i + 2;
            while (e < n && isIdChar(line[e])) e++;
            i = e;
            continue;
          }
        }
        i++;
        continue;
      }

      if (isDigit(c)) {
        const e = numEnd(line, i);
        add(i, e, 'number');
        i = e;
        continue;
      }

      if (idS(c)) {
        let j = i + 1;
        for (;;) {
          if (j >= n) break;
          const d = line[j];
          if (idC(d)) j++;
          else if (cfg.idHyphen && d === '-' && isLetter(line[j + 1])) j++;
          else break;
        }
        const w = line.slice(i, j);
        const nx = line[j];
        if (cfg.pyStr && j - i <= 2 && (nx === '"' || nx === "'") && /^[rbfuRBFU]+$/.test(w)) {
          doString(i, j, nx);
          continue;
        }
        if (cfg.rustRaw && (w === 'r' || w === 'br') && (nx === '"' || nx === '#')) {
          let h = 0;
          while (line[j + h] === '#') h++;
          if (line[j + h] === '"') {
            const close = '"' + '#'.repeat(h);
            const e = line.indexOf(close, j + h + 1);
            const end = e < 0 ? n : e + close.length;
            add(i, end, 'string');
            i = end;
            continue;
          }
        }
        const key = cfg.ci ? w.toLowerCase() : w;
        if (cfg.kw.has(key)) add(i, j, 'keyword');
        else if (cfg.cst.has(key)) add(i, j, 'constant');
        else if (cfg.verbs) {
          const h = key.indexOf('-');
          if (h > 0 && cfg.verbs.has(key.slice(0, h))) add(i, j, 'keyword');
        }
        i = j;
        continue;
      }

      if (cfg.psOps && c === '-' && isLetter(line[i + 1]) && (i === 0 || !isIdChar(line[i - 1]))) {
        let e = i + 2;
        while (e < n && isLetter(line[e])) e++;
        if (BRACKET_OPEN_PS_OPS.has(line.slice(i + 1, e).toLowerCase())) add(i, e, 'keyword');
        i = e;
        continue;
      }
      i++;
    }
    return state;
  }

  // ---------------------------------------------------------- HTML and XML

  const isNameChar = (c) => isIdChar(c) || c === '-' || c === ':' || c === '.';

  function runMarkup(line, st, add) {
    const n = line.length;
    let i = 0;
    let tagMode = false;
    if (st === 'hc') {
      const e = line.indexOf('-->');
      if (e < 0) { add(0, n, 'comment'); return 'hc'; }
      add(0, e + 3, 'comment');
      i = e + 3;
    } else if (st === 'tq"' || st === "tq'") {
      const q = st[2];
      const e = line.indexOf(q);
      if (e < 0) { add(0, n, 'string'); return st; }
      add(0, e + 1, 'string');
      i = e + 1;
      tagMode = true;
    } else if (st === 'tag') tagMode = true;

    while (i < n) {
      if (!tagMode) {
        const lt = line.indexOf('<', i);
        if (lt < 0) break;
        if (line.startsWith('<!--', lt)) {
          const e = line.indexOf('-->', lt + 4);
          if (e < 0) { add(lt, n, 'comment'); return 'hc'; }
          add(lt, e + 3, 'comment');
          i = e + 3;
          continue;
        }
        const d = line[lt + 1];
        if (isLetter(d) || d === '/' || d === '!' || d === '?') {
          let j = lt + 1;
          if (!isLetter(d)) j++;
          while (j < n && isNameChar(line[j])) j++;
          add(lt, j, 'tag');
          i = j;
          tagMode = true;
          continue;
        }
        i = lt + 1;
        continue;
      }
      const c = line[i];
      if (isWs(c) || c === '=') { i++; continue; }
      if (c === '>') { add(i, i + 1, 'tag'); tagMode = false; i++; continue; }
      if ((c === '/' || c === '?') && line[i + 1] === '>') { add(i, i + 2, 'tag'); tagMode = false; i += 2; continue; }
      if (c === '/') { i++; continue; }
      if (c === '"' || c === "'") {
        const e = line.indexOf(c, i + 1);
        if (e < 0) { add(i, n, 'string'); return 'tq' + c; }
        add(i, e + 1, 'string');
        i = e + 1;
        continue;
      }
      let j = i + 1;
      while (j < n) {
        const d = line[j];
        if (isWs(d) || d === '=' || d === '>' || d === '"' || d === "'" ||
          ((d === '/' || d === '?') && line[j + 1] === '>')) break;
        j++;
      }
      add(i, j, 'attr');
      i = j;
    }
    return tagMode ? 'tag' : INITIAL;
  }

  // ------------------------------------------------------------------- CSS

  const CSS_GROUP = W('media supports layer container document keyframes -webkit-keyframes -moz-keyframes');

  function runCss(line, st, add) {
    const n = line.length;
    let i = 0;
    let inBlock = st === 'css' || st === 'cbc';
    let inValue = false;
    let group = false;
    if (st === 'bc' || st === 'cbc') {
      const e = line.indexOf('*/');
      if (e < 0) { add(0, n, 'comment'); return st; }
      add(0, e + 2, 'comment');
      i = e + 2;
    }
    while (i < n) {
      const c = line[i];
      if (isWs(c)) { i++; continue; }
      if (c === '/' && line[i + 1] === '*') {
        const e = line.indexOf('*/', i + 2);
        if (e < 0) { add(i, n, 'comment'); return inBlock ? 'cbc' : 'bc'; }
        add(i, e + 2, 'comment');
        i = e + 2;
        continue;
      }
      if (!inBlock) {
        if (c === '{') { inBlock = !group; group = false; inValue = false; i++; continue; }
        if (c === '}' || c === ';') { i++; continue; }
        let j = i;
        while (j < n) {
          const d = line[j];
          if (d === '{' || d === ';' || d === '}' || (d === '/' && line[j + 1] === '*')) break;
          j++;
        }
        let e = j;
        while (e > i && isWs(line[e - 1])) e--;
        add(i, e, 'section');
        if (c === '@') {
          let k = i + 1;
          while (k < e && (isNameChar(line[k]) && line[k] !== ':')) k++;
          group = CSS_GROUP.has(line.slice(i + 1, k).toLowerCase());
        }
        i = j;
        continue;
      }
      if (c === '}') { inBlock = false; inValue = false; i++; continue; }
      if (c === '{') { i++; continue; }
      if (c === ';') { inValue = false; i++; continue; }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < n && line[j] !== c) j += line[j] === '\\' ? 2 : 1;
        j = j < n ? j + 1 : n;
        add(i, j, 'string');
        i = j;
        continue;
      }
      if (inValue && c === '#') {
        let j = i + 1;
        while (j < n && isIdChar(line[j])) j++;
        if (j > i + 1) add(i, j, 'number');
        i = j;
        continue;
      }
      if (inValue && (isDigit(c) || ((c === '.' || c === '-' || c === '+') &&
        (isDigit(line[i + 1]) || (line[i + 1] === '.' && isDigit(line[i + 2])))))) {
        let j = i;
        if (c === '-' || c === '+') j++;
        while (j < n && isDigit(line[j])) j++;
        if (line[j] === '.' && isDigit(line[j + 1])) { j++; while (j < n && isDigit(line[j])) j++; }
        while (j < n && (isLetter(line[j]) || line[j] === '%')) j++;
        add(i, j, 'number');
        i = j;
        continue;
      }
      if (isIdChar(c) || c === '-') {
        let j = i + 1;
        while (j < n && (isIdChar(line[j]) || line[j] === '-')) j++;
        if (!inValue) {
          let k = j;
          while (k < n && isWs(line[k])) k++;
          if (line[k] === ':') { add(i, j, 'attr'); inValue = true; i = k + 1; continue; }
        }
        i = j;
        continue;
      }
      i++;
    }
    return inBlock ? 'css' : INITIAL;
  }

  // ------------------------------------------------------------------ JSON

  function runJson(line, st, add) {
    const n = line.length;
    let i = 0;
    while (i < n) {
      const c = line[i];
      if (c === '"') {
        let j = i + 1;
        let closed = false;
        while (j < n) {
          const d = line[j];
          if (d === '\\') j += 2;
          else if (d === '"') { j++; closed = true; break; } else j++;
        }
        if (j > n) j = n;
        let k = j;
        while (k < n && isWs(line[k])) k++;
        add(i, j, closed && line[k] === ':' ? 'attr' : 'string');
        i = j;
        continue;
      }
      if (isDigit(c) || (c === '-' && isDigit(line[i + 1]))) {
        const e = numEnd(line, c === '-' ? i + 1 : i);
        add(i, e, 'number');
        i = e;
        continue;
      }
      if (isLetter(c)) {
        let j = i + 1;
        while (j < n && isIdChar(line[j])) j++;
        const w = line.slice(i, j);
        if (w === 'true' || w === 'false' || w === 'null') add(i, j, 'constant');
        i = j;
        continue;
      }
      i++;
    }
    return INITIAL;
  }

  // ------------------------------------------------------ YAML and INI values

  const YAML_CONST = W('true false null yes no on off ~');
  const INI_CONST = W('true false yes no on off');

  function wordValue(line, i, j, consts, add) {
    const c = line[i];
    const s = (c === '-' || c === '+') ? i + 1 : i;
    if (isDigit(line[s]) && numEnd(line, s) === j) add(i, j, 'number');
    else if (consts.has(line.slice(i, j).toLowerCase())) add(i, j, 'constant');
  }

  function runYaml(line, st, add) {
    const n = line.length;
    let i = 0;
    if ((line.startsWith('---') || line.startsWith('...')) && (n === 3 || isWs(line[3]))) {
      add(0, 3, 'section');
      i = 3;
    } else {
      while (i < n && isWs(line[i])) i++;
      while (line[i] === '-' && (i + 1 >= n || isWs(line[i + 1]))) {
        i++;
        while (i < n && isWs(line[i])) i++;
      }
      const c = line[i];
      if (i < n && '#[{|>&*!%@'.indexOf(c) < 0) {
        let kEnd = -1;
        let colon = -1;
        if (c === '"' || c === "'") {
          let j = i + 1;
          while (j < n && line[j] !== c) j += (c === '"' && line[j] === '\\') ? 2 : 1;
          if (j < n) {
            kEnd = j + 1;
            let k = kEnd;
            while (k < n && isWs(line[k])) k++;
            if (line[k] === ':' && (k + 1 >= n || isWs(line[k + 1]))) colon = k;
          }
        } else {
          for (let j = i; j < n; j++) {
            const d = line[j];
            if (d === ':' && (j + 1 >= n || isWs(line[j + 1]))) { colon = j; kEnd = j; break; }
            if (d === '#' && j > i && isWs(line[j - 1])) break;
          }
          while (kEnd > i && isWs(line[kEnd - 1])) kEnd--;
        }
        if (colon >= 0 && kEnd > i) {
          add(i, kEnd, 'attr');
          i = colon + 1;
        }
      }
    }
    while (i < n) {
      const c = line[i];
      if (isWs(c)) { i++; continue; }
      if (c === '#' && (i === 0 || isWs(line[i - 1]))) { add(i, n, 'comment'); break; }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < n) {
          if (line[j] === c) {
            if (c === "'" && line[j + 1] === "'") { j += 2; continue; }
            j++;
            break;
          }
          j += (c === '"' && line[j] === '\\') ? 2 : 1;
        }
        if (j > n) j = n;
        add(i, j, 'string');
        i = j;
        continue;
      }
      if (',[]{}:'.indexOf(c) >= 0) { i++; continue; }
      let j = i + 1;
      while (j < n && !isWs(line[j]) && ',[]{}:'.indexOf(line[j]) < 0) j++;
      wordValue(line, i, j, YAML_CONST, add);
      i = j;
    }
    return INITIAL;
  }

  function runIni(line, st, add) {
    const n = line.length;
    let i = 0;
    while (i < n && isWs(line[i])) i++;
    if (i >= n) return INITIAL;
    const c0 = line[i];
    if (c0 === '#' || c0 === ';') { add(i, n, 'comment'); return INITIAL; }
    if (c0 === '[') {
      const e = line.indexOf(']', i);
      add(i, e < 0 ? n : e + 1, 'section');
      return INITIAL;
    }
    let j = i;
    while (j < n && line[j] !== '=' && line[j] !== ':') j++;
    if (j < n) {
      let e = j;
      while (e > i && isWs(line[e - 1])) e--;
      if (e > i) add(i, e, 'attr');
      i = j + 1;
    }
    while (i < n) {
      const c = line[i];
      if (isWs(c)) { i++; continue; }
      if (c === '"' || c === "'") {
        const e = line.indexOf(c, i + 1);
        const end = e < 0 ? n : e + 1;
        add(i, end, 'string');
        i = end;
        continue;
      }
      let k = i + 1;
      while (k < n && !isWs(line[k]) && line[k] !== ',') k++;
      wordValue(line, i, k, INI_CONST, add);
      i = k;
    }
    return INITIAL;
  }

  // ------------------------------------------------------------- dispatch

  const IMPL = new Map();
  for (const id of Object.keys(CODE)) {
    const cfg = CODE[id];
    cfg.cst = cfg.cst || new Set();
    cfg.line = cfg.line || [];
    cfg.quotes = cfg.quotes || '';
    const states = statesOf(cfg);
    IMPL.set(id, { states, run: (line, st, add) => scan(cfg, line, st, add) });
  }
  IMPL.set('html', { states: new Set([INITIAL, 'hc', 'tag', 'tq"', "tq'"]), run: runMarkup });
  IMPL.set('xml', IMPL.get('html'));
  IMPL.set('css', { states: new Set([INITIAL, 'bc', 'css', 'cbc']), run: runCss });
  IMPL.set('json', { states: new Set([INITIAL]), run: runJson });
  IMPL.set('yaml', { states: new Set([INITIAL]), run: runYaml });
  IMPL.set('ini', { states: new Set([INITIAL]), run: runIni });

  /**
   * Colour one line. Unknown language, 'plain' or a non-string line: no tokens,
   * state returned unchanged. A line over 20,000 characters is not coloured and
   * the returned state resets to initialState(). A state that is not valid for
   * the language is treated as the initial state. Never throws.
   */
  function tokenizeLine(lang, line, state) {
    const impl = typeof lang === 'string' ? IMPL.get(lang) : undefined;
    if (!impl || typeof line !== 'string') return { tokens: [], state };
    if (line.length > MAX_LINE) return { tokens: [], state: INITIAL };
    const st = typeof state === 'string' && impl.states.has(state) ? state : INITIAL;
    const tokens = [];
    const n = line.length;
    let last = 0;
    const add = (s, e, type) => {
      if (e > n) e = n;
      if (s < last) s = last;
      if (e > s) { tokens.push({ start: s, end: e, type }); last = e; }
    };
    try {
      return { tokens, state: impl.run(line, st, add) };
    } catch (e) {
      return { tokens: [], state: INITIAL };
    }
  }

  // ------------------------------------------------------- bracket matching

  const OPEN = '([{';
  const CLOSE = ')]}';

  /**
   * Find the bracket partner of the bracket just before (else just after) the
   * caret, ignoring brackets inside comment and string tokens. At most 5,000
   * lines (and 2,000,000 characters) are scanned in the needed direction.
   */
  function matchBracket(getLine, lineCount, lineIndex, column, lang, stateAt) {
    try {
      if (typeof getLine !== 'function' || !Number.isInteger(lineCount) || !Number.isInteger(lineIndex) ||
        !Number.isInteger(column) || lineCount < 1 || lineIndex < 0 || lineIndex >= lineCount || column < 0) return null;
      const cache = new Map();
      let budget = MAX_SCAN_CHARS;
      // Brackets of line i outside strings and comments: [[column, char], ...] or null when unreadable.
      const bracketsOf = (i) => {
        if (cache.has(i)) return cache.get(i);
        let res = null;
        const text = getLine(i);
        if (typeof text === 'string') {
          budget -= text.length + 1;
          let st;
          try { st = typeof stateAt === 'function' ? stateAt(i) : undefined; } catch (e) { st = undefined; }
          const toks = tokenizeLine(lang, text, st === undefined ? INITIAL : st).tokens;
          res = [];
          let t = 0;
          for (let k = 0; k < text.length; k++) {
            const ch = text[k];
            const o = OPEN.indexOf(ch);
            if (o < 0 && CLOSE.indexOf(ch) < 0) continue;
            while (t < toks.length && toks[t].end <= k) t++;
            const tok = t < toks.length ? toks[t] : null;
            if (tok && tok.start <= k && (tok.type === 'comment' || tok.type === 'string')) continue;
            res.push([k, ch]);
          }
        }
        cache.set(i, res);
        return res;
      };
      const text0 = getLine(lineIndex);
      if (typeof text0 !== 'string' || column > text0.length) return null;
      const here = bracketsOf(lineIndex);
      if (!here) return null;
      const at = (col) => {
        for (let k = 0; k < here.length; k++) if (here[k][0] === col) return here[k][1];
        return null;
      };
      for (const col of [column - 1, column]) {
        const ch = at(col);
        if (ch === null) continue;
        const o = OPEN.indexOf(ch);
        if (o >= 0) {
          const want = CLOSE[o];
          let depth = 0;
          const last = Math.min(lineCount - 1, lineIndex + MAX_SCAN_LINES);
          for (let li = lineIndex; li <= last; li++) {
            const bs = bracketsOf(li);
            if (budget < 0) return null;
            if (!bs) continue;
            for (let k = 0; k < bs.length; k++) {
              const [bc, b] = bs[k];
              if (li === lineIndex && bc <= col) continue;
              if (b === ch) depth++;
              else if (b === want) {
                if (depth === 0) return { open: { line: lineIndex, column: col }, close: { line: li, column: bc } };
                depth--;
              }
            }
          }
        } else {
          const want = OPEN[CLOSE.indexOf(ch)];
          let depth = 0;
          const first = Math.max(0, lineIndex - MAX_SCAN_LINES);
          for (let li = lineIndex; li >= first; li--) {
            const bs = bracketsOf(li);
            if (budget < 0) return null;
            if (!bs) continue;
            for (let k = bs.length - 1; k >= 0; k--) {
              const [bc, b] = bs[k];
              if (li === lineIndex && bc >= col) continue;
              if (b === ch) depth++;
              else if (b === want) {
                if (depth === 0) return { open: { line: li, column: bc }, close: { line: lineIndex, column: col } };
                depth--;
              }
            }
          }
        }
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  return { LANGUAGE_IDS, initialState, sameState, tokenizeLine, matchBracket };
});
