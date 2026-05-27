# SMGo — Project Context for Claude Code

## What this is
SMGo is a mobile companion for **SuperMemo 18** (Windows desktop). It lets you review
your SM flashcards on a phone via a PWA, then syncs grades, extracts, cloze deletions,
and Q&A items back to the desktop SM collection — from anywhere, not just home WiFi.

SuperMemo wiki: https://www.supermemo.wiki/en/home  
GitHub repo: https://github.com/Bosonian/smgo  
Live PWA: https://bosonian.github.io/smgo/

---

## Architecture

```
Android devices (S7 Tab, S25 Ultra)
        │  Xodo annotates PDFs in-place
        │  Syncthing syncs modified PDFs back to Windows
        ▼
Windows (highlight-extract.js — runs every 5 min via Task Scheduler)
        │  extracts annotation text from PDFs → pushes to Supabase
        ▼
  Supabase (cloud)  ◄──── PWA pushes grades/extracts/items/priority/dismiss
        │
        │  plugin polls every 30s
        ▼
  Desktop (SuperMemo + SMA plugin)
        │  on SM open: export-cloud.js pushes today's cards + RunHighlightExtract()
        └─ reads/writes priority.sub, Outstanding.sub, element HTML files
```

Three sync paths:
- **Cloud (Supabase)** — works from anywhere, primary path
- **PDF highlights (Syncthing + highlight-extract.js)** — annotation pipeline
- **Local server (port 3001)** — LAN only, fallback if no Supabase

---

## File Map

```
C:\SuperMemo\SMGo\
├── docs/                    ← PWA (served by GitHub Pages)
│   ├── app.js               ← all PWA logic
│   ├── index.html
│   ├── style.css
│   ├── sw.js                ← service worker (bump CACHE version on every deploy)
│   ├── manifest.json        ← orientation: portrait (locks PWA to portrait)
│   ├── favicon.ico
│   ├── icons/               ← icon-192.png, icon-512.png, icon-180.png
│   └── data/today.json      ← exported cards for static/offline mode
├── SMAPlugin/
│   ├── SMGoPlugin.cs        ← C# SMA plugin (HTTP server + file watchers + Supabase poller)
│   └── SuperMemoAssistant.Plugins.SMGo.csproj
├── sm-parser.js             ← reads SM Outstanding.sub + element HTML → card objects
│                               also: getPriorityMap(), Q&A pair detection/merging
├── server.js                ← optional Node.js server (same API as SMA plugin, port 3001)
├── export.js                ← manual: generates today.json + git push
├── export-cloud.js          ← auto: pushes today's cards to Supabase (run by plugin on startup)
├── highlight-extract.js     ← scans SM element PDFs for annotations → pushes to Supabase
│                               run automatically every 5 min by Task Scheduler
├── highlight-extract-state.json  ← mtime cache per PDF — GITIGNORED
├── config.json              ← Supabase credentials — GITIGNORED, never commit
└── .gitignore
```

---

## SM Collection

- Path: `C:\SuperMemo\systems\Facharzt`
- Element files: `elements/{floor((id-1)/10)}/{id}.htm` (ids 1-10 in root)
- Outstanding elements: `info/Outstanding.sub` — flat array of 4-byte little-endian uint32 IDs
- Card types parsed: `topic`, `cloze`, `pdf-extract`, `image`

---

## Supabase

- Project URL: `https://psqbpimlszjhpbdckwsj.supabase.co`
- Anon key: in `config.json` (key: `supabaseKey`)
- Tables:
  - `smgo_queue` — pending extracts/items/grades (`id text PK, type text, payload jsonb, applied bool`)
  - `smgo_daily` — today's cards (`date text PK, data jsonb`)
- Both tables have RLS policy `"open"` (allow all — personal project)
- `smgo_setup()` RPC function auto-creates tables if missing; called by `export-cloud.js` on every run
- PWA localStorage keys for Supabase: `smgo_supa_url`, `smgo_supa_key`

---

## SMA Plugin

