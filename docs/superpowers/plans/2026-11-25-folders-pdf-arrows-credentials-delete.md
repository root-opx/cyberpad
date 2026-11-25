# Folders, PDF Export, Arrows, Credentials Note and Easier Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add note folders, PDF export through the print dialog, as-you-type arrows, an encrypted credentials note, and delete-from-sidebar with undo.

**Architecture:** The data model and the text rules are pure functions in `js/core/store.js` and `js/core/texttools.js` with Node tests. `js/app.js` wires them into the sidebar, editor and palette. PDF export is a print stylesheet plus `window.print()`. No host or bridge change.

**Tech Stack:** Plain JS (no build, no dependencies), CSS, Node built-in test runner.

**Spec:** `docs/superpowers/specs/2026-11-25-folders-pdf-arrows-credentials-delete-design.md`. Read it and `docs/ux-handoff.md` before any task.

## Global Constraints

- CSP in `index.html` does not change. No inline `<script>`/`<style>`, no `style="…"` in markup, no `setAttribute('style', …)`.
- No `innerHTML` or `insertAdjacentHTML`. Build elements with `NP.dom.h`. Do not widen `SAFE_ATTR` in `js/ui/dom.js`; if an attribute you need is not allowed, stop and report it.
- No new dependency. No change under `desktop/` and no host bridge change.
- `SCHEMA` stays 1. New stored fields are optional on read.
- Validate stored and imported values: type, then range, then allow-list. Drop bad values; do not repair them.
- On screen, only the existing colour tokens. No new animation or transition.
- Everything is reachable by keyboard with a visible `--cool` focus ring; state is exposed to assistive technology.
- Copy: sentence case, plain verbs. Grep `tests/` and `desktop/CyberPad.Desktop.Tests/` before changing an existing string.
- **Never launch `CyberPad.exe`.**
- Baseline: `npm test` passes 151 tests.
- Commit messages end with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`. No personal data or machine paths in commits. Never commit anything under `.superpowers/`.
- Browser preview: start `cyberpad-web` with the preview tool (never from a shell) and use http://127.0.0.1:8787; after editing a file, reload that file's URL and then the page, because the pane caches assets.

## Review Focus

1. **Old data.** A `notes.json` or backup written before this change (no `folder`, no new settings) loads with every note intact and no folder. (Task 1 tests.)
2. **Hostile folder values in an import**: `__proto__`, a 5,000-character name, a number, a name with `/` or a newline. Expected: the note loads with no folder. (Task 1 tests.)
3. **Arrow next to existing text and at the edges**: typing `>` at position 0 or 1; `-` then `>` typed with a selection replaced; inside the second of two fenced blocks. Expected: no exception, code untouched. (Task 1 tests; Task 3 browser check.)
4. **Credentials flow cancelled or failed** (dialog closed, weak passphrase rejected). Expected: no new note in the list and nothing written to storage. (Task 3 browser check, reading `localStorage`.)
5. **Undo after the state moved on**: deleted note was the only note; another note was created or deleted during the 10 seconds; the deleted note was encrypted or linked. Expected: no duplicate ids, no blank leftover note, the right note comes back. (Task 2 browser check.)
6. **Print with a long code line and a wide table.** Expected: nothing is cut off at the page edge. (Task 4 check.)

---

### Task 1: Data model and text rules (pure logic)

**Files:**
- Modify: `js/core/store.js`, `js/core/texttools.js`
- Test: `tests/store.test.js`, `tests/texttools.test.js`

**Interfaces — produces:**

On the store module:
- `LIMITS.folderName = 40`, `LIMITS.folders = 100`.
- `cleanFolder(value): string`. Returns `''` unless `value` is a string. Trims it and collapses each run of whitespace to one space. Returns `''` if the result is empty, longer than 40 characters, or contains `/`, `\`, or a character in U+0000–U+001F or U+007F (checked before collapsing). Otherwise returns the result.
- Notes carry `folder` (string). `createNote` gives `''`. `validateNote` sets `folder: cleanFolder(n.folder)`. `validateNotes` keeps at most 100 distinct folder names in list order; a note with a further name gets `''`. `serialize` and `makeBackup` write `folder`; `parseBackup` keeps it.
- `folderList(notes): { name: string, count: number }[]`, sorted by name with `localeCompare(…, 'en', { sensitivity: 'base' })`, ties by plain string order; notes with `''` are not listed.
- Settings: `arrows` (boolean, default `true`); `collapsedFolders` (default `[]`): on validate, an array is filtered to unique strings for which `cleanFolder(x) === x`, at most 100; anything else becomes `[]`.

On the texttools module:
- `inCodeAt(text: string, caret: number): boolean`. True when an odd number of fence lines precede the caret's line (a fence line matches `/^ {0,3}(```|~~~)/`), or an odd number of backticks lie between the start of the caret's line and the caret.
- `arrowReplacement(text: string, caret: number, typed: string): { start: number, end: number, insert: string } | null`. `text` is the editor value after `typed` was inserted and `caret` is just after it. Returns the range to replace, or `null`. Rules, with `a = text[caret-2]`, `b = text[caret-3]`:
  - `typed === '>'`, `a === '-'`, `b` not `-` or `<` → replace `[caret-2, caret)` with `→`.
  - `typed === '>'`, `a === '←'` → replace `[caret-2, caret)` with `↔`.
  - `typed === '>'`, `a === '='`, `b` not one of `= < > !` → `⇒`.
  - `typed === '-'`, `a === '<'`, `b !== '<'` → `←`.
  - Any other case, `caret < 2`, a non-string or out-of-range argument, or `inCodeAt(text, caret)` → `null`.
