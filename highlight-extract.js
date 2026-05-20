'use strict';
// Scans SM collection PDFs for highlight annotations made in Xodo (or any standard
// PDF annotator) and pushes new highlights to Supabase as SM extract items.
// Run automatically by the SMA plugin on SM startup, or manually:
//   node highlight-extract.js
//   node highlight-extract.js --dry-run   (log only, no Supabase push)

const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const crypto  = require('crypto');

let pdfjsLib;
try {
  pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  pdfjsLib.GlobalWorkerOptions.workerSrc = ''; // disable worker in Node.js
} catch { console.error('SMGo highlight-extract: pdfjs-dist not found'); process.exit(0); }

// ── Config ─────────────────────────────────────────────────────────────────

let config;
try { config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8')); }
catch { console.error('SMGo highlight-extract: config.json not found'); process.exit(0); }

if (!config.supabaseUrl || !config.supabaseKey) {
  console.error('SMGo highlight-extract: config.json missing supabaseUrl / supabaseKey');
  process.exit(0);
}

const ELEMENTS_DIR = 'C:\\SuperMemo\\systems\\Facharzt\\elements';
const STATE_FILE   = path.join(__dirname, 'highlight-extract-state.json');
const DRY_RUN      = process.argv.includes('--dry-run');

const base    = config.supabaseUrl.replace(/\/$/, '');
const headers = {
  apikey:          config.supabaseKey,
  Authorization:  `Bearer ${config.supabaseKey}`,
  'Content-Type':  'application/json',
};

// ── Supabase ───────────────────────────────────────────────────────────────

function supaRequest(reqPath, method, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url  = new URL(base + reqPath);
    const data = body ? JSON.stringify(body) : '';
    const opts = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method,
      headers:  { ...headers, ...extraHeaders, 'Content-Length': Buffer.byteLength(data) },
    };
    const req = https.request(opts, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── State (mtime cache — skips unmodified PDFs on re-runs) ─────────────────

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')); }
  catch { return {}; }
}

function saveState(state) {
  // Atomic write via temp file + rename to avoid corruption on crash mid-write
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// ── Helpers ────────────────────────────────────────────────────────────────

// SM element ID is the numeric PDF filename: elements/50/500.pdf → 500
function getElementId(pdfPath) {
  const base = path.basename(pdfPath, path.extname(pdfPath));
  const id   = parseInt(base, 10);
  return Number.isInteger(id) && String(id) === base ? id : null;
}

// Syncthing conflict copies: 500.sync-conflict-20260521-123456-ABCD.pdf
function isSyncConflict(filename) {
  return filename.includes('.sync-conflict-');
}

// Classify highlight color for logging. All colors are extracted by default —
// change COLOR_ACTION to 'skip' for colors you want to ignore.
const COLOR_ACTION = { yellow: 'extract', green: 'extract', pink: 'extract', blue: 'extract', other: 'extract' };

function classifyColor(color) {
  if (!color || color.length < 3) return 'other';
  const [r, g, b] = color;
  if (r > 0.8 && g > 0.7 && b < 0.3) return 'yellow';
  if (r < 0.4 && g > 0.6 && b < 0.5) return 'green';
  if (r > 0.7 && g < 0.5 && b < 0.5) return 'pink';
  if (r < 0.4 && b > 0.6)            return 'blue';
  return 'other';
}

// Convert flat quadPoints array (groups of 8: x0,y0,x1,y1,x2,y2,x3,y3 per line)
// into bounding rects. QuadPoints use PDF coordinates (y=0 at bottom of page).
function quadPointsToRects(quadPoints) {
  const rects = [];
  for (let i = 0; i + 7 < quadPoints.length; i += 8) {
    const xs = [quadPoints[i], quadPoints[i+2], quadPoints[i+4], quadPoints[i+6]];
    const ys = [quadPoints[i+1], quadPoints[i+3], quadPoints[i+5], quadPoints[i+7]];
    rects.push({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) });
  }
  return rects;
}

// Find text items whose baseline y and x range overlap with any of the quad rects.
// Text items use the same PDF coordinate space as quadPoints.
function extractTextForRects(textItems, quadRects) {
  const TOLERANCE = 3; // pts — handles slight bbox misalignment
  const matched   = [];

  for (const item of textItems) {
    if (!item.str) continue;
    const tx = item.transform[4];          // x origin of text item
    const ty = item.transform[5];          // baseline y (PDF coords — higher = visually higher)
    const tw = item.width  || 0;

    for (const r of quadRects) {
      const withinY = ty >= r.y0 - TOLERANCE && ty <= r.y1 + TOLERANCE;
      const withinX = tx < r.x1 + TOLERANCE && (tx + tw) > r.x0 - TOLERANCE;
      if (withinY && withinX) {
        matched.push({ str: item.str, x: tx, y: ty });
        break;
      }
    }
  }

  // Sort top-to-bottom (descending y in PDF coords), left-to-right
  matched.sort((a, b) => b.y - a.y || a.x - b.x);
  return matched.map(m => m.str).join(' ');
}

// Clean extracted text: soft hyphens, line-break hyphens, whitespace
function cleanText(raw) {
  return raw
    .replace(/­/g, '')          // soft hyphens (common in justified German text)
    .replace(/-\s*\n\s*/g, '')       // hyphenated line breaks
    .replace(/\s+/g, ' ')
    .trim();
}

// Stable, content-addressable ID for a highlight — rounds coords to avoid
// float drift when Xodo re-saves the PDF after adding more annotations.
function highlightId(relPath, pageIndex, quadPoints, text) {
  const rounded = Array.from(quadPoints).map(v => Math.round(v * 10) / 10);
  const data = JSON.stringify({ p: relPath, pg: pageIndex, q: rounded, t: text });
  return 'hl-' + crypto.createHash('sha1').update(data).digest('hex').slice(0, 16);
}

// ── Main ───────────────────────────────────────────────────────────────────

async function run() {
  const state = loadState();
  let totalScanned = 0, totalHighlights = 0, newPushed = 0, errors = 0;

  // Walk elements dir, collect PDFs (recursive — elements/{dir}/{id}.pdf)
  function collectPdfs(dir) {
    const results = [];
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory())                                  results.push(...collectPdfs(full));
      else if (entry.name.toLowerCase().endsWith('.pdf') &&
               !isSyncConflict(entry.name))                     results.push(full);
    }
    return results;
  }

  const pdfPaths = collectPdfs(ELEMENTS_DIR);
  console.log(`SMGo highlight-extract: ${pdfPaths.length} PDFs found${DRY_RUN ? ' (dry run)' : ''}`);

  for (const pdfPath of pdfPaths) {
    const elementId = getElementId(pdfPath);
    if (!elementId) continue; // skip non-SM-named PDFs (e.g. Harrison_Ch12.pdf)

    const relPath = path.relative(ELEMENTS_DIR, pdfPath).replace(/\\/g, '/');

    // Skip unmodified PDFs — mtime cache avoids re-scanning on every SM startup
    let mtime;
    try { mtime = fs.statSync(pdfPath).mtimeMs; } catch { continue; }
    if (state[relPath] && state[relPath].mtime === mtime) continue;

    totalScanned++;
    let docHighlights = 0;

    let doc;
    try {
      const data = new Uint8Array(fs.readFileSync(pdfPath));
      doc = await pdfjsLib.getDocument({ data, verbosity: 0 }).promise;
    } catch (err) {
      console.log(`  skip (open error) ${relPath}: ${err.message}`);
      errors++;
      continue;
    }

    let pageError = false;

    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      let page;
      try { page = await doc.getPage(pageNum); }
      catch { continue; }

      let annotations = [];
      try { annotations = await page.getAnnotations(); }
      catch { continue; }

      const highlights = annotations.filter(a => a.subtype === 'Highlight' && a.quadPoints?.length);
      if (!highlights.length) continue;

      let textItems = [];
      try {
        const tc = await page.getTextContent();
        textItems = tc.items || [];
      } catch { continue; }

      for (const annot of highlights) {
        totalHighlights++;
        const color = classifyColor(annot.color);
        if (COLOR_ACTION[color] === 'skip') continue;

        const quadRects = quadPointsToRects(annot.quadPoints);
        const raw       = extractTextForRects(textItems, quadRects);
        const text      = cleanText(raw);

        if (!text) {
          // Scanned PDF (image-only) — no text layer; log once per page not per annot
          continue;
        }

        const id  = highlightId(relPath, pageNum - 1, annot.quadPoints, text);
        const row = {
          id,
          type:    'extract',
          applied: false,
          payload: {
            parentId: elementId,
            text,
            source:   'pdf-highlight',
            pdfPage:  pageNum,
            color,
            note:     annot.contents || '',   // sticky-note comment if user added one
          },
        };

        if (DRY_RUN) {
          console.log(`  [p.${pageNum}] [${color}] ${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`);
          docHighlights++;
          continue;
        }

        try {
          const res = await supaRequest(
            '/rest/v1/smgo_queue', 'POST', row,
            { Prefer: 'resolution=ignore-duplicates,return=minimal' }
          );
          if (res.status >= 200 && res.status < 300) {
            docHighlights++;
            newPushed++;
            console.log(`  [p.${pageNum}] [${color}] ${text.slice(0, 70)}${text.length > 70 ? '…' : ''}`);
          } else {
            console.log(`  error ${res.status} pushing highlight from ${relPath} p.${pageNum}: ${res.body.slice(0, 120)}`);
            errors++;
            pageError = true;
          }
        } catch (err) {
          console.log(`  network error: ${err.message}`);
          errors++;
          pageError = true;
        }
      }
    }

    doc.destroy();

    // Update mtime cache only if we processed the file without errors,
    // so a partial failure causes a retry on next run.
    if (!pageError) {
      state[relPath] = { mtime };
      saveState(state);
    }

    if (docHighlights > 0)
      console.log(`  ${relPath}: ${docHighlights} highlights`);
  }

  const summary = DRY_RUN
    ? `${totalHighlights} highlights found across ${totalScanned} modified PDFs (dry run — nothing pushed)`
    : `${newPushed} highlights pushed to Supabase (${totalScanned} PDFs scanned, ${errors} errors)`;
  console.log(`SMGo highlight-extract: ${summary}`);
}

run().catch(err => { console.error('SMGo highlight-extract fatal:', err.message); process.exit(1); });