- **Port:** 3001 (HttpListener on `http://+:3001/`)
- **DataDir:** `C:\SuperMemo\SMGo`
- **CollectionInfoDir:** `C:\SuperMemo\systems\Facharzt\info`
- **DLL install path:** `C:\Users\deepak\SuperMemoAssistant\Plugins\Packages\SuperMemoAssistant.Plugins.SMGo.1.0.0\lib\net472\`
- **Build:** `"C:\Program Files\dotnet\dotnet.exe" build -c Release` (MSBuild v4 won't work — SDK-style project requires dotnet CLI)
- **Config file:** reads `config.json` at startup for Supabase credentials
- **On SM open:** waits 5s → runs `export-cloud.js` then `highlight-extract.js` via `cmd.exe /c node`
- **Supabase poller:** starts 15s after SM open, then every 30s — fetches `applied=false` rows, applies, PATCHes `applied=true`
- **File watchers:** `grades/`, `extracts/`, `items/`, `dismisses/` — local fallback for LAN-only sync
- **Routes:** GET `/api/today`, POST `/api/grades`, POST `/api/extracts`, GET `/api/extracts`, POST `/api/items`, POST `/api/dismiss`, POST `/api/apply`, GET `/api/images/:id`

### Applying items to SM
- Extract → `ElementType.Topic` with `TextContent`, `.WithParent(parentId)`, `.DoNotDisplay()`
- Q&A → `ElementType.Item` with two `TextContent` args (question, answer)
- Cloze → `ElementType.Item`, regex `[word]` → `<span style="color:blue">[...]</span>`
- Grade → `GoToElement(id)` + sleep 400ms + `AssignGrade(grade)` + sleep 200ms
- Dismiss → `Svc.SM.Registry.Element[id].Done()` — calls SM engine directly (no UI dialog), marks as Dismissed permanently
- Priority → reads/writes `info/priority.sub` directly (flat uint32 array, position = rank)
- `ElementBuilder(ElementType, params ContentBase[])` — no `.WithContent()` method, pass contents in constructor
- **pdf-extract-create** → creates SM element from `payload.segments[]`; each segment is `{kind:'text', text}` or `{kind:'image', dataUrl?}` or `{kind:'image', imgPath?}`; `imgPath` is rendered as `<img src="file:///...">` with backslashes converted to forward slashes
- **ElemCreationFlags.None** — used for all `Element.Add()` calls; `CreateSubfolders` was causing new elements to land in an auto-created concept subfolder instead of directly under the specified parent

### Supabase queue types handled by plugin
| type | payload fields | effect |
|------|---------------|--------|
| `grade` | `elementId`, `grade` | GoToElement + AssignGrade |
| `extract` | `parentId`, `text` | create child Topic element |
| `pdf-extract-create` | `parentId`, `segments[]` | create child Topic with multiple paragraphs |
| `cloze` | `parentId`, `sentence`, `answer` | create Item with cloze blank |
| `qa` | `parentId`, `question`, `answer` | create Item |
| `dismiss` | `elementId` | element.Done() — permanent removal from Outstanding |
| `priority` | `elementId`, `priority` (0–100%) | reposition in priority.sub |

---

## PDF Highlight Extraction Pipeline

### Overview
Xodo (Android) annotates PDFs in-place → Syncthing syncs to Windows → `highlight-extract.js` extracts text → pushes to Supabase → SM plugin creates child elements.

### Color scheme — text highlights
| Color | Action |
|-------|--------|
| 🟠 Orange | Stage: accumulate in buffer, waiting for green |
| 🟢 Green | Commit: add green as final segment, flush buffer as one `pdf-extract-create` |
| 🟡 Yellow | Extract immediately as individual SM element |
| 🔵 Blue / pink | Skip entirely |

### Color scheme — rectangle annotations (Square subtype)
| Color | Action |
|-------|--------|
| 🟠 Orange / red / yellow / pink / other | Stage |
| 🟢 Green | Commit (lone green rect → immediate extract) |
| 🔵 Blue | Skip |

Rectangle color logic is intentionally permissive: Xodo's default rect color is red `{219,52,37}` which classifies as `pink` → stage.

- Staging buffer is per-PDF, persists across pages; text and rect members mix freely
- Green with no staged items → treated as immediate individual extract
- Uncommitted oranges logged as warning at end of PDF

### Rectangle annotation pipeline
1. Xodo draws a rectangle (Square PDF subtype) over a figure/flowchart
2. `highlight-extract.js` detects `annotation.subtype === 'Square'`
3. `renderRectToPng()` renders the full page via `@napi-rs/canvas` + pdfjs at 2× scale, then crops to the annotation rect
4. PNG saved as side-car file: `elements/{pdfBase}-rect-{annotId}.png`
5. Pushed to Supabase as `pdf-extract-create` with `segments: [{kind:'image', imgPath: '/absolute/path.png'}]`
6. Plugin creates SM element: `<img src="file:///C:/path/to.png" style="max-width:100%;height:auto">`

**Coordinate transform** (PDF → canvas): PDF origin is bottom-left; canvas origin is top-left.
`cx = (rx0 - view[0]) * scale`, `cy = (view[3] - ry1) * scale`

**`@napi-rs/canvas` + pdfjs shim**: pdfjs requires a module named exactly `canvas`. On ARM64 Windows there are no PyMuPDF wheels and the standard `canvas` npm package also lacks ARM64 binaries. Fix:
- `npm install @napi-rs/canvas`
- Create `node_modules/canvas/index.js` → `module.exports = require("@napi-rs/canvas");`
- Create `node_modules/canvas/package.json` → `{"name":"canvas","version":"2.11.2","main":"index.js"}`

### Two-column PDF handling
Harrison's Neurology (7.pdf) uses a two-column layout. Both columns share overlapping Y coordinates, so text items from left and right columns appear at the same Y positions. `extractTextForRects()` uses `TOLERANCE=3` and matches text items by both Y-range and X-range against `quadRects` — this works correctly for two-column PDFs without any special handling.

**Hyphenation artifacts**: Words split at PDF line breaks are stored as separate text items (e.g., `"asymmet-"` and `"ric"`). After `join(' ')` they become `"asymmet- ric"`. `cleanText()` fixes this with `(\w)- (\w)` → `$1$2`.

**Cross-page annotation gaps**: Highlights spanning page boundaries create two separate annotations (one per page). Text between them (e.g., the continuation of a split word on the next page's annotation start) is unrecoverable — the two annotations have no awareness of each other. This is expected behavior, not a bug.

### highlight-extract.js internals
- `highlightId()` — SHA1 of `{relPath, pageIndex, roundedQuadPoints, text}` → `hl-{hex16}`
- `rectId()` — SHA1 of `{relPath, pageIndex, roundedRect}` → `rect-{hex16}`
- `groupId()` — SHA1 of ordered member IDs → `grp-{hex16}` (stable across re-runs)
- `mtime` cache in `highlight-extract-state.json` — skip unmodified PDFs; **not updated in `--dry-run` mode**
- Sync-conflict files (`.sync-conflict-*`) filtered out before processing
- Supabase push uses `Prefer: resolution=ignore-duplicates` — fully idempotent

### Xodo annotation format quirks
- **quadPoints** returned as `[[{x,y},{x,y},{x,y},{x,y}], ...]` (array of quads, each quad = 4 `{x,y}` objects) — NOT the standard flat number array. `quadPointsToRects()` handles both formats.
- **color values** are 0–255 integers (TypedArray), not 0–1 floats. `classifyColor()` normalizes: `if (r > 1 || g > 1 || b > 1) { r/=255; g/=255; b/=255 }`.
- **Rectangle annotations** use `subtype === 'Square'` (standard PDF name for fixed-ratio rect tool). `annotation.rect` is `[x0, y0, x1, y1]` in PDF user units. No `quadPoints` field.

### Automation
- **Task Scheduler** job `SMGo-HighlightScan`: runs `C:\Program Files\nodejs\node.exe highlight-extract.js` every 5 minutes, `MultipleInstances=IgnoreNew`
- Also triggered at SM startup by plugin (`RunHighlightExtract()`)

---

## Syncthing Setup

- **Windows executable:** `C:\Users\deepak\AppData\Local\Microsoft\WinGet\Packages\Syncthing.Syncthing_...\syncthing.exe`
- **Web UI:** `http://127.0.0.1:8384` (API key in config)
- **Auto-start:** Task Scheduler job `Syncthing` at logon, `--no-browser` flag
- **Folder ID:** `sm-elements` → `C:\SuperMemo\systems\Facharzt\elements` (Send & Receive)
- **Devices:** Windows (DEEPAKBOSA055), S7 Tab (`L7IMDJC-…`), S25 Ultra (`5LYUWTW-…`)
- **Topology:** full mesh (Windows↔Tab, Windows↔S25, Tab↔S25 direct)
- Android: use **Syncthing-Fork** (Play Store), set battery to **Unrestricted** or it stops in background

