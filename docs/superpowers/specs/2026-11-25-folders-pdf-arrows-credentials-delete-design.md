# Folders, PDF export, arrows, credentials note and easier delete: design

Date: 2026-11-25. Branch: `feature/ux-ui`. Status: the user chose the direction of each feature on 2026-11-25 and asked for it to be built; details marked *(my call)* were not discussed.

Read `docs/ux-handoff.md` first. Its rules apply to everything here: strict CSP, no `innerHTML`, no dependencies, accessibility, never launch `CyberPad.exe`.

## Why

The user's to-do list for CyberPad before the UX branch is merged:

1. Files in folders
2. `.md` to `.pdf`
3. `->` becomes a real arrow
4. A password-encrypted template
5. Deleting files

They also asked for any other really useful feature. One was added: **undo after deleting a note**, because feature 5 makes deleting a one-click action.

## Goals

- Notes can be grouped in folders in the sidebar.
- A note can be saved as a PDF that looks like the preview, on paper colours.
- Typing `->` in prose gives `→`, without ever changing code.
- Credentials can be written into a note that is encrypted before it is ever stored.
- A note can be deleted from the sidebar directly, and a mistaken delete can be undone.

## Non-goals

- Browsing a folder on disk, or nested folders.
- Deleting a linked file on disk. CyberPad still never deletes your files.
- A password generator (the user chose the option without it).
- Selecting and deleting several notes at once.
- A host-side "save as PDF" dialog. That would need a new host message; this design uses the print dialog instead.

## Anti-goals

The work has failed if any of these happen:

- The CSP changes, an `innerHTML` appears, a dependency is added, or the host bridge changes in any way.
- A credentials note is written to storage in plain text, even for a moment.
- Text inside a code block or inline code is changed by the arrow feature.
- An existing `notes.json` or backup fails to load, or loses data, because of the new fields.
- Something in the sidebar can be done with the mouse but not with the keyboard.

## Constraints

- Stored data and imports are validated field by field: type, then range, then allow-list. Bad values are dropped, not repaired.
- `SCHEMA` stays 1. New fields are optional on read, so older data loads unchanged.
- Only existing colour tokens on screen. Print has its own paper colours.
- Existing user-facing strings may be matched by tests. Grep `tests/` and `desktop/CyberPad.Desktop.Tests/` before changing one.

## Approaches

| Feature | Options considered | Chosen |
|---|---|---|
| Folders | Folders for notes; open a disk folder (desktop only, wider bridge); both | **Folders for notes** (user) |
| Arrow | Replace as you type; show only in the preview | **As you type** (user) |
| Credentials | New encrypted note; plain template; encrypted note plus password generator | **New encrypted note** (user) |
| Deleting | Delete from the sidebar; also delete the linked file on disk; multi-select | **Delete from the sidebar** (user) |
| PDF | Print dialog with a print stylesheet; a new host message that writes a PDF | **Print dialog** *(my call: no bridge change, works in browser and desktop)* |

## Design

### 1. Folders

**Model.** A note gains `folder`: a string, `''` when it is in no folder. There is no separate list of folders: a folder exists while at least one note is in it.

- A folder name is 1 to 40 characters after trimming, with runs of spaces collapsed to one. It may not contain `/`, `\` or control characters. Anything else is treated as no folder when read from storage, and refused with a message when typed.
- At most 100 different folders. Notes beyond that load with no folder.
- Folder names are compared exactly (case-sensitive). They are listed in alphabetical order, ignoring case.
- **Folder names are stored in plain text, also for encrypted notes**, like the pinned flag. The README says so.
- Backups carry the folder. A linked file's location on disk has nothing to do with folders.
- Settings gain `collapsedFolders`: the names of folders shown closed.

**Sidebar.** *(Layout is my call.)*

```
[ New note             Alt N ]
v Clients                  3
    Acme pentest           x
    Globex review          x
> Incidents                5
  Welcome to CyberPad      x
