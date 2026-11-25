# UX/UI enhancement: handoff

Start here if you are picking up the UX/UI work on CyberPad in a fresh session. It covers the project as it stands, the rules any change must keep, and what is still undecided.

## What CyberPad is

An offline, cyberpunk-retro notepad for a cybersecurity specialist. It runs as a plain web page or as a Windows desktop app (WinForms + WebView2) that loads the same page. Besides Markdown notes with a live preview it has slash inserts, an inline calculator, AES-GCM note encryption, a secret scanner, IOC extraction and defanging, a CVSS calculator, a subnet calculator, and, in the desktop app only, notes linked to `.txt`/`.md`/`.cpnote` files on disk. The README lists every feature and shortcut.

The look is "a salvaged corporate terminal": dark screens, a display face in OCR-A, glowing signal colours, an optional CRT effect (scanlines and glow), optional typing sounds, and a boot animation.

## What is decided and what is not

- **Decided:** the user wants to improve the UX/UI. Everything functional is finished and tested.
- **Not decided:** what "better" means. Which screens, which pain points, and whether the retro identity stays as it is, gets refined or changes are all open. Ask the user before designing. Use the superpowers brainstorming skill: an approved design doc in `docs/superpowers/specs/`, then a plan, then build.

## Where things are

```
index.html        app shell: titlebar, sidebar, workspace (editor + preview), statusbar, dialogs, CSP
css/style.css     everything visual, about 1,200 lines; theme tokens at the top
js/app.js         application controller (about 3,500 lines): rendering of lists, bars, dialogs, palette, toasts
js/ui/dom.js      NP.dom.h(tag, attrs, ...children): the only way UI builds elements
js/ui/render.js   Markdown tree to DOM for the preview
js/ui/caret.js    caret position (for the slash popup)
js/ui/sound.js    typing sounds (Web Audio)
js/core/          pure logic with Node tests; usually no UI work here
js/platform.js    storage and file bridge (browser or desktop host)
desktop/          Windows host, xUnit tests, build.ps1
```

**Themes.** These are set by `data-theme` on `<html>` and chosen in the titlebar:

| Theme | `data-theme` | Look |
|---|---|---|
| Neon | `neon` | the default |
| Amber | `amber` | amber terminal |
| Terminal green | `terminal` | green phosphor |

- **Colour tokens:** `--void` (screen), `--panel`, `--raise`, `--line`, `--ink`, `--dim`, `--hot` (active/danger), `--cool` (links/focus/success), `--warn`, `--sel`, `--glow-strength`.
- **Type:** `--mono` (Cascadia Mono and fallbacks) and `--display` (OCR A and fallbacks). The size scale is `--fs-*`.
- **Breakpoints:** 1100 px and 760 px.
- **Motion:** `prefers-reduced-motion` is already handled.

**UI surfaces** a redesign has to cover:
- titlebar: note-list toggle, wordmark, search, Write/Split/Read, theme, CRT, Sound, Commands;
- sidebar: New note, filter row, note list, tags;
- find/replace bar;
- secret-scanner alert bar;
- editor;
- lock screen for encrypted notes;
- preview and backlinks;
- statusbar: save LED, position, words, selection, lock and timer, clock;
- slash popup;
- command palette (`Ctrl+K`);
- modal dialogs (built in `app.js`, e.g. CVSS, subnet, hashes);
- toasts;
- boot screen;
- drop zone;
- desktop only: the linked-file status line, the conflict bar (**Keep mine** / **Use the file's version**) and toast actions.

## Rules every change must keep

These come from the project and from the user's security rules in `~/.claude/rules/security.md`, which also apply to this work.

- **Content-Security-Policy stays as it is** (in `index.html`): `script-src 'self'; style-src 'self'`, with no `unsafe-inline`.
  - No inline `<script>` or `<style>`, no `style="…"` in markup, and no `setAttribute('style', …)`.
  - Setting individual properties through the CSSOM (`el.style.width = …`) is fine; the code already does this.
  - Weakening or adding exceptions to the CSP needs the user's explicit OK first.
- **No HTML strings.**
  - Never use `innerHTML` or `insertAdjacentHTML`; build elements with `NP.dom.h`.
  - Its attribute allow-list (`SAFE_ATTR` in `dom.js`) is a security control: widen it only if the user agrees.
- **Offline, no dependencies.**
  - No CDN, no web fonts from the network, no npm packages, no build step: the page must work when opened by double-clicking `index.html`.
  - Bundling a font file under the repo (allowed by `font-src 'self'`) is still a new dependency and needs the user's OK, including its licence.
- **Accessibility must not regress.**
  - Everything must be reachable by keyboard, with a visible focus ring (`--cool`).
  - Keep the existing ARIA roles and labels, and respect `prefers-reduced-motion`.
  - Check contrast in all three themes, with the CRT effect on and off.
- **Copy:**
  - Sentence case, plain verbs, no apologies.
  - Error messages say what happened and what to do.
  - Existing user-facing strings are matched by tests in some places (`tests/` and `desktop/CyberPad.Desktop.Tests/`). Grep for a string before changing it.
- **Desktop app.**
  - The desktop build copies `index.html`, `css/` and `js/` into `wwwroot`, so UI changes reach it automatically.
  - Desktop-only UI is behind `platform.isDesktop` and cannot be seen in a browser.
  - **Do not launch `CyberPad.exe`:** the user's real data lives in `%LOCALAPPDATA%\CyberPad` and the user runs desktop GUI checks themself. Ask them to.

## How to see and test it

- **Browser preview:** run the command below and open http://localhost:8787. Use your own browser pane for screenshots across themes and widths.

  ```powershell
  python -m http.server 8787 --bind 127.0.0.1
  ```

- **Tests:**
  - `npm test` (Node built-in runner, 141 tests);
  - `node --check js/app.js`;
  - `dotnet test desktop/CyberPad.sln` (316 tests). The .NET test run rewrites `desktop/**/packages.lock.json`; revert that with `git checkout -- "desktop/**/packages.lock.json"`.
- **Manual checks:** README, "Manual checks for the desktop app". Add a line there for any desktop-visible UI change.

## Git

- **Branches:** the finished work is on `feature/desktop-app` (not yet merged to `main`). Do the UX work on its own branch, `feature/ux-ui`, created from `feature/desktop-app`.
- **When to commit:** only when the user asks or the approved plan says to.
- **Public repo:** the user plans to publish this repository on GitHub once the UX work is done. Keep personal data, secrets and machine-specific paths out of commits.
