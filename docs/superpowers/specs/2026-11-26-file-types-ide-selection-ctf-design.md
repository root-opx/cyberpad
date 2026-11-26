# More file types, IDE features, selection toolbar and CTF support: design and build steps

Date: 2026-11-26. Branch: `feature/ide-ctf-filetypes` (from `main`). Status: the user passed on four suggestions from a friend and asked for all of them. The user chose: editor features without running code; a fixed list of common text file types; and for CTF: templates, more decoders, a flag finder and a report built from a folder. Details marked *(my call)* were not discussed.

Read `docs/ux-handoff.md` first. Its rules apply: strict CSP, no `innerHTML`, no dependencies, accessibility, never launch `CyberPad.exe`, and nobody but the user runs the setup file or the uninstaller.

## Why

A friend who tried CyberPad asked for four things:

1. Save in more formats than `.txt` and `.md`, above all for scripts (a Python script should save as `.py`), and make CyberPad feel like an IDE.
2. When text is selected, show what can be done with it (bold, italic, highlight and so on).
3. Help with solving CTF challenges and writing CTF reports.
4. Open the popular file types, as Notepad++ does.

## Goals

- A note can be linked to, opened from and saved as any file type on a fixed list of text formats.
- Opening a file picks the right mode for it: Markdown, a script language, or plain text.
- Script notes get syntax colouring, matching-bracket highlight, comment toggle, duplicate and move line, and go to line.
- Selecting text shows a small toolbar with the formatting that applies.
- CTF: challenge and writeup templates, a decode/encode dialog with many codecs, a "try common decodings" view, a flag finder, and a report built from the notes in a folder.

## Non-goals

- Running or debugging code. CyberPad still never starts a program.
- Code completion, linting, multiple cursors, auto-closing brackets, code folding.
- Opening binary files, or any extension outside the list.
- Registering the new file types with Explorer's "Open with". The installer keeps registering `.md`, `.txt` and `.cpnote` only.
- A user-supplied regular expression for flags.
- The Linux app (paused separately).

## Anti-goals

- The CSP changes, an `innerHTML` appears, or a dependency is added.
- The desktop host accepts an extension outside the fixed list, or the page can make it write a path the user did not choose in a native dialog.
- Text of an encrypted note stays in any hidden layer after the note locks.
- A decoder, the tokenizer or the flag finder can freeze the page on hostile input.
- A Markdown note behaves differently unless the user uses a new feature.
- Encrypted note text ends up in a plain note without the user asking for exactly that.

## Design

### 1. File types

**The list** *(the exact list is my call)*. Lower-case, without the dot. It is the same on the page and in the host, and tests pin both copies to this table.

| Group | Extensions | Opens as |
|---|---|---|
| Notes | `txt` | Markdown note (as today) |
| Notes | `md`, `markdown` | Markdown note |
| Encrypted | `cpnote` | encrypted note (as today) |
| Python | `py`, `pyw` | `python` |
| JavaScript | `js`, `mjs`, `cjs`, `jsx` | `javascript` |
| TypeScript | `ts`, `tsx` | `typescript` |
| Shell | `sh`, `bash`, `zsh` | `bash` |
| PowerShell | `ps1`, `psm1`, `psd1` | `powershell` |
| Batch | `bat`, `cmd` | `batch` |
| C | `c`, `h` | `c` |
| C++ | `cpp`, `cc`, `cxx`, `hpp` | `cpp` |
| C# | `cs` | `csharp` |
| Java | `java` | `java` |
| Go | `go` | `go` |
| Rust | `rs` | `rust` |
| Ruby | `rb` | `ruby` |
| PHP | `php` | `php` |
| Lua | `lua` | `lua` |
| Perl | `pl` | `perl` |
| SQL | `sql` | `sql` |
| HTML | `html`, `htm` | `html` |
| XML | `xml`, `xsd`, `xsl`, `svg` | `xml` |
| CSS | `css`, `scss` | `css` |
| JSON | `json`, `jsonl` | `json` |
| YAML | `yaml`, `yml` | `yaml` |
| TOML and INI | `toml`, `ini`, `cfg`, `conf`, `properties`, `env` | `ini` |
| Plain text | `log`, `csv`, `tsv`, `diff`, `patch`, `nfo`, `lst`, `rules`, `yar`, `yara`, `nse`, `asm`, `s`, `tex`, `rst`, `gitignore` | `plain` |

