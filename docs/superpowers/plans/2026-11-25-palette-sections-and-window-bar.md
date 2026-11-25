# Palette Sections, Themed Windows Bar and Top-Bar Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the command palette as sections with no scrolling, colour the Windows title bar to follow the theme, and fix the top bar's phone layout and control sizes.

**Architecture:** Section grouping and scoring become pure functions in `js/core/texttools.js`; `js/app.js` renders a two-pane palette from them. The page tells the desktop host its theme through one new allow-listed bridge message, and the host maps the name to fixed colours and calls `DwmSetWindowAttribute`. The top-bar fixes are CSS only.

**Tech Stack:** Plain JS (no build, no dependencies), CSS, Node built-in test runner, C# .NET 8 WinForms + WebView2, xUnit.

**Spec:** `docs/superpowers/specs/2026-11-25-palette-sections-and-window-bar-design.md`. Read it and `docs/ux-handoff.md` before starting any task.

## Global Constraints

- CSP in `index.html` does not change. No inline `<script>`/`<style>`, no `style="…"` in markup, no `setAttribute('style', …)`.
- No `innerHTML` or `insertAdjacentHTML`. Build elements with `NP.dom.h`. Do not widen `SAFE_ATTR` in `js/ui/dom.js`.
- No new dependency of any kind (npm, NuGet, font, CDN). `dwmapi.dll` is part of Windows and is allowed.
- Only the existing colour tokens: `--void --panel --raise --line --ink --dim --hot --cool --warn`.
- No new animation or transition.
- Everything stays reachable by keyboard with a visible `--cool` focus ring. Existing ARIA roles and labels stay.
- Copy: sentence case, plain verbs. Grep `tests/` and `desktop/CyberPad.Desktop.Tests/` before changing an existing string.
- **Never launch `CyberPad.exe`.** Desktop GUI checks are done by the user.
- The bridge gains exactly one message, `theme`. No other bridge change.
- After `dotnet test`, run `git checkout -- "desktop/**/packages.lock.json"`.
- Baseline before Task 1: `npm test` passes 141 tests; `dotnet test desktop/CyberPad.sln` passes 316.
- Commit messages end with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`. No personal data or machine paths in commits.
- Browser preview: start the `cyberpad-web` server from `.claude/launch.json` with the preview tool (not from a shell) and use http://localhost:8787.

## Review Focus

Conditions the spec implies that are easy to miss. Each is pinned by a test or check in the task named.

1. **Palette opened with no note, or on a locked encrypted note.** Many commands are unavailable, whole sections disappear, Recent notes may be absent. Expected: no empty section is listed, a valid row is selected, Tab works even with one section. (Task 1 tests; Task 2 browser check.)
2. **Filter text deleted back to empty.** Expected: browse mode returns, on the first section, with its first command selected. (Task 2 browser check.)
3. **Clicking a section with the mouse.** Expected: the search box keeps focus and typing still filters. (Task 2 browser check.)
4. **Host never answers the `theme` message.** Expected: nothing is shown to the user, and the next theme change is still sent. (Task 4 tests.)
5. **Windows refuses the title-bar call (Windows 10, or an invalid handle).** Expected: no exception; the window opens. (Task 5 test.)
6. **Short window (600 px, the desktop minimum).** Expected: the command pane scrolls, the selected row stays in view, the footer is visible. (Task 2 browser check.)

---

### Task 1: Section grouping and scoring (pure logic)

**Files:**
- Modify: `js/core/texttools.js` (add next to `fuzzyScore`, about line 306; add to the exported object)
- Test: `tests/texttools.test.js`

**Interfaces:**
- Produces, on the texttools module (`NP.text` in the page, `require('../js/core/texttools.js')` in tests):
  - `PALETTE_SECTIONS`: frozen array `['Recent notes', 'Note', 'File', 'View', 'Insert', 'Text', 'Tools', 'Vault', 'Security']`.
  - `sectionOf(group: string): string`. `'Theme'` → `'View'`, `'Templates'` → `'Insert'`, `'Transform'` → `'Text'`; any other string is returned unchanged.
  - `paletteSections(items: {group: string}[]): {name: string, items: object[]}[]`. Groups items by `sectionOf(item.group)`, in `PALETTE_SECTIONS` order, keeping each section's items in input order. Sections with no items are left out. A section name not in `PALETTE_SECTIONS` goes after the known ones, in first-seen order. Does not mutate its input.
  - `paletteScore(query: string, item: {group: string, title: string}): number`. Returns `Math.max(fuzzyScore(q, title), fuzzyScore(q, group + ' ' + title) - 50, fuzzyScore(q, sectionOf(group) + ' ' + title) - 50)`.

- [ ] **Step 1: Write the failing tests** in `tests/texttools.test.js`

```js
test('sectionOf merges Theme, Templates and Transform and leaves the rest', () => {
  assert.equal(T.sectionOf('Theme'), 'View');
  assert.equal(T.sectionOf('Templates'), 'Insert');
  assert.equal(T.sectionOf('Transform'), 'Text');
  for (const g of ['Note', 'File', 'View', 'Insert', 'Tools', 'Vault', 'Security', 'Recent notes']) assert.equal(T.sectionOf(g), g);
  assert.equal(T.sectionOf('__proto__'), '__proto__');
});

