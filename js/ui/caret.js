/* Pixel position of a character offset inside a textarea, via a mirror element. */
(function (root) {
  'use strict';

  const PROPS = [
    'direction', 'boxSizing', 'width', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'borderStyle', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontStyle', 'fontVariant',
    'fontWeight', 'fontStretch', 'fontSize', 'lineHeight', 'fontFamily', 'textAlign', 'textTransform',
    'textIndent', 'letterSpacing', 'wordSpacing', 'tabSize', 'whiteSpace', 'overflowWrap', 'wordBreak',
  ];

  /** Returns {top, left, height} relative to the textarea's visible box. */
  function coords(ta, pos) {
    const cs = getComputedStyle(ta);
    const mirror = document.createElement('div');
    const st = mirror.style;
    for (const p of PROPS) st[p] = cs[p];
    st.position = 'absolute';
    st.visibility = 'hidden';
    st.top = '0';
    st.left = '-99999px';
    st.height = 'auto';
    st.overflow = 'hidden';
    mirror.textContent = ta.value.slice(0, pos);
    const marker = document.createElement('span');
    marker.textContent = ta.value.slice(pos, pos + 1) || '.';
    mirror.appendChild(marker);
    document.body.appendChild(mirror);
    const lineHeight = Number.parseFloat(cs.lineHeight) || Number.parseFloat(cs.fontSize) * 1.6;
    const out = {
      top: marker.offsetTop - ta.scrollTop,
      left: marker.offsetLeft - ta.scrollLeft,
      height: lineHeight,
    };
    mirror.remove();
    return out;
  }

  (root.NP = root.NP || {}).caret = { coords };
})(self);
