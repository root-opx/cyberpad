# Light, Dark and System themes: design and build steps

Date: 2026-11-25. Branch: `feature/ux-ui`. Status: the user chose the themes, the System option and the CRT behaviour on 2026-11-25 and asked for them to be built. Details marked *(my call)* were not discussed.

Read `docs/ux-handoff.md` first. Its rules apply: strict CSP, no `innerHTML`, no dependencies, accessibility, never launch `CyberPad.exe`.

## Why

CyberPad has three themes and all are dark and stylised. The user wants a plain **Light** theme, a plain **Dark** theme, and a choice that follows the Windows light or dark setting.

## Goals

- Two new themes: Light and Dark.
- A **System** choice that shows Light or Dark to match the operating system, and switches live when the system setting changes.
- Every existing screen is readable in the new themes: text contrast at least 4.5:1, focus ring visible.
- In the desktop app the Windows title bar matches the new themes too.

## Non-goals

- Other palettes (high contrast, Solarized). The user did not pick them.
- Changing Neon, Amber or Terminal green, or the default theme (Neon).
- A custom theme editor.

## Anti-goals

- The CSP changes, an `innerHTML` appears, or a dependency is added.
- The page can send the host anything other than a fixed theme name. `system` is never sent to the host.
- A stored setting from before this change stops loading.

## Design

### Theme values

| Setting value | Name shown | What is on screen |
|---|---|---|
| `neon` | Neon | as today |
| `amber` | Amber | as today |
| `terminal` | Terminal green | as today |
| `light` | Light | the Light theme |
| `dark` | Dark | the Dark theme |
| `system` | System | Light or Dark, following the operating system |

- `data-theme` on `<html>` always holds a real theme, never `system`.
- The theme picker lists, in this order: System, Light, Dark, Neon, Amber, Terminal green. *(my call)*
- The palette's View section keeps one `Theme: <name>` command for each choice that is not the current setting.
- With System chosen, the page listens to `(prefers-color-scheme: dark)` and re-applies when it changes.

### Colours *(my call; the builder may adjust a value only to meet the contrast rule, and reports any change)*

| Token | Light | Dark |
|---|---|---|
| `--void` | `#fafaf7` | `#16181d` |
| `--panel` | `#f0f0ea` | `#1c1f26` |
| `--raise` | `#e4e4dc` | `#272b34` |
| `--line` | `#bfbfb4` | `#3a404c` |
| `--ink` | `#1b1b1f` | `#e3e6ec` |
| `--dim` | `#5d5d66` | `#9aa3b2` |
| `--hot` | `#b3005e` | `#ff8f5a` |
| `--cool` | `#00635f` | `#6cb6ff` |
| `--warn` | `#8a5a00` | `#f2cc60` |
| `--sel` | `rgb(179 0 94 / 0.18)` | `rgb(108 182 255 / 0.28)` |
| `--glow-strength` | `0` | `0` |

- Contrast rule: `--ink`, `--dim`, `--hot`, `--cool` and `--warn` as text on each of `--void`, `--panel` and `--raise` reach at least 4.5:1; `--void` as text on `--cool` and on `--hot` (primary buttons, pressed tags, the critical badge) reaches at least 4.5:1; `--line` against `--void` and `--panel` reaches at least 1.5:1 so borders stay visible.
- Light sets `color-scheme: light` so scroll bars and native controls are light; every other theme stays `color-scheme: dark`.
- Rules that hard-code dark values (the dialog backdrop, the scrim, drop shadows, theme-specific overrides such as the Terminal green ones) are checked on Light and adjusted only where something is unreadable or looks broken.

### CRT effect

- **Dark:** scanlines and dark corners as on the other dark themes, with no text glow.
- **Light:** the CRT switch gives faint scanlines only: no glow, no dark corners, no flicker. *(Strength is my call: about 3 to 4% black lines.)*

### Windows title bar (desktop)

The page already tells the host which theme is on with the `theme` message. Two names are added to the host's allow-list, and nothing else about the message changes:

| Theme | Caption | Text | Border | Windows dark-mode flag |
|---|---|---|---|---|
| `light` | `#f0f0ea` | `#1b1b1f` | `#bfbfb4` | off |
| `dark` | `#1c1f26` | `#e3e6ec` | `#3a404c` | on |

- The page sends the theme that is actually on screen. With System chosen it sends `light` or `dark`, and sends again when the system setting flips. `system` is not a valid value for the host and is rejected like any other unknown name.
- If a colour above is adjusted for contrast, the host table changes with it.

### Data

- `store.THEMES` lists the six setting values. A new `store.SCREEN_THEMES` lists the five real themes. `store.resolveTheme(setting, prefersDark)` returns the real theme: the setting itself, or for `system`, `'dark'` when `prefersDark` is true and `'light'` otherwise; any unknown setting gives `'neon'`.
- Settings saved before this change hold one of the three old values and load unchanged.

## Build steps

**Step 1: page side.** Files: `js/core/store.js`, `js/platform.js`, `js/app.js`, `css/style.css`, `index.html` (theme picker options only), `tests/store.test.js`, `tests/platform.test.js`.

- store: `THEMES`, `SCREEN_THEMES`, `resolveTheme` as above, exported. Tests: the six values validate; an unknown value falls back to the default; `resolveTheme` for all six settings with both `prefersDark` values and for `'__proto__'`, `null`, `5`.
- platform: `HOST_THEMES` gains `light` and `dark`. The existing test that iterates the store's themes iterates `store.SCREEN_THEMES`. `setHostTheme('system')` is rejected and posts nothing. Any existing test that uses `'dark'` as an example of an invalid name uses `'solarized'` instead.
- app: theme names, picker options and order, palette commands; `applySettings` resolves the setting before setting `data-theme`; the `matchMedia` listener (registered once, re-applies only when the setting is `system`); `syncHostTheme` sends the resolved theme.
- css: the two token blocks, `color-scheme` for Light, the CRT rules above, the print block's paper tokens covering the new themes, and any fix the Light check turns up.
- Checks in the browser pane, for Light and for Dark, CRT on and off, at 1280 and 375 px: the main screen, sidebar with a folder, palette, a modal dialog, the lock screen, toasts, the find bar, a preview with headings, code, a table, task boxes, a CVSS critical badge, links and a blockquote. Compute the contrast pairs in the rule above from the computed colours and report the numbers. Switch the pane's colour scheme with the tool's `colorScheme` option to confirm System flips live.

**Step 2: desktop host.** Files: `desktop/CyberPad.Desktop/Bridge/HostTheme.cs`, `desktop/CyberPad.Desktop/TitleBar.cs`, tests in `desktop/CyberPad.Desktop.Tests/`.

- `HostTheme` gains `Light` and `Dark`; `HostThemes.TryParse` accepts exactly the five names; `ColorsFor` returns the table above; `TitleBar.Apply` sets the dark-mode attribute to 0 for Light and 1 otherwise.
- Tests: `TryParse` accepts the five and rejects `system`, `Light`, `DARK`, and the existing bad cases (replace `dark` in the rejected lists with `solarized`); the COLORREF values `light` 0xEAF0F0 / 0x1F1B1B / 0xB4BFBF and `dark` 0x261F1C / 0xECE6E3 / 0x4C403A (recomputed if a colour was adjusted); the dispatcher accepts `light` and `dark` and rejects `system`.

**Step 3: documents.** `README.md` (themes list, System, CRT on Light, the bridge sentence now naming five values, a manual check: `Choose System, switch Windows between light and dark mode: the app and its title bar follow.`), the `theme` row in `docs/superpowers/specs/2026-11-23-desktop-app-design.md`, and the `--panel`/`--ink`/`--line` cross-reference comment in `css/style.css`.

**Verification.** `node --check js/app.js`; `npm test`; `dotnet test desktop/CyberPad.sln` then `git checkout -- "desktop/**/packages.lock.json"`; CSP line unchanged; no `innerHTML`, `insertAdjacentHTML` or inline style added; `js/ui/dom.js` untouched.