test('paletteSections orders, merges, drops empty sections and keeps item order', () => {
  const items = [
    { group: 'Security', title: 's1' }, { group: 'Templates', title: 't1' }, { group: 'Note', title: 'n1' },
    { group: 'Insert', title: 'i1' }, { group: 'Theme', title: 'th1' }, { group: 'Recent notes', title: 'r1' },
    { group: 'View', title: 'v1' }, { group: 'Transform', title: 'x1' },
  ];
  const out = T.paletteSections(items);
  assert.deepEqual(out.map((s) => s.name), ['Recent notes', 'Note', 'View', 'Insert', 'Text', 'Security']);
  assert.deepEqual(out.find((s) => s.name === 'Insert').items.map((i) => i.title), ['t1', 'i1']);
  assert.deepEqual(out.find((s) => s.name === 'View').items.map((i) => i.title), ['th1', 'v1']);
  assert.equal(items.length, 8);
});

test('paletteSections handles no items, one section and unknown groups', () => {
  assert.deepEqual(T.paletteSections([]), []);
  assert.deepEqual(T.paletteSections([{ group: 'Vault', title: 'a' }]).map((s) => s.name), ['Vault']);
  const out = T.paletteSections([{ group: 'Zed', title: 'z' }, { group: 'Note', title: 'n' }, { group: 'constructor', title: 'c' }]);
  assert.deepEqual(out.map((s) => s.name), ['Note', 'Zed', 'constructor']);
});

test('paletteScore still matches old group names and also the new section names', () => {
  const upper = { group: 'Transform', title: 'UPPERCASE' };
  const finding = { group: 'Templates', title: 'Insert pentest finding' };
  const amber = { group: 'Theme', title: 'Theme: Amber' };
  assert.ok(T.paletteScore('transform', upper) > 0);
  assert.ok(T.paletteScore('text', upper) > 0);
  assert.ok(T.paletteScore('templates', finding) > 0);
  assert.ok(T.paletteScore('view', amber) > 0);
  assert.ok(T.paletteScore('zzzz', upper) <= 0);
  assert.equal(T.paletteScore('upper', upper), T.fuzzyScore('upper', 'UPPERCASE'));
});
```

Use whatever name the file already gives the required module (`T` above).

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/texttools.test.js`
Expected: the four new tests FAIL with "T.sectionOf is not a function" or similar.

- [ ] **Step 3: Implement the four exports** in `js/core/texttools.js`

Use a `Map` for the three renames and for grouping, so a group named `__proto__` or `constructor` is ordinary data.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test`
Expected: 145 tests pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers js/core/texttools.js tests/texttools.test.js
git commit -m "feat: palette section grouping and scoring"
```

(This first commit also adds the spec and this plan.)

---

### Task 2: Two-pane palette

**Files:**
- Modify: `index.html:124-130` (the `#palette` dialog)
- Modify: `js/app.js` — `paletteItems` (about 1332), `openPalette`, `renderPalette` (about 1381), the palette listeners (about 3422), and the `els` lookup for the new elements
- Modify: `css/style.css` — the palette block (about 865-918) and the `max-width: 760px` block

**Interfaces:**
- Consumes: `T.paletteSections`, `T.paletteScore`, `T.sectionOf` from Task 1.
- Produces: no API for later tasks.

**Markup.** Replace the dialog's contents with this (the input keeps every attribute it has today, plus `aria-describedby="palette-foot"`):

```html
<div class="palette-input-row"> … unchanged … </div>
<div class="palette-body">
  <div id="palette-sections" class="palette-sections" role="group" aria-label="Sections" hidden></div>
  <ul id="palette-list" class="palette-list" role="listbox"></ul>
</div>
<p id="palette-status" class="sr-only" aria-live="polite"></p>
<p id="palette-foot" class="palette-foot"></p>
```

