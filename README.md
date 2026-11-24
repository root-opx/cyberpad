# CyberPad

An offline, cyberpunk-retro notepad that runs in your browser, or as a Windows desktop app. No account, no network use of its own, no dependencies.

## Run it

**In a browser**

Double-click `index.html` (Chrome, Edge, or another Chromium browser).

Or serve the folder locally, which also gives the app its own storage origin:

```powershell
python -m http.server 8787 --bind 127.0.0.1
```

Then open http://localhost:8787.

**As a Windows app:** see [Desktop app](#desktop-app) below.

## What it does

**Writing**
- Markdown with a live preview. Switch between Write, Split, and Read with `Ctrl+E`.
- `/` quick inserts at the start of a word: `/date`, `/time`, `/now`, `/utc`, `/week`, `/todo`, `/table`, `/code`, `/link`, `/wiki`, `/uuid`, and more.
- Inline calculator: end a line with `=` and press `Tab`, for example `1280 * 0.15 =` becomes `1280 * 0.15 = 192`. It supports `+ - * / % ^`, parentheses, `sqrt abs round floor ceil sin cos tan ln log exp pow min max`, `pi`, and `e`.
- Lists continue when you press Enter. Pressing Enter on an empty item ends the list.
- `Ctrl+Enter` turns a line into a task or ticks it. You can also tick tasks in the preview.
- Pasting a URL over selected text makes a Markdown link.
- Select text that contains numbers and the status bar shows their sum and average.

**Organising**
- `[[Note title]]` links notes together. Clicking a missing link creates the note, and each note lists its backlinks.
- `#tags` show up in the sidebar for filtering. A new note inherits the active tag filter.
- Pinned notes, full-text search with highlighted snippets, and a daily log (`Alt+T`).
- Version history: the app keeps a snapshot at most once a minute while you type, up to 20 per note, and you can restore any of them.

**Command palette (`Ctrl+K`)**
- Runs every command and jumps to any note. Type `@` to jump to a heading in the current note.
- Text transforms on the selection, or on the whole note if nothing is selected: case changes, sort, reverse, dedupe, trim, number lines, Base64, URL encode/decode, and JSON format/minify.
- 25-minute focus timer and 5-minute break timer.

**Encryption**
- **Encrypt note** seals a note with AES-256-GCM. The key comes from your passphrase via PBKDF2-SHA256 with 600,000 iterations, a random salt, and a fresh IV on every save. The app only ever stores ciphertext, and turning on encryption deletes the note's plaintext history.
- Unlocked notes lock again after a set idle time (configurable from 1 to 60 minutes) or right away with `Alt+L`.
- They also lock when you switch away from the tab or minimize the window. Turn this off from the palette under Vault if it gets in the way. Locking cancels any open dialog that belongs to the encrypted note, so a confirmation can never act on a note that locked in the background.
- Text copied while an encrypted note is open (with `Ctrl+C`, cut, or a Copy button) is cleared from the clipboard 30 seconds later. Browsers only let a page write to the clipboard while it has focus, so if you are in another app at that moment, it is cleared as soon as you come back. The app never reads the clipboard, so whatever is there at that point is overwritten, even if you copied something else in the meantime. You can turn this off under Vault.
- A forgotten passphrase cannot be recovered.

**Security tools** (palette group "Security")
- **Extract IOCs** (`Alt+I`) pulls URLs, domains, IPv4/IPv6 addresses, emails, MD5/SHA-1/SHA-256/SHA-512 hashes, CVE IDs, and MITRE ATT&CK technique IDs out of the selection or the whole note. It reads defanged text too (`hxxp`, `[.]`, `[@]`, `[dot]`), removes duplicates, and filters out file names like `notes.md` that look like domains. You can copy each value, download the list as CSV, or open it as a new note. Output is defanged by default.
- **Defang IOCs** / **Refang IOCs** make indicators safe to paste into tickets and chat, or turn them back into live values. Undo works as usual.
- **Secret scanner** checks the note in the background as you type and shows a warning bar when it finds a credential: private keys, AWS, GitHub, GitLab, Slack, Google, Stripe and `sk-` API keys, JWTs, Azure storage keys, passwords inside URLs, and `password = …` style assignments. From the bar you can encrypt the note, mask the secrets with `[REDACTED:type]` (which also scrubs them from version history), review each finding, or ignore them. Encrypted notes are not scanned.
- **Hash selection** / **Hash a file** give SHA-1, SHA-256, SHA-384, and SHA-512 with Web Crypto. Files are hashed locally and never leave the browser (256 MB limit).
- **Decode JWT** shows the header, payload, and claim times, and flags expired, not-yet-valid, and unsigned (`alg: none`) tokens. It decodes only and does not verify the signature.
- **Convert timestamp** reads Unix seconds, milliseconds, or microseconds, Windows FILETIME / Active Directory values, and date strings, and shows UTC, local time, and the other formats.
- Hex, HTML entity, and ROT13 encode/decode on the selection.
- **CVSS 3.1 calculator** scores a vector from the selection or the cursor's line, or builds one with a metric picker. It covers base, temporal, and environmental scores for CVSS 3.0 and 3.1, and **Update in note** writes the vector back. Any valid vector in a note shows its score and severity in the preview. Click the badge to open it in the calculator.
- **Subnet calculator** takes `10.0.0.5/24`, `10.0.0.5 255.255.255.0`, `2001:db8::/48`, or a bare address, from the selection or the cursor's line. It shows the network, netmask, wildcard, usable range, broadcast, host count, and address type (RFC 1918, CGNAT, link-local, documentation, ULA, and so on), and can check whether an address is inside the network. **Insert summary** adds the result to the note as a list.
- **Reference links:** `CVE-2024-3094`, `CWE-79`, `T1059.001`, and `TA0001` become links to NVD, MITRE CWE, and MITRE ATT&CK in the preview. They open in a new tab and only when you click them.

**Engagement templates**
- `/finding` inserts a pentest finding: severity, CVSS, CWE, affected assets, status, reported time, description, steps to reproduce, evidence, impact, remediation, and references.
- `/ioc` inserts an IOC tracking table, `/timeline` an incident timeline table that starts with the current UTC time, and `/utc` a UTC timestamp such as `2026-11-23 14:05:12 UTC`.
- The same templates are in the palette under Templates. Block templates always start on a new line.

**Look and feel**
- Three screen themes, picked from the menu in the title bar or the palette: Neon, Amber, and Terminal green (classic monochrome green screen).
- A CRT effect (scanlines, glow, vignette) that you can switch off. Flicker is disabled when your system asks for reduced motion.
- Optional synthesized typing sounds and a boot screen you can skip.
- Zen mode (`Alt+Z`), and a layout that works on phone screens.

**Files**
- Export a note as `.md`, or export a JSON backup of every note. Encrypted notes stay encrypted in the backup, but the others are plain text.
- **Export encrypted backup** seals the whole backup into one file with AES-256-GCM, under a passphrase you choose (PBKDF2-SHA256 with 600,000 iterations, a fresh salt and IV each time). Notes that were already encrypted keep their own passphrase inside it. Import the file like any other backup and the app asks for the passphrase.
- Import `.txt`, `.md`, or backup `.json` files with the file picker or by dropping them on the window.

## Shortcuts

| Keys | Action |
| --- | --- |
| `Ctrl+K` | Command palette |
| `Alt+N` / `Alt+T` | New note / today's log |
| `Alt+P` | Pin or unpin |
| `Ctrl+S` | Save now (it also saves automatically) |
| `Ctrl+E` | Switch layout |
| `Ctrl+B` | Show or hide the note list |
| `Ctrl+F` / `Ctrl+H` | Find / find and replace (with regex and case options) |
| `F3` / `Shift+F3` | Next / previous match |
| `Alt+Z` | Zen mode |
| `Alt+L` | Lock encrypted notes |
| `Alt+I` | Extract IOCs |
| `Esc`, then `Tab` | Move focus out of the editor |
| `F1` | All shortcuts |

## Desktop app

The same notepad in its own window and process. If the page inside it crashes, the window stays open and your saved notes are not lost. It is a .NET 8 + WebView2 host around the unchanged web app, for 64-bit Windows.

**Get it**
- Build `CyberPad-win-x64-<version>.zip` with `desktop/build.ps1` (see Development); there is no hosted download yet. Unzip it anywhere and run `CyberPad.exe`. Nothing is installed.
- The build is not code-signed, so Windows SmartScreen warns on first run. Click **More info**, then **Run anyway**.
- It needs the Microsoft Edge WebView2 Runtime, which is preinstalled on Windows 11. If it is missing, the app shows a message with Microsoft's download page; it never downloads anything itself.

**How it behaves**
- Only one copy runs at a time. Starting it again brings the open window forward, so two copies never write the same file.
- Notes are saved to disk as you type. Each save writes a temporary file and swaps it in, keeping the previous save as a backup, so a crash at any moment loses at most the last fraction of a second of typing and never corrupts your notes.
- If the web engine's page process dies, the window reloads from the last save. If that happens three times within a minute, it shows a message instead of looping. A page that is only busy (not responding for a while) is left alone, so work you have not saved yet is not thrown away.
- Closing the window waits up to 5 seconds for the last save (including any pending encryption), then exits. If that last save fails (for example, the disk is full or the folder is not writable), the app asks whether to close anyway and lose the latest changes; choose **No** to stay open and export a backup.
- Minimizing locks encrypted notes, as the lock-when-hidden setting does in a browser.
- Exports and backups open the Windows Save dialog. They cannot be saved into the CyberPad data folder. Imports use the Open dialog or drag and drop, as before.
- Links in the preview open in your default browser only when you click them, and only `http`, `https`, and `mailto` links.
- If the app cannot read its notes file at startup, it restores the previous save, keeps the unreadable file in the data folder, and tells you. If only the backup copy is damaged, it keeps the unreadable files aside and immediately writes your notes back as `notes.json`. If it cannot load your notes at all, saving is turned off for that session, so nothing gets overwritten.

**Your own files**

A note can be linked to a `.txt`, `.md` or `.cpnote` file you choose. The note stays in CyberPad too; the file is a second copy that CyberPad keeps in step.

- **Save as file** (Ctrl+Shift+S, or the palette) asks where to put a new file and links the note to it. Plain notes default to `.md`; new files are UTF-8 without BOM, with LF line endings.
- **Save** (Ctrl+S) writes the note to its linked file now. Linked notes are also written as you type.
- **Open file** (Ctrl+O) opens a file as a note, linked to it. Opening a file that is already linked jumps to its note.
- **Open with:** right-click a `.txt`, `.md` or `.cpnote` file in Explorer, choose **Open with**, then **CyberPad**. To make it the default, choose **Open with**, **Choose another app**, pick `CyberPad.exe` and tick **Always**. CyberPad makes no registry changes of its own. You can also run `CyberPad.exe "C:\path\file.md"`. If CyberPad is already running, the file opens in that window; if it cannot be reached within 3 seconds you get "CyberPad is already running but not responding." Any other file type is refused with "CyberPad can only open .txt, .md and .cpnote files."
- **Formats:** CyberPad reads UTF-8 (with or without BOM) and UTF-16 with a BOM, keeps a file's CRLF line endings when you save it, and refuses anything else, or text containing a NUL, with "This file isn't UTF-8 or UTF-16 text." Files up to 4 MB are accepted.
- **Encrypted notes** save as `.cpnote`: a small JSON file holding the same encrypted envelope the note already uses, so it stays ciphertext on disk. Encrypting a note that is linked to a `.txt` or `.md` file removes that link (the plain file is left alone, and you are told). A `.cpnote` file opens as an encrypted note and asks for its passphrase.
- **Changed elsewhere:** CyberPad checks linked files when the window regains focus. If you have no unsaved changes and have not typed in the note for two seconds, the new version loads quietly; otherwise a bar offers **Keep mine** or **Use the file's version**.
- **Missing file:** the note shows "File not found" and keeps its text. You can Save as to a new file or unlink it. CyberPad never deletes your files and never recreates one on its own.
- A file can be linked to one note only ("That file is already linked to another note."). Duplicating a note drops the link, and backups never include it.

**Moving notes from the browser version**

The desktop app cannot read a browser's storage. In the browser version, export a backup (Command palette → **Export backup of all notes**, or **Export encrypted backup**), then import that file here. A new install's welcome note says the same.

**Your notes**

They live in `%LOCALAPPDATA%\CyberPad` (paste it into Explorer's address bar). That is the local profile, so roaming profiles do not sync it.

| File | What it is |
| --- | --- |
| `notes.json` | all your notes |
| `notes.json.bak` | the previous good save |
| `notes.json.tmp` | a save in progress; it exists only for a moment, or after a save was cut off |
| `notes.unreadable-<time>.json`, `notes.unreadable-<time>.bak.json` | files the app could not read, kept instead of deleted |
| `links.json` | which note is linked to which file on disk (the page only ever sees file names) |
| `links.unreadable-<time>.json` | a links file the app could not read, kept instead of deleted |
| `window.json` | window size and position |
| `cyberpad.log`, `cyberpad.log.1` | diagnostics log: UTC time, message type, rejection reason or error type name, never note content. When it reaches 256 KB it becomes `cyberpad.log.1` (replacing the older one) and a new log starts, so the two stay around half a megabyte. |
| `WebView2\` | the web engine's own profile |

**Unencrypted notes are plain text in `notes.json`.** Anyone who can read your Windows profile or the disk can read them. Encrypt anything sensitive, and consider BitLocker for the disk. Encrypted notes are stored as ciphertext only.

## Where your data lives

**Browser version.** Notes are stored in your browser's `localStorage` on this device. Nothing ever leaves it: the Content Security Policy blocks all network connections.

- **Unencrypted notes are stored as plain text.** Anyone with access to this browser profile can read them. Encrypt anything sensitive.
- When you open the app from `file://`, Chromium shares one storage area between all local HTML files. Serving it from `localhost`, as shown above, gives it a storage area of its own.
- Clearing site data deletes your notes, so export a backup now and then.

**Desktop app.** Notes are in `%LOCALAPPDATA%\CyberPad\notes.json` (details under [Desktop app](#desktop-app)). The app itself never sends them anywhere.

## Security notes

- Nothing is rendered as HTML. Markdown is parsed into a syntax tree and built with DOM text nodes, so `<script>` in a note shows up as text. Links are allowed only for `http`, `https`, and `mailto` URLs.
- Strict CSP: `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'`, with no inline scripts or styles.
- The calculator uses its own bounded parser and never calls `eval` or `Function`.
- Stored data and imports are validated field by field. Note sizes, counts, and history depth are capped; bad records are dropped instead of being repaired.
- Imports must use an allowed extension, have no risky double extension, stay within the size limit, and decode as strict UTF-8 with no binary bytes.
- The secret scanner and IOC extractor use bounded regular expressions with capped result counts. Finding previews are masked, and secrets never go into storage outside the note itself, logs, or the URL.
- CSV exports prefix cells that start with `=`, `+`, `-`, `@`, tab, or carriage return, so a malicious indicator cannot run as a spreadsheet formula.
- CVSS vectors are checked against an allow-list of metrics and values. Unknown metrics, duplicates, bad values, missing base metrics, and vectors over 300 characters are rejected with a specific message, never repaired.
- Reference links are built from fixed URL templates. The ID must match its full pattern (for example `CVE-` plus a 4-digit year and 4 to 7 digits), so note text cannot change the host or path. Links never nest inside other links.
- Encrypted backups use a different AES-GCM associated-data label from notes, so a backup ciphertext can never be opened as a note or the other way round. A file that claims to be an encrypted backup but fails validation is reported as damaged and never imported as text. After decryption, the contents go through the same field-by-field backup validation as a plain backup.
- The subnet calculator rejects ambiguous input instead of guessing: no leading zeros in IPv4 octets (which some tools read as octal), no hex or short IPv4 forms, only contiguous netmasks, and no IPv6 zone IDs.
- MD5 is not offered: Web Crypto does not provide it and the app does not ship its own crypto. SHA-1 is offered only for matching against existing threat intel.
- Unlocking backs off after repeated failures. Since everything runs client-side, the real protection is the slow PBKDF2 key derivation and a strong passphrase.

### Desktop app

- **Narrow host bridge.** The page can send only a fixed list of message types: load, save, quarantine, export, flushed, flushFailed and the linked-file messages (save as, relink, open, write, read, check, unlink, reveal, prune). Each is checked for the exact origin (`https://cyberpad.example/`), a known `type`, exact field types, no extra fields, and size limits (64 Mi characters of note text, 4 Mi for a linked file, 120-character file names, link IDs of exactly 32 hex characters). Anything else is rejected and written to `cyberpad.log` by type and reason only; note content is never logged. There is no message to read or write an arbitrary path or run a command. Export file names are reduced to a safe name with a forced extension, and the user picks the real path in the Save dialog.
- **Linked files.** The page only ever sees link IDs and file names; the host holds every path and accepts only `.txt`, `.md` and `.cpnote` (also from the command line and the pipe). Writes go through a hidden temporary file in the target folder and a swap, and a file that changed since CyberPad last read it is not overwritten unless you choose to. "Open with" hands paths to a running window over a named pipe that only your own Windows account can open. It carries one path of at most 32,767 characters, which is checked again before use, and at most 20 pending opens are kept. At startup CyberPad switches its working directory to its own folder, so nothing is ever resolved against the folder of a file you opened.
- **Locked-down web view.** The app loads only from its own virtual host `cyberpad.example` (a reserved name that never resolves), keeping the strict CSP. Navigation anywhere else is cancelled, new windows are cancelled, and downloads are cancelled. Every permission request (camera, microphone, location, clipboard read, and so on) is denied. Dev tools and browser shortcut keys are off in release builds, password and form autofill are off, and SmartScreen reputation checks are off for the local page.
- **External links.** A clicked link opens in the default browser only if it is a well-formed `http`, `https`, or `mailto` URL. `file:`, `javascript:`, `ms-settings:`, UNC paths, and every other scheme are ignored.
- **Crash-safe storage.** Saves are atomic with a kept backup, and unreadable files are renamed, never deleted. The app and its host make no network requests and send no telemetry. The WebView2 runtime is Microsoft's own component and follows Microsoft's and Windows' settings for diagnostic data, which CyberPad does not control. The only runtime NuGet dependency is `Microsoft.Web.WebView2`; `Microsoft.NET.ILLink.Tasks` is a build-time package, and the published exe bundles the .NET runtime. Every build audits the NuGet packages in the lock files for known vulnerabilities, and fails if the audit finds any or cannot complete.
- **Not covered:** the exe is unsigned, and the notes file is not encrypted as a whole (see above). WebView2 crash dumps under `%LOCALAPPDATA%\CyberPad\WebView2` can contain memory from the page, including the text of unlocked encrypted notes.

## Development

```powershell
npm test
```

The tests use Node's built-in test runner (Node 18+) and cover the calculator, Markdown parser, text tools, vault, store, security tools, CVSS scoring (checked against reference scores), and the subnet calculator, including negative cases such as injection payloads, tampered ciphertext, bad imports, and prototype pollution.

**Desktop app.** You need the .NET 8 SDK and Node 18+.

```powershell
dotnet test desktop/CyberPad.sln -c Release
powershell -ExecutionPolicy Bypass -File desktop/build.ps1
```

`desktop/build.ps1` runs `npm test` and the .NET tests, audits the .NET packages for known vulnerabilities (and fails if it finds any), publishes a self-contained single-file build, and zips it to `dist/CyberPad-win-x64-<version>.zip` (about 65 MB). It stops at the first failing step. The version is set once, in `desktop/CyberPad.Desktop/CyberPad.Desktop.csproj`. `dist/` is not committed.

Manual checks for the desktop app:
- Kill the WebView render process (`msedgewebview2.exe`) in Task Manager: the window reloads with your notes intact.
- Kill `CyberPad.exe` while typing: the last save is intact on the next start.
- Hold `notes.json` open in PowerShell (`$f = [IO.File]::Open("$env:LOCALAPPDATA\CyberPad\notes.json", 'Open', 'ReadWrite', 'None')`), type something, and close the window: the app asks before closing without saving, and **No** keeps it open. Run `$f.Dispose()` afterwards.
- Minimize with an unlocked encrypted note: it is locked when you restore the window.
- Click an NVD link in the preview: it opens in the default browser.
- Start `CyberPad.exe` a second time: the first window comes to the front.
- Linked files (use a scratch folder):
  - Save a note as `.md`, edit it, and see the file change on disk.
  - Edit the file in Notepad, then switch back to CyberPad: you get a quiet reload, or the conflict bar if you had typed.
  - Delete the file: the note shows "File not found".
  - Open a CRLF file and a UTF-16 file, save without edits, and confirm the bytes are identical (`Get-FileHash` before and after).
  - Edit a file that has mixed line endings elsewhere: **Use the file's version** ends on the conflict bar (expected; **Keep mine** resolves it).
  - "Open with" while CyberPad is running: the file opens in the running window, which comes forward. Try an `.exe` and a second argument too: both are refused.
  - Encrypt a linked `.txt` note: the link is removed and the notice appears. If unlinking fails, the encrypt dialog closes without encrypting.
  - Make a linked file read-only, change the note and close the window: the close prompt appears. Do the same with a file in conflict.
  - Switch to another app and back, and close a native dialog: both trigger the file check (WebView2 focus).
  - Save as / Open dialogs: filters, `.md` as the default extension and the starting folder.
  - Ctrl+O, Ctrl+S and Ctrl+Shift+S work from the editor.
  - **Show file in folder** opens Explorer with the file selected.
  - The file status and the conflict bar fit in every theme and at narrow widths, and the toast buttons can be reached with the keyboard.

```
index.html          app shell and CSP
css/style.css       themes and layout
js/core/            pure logic, also loaded by Node tests
  calc.js           safe expression evaluator
  markdown.js       Markdown to syntax tree, URL allow-list
  texttools.js      stats, tags, links, transforms, slash commands, fuzzy match
  vault.js          PBKDF2 + AES-GCM via Web Crypto
  store.js          data model, validation, backup and import checks
  secops.js         IOC extraction, defang, secret scanning, decoders, hashing
  cvss.js           CVSS 3.0/3.1 parsing and scoring
  netcalc.js        IPv4/IPv6 subnet calculator
js/ui/              DOM helpers: renderer, caret position, sound
js/platform.js      storage and file adapter (browser or desktop host)
js/app.js           application controller
tests/              node:test suites
desktop/            Windows host (WinForms + WebView2), its xUnit tests, build.ps1
```
