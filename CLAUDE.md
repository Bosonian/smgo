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
Phone (PWA — GitHub Pages)
        │  reads cards from         │  pushes extracts/grades/items via
        ▼                           ▼
  Supabase (cloud)  ◄──────────────────────────────────
        │                           │
        │  plugin polls every 30s   │  plugin runs export-cloud.js on SM open
        ▼                           │
  Desktop (SuperMemo + SMA plugin) ─┘
```

Two sync paths:
- **Cloud (Supabase)** — works from anywhere, primary path
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
│   ├── manifest.json
│   ├── icons/
│   └── data/today.json      ← exported cards for static/offline mode
├── SMAPlugin/
│   ├── SMGoPlugin.cs        ← C# SMA plugin (HTTP server + file watchers + Supabase poller)
│   └── SuperMemoAssistant.Plugins.SMGo.csproj
├── sm-parser.js             ← reads SM Outstanding.sub + element HTML → card objects
├── server.js                ← optional Node.js server (same API as SMA plugin, port 3001)
├── export.js                ← manual: generates today.json + git push
├── export-cloud.js          ← auto: pushes today's cards to Supabase (run by plugin on startup)
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
- **DLL install path:** `C:\Users\deepak\SuperMemoAssistant\Plugins\Packages\SuperMemoAssistant.Plugins.SMGo.1.0.0\lib\net472\`
- **Build:** `"C:\Program Files\dotnet\dotnet.exe" build -c Release` (MSBuild v4 won't work — SDK-style project requires dotnet CLI)
- **Config file:** reads `config.json` at startup for Supabase credentials
- **On SM open:** waits 5s → runs `cmd.exe /c node export-cloud.js` → pushes today's cards to Supabase
- **Supabase poller:** starts 15s after SM open, then every 30s — fetches `applied=false` rows, applies, PATCHes `applied=true`
- **File watchers:** `grades/`, `extracts/`, `items/`, `dismisses/` — local fallback for LAN-only sync
- **Routes:** GET `/api/today`, POST `/api/grades`, POST `/api/extracts`, GET `/api/extracts`, POST `/api/items`, POST `/api/dismiss`, POST `/api/apply`, GET `/api/images/:id`

### Applying items to SM
- Extract → `ElementType.Topic` with `TextContent`, `.WithParent(parentId)`, `.DoNotDisplay()`
- Q&A → `ElementType.Item` with two `TextContent` args (question, answer)
- Cloze → `ElementType.Item`, regex `[word]` → `<span style="color:blue">[...]</span>`
- Grade → `GoToElement(id)` + sleep 400ms + `AssignGrade(grade)` + sleep 200ms
- Dismiss → `GoToElement(id)` + sleep 400ms + `Done()`
- `ElementBuilder(ElementType, params ContentBase[])` — no `.WithContent()` method, pass contents in constructor

---

## PWA Key Details

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
Cache name: `smgo-v16` — **must bump on every meaningful deploy** or phone will serve stale JS.
Shell: `['./','./index.html','./app.js','./style.css','./manifest.json','./icons/icon-192.png','./icons/icon-512.png']`

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