Tags
```

- Folders come first, each with a header showing its name and note count. Clicking the header, or pressing Enter or Space on it, opens or closes it. Notes without a folder follow.
- Inside each group the order is as today: pinned first, then most recently changed.
- While a search or a tag filter is active the list is flat, as today, and each row shows its folder name.
- Opening a note that is in a closed folder (from the palette, a wiki link, search) opens that folder.
- A new note goes into the folder of the note that was open. Today's log, imports and opened files get no folder. A duplicate keeps its folder.

**Commands** (palette, Note section):

- **Move to folder…** opens a dialog with a text box (new or existing name) and the existing folders as buttons.
- **Remove from folder** (only when the note is in one).
- **Rename folder…** (only when the note is in one) renames it for every note in it. Renaming to an existing folder's name merges the two, after a confirmation.

**Drag and drop.** A note row can be dragged onto a folder header, or onto the area of notes without a folder. This is a mouse shortcut for the commands above; the file-import drop zone must not appear for these drags.

### 2. Export as PDF

- New command **Export note as PDF** (palette, File section), for a note that is open and unlocked.
- It opens the print dialog, where the user picks "Save as PDF". A toast says so: `In the print dialog, choose Save as PDF.`
- A print stylesheet shows only the rendered note: no bars, no sidebar, no editor, no CRT effect, no copy buttons. Dark text on white, the link address printed after each link, code blocks wrapped instead of cut off, and headings kept with the text that follows.
- The dialog's suggested file name is the note title.
- For an encrypted note, a confirmation comes first: title `Export this encrypted note as PDF?`, message `The PDF is not encrypted. Anyone who can open it can read the note.`, button `Export as PDF`.
- Limit: whether the print dialog appears inside the desktop app cannot be checked without running it. The user checks that. If it does not, a host-side export is a later piece of work that needs its own approval.

### 3. Arrows as you type

| You type | You get | Not when |
|---|---|---|
| `->` | `→` | the character before the `-` is `-` or `<` (so `-->` stays) |
| `<-` | `←` | the character before the `<` is `<` (so the shell's `<<-` stays) |
| `<->` | `↔` | (follows from the two above) |
| `=>` | `⇒` | the character before the `=` is `=`, `<`, `>` or `!` |

- Only for a character typed at the keyboard, never for pasted text.
- **Never inside a fenced code block or inline code.** A caret is in code when an odd number of fence lines (` ``` ` or `~~~`, indented at most three spaces) come before its line, or an odd number of backticks come before it on its line.
- Ctrl+Z undoes the replacement as its own step. Pressing Backspace immediately after a replacement puts back the characters that were typed.
- A setting, on by default, switches it off: palette, View section, **Turn off arrow replacement** / **Turn on arrow replacement**.

*(The exclusions, Backspace behaviour and the setting are my calls.)*

### 4. Encrypted credentials note

- New command **New encrypted credentials note** (palette, Insert section) and the quick insert `/credentials`.
- It asks for a passphrase with the existing encryption dialog. Only after the note is sealed does it join the note list and get saved. Cancelling the dialog leaves nothing behind.
- The note starts with:

  ```markdown
  # Credentials

  | System | Username | Password | URL | Notes |
  | --- | --- | --- | --- | --- |
  |  |  |  |  |  |

  Last reviewed: 2026-11-25
  ```

- `/credentials` typed in a plain note removes the typed text and starts the same flow; it never inserts the table into a plain note. Typed in an unlocked encrypted note, it inserts the table at the cursor.
- The new note goes into the folder of the note that was open.

### 5. Delete from the sidebar, with undo

- Each note row has a delete button (`×`, labelled `Delete <title>` for screen readers). It shows when the row is hovered or focused, and always on touch screens.
- The Delete key deletes the focused note row.
- The existing confirmation stays, with new wording: `You can undo this for 10 seconds. After that the note is gone, so export a backup first if you might need it later.` For a linked note it still adds `The file stays where it is.`
- After deleting, the toast `Note deleted.` has an **Undo** button for 10 seconds. Undo puts the note back as it was: text, folder, pin, history, and its link to a file. An encrypted note comes back locked.
- Only the latest delete can be undone. Deleting another note makes the earlier one final.
- The host is told to forget a deleted note's file link only when the delete is final.

## Testing

**Automated** (`npm test`):

- store: the folder field through validate, serialize, backup and import; bad folder values dropped; the 100-folder cap; old data without the field; the two new settings.
- texttools: every row of the arrow table, each exclusion, fenced and inline code, start and end of text; the credentials template.

**In the browser pane**, all three themes, at 1280, 900 and 375 px: each feature by keyboard and by mouse; the print layout with the pane's print emulation or the browser's print preview.

**By the user in the desktop app** (added to the README's manual checks):

- **Export note as PDF** opens the print dialog and "Save as PDF" produces a readable file.
- Folders, delete and undo behave as in the browser, and a deleted linked note leaves its file on disk.

## Documentation

README: folders (including that names are not encrypted), PDF export, arrows and how to turn them off, the credentials note, delete and undo, the new shortcuts, and the manual checks above.

## Left to the builder

- Exact markup and ARIA for folder headers and the delete button, as long as both work from the keyboard and are announced with their state.
- How the 10-second undo window is timed and cleaned up.
- How the credentials flow reuses the existing encryption dialog.
- The exact print colours and spacing.
