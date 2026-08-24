'use strict';
// Scans SM collection PDFs for highlight annotations (Xodo or any standard annotator)
// and pushes them to Supabase as SM extract items.
//
// Color scheme:
//   🟠 Orange  — stage: add to buffer, waiting for a green commit signal
//   🟢 Green   — commit: adds text to buffer then flushes all buffered highlights
//                as ONE combined SM element (segments in reading order)
//   🟡 Yellow  — extract immediately as an individual SM element
//   🔵 Blue    — skip: personal annotation, never sent to SM
//
// Staging buffer persists across pages within one PDF. Oranges on page 3 + 5
// are committed together by a green on page 6.
// Uncommitted oranges (no green yet) remain staged — nothing is pushed.
//
// Usage:
//   node highlight-extract.js              — scan + push new highlights
//   node highlight-extract.js --dry-run    — log only, no Supabase writes

const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const crypto  = require('crypto');
const { loadCollectionContext, collectionIdForPath } = require('./collection-context');

let pdfjsLib;
try {
  pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  pdfjsLib.GlobalWorkerOptions.workerSrc = '';
} catch { console.error('SMGo highlight-extract: pdfjs-dist not found'); process.exit(0); }

let createCanvas;
try { createCanvas = require('@napi-rs/canvas').createCanvas; } catch { /* rect rendering disabled */ }

// ── Config ─────────────────────────────────────────────────────────────────

let config;
try { config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8')); }
catch { console.error('SMGo highlight-extract: config.json not found'); process.exit(0); }

if (!config.supabaseUrl || !config.supabaseKey) {
  console.error('SMGo highlight-extract: config.json missing supabaseUrl / supabaseKey');
  process.exit(0);
}

const collection   = loadCollectionContext(config);
const ELEMENTS_DIR = collection.elementsDir;
const STATE_DIR    = path.join(__dirname, 'state');
const STATE_FILE   = path.join(STATE_DIR, `highlight-extract-${collection.id}.json`);
const LEGACY_STATE_FILE = path.join(__dirname, 'highlight-extract-state.json');
const DRY_RUN      = process.argv.includes('--dry-run');
const IMPORT_LEGACY_STATE = process.argv.includes('--import-legacy-highlight-state');
const configuredLegacyId = config.legacyHighlightStateCollectionPath
  ? collectionIdForPath(config.legacyHighlightStateCollectionPath) : null;
const isLegacyStateCollection = configuredLegacyId === collection.id || /facharzt/i.test(collection.name);

const base    = config.supabaseUrl.replace(/\/$/, '');
const headers = {
  apikey:         config.supabaseKey,
  Authorization:  `Bearer ${config.supabaseKey}`,
  'Content-Type': 'application/json',
};

// ── Supabase ───────────────────────────────────────────────────────────────

function supaRequest(reqPath, method, body, extraHeaders = {}, timeoutMs = 20000) {
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
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Supabase request timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── State (mtime cache) ────────────────────────────────────────────────────

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')); }
  catch {
    if (!fs.existsSync(LEGACY_STATE_FILE)) return {};
    if (!isLegacyStateCollection) return {};
    if (!IMPORT_LEGACY_STATE) {
      throw new Error('legacy highlight state exists; rerun once with --import-legacy-highlight-state to preserve processed annotations');
    }
    const legacy = JSON.parse(fs.readFileSync(LEGACY_STATE_FILE, 'utf-8'));
    // Keep the legacy mtime entries exactly as they were. This is what prevents
    // a collection-ID migration from re-queueing annotations already sent.
    legacy.__smgoLegacyImport = { importedAt: new Date().toISOString(), source: 'highlight-extract-state.json' };
    saveState(legacy);
    console.log('SMGo highlight-extract: imported legacy state once; existing annotation IDs were preserved.');
    return legacy;
  }
}

function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// ── Color classification ───────────────────────────────────────────────────
// pdfjs annotation colors: 0–1 floats (standard) or 0–255 integers (Xodo TypedArray).

function classifyColor(color) {
  if (!color || color.length < 3) return 'other';
  let [r, g, b] = color;
  // Normalize 0–255 integers to 0–1
  if (r > 1 || g > 1 || b > 1) { r /= 255; g /= 255; b /= 255; }
  // Green: dominant G, low R and B
  if (g > 0.5 && r < 0.5 && b < 0.5)        return 'green';
  // Blue/cyan: dominant B, low R
  if (b > 0.5 && r < 0.5)                    return 'blue';
  // Yellow: high R+G, very low B
  if (r > 0.7 && g > 0.6 && b < 0.25)       return 'yellow';
  // Orange: high R, mid G (0.25–0.65), very low B — sits between yellow and red
  if (r > 0.7 && g >= 0.25 && g < 0.65 && b < 0.25) return 'orange';
  // Pink/red: high R, low G+B
  if (r > 0.6 && g < 0.4 && b < 0.4)        return 'pink';
  return 'other';
}

// 🟠 stage  — add to buffer, wait for green
// 🟢 commit — flush buffer as one combined element
// 🟡 extract — push immediately as individual element
// skip      — ignore
const COLOR_ACTION = {
  orange: 'stage',
  green:  'commit',
  yellow: 'extract',
  blue:   'skip',
  pink:   'skip',
  other:  'skip',
};

// For Square (rect) annotations: any non-blue/non-green color stages.
// Red/pink are natural choices in Xodo's rect tool default palette.
const SQUARE_COLOR_ACTION = {
  orange: 'stage',
  green:  'commit',
  yellow: 'stage',
  blue:   'skip',
  pink:   'stage',
  other:  'stage',
};

// ── PDF helpers ────────────────────────────────────────────────────────────

function isSyncConflict(filename) {
  return filename.includes('.sync-conflict-');
}

function getElementId(pdfPath) {
  const base = path.basename(pdfPath, path.extname(pdfPath));
  const id   = parseInt(base, 10);
  return Number.isInteger(id) && String(id) === base ? id : null;
}

// quadPoints → array of bounding rects.
// Handles two formats pdfjs may return:
//   standard : flat number array  [x0,y0,x1,y1,x2,y2,x3,y3, ...]  (8 per quad)
//   Xodo     : array of [{x,y}×4] quads
function quadPointsToRects(quadPoints) {
  const rects = [];
  if (quadPoints.length > 0 && Array.isArray(quadPoints[0])) {
    // Xodo format: [[{x,y},{x,y},{x,y},{x,y}], ...]
    for (const quad of quadPoints) {
      const xs = quad.map(p => p.x);
      const ys = quad.map(p => p.y);
      rects.push({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) });
    }
  } else {
    // Standard flat number array
    for (let i = 0; i + 7 < quadPoints.length; i += 8) {
      const xs = [quadPoints[i], quadPoints[i+2], quadPoints[i+4], quadPoints[i+6]];
      const ys = [quadPoints[i+1], quadPoints[i+3], quadPoints[i+5], quadPoints[i+7]];
      rects.push({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) });
    }
  }
  return rects;
}