---

## PWA Key Details

### Card rendering
- **pdf-extract**: heading shows `pdfFilename` without extension (e.g. `030-071 Neuroborreliose 2024-05`)
- **topic / cloze**: no heading — body content displayed directly
- **Q&A pairs**: topic cards ending with `?` whose `id+1` is a non-question topic are merged; question shown first, "Show Answer" button reveals answer. Both Q and A element IDs graded together.
- **Priority badge**: shown when Supabase is configured; color-coded `prio-high` (≤20%), `prio-mid` (≤50%), `prio-low` (>50%)

### Q&A pair detection (sm-parser.js)
Cards are merged in `getTodayCards()` post-processing:
1. Topic card body ends with `?`
2. Card at `id+1` exists, is type `topic`, does NOT end with `?`, and has non-empty body
→ `card.answer = answer.body`, `card.answerPairId = answer.id`, answer card removed from list

### Q&A rendering and interaction (app.js + style.css)
- Question shown immediately; "Show Answer" button calls `doReveal()` which unhides `#card-answer`
- On reveal, `.card` gets class `qa-revealed` → adaptive split layout:
  - `.card.qa-revealed` is `overflow-y: hidden` (no single scroll for the whole card)
  - `.card.qa-revealed .card-body.selectable` (question): `flex: 0 0 auto; max-height: 32vh; overflow-y: auto`
  - `.card.qa-revealed .card-answer` (answer block): `flex: 1; overflow-y: auto`
