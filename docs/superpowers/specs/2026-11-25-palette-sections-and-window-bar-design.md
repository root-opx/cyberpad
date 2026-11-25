# Command palette sections, themed Windows bar and top-bar fixes: design

Date: 2026-11-25. Branch: `feature/ux-ui`. Status: waiting for approval.

Read `docs/ux-handoff.md` first. Its rules (strict CSP, no `innerHTML`, no dependencies, accessibility, never launch `CyberPad.exe`) apply to everything here.

## Why

The user named two things that bother them:

1. **The command palette is one long list.** Ctrl+K itself is fine. What is not fine is scrolling through about 75 rows to see what the app can do.
2. **The Windows title bar is white.** In the desktop app the bar that Windows draws sits above the app's own dark bar and clashes with it.

While looking at the app, two defects in the top bar turned up, and the user agreed to fix them in the same round:

3. **At phone width the top bar breaks.** At 375 px it is three rows (136 px) tall and the row of controls runs 37 px past the right edge, so the Commands button is cut off.
4. **Top-bar controls are small.** They are 27 to 28 px tall.

## Goals

- Every command can be found in the palette without scrolling, on a window at least 700 px tall.
- The Windows title bar matches the app's own bar in all three themes.
- The top bar fits any width from 320 px up with nothing cut off.
- Top-bar controls are at least 32 px tall, and 44 px at phone width.

## Non-goals

- A menu bar or toolbar that is always on screen. The user confirmed Ctrl+K is fine.
- Changing what any command does, or adding or removing commands.
- New theme colours. Amber and Terminal green have weak colour distinctions; that is a later round.
- The cramped split view below about 900 px. Also a later round.
- Drawing our own window frame in place of the Windows one.
- Remembering which section was open last time.

## Anti-goals

The work has failed, even if it looks right, if any of these happen:

- The CSP changes, an `innerHTML` appears, or a dependency is added.
- The page can send the host a colour, or anything other than one of three fixed theme names.
- The palette becomes harder to use from the keyboard, or typing to filter behaves differently from today.
- A screen-reader user can no longer tell which command is selected.

## Constraints

- All UI is built with `NP.dom.h`. No inline styles in markup; CSSOM property sets are fine.
- Only the existing colour tokens (`--void`, `--panel`, `--raise`, `--line`, `--ink`, `--dim`, `--hot`, `--cool`, `--warn`). Check contrast in all three themes with the CRT effect on and off.
- `prefers-reduced-motion` stays respected. This design adds no animation.
- The host bridge is a security control. It changes in exactly one way, described below, which the user approved on 2026-11-25.
- Some user-facing strings are matched by tests. Grep `tests/` and `desktop/CyberPad.Desktop.Tests/` before changing one.
- Desktop-only behaviour cannot be seen in a browser. The user checks it in the desktop app themself.

## Approaches

### Palette

