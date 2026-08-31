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
├── server.js                ← limited legacy LAN server (grades/extracts + card serving only)
├── export.js                ← manual: generates today.json only; publishing is explicit
├── export-cloud.js          ← auto: pushes today's cards to Supabase (run by plugin on startup)
├── highlight-extract.js     ← scans SM element PDFs for annotations → pushes to Supabase
│                               run automatically every 5 min by Task Scheduler
├── state/highlight-extract-<collection-id>.json  ← mtime cache per collection — GITIGNORED
├── config.json              ← Supabase credentials — GITIGNORED, never commit
└── .gitignore
```

---

## SM Collection

- The active collection is detected by the SMA plugin. Do not configure a
  collection path in source code; manual Node runs use `collection.path` in
  ignored `config.json`.
- Element files: `elements/{floor((id-1)/10)}/{id}.htm` (ids 1-10 in root)
- Outstanding elements: `info/Outstanding.sub` — flat array of 4-byte little-endian uint32 IDs
- Card types parsed: `topic`, `cloze`, `pdf-extract`, `image`

---

## Supabase

- Project URL: `https://psqbpimlszjhpbdckwsj.supabase.co`
- Anon key: in `config.json` (key: `supabaseKey`)
- Tables:
  - `smgo_queue` — collection-scoped commands (`id text PK, collection_id, type, payload jsonb, applied bool`)
  - `smgo_daily` — collection-scoped exports (`collection_id, review_date` composite key, `data jsonb`)
- Both tables have RLS policy `"open"` (allow all — personal project)
- `smgo_setup()` RPC function auto-creates tables if missing; called by `export-cloud.js` on every run
- PWA localStorage keys for Supabase: `smgo_supa_url`, `smgo_supa_key`

---

## SMA Plugin