- Answer section has a horizontal-rule-style "Answer" divider (`.answer-divider`)
- `dismissCard()` dismisses both `card.id` and `card.answerPairId` — both IDs logged to Supabase so the answer element is also removed from Outstanding

### localStorage keys
| Key | Purpose |
|-----|---------|
| `smgo_theme` | `"dark"` or `"light"` |
| `smgo_server` | custom server URL (overrides isStaticMode detection) |
| `smgo_supa_url` | Supabase project URL |
| `smgo_supa_key` | Supabase anon key |
| `smgo_gemini_key` | Gemini API key |
| `smgo_gemini_model` | cached working Gemini model name |
| `smgo_extracts` | pending extract records |
| `smgo_items` | pending Q&A / cloze records |
| `smgo_progress_YYYY-MM-DD` | grades for that day |
| `smgo_last_sync` | ISO timestamp of last successful sync |

### isStaticMode()
Returns `true` (GitHub Pages, offline-only) unless:
- `smgo_server` is set in localStorage, OR
- hostname is localhost / 127.0.0.1 / LAN IP range

### Grade labels (SM18)
`0=Null, 1=Bad, 2=Fail, 3=Pass, 4=Good, 5=Bright`

### Text rendering
SM stores each PDF visual line as a separate `<p>`, producing `\r\n\n` between every wrapped line.
`normalizeBody()` in `app.js` rejoins soft-wrapped lines (heuristic: no sentence-ending punct + next block starts lowercase/digit). `formatBody()` wraps paragraphs in `<p>` tags.

### Service worker
Cache name: `smgo-v47` — **must bump on every meaningful deploy** or phone will serve stale JS.
Shell: `['./', './index.html', './app.js', './style.css', './manifest.json', './favicon.ico', './icons/icon-192.png', './icons/icon-512.png']`

### Manifest
`orientation: "portrait"` — locks PWA to portrait, overrides system rotation setting.

### Gemini Q&A
Probes 8 model variants in order, caches the first that works in `smgo_gemini_model`.
Model list: `gemini-2.5-flash`, `gemini-2.5-flash-lite-preview-06-17`, `gemini-2.5-flash-preview-05-20`, `gemini-2.0-flash`, `gemini-1.5-flash`

---

## How to Build & Deploy

```powershell
# Build plugin (close SMA first if DLL locked)
cd C:\SuperMemo\SMGo\SMAPlugin
"C:\Program Files\dotnet\dotnet.exe" build -c Release
# DLL auto-copies to plugin store on success; if locked, copy manually:
Copy-Item -Force "bin\Release\net472\SuperMemoAssistant.Plugins.SMGo.dll" `
  "$env:USERPROFILE\SuperMemoAssistant\Plugins\Packages\SuperMemoAssistant.Plugins.SMGo.1.0.0\lib\net472\SuperMemoAssistant.Plugins.SMGo.dll"

