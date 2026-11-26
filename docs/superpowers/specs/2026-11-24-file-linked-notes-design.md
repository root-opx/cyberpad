# File-linked notes: design

Status: approved by the user on 2026-11-24. Builds on the desktop app (`docs/superpowers/specs/2026-11-23-desktop-app-design.md`), branch `feature/desktop-app`.

## Intent

The user wants CyberPad to work like Notepad with their own files: choose a folder, a file name and a format, keep editing, and reopen the file later. They chose:

- **Linked notes (option A).** A note stays in CyberPad's list and keeps autosaving to `notes.json` as today, and is also linked to a file on disk that receives every change. This keeps the reason they moved to a desktop app (a crash can't cost them their notes) while giving them real files.
- **Host-owned files (approach 1).** The desktop host does all file access through Windows dialogs. The page never sees or sends a path.

## Goals

Updated 2026-11-26: the list of file types is now the table in 2026-11-26-file-types-ide-selection-ctf-design.md.

1. **Save as file.** Link any note to a new or existing file the user picks in the Windows Save dialog, choosing the format.
2. **Keep the file in step.** After linking, every change to the note reaches the file automatically, on the same debounce as `notes.json` saves, written crash-safely.
3. **Open file.** Open a `.txt`, `.md` or `.cpnote` file from inside CyberPad. It becomes a linked note (or focuses the existing one if that file is already linked).
4. **Open with CyberPad.** Starting `CyberPad.exe <path>` (Explorer "Open with", or a shortcut) opens that file, including when CyberPad is already running.
5. **Never lose or clobber.** If the file changed elsewhere, went missing, or can't be written, CyberPad says so and asks. It never silently overwrites, deletes or recreates a user file.

## Non-goals

Updated 2026-11-26: the list of file types is now the table in 2026-11-26-file-types-ide-selection-ctf-design.md.

- Formats beyond `.txt`, `.md`, `.cpnote` (no HTML, PDF, DOCX, RTF).
- Registering file associations in the registry (the app is a portable zip with no installer). The README explains "Open with → Choose another app → CyberPad.exe → Always use this app".
- Drag-and-drop of files onto the window.
- Folder views, a file tree, watching folders, or "recent files" beyond the notes list itself.
- Note history, pin state or other metadata in the file. The file holds the note text only.
- File linking in the browser version (it keeps the one-off export).

## Anti-goals (failure even if it "works")

- Writing an encrypted note's plain text to any file.
- Overwriting a file that changed outside CyberPad without the user choosing to.
- Deleting, moving or recreating a user's file without being asked.
- The page building, holding or sending a filesystem path, or the host accepting one from the page.
- Losing the in-app copy of a note because its file vanished or a write failed.

## Constraints

- Everything in the desktop design's constraints and the user's security rules (`~/.claude/rules/security.md`) applies: validate type, range, allow-list and reject; never build paths from untrusted input; content-free logs; fail closed; bound every input.
- Note body limit stays `LIMITS.body` (1,000,000 chars) from `js/core/store.js`. A file over that limit cannot be opened.
- No new dependencies.

## Approaches considered

| Approach | Trade-off | Outcome |
|---|---|---|
| **1. Host owns files; the page holds only opaque link IDs** | Desktop only. Reuses the reviewed bridge, validation, atomic writes and logging. | **Chosen by the user.** |
| 2. WebView2/Chromium File System Access API from the page | Would also work in Chrome, but permission prompts return after every restart, and writes would bypass the host's checks and atomic save. | Rejected: breaks "it just keeps saving" and widens the attack surface. |
| 3. The page stores paths and asks the host to write them | Simplest code. | Rejected: violates "never build filesystem paths from untrusted input". |

## How it works

### Formats

| Format | Used for | On disk |
|---|---|---|
| `.txt` | plain notes | The note text exactly. |
| `.md` | plain notes | The note text exactly (same bytes as `.txt`; the extension only signals Markdown). |
| `.cpnote` | encrypted notes | JSON: `{"app":"cyberpad","kind":"note","v":1,"cipher":<envelope>}` where `<envelope>` is the note's existing ciphertext envelope (PBKDF2-SHA256 600k + AES-256-GCM, note AAD `neonpad:v1`). |

- **Rule: a link's format must match the note's encryption state.** Plain notes link to `.txt`/`.md`, encrypted notes to `.cpnote`. The Save dialog offers only the formats that match.
- **My call:** text files are written as UTF-8 without BOM and line endings are kept exactly as in the note. On open, UTF-8 (with or without BOM) and UTF-16 LE/BE with BOM are accepted; the file's encoding and BOM are remembered and preserved on later writes. Anything that isn't valid text in those encodings is refused with a message ("This file isn't UTF-8 or UTF-16 text.").
- **When encryption state changes on a linked note:**
  - Encrypting a note linked to `.txt`/`.md`: the link is removed before the first ciphertext is produced, and a dialog says the plain-text file still holds the last saved text and offers **Save as encrypted file…**. CyberPad never deletes the old file.
  - Removing encryption from a note linked to `.cpnote`: the link is removed (the `.cpnote` keeps the last ciphertext) and a toast offers **Save as file…**.

