// Start-up theme: runs in <head>, before the stylesheet paints, so the page starts in the colours of the theme
// that was last on screen. app.js stores the theme SETTING under 'cyberpad.theme'; this only reads it.
// It cannot use js/core/store.js (not loaded yet), so it keeps its own allow-list, which a test pins to store.THEMES.
// Anything unexpected, or storage being unavailable, leaves the default (data-theme="neon" in index.html).
// Without matchMedia, 'system' resolves to light, the same as the app's own "not dark".
(function () {
  'use strict';
  try {
    var THEMES = Object.freeze(['system', 'light', 'dark', 'neon', 'amber', 'terminal']);
    var value = localStorage.getItem('cyberpad.theme');
    if (typeof value !== 'string' || THEMES.indexOf(value) < 0) return;
    if (value === 'system') {
      var dark = false;
      try { dark = !!matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { dark = false; }
      value = dark ? 'dark' : 'light';
    }
    document.documentElement.dataset.theme = value;
  } catch (e) { /* storage blocked or no DOM: keep the default theme */ }
})();