# Deploy PWA — always bump sw.js CACHE version first, then:
cd C:\SuperMemo\SMGo
git add docs/ [other changed files]
git commit -m "description"
git push
# GitHub Pages deploys in ~1-2 minutes
# Phone: close PWA from recents, reopen to force SW update
```

---

## Gotchas & Lessons Learned

1. **DLL locked by SMA** — SMA holds the plugin DLL while running. Always close SuperMemo + SMA before building or `Copy-Item -Force` will fail silently (build succeeds, old DLL remains).

2. **MSBuild v4 can't build SDK-style projects** — The system MSBuild (invoked as `msbuild`) is v4.0 and rejects the `.csproj`. Always use `"C:\Program Files\dotnet\dotnet.exe" build`.

3. **`ElementBuilder` constructor, not `.WithContent()`** — SMA Interop's `ElementBuilder` takes `params ContentBase[]` directly in the constructor. There is no `.WithContent()` method. Pattern: `new ElementBuilder(ElementType.Item, new TextContent(true, html1), new TextContent(true, html2))`.

4. **isStaticMode() false positive** — PWA installed from GitHub Pages has a `.io` hostname, so `isStaticMode()` returned `true` even on home WiFi, blocking LAN sync. Fixed: also return `false` if `smgo_server` is set in localStorage.

5. **Android copy/paste menu covers floating buttons** — Long-press to select text on Android shows the system copy/paste toolbar, which covers any floating button near the selection. Moved extract/cloze/Q&A buttons to the bottom action bar (`#selection-bar`) instead.

6. **`surroundContents()` throws on cross-element selections** — When a text selection spans multiple `<p>` tags, `range.surroundContents(mark)` throws `HierarchyRequestError`. Use `mark.appendChild(range.extractContents()); range.insertNode(mark)` instead.

7. **SM PDF text = soft-wrapped lines stored as separate paragraphs** — Each visual line from a PDF becomes its own `<p>` element, producing `\r\n\n` between every line after HTML stripping. Using `white-space: pre-wrap` makes this hideous. Fixed with `normalizeBody()` heuristic + `<p>` tag rendering.

8. **Service worker cache must be bumped manually** — There is no automatic cache invalidation. If you push new JS/CSS without bumping the cache version in `sw.js`, every installed PWA continues serving the old files. Bump `CACHE = 'smgo-vN'` on every deploy.

9. **`System.Net.Http` not auto-referenced in net472** — Adding `using System.Net.Http;` is not enough. Requires explicit `<Reference Include="System.Net.Http" />` in the `.csproj` for .NET Framework 4.7.2.

10. **Plugin can't find `node` directly** — Running `node script.js` as a `ProcessStartInfo` FileName doesn't find node because the plugin process doesn't inherit the user's PATH. Fix: use `cmd.exe /c node script.js` which does inherit PATH.

11. **Supabase anon key can't run DDL** — PostgREST (the Supabase REST layer) only handles data operations, never schema changes. Created a `smgo_setup()` stored function with `security definer` and `grant execute to anon` so `export-cloud.js` can auto-create tables.

12. **PATCH method in .NET HttpClient** — `HttpMethod.Patch` doesn't exist in .NET Framework 4.7.2's `HttpMethod` class. Use `new HttpMethod("PATCH")`.

13. **Supabase `Prefer: return=minimal` on PATCH** — Without this header, Supabase tries to return the updated row and may error. Always include it on PATCH requests.

14. **Gemini model names vary by project/region** — `gemini-2.0-flash` works in some projects, not others. 404 = model not found (not API error). Solved with an ordered probe list that caches the first working model.

15. **Duplicate `OnSMStopped()` causes silent compile failure** — Added the method twice during iterative edits. C# gives a clear error but it's easy to miss if not checking build output carefully.

16. **`config.json` must be gitignored** — Contains Supabase credentials. Add to `.gitignore` before first commit or credentials end up in public repo history.

17. **`IElementWdw.Done()` shows a confirmation dialog** — `Svc.SM.UI.ElementWdw.Done()` triggers SM's UI dismiss dialog. Use `Svc.SM.Registry.Element[id].Done()` instead — calls the engine directly, no dialog, marks element as Dismissed immediately.

18. **`SetElementState` is not for learning state** — Despite the name, `IElementWdw.SetElementState` controls the *display* mode of the element window (e.g. question/answer view), not the learning state (Memorized/Dismissed). Cannot be used to dismiss elements.

19. **priority.sub format** — Flat array of 4-byte little-endian uint32 element IDs. Position in array = priority rank. `priority% = index / total × 100` (lower % = higher priority = earlier in array). Read/write directly with `BitConverter`; changes take effect on next SM startup.

20. **Xodo quadPoints format differs from PDF spec** — Standard PDF highlight annotations store quadPoints as a flat array of numbers (8 per quad). Xodo stores them as an array of arrays of `{x, y}` objects: `[[{x,y}×4], ...]`. Always handle both formats. Also: Xodo colors are 0–255 integer TypedArrays, not 0–1 floats — normalize before classifying.