### Commands (palette and keys)

| Command | Key | Behaviour |
|---|---|---|
| Save as file… | Ctrl+Shift+S | Save dialog (start folder: last used, else Documents). Links the note to the chosen file and writes it immediately. Allowed on an already-linked note: moves the link to the new file (the old file stays as it was). |
| Save | Ctrl+S | Linked note: write now (skips the debounce). Unlinked note: same as Save as file… |
| Open file… | Ctrl+O | Open dialog filtered to `.txt;.md;.cpnote`. |
| Show file in folder | — | Opens Explorer with the file selected. |
| Unlink from file | — | Removes the link; the note and the file both stay. |

**My call:** the existing **Export note as Markdown** stays as the one-off copy (it does not link).

### What the user sees

- A linked note shows its **file name** (never the path) and a small status next to the existing save status. The states are "Saved to file", "File changed elsewhere", "File not found" and "Not saved to file: <reason>".
- In the notes list, linked notes get a file marker.
- Deleting a linked note asks for confirmation as today, adding: "The file stays where it is."

### Keeping the file in step

- After each `notes.json` save, the page sends the note's current file text to the host if it differs from what was last written (`.cpnote` sends the envelope JSON). One write per link is in flight at a time; changes during a write coalesce into one more write, mirroring `persistNow`.
- The host writes atomically: a temp file next to the target (hidden, `.<name>.cyberpad-tmp-<8 hex>`), flush with WriteThrough, then `File.Replace` (or `File.Move` for a new file), with the same short retry on sharing or lock violations as `NoteStore`.
- **External change detection (my call):** the host remembers, per link, the size, last-write time (UTC) and SHA-256 of the content it last read or wrote. Before every write it re-checks. If the file changed, it does not write and reports a conflict. It also checks all links when the window regains focus and at startup.
  - Changed elsewhere, and the note has no unwritten changes: reload the file into the note, with a toast "Reloaded <name> from disk."
  - Changed elsewhere, and the note has unwritten changes: show a bar on the note: **Keep mine** (overwrite the file), **Use the file's version** (replace the note text; the previous text goes into note history as usual), **Save mine as a copy…** (Save as to a new file).
- **Missing file (moved, deleted, drive unplugged):** writes pause. The note keeps its text, the status reads "File not found", and the actions are **Save as file…**, **Unlink** and **Retry**. The file is never recreated at the old path without the user choosing **Retry** or Save as.
- **Write failure (read-only file, permissions, disk full):** the status shows "Not saved to file: <reason>" with **Retry** and **Save as file…**. The note stays safe in `notes.json`.
- **Closing:** the existing close handshake also covers unwritten file changes. The "could not save your latest changes" prompt appears if `notes.json` or any linked file couldn't be written.

### Opening files

