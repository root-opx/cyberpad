# Start-up theme, line numbers and script mode: design and build steps

Date: 2026-11-25. Branch: `feature/ux-ui`. Status: the user asked for all three on 2026-11-25 and chose: script mode per note, line numbers as a switch that is on in script notes, the preview showing a script as one code block, and long lines scrolling sideways in script notes. Details marked *(my call)* were not discussed.

Read `docs/ux-handoff.md` first. Its rules apply: strict CSP, no `innerHTML`, no dependencies, accessibility, never launch `CyberPad.exe`.

## Why

1. **Dark flash at start-up.** With the Light theme the window, its title bar and the page all start in Neon colours and switch a moment later.
2. **Line numbers.** The user wants numbered lines in the editor, like an IDE.
3. **Script mode.** The user keeps scripts in notes and wants to pick a programming language and have indentation behave the way that language expects.

## Goals

- The app starts in the colours of the theme that was last on screen: window background, title bar and page.
- The editor can show a line-number gutter.
- A note can be marked as a script in a chosen language. In such a note Tab, Shift+Tab, Enter and Backspace indent the way that language does, long lines scroll sideways, and the preview shows the code as one block.

## Non-goals

- Syntax colouring, code completion, bracket matching, linting or running code.
- Saving a script note to a file with the language's extension. Linked files stay `.txt`, `.md` and `.cpnote`.
- Detecting the language automatically.
- Changing how Markdown notes edit, apart from optional line numbers.

## Anti-goals

- The CSP changes, an `innerHTML` appears, a dependency is added, or the host bridge changes.
- Text of an encrypted note stays anywhere in the page (for example in a hidden measuring element) after the note locks.
- A Markdown note behaves differently because script mode exists: its Tab, Enter, arrows, lists, slash inserts and calculator are untouched.
- Typing in a 20,000-line note becomes sluggish because of the gutter.
- Data saved before this change fails to load.

## Design

### 1. Start-up theme

**Page.** A small script, `js/early-theme.js`, is loaded in `<head>` before the stylesheet paints. It reads one value from `localStorage` (`cyberpad.theme`), accepts only the six setting names, resolves `system` with `(prefers-color-scheme: dark)`, and sets `data-theme` on `<html>`. Anything else, or storage being unavailable, leaves the default. The app writes that value whenever the theme setting is applied. The value is a theme name and nothing else.

**Host.** The host remembers the last theme it applied in a new file in the data folder, `appearance.json` (`{"theme":"light"}`), written only when the theme changes. At start-up it reads it, accepts only the five real theme names through the existing `HostThemes.TryParse`, and otherwise uses Neon. The remembered theme sets the window background, the WebView2 default background and the title bar before the page loads. The host's colour table gains the page background (`--void`) of each theme:

| Theme | Background |
|---|---|
| neon | `#140f2e` |
| amber | `#1a1106` |
| terminal | `#010801` |
| light | `#fafaf7` |
| dark | `#16181d` |

No bridge change: the file is written from the existing `theme` message. A missing, unreadable or invalid file is ignored without a message; a write failure is logged by type name only and never shown.

### 2. Line numbers

- New setting `lineNumbers` with three values: `script` (default: numbers in script notes only), `all` (every note), `off`. One palette command in the View section cycles it and names the current state, for example `Line numbers: script notes only (change)`. *(Three states are my call, so that numbers can also be turned off in script notes.)*
- The gutter sits at the left edge of the editor pane. Numbers are right-aligned in `--dim`; the number of the line holding the caret is `--ink`. The gutter is hidden from assistive technology and cannot be focused or selected. The status bar keeps showing the line and column.
- When the gutter shows, the editor's text starts right after it instead of being centred. *(my call)*
- **Script notes** never wrap, so each line is one row and the gutter follows the editor's vertical scroll.
- **Markdown notes** wrap. A wrapped line gets one number, at its first row. Finding where each line starts needs measuring; it is done off screen, updated at most a few times per second while typing, and skipped (gutter hidden, with the palette command saying so) for a note of more than 3,000 lines. *(The limit is my call.)*
- Only the numbers that can be seen are drawn, so a very long script note stays fast.
- Whatever is used to measure wrapped lines holds note text. It is emptied when the note locks, when another note opens and when the gutter is turned off.

### 3. Script mode