- `credentialsTemplate(now: Date): string` returning exactly (with `ymd(now)` for the date, ending in one newline):

  ```
  # Credentials

  | System | Username | Password | URL | Notes |
  | --- | --- | --- | --- | --- |
  |  |  |  |  |  |

  Last reviewed: 2026-11-25
  ```

- [ ] **Step 1: Write the failing tests.** Use each file's existing naming for the modules and helpers.

`tests/store.test.js`:

```js
test('cleanFolder accepts a tidy name and rejects everything else', () => {
  assert.equal(store.cleanFolder('  Client   work '), 'Client work');
  assert.equal(store.cleanFolder('a'.repeat(40)), 'a'.repeat(40));
  for (const bad of ['', '   ', 'a'.repeat(41), 'a/b', 'a\\b', 'a\nb', 'a\u0000b', 'a\u007fb', 7, null, undefined, {}, ['x'], true]) {
    assert.equal(store.cleanFolder(bad), '');
  }
  assert.equal(store.cleanFolder('__proto__'), '__proto__');
});

test('notes keep a valid folder through validate, serialize and backup', () => {
  const n = { ...store.createNote('hi', 1000, 'a'.repeat(32)), folder: 'Clients' };
  assert.equal(store.createNote('x').folder, '');
  const state = store.validateState(JSON.parse(store.serialize({ notes: [n], settings: store.DEFAULT_SETTINGS, activeId: n.id })));
  assert.equal(state.notes[0].folder, 'Clients');
  assert.equal(store.parseBackup(store.makeBackup([n]))[0].folder, 'Clients');
});

test('data written before folders existed loads with no folder', () => {
  const old = { v: 1, activeId: null, settings: { theme: 'amber' }, notes: [{ id: 'b'.repeat(32), body: 'old', pinned: true, created: 1, updated: 2, history: [] }] };
  const state = store.validateState(old);
  assert.equal(state.notes.length, 1);
  assert.equal(state.notes[0].folder, '');
  assert.equal(state.notes[0].pinned, true);
  assert.equal(state.settings.arrows, true);
  assert.deepEqual(state.settings.collapsedFolders, []);
});

test('bad folder values are dropped, the note is kept', () => {
  const mk = (i, folder) => ({ id: String(i).padStart(32, '0'), body: 'x', created: 1, updated: 1, folder });
  const notes = store.validateNotes([mk(1, 'a/b'), mk(2, 5), mk(3, 'x'.repeat(5000)), mk(4, 'line\nbreak'), mk(5, 'Fine')], 10);
  assert.deepEqual(notes.map((n) => n.folder), ['', '', '', '', 'Fine']);
});

test('at most 100 distinct folders survive validation', () => {
  const list = Array.from({ length: 120 }, (_, i) => ({ id: String(i).padStart(32, '0'), body: 'x', created: 1, updated: 1, folder: `F${i}` }));
  const notes = store.validateNotes(list, 10);
  assert.equal(notes.length, 120);
  assert.equal(new Set(notes.map((n) => n.folder).filter(Boolean)).size, 100);
  assert.equal(notes[100].folder, '');
});

test('folderList counts and sorts, ignoring case', () => {
  const f = (folder) => ({ ...store.createNote('x'), folder });
  assert.deepEqual(store.folderList([f('beta'), f('Alpha'), f(''), f('beta'), f('alpha')]),
    [{ name: 'Alpha', count: 1 }, { name: 'alpha', count: 1 }, { name: 'beta', count: 2 }]);
  assert.deepEqual(store.folderList([]), []);
});

test('collapsedFolders and arrows settings are validated', () => {
  const s = store.validateSettings({ arrows: false, collapsedFolders: ['A', 'A', 'b/c', 9, ' x', 'B'] });
  assert.equal(s.arrows, false);
  assert.deepEqual(s.collapsedFolders, ['A', 'B']);
  assert.deepEqual(store.validateSettings({ arrows: 'no', collapsedFolders: 'A' }).collapsedFolders, []);
  assert.equal(store.validateSettings({ arrows: 'no' }).arrows, true);
});
```