21. **dry-run must not update mtime state** — If `highlight-extract.js --dry-run` writes to `highlight-extract-state.json`, subsequent real runs will skip those PDFs. Always guard state writes with `if (!DRY_RUN)`.

22. **Task Scheduler needs full path to node** — Scheduled tasks run in a stripped environment that may not have user PATH. Use `C:\Program Files\nodejs\node.exe` as the executable, not just `node`.

23. **Syncthing-Fork stops on Android with battery optimization** — Samsung's aggressive power management kills Syncthing-Fork when the screen is off unless battery is set to **Unrestricted** in App settings. Symptoms: device shows "Disconnected" in Syncthing UI after screen timeout.

24. **Syncthing folder share popup appears in web UI, not system notifications** — On Android, the "remote device wants to share folder X" notification does not appear as a system notification. Must open Syncthing-Fork → web UI (globe icon) to see and accept it.

25. **`ElemCreationFlags.CreateSubfolders` redirects to a concept subfolder** — Using this flag when adding a child element to a Topic (e.g. a PDF element) causes SM to auto-create a concept subfolder and place the new element there, not directly under the specified parent. Use `ElemCreationFlags.None` to place extracts exactly under `parentId`.

26. **Universal PDF DRM breaks Acrobat saves (error 110)** — Some PDFs contain a "Universal PDF" trade-secret marker in their internal structure. Acrobat errors with code 110 when trying to save over such files. Fix: rewrite with pypdf — `r=pypdf.PdfReader('file.pdf', strict=False); w=pypdf.PdfWriter(); w.append(r); w.write('file_repaired.pdf')`. After repair Acrobat may still show error 110 but saves successfully.

27. **Mac annotation via Parallels** — Windows running in Parallels is accessible from macOS via SMB at `\\Mac\AllFiles\Windows\...` (Z: drive from Windows, or via Finder → Network → WINDOWS-MACHINE). Mac apps can read files but cannot save back to Windows paths reliably (SMB write fails for some apps). Workaround: annotate PDFs on Windows inside Parallels (Acrobat Reader, Xodo Windows) or on Android (Xodo). PDF Expert on Mac has this limitation and also doesn't snap text highlights on network-share PDFs.

28. **`@napi-rs/canvas` + pdfjs ARM64 shim** — pdfjs-dist requires a module named exactly `canvas` for server-side rendering. The standard `canvas` npm package has no ARM64 Windows prebuilts. Solution: install `@napi-rs/canvas` and create a shim at `node_modules/canvas/index.js` containing `module.exports = require("@napi-rs/canvas");` with matching `package.json`. This must be recreated after `npm ci` clears node_modules.

29. **SM element ID ≠ PDF filename number (usually)** — In SM's Incremental PDF Reader, PDF files are stored in the elements folder as `{elementId}.pdf`. So `7.pdf` corresponds to SM element ID 7. The `getElementId()` function parses the filename integer and uses it as `parentId` for new child extracts — this is correct.

30. **Q&A dismiss must cover both element IDs** — A Q&A pair merges two SM elements (question at `id`, answer at `id+1`). `dismissCard()` must dismiss both `card.id` and `card.answerPairId`. Dismissing only the question card leaves the answer in Outstanding; it surfaces as an orphan topic card on the next review.

31. **Q&A adaptive layout via `qa-revealed` class** — On reveal, add class `qa-revealed` to `.card`. Use `flex: 0 0 auto; max-height: 32vh; overflow-y: auto` on the question block and `flex: 1; overflow-y: auto` on the answer block. Without this, the question fills most of the card and the answer is squeezed into a few lines at the bottom.

32. **Hyphenation artifacts in PDF-extracted text** — Two-column PDFs (e.g. Harrison's Neurology) store words split at line breaks as separate text items: `"asymmet-"` and `"ric"`. After `join(' ')` they become `"asymmet- ric"`. Regex `/-\n-/` never matches (no `\n` after join). Fix in `cleanText()`: `.replace(/(\w)- (\w)/g, '$1$2')` catches the hyphen-space artifact.

33. **Cross-page annotation gaps are unrecoverable** — When a highlight spans a page boundary, pdfjs creates two annotations (one per page). The text between where the first annotation ends on page N and where the second begins on page N+1 is not captured. "and distal?" at the start of a page-584 annotation is correct behavior — the preceding text was on page 583 and not highlighted.
