'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('the early theme script is loaded before the stylesheet', () => {
  const script = html.indexOf('<script src="js/early-theme.js"></script>');
  const sheet = html.indexOf('<link rel="stylesheet" href="css/style.css">');
  assert.ok(script >= 0, 'early-theme script tag present');
  assert.ok(sheet >= 0, 'stylesheet link present');
  assert.ok(script < sheet, 'script before stylesheet');
  assert.ok(script < html.indexOf('</head>'), 'script is in <head>');
});

test('the Content-Security-Policy is exactly the approved one', () => {
  const m = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html);
  assert.ok(m, 'CSP meta present');
  assert.equal(m[1], "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'");
});

test('no inline script and no style attribute anywhere', () => {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length > 0);
  for (const [, attrs, body] of scripts) {
    assert.match(attrs, /\bsrc="[^"]+"/, 'every script is external');
    assert.equal(body.trim(), '', 'script has no body');
  }
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.doesNotMatch(html, /<style\b/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'no inline event handlers');
});

test('the import file picker accepts every importable extension, and the drop hint matches', () => {
  const store = require('../js/core/store.js');
  const m = /<input type="file" id="file-input" accept="([^"]*)" hidden>/.exec(html);
  assert.ok(m, 'file input present');
  const accepted = m[1].split(',');
  for (const ext of store.IMPORT_EXTENSIONS) assert.ok(accepted.includes(`.${ext}`), `.${ext} is accepted`);
  assert.equal(accepted.length, store.IMPORT_EXTENSIONS.length, 'nothing extra is accepted');
  assert.ok(!accepted.includes('.cpnote'));
  assert.ok(html.includes('<p>Drop a text, code or backup .json file to import it</p>'));
});

test('highlight.js loads after codeedit.js, and the colouring layer is hidden from assistive technology', () => {
  assert.ok(html.indexOf('js/core/codeedit.js') < html.indexOf('js/core/highlight.js'));
  assert.ok(html.indexOf('js/core/highlight.js') < html.indexOf('js/app.js'));
  assert.match(html, /<pre class="hl" id="hl" aria-hidden="true" inert><\/pre>/);
});

test('ctf.js is loaded once, after highlight.js and before app.js', () => {
  assert.equal(html.split('js/core/ctf.js').length - 1, 1);
  assert.ok(html.indexOf('js/core/highlight.js') < html.indexOf('js/core/ctf.js'));
  assert.ok(html.indexOf('js/core/ctf.js') < html.indexOf('js/app.js'));
});