Adjust how a state is built or read to the file's existing helpers if `validateState`'s shape differs; keep every assertion.

`tests/texttools.test.js`:

```js
const type = (before, ch, after = '') => T.arrowReplacement(before + ch + after, before.length + 1, ch);

test('arrowReplacement turns typed ASCII arrows into real ones', () => {
  assert.deepEqual(type('a -', '>'), { start: 2, end: 4, insert: '→' });
  assert.deepEqual(type('-', '>'), { start: 0, end: 2, insert: '→' });
  assert.deepEqual(type('x <', '-'), { start: 2, end: 4, insert: '←' });
  assert.deepEqual(type('a =', '>'), { start: 2, end: 4, insert: '⇒' });
  assert.deepEqual(type('a ←', '>'), { start: 2, end: 4, insert: '↔' });
  assert.deepEqual(type('a -', '>', ' b'), { start: 2, end: 4, insert: '→' });
});

test('arrowReplacement leaves look-alikes alone', () => {
  for (const [before, ch] of [['--', '>'], ['<!--', '>'], ['<-', '>'], ['cat <<', '-'], ['a ==', '>'], ['a <=', '>'], ['a >=', '>'], ['a !=', '>'], ['', '>'], ['a', '>'], ['a -', 'x'], ['a -', '']]) {
    assert.equal(type(before, ch), null, `${before}${ch}`);
  }
  assert.equal(T.arrowReplacement('->', 5, '>'), null);
  assert.equal(T.arrowReplacement('->', -1, '>'), null);
  assert.equal(T.arrowReplacement(null, 2, '>'), null);
});

test('arrowReplacement never fires in code', () => {
  assert.equal(type('```\nptr-', '>'), null);
  assert.equal(type('~~~sh\na -', '>'), null);
  assert.equal(type('use `a-', '>'), null);
  assert.deepEqual(type('```\ncode\n```\nprose -', '>'), { start: 19, end: 21, insert: '→' });
  assert.equal(type('```\na\n```\nb\n```\nc -', '>'), null);
  assert.deepEqual(type('`done` then -', '>'), { start: 12, end: 14, insert: '→' });
  assert.equal(T.inCodeAt('   ```\nx', 8), true);
  assert.equal(T.inCodeAt('    ```\nx', 9), false);
});

