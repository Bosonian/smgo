'use strict';
// Pushes today's SM cards to Supabase smgo_daily table.
// Run automatically by the SMA plugin on SM startup, or manually.
const fs   = require('fs');
const path = require('path');
const https = require('https');
const { getTodayCards, collection } = require('./sm-parser');

let pdfjsLib;
try {
  pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  pdfjsLib.GlobalWorkerOptions.workerSrc = ''; // disable worker in Node.js
} catch { pdfjsLib = null; }

let config;
try { config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8')); }
catch { console.error('SMGo: config.json not found'); process.exit(0); }

if (!config.supabaseUrl || !config.supabaseKey) {
  console.error('SMGo: config.json missing supabaseUrl or supabaseKey');
  process.exit(0);
}

const base    = config.supabaseUrl.replace(/\/$/, '');
const headers = {
  'apikey':        config.supabaseKey,
  'Authorization': `Bearer ${config.supabaseKey}`,
  'Content-Type':  'application/json',
};

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

// Extract text from a specific page of a PDF file (0-indexed page number).
// Groups cards by PDF file so each file is opened only once.
async function enrichPdfCards(cards) {
  if (!pdfjsLib) return;
  const pdfCards = cards.filter(c => c.type === 'pdf-extract' && c.pdfFile && c.pdfPage != null);
  if (!pdfCards.length) return;

  // Group by PDF path
  const groups = {};
  for (const card of pdfCards) {
    if (!groups[card.pdfFile]) groups[card.pdfFile] = [];
    groups[card.pdfFile].push(card);
  }

  for (const [pdfPath, group] of Object.entries(groups)) {
    if (!fs.existsSync(pdfPath)) {
      console.warn(`SMGo: PDF not found: ${pdfPath}`);
      continue;
    }
    let doc;
    try {
      const data = new Uint8Array(fs.readFileSync(pdfPath));
      doc = await pdfjsLib.getDocument({ data, verbosity: 0 }).promise;
    } catch (e) {
      console.warn(`SMGo: could not open PDF ${path.basename(pdfPath)}: ${e.message}`);
      continue;
    }
    for (const card of group) {
      try {
        // pdfPage is 0-indexed; PDF.js getPage() is 1-indexed; null → default page 1
        const pageNum = Math.max(1, Math.min((card.pdfPage ?? 0) + 1, doc.numPages));
        const page    = await doc.getPage(pageNum);
        const content = await page.getTextContent();
        card.body = content.items
          .map(i => i.str || '')
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 8000);
      } catch {}
    }
  }
}

(async () => {
  // Ensure tables exist (idempotent — safe to call every time)
  const setup = await supaRequest('/rest/v1/rpc/smgo_setup', 'POST', {});
  if (setup.status !== 200 && setup.status !== 204) {
    console.error(`SMGo: smgo_setup() failed (${setup.status}): ${setup.body}`);
    // Non-fatal — tables may already exist
  }

  const _d  = new Date();
  const date = `${_d.getFullYear()}-${String(_d.getMonth()+1).padStart(2,'0')}-${String(_d.getDate()).padStart(2,'0')}`;
  const cards = getTodayCards();

  // Fill in PDF page text (requires pdfjs-dist and local PDF files)
  await enrichPdfCards(cards);

  // Strip server-side pdfFile path before sending — it's meaningless to the PWA
  const cleanCards = cards
    // A PDF wrapper with no extracted page text cannot be reviewed in the PWA.
    // Keep successfully enriched PDF cards; omit empty wrappers instead of
    // exporting a misleading "No renderable content" card.
    .filter(c => c.type !== 'pdf-extract' || Boolean(c.body?.trim()))
    .map(c => {
      if (c.type !== 'pdf-extract') return c;
      const { pdfFile, ...rest } = c;
      return rest;
    });

  const payload = {
    protocolVersion: 2,
    collectionId: collection.id,
    collectionName: collection.name,
    date,
    count: cleanCards.length,
    cards: cleanCards,
    generated: new Date().toISOString(),
  };

  const push = await supaRequest(
    '/rest/v1/smgo_daily?on_conflict=collection_id,review_date', 'POST',
    { collection_id: collection.id, review_date: date, date, data: payload },
    { 'Prefer': 'resolution=merge-duplicates' }
  );
  const pdfCount = cleanCards.filter(c => c.type === 'pdf-extract' && c.body).length;
  console.log(`SMGo: pushed ${cleanCards.length} cards for ${collection.name} (${pdfCount} PDF extracts with text) HTTP ${push.status}`);
})().catch(e => console.error('SMGo export-cloud error:', e.message));
