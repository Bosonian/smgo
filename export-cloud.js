'use strict';
// Pushes today's SM cards to Supabase smgo_daily table.
// Run automatically by the SMA plugin on SM startup, or manually.
const fs   = require('fs');
const path = require('path');
const https = require('https');
const { getTodayCards } = require('./sm-parser');

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

function supaRequest(path, method, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url  = new URL(base + path);
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

(async () => {
  // Ensure tables exist (idempotent — safe to call every time)
  const setup = await supaRequest('/rest/v1/rpc/smgo_setup', 'POST', {});
  if (setup.status !== 200 && setup.status !== 204) {
    console.error(`SMGo: smgo_setup() failed (${setup.status}): ${setup.body}`);
    // Non-fatal — tables may already exist
  }

  const date    = new Date().toISOString().slice(0, 10);
  const cards   = getTodayCards();
  const payload = { date, count: cards.length, cards, generated: new Date().toISOString() };

  const push = await supaRequest(
    '/rest/v1/smgo_daily', 'POST',
    { date, data: payload },
    { 'Prefer': 'resolution=merge-duplicates' }
  );
  console.log(`SMGo: pushed ${cards.length} cards to Supabase (HTTP ${push.status})`);
})().catch(e => console.error('SMGo export-cloud error:', e.message));
