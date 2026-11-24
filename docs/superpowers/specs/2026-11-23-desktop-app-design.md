# CyberPad desktop app: design

Date: 2026-11-23
Status: approved by the user on 2026-11-23 (without DPAPI file encryption)

## Intent

CyberPad currently runs in a browser tab, and its notes live in that browser's `localStorage`. The user doesn't like a notepad that depends on the browser: if the browser crashes, the notepad goes down with it. They want a downloadable Windows application that runs in its own process and window, and whose notes stay safe whatever crashes.

## Goals

1. **Own process and window.** `CyberPad.exe` starts like any desktop program, with its own taskbar entry and icon. A browser crash cannot take it down.
2. **Notes on disk, crash-safe.** Notes are saved to a file in the user's profile. A crash at any moment, mid-save included, loses at most the last fraction of a second of typing. It never corrupts the saved file.
3. **Recover from its own crashes.** If the web engine's page process dies, the window reloads the app from the last save without asking.
4. **Same app inside.** The editor, vault, security tools, themes, and shortcuts work exactly as they do now.
5. **Native file handling.** Exports and backups open the Windows Save dialog. Imports keep working through the Open dialog and drag-and-drop.
6. **Same security bar or higher.** It keeps the strict CSP and the no-network rule, and the host exposes the narrowest possible native API to the page.

## Non-goals

- Mac and Linux builds. The user chose Windows only. Tauri was the cross-platform alternative.
- Auto-update, code signing, an MSI/MSIX installer, and a Microsoft Store listing. A later step can add these. The first deliverable is a portable folder (zip).
- Rewriting the UI natively. The existing HTML, CSS, and JS run inside WebView2.
- Reading notes out of the old browser version automatically. The desktop app cannot reach a browser's `localStorage`. Moving notes over uses the existing backup export and import.

## Anti-goals (a failure even if it works)

- The host becomes a general file or system API for the page, for example "read any path" or "run a command".
- Any network access appears: telemetry, update checks, remote content, or fonts.
- Encrypted notes end up in plaintext anywhere on disk, temp files included.
- A partial or failed write replaces the last good copy of the notes.
- Two running copies of CyberPad overwrite each other's saves.

## Constraints

- **Toolchain:** .NET 8 SDK (installed, 8.0.428), the WebView2 Evergreen Runtime (installed, 157.x, kept current by Windows Update), Node 24 for the existing JS tests. No Rust and no Electron.
- **Dependencies:** the security rules (section 11) require pinned versions, an audit, and nothing the framework already provides.
  - App: `Microsoft.Web.WebView2` (official Microsoft package), nothing else.
  - Tests: `Microsoft.NET.Test.Sdk`, `xunit`, `xunit.runner.visualstudio`.
  - Pin versions with `packages.lock.json` (`RestorePackagesWithLockFile`). Audit with `dotnet list package --vulnerable --include-transitive`.
- **The web code stays dependency-free.** The browser version keeps working, because `npm test` and quick UI checks use it.

## Approaches considered

| Approach | Trade-offs | Outcome |
| --- | --- | --- |
| **.NET 8 + WebView2 (WinForms host)** | Everything is already installed. One official dependency. Windows Update patches the web engine. About 70 MB self-contained, or about 2 MB if it relies on an installed .NET runtime. Windows only. | **Chosen by the user** |
| Tauri 2 (Rust + system WebView) | Cross-platform, tiny installer, strict permission model. Needs the Rust toolchain plus several GB of VS Build Tools, and brings many third-party crates. | Not chosen: Windows only is fine |
| Electron | Cross-platform, uses the installed Node. Bundles its own Chromium (100 MB+), and every Chromium fix needs a new app release. The `electron` package runs an install script that downloads binaries. Larger hardening surface. | Not chosen |
| Browser "install as app" (PWA) | Still runs inside the browser, so it doesn't fix the crash coupling. | Ruled out |
| Neutralino | Its native bridge runs through a local web server, which adds attack surface. | Ruled out |

