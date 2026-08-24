'use strict';
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const { getTodayCards, findElementFile, collection } = require('./sm-parser');

const PORT        = 3001;
const PWA_DIR     = path.join(__dirname, 'docs');
const QUEUE_DIR   = path.join(__dirname, 'queues', collection.id);
const GRADES_DIR  = path.join(QUEUE_DIR, 'grades');
const EXTRACT_DIR = path.join(QUEUE_DIR, 'extracts');

if (!fs.existsSync(GRADES_DIR))  fs.mkdirSync(GRADES_DIR, { recursive: true });
if (!fs.existsSync(EXTRACT_DIR)) fs.mkdirSync(EXTRACT_DIR, { recursive: true });

function hasCurrentCollection(payload) {
  return payload && payload.protocolVersion === 2 && payload.collectionId === collection.id;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.bmp':  'image/bmp',
  '.ico':  'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function getLocalIPs() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const iface of Object.values(nets))
    for (const n of iface)
      if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
  return ips;
}

function send(res, status, contentType, body) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function sendJson(res, data, status = 200) {
  send(res, status, 'application/json', data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) reject(new Error('Too large')); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function serveStatic(res, urlPath) {
  let filePath = path.join(PWA_DIR, urlPath === '/' ? 'index.html' : urlPath);
  if (!fs.existsSync(filePath)) {
    send(res, 404, 'text/plain', '404');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (req.method === 'OPTIONS') { send(res, 204, 'text/plain', ''); return; }

  // ── API ──────────────────────────────────────────────────────────────────
  if (url === '/api/today' && req.method === 'GET') {
    try {
      const cards = getTodayCards();
      sendJson(res, {
        protocolVersion: 2,
        collectionId: collection.id,
        collectionName: collection.name,
        date: new Date().toISOString().slice(0, 10),
        total: cards.length,
        cards,
      });
    } catch (e) {
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  if (url === '/api/grades' && req.method === 'POST') {
    try {
      const body  = await readBody(req);
      const payload = JSON.parse(body);
      if (!hasCurrentCollection(payload)) { sendJson(res, { error: 'Collection mismatch' }, 409); return; }
      // payload: { date, reviews: [{elementId, grade, timestamp}] }
      const dateStr = payload.date || new Date().toISOString().slice(0, 10);
      const file    = path.join(GRADES_DIR, `${dateStr}.json`);
      // Merge with any existing grades for the same date
      let existing = [];
      if (fs.existsSync(file)) existing = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const byId = Object.fromEntries(existing.map(r => [r.elementId, r]));
      for (const r of (payload.reviews || [])) {
        if (r.collectionId && r.collectionId !== collection.id) throw new Error('Collection mismatch');
        r.collectionId = collection.id;
        r.protocolVersion = 2;
        byId[r.elementId] = r;
      }
      fs.writeFileSync(file, JSON.stringify(Object.values(byId), null, 2));
      sendJson(res, { saved: Object.keys(byId).length });
    } catch (e) {
      sendJson(res, { error: e.message }, 400);
    }
    return;
  }

  // POST /api/extracts — save a single extract record
  if (url === '/api/extracts' && req.method === 'POST') {
    try {
      const extract = JSON.parse(await readBody(req));
      if (!hasCurrentCollection(extract)) { sendJson(res, { error: 'Collection mismatch' }, 409); return; }
      if (extract.collectionId && extract.collectionId !== collection.id) { sendJson(res, { error: 'Collection mismatch' }, 409); return; }
      extract.collectionId = collection.id;
      extract.protocolVersion = 2;
      const date    = new Date().toISOString().slice(0, 10);
      const file    = path.join(EXTRACT_DIR, `${date}.json`);
      let list = [];
      if (fs.existsSync(file)) list = JSON.parse(fs.readFileSync(file, 'utf-8'));
      // Deduplicate by id
      if (!list.find(e => e.id === extract.id)) list.push(extract);
      fs.writeFileSync(file, JSON.stringify(list, null, 2));
      sendJson(res, { saved: list.length });
    } catch (e) { sendJson(res, { error: e.message }, 400); }
    return;
  }

  // GET /api/extracts — return all pending (unapplied) extract files
  if (url === '/api/extracts' && req.method === 'GET') {
    const files = fs.readdirSync(EXTRACT_DIR).filter(f => f.endsWith('.json'));
    const all = [];
    for (const f of files) {
      try { all.push(...JSON.parse(fs.readFileSync(path.join(EXTRACT_DIR, f), 'utf-8'))); }
      catch {}
    }
    sendJson(res, all);
    return;
  }

  // GET /api/images/:id — serve element image file directly from SM collection
  const imgMatch = /^\/api\/images\/(\d+)$/.exec(url);
  if (imgMatch && req.method === 'GET') {
    const filePath = findElementFile(parseInt(imgMatch[1]));
    if (!filePath || !/\.(png|jpe?g|gif|bmp)$/i.test(filePath)) {
      send(res, 404, 'text/plain', '404'); return;
    }
    const ext  = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'image/png';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'max-age=3600', 'Access-Control-Allow-Origin': '*' });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  if (url === '/api/pending-grades' && req.method === 'GET') {
    // List all pending grade files (dates where grades were stored)
    const files = fs.readdirSync(GRADES_DIR).filter(f => f.endsWith('.json'));
    const all = [];
    for (const f of files) {
      try { all.push({ date: f.replace('.json',''), reviews: JSON.parse(fs.readFileSync(path.join(GRADES_DIR, f), 'utf-8')) }); }
      catch {}
    }
    sendJson(res, all);
    return;
  }

  // ── PWA static files ─────────────────────────────────────────────────────
  serveStatic(res, url);
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIPs();
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║         SMGo – SuperMemo Mobile Bridge       ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  Local:   http://localhost:${PORT}               ║`);
  for (const ip of ips)
    console.log(`║  Network: http://${ip.padEnd(15)}:${PORT}      ║`);
  console.log('╠══════════════════════════════════════════════╣');
  console.log('║  Open the Network URL on your Android phone  ║');
  console.log('║  Tap "Add to Home Screen" for PWA install    ║');
  console.log('╚══════════════════════════════════════════════╝\n');
});