test('credentialsTemplate is the agreed table with today as the review date', () => {
  const out = T.credentialsTemplate(new Date(2026, 10, 25));
  assert.equal(out, '# Credentials\n\n| System | Username | Password | URL | Notes |\n| --- | --- | --- | --- | --- |\n|  |  |  |  |  |\n\nLast reviewed: 2026-11-25\n');
});
```

- [ ] **Step 2: Run to verify they fail.** `npm test` → the 11 new tests fail on missing functions or fields.
- [ ] **Step 3: Implement** the store and texttools changes per the Interfaces block, and export the new functions. Use `Set`/`Map` for folder bookkeeping.
- [ ] **Step 4: Run to verify.** `npm test` → 162 pass, 0 fail.
- [ ] **Step 5: Commit.**

```bash
git add docs/superpowers js/core/store.js js/core/texttools.js tests/store.test.js tests/texttools.test.js
git commit -m "feat: folder field, arrow rules and credentials template"
```

---

### Task 2: Sidebar folders, delete button and undo

**Files:** Modify `js/app.js`, `css/style.css`, `index.html` (only if a new static element is needed).

**Interfaces — consumes:** `store.cleanFolder`, `store.folderList`, `store.LIMITS.folderName`, `note.folder`, `S.settings.collapsedFolders` from Task 1.

**Build** (spec sections 1 and 5):

- **List rendering** (`renderList`). No search text and no tag filter: for each entry of `store.folderList(S.notes)` a header `<li>` holding `<button type="button" class="folder-head" aria-expanded data-folder>` (name, then a `.count`), followed by that folder's note rows unless it is in `collapsedFolders`; then the notes with `folder === ''`. Order inside a group is `sortedNotes()` order. With a search or tag filter: the flat list as today, each row showing its folder name in the meta line. Keep the 500-row cap.
- **Note rows.** The `<li>` now holds the existing `button.note-item` plus a sibling `button.note-del` (`type="button"`, `aria-label="Delete <title>"`, text `×`). Rows inside a folder are indented. `.note-del` is hidden until its `li` is hovered or has focus within, and always shown under `@media (hover: none)`; at 760 px and below it is at least 2.75rem square.
- **Folder state.** Toggling a header updates `S.settings.collapsedFolders` and saves settings. Prune names that no longer exist when saving. Opening a note whose folder is collapsed expands it.
- **New notes.** `newNote` (and Task 3's credentials note) take the folder of the note that was active. Daily log, import and open-file do not. Duplicate keeps the folder.
- **Commands**, group `'Note'`: `Move to folder…`, `Remove from folder` (when `note.folder`), `Rename folder…` (when `note.folder`).
  - Move dialog: built like the app's other modals; a text input (`maxlength` 40, labelled `Folder name`), the existing folders as buttons that fill the input, primary button `Move`. Empty or invalid input shows `Folder names are 1 to 40 characters, without / or \.` and keeps the dialog open. Refuse a new name when 100 folders already exist: `You already have 100 folders. Move the note into one of them.`
  - Rename dialog: same input and validation, button `Rename`. If the new name is another existing folder, confirm first: title `Merge into "<name>"?`, message `Every note in "<old>" moves into "<name>".`, button `Merge folders`.
  - Each success ends with a toast: `Moved to <name>.`, `Removed from <name>.`, `Renamed to <name>.`
- **Drag and drop.** Note rows are draggable. Drop targets: folder headers, and the list area below the folders (no folder). Keep the dragged note id in a module variable, not in `dataTransfer` text; ignore a drop when that variable is empty. The existing file-import drop zone must only react when `dataTransfer.types` includes `Files`.
- **Delete.** Generalise `deleteNote(note = active())`. `.note-del` click and the Delete key on a focused `.note-item` call it for that row's note. Confirmation message becomes `You can undo this for 10 seconds. After that the note is gone, so export a backup first if you might need it later.` (plus ` The file stays where it is.` for a linked note).
- **Undo.** After a delete, `toast('Note deleted.', 'info', [Undo])` using the toast's existing action support, kept for 10 seconds. Keep the removed note object and its list position in one `S.pendingDelete` slot. Undo: put the note back (if a note with that id exists, do nothing), remove the blank note that was auto-created when the last note was deleted if it is still empty and untouched, make the restored note active, persist, re-render. An encrypted note returns locked. A new delete, or the 10 seconds passing, finalises the pending one; only then call `forgetHostLink` for a linked note. Finalise on `pagehide`/flush as well.

- [ ] **Step 1: Implement** the list rendering, folder state and CSS.
- [ ] **Step 2: Implement** the three commands and their dialogs, then drag and drop.
- [ ] **Step 3: Implement** the delete button, Delete key and undo.
- [ ] **Step 4:** `node --check js/app.js`; `npm test` → 162 pass.
- [ ] **Step 5: Browser checks** at 1280 px in Neon, then spot-check Amber, Terminal green and 375 px. Each must hold:

| Do | Expect |
|---|---|
| Create three notes; move two into `Clients` with the palette command | A `Clients` header with count 2 above the loose note; toast shown |
| Enter/Space on the header; reload the page | It closes and opens; the closed state survives the reload |
| Open a note in a closed folder from the palette | The folder opens and the note is current |
| Type `a/b` and then nothing in the Move dialog | The error text shows; the dialog stays open |
| Rename `Clients` to an existing folder's name | Merge confirmation; afterwards one folder with all notes |
| Remove the last note from a folder | The folder header disappears |
| Type in search | Flat list; rows show their folder name |
| Drag a loose note onto a header, and a foldered note onto the loose area | The note moves; the import drop zone never appears |
| Tab through the sidebar | Headers, notes and delete buttons are all reachable with a visible focus ring |
| Delete key on a focused row; click `×` on another row | Confirmation with the new wording each time |
| Delete, then Undo within 10 s | The note is back with its folder and pin, and is current |
| Delete the only note, then Undo | Exactly one note remains, the restored one *(Review Focus 5)* |
| Delete A, create a note, delete B, Undo | B returns; A stays gone; no duplicate ids (`new Set(ids).size === ids.length` in `localStorage`) |
| Delete an unlocked encrypted note, Undo | It returns locked |
| New note while a foldered note is open | The new note is in that folder |

No console errors. Remove the scratch notes afterwards.

- [ ] **Step 6: Commit.**

```bash
git add js/app.js css/style.css index.html
git commit -m "feat: note folders, delete from the sidebar and undo"
```

---

### Task 3: Arrows as you type and the encrypted credentials note

**Files:** Modify `js/app.js`, `js/core/texttools.js` (slash list only), `tests/texttools.test.js` (if the slash list is tested there).

**Interfaces — consumes:** `T.arrowReplacement`, `T.credentialsTemplate`, `S.settings.arrows` from Task 1; the folder rule for new notes from Task 2.

**Build** (spec sections 3 and 4):

- **Arrows.** In the editor's `input` handler: when `S.settings.arrows` is on, the event's `inputType` is `insertText`, `data` is one character, and the selection is collapsed, call `T.arrowReplacement(value, selectionStart, data)`. On a result, replace that range with the app's existing undo-preserving replace helper (the one find-and-replace and the transforms use), leave the caret after the arrow, and remember `{ pos, original }` (`original` is the replaced text). Run this before the handler's other work so stats, autosave and the secret scan see the final text once.
- **Backspace.** On `keydown` Backspace with a collapsed selection at `pos + 1` and the remembered arrow still at `pos`: prevent the default and replace the arrow with `original`. Forget the memory on any other key, input, click or note switch.
- **Setting.** Command in group `'View'`: `Turn off arrow replacement` / `Turn on arrow replacement`, toggling `S.settings.arrows` and saving. Toast: `Arrow replacement off.` / `Arrow replacement on.`
- **Credentials note.** A function `newCredentialsNote()`:
  1. Builds the body with `T.credentialsTemplate(new Date())`.
  2. Asks for a passphrase with the existing encrypt dialog (same strength rules and wording as **Encrypt note**; title `New encrypted credentials note`).
  3. Seals the body with the vault. Only then creates the note (cipher set, plaintext body empty in the stored record), gives it the active note's folder, adds it to `S.notes`, makes it active and unlocked, persists, renders.
  4. On cancel or failure, nothing is added and nothing is persisted.
  Read `encryptActive()` and its helpers first and reuse them; do not copy the crypto calls. If the dialog cannot be reused without first adding a plaintext note to `S.notes`, stop and report NEEDS_CONTEXT.
- **Entry points.** Command in group `'Templates'`: `New encrypted credentials note`, hint `/credentials`. Slash entry `credentials`, description `New encrypted credentials note`: in a plain note it removes the typed `/credentials` and calls `newCredentialsNote()`; in an unlocked encrypted note it inserts the template at the cursor like other block templates.

- [ ] **Step 1: Implement** arrows, Backspace and the setting.
- [ ] **Step 2: Implement** the credentials note and its two entry points.
- [ ] **Step 3:** `node --check js/app.js`; `npm test` → all pass (162, plus any slash-list test you add).
- [ ] **Step 4: Browser checks.**

| Do | Expect |
|---|---|
| Type `a -> b`, `x <- y`, `p => q`, `m <-> n` | `→`, `←`, `⇒`, `↔` appear |
| Type `-->`, `a == b`, `cat <<-EOF` | Unchanged |
| Inside a fenced block and inside `` `code` ``, type `ptr->x` | Unchanged *(Review Focus 3)* |
| Type `->` then Backspace | `->` is back; a second Backspace deletes `>` |
| Type `->` then Ctrl+Z | `->` is back |
| Paste `a -> b` | Unchanged |
| Turn the setting off, type `->`, reload | Unchanged; the setting survives |
| Run **New encrypted credentials note**, cancel the dialog | No new note; `localStorage` unchanged *(Review Focus 4)* |
| Run it again with a strong passphrase | A new unlocked encrypted note with the table; in `localStorage` its record has a `cipher` and an empty `body`, and the text `Username` appears nowhere in storage |
| Type `/credentials` in a plain note, complete the dialog | The typed text is gone from the plain note; the new note is as above |
| Type `/credentials` in the unlocked encrypted note | The table is inserted at the cursor |
| With a foldered note open, create a credentials note | It is in that folder |

No console errors. Delete the scratch notes afterwards.

- [ ] **Step 5: Commit.**

```bash
git add js/app.js js/core/texttools.js tests/texttools.test.js
git commit -m "feat: arrows as you type and encrypted credentials note"
```

---

### Task 4: Export note as PDF

**Files:** Modify `js/app.js`, `css/style.css`.

**Build** (spec section 2):

- Command in group `'File'`: `Export note as PDF`, available when the active note is editable (open and unlocked).
- `exportPdf()`: for an encrypted note, first `confirmDialog('Export this encrypted note as PDF?', 'The PDF is not encrypted. Anyone who can open it can read the note.', 'Export as PDF')`. Then make sure the preview holds the current note's rendering even in Write layout, set `document.title` to the note title, show `toast('In the print dialog, choose Save as PDF.')`, and call `window.print()`. Restore `document.title` on `afterprint` (and after the call returns, for engines that block).
- `@media print` block at the end of `css/style.css`:
  - Paper tokens on `:root` and every `[data-theme]`: `--void: #fff; --panel: #f4f4f4; --raise: #ececec; --line: #b5b5b5; --ink: #111; --dim: #555; --hot: #a3004f; --cool: #00605c; --warn: #7a5600;`.
  - `html, body, .app, .workspace, .panes, .pane-preview`: `display: block; height: auto; overflow: visible; background: #fff;`.
  - Hidden: `.titlebar, .sidebar, .scrim, .statusbar, .findbar, .alertbar, .pane-editor, .backlinks, .copy-btn, .toasts, .boot, .dropzone, .slash, dialog`. `body.crt::after { display: none; }`. No `text-shadow` anywhere.
  - `.workspace[data-view] .pane-preview { display: block; border: 0; }` so Write layout still prints.
  - `.preview { max-width: none; padding: 0; }`; `.preview pre { white-space: pre-wrap; overflow-wrap: anywhere; overflow: visible; }`; `.table-wrap { overflow: visible; }`; `.preview table { width: 100%; }` with cells allowed to wrap.
  - `.preview a[href^="http"]::after { content: " (" attr(href) ")"; font-size: var(--fs-xs); color: var(--dim); overflow-wrap: anywhere; }`.
  - `h1, h2, h3 { break-after: avoid; }`; `pre, blockquote, tr { break-inside: avoid; }`; `@page { margin: 18mm; }`.