## Design

### Repository layout

```
index.html, css/, js/, tests/      existing web app and Node tests (unchanged location)
js/platform.js                     NEW: storage and file adapter (browser or desktop)
desktop/
  CyberPad.Desktop/                NEW: WinForms + WebView2 host (net8.0-windows)
  CyberPad.Desktop.Tests/          NEW: xUnit tests for the host's storage and message handling
  CyberPad.sln
docs/superpowers/specs/            this document
```

The host project copies `index.html`, `css/`, and `js/` into a `wwwroot` folder next to the exe at build time (MSBuild `Content` items with `Link`). One copy of the web code serves both versions.

### Host program (C#)

- **Window:** a single WinForms `Form` containing the WebView2 control, with title "CyberPad" and an app icon. The window size and position are remembered in a small settings file in the data folder.
- **Single instance:** a per-user named mutex. A second launch brings the existing window forward and exits, so two processes never write the same file.
- **WebView2 environment:**
  - The user data folder is `%LOCALAPPDATA%\CyberPad\WebView2`, so it is never shared with Edge.
  - The app is served through `SetVirtualHostNameToFolderMapping("cyberpad.example", wwwroot, Deny)`. `.example` is a reserved TLD that never resolves. The page loads from `https://cyberpad.example/index.html`, so the existing CSP `'self'` still works.
- **Lockdown settings:**
  - Devtools are off in Release builds and on in Debug.
  - Browser accelerator keys are off, so Ctrl+R, F5, Ctrl+P, and the browser's own Ctrl+F do nothing. The app's shortcuts are JavaScript and keep working.
  - The status bar is off.
  - Password autosave and general autofill are off, so passphrase fields are never offered to a store.
  - The default context menu stays for cut, copy, and paste, with "Inspect" and other non-editing items removed.
  - Pinch zoom is off. Ctrl+wheel zoom is allowed.
