# CyberPad Desktop App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship CyberPad as a portable Windows desktop app (`CyberPad.exe`) that hosts the existing web UI in WebView2, stores notes crash-safely on disk, and recovers from its own crashes.

**Architecture:**
- A .NET 8 WinForms host owns the window, single-instance lock, WebView2 lockdown, crash recovery and all disk I/O.
- The page talks to the host only through a validated, allow-listed message bridge.
- A new `js/platform.js` adapter hides the difference between browser (`localStorage`, downloads) and desktop (bridge), so the same web files serve both.

**Tech Stack:** .NET 8 (`net8.0-windows`, WinForms), `Microsoft.Web.WebView2`, xUnit; vanilla JS with `node:test` (Node 24).

**Spec:** `docs/superpowers/specs/2026-11-23-desktop-app-design.md`

## Global Constraints

- Windows only; .NET 8 SDK 8.0.428; WebView2 Evergreen Runtime; no Rust, no Electron, no Node dependencies.
- App dependency: `Microsoft.Web.WebView2` only. Test dependencies: `Microsoft.NET.Test.Sdk`, `xunit`, `xunit.runner.visualstudio` only (remove `coverlet.collector` that the `xunit` template adds).
- Pin with `packages.lock.json` (`<RestorePackagesWithLockFile>true</RestorePackagesWithLockFile>`); audit with `dotnet list package --vulnerable --include-transitive` (must report no vulnerable packages).
- Data folder `%LOCALAPPDATA%\CyberPad\`; files `notes.json`, `notes.json.bak`, `notes.json.tmp`; WebView2 user data in `%LOCALAPPDATA%\CyberPad\WebView2`.
- App origin `https://cyberpad.example/` via `SetVirtualHostNameToFolderMapping("cyberpad.example", wwwroot, Deny)`; start page `https://cyberpad.example/index.html`.
- Message size limit: 64 MB (`64 * 1024 * 1024` chars) for `save.data` and `exportFile.text`; `suggestedName` ≤ 120 chars.
- No network access, no telemetry; the CSP meta tag in `index.html` is unchanged.
- The host never logs note content: only message type and rejection reason.
- Encrypted notes never appear in plaintext on disk (the host stores the page's serialized state, in which encrypted notes are ciphertext only).
- The browser version keeps working and `npm test` stays green.
- Version `1.0.0`, defined once in `desktop/CyberPad.Desktop/CyberPad.Desktop.csproj` (`<Version>`).
- Work on branch `feature/desktop-app`, not `main`.

## Review Focus

1. **Notes file damaged outside the app** (empty, truncated, BOM-prefixed, or not JSON): the app should start from `notes.json.bak`, say so, and quarantine the bad file, never silently start empty. Pinned by `store.pickState` tests in Task 5.
2. **Data folder not writable / disk full:** saving should fail visibly ("Not saved" + reason) while notes stay in memory, and the old file must stay intact. Pinned by `Save_WhenDataDirIsUnusable_ThrowsStoreException` (Task 1) and `Save_StoreFailure_RepliesSaveFailedWithoutContent` (Task 3).
3. **Closing while the page is busy or broken** (pending encryption, flush handler throws): the host should still close within 5 s, and a throwing flush handler must still answer `flushed`. Pinned by the platform test `flush handler that throws still posts flushed` (Task 4).
4. **State larger than 64 MB:** the page should refuse to send it and show an error instead of hanging the bridge. Pinned by `saveState rejects oversize text without posting` (Task 4) and the dispatcher oversize test (Task 3).
5. **Non-ASCII text and CRLF line endings** must round-trip byte-exact through disk. Pinned by `Save_Load_RoundTripsUnicodeWithoutBom` (Task 1).

---

### Task 1: Solution scaffold, atomic file writing and `NoteStore`

**Files:**
- Create: `desktop/CyberPad.sln`, `desktop/CyberPad.Desktop/CyberPad.Desktop.csproj`, `desktop/CyberPad.Desktop/Storage/AtomicFile.cs`, `desktop/CyberPad.Desktop/Storage/NoteStore.cs`, `desktop/CyberPad.Desktop/Storage/StoreException.cs`
- Create: `desktop/CyberPad.Desktop.Tests/CyberPad.Desktop.Tests.csproj`, `desktop/CyberPad.Desktop.Tests/NoteStoreTests.cs`
- Modify: `.gitignore` (add `desktop/**/bin/`, `desktop/**/obj/`, `dist/`)

**Interfaces:**
- Produces:
  - `static class AtomicFile { static void Write(string path, string text); }`: UTF-8 without BOM. It writes `<path>.tmp-<8 random hex>` in the same directory with `FileOptions.WriteThrough` and `Flush(true)`, then `File.Move(tmp, path, overwrite: true)`. It deletes the temp file on failure and throws `StoreException`.
  - `sealed class StoreException : Exception` (message is a short user-facing reason, never content).
  - `sealed class NoteStore`:
    - `NoteStore(string dataDir)`
    - `string DataDir { get; }`
    - `(string? Main, string? Backup) Load()`
    - `void Save(string data)`
    - `IReadOnlyList<string> Quarantine(DateTimeOffset now)`
    - `const string MainFile = "notes.json", BackupFile = "notes.json.bak", TempFile = "notes.json.tmp"`.
    - Save:
      1. Create `DataDir` if missing.
      2. Write `notes.json.tmp` (UTF-8, no BOM, `WriteThrough`, `Flush(true)`).
      3. If `notes.json` exists, `File.Replace(tmp, main, bak)`; otherwise `File.Move(tmp, main)`.
      4. Wrap any `IOException` or `UnauthorizedAccessException` in `StoreException`.
    - Quarantine renames existing `notes.json` / `notes.json.bak` to `notes.unreadable-<yyyyMMddTHHmmssZ>.json` / `notes.unreadable-<…>.bak.json` and returns the new names.

- [ ] **Step 1: Create branch and projects**

Run:
```powershell
git switch -c feature/desktop-app
dotnet new sln -n CyberPad -o desktop
dotnet new winforms -n CyberPad.Desktop -o desktop/CyberPad.Desktop -f net8.0
dotnet new xunit -n CyberPad.Desktop.Tests -o desktop/CyberPad.Desktop.Tests -f net8.0
dotnet sln desktop/CyberPad.sln add desktop/CyberPad.Desktop desktop/CyberPad.Desktop.Tests
dotnet add desktop/CyberPad.Desktop.Tests reference desktop/CyberPad.Desktop
dotnet remove desktop/CyberPad.Desktop.Tests package coverlet.collector
```
Edit both `.csproj` files:
- set `<TargetFramework>net8.0-windows</TargetFramework>`, `<Nullable>enable</Nullable>`, `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>`, `<RestorePackagesWithLockFile>true</RestorePackagesWithLockFile>`
- in the app project, also `<Version>1.0.0</Version>`

Delete the template `Form1*` and `UnitTest1.cs`.

Expected: `dotnet build desktop/CyberPad.sln` succeeds (an empty `Program.Main` is fine for now).

- [ ] **Step 2: Write failing tests in `NoteStoreTests.cs`** (each test uses a fresh temp dir)

```csharp
[Fact] Save_FirstTime_CreatesMainWithoutBackup()        // Load() == ("a", null)
[Fact] Save_Twice_KeepsPreviousAsBackup()                // Save("a"); Save("b"); Load() == ("b", "a")
[Fact] Save_Load_RoundTripsUnicodeWithoutBom()           // "✓ 漢字 🔐 مرحبا\r\nline2" round-trips; File.ReadAllBytes(main)[0..3] != EF BB BF
[Fact] Save_WhenTempWriteFails_LeavesMainUntouched()     // Save("good"); Directory.CreateDirectory(Path.Combine(dir, NoteStore.TempFile)); Assert.Throws<StoreException>(() => store.Save("new")); Load().Main == "good"
[Fact] Save_WhenDataDirIsUnusable_ThrowsStoreException() // dataDir path is an existing *file*; Save throws StoreException
[Fact] Load_WhenNothingSaved_ReturnsNulls()              // (null, null), and creates no files
[Fact] Quarantine_RenamesInsteadOfDeleting()             // after Save twice, Quarantine(2026-11-23T10:00:00Z) returns 2 names; notes.json gone; notes.unreadable-20261123T100000Z.json contains "b"
[Fact] AtomicFile_Write_ReplacesExistingAndLeavesNoTemp() // write twice; content is second; no "*.tmp-*" files remain
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `dotnet test desktop/CyberPad.sln`
Expected: build errors / FAIL (`NoteStore` not defined).

- [ ] **Step 4: Implement `AtomicFile`, `StoreException`, `NoteStore` per the Interfaces block**

- [ ] **Step 5: Run tests to verify they pass**

Run: `dotnet test desktop/CyberPad.sln`
Expected: 8 passed.

- [ ] **Step 6: Commit**

```powershell
git add .gitignore desktop docs/superpowers
git commit -m "feat(desktop): scaffold host solution with atomic note storage"
```

---

### Task 2: Export file names and external link policy

**Files:**
- Create: `desktop/CyberPad.Desktop/Bridge/ExportKind.cs`, `desktop/CyberPad.Desktop/Bridge/FileNameSanitizer.cs`, `desktop/CyberPad.Desktop/Bridge/AppOrigin.cs`, `desktop/CyberPad.Desktop/Bridge/ExternalLinkPolicy.cs`
- Test: `desktop/CyberPad.Desktop.Tests/FileNameSanitizerTests.cs`, `desktop/CyberPad.Desktop.Tests/LinkPolicyTests.cs`

**Interfaces:**
- Produces:
  - `enum ExportKind { Note, Backup, EncryptedBackup, IocCsv, IocMd }`
  - `static class ExportKinds`:
    - `bool TryParse(string wire, out ExportKind kind)`: wire names `note`, `backup`, `encryptedBackup`, `iocCsv`, `iocMd`; exact case.
    - `string Extension(ExportKind k)`: `.md`, `.json`, `.json`, `.csv`, `.md`.
    - `string DialogFilter(ExportKind k)`: `"Markdown (*.md)|*.md"`, `"JSON backup (*.json)|*.json"`, `"CSV (*.csv)|*.csv"`.
  - `static class FileNameSanitizer { const int MaxLength = 120; static string Sanitize(string? suggested, ExportKind kind); }`. Rules, in order:
    1. Replace `Path.GetInvalidFileNameChars()` (which covers `\ / :`) with `-`.
    2. Collapse runs of `-`.
    3. Trim `.`, ` ` and `-` from both ends.
    4. If the result is empty, use `cyberpad-export`.
    5. If the result doesn't end with the kind's extension (case-insensitive), append it.
    6. If the part before the first `.` is a reserved device name (`CON PRN AUX NUL COM1-9 LPT1-9`, case-insensitive), prefix `_`.
    7. Truncate the base so the whole name is ≤ 120 chars.
  - `static class AppOrigin`:
    - `const string Host = "cyberpad.example"`
    - `static readonly Uri StartUri = new("https://cyberpad.example/index.html")`
    - `const string Origin = "https://cyberpad.example/"`
    - `static bool IsAppUri(string? uri)`: true only for absolute `https` URIs with host exactly `cyberpad.example`, default port.
  - `static class ExternalLinkPolicy { static bool TryGetOpenableUri(string? raw, out Uri? uri); }`:
    - Accepts only absolute URIs ≤ 2048 chars with no whitespace or control characters.
    - The scheme must be `http` or `https` with a non-empty host, or `mailto`.
    - Rejects everything else.

- [ ] **Step 1: Write failing tests**

```csharp
// FileNameSanitizerTests
[Theory]
[InlineData(@"..\..\x", ExportKind.Note, "x.md")]
[InlineData("CON", ExportKind.Backup, "_CON.json")]
[InlineData("con.txt", ExportKind.Note, "_con.txt.md")]
[InlineData("a/b:c", ExportKind.IocCsv, "a-b-c.csv")]
[InlineData("notes.txt", ExportKind.Note, "notes.txt.md")]
[InlineData("Notes.MD", ExportKind.Note, "Notes.MD")]
[InlineData("", ExportKind.Note, "cyberpad-export.md")]
[InlineData(null, ExportKind.EncryptedBackup, "cyberpad-export.json")]
[InlineData("cyberpad-backup-2026-11-23.encrypted.json", ExportKind.EncryptedBackup, "cyberpad-backup-2026-11-23.encrypted.json")]
Sanitize_ProducesSafeNames(string? input, ExportKind kind, string expected)
[Fact] Sanitize_TruncatesTo120WithExtension()   // new string('a', 200) → length 120, ends ".md"
[Fact] ExportKinds_TryParse_RejectsUnknownAndWrongCase() // "Note", "exe", "" → false; "iocMd" → IocMd

// LinkPolicyTests
[Theory]
[InlineData("https://nvd.nist.gov/vuln/detail/CVE-2024-3094", true)]
[InlineData("https://attack.mitre.org/techniques/T1059/001/", true)]
[InlineData("mailto:soc@example.com", true)]
[InlineData("file:///C:/Windows/system32/calc.exe", false)]
[InlineData("javascript:alert(1)", false)]
[InlineData("ms-settings:privacy", false)]
[InlineData(@"\\server\share\x", false)]
[InlineData("https://exa mple.com", false)]
[InlineData("/relative/path", false)]
[InlineData("http://", false)]
TryGetOpenableUri_AllowsOnlyWebAndMail(string raw, bool ok)
[Fact] TryGetOpenableUri_RejectsOverlong()    // "https://x.example/" + 2100 chars → false
[Theory] // AppOrigin
[InlineData("https://cyberpad.example/index.html", true)]
[InlineData("https://cyberpad.example.evil.com/", false)]
[InlineData("http://cyberpad.example/", false)]
[InlineData("https://cyberpad.example:8443/", false)]
[InlineData("about:blank", false)]
IsAppUri_MatchesOnlyTheAppOrigin(string uri, bool ok)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `dotnet test desktop/CyberPad.sln`
Expected: build errors (types not defined).

- [ ] **Step 3: Implement the four files per the Interfaces block**

- [ ] **Step 4: Run tests to verify they pass**

Run: `dotnet test desktop/CyberPad.sln`
Expected: all pass.

- [ ] **Step 5: Commit**

```powershell
git add desktop
git commit -m "feat(desktop): add export filename sanitizer and link policies"
```

---

### Task 3: Message dispatcher (the bridge's host side)

**Files:**
- Create: `desktop/CyberPad.Desktop/Bridge/IHostActions.cs`, `desktop/CyberPad.Desktop/Bridge/MessageDispatcher.cs`
- Test: `desktop/CyberPad.Desktop.Tests/MessageDispatcherTests.cs` (with a `FakeHostActions` in the test file)

**Interfaces:**
- Consumes: `StoreException` (Task 1), `ExportKind`, `ExportKinds.TryParse`, `FileNameSanitizer.Sanitize`, `AppOrigin.Origin` (Task 2).
- Produces:
  - `interface IHostActions`:
    - `string Version { get; }`
    - `string DataDir { get; }`
    - `Task<(string? Main, string? Backup)> LoadAsync()`
    - `Task SaveAsync(string data)`, which throws `StoreException`
    - `Task QuarantineAsync()`
    - `Task<string?> ExportAsync(ExportKind kind, string safeName, string text)`, which returns the chosen file name or `null` if cancelled, and throws `StoreException`
    - `void Flushed()`
  - `sealed class MessageDispatcher`:
    - `MessageDispatcher(IHostActions actions, Action<string> log)`
    - `const int MaxTextChars = 64 * 1024 * 1024`
    - `Task<string?> HandleAsync(string source, string json)`, which returns the reply JSON, or `null` when there is nothing to send.
    - Behaviour:
      1. Serialize calls with a `SemaphoreSlim(1)`.
      2. Reject (log, return `null`) when `source != AppOrigin.Origin`, when `json.Length > MaxTextChars + 65536`, or on invalid JSON (`JsonDocumentOptions { MaxDepth = 4 }`).
      3. The root must be an object with a string `type`.
      4. Every type except `flushed` needs `id` matching `^[A-Za-z0-9_-]{1,64}$`.
      5. The allowed fields per type are exact; extra fields reject:
         - `load {type,id}`
         - `save {type,id,data:string}`
         - `quarantine {type,id}`
         - `exportFile {type,id,kind:string,suggestedName:string,text:string}`
         - `flushed {type}`
      6. When `id` is valid but the message is rejected, reply `{"type":"rejected","id":…,"reason":…}`.
    - Replies (camelCase, `System.Text.Json`):
      - `{"type":"loaded","id","main","backup","version","dataDir"}`
      - `{"type":"saved","id"}` / `{"type":"saveFailed","id","reason"}`
      - `{"type":"quarantined","id"}`
      - `{"type":"exported","id","name"}` / `{"type":"exportCancelled","id"}` / `{"type":"exportFailed","id","reason"}`. `exportFailed` is an addition to the spec's table, for write errors.
    - Log lines are only `"<type|?>: <reason>"`. They never contain `data`, `text`, `suggestedName`, or the raw JSON.

- [ ] **Step 1: Write failing tests**

```csharp
const string Src = "https://cyberpad.example/";
[Fact] Load_RepliesWithFilesVersionAndDataDir()       // fake returns ("m","b"); reply has type "loaded", id echoed, main "m", backup "b", version "1.0.0", dataDir
[Fact] Save_CallsStoreAndRepliesSaved()               // fake.Saved == "x"; reply {"type":"saved","id":"r1"}
[Fact] Save_StoreFailure_RepliesSaveFailedWithoutContent() // fake throws StoreException("Disk is full."); reply type "saveFailed", reason "Disk is full."; log lines don't contain "SECRET-DATA"
[Fact] ExportFile_SanitizesNameAndForwardsKind()      // suggestedName "..\\..\\x" kind "iocCsv" → fake receives (IocCsv, "x.csv", text); reply {"type":"exported","id":"e1","name":"x.csv"}
[Fact] ExportFile_Cancelled_RepliesExportCancelled()
[Fact] Flushed_CallsActionAndRepliesNothing()         // returns null; fake.FlushedCalls == 1
[Theory]
[InlineData("https://evil.example/")]  [InlineData("https://cyberpad.example.evil.com/")]  [InlineData("")]
WrongOrigin_IsRejectedWithoutCallingActions(string source)   // returns null; no fake calls
[Theory]
[InlineData("""{"type":"delete","id":"a"}""")]                      // unknown type
[InlineData("""{"type":"save","id":"a","data":5}""")]               // non-string data
[InlineData("""{"type":"save","id":"a","data":"x","path":"C:\\x"}""")] // extra field
[InlineData("""{"type":"load"}""")]                                 // missing id
[InlineData("""{"type":"load","id":"../../x"}""")]                  // bad id
[InlineData("""{"type":"exportFile","id":"a","kind":"exe","suggestedName":"x","text":"t"}""")] // unknown kind
[InlineData("""[1,2]""")]  [InlineData("""not json""")]  [InlineData("""{"type":{"a":{"b":{"c":{"d":1}}}}}""")]
InvalidMessages_AreRejectedAndNoActionRuns(string json)    // no fake calls; reply is null or type "rejected"
[Fact] OversizeData_IsRejected()                      // data = new string('a', MaxTextChars + 1) → rejected, fake.Saved == null
[Fact] Messages_AreHandledOneAtATime()                // two concurrent SaveAsync calls on a fake that delays 50 ms: fake records max concurrency == 1
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `dotnet test desktop/CyberPad.sln`
Expected: build errors (`MessageDispatcher` not defined).

- [ ] **Step 3: Implement `IHostActions` and `MessageDispatcher` per the Interfaces block**

- [ ] **Step 4: Run tests to verify they pass**

Run: `dotnet test desktop/CyberPad.sln`
Expected: all pass.

- [ ] **Step 5: Commit**

```powershell
git add desktop
git commit -m "feat(desktop): add validated message dispatcher for the page bridge"
```

---

### Task 4: `js/platform.js` adapter

**Files:**
- Create: `js/platform.js`
- Test: `tests/platform.test.js`

**Interfaces:**
- Produces, in the UMD wrapper used by `js/core/*.js` and attached as `NP.platformFactory`:
  - `createPlatform(env, opts?) => Platform`, where `env` is `{ chrome?, localStorage?, document?, URL?, Blob?, crypto, setTimeout, clearTimeout }` and `opts = { timeoutMs = 15000, storageKey = 'cyberpad.v1', legacyKeys = ['neonpad.v1'] }`.
  - `class PlatformError extends Error`, with `reason: string`, where reason is one of `'quota' | 'too-large' | 'timeout' | 'host'`.
  - `Platform`:
    - `isDesktop: boolean`, true when `env.chrome?.webview?.postMessage` is a function.
    - `maxStateChars: number`: `64 * 1024 * 1024` on desktop, `Infinity` in the browser.
    - `loadState(): Promise<{ main: string|null, backup: string|null, legacyKey: string|null, storageOk: boolean, version: string|null, dataDir: string|null }>`
      - Browser: reads `storageKey`, then the legacy keys. `storageOk` is false if `localStorage` throws. `backup`, `version` and `dataDir` are null.
    - `saveState(text: string): Promise<void>`
      - Over `maxStateChars`: reject `PlatformError('too-large')` without posting.
      - Browser: a quota `DOMException` rejects `PlatformError('quota')`.
      - Desktop: `saveFailed` or `rejected` rejects `PlatformError('host')`, with the host reason as the message.
    - `removeLegacy(key: string): void`: browser only, a no-op on desktop.
    - `quarantine(raw: string|null): Promise<void>`
      - Browser: `localStorage.setItem(\`${storageKey}.unreadable-${Date.now()}\`, raw)`.
      - Desktop: the `quarantine` message.
    - `exportFile({ kind, suggestedName, text, mime }): Promise<{ saved: boolean, name: string|null }>`
      - Browser: today's blob-anchor download, then `{ saved: true, name: suggestedName }`.
      - Desktop: `exportFile`, with no timeout because it waits for the user. `exportCancelled` resolves `{ saved: false }`, and `exportFailed` rejects `PlatformError('host')`.
    - `onFlushRequest(fn: () => Promise<void>): void`: on the desktop, on `{type:'flush'}`, await `fn()` and post `{type:'flushed'}` in `finally`.
  - Request ids are 16 hex chars from `crypto.getRandomValues`. Replies with unknown ids are ignored, and every non-export request times out after `timeoutMs` with `PlatformError('timeout')`.

- [ ] **Step 1: Write failing tests** (use a `fakeWebview()` that records `postMessage` calls and lets the test `reply(obj)` via the registered `message` listener, which passes `{ data: obj }`; a `fakeStorage()` Map-backed localStorage)

```js
test('detects desktop only when chrome.webview.postMessage exists', ...)       // isDesktop true/false; maxStateChars 64 MiB vs Infinity
test('desktop loadState sends load and resolves with the reply', ...)           // posted {type:'load', id}; reply {type:'loaded', id, main:'m', backup:'b', version:'1.0.0', dataDir:'C:\\x'} → resolved fields equal
test('desktop saveState resolves on saved and rejects on saveFailed', ...)      // PlatformError reason 'host', message 'Disk is full.'
test('replies with unknown ids are ignored and requests time out', ...)        // timeoutMs: 20; reply with other id; rejects reason 'timeout'
test('saveState rejects oversize text without posting', ...)                   // text length maxStateChars + 1 → reason 'too-large'; fake.posted.length === 0
test('exportFile resolves saved:false on exportCancelled and never times out', ...) // timeoutMs: 20; reply after 60 ms
test('flush handler that throws still posts flushed', ...)                      // onFlushRequest(async () => { throw new Error('x') }); dispatch {type:'flush'} → posted includes {type:'flushed'}
test('browser loadState adopts legacy key and reports storage failures', ...)  // only 'neonpad.v1' set → main equals it, legacyKey 'neonpad.v1'; throwing storage → storageOk false
test('browser saveState maps quota errors', ...)                                // setItem throws DOMException name 'QuotaExceededError' → reason 'quota'
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: `tests/platform.test.js` FAILS (cannot find module `../js/platform.js`); the 81 existing tests pass.

- [ ] **Step 3: Implement `js/platform.js` per the Interfaces block**

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: 90 tests, 0 failures.

- [ ] **Step 5: Commit**

```powershell
git add js/platform.js tests/platform.test.js
git commit -m "feat: add platform adapter for browser and desktop storage"
```

---

### Task 5: Wire `app.js` to the platform adapter

**Files:**
- Modify: `js/core/store.js` (add `pickState`), `js/app.js` (`load`, `persistNow`, `schedulePersist`, `download` call sites, `bootSequence`, `wireEvents`, `commandList`, `WELCOME` handling), `index.html` (add `<script src="js/platform.js"></script>` before `js/app.js`)
- Test: `tests/store.test.js`

**Interfaces:**
- Consumes: `createPlatform`, `PlatformError` and the `Platform` methods (Task 4).
- Produces:
  - `store.pickState(main: string|null, backup: string|null, now?) => { state, source: 'main'|'backup'|'none', unreadable: boolean }`.
    - A copy is *usable* when it is a string, `JSON.parse` gives an object (not `null`, not an array), and `parseStored` returns `error: null`.
    - `parseStored` alone is not enough: `parseStored('')` and `parseStored('null')` return an empty state with no error, and that must count as damaged, not as "no notes".
    - Use `main` if usable, otherwise `backup` if usable, otherwise an empty state with source `'none'`.
    - `unreadable` is true when any non-null input was not usable.
  - In `app.js`:
    - `const platform = NP.platformFactory.createPlatform(window)`
    - `async function load()`
    - `function persistNow(): Promise<boolean>`: coalescing, with at most one save in flight. A change during a save sets `S.saveDirty` and triggers one more save after it.

- [ ] **Step 1: Write failing `pickState` tests in `tests/store.test.js`**

```js
test('pickState prefers a valid main copy', ...)            // source 'main', unreadable false
test('pickState falls back to backup when main is damaged', ...) // main strings '', '   ', '{"v":1,"notes":[', '\uFEFFgarbage', 'null', '[]' each → source 'backup', unreadable true
test('pickState uses backup without a warning when main is missing', ...) // (null, valid) → source 'backup', unreadable false
test('pickState reports none when both are unusable', ...)  // ('x','y') → source 'none', unreadable true, state.notes []; (null, null) → source 'none', unreadable false
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL (`store.pickState is not a function`).

- [ ] **Step 3: Implement `pickState` in `store.js` and export it**

- [ ] **Step 4: Rewire `app.js`**
- `load()`:
  1. `await platform.loadState()`, then `store.pickState(main, backup)`.
  2. If the source is `backup`, toast "Your last save could not be read, so the previous save was restored."
  3. If `unreadable` is true, `await platform.quarantine(main)` and toast that the unreadable copy was kept (desktop: "in the data folder", browser: "in browser storage").
  4. Keep the legacy-key flow via `platform.removeLegacy` after the first successful save.
  5. Store `version` and `dataDir` in `S.host`.
- `persistNow()`:
  1. `await platform.saveState(serialized)`. On `quota`, keep today's history-trim-and-retry.
  2. On `too-large`, set state `error` "Not saved" and toast "Your notes are over 64 MB, so they can't be saved. Export a backup, then remove large notes."
  3. On `host` or `timeout`, set state `error` "Save failed" and show a toast with the reason.
  4. Track `S.lastStateChars` for the boot screen.
- Replace each `download(...)` call with `platform.exportFile`:
  - note → `kind 'note'`
  - plain backup → `'backup'`
  - encrypted backup → `'encryptedBackup'`
  - IOC CSV → `'iocCsv'`
  - Toasts say "Saved <name>." when `saved`, and nothing when cancelled.
- Desktop only (`platform.isDesktop`):
  - Register `platform.onFlushRequest(async () => { await flushSeals(); await persistNow(); })`.
  - Skip the `beforeunload` and `storage` listeners.
  - On first run, append the welcome line: "Moving from the browser version? Export a backup there (Command palette → Export backup), then import it here."
  - Add palette command `C('View', 'About CyberPad', showAbout)`, a dialog showing "CyberPad <version>" and "Notes are saved in <dataDir>".
  - Replace browser-storage wording in toasts with the data folder.

- [ ] **Step 5: Run tests and check the browser version**

Run: `npm test`
Expected: 94 tests pass.

Then start the `neonpad` preview server and open `http://localhost:8787/`. Expected: notes load, typing saves (status "Saved"), "Export note as Markdown" downloads, no console errors.

- [ ] **Step 6: Commit**

```powershell
git add js/app.js js/core/store.js index.html tests/store.test.js
git commit -m "feat: route storage and exports through the platform adapter"
```

---

### Task 6: Host window, WebView2 lockdown and lifecycle

**Files:**
- Create: `desktop/CyberPad.Desktop/Program.cs`, `desktop/CyberPad.Desktop/MainForm.cs`, `desktop/CyberPad.Desktop/HostActions.cs`, `desktop/CyberPad.Desktop/SingleInstance.cs`, `desktop/CyberPad.Desktop/WindowPlacement.cs`, `desktop/CyberPad.Desktop/app.ico`
- Modify: `desktop/CyberPad.Desktop/CyberPad.Desktop.csproj` (add the WebView2 package, icon, and wwwroot content links)
- Test: `desktop/CyberPad.Desktop.Tests/WindowPlacementTests.cs`

**Interfaces:**
- Consumes: `NoteStore`, `AtomicFile`, `StoreException` (Task 1); `AppOrigin`, `ExternalLinkPolicy`, `FileNameSanitizer`, `ExportKinds` (Task 2); `IHostActions`, `MessageDispatcher` (Task 3); the page's `flush` → `flushed` handshake (Tasks 4 and 5).
- Produces:
  - `static class WindowPlacement`:
    - `record Placement(int X, int Y, int Width, int Height, bool Maximized)`
    - `static Placement? Read(string path)`: returns null on a missing file or invalid JSON
    - `static void Write(string path, Placement p)`, via `AtomicFile`
    - `static Placement Fit(Placement p, IReadOnlyList<Rectangle> screens, Size min)`: if the rectangle doesn't intersect any working area by at least 100×100 px, it is centred on the first screen; the size is clamped to at least `min`.
  - `sealed class SingleInstance : IDisposable`:
    - `static SingleInstance? TryAcquire(string userSid)`, using mutex `Local\CyberPad-<sid>` and event `Local\CyberPad-<sid>-activate`
    - `static void SignalExisting(string userSid)`
    - `event Action? ActivationRequested`
  - `HostActions : IHostActions`, implemented over `NoteStore`. `ExportAsync` shows a `SaveFileDialog` on the UI thread:
    - `Filter = ExportKinds.DialogFilter(kind)`
    - `FileName = safeName`
    - `OverwritePrompt = true`
    - `InitialDirectory = Documents`

    It then calls `AtomicFile.Write` on a worker thread.

- [ ] **Step 1: Write failing `WindowPlacementTests`**

```csharp
[Fact] Read_ReturnsNullForMissingOrCorruptFile()
[Fact] Write_Read_RoundTrips()
[Fact] Fit_KeepsVisiblePlacement()
[Fact] Fit_RecentresWhenOffAllScreens()   // X = -5000 → centred on screens[0]
[Fact] Fit_EnforcesMinimumSize()          // 10×10 → min 900×600
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `dotnet test desktop/CyberPad.sln`
Expected: build errors (`WindowPlacement` not defined).

- [ ] **Step 3: Implement `WindowPlacement`, `SingleInstance`, `HostActions`**

- [ ] **Step 4: Implement `Program.Main` and `MainForm`**
- **Startup:**
  1. `[STAThread]`.
  2. Single instance: if not acquired, `SignalExisting` and exit 0.
  3. Check `CoreWebView2Environment.GetAvailableBrowserVersionString()`. On `WebView2RuntimeNotFoundException`, show a `MessageBox`: "CyberPad needs the Microsoft Edge WebView2 Runtime. Install it from https://developer.microsoft.com/microsoft-edge/webview2/ and start CyberPad again." Then exit 1.
- **Package and project setup:**
  - Add the package: `dotnet add desktop/CyberPad.Desktop package Microsoft.Web.WebView2` (the latest stable version; it is recorded in `packages.lock.json`).
  - Add wwwroot content with `CopyToOutputDirectory` / `CopyToPublishDirectory` `PreserveNewest` and `ExcludeFromSingleFile` `true`:
    - `..\..\index.html` → `wwwroot\index.html`
    - `..\..\css\**\*` → `wwwroot\css\%(RecursiveDir)%(Filename)%(Extension)`
    - `..\..\js\**\*` → `wwwroot\js\%(RecursiveDir)%(Filename)%(Extension)`
  - `app.ico`: 16/32/48/256 px, drawn from the favicon design (dark square, magenta "C", cyan bars). Set `<ApplicationIcon>`.
- **`MainForm`:**
  - **Window:**
    - Title "CyberPad", minimum size 900×600.
    - Apply `WindowPlacement.Fit(Read(...))` from `%LOCALAPPDATA%\CyberPad\window.json`, and write the placement on close.
  - **WebView2 environment and settings:**
    - `CoreWebView2Environment.CreateAsync(null, <data>\WebView2)`.
    - `AreDevToolsEnabled` is false in Release (`#if DEBUG` true).
    - `AreBrowserAcceleratorKeysEnabled = false`, `IsStatusBarEnabled = false`, `IsPasswordAutosaveEnabled = false`, `IsGeneralAutofillEnabled = false`, `IsPinchZoomEnabled = false`.
    - `SetVirtualHostNameToFolderMapping(AppOrigin.Host, wwwroot, CoreWebView2HostResourceAccessKind.Deny)`.
  - **Events:**
    - `ContextMenuRequested`: keep only items named `cut`, `copy`, `paste`, `pasteAndMatchStyle`, `selectAll`, `undo`, `redo`, or `spellCheck*`.
    - `NavigationStarting`: cancel unless `AppOrigin.IsAppUri(e.Uri)`.
    - `NewWindowRequested`: set `e.Handled = true` (cancels the new window). If `ExternalLinkPolicy.TryGetOpenableUri(e.Uri, out var u)`, call `Process.Start(new ProcessStartInfo(u.AbsoluteUri) { UseShellExecute = true })`.
    - `DownloadStarting`: cancel.
    - `PermissionRequested`: `State = Deny`.
    - `WebMessageReceived`: `reply = await dispatcher.HandleAsync(e.Source, e.WebMessageAsJson)`; if the reply isn't null, `PostWebMessageAsJson(reply)`.
  - **Crash recovery:** on `ProcessFailed`:
    - `RenderProcessExited` or `RenderProcessUnresponsive`: `Reload()`. After the 3rd within 60 s, show a `MessageBox` with the data folder path and stop reloading.
    - `BrowserProcessExited`: dispose and recreate the WebView2 control and re-run initialisation.
  - **Closing:** on the first `FormClosing`, set `e.Cancel = true`, post `{"type":"flush"}`, and start a 5 s timer that forces the close. `HostActions.Flushed()` (or the timer) sets `_closeConfirmed` and calls `BeginInvoke(Close)`.
  - **Minimize:** `Resize` while `WindowState == Minimized` sets `webView.Visible = false`; restoring sets it back to true. This fires `visibilitychange` in the page.
  - **Second launch:** `SingleInstance.ActivationRequested` → `BeginInvoke`: restore if minimized, then `Activate()`.

- [ ] **Step 5: Run tests and the app**

Run: `dotnet test desktop/CyberPad.sln`
Expected: all pass.

Then run `dotnet run --project desktop/CyberPad.Desktop -c Release` and check these manually:
- The window opens with the welcome note and the "Moving from the browser version?" line. Typing shows "Saved", and `%LOCALAPPDATA%\CyberPad\notes.json` exists.
- Closing and reopening keeps the text and the window position.
- Ending the "CyberPad" WebView2 renderer process in Task Manager reloads the window with notes intact.
- Killing `CyberPad.exe` mid-typing loses at most the last ~half second of typing, and the next start loads fine.
- Encrypting a note and then minimizing locks it.
- Clicking a CVE link in the preview opens NVD in the default browser.
- A second `dotnet run` (or exe launch) focuses the first window and exits.
- "Export note as Markdown" opens the Save dialog and writes the file.
- F5, Ctrl+R, Ctrl+P and right-click → Inspect do nothing.

- [ ] **Step 6: Commit**

```powershell
git add desktop
git commit -m "feat(desktop): host window with locked-down WebView2, crash recovery and safe close"
```

---

### Task 7: Build script, packaging and docs

**Files:**
- Create: `desktop/build.ps1`
- Modify: `README.md` (new "Desktop app" section; "Where your data lives" covers both versions; Development section lists the desktop commands and the manual checks from Task 6, Step 5), `.claude/launch.json` (rename the configuration `neonpad` → `cyberpad-web`)

**Interfaces:**
- Consumes: everything above.
- Produces: `dist/CyberPad-win-x64-1.0.0.zip`, containing `CyberPad.exe` and `wwwroot/`.

- [ ] **Step 1: Write `desktop/build.ps1`.** It uses `$ErrorActionPreference = 'Stop'`, stops on the first failing step, and runs in order:
  1. `npm test`
  2. `dotnet test desktop/CyberPad.sln -c Release`
  3. `dotnet list desktop/CyberPad.sln package --vulnerable --include-transitive`. Fail if the output contains "has the following vulnerable packages".
  4. `dotnet publish desktop/CyberPad.Desktop -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o dist/CyberPad`
  5. Read the version from the `.csproj` `<Version>` and `Compress-Archive dist/CyberPad/* dist/CyberPad-win-x64-<version>.zip -Force`.

- [ ] **Step 2: Run it**

Run: `powershell -ExecutionPolicy Bypass -File desktop/build.ps1`
Expected:
- all tests pass
- no vulnerable packages
- `dist/CyberPad-win-x64-1.0.0.zip` exists
- unzipped to a fresh folder, `CyberPad.exe` starts and shows the notes

- [ ] **Step 3: Update the README**
- **Desktop app section:**
  - Download or build the zip, unzip, run `CyberPad.exe`.
  - SmartScreen "More info → Run anyway" for unsigned builds.
  - The data folder `%LOCALAPPDATA%\CyberPad`, with `notes.json`, `.bak` and quarantined files.
  - Moving notes from the browser version.
  - Unencrypted notes are plain text in `notes.json`; encrypt sensitive ones.
- **Security notes:** the host bridge allow-list, the navigation/permission/download lockdown, and that external links open in the default browser (http, https and mailto only).

- [ ] **Step 4: Commit**

```powershell
git add desktop/build.ps1 README.md .claude/launch.json
git commit -m "build(desktop): add build and packaging script, document the desktop app"
```