- [ ] **Step 1: Implement** the command, `exportPdf()` and the print stylesheet.
- [ ] **Step 2:** `node --check js/app.js`; `npm test` → all pass.
- [ ] **Step 3: Check the print layout** without opening a real print dialog. In the browser pane run, on a note with headings, a task list, a link, a table, a blockquote and a fenced block containing one 300-character line:

```js
(() => { const m = [...document.styleSheets].flatMap((s) => [...s.cssRules]).filter((r) => r.media && r.media.mediaText === 'print');
  return { printBlocks: m.length, rules: m.reduce((n, r) => n + r.cssRules.length, 0) }; })()
```

Expected: `printBlocks >= 1` and `rules > 10`. Then, if the pane or DevTools offers print-media emulation, use it and confirm by reading computed styles that `.titlebar`, `.sidebar` and `#editor`'s pane are `display: none`, `.preview` text colour is `rgb(17, 17, 17)` on a white background, and the long code line wraps (`pre` `scrollWidth <= clientWidth`) *(Review Focus 6)*. If no emulation is available, say so in the report and verify the rules by reading the stylesheet instead.
- [ ] **Step 4:** In the browser, stub `window.print` (`window.print = () => { window.__printed = document.title; }`) for this check only, run the command on a plain note and on an encrypted note, and confirm: the toast text, `__printed` equals the note title, `document.title` is restored afterwards, the encrypted note asks first and does nothing on Cancel, and in Write layout the preview holds the note's content. Reload to drop the stub.
- [ ] **Step 5: Commit.**

