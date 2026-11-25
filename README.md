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

**As a Windows app:** run the installer, or unzip the portable build. See [Desktop app](#desktop-app) below.

## What it does

**Writing**
- Markdown with a live preview. Switch between Write, Split, and Read with `Ctrl+E`.
- `/` quick inserts at the start of a word: `/date`, `/time`, `/now`, `/utc`, `/week`, `/todo`, `/table`, `/code`, `/link`, `/wiki`, `/uuid`, and more.
- Inline calculator: end a line with `=` and press `Tab`, for example `1280 * 0.15 =` becomes `1280 * 0.15 = 192`. It supports `+ - * / % ^`, parentheses, `sqrt abs round floor ceil sin cos tan ln log exp pow min max`, `pi`, and `e`.
- Lists continue when you press Enter. Pressing Enter on an empty item ends the list.
- `Ctrl+Enter` turns a line into a task or ticks it. You can also tick tasks in the preview.
- Pasting a URL over selected text makes a Markdown link.
- Select text that contains numbers and the status bar shows their sum and average.
- Typing `->`, `<-`, `<->` or `=>` gives `→`, `←`, `↔` or `⇒`. It never happens inside a fenced code block or inline code, or for pasted text. Backspace or `Ctrl+Z` right after a replacement puts back what was there before that keystroke, so after `<->` it gives `←>`. Find and replace never makes arrows. Turn it off in the palette under View (**Turn off arrow replacement**).

**Scripts**
- **Script mode** is set per note. In the palette, Note section, **Script mode: choose a language…** opens a list of languages and **Back to a Markdown note** returns. The status bar shows the language and opens the same list. Switching modes never changes the text.
- Languages and what one indent is:

  | Language | One indent |
  | --- | --- |
  | Bash | 2 spaces |
  | C | 4 spaces |
  | C++ | 4 spaces |
  | C# | 4 spaces |
  | CSS | 2 spaces |
  | Go | 1 tab |
  | HTML | 2 spaces |
  | Java | 4 spaces |
  | JavaScript | 2 spaces |
  | JSON | 2 spaces |
  | PowerShell | 4 spaces |
  | Python | 4 spaces |
  | Rust | 4 spaces |
  | SQL | 4 spaces |
  | TypeScript | 2 spaces |
  | YAML | 2 spaces |

- `Tab` with no selection inserts spaces up to the next indent stop (a tab in Go); with a whole line or several lines selected it indents them. `Shift+Tab` removes one level from the current line or from every selected line.
- `Enter` keeps the indentation and adds one level after the language's block openers: `:` in Python, `{` in the C family, `then` or `do` in Bash, `|` in YAML, and so on. This also works when the line ends in a comment. `Enter` between a pair of brackets puts the closing bracket on its own line, but only when the bracket before the caret is one of the language's block openers (so not in Python, YAML or HTML).
- A closing bracket typed on an empty indented line steps back one level. `Backspace` steps back one level only when everything to the left of the caret on the line is spaces; in Go it deletes one tab as usual. Each of these is one undo step. `Esc`, then `Tab` still leaves the editor.
- Long lines scroll sideways instead of wrapping.
- The preview shows the note as one code block with the language name and a Copy button. **Export note as PDF** prints that block, and **Export note as Markdown** writes the code in a fenced block. Linked files and exports keep the `.txt`, `.md` and `.cpnote` extensions.
- Switched off in a script note: arrow replacement, list continuation, `Ctrl+Enter` tasks, `/` quick inserts, the inline calculator, URL-paste links, and `#tags`, `[[links]]` and "Go to heading", so a `# comment` is not a tag or a heading. The secret scanner stays on. There is no syntax colouring.
- **The language of a script note is not encrypted, even for encrypted notes.**
- **Line numbers** sit in a gutter at the left of the editor, and the caret's line is brighter. **Line numbers: script notes only (change)** in the palette's View section cycles script notes only (the default), every note, off; the title names the current state. In a Markdown note a wrapped line gets one number, at its first row. Numbers are hidden in a wrapped note of more than 3,000 lines or 200,000 characters.

**Organising**
- `[[Note title]]` links notes together. Clicking a missing link creates the note, and each note lists its backlinks.
- `#tags` show up in the sidebar for filtering. A new note inherits the active tag filter.
- Pinned notes, full-text search with highlighted snippets, and a daily log (`Alt+T`). The note list shows at most 500 rows; when notes are left out, a last row says how many, and search finds them.
- Version history: the app keeps a snapshot at most once a minute while you type, up to 20 per note, and you can restore any of them.
- Folders: a note can be in one folder. The sidebar lists folders first, each with its note count and a header that opens and closes (the state is remembered), then the notes without a folder. Use **Move to folder…**, **Remove from folder** and **Rename folder…** in the palette (renaming to an existing folder's name merges the two after a confirmation), or drag a note onto a folder header, or onto the area below the folders to take it out. A new note joins the folder of the note that was open (New note, Duplicate, the credentials note, a note made from a `[[wiki link]]` and Extract IOCs); today's log, imports and opened files start with no folder. Dragging notes is a mouse shortcut: the palette commands do the same from the keyboard or a touch screen. A folder exists while at least one note is in it. Folder names cannot contain `/`, `\`, control characters, or invisible and text-direction characters; that also refuses emoji built with a joiner (such as family or profession emoji) and the zero-width non-joiner some scripts use. **Folder names are not encrypted, even for encrypted notes.**
- Deleting: the `×` on a note row (or the `Delete` key on a focused row) asks for confirmation, then the toast offers **Undo** for 10 seconds. Undo restores the text, folder, pin, history and file link, and an encrypted note comes back locked. A linked file on disk is never deleted. The 10 seconds end early if you switch away from the window or minimise it. Undo is also the palette command **Undo delete**, and `Ctrl+Z` in the list does the same.

**Command palette (`Ctrl+K`)**
- Runs every command and jumps to any note. Type `@` to jump to a heading in the current note.
- Commands are grouped in sections (Note, File, View, Insert, Text, Tools, Vault, Security) listed beside the commands. `Tab` moves to the next section and `Shift+Tab` back, and typing searches all of them.
- Text transforms on the selection, or on the whole note if nothing is selected: case changes, sort, reverse, dedupe, trim, number lines, Base64, URL encode/decode, and JSON format/minify.
- 25-minute focus timer and 5-minute break timer.

**Encryption**
- **Encrypt note** seals a note with AES-256-GCM. The key comes from your passphrase via PBKDF2-SHA256 with 600,000 iterations, a random salt, and a fresh IV on every save. The app only ever stores ciphertext, and turning on encryption deletes the note's plaintext history.
- Unlocked notes lock again after a set idle time (configurable from 1 to 60 minutes) or right away with `Alt+L`.
- They also lock when you switch away from the tab or minimize the window. Turn this off from the palette under Vault if it gets in the way. Locking cancels any open dialog that belongs to the encrypted note, so a confirmation can never act on a note that locked in the background.
- Text copied while an encrypted note is open (with `Ctrl+C`, cut, or a Copy button) is cleared from the clipboard 30 seconds later. Browsers only let a page write to the clipboard while it has focus, so if you are in another app at that moment, it is cleared as soon as you come back. The app never reads the clipboard, so whatever is there at that point is overwritten, even if you copied something else in the meantime. You can turn this off under Vault.
- **New encrypted credentials note** (palette, Insert, or `/credentials`) asks for a passphrase and creates an encrypted note with a table for system, username, password, URL and notes. The note is encrypted before it is saved. Typed in an unlocked encrypted note, `/credentials` inserts the table at the cursor.
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
- The same templates are in the palette under Insert. Block templates always start on a new line.

**Look and feel**
- Six theme choices, picked from the menu in the title bar or the palette: System, Light, Dark, Neon, Amber, and Terminal green (classic monochrome green screen). Neon is the default. System follows your operating system's light or dark setting: Light in light mode, Dark in dark mode, and it switches live when the setting changes.
- The app starts in the colours of the theme that was last on screen, with no flash of another theme. The window and title bar use it too in the desktop app.
- In the desktop app, the Windows title bar takes the colour of the theme on screen, for all five themes (Windows 11; Windows 10 shows its own dark bar).
- A CRT effect (scanlines, glow, vignette) that you can switch off. On Light it gives faint scanlines only. On Dark it gives scanlines and dark corners, with no text glow. Flicker is disabled when your system asks for reduced motion.
- Optional synthesized typing sounds and a boot screen you can skip.
- Zen mode (`Alt+Z`), and a layout that works on phone screens.

**Files**
- **Export note as PDF** opens the print dialog; choose Save as PDF there. The PDF of an encrypted note is not encrypted, so the app asks you to confirm first.
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
| `Delete` | Delete the focused note in the list |
| `Ctrl+Z` in the note list | Undo the last delete |
| `Alt+I` | Extract IOCs |
| `Tab` / `Shift+Tab` | Indent / outdent in a script note |
| `Esc`, then `Tab` | Move focus out of the editor |
| `F1` | All shortcuts |

## Desktop app

The same notepad in its own window and process. If the page inside it crashes, the window stays open and your saved notes are not lost. It is a .NET 8 + WebView2 host around the unchanged web app, for 64-bit Windows.

**Get it**
- Build with `desktop/build.ps1` (see Development); there is no hosted download yet. It writes two files to `dist/`:
  - `CyberPad-Setup-<version>.exe`, the installer: run it and follow the setup window (see [Installing and uninstalling](#installing-and-uninstalling)).
  - `CyberPad-win-x64-<version>.zip`, the portable build: unzip it anywhere and run `CyberPad.exe`. It installs nothing and makes no registry changes.
- Neither file is code-signed, so Windows SmartScreen warns on first run of the setup file or of `CyberPad.exe`. Click **More info**, then **Run anyway**. A company-managed PC may block unsigned programs.
- It needs the Microsoft Edge WebView2 Runtime, which is preinstalled on Windows 11. If it is missing, the app shows a message with Microsoft's download page; it never downloads anything itself.

**Installing and uninstalling**

Running the setup file shows a setup window, not the app. It installs CyberPad for your Windows account only, with no administrator prompt and no network access. You choose the folder; the default is `%LOCALAPPDATA%\Programs\CyberPad`. Your notes are stored separately, in `%LOCALAPPDATA%\CyberPad`, and setup does not touch them. A **Start CyberPad when setup finishes** box is ticked by default.

- **Folder rules.** The folder must be one of its own on a local drive. Setup refuses a drive root, your profile, Desktop, Documents and Downloads folders themselves, anything under Windows or Program Files, network and removable drives, a path with a `%` in it, a folder reached through a link, and the notes folder or any folder that contains it or is inside it. If the folder already has other files in it, setup uses a `CyberPad` subfolder and shows that path before installing.
- **What setup adds, and nothing else.**
  - The program files in the chosen folder, plus `Uninstall.exe` and `install.manifest` (the list of files setup wrote).
  - A Start menu shortcut, `%APPDATA%\Microsoft\Windows\Start Menu\Programs\CyberPad.lnk`.
  - Two registry keys under the current user: `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\CyberPad` (the entry under Settings, Apps, Installed apps) and `HKCU\Software\Classes\Applications\CyberPad.exe` (so CyberPad appears in Explorer's **Open with** list for `.md`, `.txt` and `.cpnote`; it is not made the default for anything).
- **Updating.** Running a setup file when CyberPad is already installed updates it in place, in the same folder. To move it, uninstall first.
- **Running copy.** Setup never closes a running CyberPad. It asks you to close it and changes nothing.
- **Uninstalling.** Use Settings, Apps, Installed apps, or run `Uninstall.exe` in the install folder. It removes exactly the files setup wrote (from `install.manifest`), the shortcut and the two registry keys. Files in the folder that setup did not write are left, and then so is the folder. Your notes are kept unless you tick **Also delete my notes and settings** and confirm a second question. A program cannot delete itself while it runs, so a copy of the uninstaller (about 100 KB) is left in your temp folder.

The main app is unchanged: it makes no registry changes itself and has no code that installs or uninstalls.

**How it behaves**
- Only one copy runs at a time. Starting it again brings the open window forward, so two copies never write the same file.
- Notes are saved to disk as you type. Each save writes a temporary file and swaps it in, keeping the previous save as a backup, so a crash at any moment loses at most the last fraction of a second of typing and never corrupts your notes.
- If the web engine's page process dies, the window reloads from the last save. If that happens three times within a minute, it shows a message instead of looping. A page that is only busy (not responding for a while) is left alone, so work you have not saved yet is not thrown away.
- Closing the window waits up to 5 seconds for the last save (including any pending encryption), then exits. If that last save fails (for example, the disk is full or the folder is not writable), the app asks "CyberPad could not save your latest changes (to its notes or to a linked file). Close anyway?"; choose **No** to stay open and export a backup. If a linked file is still being written after 5 seconds (for example, on a slow network share), it asks "CyberPad is still saving to a linked file. Close anyway?" instead of closing.
- Minimizing locks encrypted notes, as the lock-when-hidden setting does in a browser.
- Exports and backups open the Windows Save dialog. They cannot be saved into the CyberPad data folder. Imports use the Open dialog or drag and drop, as before.
- Links in the preview open in your default browser only when you click them, and only `http`, `https`, and `mailto` links.
- If the app cannot read its notes file at startup, it restores the previous save, keeps the unreadable file in the data folder, and tells you. If only the backup copy is damaged, it keeps the unreadable files aside and immediately writes your notes back as `notes.json`. If it cannot load your notes at all, saving is turned off for that session, so nothing gets overwritten.

**Your own files**

A note can be linked to a `.txt`, `.md` or `.cpnote` file you choose. The note stays in CyberPad too; the file is a second copy that CyberPad keeps in step.

- **Save as file** (Ctrl+Shift+S, or the palette) asks where to put a new file and links the note to it. Plain notes default to `.md`; new files are UTF-8 without BOM, with LF line endings.
- **Save** (Ctrl+S) writes the note to its linked file now. Linked notes are also written as you type.
- **Open file** (Ctrl+O) opens a file as a note, linked to it. Opening a file that is already linked jumps to its note.
- **Open with:** if you used the installer, CyberPad is already in the **Open with** list. Right-click a `.txt`, `.md` or `.cpnote` file in Explorer, choose **Open with**, then **CyberPad** (with the portable zip, pick `CyberPad.exe` through **Choose another app** the first time). To make it the default, choose **Open with**, **Choose another app**, pick `CyberPad.exe` and tick **Always**. The app never makes registry changes itself; the installer registers CyberPad in the **Open with** list (the two keys above), and with the portable zip you add it by hand as described here. You can also run `CyberPad.exe "C:\path\file.md"`. A relative path is resolved against the folder you ran it from. If CyberPad is already running, the file opens in that window; if it cannot be reached within 3 seconds you get "CyberPad is already running but not responding." Any other file type is refused with "CyberPad can only open .txt, .md and .cpnote files."
- **Formats:** CyberPad reads UTF-8 (with or without BOM) and UTF-16 with a BOM, keeps a file's CRLF line endings when you save it, and refuses anything else, or text containing a NUL, with "This file isn't UTF-8 or UTF-16 text." Files can be up to 4 MB on disk and, for `.txt` and `.md`, at most 1,000,000 characters of text.
- **Encrypted notes** save as `.cpnote`: a small JSON file holding the same encrypted envelope the note already uses, so it stays ciphertext on disk. Encrypting a note that is linked to a `.txt` or `.md` file removes that link (the plain file is left alone, and you are told). A `.cpnote` file opens as an encrypted note and asks for its passphrase.
- **Changed elsewhere:** CyberPad checks linked files when the window regains focus. If you have no unsaved changes and have not typed in the note for two seconds, the new version loads quietly; otherwise a bar offers **Keep mine** or **Use the file's version**. A file edited while CyberPad was closed is reloaded on start if the note had no changes since it was last saved to that file; otherwise the bar asks.
- **Missing file:** the note shows "File not found" and keeps its text. You can Save as to a new file or unlink it. CyberPad never deletes your files and never recreates one on its own. If the file comes back unchanged, saving to it resumes on its own.
- A file can be linked to one note only ("That file is already linked to another note."). Duplicating a note drops the link, and backups never include it.

**Moving notes from the browser version**

The desktop app cannot read a browser's storage. In the browser version, export a backup (Command palette → **Export backup of all notes**, or **Export encrypted backup**), then import that file here. A new install's welcome note says the same.

**Your notes**

They live in `%LOCALAPPDATA%\CyberPad` (paste it into Explorer's address bar). That is the local profile, so roaming profiles do not sync it. Uninstalling keeps this folder unless you ask for it to be deleted.

| File | What it is |
| --- | --- |
| `notes.json` | all your notes |
| `notes.json.bak` | the previous good save |
| `notes.json.tmp` | a save in progress; it exists only for a moment, or after a save was cut off |
| `notes.unreadable-<time>.json`, `notes.unreadable-<time>.bak.json` | files the app could not read, kept instead of deleted |
| `links.json` | which note is linked to which file on disk (the page only ever sees file names) |
| `links.unreadable-<time>.json` | a links file the app could not read, kept instead of deleted |
| `window.json` | window size and position |
| `appearance.json` | the last theme, so the window starts in the right colours |
| `cyberpad.log`, `cyberpad.log.1` | diagnostics log: UTC time, message type, rejection reason or error type name, never note content. When it reaches 256 KB it becomes `cyberpad.log.1` (replacing the older one) and a new log starts, so the two stay around half a megabyte. |
| `WebView2\` | the web engine's own profile |

**Unencrypted notes are plain text in `notes.json`.** Anyone who can read your Windows profile or the disk can read them. Encrypt anything sensitive, and consider BitLocker for the disk. Encrypted notes are stored as ciphertext only.

## Where your data lives

**Browser version.** Notes are stored in your browser's `localStorage` on this device. Nothing ever leaves it: the Content Security Policy blocks all network connections. The theme name is also kept in `localStorage` under `cyberpad.theme`, so the page can start in the right colours.

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
- Folder names are validated: 1 to 40 characters, no `/`, `\`, control characters, or invisible and text-direction characters, and at most 100 folders. This also refuses emoji built with a joiner (such as family or profession emoji) and the zero-width non-joiner some scripts use. They are stored in plain text, also for encrypted notes.
- The language of a script note is stored in plain text, like the folder name, also for encrypted notes. The script preview and the line-number measuring element are built from text nodes and are cleared when a note locks.
- `appearance.json` is read with a size cap and accepts only the five theme names; an unreadable file falls back to Neon. It holds a theme name and nothing else, as does `cyberpad.theme` in the browser.
- The start-up theme script is an external file (`js/early-theme.js`) allowed by the existing CSP, so there is still no inline script.
- The credentials note is sealed before it joins the note list, and cancelling the passphrase prompt leaves nothing behind.
- The PDF of an encrypted note is plain text once saved.
- Deleting a note removes it from storage immediately. Undo keeps it only in memory for 10 seconds.
- Unlocking backs off after repeated failures. Since everything runs client-side, the real protection is the slow PBKDF2 key derivation and a strong passphrase.

### Desktop app

- **Narrow host bridge.** The page can send only a fixed list of message types: load, save, quarantine, export, flushed, flushFailed, theme and the linked-file messages (save as, relink, open, write, read, check, unlink, reveal, prune). Each is checked for the exact origin (`https://cyberpad.example/`), a known `type`, exact field types, no extra fields, and size limits (64 Mi characters of note text, 4 Mi for a linked file, 120-character file names, link IDs of exactly 32 hex characters). Anything else is rejected and written to `cyberpad.log` by type and reason only; note content is never logged. The `theme` message carries only `neon`, `amber`, `terminal`, `light` or `dark`; with System chosen the page sends `light` or `dark`, never `system`, and sends again when the system setting changes; the colours are fixed in the host, and any other value is rejected. There is no message to read or write an arbitrary path or run a command. Export file names are reduced to a safe name with a forced extension, and the user picks the real path in the Save dialog.
- **Linked files.** The page only ever sees link IDs and file names; the host holds every path and accepts only `.txt`, `.md` and `.cpnote` (also from the command line and the pipe). Writes go through a hidden temporary file in the target folder and a swap, and a file that changed since CyberPad last read it is not overwritten unless you choose to. "Open with" hands paths to a running window over a named pipe that only your own Windows account can open. It carries one path of at most 32,767 characters, which is checked again before use, and at most 20 pending opens are kept. At startup CyberPad switches its working directory to its own folder, so nothing is ever resolved against the folder of a file you opened.
- **Locked-down web view.** The app loads only from its own virtual host `cyberpad.example` (a reserved name that never resolves), keeping the strict CSP. Navigation anywhere else is cancelled, new windows are cancelled, and downloads are cancelled. Every permission request (camera, microphone, location, clipboard read, and so on) is denied. Dev tools and browser shortcut keys are off in release builds, password and form autofill are off, and SmartScreen reputation checks are off for the local page.
- **External links.** A clicked link opens in the default browser only if it is a well-formed `http`, `https`, or `mailto` URL. `file:`, `javascript:`, `ms-settings:`, UNC paths, and every other scheme are ignored.
- **Crash-safe storage.** Saves are atomic with a kept backup, and unreadable files are renamed, never deleted. The app and its host make no network requests and send no telemetry. The WebView2 runtime is Microsoft's own component and follows Microsoft's and Windows' settings for diagnostic data, which CyberPad does not control. The only runtime NuGet dependency is `Microsoft.Web.WebView2`; `Microsoft.NET.ILLink.Tasks` is a build-time package, and the published exe bundles the .NET runtime. Every build audits the NuGet packages in the lock files for known vulnerabilities, and fails if the audit finds any or cannot complete.
- **Installer.** Setup and uninstall run per user, with no administrator rights, no network access and no command shell (CyberPad.exe and the uninstaller's temp copy are started directly by full path). The chosen folder is validated before anything is written (local drive, not a shared or system folder, not the notes folder, no link, no `%`). The payload is unpacked with every entry name checked to stay inside the install folder, and with limits of 2,000 files and 1 GB. Uninstall deletes only files listed in `install.manifest` (itself limited to 2,000 paths and 256 KB), each checked to be inside the install folder, and removes a folder only when it is empty; it never deletes an install folder recursively. The notes folder is a fixed path, checked not to be a link, and is deleted only after a second confirmation; links inside it are removed, not followed. Only the two registry keys named above are written, both under the current user. The setup file and the uninstaller are unsigned.
- **Not covered:** the exe is unsigned, and the notes file is not encrypted as a whole (see above). WebView2 crash dumps under `%LOCALAPPDATA%\CyberPad\WebView2` can contain memory from the page, including the text of unlocked encrypted notes.

## Development

```powershell
npm test
```

The tests use Node's built-in test runner (Node 18+) and cover the calculator, Markdown parser, text tools, vault, store, security tools, CVSS scoring (checked against reference scores), the subnet calculator, the script-mode indentation rules, and the `index.html` checks (the early-theme script, the exact Content-Security-Policy, no inline script or style attribute), including negative cases such as injection payloads, tampered ciphertext, bad imports, and prototype pollution.

**Desktop app.** You need the .NET 8 SDK, Node 18+, and the .NET Framework 4.7.1 developer pack (installed with Visual Studio) for the two small setup and uninstall programs, which run on the .NET Framework that is part of Windows 10 and 11. No extra package is used.

```powershell
dotnet test desktop/CyberPad.sln -c Release
powershell -ExecutionPolicy Bypass -File desktop/build.ps1
```

`desktop/build.ps1` stops at the first failing step. Its steps are:

1. `npm test`
2. `dotnet test`
3. vulnerable package audit: audits the .NET packages for known vulnerabilities and fails if it finds any
4. `dotnet publish`: a self-contained single-file build
5. `zip`: checks the publish output and writes `dist/CyberPad-win-x64-<version>.zip` (about 65 MB)
6. `build Uninstall.exe`
7. `build CyberPad-Setup.exe`: embeds the zip and `Uninstall.exe`
8. `check and copy the setup file`: fails if it is smaller than the zip or larger than 150 MB, then writes `dist/CyberPad-Setup-<version>.exe`

The version is set once, in `desktop/CyberPad.Desktop/CyberPad.Desktop.csproj`. `dist/` is not committed. The .NET tests include the installer and uninstaller logic.

Manual checks for the desktop app:
- Installer (do these on a PC where losing the install does not matter):
  - Run the setup file: the setup window appears, not the app.
  - Install to the default folder: CyberPad starts, is in the Start menu and under Installed apps, and appears under Open with for a `.md` file.
  - Choose your Documents folder: setup refuses. Choose a folder that already has files: setup offers a `CyberPad` subfolder.
  - Run the setup file again: it offers to update the existing install, and the folder cannot be changed.
  - Start setup while CyberPad is running: it asks you to close CyberPad and changes nothing.
  - Put a file of your own in the install folder, then uninstall from Settings: the program, shortcut and both entries are gone, your file and the folder remain, and your notes are still in `%LOCALAPPDATA%\CyberPad`.
  - Uninstall with the box ticked and choose Keep notes at the second question: the notes are kept.
- Kill the WebView render process (`msedgewebview2.exe`) in Task Manager: the window reloads with your notes intact.
- Kill `CyberPad.exe` while typing: the last save is intact on the next start.
- Hold `notes.json` open in PowerShell (`$f = [IO.File]::Open("$env:LOCALAPPDATA\CyberPad\notes.json", 'Open', 'ReadWrite', 'None')`), type something, and close the window: the app asks before closing without saving, and **No** keeps it open. Run `$f.Dispose()` afterwards.
- Minimize with an unlocked encrypted note: it is locked when you restore the window.
- Export note as PDF opens the print dialog, and Save as PDF gives a readable file with dark text on white.
- Move a note into a folder, close the app and reopen it: the folder and its closed or open state are kept.
- Delete a linked note and undo: the note returns still linked. Delete it again and wait: the file is still on disk.
- Delete a linked note, then open its file with Ctrl+O within 10 seconds: the deleted note comes back and no second note is created.
- Drag a note onto a folder header and onto the area below the folders: it moves, and the import drop zone does not appear.
- Type -> in a note and in a fenced code block: only the first becomes an arrow.
- Click an NVD link in the preview: it opens in the default browser.
- Start `CyberPad.exe` a second time: the first window comes to the front.
- With the CRT effect off, the Windows title bar is the same colour as the app's bar in each theme and changes when the theme changes. With CRT on it is the same base colour without the scanlines.
- Choose System, then switch Windows between light and dark mode: the app and its title bar follow.
- Choose Light: the title bar is light with dark text, and the CRT switch gives faint scanlines only.
- With Light chosen, close and reopen the app: the window and title bar are light from the first moment.
- Replace appearance.json in the data folder with random text and start the app: it starts in Neon colours without a message.
- In a Python script note, Tab, Shift+Tab and Enter after a colon indent by four spaces, and a long line scrolls sideways.
- With line numbers on, the numbers line up with the lines while scrolling, and disappear when an encrypted note locks.
- Minimise, maximise, close, drag, snap and the title bar's system menu still work.
- Linked files (use a scratch folder):
  - Save a note as `.md`, edit it, and see the file change on disk.
  - Edit the file in Notepad, then switch back to CyberPad: you get a quiet reload, or the conflict bar if you had typed.
  - Close CyberPad, edit a linked file in Notepad, and start CyberPad: the note reloads quietly with "Reloaded <name> from disk." Do it again after typing in the note and closing while the file is read-only: the conflict bar asks instead.
  - Delete the file: the note shows "File not found".
  - Open a CRLF file and a UTF-16 file, save without edits, and confirm the bytes are identical (`Get-FileHash` before and after).
  - Edit a file that has mixed line endings elsewhere: **Use the file's version** loads it and the bar goes away; the file is not rewritten until you edit the note.
  - "Open with" while CyberPad is running: the file opens in the running window, which comes forward. Try an `.exe` and a second argument too: both are refused.
  - Encrypt a linked `.txt` note: the link is removed and the notice appears. If unlinking fails, the encrypt dialog closes without encrypting.
  - Make a linked file read-only, change the note and close the window: the close prompt appears. Do the same with a file in conflict.
  - Link a note to a file on a slow or unreachable network share (or pause the share), type, and close the window within a second: after 5 seconds "CyberPad is still saving to a linked file. Close anyway?" appears. **No** keeps the window open (closing again asks the page again); **Yes** closes.
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
  codeedit.js       script-mode languages and indentation rules
js/ui/              DOM helpers: renderer, caret position, sound
js/early-theme.js   applies the last theme before first paint
js/platform.js      storage and file adapter (browser or desktop host)
js/app.js           application controller
tests/              node:test suites
desktop/            Windows host (WinForms + WebView2), its xUnit tests, build.ps1
  CyberPad.Install/   installer and uninstaller logic (folder rules, unpacking, manifest, registry, shortcut)
  CyberPad.Setup/     the setup window, built into CyberPad-Setup-<version>.exe
  CyberPad.Uninstall/ the uninstall window, built into Uninstall.exe
  Shared/             code shared by the two windows (common UI helpers, embedded-library loader)
```