- **Open file…** reads the file (size ≤ 4 MB on disk, decoded text ≤ `LIMITS.body`), creates a note with that text and links it.
- If the file is already linked to a note, CyberPad shows that note instead. Paths are compared after `Path.GetFullPath`, case-insensitively.
- `.cpnote` files must parse as the JSON above with a valid envelope (`store.validateEnvelope`). They open as a locked note, unlocked with the passphrase as usual. A damaged `.cpnote` is refused with a message and nothing is imported.
- **Open with CyberPad / command line:**
  - `CyberPad.exe "<path>"` is external input. The host checks:
    - exactly one argument
    - a full path after `GetFullPath`
    - an extension in the allow-list
    - a regular file, not a device or a UNC device path such as `\\.\`
    - the size cap
  - On first launch it opens the file after the page loads.
  - **My call:** if CyberPad is already running, the second instance passes the path to the first over a named pipe (`\\.\pipe\CyberPad-<user SID>`). The pipe's ACL allows only the current user, it carries one message (path ≤ 32,767 chars, UTF-8) and has a short timeout. The first instance runs the same checks before opening. Without a path argument, the existing "bring the window forward" behaviour is unchanged.

### Host design

- **Link store:** `%LOCALAPPDATA%\CyberPad\links.json` maps `linkId` (32 hex characters from a CSPRNG, made by the host) to `{ path, format, encoding, bom, size, mtimeUtc, sha256 }`. It is written atomically like `notes.json`. If it is unreadable at startup, it is quarantined like `notes.json`, and the links show "File not found" until re-linked.
- **The page knows only** `note.file = { linkId, name, format }` (name = file name without folder, for display), persisted in `notes.json` and validated by `store.js` (`linkId` exact hex format, `name` ≤ 255 chars, `format` in the allow-list).
- **Orphans:** links in `links.json` that no note references are dropped at startup. A note whose `linkId` isn't in `links.json` shows "File not found".

### Bridge messages (new)

The page sends no paths. Every message has exact field sets, as in the existing dispatcher.

| Page → host | Host → page |
|---|---|
| `saveAsFile {id, format, suggestedName, text}` | `fileLinked {id, linkId, name, format}` / `fileCancelled {id}` / `fileFailed {id, reason}` |
| `relinkFile {id, linkId, format, suggestedName, text}` (Save as on a linked note) | same as above |
| `openFile {id}` | `fileOpened {id, linkId, name, format, text, alreadyLinked:boolean}` / `fileCancelled` / `fileFailed` |
| `writeFile {id, linkId, text, force:boolean}` | `fileWritten {id}` / `fileConflict {id}` / `fileMissing {id}` / `fileFailed {id, reason}` |
| `readFile {id, linkId}` | `fileRead {id, text}` / `fileMissing` / `fileFailed` |
| `checkFiles {id, linkIds:[…]}` (≤ 2000) | `fileStatus {id, statuses:{linkId: "ok"\|"changed"\|"missing"\|"unknown"}}` |
| `unlinkFile {id, linkId}` / `revealFile {id, linkId}` | `fileUnlinked {id}` / `fileRevealed {id}` |
| (host-initiated) | `openRequested {}` when a path arrives from the command line or pipe. The page then sends `openFile`, and the host answers it with the pending path instead of showing a dialog. |

Size limits: `text` ≤ 4 × 1024 × 1024 chars (`.cpnote` of a 1M-char note fits). Unknown `linkId` gets `rejected`. File dialogs follow the existing rule: posted with `BeginInvoke`, never run inside the WebView2 event handler, with only one dialog open at a time.

### Edge cases (my calls, settled after the builder check)

- **What counts as "changed elsewhere": the hash decides.**
  - The host compares size and last-write time first, and reads the SHA-256 only when either differs.
  - A file whose hash equals the last confirmed hash, or the hash of the write in flight, is "ok" even if its timestamp changed (for example a cloud-sync touch).
  - `links.json` is rewritten after every successful file write (it is small), so a restart never mistakes CyberPad's own last write for an outside change.
- **"Unwritten changes"** means the note's current file text differs from the last text the host confirmed with `fileWritten` (or `fileOpened`/`fileRead`). The page tracks this per note in memory; for encrypted notes a pending seal counts as unwritten.
  - A silent reload happens only when there are no unwritten changes and there has been no typing in that note for 2 seconds. Otherwise the conflict bar appears.
- **One file, one note.**
  - Duplicate note: the copy has no link.
  - Backup export and import: `note.file` is stripped, because a link ID means nothing on another machine or after a restore.
  - Save as or relink onto a file already linked to another note: refused with "That file is already linked to another note." plus a **Show it** action. Path comparison uses `GetFullPath`, case-insensitive.
- **Line endings.** The editor works with `\n`. On open, the host notes whether the file used CRLF (more `\r\n` than lone `\n`) and normalises to `\n` before sending the text. On write, it converts back to the remembered style.
  - New files are written with LF.
  - `.cpnote` is JSON, so line endings don't matter.
- **Who decodes.** Only the host reads and decodes file bytes; the page receives text and checks `LIMITS.body`. The browser import path (`store.js` strict UTF-8 and `LIMITS.importBytes`) is unchanged.
- **Notes cap.** If opening a file would exceed `LIMITS.notes`, the open is refused with a message. Nothing is replaced.
- **Encrypting or decrypting a linked note.** The link is removed only after the user confirms the passphrase dialog. Cancelling changes nothing.
  - If the host can't remove the link, encryption is aborted (fail closed), so ciphertext is never produced for a note still linked to `.txt`/`.md`.
  - Save as file… on a locked encrypted note works and writes the existing envelope as `.cpnote`.
- **Paths from the command line or pipe while busy.**
  - The host keeps a FIFO queue of up to 20 pending paths; extra paths are refused and logged.
  - It sends `openRequested` once the page is ready and no file dialog is open. The page processes the queue one `openFile` at a time, after any open CyberPad dialog closes.
  - Opening a plain file never needs the vault; a `.cpnote` opens locked.
- **First instance not answering.** If the second instance can't hand over its path within 3 seconds, it shows "CyberPad is already running but not responding." and exits. It never starts a second writer.
- **Status checks off the UI thread.**
  - `checkFiles` and the pre-write checks run on a worker with a 2-second timeout per file. A timeout reports "unknown", which changes nothing and is retried at the next check.
  - Writes to a slow network drive simply stay "saving" until they finish or fail.

## What's left to the builder

- Exact UI placement and styling of the file status and the conflict bar (match the existing status line and toasts).
- The precise wording of toasts and dialogs not quoted here (sentence case, no note content).
- Internal class structure in the host (for example a `LinkStore` beside `NoteStore`, and pipe handling beside `SingleInstance`).
- Test structure. Cover every row of the message table, each external-change and missing-file branch, the encoding round-trips, command-line path validation, the pipe's single-message and timeout behaviour, and the encryption-state transitions.