**Behaviour to build** (spec section "1. Command palette"):

- Mode is derived from the input on every render: `@…` → heading jump; other non-space text → filter; otherwise browse.
- **Heading jump and filter:** `#palette-sections` is hidden and the list is drawn as today, with two differences in filter mode only: rows are scored with `T.paletteScore(q, item)` instead of the inline expression at `app.js:1348`, and the hint shows `T.sectionOf(item.group)`.
- **Browse:** `S.pal.items` is the flat list from `T.paletteSections(items).flatMap((s) => s.items)`, so `S.pal.idx` stays one global index and row ids stay `pal-${i}`. The current section is the one that contains `S.pal.idx`. `#palette-sections` holds one `<button type="button" tabindex="-1" class="palette-section" aria-pressed="…">` per section, containing the name and, except for Recent notes, a `<span class="count">` with the number of commands. The list shows only the current section's rows, with no group header rows.
- **Keys** (in the existing `keydown` handler on `els.paletteInput`): Up/Down stay as they are, which now crosses sections and wraps because the list is flat. In browse mode only, `Tab`, `Shift+Tab`, `PageDown` and `PageUp` call `preventDefault()` and move `S.pal.idx` to the first row of the next or previous section, wrapping. In the other modes these keys are not handled.
- **Mouse:** a `mousedown` listener on `#palette-sections` calls `preventDefault()` so the input keeps focus; `click` on a section button sets `S.pal.idx` to that section's first row and re-renders.
- **Status:** when the current section differs from the one at the previous render (and on open), set `#palette-status` text to `"<name>, <n> commands"` (`"1 command"` for one; for Recent notes use `notes`/`note`). Clear it in filter and heading modes.
- **Footer text**, built with `h` as four `<span>`s: browse `↑ ↓ move`, `Tab next section`, `Enter run`, `Esc close`; other modes the same without the Tab item.
- `openPalette` keeps starting at `S.pal.idx = 0`, which is the first row of the first section.
- The empty-result strings at `app.js:1402` are unchanged.

**CSS to build:**