// Extract text items that fall within the highlight's quad rects.
// Uses per-quad matching (not annot.rect) for correct multi-line highlights.
function extractTextForRects(textItems, quadRects) {
  const TOLERANCE = 3;
  const matched   = [];
  for (const item of textItems) {
    if (!item.str) continue;
    const tx = item.transform[4];
    const ty = item.transform[5]; // baseline y in PDF coords (higher = visually higher)
    const tw = item.width || 0;
    for (const r of quadRects) {
      if (ty >= r.y0 - TOLERANCE && ty <= r.y1 + TOLERANCE &&
          tx <  r.x1 + TOLERANCE && tx + tw > r.x0 - TOLERANCE) {
        matched.push({ str: item.str, x: tx, y: ty });
        break;
      }
    }
  }
  matched.sort((a, b) => b.y - a.y || a.x - b.x); // top→bottom, left→right
  return matched.map(m => m.str).join(' ');
}

function cleanText(raw) {
  return raw
    .replace(/­/g, '')              // soft hyphens U+00AD
    .replace(/-\s*\n\s*/g, '')      // hyphenated line breaks (when items contain \n)
    .replace(/(\w)- (\w)/g, '$1$2') // hyphen-space artifacts from join(' ') on split words
    .replace(/\s+/g, ' ')
    .trim();
}