**Model.** A note gains `lang`: `''` for an ordinary Markdown note, or one of the language ids below. It is stored in plain text, also for encrypted notes, like the folder name. Backups and duplicates carry it. Anything not on the list loads as `''`.

**Languages** *(the list and the rules are my call)*:

| id | Name | One indent | Enter adds an indent after a line ending in | A closer typed first on a line removes an indent |
|---|---|---|---|---|
| `bash` | Bash | 2 spaces | `then` `do` `else` `{` `(` | `}` `)` |
| `c` | C | 4 spaces | `{` `(` `[` | `}` `)` `]` |
| `cpp` | C++ | 4 spaces | `{` `(` `[` | `}` `)` `]` |
| `csharp` | C# | 4 spaces | `{` `(` `[` | `}` `)` `]` |
| `css` | CSS | 2 spaces | `{` | `}` |
| `go` | Go | 1 tab | `{` `(` `[` | `}` `)` `]` |
| `html` | HTML | 2 spaces | (nothing) | (nothing) |
| `java` | Java | 4 spaces | `{` `(` `[` | `}` `)` `]` |
| `javascript` | JavaScript | 2 spaces | `{` `(` `[` | `}` `)` `]` |
| `json` | JSON | 2 spaces | `{` `[` | `}` `]` |
| `powershell` | PowerShell | 4 spaces | `{` `(` | `}` `)` |
| `python` | Python | 4 spaces | `:` | (nothing) |
| `rust` | Rust | 4 spaces | `{` `(` `[` | `}` `)` `]` |
| `sql` | SQL | 4 spaces | `(` | `)` |
| `typescript` | TypeScript | 2 spaces | `{` `(` `[` | `}` `)` `]` |
| `yaml` | YAML | 2 spaces | `:` | (nothing) |

"Ending in" ignores spaces at the end of the line. Word endings (`then`, `do`, `else`) must be whole words.

**Editing in a script note.**

| Key | What happens |
|---|---|
| Enter | The new line starts with the current line's leading whitespace. One more indent is added when the text before the caret ends in one of the language's openers. If the character right after the caret is the matching closer (`}` after `{`, `)` after `(`, `]` after `[`), the closer moves to its own line at the original indent and the caret sits on the indented line between them. |
| Tab | No selection, or a selection inside one line: inserts spaces up to the next indent stop (or one tab for Go). A selection across lines: indents every selected line by one indent. |
| Shift+Tab | Removes up to one indent from the start of the current line or of every selected line. |
| Backspace | When the caret has only spaces to its left on the line, deletes back to the previous indent stop. Otherwise as usual. |
| A closer (`}` `)` `]`) typed as the first character on a line that holds only whitespace | The line loses one indent, then the closer is inserted. |

Each of these is one undo step. `Esc` then `Tab` still moves focus out of the editor.

**What is switched off in a script note:** arrow replacement, list continuation, Ctrl+Enter task toggling, slash quick inserts, the inline calculator, and pasting a URL over a selection to make a link. Its text is not searched for `#tags` or `[[wiki links]]`, so it has no tags and no backlinks. The secret scanner stays on.

**Display.**

- The editor does not wrap; it scrolls sideways. The tab width shown is 4.
- The note title is its first non-empty line, as written.
- The preview shows the whole note as one code block, with the language name and a Copy button, and no Markdown rendering. **Export note as PDF** prints that block. **Export note as Markdown** writes the code inside a fenced block marked with the language id.
- The sidebar marks a script note, and screen readers hear `script, <language>`. The status bar shows the language name; activating it opens the language dialog.

**Commands** (palette, Note section):

- `Script mode: choose a language…` opens a dialog listing `Markdown note (no script mode)` and the languages; the current choice is marked. Choosing one applies it at once.
- `Back to a Markdown note` (only for a script note).

Switching modes never changes the note's text.

### Data

- `store.LANGS`: the 16 ids in the order above. `note.lang` is validated against it.
- `store` settings: `lineNumbers`, one of `script`, `all`, `off`; default `script`.
- A new pure module `js/core/codeedit.js` holds the language table and the editing rules, with Node tests. Its ids must equal `store.LANGS` (a test checks this).

## Build steps