- Sixty-nine extensions. A file with no extension, or any other extension, is refused as today with an updated message: `CyberPad cannot open that file type.`
- The text rules do not change: UTF-8 or UTF-16 with a BOM, no NUL, at most 4 MB on disk and 1,000,000 characters; CRLF is kept on save.
- `.cpnote` stays the only format for an encrypted note. Encrypting a note linked to any other type removes the link, as today for `.txt` and `.md`.

**Languages.** Script mode gains nine entries: `batch`, `ruby`, `php`, `lua`, `perl`, `xml`, `ini`, `plain` ("Plain text") and nothing else changes for the existing sixteen. `plain` has no block openers and no comment marker; it gives a note that is not Markdown: no tags, no rendering, numbered lines, long lines scroll.

**Opening.** Open file, "Open with", the command line and drag-and-drop accept the listed types. The note's mode is set from the extension. A `.json` file dropped or imported is still tried as a CyberPad backup first; if it does not claim to be one it opens as a JSON note. A file that claims to be a backup but fails validation is still reported as damaged and never imported as text.

**Saving.** "Save as file…" offers the type that fits the note first (its language's first extension, `md` for a Markdown note, `cpnote` for an encrypted one), then "All supported types". The host accepts the chosen path only if its extension is on the list, and it is `cpnote` exactly when the note is encrypted. After saving under a different type the note's mode follows the new extension, unless the user had set the language by hand (then it is kept and the status bar shows it).

**Browser version.** "Export note as Markdown" is joined by **Export note as file**, which downloads the note with its language's extension (`.txt` for plain). The desktop app uses "Save as file…" for this, so its export list does not change.

**Bridge.** No new message type. The `format` field of the existing file messages, today one of three words, becomes one of the listed extensions, checked exactly on both sides. Everything else about those messages is unchanged.

### 2. IDE features (script notes only)

| Feature | How |
|---|---|
| Syntax colouring | Comments, strings, numbers, keywords, and for HTML/XML tags and attribute names, for CSS selectors and properties, for JSON keys, for YAML and INI keys and sections. Colours come from the existing tokens: comments `--dim`, strings `--cool`, keywords `--hot`, numbers and constants `--warn`, the rest `--ink`. No colouring for `plain`. |
| Matching bracket | With the caret next to `( ) [ ] { }`, both brackets get an outline. Brackets inside strings and comments are ignored. The search is limited to 5,000 lines in each direction. |
| Comment or uncomment | `Ctrl+/` toggles the language's line comment on the current line or every selected line. Languages without a line comment (HTML, XML, CSS, JSON, plain) wrap or unwrap the selection in their block comment where they have one, and do nothing otherwise. |
| Duplicate line | `Ctrl+Shift+D` duplicates the current line or the selected lines below. |
| Move line | `Alt+Up` and `Alt+Down` move the current line or the selected lines. |
| Go to line | `Ctrl+G` asks for a line number, in every kind of note. |

- Each edit is one undo step. The palette has a command for each, in the Text section, so nothing depends on a shortcut.
- A new setting, on by default, turns colouring off: palette, View, **Turn off syntax colouring**.
- Colouring is drawn in a layer behind the editor's text. Only the lines on screen are drawn, so a 20,000-line script stays fast. The layer holds note text, so it is emptied whenever the gutter's measuring element is: when the note locks, when another note opens, before printing. A note longer than 200,000 lines, or a line longer than 20,000 characters, is drawn without colour.
- The tokenizer works one line at a time, in one pass, with a small state carried from line to line (inside a block comment, a multi-line string). To find the state at the first visible line it remembers the state every 200 lines and re-reads only from the nearest remembered point; an edit forgets the points after the edited line.

### 3. Selection toolbar

When text is selected in the editor, a small toolbar appears above the selection (below it when there is no room).

- **Markdown notes:** Bold, Italic, Strikethrough, Highlight, Code, Link, Quote, Bulleted list, and **Decode…** (opens the CTF decode dialog on the selection). Each button wraps the selection, or removes the wrapping if it is already there. Link turns `text` into `[text](url)` and selects `url`; Quote and Bulleted list work on whole lines.
- **Script notes:** Comment, Indent, Outdent, **Decode…**.
- It appears when the mouse button or a selection key is released, not while dragging, and goes away when the selection collapses, on typing, on scroll, on `Esc`, and when another window or dialog opens. It never takes focus by itself.
- Keyboard: `Alt+F10` *(my call)* moves focus into the toolbar when it is showing; arrow keys move between buttons, `Esc` returns to the editor. Every action is also a palette command in the Text section (`Bold`, `Italic`, `Strikethrough`, `Highlight`, `Code`, `Link`, `Quote`, `Bulleted list`).
- A setting, on by default: palette, View, **Turn off the selection toolbar**.
- Highlight uses `==text==`. If the Markdown preview does not render that yet, it is added to the parser as `<mark>`, with tests.

### 4. CTF support

A new palette section, **CTF**, with at most these commands:

| Command | What it does |
|---|---|
| New CTF challenge… | Asks for event, challenge name, category and points. Creates a note from the challenge template in a folder named after the event. |
| Insert challenge template | Quick insert `/ctf`. |
| Insert writeup template | Quick insert `/writeup`. |
| Decode or encode… | A dialog: the input (the selection, or typed), a list of codecs, the output, and **Copy**, **Replace selection**, **Insert below**. |
| Try common decodings | Runs the decoders on the selection or the cursor's line and lists every result that is readable text, best first. Applies up to three layers (for example Base64 of hex). |
| Find flags in this note | Lists flags found, each with a Copy button and the line it is on. |
| Find flags in all notes | The same across every note that is not locked. |
| Flag formats… | Edit the list of flag prefixes. |
| Build CTF report from this folder | Creates the report note described below. |

**Templates.**

```markdown
# <Challenge name>

- Event: <event>
- Category: <category>
- Points: <points>
- Status: unsolved
- Flag:

## Description

## Files and endpoints

## Recon

## Solution

## Solve script

## Notes
```

The writeup template has: title, event, date, team, a summary, a results table (challenge, category, points, status), then per challenge "Summary", "Steps", "Flag", "Lessons learned", and "Tools used".

Categories: web, pwn, crypto, reversing, forensics, stego, osint, misc, mobile, hardware.

**Codecs** (each a pure function with input and output limits; an invalid input gives a clear message, never an exception):

- Base64 (standard and URL-safe), Base32, Base58 (Bitcoin alphabet), Base85 (Ascii85 and Z85), hex, binary, octal and decimal byte lists.
- URL encoding, HTML entities, Unicode escapes (`A`, `\x41`).
- ROT13, ROT47, Atbash, Caesar with a chosen shift, Caesar brute force (all 25), Vigenère encrypt and decrypt with a key, Rail fence (2 to 10 rails), reverse text, swap case.
- Morse code.
- XOR with a key (text or hex), and single-byte XOR brute force showing the ten most readable results.
- Input is limited to 100,000 characters and output to 1,000,000; the brute-force views show at most 30 results of 2,000 characters each.

"Readable" is scored by the share of printable ASCII and common English letters, with a bonus when the output matches a flag format.

**Flags.** A flag is `<prefix>{<1 to 200 characters without braces or line breaks>}`. The prefix list is a setting, default `flag`, `ctf`, `HTB`, `picoCTF`, `THM`, `DUCTF`; each prefix is 1 to 20 letters, digits or underscores, at most 30 prefixes, matched without regard to case. The finder also looks inside Base64, Base32 and hex runs of 16 or more characters, and in reversed text. The user never supplies a regular expression.

**Report from a folder.** Run from a note that is in a folder:

- It reads every note in that folder that was made from the challenge template (it has the `- Category:` line).
- It creates a new Markdown note, `CTF report: <folder>`, in the same folder: a header, a results table (challenge, category, points, status, flag found or not), totals, then each challenge's text with its headings moved down one level, then a "Solve scripts" part with every script note in the folder as a fenced code block.
- **Encrypted notes are never included**, locked or not, because the report is a plain note. The report says only how many were left out, never their titles: an unlocked encrypted note's title comes from its decrypted first line. *(my call)*
- Only notes in a programming or scripting language count as solve scripts. Plain text, INI, JSON, YAML, XML, HTML and CSS notes are not copied in, since they are data and configuration that may hold secrets.
- The report carries a marker line, `Generated by CyberPad CTF report.`, so an earlier report in the folder is never folded into a new one.
- The report stops adding notes before it would pass the 1,000,000-character limit and says which were left out.
- Running it again creates a new report; it does not overwrite the old one.

### Data

- `store.FILE_TYPES`: the table above as a frozen list of `{ ext, lang, group }`; helpers `fileTypeOf(ext)`, `defaultExtFor(note)`. `store.FILE_FORMATS` becomes the list of extensions. A note's `file.format` is validated against it.
- `store.LANGS` gains the nine ids. `codeedit.LANGUAGES` gains matching entries and each language's comment markers.
- New settings: `syntaxColors` (boolean, default true), `selectionToolbar` (boolean, default true), `flagPrefixes` (validated list as above).
- New pure modules with Node tests: `js/core/highlight.js` (tokenizer and bracket matching), `js/core/ctf.js` (codecs, scoring, flag finder, report builder, templates).

## Build steps

**Step 1: pure page logic**, three parts that touch different files and can be built side by side.

- 1a `js/core/store.js`, `js/core/codeedit.js`, `js/core/texttools.js`, `js/core/markdown.js` and their tests: the file-type table and helpers, the new languages with comment markers, the new settings, `codeedit.toggleComment`, `duplicateLines`, `moveLines` (same result shape as the existing functions), `texttools.toggleWrap` / `toggleLinePrefix` / `makeLink` for the toolbar, and `==highlight==` in the Markdown parser if missing.
- 1b `js/core/highlight.js` and tests: `tokenizeLine(lang, line, state) → { tokens: [{ start, end, type }], state }`, `initialState()`, `matchBracket(lines accessor, line, column, lang)`. Linear time; a test with a 20,000-character line of each awkward character under 50 ms; hostile language ids; every language has at least one test for comments, strings and keywords.
- 1c `js/core/ctf.js` and tests: every codec round-trips where it has an inverse, known test vectors for each, limits enforced, hostile inputs (1,000,000 `A`s, lone surrogates, NUL bytes, deeply layered encodings stop at three layers), flag finder cases including encoded and reversed flags and prefixes that try to inject pattern syntax, the report builder with encrypted, locked, oversized and empty folders, and the templates.

**Step 2: desktop host** (`desktop/CyberPad.Desktop/Files`, `Bridge`, tests): the same extension list as one table; `LinkFormat` handling generalised from three values to the table; path policy, dialogs' filters, the unsupported-type message; tests for every listed extension, for look-alikes (`.py.exe`, `.PY`, `.py ` with a trailing space, `.py:stream`, `.cpnote` for a plain note and a script type for an encrypted one), and that the installer's "Open with" registration is unchanged.

**Step 3: file types and IDE features in the page** (`js/app.js`, `js/platform.js`, `css/style.css`, `index.html`): open, import, drop, save and export with the new types; mode from extension; the colouring layer; bracket outline; the four editing commands and Go to line; the settings.

**Step 4: selection toolbar** (`js/app.js`, `css/style.css`, `index.html`).

**Step 5: CTF** (`js/app.js`, `css/style.css`, `index.html`, `js/core/texttools.js` for the palette section and slash entries).

**Step 6: documents.** README (file types table, IDE features and shortcuts, selection toolbar, CTF section, security notes: the wider list and why it is fixed, the hidden colouring layer, no user regex, encrypted notes excluded from reports), `docs/ux-handoff.md`, and the older design docs' file-type statements.

**Verification.** `node --check js/app.js`; `npm test`; `dotnet test desktop/CyberPad.sln` then restore noise-only lock-file changes; the CSP line unchanged; no `innerHTML`, `insertAdjacentHTML` or inline style added; `js/ui/dom.js` untouched; no new message type in the bridge; `desktop/build.ps1` builds the zip and the setup file.
