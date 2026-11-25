# Windows installer: design and build steps

Date: 2026-11-25. Branch: `feature/ux-ui`. Status: the user asked for an installer on 2026-11-25 and chose: the user picks the folder the program is installed into; the installer is our own code, not a third-party tool; it installs for the current user only; it adds a Start menu shortcut, an uninstall entry and an "Open with" registration. Details marked *(my call)* were not discussed.

Read `docs/ux-handoff.md` first. **Never launch `CyberPad.exe`, and never run the installer or uninstaller on the developer's machine**: they change the user's Start menu and registry. The user runs them.

## Why

Today the release is a zip: unzip it and run `CyberPad.exe`. The user wants what people expect from a Windows program: run a setup file, choose where it goes, and have it installed properly, with a way to remove it.

## Goals

- `CyberPad-Setup-<version>.exe`: running it shows a setup window, not the app.
- The user chooses the install folder; a sensible default is filled in.
- After installing: CyberPad is in the Start menu, is listed under Settings → Apps → Installed apps with a working Uninstall, and appears in Explorer's "Open with" list for `.md`, `.txt` and `.cpnote`.
- Running a newer setup over an existing install upgrades it in place.
- Uninstalling removes what setup added and nothing else. Notes are kept unless the user explicitly asks to delete them.
- No administrator rights, no network access, no third-party installer tool.

## Non-goals

- Installing for all users, or into Program Files.
- A desktop shortcut, auto-start, or auto-update.
- Making CyberPad the default app for any file type.
- Code signing. The setup file is unsigned, like the app, so SmartScreen warns on first run.
- Moving where notes are stored. They stay in `%LOCALAPPDATA%\CyberPad`.
- Silent or command-line installation.

## Anti-goals

- Setup or uninstall deletes a file it did not install. In particular, uninstall never deletes a folder recursively because a path said so.
- The install folder is, contains, or is inside the notes folder.
- A crafted payload or manifest makes setup or uninstall write or delete outside the install folder.
- Anything runs through a command shell, or needs administrator rights.
- The app itself (the page, the host bridge) gains any ability to install, uninstall or write to the registry.

## Design

### What is shipped

`desktop/build.ps1` produces, next to today's portable zip:

- `dist/CyberPad-Setup-<version>.exe`: the installer. It carries the portable build (the same files as the zip) and the uninstaller inside itself.

The portable zip stays: unzip and run, nothing installed, no registry changes.

### How it is built *(my call)*

- Two small Windows programs, **Setup** and **Uninstall**, written in C# against the .NET Framework that is part of Windows 10 and 11 (target `net471`). They need no runtime bundled, so the uninstaller is about 100 KB and the installer is about the size of the zip.
- Their logic lives in the source files of `CyberPad.Install`. The library's source files are compiled into each program, so no separate DLL is loaded at run time (a DLL placed beside the setup file could otherwise be loaded in its place). The `CyberPad.Install` project itself is built for `net471` and `net8.0-windows` so the existing xUnit project can test the same code.
- Both programs refuse to run with administrator rights (an elevated token), and only one instance of setup or uninstall runs at a time (a named mutex per Windows session).
- A residual that a .NET Framework program cannot close: a `<exe>.config` file placed beside the exe is read before `Main` runs. The README tells users to run the setup file from a folder that holds only their own files.
- No new package. The build uses the .NET Framework 4.7.1 developer pack that is installed with Visual Studio. The README says so under Development.
- The main app, `CyberPad.exe`, is not changed and does not reference any of this.

### The setup window

```
CyberPad Setup                                              [x]
------------------------------------------------------------
Install CyberPad 1.0.0

CyberPad is installed for your Windows account only.
Your notes are stored separately and are not affected.

Install in:
[ C:\Users\you\AppData\Local\Programs\CyberPad      ] [Browse…]
This folder will be created.

[x] Start CyberPad when setup finishes

                                        [ Install ]  [ Cancel ]
```

- Default folder: `%LOCALAPPDATA%\Programs\CyberPad`. If CyberPad is already installed (found through its uninstall entry), the field shows that folder and the heading reads `Update CyberPad to <version>`; the button reads `Update`.
- Setup never installs a version lower than the installed one: the heading stays, the button (which reads `Update`) is disabled, and the status line reads `A newer version of CyberPad (<installed>) is already installed.` An equal version reinstalls as an update.
- The line under the field tells the user what will happen: `This folder will be created.`, `CyberPad will be installed in this folder.`, `CyberPad is already installed here and will be updated.`, or the reason the folder cannot be used.
- While installing, the controls are disabled and a progress bar shows files copied. Closing the window during the copy is refused with `Setup is still copying files.`
- On success: `CyberPad is installed.` with a `Finish` button; CyberPad starts if the box is ticked.
- On failure: what happened and what to do, in one sentence, and anything already copied in this run is removed again.

### Choosing the folder

The path the user types or picks is untrusted input. Setup resolves it to a full path and accepts it only if all of these hold:

| Rule | Message when it fails |
|---|---|
| It is an absolute path on a local fixed drive (not a network path, not removable, no `\\?\` or device paths). | `Choose a folder on a local drive.` |
| It is inside the user's own profile folder (for example `C:\Users\you\…`). Folders elsewhere, such as `C:\Tools` or another drive, can usually be changed by other accounts on the PC, who could then replace the program. | `Choose a folder inside your own user folder.` |
| It is not the Startup folder or the temp folder, or inside either. | `Choose a folder of its own for CyberPad, not a shared folder.` |
| It is at most 180 characters and contains no control characters. | `That path is too long or contains characters that cannot be used.` |
| It is not a drive root, and not the user's profile, Desktop, Documents or Downloads folder itself. | `Choose a folder of its own for CyberPad, not a shared folder.` |
| It is not the notes folder (`%LOCALAPPDATA%\CyberPad`), inside it, or a parent of it. | `That folder holds your notes. Choose a different one.` |
| It is not inside the Windows folder or Program Files. | `That folder needs administrator rights. Choose a folder inside your own user folder.` |
| No part of the path below the drive is a link or junction. | `That folder is a link to another location. Choose a real folder.` |
| The folder does not exist, or is empty, or is an existing CyberPad install (it holds a valid install manifest). | *(see below)* |
| Setup can create a file there. | `Setup cannot write to that folder.` |

If the chosen folder exists, is not empty and is not a CyberPad install, setup uses a `CyberPad` subfolder inside it and shows that path in the field, so the user sees exactly where the files go. If that subfolder also fails the rules, the reason is shown.

### What installing does, in order

1. Checks that CyberPad is not running from the target folder (it tries to open the existing `CyberPad.exe` for writing). If it is: `Close CyberPad, then choose Install again.` (`Update` on an update). Setup never closes it.
2. Reads the old install manifest if this is an update, and remembers the old file list.
3. Unpacks the payload into the folder. Every entry name is checked: relative, no `..`, no drive or root, no reserved device names, and the resolved path must stay inside the install folder. The entry count and total size are capped (2,000 files, 1 GB). A payload that breaks a rule stops the install.
4. Writes `Uninstall.exe` and the install manifest: a text file listing the version and every file setup wrote, one relative path per line.
5. Deletes files listed in the old manifest that are not in the new one.
6. Creates the Start menu shortcut: `%APPDATA%\Microsoft\Windows\Start Menu\Programs\CyberPad.lnk`.
7. Writes the registry entries, all under the current user:
   - `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\CyberPad`: name, version, publisher `CyberPad`, install location, icon, estimated size, the uninstall command (`"<folder>\Uninstall.exe"`), and "no modify / no repair".
   - `HKCU\Software\Classes\Applications\CyberPad.exe`: the open command (`"<folder>\CyberPad.exe" "%1"`), a friendly name, and the supported types `.md`, `.txt`, `.cpnote`.
8. Tells Explorer that associations changed.

If a step fails, the steps already done in this run are undone in reverse order, as far as possible, and the user is told.

### Uninstalling

Started from Settings → Apps, or by running `Uninstall.exe`.

```
Uninstall CyberPad                                          [x]
------------------------------------------------------------
Remove CyberPad from this computer?

Your notes are kept. They are in:
C:\Users\you\AppData\Local\CyberPad

[ ] Also delete my notes and settings. This cannot be undone.

                                      [ Uninstall ]  [ Cancel ]
```

- The install folder comes from the uninstall registry entry and must contain a valid manifest; a path given on the command line is never used.
- If CyberPad is running: `Close CyberPad, then choose Uninstall again.`
- Because a program cannot delete itself while it runs, `Uninstall.exe` copies itself to the user's temp folder and continues from there. That copy (about 100 KB) is left in the temp folder. The next uninstall removes older copies. *(my call)*
- It removes: every file named in the manifest (each checked to be inside the install folder), the manifest, `Uninstall.exe`, folders that are now empty, the Start menu shortcut if it still points at this install, and the two registry keys. Files in the install folder that setup did not write are left alone, and then the folder stays too.
- If a file cannot be deleted (for example because it is in use), the registry keys are still removed and the manifest is rewritten to list exactly the files that are left.
- If the install's folder no longer passes the folder rules, or its manifest is missing or damaged, no file is deleted at all: only the entry (and the shortcut, if it points at that folder) is removed, and the user is told the files were left.
- If `HKCU\Software\Classes\Applications\CyberPad.exe` already existed before the first install (Windows creates it when the portable `CyberPad.exe` is chosen through "Open with → Choose another app"), setup records its open command in the uninstall entry, and uninstall puts that command back instead of deleting the key, as long as the key still runs this install's command.
- If the box is ticked, a second question follows: `Delete all CyberPad notes and settings in <folder>? This cannot be undone.` with `Delete notes` and `Keep notes`. Only then is `%LOCALAPPDATA%\CyberPad` removed. That path is fixed in the program, never read from input, and is checked not to be a link.
- At the end: `CyberPad was removed.` or `CyberPad was removed. Some files could not be deleted: <folder>`.

### Not changing

- The app's start-up, single-instance behaviour, data folder and bridge.
- The app still makes no registry changes itself. Only setup and uninstall do.

## Build steps

**Step 1: the logic library and its tests.** New project `desktop/CyberPad.Install` (`net471;net8.0-windows`, no packages), added to the solution and referenced by the test project. It contains, each behind an interface where it touches the system so the tests use fakes or temp folders:

- `InstallPathPolicy`: the folder rules and messages above, and the subfolder rule.
- `PayloadExtractor`: safe unpacking with the entry checks and caps.
- `InstallManifest`: write, read and validate (strict: version line, then relative paths; anything else is invalid; at most 2,000 lines and 256 KB).
- `Installer` and `Uninstaller`: the ordered steps with undo, against `IRegistry`, `IShortcuts`, `IFileSystemProbe` and a progress callback.
- Real implementations of the registry writer (HKCU only, fixed key paths), the shortcut writer (COM `IShellLink`, no shell commands) and the association notifier.
- Command-line quoting for the uninstall and open commands, with tests for paths containing spaces, quotes, `%`, `&`, `^` and trailing backslashes.

Tests: every folder rule, with hostile inputs (`..`, UNC, device paths, trailing dots and spaces, reserved names, alternate data stream syntax `a:b`, 8.3 names, mixed slashes, a junction, the notes folder and its parents and children, different letter case); payload entries that try to escape; an oversized payload; a manifest with `..`, absolute paths, duplicates, too many lines or NUL bytes; install into an empty temp folder then uninstall leaves the folder gone; a stray user file in the folder survives uninstall; update removes files the new version no longer has; a failure half-way undoes what was done; registry and shortcut calls checked through fakes. No test writes to the real registry or Start menu.

**Step 2: the two programs and the build.** New projects `desktop/CyberPad.Setup` and `desktop/CyberPad.Uninstall` (`net471`, WinForms, the app icon, a manifest declaring `asInvoker` and DPI awareness). `desktop/build.ps1` gains steps after the zip: build the uninstaller, build setup with the zip and the uninstaller embedded, check the output exists and is under 150 MB, and write `dist/CyberPad-Setup-<version>.exe`. The .NET tests keep running in the build, now including the library's.

**Step 3: documents.** README: a "Get it" section offering the installer first and the portable zip second; what setup changes on the PC (the folder, the shortcut, the two registry keys) and that uninstall removes exactly those; SmartScreen; the build prerequisite; that the portable zip still installs nothing; the "Open with" paragraph updated; security notes for the installer (per user, no admin, no network, no shell, path rules, manifest-only deletion); manual checks. `docs/ux-handoff.md`: the new projects, and the rule that nobody but the user runs setup or uninstall.

**Manual checks for the user** (in the README):

- Run the setup file: the setup window appears, not the app.
- Install to the default folder: CyberPad starts, is in the Start menu and under Installed apps, and appears under Open with for a `.md` file.
- Choose your Documents folder: setup refuses. Choose a folder that already has files: setup offers a `CyberPad` subfolder.
- Run the setup file again: it offers to update the existing install.
- Uninstall from Settings: the program, shortcut and entries are gone, and your notes are still in `%LOCALAPPDATA%\CyberPad`.

## Verification

`dotnet test desktop/CyberPad.sln` (then `git checkout -- "desktop/**/packages.lock.json"`); `npm test`; `desktop/build.ps1` produces both the zip and the setup file; no new package in any lock file; `CyberPad.Desktop` has no reference to the install projects; no `cmd`, `powershell` or `ShellExecute` use in the install code apart from starting `CyberPad.exe` and the temp copy of `Uninstall.exe` directly by full path.

### Messages added during review

- A path with `..`: `Type the full path of the folder, without "..".`
- A `%` in the profile folder's name: `Your user folder's name contains %, which Windows would misread. CyberPad cannot be installed for this account.`
- The folder changed since it was chosen: `That folder changed since you chose it. Check the folder and choose Install again.`
- Installed but clean-up incomplete: `CyberPad was installed, but setup could not finish cleaning up.`
- Setup or uninstall already running: `CyberPad setup or uninstall is already running.`
- Setup refused as administrator: `Run setup without administrator rights. CyberPad is installed for your own account. If User Account Control is turned off, sign in with a standard account.`
- Uninstall refused as administrator: `Run uninstall without administrator rights. If User Account Control is turned off, sign in with the account that installed CyberPad.`
- Removed but shortcut or entry left: `CyberPad was removed, but its Start menu shortcut or its entry under Installed apps could not be deleted.`
- File list missing or damaged: `CyberPad's entry was removed. The files in <folder> were left because setup's file list is missing or damaged.`
- Install folder could not be checked: `CyberPad's entry was removed. No files were deleted because the install folder could not be checked.`