**Step 1: start-up theme.** Files: `js/early-theme.js` (new), `index.html` (one `<script src>` in `<head>`, before the stylesheet link; the CSP line untouched), `js/app.js` (write the `localStorage` value where the theme is applied; storage errors are caught and ignored with a comment), host: `Bridge/HostTheme.cs` (background colours), a small `AppearanceStore` (read and write `appearance.json`, atomic write, validated read), `MainForm.cs` (use it for the window background, the WebView2 default background and the first title-bar colour; save on theme change), tests for the store (round trip; missing file; garbage; a valid JSON with `"theme":"system"`, `"Light"`, a number, a 1 MB string: all give Neon; a file larger than 4 KB is not read) and for the new colours as COLORREF-style expectations.

**Step 2: data and editing rules (pure).** Files: `js/core/store.js`, `js/core/codeedit.js` (new), `tests/store.test.js`, `tests/codeedit.test.js` (new). Do not touch `index.html` or `js/app.js`.

`codeedit` exports:
- `LANGUAGES`: frozen array of `{ id, name, unit, openers, closers }` in the table's order; `unit` is `'  '`, `'    '` or `'\t'`.
- `language(id)`: the entry, or `null`.
- `enter(text, start, end, id)`, `tab(text, start, end, id, shift)`, `backspace(text, start, end, id)`, `closer(text, start, end, id, typed)`: each returns `null` (let the browser do its default) or `{ start, end, insert, selStart, selEnd }`: replace `[start, end)` of `text` with `insert`, then select `[selStart, selEnd)` in the result. Each returns `null` for an unknown id or a bad argument, never throws, and looks only at the lines it needs (no scan of the whole text beyond finding line boundaries).

Tests cover every row of the editing table for at least Python, JavaScript, Go and Bash, including: Enter in the middle of a line; Enter between `{` and `}`; Enter after `if x:` with trailing spaces; `done`/`redo` not counting as `do`; Tab at columns 0, 1, 3 and 4 with a 4-space unit; Tab on a three-line selection and Shift+Tab undoing it exactly; Shift+Tab on a line with fewer spaces than one indent, with a tab, and with none; Backspace at an indent stop, between stops, and after text; a closer on an empty indented line, on a line with text, and for a language without closers; a selection spanning the whole text; empty text; positions out of range.

Store tests: `lang` through validate, serialize, backup and import; an unknown, mixed-case, numeric or `__proto__` value loads as `''`; data from before this change loads with `lang: ''` and `lineNumbers: 'script'`; `lineNumbers` accepts the three values and falls back to `script`.

**Step 3: script mode in the app.** Files: `index.html` (the `codeedit.js` script tag after `texttools.js`; a status-bar element for the language), `js/app.js`, `css/style.css`. Everything in "3. Script mode" above. The checks: each editing row typed with real keys in a Python and a JavaScript note; a Markdown note typed the same way behaves exactly as before; the helpers listed as switched off are off in a script note and on in a Markdown note; a script note containing `# heading`, `#tag` and `[[link]]` shows no tag in the sidebar and renders as one code block; switching a note to script and back leaves its text byte-identical; an encrypted script note locks and unlocks normally.

**Step 4: line-number gutter.** Files: `index.html` (gutter element if static), `js/app.js`, `css/style.css`. Everything in "2. Line numbers". The checks: numbers line up with rows in a script note at the top, middle and end of a 5,000-line note and while scrolling; in a wrapped Markdown note with `all`, a line that wraps to three rows gets one number and the next number is three rows down, also after the pane is resized or the layout switches between Write and Split; the caret's line is highlighted; the measuring element is empty after an encrypted note locks; typing in a 20,000-line script note shows no visible lag; the gutter never appears in print.

**Step 5: documents.** README (start-up colours and the new `appearance.json` row in the data-folder table; line numbers; script mode with the language table and what is switched off; that `lang` is stored in plain text; manual checks: `With Light chosen, close and reopen the app: the window and title bar are light from the first moment.` and `In a Python script note, Tab, Shift+Tab and Enter after a colon indent by four spaces.`), `docs/ux-handoff.md` (the new module and surfaces).

**Verification.** `node --check js/app.js`; `npm test`; `dotnet test desktop/CyberPad.sln` then `git checkout -- "desktop/**/packages.lock.json"`; the CSP line unchanged; no `innerHTML`, `insertAdjacentHTML` or inline style added; `js/ui/dom.js` untouched; no new message type in the bridge.
