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

let pdfjsLib;
try {
  pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  pdfjsLib.GlobalWorkerOptions.workerSrc = '';
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
  apikey:         config.supabaseKey,
  Authorization:  `Bearer ${config.supabaseKey}`,
  'Content-Type': 'application/json',
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

// ── State (mtime cache) ────────────────────────────────────────────────────

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')); }
  catch { return {}; }
}

function saveState(state) {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// ── Color classification ───────────────────────────────────────────────────
// pdfjs annotation colors are [r, g, b] each in range 0–1.

function classifyColor(color) {
  if (!color || color.length < 3) return 'other';
  const [r, g, b] = color;
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

// ── PDF helpers ────────────────────────────────────────────────────────────

function isSyncConflict(filename) {
  return filename.includes('.sync-conflict-');
}

function getElementId(pdfPath) {
  const base = path.basename(pdfPath, path.extname(pdfPath));
  const id   = parseInt(base, 10);
  return Number.isInteger(id) && String(id) === base ? id : null;
}

// flat quadPoints [x0,y0,x1,y1,x2,y2,x3,y3, ...] → array of bounding rects
function quadPointsToRects(quadPoints) {
  const rects = [];
  for (let i = 0; i + 7 < quadPoints.length; i += 8) {
    const xs = [quadPoints[i], quadPoints[i+2], quadPoints[i+4], quadPoints[i+6]];
    const ys = [quadPoints[i+1], quadPoints[i+3], quadPoints[i+5], quadPoints[i+7]];
    rects.push({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) });
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
    .replace(/­/g, '')       // soft hyphens (common in German justified text)
    .replace(/-\s*\n\s*/g, '')    // hyphenated line breaks
    .replace(/\s+/g, ' ')
    .trim();
}

// Stable ID for a single highlight
function highlightId(relPath, pageIndex, quadPoints, text) {
  const rounded = Array.from(quadPoints).map(v => Math.round(v * 10) / 10);
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
    const res = await supaRequest(
      '/rest/v1/smgo_queue', 'POST', row,
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

// Push a committed group of staged highlights as one combined SM element.
// Each member becomes a separate <p> segment via pdf-extract-create.
async function pushGroup(elementId, members) {
  const id  = groupId(members);
  const row = {
    id,
    type:    'pdf-extract-create',
    applied: false,
    payload: {
      parentId: elementId,
      segments: members.map(m => ({ kind: 'text', text: m.text })),
      source:   'pdf-highlight-staged',
      pages:    [...new Set(members.map(m => m.page))],
    },
  };
  const ok = await pushRow(row);
  if (ok) {
    const preview = members.map(m => m.text.slice(0, 40)).join(' / ');
    console.log(`  [p.${members[0].page}–${members[members.length-1].page}] 🟢 committed ${members.length} segments: ${preview.slice(0, 80)}…`);
  }
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
  console.log(`SMGo highlight-extract: ${pdfPaths.length} PDFs found${DRY_RUN ? ' (dry run)' : ''}`);

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
      let page, annotations, textContent;
      try { page = await doc.getPage(pageNum); }           catch { continue; }
      try { annotations = await page.getAnnotations(); }   catch { continue; }

      const highlights = annotations.filter(a => a.subtype === 'Highlight' && a.quadPoints?.length);
      if (!highlights.length) continue;

      try { textContent = await page.getTextContent(); }   catch { continue; }
      const textItems = textContent.items || [];

      // Sort highlights in reading order (top→bottom, left→right) before processing
      highlights.sort((a, b) => {
        const ay = Math.max(...Array.from(a.quadPoints).filter((_, i) => i % 2 === 1));
        const by = Math.max(...Array.from(b.quadPoints).filter((_, i) => i % 2 === 1));
        return by - ay || a.rect[0] - b.rect[0];
      });

      for (const annot of highlights) {
        const color  = classifyColor(annot.color);
        const action = COLOR_ACTION[color];
        if (action === 'skip') continue;

        const text = cleanText(extractTextForRects(textItems, quadPointsToRects(annot.quadPoints)));
        if (!text) continue; // scanned/image-only PDF page

        const id = highlightId(relPath, pageNum - 1, annot.quadPoints, text);
        const h  = { id, text, page: pageNum, color };

        if (action === 'stage') {
          // Orange: accumulate — nothing pushed yet
          stagingBuffer.push(h);
          if (DRY_RUN) console.log(`  [p.${pageNum}] 🟠 staged: ${text.slice(0, 70)}…`);

        } else if (action === 'commit') {
          // Green: add green text as the final segment, then commit the whole buffer
          stagingBuffer.push(h);
          if (stagingBuffer.length === 1) {
            // Green with no staged oranges — treat as immediate individual extract
            const ok = await pushImmediate(elementId, h);
            if (!ok) pageError = true;
            else docPushed++;
          } else {
            const members = stagingBuffer.splice(0); // take all, clear buffer
            if (DRY_RUN) {
              const preview = members.map(m => m.text.slice(0, 30)).join(' / ');
              console.log(`  [p.${pageNum}] 🟢 would commit ${members.length} segments: ${preview.slice(0, 80)}…`);
            } else {
              const ok = await pushGroup(elementId, members);
              if (!ok) pageError = true;
              else docPushed++;
            }
          }

        } else if (action === 'extract') {
          // Yellow: push immediately, independent of staging buffer
          if (DRY_RUN) {
            console.log(`  [p.${pageNum}] 🟡 ${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`);
            docPushed++;
          } else {
            const ok = await pushImmediate(elementId, h);
            if (!ok) pageError = true;
            else docPushed++;
          }
        }
      }
    }

    doc.destroy();

    // Report any uncommitted staged highlights so the user knows to add a green
    if (stagingBuffer.length > 0) {
      console.log(`  ${relPath}: ${stagingBuffer.length} orange highlight(s) still staged (add a 🟢 green to commit)`);
    }

    if (!pageError) {
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
