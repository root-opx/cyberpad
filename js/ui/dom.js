/* Tiny DOM builder. Children are always added as text nodes or elements, never as HTML. */
(function (root) {
  'use strict';

  const SAFE_ATTR = /^(class|id|type|role|title|href|target|rel|download|start|tabindex|for|name|value|placeholder|autocomplete|maxlength|hidden|checked|disabled|aria-[a-z-]+|data-[a-z0-9-]+)$/;

  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (!SAFE_ATTR.test(k)) throw new Error(`Attribute not allowed: ${k}`);
        node.setAttribute(k, v === true ? '' : String(v));
      }
    }
    append(node, children);
    return node;
  }

  function append(node, children) {
    for (const c of children) {
      if (c == null || c === false) continue;
      if (Array.isArray(c)) append(node, c);
      else if (c instanceof Node) node.appendChild(c);
      else node.appendChild(document.createTextNode(String(c)));
    }
    return node;
  }

  (root.NP = root.NP || {}).dom = { h, append };
})(self);
