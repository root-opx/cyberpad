# CyberPad

An offline, cyberpunk-retro notepad that runs in your browser. No install, no account, no network, no dependencies.

## Run it

Double-click `index.html` (Chrome, Edge, or another Chromium browser).

Or serve the folder locally, which also gives the app its own storage origin:

```powershell
python -m http.server 8787 --bind 127.0.0.1
```

Then open http://localhost:8787.

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

## Where your data lives

Notes are stored in your browser's `localStorage` on this device. Nothing ever leaves it: the Content Security Policy blocks all network connections.

- **Unencrypted notes are stored as plain text.** Anyone with access to this browser profile can read them. Encrypt anything sensitive.
- When you open the app from `file://`, Chromium shares one storage area between all local HTML files. Serving it from `localhost`, as shown above, gives it a storage area of its own.
- Clearing site data deletes your notes, so export a backup now and then.

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

## Development

```powershell
npm test
```

The tests use Node's built-in test runner (Node 18+) and cover the calculator, Markdown parser, text tools, vault, store, security tools, CVSS scoring (checked against reference scores), and the subnet calculator, including negative cases such as injection payloads, tampered ciphertext, bad imports, and prototype pollution.

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
js/app.js           application controller
tests/              node:test suites
```