// Render a PDF rect region to a PNG side-car file. Returns absolute path or null.
async function renderRectToPng(doc, pdfPath, pageIndex, pdfRect, annotId) {
  if (!createCanvas) return null;
  try {
    const page  = await doc.getPage(pageIndex + 1);
    const view  = page.view; // [left, bottom, right, top] in PDF user units
    const scale = 2;
    const vp    = page.getViewport({ scale });
    const canvas = createCanvas(Math.round(vp.width), Math.round(vp.height));
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;

    // Convert PDF rect (bottom-left origin) → canvas coords (top-left origin)
    const [rx0, ry0, rx1, ry1] = pdfRect;
    const cx = Math.max(0, Math.round((rx0 - view[0]) * scale));
    const cy = Math.max(0, Math.round((view[3] - ry1) * scale));
    const cw = Math.max(1, Math.round((rx1 - rx0) * scale));
    const ch = Math.max(1, Math.round((ry1 - ry0) * scale));

    const cropped = createCanvas(cw, ch);
    cropped.getContext('2d').drawImage(canvas, cx, cy, cw, ch, 0, 0, cw, ch);

    const outPath = path.join(
      path.dirname(pdfPath),
      `${path.basename(pdfPath, path.extname(pdfPath))}-rect-${annotId}.png`
    );
    fs.writeFileSync(outPath, cropped.toBuffer('image/png'));
    return outPath;
  } catch (err) {
    console.log(`  rect render error: ${err.message}`);
    return null;
  }
}

// Stable ID for a Square annotation
function rectId(relPath, pageIndex, rect) {
  return 'rect-' + crypto.createHash('sha1')
    .update(JSON.stringify({ p: relPath, pg: pageIndex, r: rect.map(v => Math.round(v)) }))
    .digest('hex').slice(0, 16);
}

// Stable ID for a single highlight
function highlightId(relPath, pageIndex, quadPoints, text) {
  // Normalize both quadPoints formats to a flat number array for stable hashing
  let flat;
  if (quadPoints.length > 0 && Array.isArray(quadPoints[0])) {
    flat = quadPoints.flatMap(quad => quad.flatMap(p => [p.x, p.y]));
  } else {
    flat = Array.from(quadPoints);
  }
  const rounded = flat.map(v => Math.round(v * 10) / 10);
  return 'hl-' + crypto.createHash('sha1')
    .update(JSON.stringify({ p: relPath, pg: pageIndex, q: rounded, t: text }))
    .digest('hex').slice(0, 16);
}

// Stable ID for a committed group — based on the ordered IDs of its members.
// Same set of highlights in same order always produces the same group ID.
function groupId(members) {
  return 'grp-' + crypto.createHash('sha1')
    .update(members.map(m => m.id).join(','))
    .digest('hex').slice(0, 16);
}

// ── Push helpers ───────────────────────────────────────────────────────────

async function pushRow(row) {
  if (DRY_RUN) return true;
  try {
    // Queue IDs and payloads are both scoped. The queue ID prevents a stable
    // PDF annotation ID from colliding with the same relative PDF in another
    // collection; the payload lets the desktop bridge fail closed as well.
    const commandId = `${collection.id}--${row.id}`;
    const scopedRow = {
      ...row,
      id: commandId,
      collection_id: collection.id,
      payload: {
        ...row.payload,
        protocolVersion: 2,
        collectionId: collection.id,
        commandId,
      },
    };
    const res = await supaRequest(
      '/rest/v1/smgo_queue', 'POST', scopedRow,
      { Prefer: 'resolution=ignore-duplicates,return=minimal' }
    );
    if (res.status >= 200 && res.status < 300) return true;
    console.log(`  supabase error ${res.status}: ${res.body.slice(0, 120)}`);
    return false;
  } catch (err) {
    console.log(`  network error: ${err.message}`);
    return false;
  }
}

// Push a single yellow highlight as an individual SM extract
async function pushImmediate(elementId, highlight) {
  const row = {
    id:      highlight.id,
    type:    'extract',
    applied: false,
    payload: { parentId: elementId, text: highlight.text, source: 'pdf-highlight', pdfPage: highlight.page },
  };
  const ok = await pushRow(row);
  if (ok) console.log(`  [p.${highlight.page}] 🟡 ${highlight.text.slice(0, 70)}${highlight.text.length > 70 ? '…' : ''}`);
  return ok;
}