- **Navigation policy:**
  - `NavigationStarting`: cancel any navigation to a host other than `cyberpad.example`.
  - `NewWindowRequested` (the preview's `target="_blank"` links: web links, NVD, MITRE): always cancel the WebView window. If the URI is well formed and its scheme is `http` or `https`, open it in the user's default browser with `Process.Start` (`UseShellExecute = true`, the URI as the only argument). Ignore any other scheme. `mailto:` links open the default mail client through the same allow-listed path.
  - `DownloadStarting`: cancel. Exports go through the Save dialog (below).
  - `PermissionRequested`: deny every kind (camera, microphone, geolocation, notifications, clipboard-read, and so on). Clipboard writes need no permission.
- **Crash recovery:**
  - `ProcessFailed` with a render-process failure: reload `index.html`. If it happens three times within 60 seconds, show a native message with the data folder path instead of looping.
  - Browser-process failure: recreate the WebView2 control.
- **Closing safely:**
  - On `FormClosing`, the first time, cancel the close and post `{type: "flush"}` to the page.
  - The page finishes pending encryption, saves, and replies `{type: "flushed"}`. The host then closes for real.
  - If no reply comes within 5 seconds, close anyway: the last completed save is on disk.
- **Minimize locks the vault:** when the window is minimized, set `CoreWebView2Controller.IsVisible = false`. This fires `visibilitychange` (hidden) in the page, so the existing "lock when hidden" setting covers minimizing. Restoring sets it back to true.

### Storage (host side)

- **Data folder:** `%LOCALAPPDATA%\CyberPad\`.
  - The folder is `LocalAppData`, not roaming `AppData`, so notes never sync to corporate profile servers.
  - It is created with the user's default ACL, which is private to the user.
- **Files:**
  - `notes.json` is the state, as produced by `store.serialize`.
  - `notes.json.bak` is the previous good copy.
- **Atomic save:**
  1. Write `notes.json.tmp` with `FileOptions.WriteThrough` and flush.
  2. Then `File.Replace(tmp, notes.json, notes.json.bak)`.
  3. On the very first save, when `notes.json` doesn't exist yet, use `File.Move`.
  4. A failure at any step leaves `notes.json` untouched, and the host reports the error to the page.
- **Load:**
  - The host reads `notes.json` and returns its text, and also returns `notes.json.bak` if it exists.
  - The page validates the main copy with the existing `store.parseStored`. If that copy is missing or fails, the page uses the backup and shows a toast saying it restored the previous save.
  - If both fail, the page starts empty and asks the host to rename the unreadable files to `notes.unreadable-<timestamp>.json` instead of deleting them.
- **The host never interprets note content.** It stores the page's string as is, after its own checks (below). Validation of the content stays in `store.js`, which already treats storage as untrusted.

### Bridge between page and host

- **Transport:** `window.chrome.webview.postMessage(obj)` from page to host, and `CoreWebView2.PostWebMessageAsJson` from host to page.
- **Every message the host accepts** goes through one dispatcher that checks:
  - The sender origin (`args.Source`) is exactly `https://cyberpad.example/`.
  - The payload is a JSON object with a string `type` from this allow-list:

| type | From page | Host does | Reply |
| --- | --- | --- | --- |
| `load` | `{id}` | read `notes.json` and `.bak` | `{type:"loaded", id, main: string\|null, backup: string\|null, version: string, dataDir: string}` |
| `save` | `{id, data: string}`, `data` ≤ 64 Mi chars | atomic save | `{type:"saved", id}` or `{type:"saveFailed", id, reason}` |
| `quarantine` | `{id}` | rename unreadable files with a timestamp | `{type:"quarantined", id}` |
| `exportFile` | `{id, kind: "note"\|"backup"\|"encryptedBackup"\|"iocCsv"\|"iocMd", suggestedName: string ≤ 120 chars, text: string ≤ 64 Mi chars}` | show the Save dialog with a filter chosen by `kind` (`.md`, `.json`, `.csv`), write atomically to the chosen path | `{type:"exported", id, name}`, `{type:"exportCancelled", id}` or `{type:"exportFailed", id, reason}` |
| `flushed` | `{type}` | finish closing | none |
| `flushFailed` | `{type}` | the last save failed: ask the user whether to close anyway | none |
| `saveAsFile` | `{id, format: "txt"\|"md"\|"cpnote", suggestedName ≤ 120 chars, text ≤ 4 Mi chars}` | Save dialog, write the file, create a link | `{type:"fileLinked", id, linkId, name, format}` or `{type:"fileCancelled", id}` |
| `relinkFile` | as `saveAsFile` plus `linkId` | same, moving an existing link to the new file | `fileLinked` or `fileCancelled` |
| `openFile` | `{id}` | Open dialog (or the next queued command-line path), read the file, create or reuse a link | `{type:"fileOpened", id, linkId, name, format, text, alreadyLinked}` or `fileCancelled` |
| `writeFile` | `{id, linkId, text ≤ 4 Mi chars, force: boolean}` | atomic write to the linked file; without `force` it refuses if the file changed since last confirmed | `fileWritten`, `fileConflict` or `fileMissing` (each `{type, id}`) |
| `readFile` | `{id, linkId}` | read the linked file | `{type:"fileRead", id, text}` or `fileMissing` |
| `checkFiles` | `{id, linkIds: string[] ≤ 2000}` | compare size, time and hash of each linked file (2 s limit per file) | `{type:"fileStatus", id, statuses: {<linkId>: "ok"\|"changed"\|"missing"\|"unknown"}}` |
| `unlinkFile` | `{id, linkId}` | drop the link (never touches the file) | `{type:"fileUnlinked", id}` |
| `revealFile` | `{id, linkId}` | open Explorer with the file selected | `{type:"fileRevealed", id}` |
| `pruneLinks` | `{id, linkIds: string[] ≤ 2000}` | drop every link not in the list | `{type:"linksPruned", id}` |

`linkId` is exactly 32 lowercase hex characters, made by the host. The page never sends or receives a path, only link IDs and file names. Any file message can fail with `{type:"fileFailed", id, reason, linkId?}` (`linkId` only when the file is already linked to another note), and a `linkId` the host does not know is answered with `rejected`. A message the dispatcher refuses is answered with `{type:"rejected", id, reason}` when it carries a valid `id`.

Host to page without a request: `{type:"openRequested"}`. It asks the page to call `openFile` for the next queued path (from the command line or "Open with"). It is posted only when a path is queued, the page is ready and no dialog is open, with at most one outstanding.

- **Origin rule (`AppOrigin.IsAppUri`):** the sender of every message, every navigation and the page-ready check accept only an absolute `https` URI whose host is `cyberpad.example` (case-insensitive), with the default port, no user-info, no whitespace or control characters and at most 8192 characters. Any path is accepted.

- **Strict validation:**
  - Unknown types, wrong field types, oversize strings, and extra fields are rejected. The host logs only the type and the reason, never the content.
  - `suggestedName` is reduced to a safe file name with no path separators, no reserved device names, and an extension forced by `kind`. It is only a suggestion: the user picks the real path in the dialog.
  - The host has no "write to this path" or "read this path" message.
- **Reading imported files stays in the page.** `<input type="file">` and drag-and-drop already work in WebView2 with the native Open dialog, and `store.checkImportFile` and `decodeImportBytes` already validate them. Hashing a file (`Hash a file`) is unchanged for the same reason.
- **Request IDs** are random strings from the page, and replies echo them. The page keeps a map of pending requests with a timeout.
- **Saves never pile up:**
  - The host handles messages one at a time on the UI thread and does file I/O off it, with at most one save running.
  - The page keeps at most one `save` in flight. If the state changes while a save is running, it marks itself dirty and sends one more save with the latest state when the reply arrives.
- **Too large to save:** if the serialized state is over the 64 MB message limit, the page doesn't send it. The status bar shows "Not saved", and a toast says to export a backup and remove large notes. The host also rejects anything over the limit, in case the page check is bypassed.

### Page changes (JS)

- **New `js/platform.js`** uses the same wrapper as `js/core/*.js` (it attaches to `window.NP`, or `module.exports` in Node), so Node tests can load it with a fake `chrome.webview`. It detects the desktop host (`window.chrome && window.chrome.webview`) and exposes one interface with two backends:
  - `platform.loadState()` returns `{ main, backup }`. In the browser it reads `localStorage`, including the existing legacy-key migration.
  - `platform.saveState(text)` returns a Promise.
  - `platform.exportFile({ kind, suggestedName, text, mime })`. In the browser it uses today's `download()`.
  - `platform.onFlushRequest(fn)` exists only on the desktop.
  - `platform.isDesktop`.
- **`app.js`:**
  - `load()` becomes async on the desktop path. `init()` is already async.
  - `persistNow()` calls `platform.saveState`, and the save-state LED reflects the reply ("Saved", "Saving…", or "Not saved" with the reason).
  - The localStorage quota fallback stays browser-only.
  - `download()` call sites switch to `platform.exportFile` with a `kind`.
- **Desktop-only tweaks:**
  - The "Where your data lives" hints and toasts that mention browser storage name the data folder instead.
  - The `storage` event warning about other tabs is skipped, because single instance makes it unnecessary.
  - The boot screen's "reading storage … KB" line uses the size of the last loaded or saved state text instead of reading `localStorage`.
  - `beforeunload` handling is replaced by the flush handshake.
- **Unchanged:** the CSP meta tag, vault, settings, and every feature.

### Moving notes from the browser version

On first run with no `notes.json`, the welcome note gets one extra line explaining how to bring notes over: export a backup (plain or encrypted) from the browser version, then import it here. There is no automatic migration, because the desktop app cannot read a browser's storage.

### Build and packaging

- `dotnet publish desktop/CyberPad.Desktop -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true` produces `CyberPad.exe` and `wwwroot/`, about 70 MB.
- The version (`1.0.0` to start) lives once, in the host `.csproj`. It's shown in the window's About line (palette: "About CyberPad") and in the zip name.
- A small PowerShell script, `desktop/build.ps1`, runs the Node tests, the .NET tests, and the vulnerable-package audit, then publishes and zips the result to `dist/CyberPad-win-x64-<version>.zip`.
- If the WebView2 runtime is missing (rare on Windows 10/11), the app shows a native message with Microsoft's download page. It does not download anything itself.
- **Unsigned builds:** the exe isn't code-signed, so Windows SmartScreen will warn on first run ("More info" → "Run anyway"). Signing needs a certificate the user would have to provide, so it's out of scope for now.
- `dist/`, `bin/`, and `obj/` are added to `.gitignore`.

### Testing

- **Existing:** `npm test` (81 Node tests) stays green, and the browser version keeps working.
- **New xUnit tests (host)**, including the negative cases the security rules require:
  - Atomic save writes the new content and keeps the old copy as `.bak`.
  - A simulated failure mid-save (temp write throws) leaves `notes.json` unchanged.
  - First save without an existing file works.
  - Quarantine renames rather than deletes.
  - The dispatcher rejects:
    - an unknown `type`
    - a wrong origin
    - non-string `data`
    - oversize `data` (>64 MB)
    - extra fields
    - a missing `id`
    - an unknown `kind`
  - Export file-name sanitizing handles `..\..\x`, `CON`, a name with `/` or `:`, a name over 120 characters, and the wrong extension.
  - The external-link policy allows `https://nvd.nist.gov/...` and rejects `file:///C:/`, `javascript:`, `ms-settings:`, and `\\server\share`.
- **New Node tests** for `platform.js`, using a fake `chrome.webview`: request/reply matching, timeouts, the fallback to the backup copy, and that a save failure surfaces as an error.
- **Manual checks (documented in the README):**
  - Kill the WebView render process in Task Manager: the window reloads with notes intact.
  - Kill `CyberPad.exe` mid-typing: the last save is intact on the next start.
  - Minimize with an unlocked encrypted note: it locks.
  - Click an NVD link: it opens in the default browser.
  - A second launch focuses the first window.

## Calls I made (the user can override)

- `%LOCALAPPDATA%` rather than roaming `%APPDATA%`, so notes don't sync to profile servers.
- Single instance, which is the simplest way to rule out two writers.
- Self-contained publish (about 70 MB), so it runs on PCs without .NET installed.
- A portable zip first. An installer, code signing, and auto-update come later.
- Keep the browser version working, because it costs little and the tests and UI checks use it.
- Minimizing counts as "hidden" for the lock-on-hide setting.

## Decided: no DPAPI file encryption

The user chose not to seal `notes.json` with DPAPI. Sensitive notes use the existing per-note encryption, and disk-level protection is left to BitLocker. Background on the option that was considered:

- **Encrypt the whole notes file with Windows DPAPI?** Encrypted notes are already sealed. Unencrypted notes sit in `notes.json` as plain text, exactly as they did in browser storage. DPAPI (Windows' per-user data protection) could seal the whole file to the user's Windows account. Other accounts, or someone reading the disk offline without BitLocker, then couldn't read it.
  - It adds one official Microsoft package (`System.Security.Cryptography.ProtectedData`).
  - The catch: if the Windows profile's keys are lost (for example an admin resets the password, or the profile is rebuilt), the file can't be decrypted. Exported backups would be the only way back.

## Left to the builder

- WinForms vs WPF for the host shell (WinForms is the default plan, being the lightest).
- The exact app icon (generated from the existing favicon design).
- How window position is persisted, and the format of its small settings file.
- The internal C# structure (for example `NoteStore`, `MessageDispatcher`, `ExternalLinkPolicy`, `FileNameSanitizer` classes), as long as the tested behaviour above holds.
