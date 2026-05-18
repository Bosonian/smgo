'use strict';
const fs = require('fs');
const path = require('path');

const COLLECTION = 'C:\\SuperMemo\\systems\\Facharzt';
const ELEM_DIR   = path.join(COLLECTION, 'elements');
const INFO_DIR   = path.join(COLLECTION, 'info');

// Read today's outstanding element IDs from Outstanding.sub
// File is a flat array of 4-byte little-endian uint32s.
function getOutstandingIds() {
  const subFile = path.join(INFO_DIR, 'Outstanding.sub');
  if (!fs.existsSync(subFile)) return [];
  const buf = fs.readFileSync(subFile);
  const ids = [];
  for (let i = 0; i + 3 < buf.length; i += 4)
    ids.push(buf.readUInt32LE(i));
  return ids;
}

// Locate the file for element ID N.
// Layout: elements/{(N-1)÷10}/{N}.ext  OR  elements/{N}.ext (for N 1–10, dir=0=root)
function findElementFile(id) {
  const dir  = Math.floor((id - 1) / 10);
  const exts = ['.HTM', '.htm', '.HTML', '.html', '.pdf', '.PDF', '.png', '.PNG', '.jpg', '.JPG'];
  for (const ext of exts) {
    // Subdirectory (for id > 10, dir > 0)
    if (dir > 0) {
      const inSub = path.join(ELEM_DIR, String(dir), `${id}${ext}`);
      if (fs.existsSync(inSub)) return inSub;
    }
    // Root elements directory (for id 1-10, dir=0)
    const inRoot = path.join(ELEM_DIR, `${id}${ext}`);
    if (fs.existsSync(inRoot)) return inRoot;
  }
  // Directory-based element (complex multi-component)
  const dirPath = path.join(ELEM_DIR, String(id));
  if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) return dirPath;
  return null;
}

// Strip HTML tags and clean whitespace for plain text preview
function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#8211;/g, '–')
    .replace(/&#8212;/g, '—')
    .replace(/&#8216;|&#8217;/g, "'")
    .replace(/&#8220;|&#8221;/g, '"')
    .replace(/&#[0-9]+;/g, c => String.fromCharCode(parseInt(c.slice(2, -1))))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Detect cloze items and extract question/answer structure.
// Cloze format: <SPAN class=cloze>question text[...]rest context</SPAN>
function parseCloze(html) {
  const re = /<[Ss][Pp][Aa][Nn][^>]*class=cloze[^>]*>([\s\S]*?)<\/[Ss][Pp][Aa][Nn]>/i;
  const m = re.exec(html);
  if (!m) return null;
  const inner = m[1];
  // The [...] is the blank; everything before it in the cloze span is the question context
  const blank = inner.replace(/\[\.\.\.\]/, '[___]');
  return { clozeSentence: stripHtml(blank) };
}

// Decode the base64 JSON embedded in PDF-reference elements
function parsePdfElement(html) {
  const titleRe    = /id=pdf-element-title[^>]*>(.*?)</i;
  const filenameRe = /id=pdf-element-filename[^>]*>(.*?)</i;
  const dataRe     = /id=pdf-element-data[^>]*>(.*?)</i;
  const title    = (titleRe.exec(html)?.[1] || '').trim();
  const filename = (filenameRe.exec(html)?.[1] || '').trim();
  let page = null;
  try {
    const b64  = dataRe.exec(html)?.[1] || '';
    const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
    page = json.RPg ?? null;
  } catch {}
  return { title: title || filename, filename, page };
}

// Build a card object for one element ID
function buildCard(id) {
  const filePath = findElementFile(id);
  if (!filePath) return { id, type: 'missing', title: `Element ${id}`, body: null };

  const ext = typeof filePath === 'string' ? path.extname(filePath).toLowerCase() : '';

  // Directory-based (complex) element — try first .htm inside
  if (!ext) {
    const inner = fs.readdirSync(filePath).find(f => /\.(htm|html)$/i.test(f));
    if (!inner) return { id, type: 'complex', title: `Element ${id}`, body: null };
    return buildCardFromHtml(id, path.join(filePath, inner));
  }

  if (ext === '.pdf') {
    return { id, type: 'pdf', title: `Element ${id} (PDF)`, body: null,
             pdfHint: path.basename(filePath) };
  }

  if (/\.(png|jpg|jpeg|gif|bmp)$/.test(ext)) {
    return { id, type: 'image', title: `Element ${id}`, body: null,
             imageFile: path.basename(filePath) };
  }

  if (/\.html?$/.test(ext)) return buildCardFromHtml(id, filePath);

  return { id, type: 'unknown', title: `Element ${id}`, body: null };
}

function buildCardFromHtml(id, filePath) {
  let html;
  try { html = fs.readFileSync(filePath, 'utf-8').replace(/^﻿/, ''); }
  catch { return { id, type: 'error', title: `Element ${id}`, body: null }; }

  // Is this a PDF-reference wrapper?
  if (html.includes('id=pdf-element-filename')) {
    const { title, filename, page } = parsePdfElement(html);
    const pageStr = page != null ? `Page ${page}` : '';
    const body = [title, pageStr, filename ? `PDF: ${filename}` : '']
                   .filter(Boolean).join('\n');
    return { id, type: 'pdf-extract',
             title: title || `Element ${id}`, body, pdfPage: page };
  }

  const cloze = parseCloze(html);
  if (cloze) {
    return { id, type: 'cloze', title: `Cloze ${id}`,
             body: stripHtml(html), clozeSentence: cloze.clozeSentence };
  }

  const text = stripHtml(html);
  // First non-empty line as title
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const title = lines[0] ? lines[0].slice(0, 80) : `Element ${id}`;
  return { id, type: 'topic', title, body: text.slice(0, 3000) };
}

// Return all outstanding cards for today — text-renderable types only
function getTodayCards() {
  const ids = getOutstandingIds();
  return ids.map(buildCard).filter(c =>
    c.type === 'topic' || c.type === 'pdf-extract' || c.type === 'cloze'
  );
}

module.exports = { getTodayCards, getOutstandingIds, COLLECTION };
