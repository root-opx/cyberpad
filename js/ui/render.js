/* Renders the Markdown syntax tree to DOM nodes (no innerHTML anywhere). */
(function (root) {
  'use strict';
  const { h } = root.NP.dom;

  const LINK_OK = /^(https?:|mailto:)/i;

  function inlines(nodes, ctx) {
    return nodes.map((n) => inline(n, ctx));
  }

  function inline(n, ctx) {
    switch (n.type) {
      case 'text': return document.createTextNode(n.value);
      case 'br': return h('br');
      case 'code': return h('code', null, n.value);
      case 'strong': return h('strong', null, inlines(n.children, ctx));
      case 'em': return h('em', null, inlines(n.children, ctx));
      case 'del': return h('del', null, inlines(n.children, ctx));
      case 'mark': return h('mark', null, inlines(n.children, ctx));
      case 'link':
        // Defense in depth: the parser already allow-lists schemes.
        if (!LINK_OK.test(n.href)) return h('span', null, inlines(n.children, ctx));
        return h('a', { href: n.href, target: '_blank', rel: 'noopener noreferrer' }, inlines(n.children, ctx));
      case 'ref':
        if (!/^https:\/\/(nvd\.nist\.gov|cwe\.mitre\.org|attack\.mitre\.org)\//.test(n.href)) return h('span', null, inlines(n.children, ctx));
        return h('a', { href: n.href, target: '_blank', rel: 'noopener noreferrer', class: `ref ref-${n.kind}`, title: n.title }, inlines(n.children, ctx));
      case 'cvss': return cvssBadge(n.vector);
      case 'wiki': {
        const exists = ctx.noteExists(n.target);
        return h('a', {
          href: '#',
          class: exists ? 'wiki' : 'wiki missing',
          'data-wiki': n.target,
          title: exists ? `Open "${n.target}"` : `Create "${n.target}"`,
        }, n.label);
      }
      case 'tag': return h('a', { href: '#', class: 'tag', 'data-tag': n.name, title: `Show notes tagged #${n.name}` }, `#${n.name}`);
      default: return document.createTextNode('');
    }
  }

  /** A CVSS vector with its score. Invalid vectors stay plain text. */
  function cvssBadge(vector) {
    const cv = root.NP.cvss;
    let r;
    try {
      r = cv.calculate(vector);
    } catch (err) {
      if (err instanceof cv.CvssError) return document.createTextNode(vector);
      throw err;
    }
    const parts = [`CVSS ${r.version} base ${r.base} (${r.baseSeverity})`];
    if (r.temporal !== null) parts.push(`temporal ${r.temporal} (${r.temporalSeverity})`);
    if (r.environmental !== null) parts.push(`environmental ${r.environmental} (${r.environmentalSeverity})`);
    return h('span', { class: 'cvss-ref' },
      h('code', null, vector),
      h('button', {
        type: 'button',
        class: `sev sev-${r.baseSeverity.toLowerCase()}`,
        'data-cvss': vector,
        title: `${parts.join(', ')}. Open in the CVSS calculator.`,
      }, `${r.base.toFixed(1)} ${r.baseSeverity}`));
  }

  function block(b, ctx) {
    switch (b.type) {
      case 'heading': return h(`h${b.level}`, null, inlines(b.children, ctx));
      case 'paragraph': return h('p', null, inlines(b.children, ctx));
      case 'hr': return h('hr');
      case 'code': {
        const pre = h('pre', b.lang ? { 'data-lang': b.lang } : null,
          h('button', { type: 'button', class: 'copy-btn', 'data-copy': '' }, 'Copy'),
          h('code', null, b.text));
        return pre;
      }
      case 'quote': return h('blockquote', null, b.children.map((c) => block(c, ctx)));
      case 'list': {
        const list = h(b.ordered ? 'ol' : 'ul', b.ordered && b.start !== 1 ? { start: b.start } : null);
        for (const item of b.items) {
          const li = h('li');
          if (item.indent) li.style.marginLeft = `${item.indent * 1.25}rem`;
          if (item.task !== null) {
            li.className = item.task ? 'task done' : 'task';
            const box = h('input', {
              type: 'checkbox',
              'data-line': item.line,
              'aria-label': item.task ? 'Mark as not done' : 'Mark as done',
              checked: item.task,
              disabled: ctx.readOnly,
            });
            li.append(box, h('span', { class: 'task-text' }, inlines(item.children, ctx)));
          } else {
            li.append(...inlines(item.children, ctx));
          }
          list.append(li);
        }
        return list;
      }
      case 'table': {
        const cols = b.header.length;
        const cell = (tag, content, i) => {
          const c = h(tag, null, inlines(content || [], ctx));
          if (b.aligns[i] && b.aligns[i] !== 'left') c.style.textAlign = b.aligns[i];
          return c;
        };
        const thead = h('thead', null, h('tr', null, b.header.map((c, i) => cell('th', c, i))));
        const tbody = h('tbody', null, b.rows.map((row) => h('tr', null, Array.from({ length: cols }, (_, i) => cell('td', row[i], i)))));
        return h('div', { class: 'table-wrap' }, h('table', null, thead, tbody));
      }
      default: return document.createTextNode('');
    }
  }

  function renderMarkdown(blocks, ctx) {
    const frag = document.createDocumentFragment();
    for (const b of blocks) frag.append(block(b, ctx));
    return frag;
  }

  root.NP.renderMarkdown = renderMarkdown;
})(self);