- `.palette`: `width: min(46rem, calc(100vw - 2rem))`, `margin-top: 8vh`.
- `.palette-body`: grid, columns `12rem minmax(0, 1fr)`; one column when `#palette-sections` is hidden.
- `.palette-sections`: `--void` background, `1px solid var(--line)` on the right, does not scroll.
- `.palette-section`: full-width row, 2.125rem tall, `--dim` text, transparent 2 px left border; `[aria-pressed="true"]` gets `--raise` background, `--ink` text and a `--hot` left border. `.count` is `--fs-xs`, `--dim`.
- `.palette-list` (replaces today's `max-height: min(26rem, 60vh)`): `height: min(28.5rem, calc(100dvh - 8vh - 9rem))`, `overflow-y: auto`. Rows are 1.75rem tall (16 rows = 28rem).
- `.palette-foot`: flex row, `gap: 1.1rem`, `1px solid var(--line)` on top, `--fs-xs`, `--dim`.
- At `max-width: 760px`: `.palette-body` is one column; `.palette-sections` is a single non-wrapping row with `overflow-x: auto`, a bottom border in place of the right one, and the pressed marker on the bottom edge; `.palette-section` and `.palette-item` have `min-height: 2.75rem`; `.palette-list` is `height: auto; max-height: 70dvh`. After each browse render, call `scrollIntoView({ block: 'nearest', inline: 'nearest' })` on the pressed section button.

- [ ] **Step 1: Change the markup** in `index.html` and add `paletteSections`, `paletteStatus`, `paletteFoot` to `els` in `js/app.js`.

- [ ] **Step 2: Implement the rendering, keys, mouse and status** in `js/app.js` as described above.

- [ ] **Step 3: Implement the CSS.**

- [ ] **Step 4: Syntax and unit tests**

Run: `node --check js/app.js` then `npm test`
Expected: no output from the first; 145 pass, 0 fail from the second.

- [ ] **Step 5: Check in the browser pane at 1280×700, Neon**

Open the palette with Ctrl+K and run this in the page:

```js
(() => { const l = document.getElementById('palette-list'), d = document.getElementById('palette').getBoundingClientRect();
  return { fits: l.scrollHeight <= l.clientHeight, insideWindow: d.bottom <= innerHeight,
    sections: [...document.querySelectorAll('.palette-section')].map((b) => b.textContent),
    focusInInput: document.activeElement.id === 'palette-input' }; })()
```

Expected: `fits: true`, `insideWindow: true`, `focusInInput: true`, sections start with `Note` (or `Recent notes` if other notes exist). Press Tab until Security is selected and run it again: still `fits: true`.

- [ ] **Step 6: Walk the behaviour checks.** Each must hold; fix and repeat if not.

| Do | Expect |
|---|---|
| Press Down past the last row of a section | Selection moves to the first row of the next section; the pressed section changes |
| Press Up on the very first row | Wraps to the last row of Security |
| Tab, Shift+Tab, PageDown, PageUp in browse mode | Jump one section, wrapping; focus stays in the input |
| Click a section, then type `sort` | Input kept focus; list switches to the flat filtered list with section hints; section column hidden |
| Type `transform`, then `text` | Both list the case and line transforms |
| Delete the text back to empty | Browse mode, first section, first row selected *(Review Focus 2)* |
| Type `@` | Heading list with its "Headings" header, as before |
| Type a single space | Still browse mode |
| Enter on a row; click a row | Command runs and the palette closes, as before |
| Encrypt a scratch note, lock it (Alt+L), open the palette | No empty sections listed; a row is selected; Tab moves or stays put without error *(Review Focus 1)* |
| Resize to 1000×600 | Command pane scrolls; selected row stays in view when arrowing; footer visible *(Review Focus 6)* |
| Resize to 375×812 | Sections are one row on top, scroll sideways, pressed one in view; rows are at least 44 px tall |

Then repeat Step 5 in Amber and Terminal green, and with CRT off. Read the console: no errors.

- [ ] **Step 7: Commit**

```bash
git add index.html js/app.js css/style.css
git commit -m "feat: command palette shows sections in two panes"
```

---

### Task 3: Top bar at phone width and control sizes

**Files:**
- Modify: `css/style.css` — the title-bar block (about 131-270) and the `max-width: 760px` block (about 1103-1137)

**Interfaces:** none.

**What to build** (spec sections 3 and 4):

- All widths: `.titlebar .icon-btn`, `.search`, `.segmented button`, `.theme-picker select`, `.titlebar .chip` get `min-height: 2rem`.
- At `max-width: 760px`:
  - those same controls get `min-height: 2.75rem`, and `.titlebar .icon-btn` is 2.75rem wide;
  - `.theme-picker` is `display: none`;
  - `.titlebar-actions` is `display: contents`, so its children join the title bar's wrapping flex row;
  - order: sidebar toggle, wordmark, then `#btn-palette` pushed right with `margin-left: auto` (row 1); then `.search` with `flex: 1 1 0; min-width: 6rem; max-width: none` and `.segmented` (row 2). Replace today's `.search { order: 5; flex-basis: 100%; }`.
- Do not change the find bar, alert bar, sidebar or dialogs.

- [ ] **Step 1: Implement the CSS.**

- [ ] **Step 2: Measure in the browser pane.** At each of 320, 375, 760, 900 and 1280 px wide, run:

```js
(() => { const t = document.querySelector('.titlebar');
  const hs = [...t.querySelectorAll('button, select, .search')].filter((e) => e.offsetParent).map((e) => Math.round(e.getBoundingClientRect().height));
  const cmd = document.getElementById('btn-palette').getBoundingClientRect();
  return { w: innerWidth, overflow: document.documentElement.scrollWidth - innerWidth, barHeight: Math.round(t.getBoundingClientRect().height),
    minControl: Math.min(...hs), cmdRight: Math.round(cmd.right) }; })()
```

Expected: `overflow: 0` and `cmdRight <= w` at every width; `minControl >= 44` at 320, 375 and 760; `minControl >= 32` at 900 and 1280; `barHeight` at 375 is under 136 and the bar is two rows.

- [ ] **Step 3: Look at it.** Screenshot 375 px and 1280 px in all three themes. The rows are aligned, nothing overlaps, and focus rings show when tabbing through the bar.

- [ ] **Step 4: Commit**

```bash
git add css/style.css
git commit -m "fix: top bar fits phone widths and has larger controls"
```

---

### Task 4: Page sends its theme to the host

**Files:**
- Modify: `js/platform.js` (add next to `quarantine`, about line 200; add to the returned object at about 365)
- Modify: `js/app.js` — `applySettings()` (about 559)
- Test: `tests/platform.test.js`

**Interfaces:**
- Produces: `platform.setHostTheme(theme: string): Promise<boolean>`.
  - Theme not exactly `'neon'`, `'amber'` or `'terminal'`: posts nothing, rejects with `new PlatformError('host', 'invalid theme')`.
  - Browser: posts nothing, resolves `false`.
  - Desktop: posts `{ type: 'theme', id, theme }` through the existing `request()` and resolves `true` on a `themeApplied` reply (`expect('themeApplied')`).
- Consumes (Task 5 provides the other end): host replies `{ "type": "themeApplied", "id": "<same id>" }`.

- [ ] **Step 1: Write the failing tests** in `tests/platform.test.js`, using the file's `fakeWebview`, `env`, `lastId`, `tick` helpers

```js
test('setHostTheme posts the theme and resolves on themeApplied', async () => {
  const fake = fakeWebview();
  const p = createPlatform(env({ chrome: fake.chrome }));
  const done = p.setHostTheme('amber');
  await tick();
  const m = fake.posted[fake.posted.length - 1];
  assert.deepEqual(Object.keys(m).sort(), ['id', 'theme', 'type']);
  assert.equal(m.type, 'theme');
  assert.equal(m.theme, 'amber');
  fake.reply({ type: 'themeApplied', id: m.id });
  assert.equal(await done, true);
});

test('setHostTheme refuses anything outside the three theme names and posts nothing', async () => {
  const fake = fakeWebview();
  const p = createPlatform(env({ chrome: fake.chrome }));
  for (const bad of ['Neon', 'dark', '', ' neon', '#191338', null, undefined, 3, {}, ['neon']]) {
    await assert.rejects(p.setHostTheme(bad), PlatformError);
  }
  assert.equal(fake.posted.length, 0);
});

test('setHostTheme does nothing in a browser', async () => {
  const p = createPlatform(env({ localStorage: fakeStorage() }));
  assert.equal(await p.setHostTheme('neon'), false);
});

test('setHostTheme rejects on a rejected or mismatched reply', async () => {
  const fake = fakeWebview();
  const p = createPlatform(env({ chrome: fake.chrome }));
  const a = p.setHostTheme('terminal');
  await tick();
  fake.reply({ type: 'rejected', id: lastId(fake), reason: 'Unexpected error.' });
  await assert.rejects(a, PlatformError);
  const b = p.setHostTheme('terminal');
  await tick();
  fake.reply({ type: 'quarantined', id: lastId(fake) });
  await assert.rejects(b, PlatformError);
});
```

Add a fifth test, `setHostTheme rejects when the host never answers`, modelled on the file's existing timeout test for another request (same way of shortening or faking the timer): no reply is sent, the promise rejects with a `PlatformError`, and a second `setHostTheme('neon')` afterwards still posts a message. *(Review Focus 4.)*

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/platform.test.js`
Expected: the new tests FAIL with "p.setHostTheme is not a function".

- [ ] **Step 3: Implement `setHostTheme`** in `js/platform.js` with a local frozen `HOST_THEMES = ['neon', 'amber', 'terminal']`, and export it.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test`
Expected: 150 pass, 0 fail.

- [ ] **Step 5: Call it from `applySettings()`** in `js/app.js`

Add `syncHostTheme()` and call it at the end of `applySettings()`:

```js
// Desktop: the Windows title bar follows the theme. Sent once per change, not on every settings save.
// A failure is not shown: the bar keeps its previous colour, and forgetting the sent value retries next time.
function syncHostTheme() {
  const theme = S.settings.theme;
  if (!platform.isDesktop || S.hostTheme === theme) return;
  S.hostTheme = theme;
  platform.setHostTheme(theme).catch(() => { if (S.hostTheme === theme) S.hostTheme = null; });
}
```

Add `hostTheme: null` where `S` is initialised.

- [ ] **Step 6: Verify**

Run: `node --check js/app.js` then `npm test`
Expected: no output; 150 pass. In the browser pane, switch themes: no console errors and no new network or message activity (browser mode is a no-op).

- [ ] **Step 7: Commit**

```bash
git add js/platform.js js/app.js tests/platform.test.js
git commit -m "feat: page reports its theme to the desktop host"
```

---

### Task 5: Host colours the Windows title bar

**Files:**
- Create: `desktop/CyberPad.Desktop/Bridge/HostTheme.cs`
- Create: `desktop/CyberPad.Desktop/TitleBar.cs`
- Modify: `desktop/CyberPad.Desktop/Bridge/IHostActions.cs`
- Modify: `desktop/CyberPad.Desktop/Bridge/MessageDispatcher.cs` (`Fields` at line 27; the `switch` at about line 129)
- Modify: `desktop/CyberPad.Desktop/HostActions.cs` (constructor and new method)
- Modify: `desktop/CyberPad.Desktop/MainForm.cs` (constructor at about line 71; add `OnHandleCreated`)
- Modify: `desktop/CyberPad.Desktop.Tests/FakeHostActions.cs`, and every test that constructs `HostActions`
- Test: `desktop/CyberPad.Desktop.Tests/MessageDispatcherTests.cs`
- Create test: `desktop/CyberPad.Desktop.Tests/HostThemeTests.cs`

**Interfaces:**
- Consumes: the page message `{ "type": "theme", "id": "<id>", "theme": "neon" | "amber" | "terminal" }` from Task 4.
- Produces:
  - `enum HostTheme { Neon, Amber, Terminal }` in namespace `CyberPad.Desktop.Bridge`.
  - `static class HostThemes` in the same file:
    - `static bool TryParse(string? name, out HostTheme theme)` — ordinal, exact match on `"neon"`, `"amber"`, `"terminal"` only.
    - `readonly record struct TitleBarColors(Color Caption, Color Text, Color Border)`.
    - `static TitleBarColors ColorsFor(HostTheme theme)`.
    - `static int ToColorRef(Color c)` — Windows `COLORREF`, `0x00BBGGRR`.
  - `IHostActions.SetThemeAsync(HostTheme theme): Task`.
  - `static class TitleBar` in namespace `CyberPad.Desktop`: `static void Apply(IntPtr hwnd, HostTheme theme, Action<string> log)`. Never throws.
  - Reply JSON: `{"type":"themeApplied","id":"<id>"}`.

**Colour table** (must equal `--panel`, `--ink`, `--line` in `css/style.css`):

| Theme | Caption | Text | Border |
|---|---|---|---|
| Neon | `#191338` | `#ece6ff` | `#362a72` |
| Amber | `#1f1508` | `#ffcc75` | `#4f3615` |
| Terminal | `#031203` | `#33ff66` | `#0d3d10` |

- [ ] **Step 1: Write the failing tests**

`desktop/CyberPad.Desktop.Tests/HostThemeTests.cs`:

```csharp
public class HostThemeTests
{
    [Theory]
    [InlineData("neon", HostTheme.Neon)]
    [InlineData("amber", HostTheme.Amber)]
    [InlineData("terminal", HostTheme.Terminal)]
    public void TryParse_AcceptsTheThreeNames(string name, HostTheme expected)
    {
        Assert.True(HostThemes.TryParse(name, out var t));
        Assert.Equal(expected, t);
    }

    [Theory]
    [InlineData(null)] [InlineData("")] [InlineData("Neon")] [InlineData("NEON")] [InlineData(" neon")]
    [InlineData("neon ")] [InlineData("dark")] [InlineData("0")] [InlineData("#191338")] [InlineData("neon\0")]
    public void TryParse_RejectsEverythingElse(string? name) => Assert.False(HostThemes.TryParse(name, out _));

    [Theory]
    [InlineData(HostTheme.Neon, 0x381319, 0xFFE6EC, 0x722A36)]
    [InlineData(HostTheme.Amber, 0x08151F, 0x75CCFF, 0x15364F)]
    [InlineData(HostTheme.Terminal, 0x031203, 0x66FF33, 0x103D0D)]
    public void ColorsFor_MatchTheCssTokens_AsColorRefs(HostTheme theme, int caption, int text, int border)
    {
        var c = HostThemes.ColorsFor(theme);
        Assert.Equal(caption, HostThemes.ToColorRef(c.Caption));
        Assert.Equal(text, HostThemes.ToColorRef(c.Text));
        Assert.Equal(border, HostThemes.ToColorRef(c.Border));
    }

    [Fact]
    public void Apply_WithAnInvalidWindowHandle_DoesNotThrow()
    {
        var log = new List<string>();
        TitleBar.Apply(IntPtr.Zero, HostTheme.Amber, log.Add);
        Assert.DoesNotContain(log, l => l.Contains('#') || l.Contains('\\'));
    }
}
```

In `MessageDispatcherTests.cs`, using the file's `Make()`, `Parse()` and `Src`, and after adding `public HostTheme? ThemeSet; public int ThemeCalls; public Exception? ThemeThrows;` plus `SetThemeAsync` to `FakeHostActions`:

```csharp
[Theory]
[InlineData("neon", HostTheme.Neon)]
[InlineData("amber", HostTheme.Amber)]
[InlineData("terminal", HostTheme.Terminal)]
public async Task Theme_AppliesAndReplies(string name, HostTheme expected)
{
    var (d, f, _) = Make();
    var r = Parse(await d.HandleAsync(Src, $$"""{"type":"theme","id":"r1","theme":"{{name}}"}"""));
    Assert.Equal("themeApplied", r.GetProperty("type").GetString());
    Assert.Equal("r1", r.GetProperty("id").GetString());
    Assert.Equal(expected, f.ThemeSet);
    Assert.Equal(1, f.ThemeCalls);
}

[Theory]
[InlineData("""{"type":"theme","id":"r1","theme":"Neon"}""")]
[InlineData("""{"type":"theme","id":"r1","theme":"dark"}""")]
[InlineData("""{"type":"theme","id":"r1","theme":""}""")]
[InlineData("""{"type":"theme","id":"r1","theme":"#191338"}""")]
[InlineData("""{"type":"theme","id":"r1","theme":1}""")]
[InlineData("""{"type":"theme","id":"r1","theme":null}""")]
[InlineData("""{"type":"theme","id":"r1","theme":["neon"]}""")]
[InlineData("""{"type":"theme","id":"r1"}""")]
[InlineData("""{"type":"theme","id":"r1","theme":"neon","color":"#fff"}""")]
[InlineData("""{"type":"theme","id":"r1","theme":"neon","theme":"amber"}""")]
[InlineData("""{"type":"theme","theme":"neon"}""")]
public async Task Theme_InvalidMessage_IsRejectedAndNeverApplied(string json)
{
    var (d, f, log) = Make();
    await d.HandleAsync(Src, json);
    Assert.Equal(0, f.ThemeCalls);
    Assert.Single(log);
    Assert.DoesNotContain("#191338", log[0]);
}

[Fact]
public async Task Theme_WrongOrigin_IsRejected()
{
    var (d, f, _) = Make();
    await d.HandleAsync("https://evil.example/", """{"type":"theme","id":"r1","theme":"neon"}""");
    Assert.Equal(0, f.ThemeCalls);
}

[Fact]
public async Task Theme_UnexpectedFailure_RepliesRejectedWithGenericReason()
{
    var (d, f, _) = Make();
    f.ThemeThrows = new InvalidOperationException(@"C:\secret\path");
    var r = Parse(await d.HandleAsync(Src, """{"type":"theme","id":"r1","theme":"neon"}"""));
    Assert.Equal("rejected", r.GetProperty("type").GetString());
    Assert.DoesNotContain("secret", r.GetRawText());
}

[Fact]
public async Task Theme_DoesNotWaitBehindASlowSave()
{
    var (d, f, _) = Make();
    f.DelayMs = 500;
    var save = d.HandleAsync(Src, """{"type":"save","id":"s1","data":"x"}""");
    var theme = d.HandleAsync(Src, """{"type":"theme","id":"t1","theme":"amber"}""");
    Assert.Same(theme, await Task.WhenAny(theme, save));
    await save;
}
```

If the fake's delay field works differently from `DelayMs` on `SaveAsync`, use the mechanism the file's existing concurrency tests use.

- [ ] **Step 2: Run to verify they fail**

Run: `dotnet test desktop/CyberPad.sln`
Expected: build errors for `HostTheme`, `HostThemes`, `TitleBar`.

- [ ] **Step 3: Implement `HostTheme.cs`** per the Interfaces block and colour table. Add a comment: "Keep in step with --panel, --ink and --line in css/style.css."

- [ ] **Step 4: Implement `TitleBar.Apply`** in `TitleBar.cs`

P/Invoke `DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size)` from `dwmapi.dll`, returning the `int` HRESULT. Set, in order: attribute 20 (immersive dark mode) to 1; 35 (caption colour), 36 (text colour) and 34 (border colour) to the `ToColorRef` values. Ignore non-zero HRESULTs (Windows 10 does not know 34 to 36). Catch only `DllNotFoundException` and `EntryPointNotFoundException`, and log `"titlebar: " + ex.GetType().Name`; log nothing else.

- [ ] **Step 5: Wire the dispatcher**

- `Fields`: add `["theme"] = new[] { "type", "id", "theme" }`.
- New `case "theme"`: read `root.GetProperty("theme")`; if it is not a JSON string or `HostThemes.TryParse` fails, `return Reject(type, id, "invalid theme")`. Otherwise call `RunAsync(type, id!, async () => { await _actions.SetThemeAsync(theme); return Serialize(new { type = "themeApplied", id }); }, null)`. Do **not** wrap it in `Serialized(...)` and do not use `RunFileAsync`: it must not take either gate.
- Add `Task SetThemeAsync(HostTheme theme);` to `IHostActions` with a one-line summary.

- [ ] **Step 6: Wire `HostActions` and `MainForm`**

- `HostActions`: new constructor parameter `Action<HostTheme> applyTheme`, placed and stored the same way as the existing `ConfirmClose` callback. `SetThemeAsync` runs `applyTheme` on the UI thread (the same marshalling the class already uses for dialogs) and returns a completed task when the window is disposed or has no handle.
- `MainForm`: add `private HostTheme _theme = HostTheme.Neon;` and `private void ApplyTheme(HostTheme theme) { _theme = theme; if (IsHandleCreated) TitleBar.Apply(Handle, theme, _log); }`; pass `ApplyTheme` to `HostActions`. Override `OnHandleCreated` to call `base.OnHandleCreated(e)` then `TitleBar.Apply(Handle, _theme, _log)`, so the bar is dark before the page loads and after any handle re-creation.
- Update `FakeHostActions` and every `new HostActions(` in the test project.

- [ ] **Step 7: Run to verify everything passes**

Run: `dotnet test desktop/CyberPad.sln`
Expected: all pass, 0 failed; the count is 316 plus the new cases.

Then: `git checkout -- "desktop/**/packages.lock.json"` and `git status --short` shows no lock file.

- [ ] **Step 8: Commit**

```bash
git add desktop/CyberPad.Desktop desktop/CyberPad.Desktop.Tests
git commit -m "feat(desktop): Windows title bar follows the theme"
```

---

### Task 6: Documentation and final verification

**Files:**
- Modify: `README.md`
- Modify: `css/style.css:3-4` (comment only)

**Interfaces:** none.

- [ ] **Step 1: Update the README**

- "Command palette (`Ctrl+K`)": add one bullet: commands are grouped in sections (Note, File, View, Insert, Text, Tools, Vault, Security) listed on the left; Tab moves between sections; typing searches all of them.
- "Engagement templates": "in the palette under Templates" → "in the palette under Insert". Grep the README for `Transform` and `Theme` used as palette section names and fix any.
- "Look and feel": add one bullet: in the desktop app the Windows title bar takes the theme's colour (Windows 11; Windows 10 shows its own dark bar).
- "Security notes → Desktop app → Narrow host bridge": add `theme` to the list of message types, and one sentence: it carries only `neon`, `amber` or `terminal`; the colours are fixed in the host, and any other value is rejected.
- "Manual checks for the desktop app": add
  - `With the CRT effect off, the Windows title bar is the same colour as the app's bar in each theme and changes when the theme changes. With CRT on it is the same base colour without the scanlines.`
  - `Minimise, maximise, close, drag, snap and the title bar's system menu still work.`

- [ ] **Step 2: Add the cross-reference comment** above the tokens in `css/style.css`: `--panel`, `--ink` and `--line` are copied in `desktop/CyberPad.Desktop/Bridge/HostTheme.cs`; change both together.

- [ ] **Step 3: Run everything**

```
node --check js/app.js
npm test
dotnet test desktop/CyberPad.sln
git checkout -- "desktop/**/packages.lock.json"
```

Expected: no output; 150 pass; all pass; clean lock files.

- [ ] **Step 4: Check the rules were kept**

Run: `git diff feature/desktop-app -- index.html | grep -n "Content-Security-Policy"` → no output (the CSP line is unchanged).
Run: `git diff feature/desktop-app -- js css index.html | grep -nE "^\+.*(innerHTML|insertAdjacentHTML|setAttribute\('style'|style=\")"` → no output.
Run: `git diff feature/desktop-app --stat -- js/ui/dom.js package.json desktop/CyberPad.Desktop/CyberPad.Desktop.csproj` → no changes.

- [ ] **Step 5: Final browser pass.** All three themes × CRT on and off, at 1280, 900, 375 and 320 px: the Task 2 Step 5 script and the Task 3 Step 2 script give their expected results; no console errors. Reset the preview to Neon and the desktop viewport.

- [ ] **Step 6: Commit**

```bash
git add README.md css/style.css
git commit -m "docs: palette sections and themed title bar"
```

- [ ] **Step 7: Hand the desktop checks to the user.** Do not launch `CyberPad.exe`. Ask the user to build with `desktop/build.ps1`, run the app, and go through the two new manual-check lines plus one more: switch themes and confirm `cyberpad.log` in `%LOCALAPPDATA%\CyberPad` has no `theme:` rejection lines.