```bash
git add js/app.js css/style.css
git commit -m "feat: export a note as PDF through the print dialog"
```

---

### Task 5: Documentation and final verification

**Files:** Modify `README.md`.

- [ ] **Step 1: Update the README**, in its existing voice:
  - "Organising": folders (move, rename, remove, drag; a new note joins the open note's folder; **folder names are not encrypted, even for encrypted notes**).
  - "Writing": `->`, `<-`, `<->` and `=>` become arrows as you type, never inside code; Backspace or Ctrl+Z puts the characters back; turn it off in the palette under View.
  - "Encryption": **New encrypted credentials note** and `/credentials`; the note is encrypted before it is saved.
  - "Files": **Export note as PDF** opens the print dialog; choose Save as PDF; the PDF of an encrypted note is not encrypted.
  - Deleting: the `×` on a note row or the Delete key; **Undo** for 10 seconds; a linked file is never deleted.
  - Command palette bullet: nothing to change unless a section name changed.
  - "Security notes": folder names are validated (1 to 40 characters, no `/`, `\` or control characters, at most 100 folders) and stored in plain text; the credentials note is sealed before it joins the note list.
  - "Manual checks for the desktop app", new lines:
    - `Export note as PDF opens the print dialog, and Save as PDF gives a readable file with dark text on white.`
    - `Move a note into a folder, close the app and reopen it: the folder and its closed or open state are kept.`
    - `Delete a linked note and undo: the note returns still linked. Delete it again and wait: the file is still on disk.`
- [ ] **Step 2: Run everything.** `node --check js/app.js`; `npm test`; `dotnet test desktop/CyberPad.sln` (expect 354 passed; the linked-file tests have failed intermittently before: re-run once if one fails and report both runs); `git checkout -- "desktop/**/packages.lock.json"`.
- [ ] **Step 3: Rule checks.**
  - `git diff 12729fa -- index.html | grep -n "Content-Security-Policy"` → no output.
  - `git diff 12729fa -- js css index.html | grep -nE "^\+.*(innerHTML|insertAdjacentHTML|setAttribute\('style'|style=\")"` → no output.
  - `git diff 12729fa --stat -- js/ui/dom.js package.json desktop/` → no changes.
- [ ] **Step 4: Final browser pass**, three themes × CRT on and off at 1280 and 375 px: the sidebar with two folders (one closed), a row's delete button focused, the Move dialog, and the palette's Note and File sections (no scrolling at 1280×700). No horizontal overflow at 375 (compare against the emulated width, not `innerWidth`), no console errors. Leave Neon, CRT on, desktop viewport, and no scratch notes.
- [ ] **Step 5: Commit.**

```bash
git add README.md
git commit -m "docs: folders, PDF export, arrows, credentials note, delete and undo"
```