- **Port:** 3001 (HttpListener on `http://+:3001/`)
- **DataDir:** `C:\SuperMemo\SMGo`
- **CollectionInfoDir:** `<active collection>\info` (derived by the plugin)
- **DLL install path:** `C:\Users\deepak\SuperMemoAssistant\Plugins\Packages\SuperMemoAssistant.Plugins.SMGo.1.0.0\lib\net472\`
- **Build:** `"C:\Program Files\dotnet\dotnet.exe" build -c Release` (MSBuild v4 won't work — SDK-style project requires dotnet CLI)
- **Config file:** reads `config.json` at startup for Supabase credentials
- **On SM open:** waits 5s → runs `export-cloud.js` then `highlight-extract.js` via `cmd.exe /c node`
- **Supabase poller:** starts 15s after SM open, then every 30s — fetches `applied=false` rows, applies, PATCHes `applied=true`
- **File watchers:** `queues/<collection-id>/{grades,extracts,items,dismisses}` — local fallback for LAN-only sync
- **Routes:** GET `/api/today`, POST `/api/grades`, POST `/api/extracts`, GET `/api/extracts`, POST `/api/items`, POST `/api/dismiss`, POST `/api/apply`, GET `/api/images/:id`

### Applying items to SM
- Extract → `ElementType.Topic` with `TextContent`, `.WithParent(parentId)`, `.DoNotDisplay()`
- Q&A → `ElementType.Item` with two `TextContent` args (question, answer)
- Cloze → `ElementType.Item`, regex `[word]` → `<span style="color:blue">[...]</span>`
- Grade → guarded attempt only. The installed SMA core does not implement the newer remoting methods needed for a verified repetition, so unsupported commands remain pending.
- Dismiss → guarded attempt only. `Registry.Element[id].Done()` throws `NotImplementedException` in the installed SMA core; unsupported commands remain pending and no live queue file is rewritten.
- Priority → reads/writes `info/priority.sub` directly (flat uint32 array, position = rank)
- `ElementBuilder(ElementType, params ContentBase[])` — no `.WithContent()` method, pass contents in constructor
- **pdf-extract-create** → creates SM element from `payload.segments[]`; each segment is `{kind:'text', text}` or `{kind:'image', dataUrl?}` or `{kind:'image', imgPath?}`; `imgPath` is rendered as `<img src="file:///...">` with backslashes converted to forward slashes
- **ElemCreationFlags.None** — used for all `Element.Add()` calls; `CreateSubfolders` was causing new elements to land in an auto-created concept subfolder instead of directly under the specified parent

### Supabase queue types handled by plugin
| type | payload fields | effect |
|------|---------------|--------|
| `grade` | `elementId`, `grade` | guarded attempt; remains pending when the SMA bridge rejects it |
| `extract` | `parentId`, `text` | create child Topic element |
| `pdf-extract-create` | `parentId`, `segments[]` | create child Topic with multiple paragraphs |
| `cloze` | `parentId`, `sentence`, `answer` | create Item with cloze blank |
| `qa` | `parentId`, `question`, `answer` | create Item |
| `dismiss` | `elementId` | guarded attempt; remains pending when `element.Done()` is unavailable |
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
- `mtime` cache in `state/highlight-extract-<collection-id>.json` — skip unmodified PDFs; **not updated in `--dry-run` mode**. Legacy Facharzt state requires one explicit `--import-legacy-highlight-state` run.
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
- **Folder ID:** `sm-elements` → `<active collection>\elements` (Send & Receive)
- **Devices:** Windows (DEEPAKBOSA055), S7 Tab (`L7IMDJC-…`), S25 Ultra (`5LYUWTW-…`)
- **Topology:** full mesh (Windows↔Tab, Windows↔S25, Tab↔S25 direct)
- Android: use **Syncthing-Fork** (Play Store), set battery to **Unrestricted** or it stops in background

---

## PWA Key Details

### Card rendering
- **pdf-extract**: heading shows `pdfFilename` without extension (e.g. `030-071 Neuroborreliose 2024-05`)
- **empty PDF wrappers**: omit a PDF wrapper when page-text enrichment returns an empty body; the PWA cannot review it and must not show a misleading empty card
- **topic / cloze**: no heading — body content displayed directly
- **Q&A safety**: never infer a Q&A pair merely because a topic ends in `?` and the next element is a non-question topic. Incremental-reading extracts are frequently adjacent and unrelated. Native Q&A items must be parsed from their explicit question/answer components.
- **Priority badge**: shown when Supabase is configured; color-coded `prio-high` (≤20%), `prio-mid` (≤50%), `prio-low` (>50%)

### Q&A parsing (sm-parser.js)
Adjacent element IDs are not relationship metadata. Parse native Q&A items from their explicit SuperMemo components; until component-aware parsing is available, keep adjacent topics independent rather than risk showing a wrong answer.

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
Cache name: `smgo-v53` — **must bump on every meaningful deploy** or phone will serve stale JS.
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

17. **Neither exposed dismissal path is production-safe in the installed runtime** — `Svc.SM.UI.ElementWdw.Done()` invokes SuperMemo's interactive Done operation and may display confirmation/statistics dialogs. `Svc.SM.Registry.Element[id].Done()` throws `NotImplementedException` in the installed SMA core. Keep dismiss commands pending; do not automate either path or edit live queue files.

18. **`SetElementState` is not for learning state** — Despite the name, `IElementWdw.SetElementState` controls the *display* mode of the element window (e.g. question/answer view), not the learning state (Memorized/Dismissed). Cannot be used to dismiss elements.

19. **priority.sub format** — Flat array of 4-byte little-endian uint32 element IDs. Position in array = priority rank. `priority% = index / total × 100` (lower % = higher priority = earlier in array). Read/write directly with `BitConverter`; changes take effect on next SM startup.

20. **Xodo quadPoints format differs from PDF spec** — Standard PDF highlight annotations store quadPoints as a flat array of numbers (8 per quad). Xodo stores them as an array of arrays of `{x, y}` objects: `[[{x,y}×4], ...]`. Always handle both formats. Also: Xodo colors are 0–255 integer TypedArrays, not 0–1 floats — normalize before classifying.

21. **dry-run must not update mtime state** — If `highlight-extract.js --dry-run` writes to the collection-scoped `state/highlight-extract-<collection-id>.json`, subsequent real runs will skip those PDFs. Always guard state writes with `if (!DRY_RUN)`.

22. **Task Scheduler needs full path to node** — Scheduled tasks run in a stripped environment that may not have user PATH. Use `C:\Program Files\nodejs\node.exe` as the executable, not just `node`.

23. **Syncthing-Fork stops on Android with battery optimization** — Samsung's aggressive power management kills Syncthing-Fork when the screen is off unless battery is set to **Unrestricted** in App settings. Symptoms: device shows "Disconnected" in Syncthing UI after screen timeout.

24. **Syncthing folder share popup appears in web UI, not system notifications** — On Android, the "remote device wants to share folder X" notification does not appear as a system notification. Must open Syncthing-Fork → web UI (globe icon) to see and accept it.

25. **`ElemCreationFlags.CreateSubfolders` redirects to a concept subfolder** — Using this flag when adding a child element to a Topic (e.g. a PDF element) causes SM to auto-create a concept subfolder and place the new element there, not directly under the specified parent. Use `ElemCreationFlags.None` to place extracts exactly under `parentId`.

26. **Universal PDF DRM breaks Acrobat saves (error 110)** — Some PDFs contain a "Universal PDF" trade-secret marker in their internal structure. Acrobat errors with code 110 when trying to save over such files. Fix: rewrite with pypdf — `r=pypdf.PdfReader('file.pdf', strict=False); w=pypdf.PdfWriter(); w.append(r); w.write('file_repaired.pdf')`. After repair Acrobat may still show error 110 but saves successfully.

27. **Mac annotation via Parallels** — Windows running in Parallels is accessible from macOS via SMB at `\\Mac\AllFiles\Windows\...` (Z: drive from Windows, or via Finder → Network → WINDOWS-MACHINE). Mac apps can read files but cannot save back to Windows paths reliably (SMB write fails for some apps). Workaround: annotate PDFs on Windows inside Parallels (Acrobat Reader, Xodo Windows) or on Android (Xodo). PDF Expert on Mac has this limitation and also doesn't snap text highlights on network-share PDFs.

28. **`@napi-rs/canvas` + pdfjs ARM64 shim** — pdfjs-dist requires a module named exactly `canvas` for server-side rendering. The standard `canvas` npm package has no ARM64 Windows prebuilts. Solution: install `@napi-rs/canvas` and create a shim at `node_modules/canvas/index.js` containing `module.exports = require("@napi-rs/canvas");` with matching `package.json`. This must be recreated after `npm ci` clears node_modules.

29. **SM element ID ≠ PDF filename number (usually)** — In SM's Incremental PDF Reader, PDF files are stored in the elements folder as `{elementId}.pdf`. So `7.pdf` corresponds to SM element ID 7. The `getElementId()` function parses the filename integer and uses it as `parentId` for new child extracts — this is correct.

30. **Never infer Q&A from adjacent IDs** — Adjacent outstanding Topics are not relationship metadata. SMGo-created Q&A Items are one native SuperMemo Item with explicit question/answer components. The question component now carries `data-smgo-type="qa"` and a UTF-8 base64 answer so the exporter can reconstruct the card without guessing. `answerPairId` remains only for legacy payload compatibility; new native Items are graded/dismissed by their single element ID.

31. **Q&A adaptive layout via `qa-revealed` class** — On reveal, add class `qa-revealed` to `.card`. Use `flex: 0 0 auto; max-height: 32vh; overflow-y: auto` on the question block and `flex: 1; overflow-y: auto` on the answer block. Without this, the question fills most of the card and the answer is squeezed into a few lines at the bottom.

32. **Hyphenation artifacts in PDF-extracted text** — Two-column PDFs (e.g. Harrison's Neurology) store words split at line breaks as separate text items: `"asymmet-"` and `"ric"`. After `join(' ')` they become `"asymmet- ric"`. Regex `/-\n-/` never matches (no `\n` after join). Fix in `cleanText()`: `.replace(/(\w)- (\w)/g, '$1$2')` catches the hyphen-space artifact.

33. **Cross-page annotation gaps are unrecoverable** — When a highlight spans a page boundary, pdfjs creates two annotations (one per page). The text between where the first annotation ends on page N and where the second begins on page N+1 is not captured. "and distal?" at the start of a page-584 annotation is correct behavior — the preceding text was on page 583 and not highlighted.

34. **Supabase HTTPS hang causes silent export failure** — `supaRequest()` in both `export-cloud.js` and `highlight-extract.js` had no timeout. If Supabase is paused, unreachable, or slow at SM startup, the HTTPS request hangs indefinitely. The plugin's `WaitForExit(30000)` times out after 30s, gets empty stdout+stderr, and logs nothing — completely silent failure, no error in the log. The orphaned node process keeps running in the background. Fix applied (2026-06-21): `req.setTimeout(20000, () => req.destroy(new Error(...)))` added to `supaRequest` in both scripts. Now fails fast with a logged error instead of silently blocking the plugin's startup export.

35. **Collections are now first-class (2026-08-24)** — Never hard-code a SuperMemo collection path. `SMGoPlugin.OnCollectionSelected()` derives the active root/path ID and passes it to Node exports. `smgo_daily` uses `(collection_id, review_date)` and every `smgo_queue` row/payload has `collection_id` / `collectionId`. The plugin filters and rechecks that ID before applying any command; untagged legacy commands are quarantined under `legacy-facharzt`. Run `supabase-migration-collections.sql` once before using the new schema. Local fallback queues are under `queues/<collection-id>/` and PWA localStorage is collection-scoped.

36. **Collection identity and legacy migration (2026-08-24)** — IDs are `collection-<readable-slug>-<12-char-sha256>` over the NFC-normalized canonical Windows collection path. JS and C# share fixtures; do not supply a custom ID. Queue payloads use `protocolVersion: 2`, `collectionId`, and `commandId` matching the row ID. The plugin snapshots a collection generation before polling or reading a local file, checks again immediately before mutation, and leaves a file unacknowledged if any record fails or mismatches. PWA legacy Facharzt browser data needs an explicit `IMPORT` confirmation; legacy highlight cache needs `--import-legacy-highlight-state` once.

37. **Empty exports are connected states, not completed sessions (2026-08-24)** — A newly created collection may have element files but no `info/Outstanding.sub`; exporting it correctly produces zero cards. The PWA must show the collection-aware empty state (`<collection> is connected`, last export time, Refresh) rather than calling `syncAndDone()` or implying that reviews occurred. Loading/error/empty screens must remain inside the content area, not cover the header, so Settings and Refresh remain reachable.

38. **Saved-action UI must include every persisted queue type (2026-08-24)** — The header badge counts extracts, cloze/Q&A items, and edits/notes, so the drawer, sync totals, and cleanup logic must use those same three stores. Never offer a blanket clear operation that silently deletes unsynced work. The PWA now labels each record Pending/Synced, confirms individual deletion of unsynced records, and only bulk-removes synced records.

39. **PWA network and dialog reliability (2026-08-24)** — Initial Supabase, static JSON, LAN, and Gemini requests use bounded fetch timeouts so a dead endpoint cannot leave an infinite spinner. The Settings UI is a real dialog with validation and a Supabase schema connection test; do not revert it to numbered `prompt()` calls. All dialogs, including priority and settings, participate in Escape handling, focus containment, and focus restoration. Service-worker shell version is currently `smgo-v53`, including the 180px Apple touch icon.

40. **Neuro100x integration was evaluated and deliberately rejected (2026-08-24)** — Keep SMGo and Neuro100x Personal SRS as separate PWAs, origins, credentials, service workers, offline queues, grading interfaces, and scheduling authorities. SMGo remains the SuperMemo 18 companion; Neuro100x remains an authenticated projection of its Mac-authoritative append-only FSRS journal. Do not map SM grades to FSRS ratings, intermingle review queues, copy cards automatically, or place Neuro100x authentication in the SMGo origin. Acceptable future integration is limited to consistent visual conventions and explicit reciprocal launch links that exchange no credentials, card content, or review state.

41. **Cloud mutation batches re-export once (2026-08-31)** — The startup export occurs before the first Supabase poll. Track whether any collection-scoped queue command applied successfully and run one consolidated `RunExportCloud()` after the batch so new Q&A/cloze/extract Items and dismissals reach the PWA in the same SM/SMA session.

42. **PWA card completeness audit and source repair (2026-08-31)** — Reconciled every Endgame outstanding ID against its element file, parser output, and cloud row. Elements 9–15 contained sentence fragments in SuperMemo itself; their complete sentences were recovered verbatim from Bradley's PDF and the originals were backed up under `%TEMP%\smgo-endgame-card-repair-2026-08-31`. Do not interpret SuperMemo's `[...]` incremental-reading extraction markers as PWA truncation. Outstanding element 39 has no corresponding element file and is deliberately omitted rather than fabricated.

43. **Explicit Q&A/cloze round-trip metadata (2026-08-31)** — `ApplyOneQA` writes `data-smgo-answer-b64`; `ApplyOneCloze` writes `data-smgo-sentence-b64`. `sm-parser.js` decodes those markers, supports Unicode, and emits native `qa`/`cloze` cards. Cloze rendering hides the actual bracketed answer text and reveals it on demand. Never restore the old `topic ends with ? + id+1` heuristic.

44. **Empty PDF wrappers are not review cards (2026-08-31)** — PDF wrapper elements whose page-text enrichment produces an empty body are excluded by both local and cloud exports. This prevents `No renderable content` cards while retaining PDF cards that successfully produce page text.

45. **SMA grade API incompatibility remains open (2026-08-31)** — The Interop interface exposes `IElementWdw.AssignGrade`, but the running SMA remoting service reports `method AssignGrade not found`. Grade commands remain pending safely and do not block later queue commands. A tightly scoped UI applicator was used for recovery, but automatic plugin grading still needs a supported runtime call or guarded fallback.

46. **Cloud creation is idempotent across crashes (2026-08-31)** — Every cloud-created extract, Q&A, cloze, image, PDF extract, and edit carries a hidden `data-smgo-command-b64` marker. Before replaying a create command, the plugin searches the active collection for that marker. Failed acknowledgements remain retryable without duplicate creation.

47. **Queue rows are immutable commands (2026-08-31)** — The PWA inserts rows with `applied:false` and `resolution=ignore-duplicates`; it must never merge over an existing command because that could reset an applied row. Desktop processing orders creates first and dismissals last, with command ID as the deterministic tie-breaker.

48. **Unsupported mutations fail closed (2026-08-31)** — Do not use `SendKeys` as an automatic grade fallback and do not rewrite `Outstanding.sub`/`priority.sub` while SuperMemo is running as a dismiss fallback. Those commands stay pending until a collection-checked, verifiable mechanism exists. The manual exporter generates data only; publishing is an explicit Git operation.

49. **SMA bridge version gap confirmed (2026-09-01)** — The installed SMA application is `2.1.0-beta.21`, SMGo references Interop `2.1.0-beta.26`, and the last official SMA core source targets Interop `2.1.0-beta.18`. Interop later advertised `AssignGrade`, `ExecuteRepetition`, `BeginLearning`, and `Exit`, but the official core never implemented those methods. Interface presence is not proof of runtime support.

50. **A verified grade is a two-stage native operation (2026-09-01)** — Investigation indicates that a correct SM18 repetition requires writing and verifying `TElWind.RecentGrade` as a signed byte in the range 0–5, then invoking `TElWind.ExecuteUncommittedRepetition`. Calling `AssignGrade` alone is insufficient. A temporary compatibility core implementing this sequence compiled cleanly, but it was experimental and was not retained or deployed.

51. **Aborted bridge test and complete rollback (2026-09-01)** — Runtime testing used the disposable clone `C:\SuperMemo\systems\SMGoBridgeTest`, never Endgame. Two SM processes inadvertently opened that clone and produced repeating old-statistics/access-denied dialogs, so SM and SMA were force-closed. The original SMA core was restored (`D72B53BF472BBE99B5C64F82587AA2FEF2981FC9116BB474CB9D2C87721075FE`) and the stable fail-closed SMGo plugin was rebuilt and installed (`0662BE8F3A586FD93F723EDA18F9033425F65F844E07B49B220FDFFC0D386237`). No experimental bridge code is installed or committed. Do not open the disposable clone; remove it only with explicit approval.

52. **Repeated PWA dismissal is expected while dismissal is unsupported (2026-09-01)** — Cards dismissed in the PWA can reappear after the next export because the corresponding SuperMemo elements remain outstanding. Dismissing them again records another client intent but does not make the SuperMemo dismissal durable. Treat repeated dismiss rows as unresolved commands, not new cards and not proof of corruption. Do not keep retrying automatically or mark them applied until a verified bridge exists.

53. **Current stable boundary after rollback (2026-09-01)** — Repository behavior remains the hardened fail-closed design at/after `d845c8e`: export, rendering, Q&A/cloze/extract creation, explicit metadata, idempotency, collection isolation, and priority handling remain supported; automatic grade and dismiss remain pending. The regression suite has 20 passing tests and the Release plugin builds with zero warnings/errors.

54. **Whole-card Q&A generation (2026-09-01)** — The persistent `Card → Q&A` action sends the complete readable card content (title/body/answer/cloze source, deduplicated) to Gemini and requires 2–8 independent, non-overlapping cards according to source length. Generated pairs are editable and individually removable before one collection-scoped batch is saved. The selection toolbar remains available for generating one focused Q&A. Each generation owns an immutable parent context, request token, and abort signal so cancelled/superseded responses cannot attach to another card. Whole-card upload requires a first-use privacy acknowledgement; very large cards get an additional quota warning. Saves are local-first, immediately attempt cloud delivery, and report whether work synced or remains pending. Service-worker shell version is `smgo-v53`.

## Endgame operational status (2026-09-01)

- Active collection ID: `collection-endgame-1d821730858a`.
- The stable Release plugin is installed in SMA's package store and hash-matched to the build output (`0662BE8F…6237`). The original SMA core is restored (`D72B53BF…75FE`); no experimental bridge is active.
- The Q&A creation commands were previously processed. Known unresolved mutations included dismissals and one grade for element 15; the user dismissed redisplayed cards again on 2026-09-01, so exact pending-row counts must be queried from Supabase before any future remediation.
- Creates are processed before dismissals. Unsupported dismissals and grades remain pending instead of editing live collection files or driving unverified UI actions.
- After opening SMA and Endgame, allow 30–60 seconds for the first poll and same-session re-export before refreshing the PWA. Redisplayed dismissed cards currently indicate the known unsupported dismissal path.
- Regression suite after this session: 20 tests passing; plugin compiles with zero C# warnings/errors and the installed DLL hash matches the build.

## Current local collection onboarding (2026-08-24)

- `C:\SuperMemo\systems\Endgame` was created and opened successfully.
- Its deterministic ID is `collection-endgame-1d821730858a`.
- The collection-aware Supabase migration was run and verified by selecting
  `collection_id` and `review_date` from `smgo_daily`.
- The Release SMA plugin DLL was built, installed, and hash-verified against the
  build output.
- `config.json` points manual Node commands at Endgame; it remains gitignored
  because it contains Supabase credentials.
- The first cloud export returned HTTP 201 and was verified in `smgo_daily` for
  2026-08-24 with zero cards. This is expected until Endgame has an
  `info/Outstanding.sub` daily queue.