Three layouts were mocked up (private canvas: https://claude.ai/artifact/YQKVt27x1KB9rZzw9mgxiP).

| | Layout | Trade-off |
|---|---|---|
| A | Section tabs across the top | Smallest change, but runs out of width as sections are added, and needs sideways scrolling on a phone. |
| **B** | **Section list down the left, commands on the right** | Reads like a menu and has room to grow. Slightly wider dialog. |
| C | Every section at once, in five columns | Shows everything, but dense, needs shortened labels, and falls back to a long list below about 1100 px. |

**The user picked B.**

### Windows bar

| | Approach | Trade-off |
|---|---|---|
| **1** | **Keep the Windows bar and colour it to follow the theme** | Same colour as the app's bar in every theme. Needs one new page-to-host message. |
| 2 | Keep the Windows bar, one fixed dark colour | No bridge change, but a visible mismatch in Amber and Terminal green. |
| 3 | Remove the Windows bar and draw our own | One bar instead of two, but dragging, resizing, snapping and the system menu must all be rebuilt and are easy to get subtly wrong. |

**The user picked 1** and approved the new message.

### Top bar

One sensible way for each fix, described below. No alternatives were worth keeping.

## Design

### 1. Command palette

**Two modes, chosen by the search box.**

- **Browse** (the box is empty): two panes.
- **Filter** (the box has text other than spaces): one flat list, as today, with the section name as the hint on each row. The section column is hidden.
- **Heading jump** (the text starts with `@`): unchanged from today, including its "Headings" header row and no hints. The section column is hidden.
- A box holding only spaces counts as empty, as today.

**Browse mode layout.**

```
> Type a command or note name
+----------------+------------------------------------+
| Recent notes   | Extract IOCs               [Alt I] |
| Note         7 | Defang IOCs                        |
| File         9 | Refang IOCs                        |
| View        12 | Scan note for secrets              |
| Insert       7 | ...                                |
| Text        15 |                                    |
| Tools        5 |                                    |
| Vault        5 |                                    |
|>Security    16 |                                    |
+----------------+------------------------------------+
  Up/Down move   Tab next section   Enter run   Esc close
```

**Sections, in this order:**

| Section | Holds today's groups |
|---|---|
| Recent notes | Recent notes (up to 5, as today; the section is absent when there are none) |
| Note | Note |
| File | File |
| View | View and Theme |
| Insert | Insert and Templates |
| Text | Transform |
| Tools | Tools |
| Vault | Vault |
| Security | Security |

- Each command keeps today's group name for searching and gains a section name for display. Filtering scores a row on its title, on its old group name plus title (as today) and on its section name plus title. So "transform", "templates" and "theme" find what they find today, and "text" and "insert" also work. The hint on a filtered row shows the section name. *(My call: this is the only change to filtering, and it only adds matches.)*
- A section with no available commands is not shown. The number beside a section is how many commands it has right now.
- The palette always opens on the first section. *(My call: predictable, and remembering was not asked for.)*
- Above 760 px the command pane has one fixed height, set in CSS, that fits 16 rows (the longest section today). It is the same every time the palette opens, even when the current note leaves sections shorter, and it does not change when you switch sections. If the window is too short for it, the pane is capped to the window and scrolls; the section column does not scroll. *(My call: a stable size over a snug one.)*
- At 760 px and below the pane is capped at about 70% of the screen height and scrolls when a section is longer. The "no scrolling" goal is for desktop-sized windows.

**Keyboard.** Focus stays in the search box the whole time, as today.

| Key | Browse mode | Filter mode |
|---|---|---|
| Up / Down | Move through commands. Past the last command of a section, continue into the next section; past the very last, wrap to the very first. | As today |
| Tab / Shift+Tab | Jump to the first command of the next / previous section, wrapping | Does nothing |
| Page Down / Page Up | Same as Tab / Shift+Tab | As today |
| Enter | Run the selected command | As today |
| Esc | Close | As today |
| Any character | Switch to filter mode | As today |

*(The key map is my call. The reason for Up/Down crossing sections is that arrow keys alone still reach everything, as they do today.)*

**Mouse.** Clicking a section selects it and its first command; the search box keeps focus. Clicking a command runs it, as today.

**Accessibility.**

- The search box stays a `combobox` whose `aria-activedescendant` is the selected command, as today.
- Section entries are real `<button>` elements kept out of the tab order (focus never leaves the search box), each with a pressed or selected state that is exposed to assistive technology.
- When the section changes, a polite live region announces it, for example "Security, 16 commands".
- The exact roles are left to the builder, within those three requirements.

**Narrow widths (760 px and below).** The section column becomes a single row above the commands. It scrolls sideways if it does not fit, and keeps the selected section in view. Section entries and command rows are 44 px tall.

**Copy.** New strings: the placeholder stays as it is; the footer reads `Up/Down move`, `Tab next section`, `Enter run`, `Esc close` (arrows may be drawn as symbols). In filter mode the footer drops the Tab hint. Existing strings such as "Nothing matches. Try another word." do not change.

### 2. Windows title bar (desktop only)

**What the user sees.** The Windows bar has the same background as the app's own bar (`--panel`) and readable title text, in every theme, and changes the moment the theme changes. Minimise, maximise, close, dragging, snapping and the system menu are untouched.

**How.**

- The host calls `DwmSetWindowAttribute` (from `dwmapi.dll`, part of Windows; no new dependency) when the window handle is created and whenever the theme changes:
  - dark mode on;
  - caption colour, caption text colour and border colour from the table below.
- The colours live in the host as constants. The page never sends a colour.

| Theme | Caption (`--panel`) | Text (`--ink`) | Border (`--line`) |
|---|---|---|---|
| `neon` | `#191338` | `#ece6ff` | `#362a72` |
| `amber` | `#1f1508` | `#ffcc75` | `#4f3615` |
| `terminal` | `#031203` | `#33ff66` | `#0d3d10` |

- If these values ever change in `css/style.css`, they must change here too. A comment in both places says so.

**The one bridge change.** A new page-to-host message:

```json
{ "type": "theme", "id": "<request id>", "theme": "neon" }
```

- `theme` must be a string equal to exactly `neon`, `amber` or `terminal`. Anything else is rejected with a logged reason, like every other message. The usual origin, exact-field-set, duplicate and id checks apply unchanged.
- It does no file or store work, so it does not wait behind the save or file gates.
- The reply type is `themeApplied`, with the request id, following the convention of `quarantined` and `fileUnlinked`. A failed Windows call is not an error and still answers `themeApplied`. Only an unexpected exception answers with the standard `rejected`.
- The page sends it once after start-up and once each time the theme changes, not on every settings save. In a browser it is a no-op. If the host does not answer, nothing is shown to the user and the page carries on; the bar just keeps its previous colour.

**Limits.**

- **CRT effect.** The Windows bar is a flat colour. With the CRT effect on (the default), the app's own bar has scanlines and darker corners drawn over it, so the two bars share a base colour but are not identical. That passes. With CRT off they match exactly. *(My call: Windows cannot draw scanlines on its bar.)*
- **Zen mode.** The app's bar is hidden, so the Windows bar sits directly above the editor in the `--panel` colour. It stays that way. *(My call.)*
- Until the page has loaded and reported its theme, the bar uses the Neon colours, the same as the window background does today. An Amber or Terminal green user sees Neon colours for a moment at start-up. *(My call: accepted, to keep this small.)*
- Windows 10 cannot set a caption colour. There the calls fail harmlessly and the bar is Windows' own dark grey. Failures are never shown to the user and never throw.

### 3. Top bar at phone width (760 px and below)

```
[=] CYBERPAD                      [Commands]
[ Search notes           ]  [Write|Split|Read]
```

- Two rows instead of three.
- The theme picker is hidden at this width; themes are in the palette under View. CRT and Sound are already hidden below 1100 px for the same reason.
- No horizontal overflow at any width from 320 px up: the page is never wider than the window.

### 4. Top-bar control sizes

- Every control in the top bar (note-list toggle, search box, Write/Split/Read, theme picker, CRT, Sound, Commands) is at least 32 px tall.
- At 760 px and below they are 44 px tall.
- Only the top bar changes. The find bar, alert bar and dialogs keep their sizes.

## Testing

**Automated.**

- `tests/platform.test.js`: the page sends the `theme` message with the right shape on desktop, sends nothing in a browser, and refuses a theme name outside the allow-list.
- `desktop/CyberPad.Desktop.Tests/MessageDispatcherTests.cs`: `theme` accepted for each of the three names; rejected for an unknown name, a wrong case, a non-string, an extra field, a missing field, a missing id and a wrong origin.
- A unit test for the theme-to-colour table, including the conversion to the byte order Windows expects.
- If the section grouping is put in a pure function, test it under `tests/`: order, merged groups, empty sections dropped, counts.
- `npm test`, `node --check js/app.js` and `dotnet test desktop/CyberPad.sln` all pass. Revert `desktop/**/packages.lock.json` after the .NET run.

**In the browser pane**, in all three themes, CRT on and off, at 1280, 900, 375 and 320 px:

- palette browse mode, each section, with keyboard only and with the mouse;
- palette filter mode and the `@` heading jump behave as before;
- the top bar has no overflow and its controls meet the sizes above;
- focus rings are visible everywhere.

**By the user in the desktop app** (add these lines to "Manual checks for the desktop app" in the README):

- With the CRT effect off, the Windows bar is the same colour as the app's bar in each theme, and it changes when the theme changes. With CRT on it is the same base colour without the scanlines.
- Minimise, maximise, close, drag, snap and the system menu still work.

## Documentation

- README, "Command palette": say that commands are grouped in sections.
- README, "Engagement templates": "in the palette under Templates" becomes "under Insert". Check the README for other mentions of the old section names (Vault and Security keep theirs).
- README, "Security notes, Desktop app, Narrow host bridge": add the `theme` message to the list and say it carries one of three fixed names.
- README, manual checks: the two lines above.

## Left to the builder

- Exact ARIA roles for the section column, within the accessibility requirements above.
- Exact dialog width and row heights on desktop, as long as the longest section fits without scrolling on a 700 px tall window.
- Whether the theme message is sent from `applySettings()` or from `setTheme()` plus start-up.
- How the host hands the theme from the dispatcher to the form's UI thread.
- CSS details, using existing tokens and the existing visual language (1 px lines, `--hot` marker on the selected section, `--cool` on the selected command).