// Push a committed group of staged highlights/rects as one combined SM element.
async function pushGroup(elementId, members, doc) {
  const segments = [];
  for (const m of members) {
    if (m.kind === 'rect') {
      const imgPath = await renderRectToPng(doc, m.pdfPath, m.pageIndex, m.rect, m.annotId);
      if (imgPath) segments.push({ kind: 'image', imgPath });
    } else {
      segments.push({ kind: 'text', text: m.text });
    }
  }
  if (!segments.length) return false;

  const id  = groupId(members);
  const row = {
    id,
    type:    'pdf-extract-create',
    applied: false,
    payload: {
      parentId: elementId,
      segments,
      source:   'pdf-highlight-staged',
      pages:    [...new Set(members.map(m => m.page))],
    },
  };
  const ok = await pushRow(row);
  if (ok) {
    const preview = members.map(m => m.kind === 'rect' ? '[rect]' : m.text.slice(0, 40)).join(' / ');
    console.log(`  [p.${members[0].page}–${members[members.length-1].page}] 🟢 committed ${members.length} segments: ${preview.slice(0, 80)}…`);
  }
  return ok;
}

// Push a single rect as an immediate individual SM element (yellow or lone-green rect)
async function pushImmediateRect(elementId, h, imgPath) {
  const row = {
    id:      h.id,
    type:    'pdf-extract-create',
    applied: false,
    payload: {
      parentId: elementId,
      segments: [{ kind: 'image', imgPath }],
      source:   'pdf-highlight-rect',
      pages:    [h.page],
    },
  };
  const ok = await pushRow(row);
  if (ok) console.log(`  [p.${h.page}] 🟡 rect extracted → ${path.basename(imgPath)}`);
  return ok;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function run() {
  const state = loadState();
  let totalScanned = 0, pushed = 0, errors = 0;

  function collectPdfs(dir) {
    const results = [];
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory())
        results.push(...collectPdfs(full));
      else if (entry.name.toLowerCase().endsWith('.pdf') && !isSyncConflict(entry.name))
        results.push(full);
    }
    return results;
  }

  const pdfPaths = collectPdfs(ELEMENTS_DIR);
  console.log(`SMGo highlight-extract: ${pdfPaths.length} PDFs found in ${collection.name}${DRY_RUN ? ' (dry run)' : ''}`);

  for (const pdfPath of pdfPaths) {
    const elementId = getElementId(pdfPath);
    if (!elementId) continue;

    const relPath = path.relative(ELEMENTS_DIR, pdfPath).replace(/\\/g, '/');

    let mtime;
    try { mtime = fs.statSync(pdfPath).mtimeMs; } catch { continue; }
    if (state[relPath] && state[relPath].mtime === mtime) continue;

    totalScanned++;

    let doc;
    try {
      doc = await pdfjsLib.getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), verbosity: 0 }).promise;
    } catch (err) {
      console.log(`  skip (open error) ${relPath}: ${err.message}`);
      errors++;
      continue;
    }

    // stagingBuffer accumulates orange highlights across all pages of this PDF.
    // A green highlight flushes and commits everything in it as one SM element.
    const stagingBuffer = [];
    let docPushed = 0;
    let pageError = false;

    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      let page, annotations;
      try { page = await doc.getPage(pageNum); }           catch { continue; }
      try { annotations = await page.getAnnotations(); }   catch { continue; }

      const highlights = annotations.filter(a => a.subtype === 'Highlight' && a.quadPoints?.length);
      const squares    = annotations.filter(a => a.subtype === 'Square' && a.rect?.length === 4);
      if (!highlights.length && !squares.length) continue;

      let textItems = [];
      if (highlights.length) {
        try { const tc = await page.getTextContent(); textItems = tc.items || []; } catch { /* ok */ }
      }

      // Unified sort key: top Y in PDF space (bottom-left origin; larger = visually higher on page)
      const annotTopY = a => a.subtype === 'Square'
        ? a.rect[3]
        : Array.isArray(a.quadPoints[0])
          ? Math.max(...a.quadPoints.flatMap(q => q.map(p => p.y)))
          : Math.max(...Array.from(a.quadPoints).filter((_, i) => i % 2 === 1));

      const allAnnots = [...highlights, ...squares];
      allAnnots.sort((a, b) => annotTopY(b) - annotTopY(a) || a.rect[0] - b.rect[0]);

      for (const annot of allAnnots) {
        const color  = classifyColor(annot.color);
        const action = annot.subtype === 'Square' ? SQUARE_COLOR_ACTION[color] : COLOR_ACTION[color];
        if (action === 'skip') continue;

        let h;
        if (annot.subtype === 'Square') {
          const id = rectId(relPath, pageNum - 1, annot.rect);
          h = { kind: 'rect', id, rect: annot.rect, annotId: annot.id, pageIndex: pageNum - 1, pdfPath, page: pageNum, color };
        } else {
          const text = cleanText(extractTextForRects(textItems, quadPointsToRects(annot.quadPoints)));
          if (!text) continue;
          const id = highlightId(relPath, pageNum - 1, annot.quadPoints, text);
          h = { kind: 'text', id, text, page: pageNum, color };
        }

        if (action === 'stage') {
          stagingBuffer.push(h);
          if (DRY_RUN) {
            if (h.kind === 'rect') console.log(`  [p.${pageNum}] 🟠 staged rect (${Math.round(h.rect[2]-h.rect[0])}×${Math.round(h.rect[3]-h.rect[1])} pts)`);
            else                   console.log(`  [p.${pageNum}] 🟠 staged: ${h.text.slice(0, 70)}…`);
          }

        } else if (action === 'commit') {
          stagingBuffer.push(h);
          if (stagingBuffer.length === 1) {
            // Lone green with no staged oranges
            if (h.kind === 'rect') {
              if (DRY_RUN) { console.log(`  [p.${pageNum}] 🟢 would extract rect (lone green)`); docPushed++; }
              else {
                const imgPath = await renderRectToPng(doc, pdfPath, h.pageIndex, h.rect, h.annotId);
                if (imgPath) { const ok = await pushImmediateRect(elementId, h, imgPath); if (!ok) pageError = true; else docPushed++; }
              }
            } else {
              const ok = await pushImmediate(elementId, h);
              if (!ok) pageError = true; else docPushed++;
            }
            stagingBuffer.length = 0;
          } else {
            const members = stagingBuffer.splice(0);
            if (DRY_RUN) {
              const preview = members.map(m => m.kind === 'rect' ? `[rect p.${m.page}]` : m.text.slice(0, 30)).join(' / ');
              console.log(`  [p.${pageNum}] 🟢 would commit ${members.length} segments: ${preview.slice(0, 80)}…`);
            } else {
              const ok = await pushGroup(elementId, members, doc);
              if (!ok) pageError = true; else docPushed++;
            }
          }

        } else if (action === 'extract') {
          // Yellow: push immediately, independent of staging buffer
          if (h.kind === 'rect') {
            if (DRY_RUN) { console.log(`  [p.${pageNum}] 🟡 would extract rect (${Math.round(h.rect[2]-h.rect[0])}×${Math.round(h.rect[3]-h.rect[1])} pts)`); docPushed++; }
            else {
              const imgPath = await renderRectToPng(doc, pdfPath, h.pageIndex, h.rect, h.annotId);
              if (imgPath) { const ok = await pushImmediateRect(elementId, h, imgPath); if (!ok) pageError = true; else docPushed++; }
            }
          } else {
            if (DRY_RUN) { console.log(`  [p.${pageNum}] 🟡 ${h.text.slice(0, 80)}${h.text.length > 80 ? '…' : ''}`); docPushed++; }
            else { const ok = await pushImmediate(elementId, h); if (!ok) pageError = true; else docPushed++; }
          }
        }
      }
    }

    doc.destroy();

    // Report any uncommitted staged highlights so the user knows to add a green
    if (stagingBuffer.length > 0) {
      console.log(`  ${relPath}: ${stagingBuffer.length} orange highlight(s) still staged (add a 🟢 green to commit)`);
    }

    if (!pageError && !DRY_RUN) {
      state[relPath] = { mtime };
      saveState(state);
    }

    pushed += docPushed;
    if (docPushed > 0 || stagingBuffer.length > 0)
      console.log(`  ${relPath}: ${docPushed} pushed, ${stagingBuffer.length} staged`);
  }

  const summary = DRY_RUN
    ? `dry run complete — ${totalScanned} PDFs scanned`
    : `${pushed} items pushed to Supabase (${totalScanned} PDFs scanned, ${errors} errors)`;
  console.log(`\nSMGo highlight-extract: ${summary}`);
}

run().catch(err => { console.error('SMGo highlight-extract fatal:', err.message); process.exit(1); });
