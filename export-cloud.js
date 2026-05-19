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

const date    = new Date().toISOString().slice(0, 10);
const cards   = getTodayCards();
const payload = { date, count: cards.length, cards, generated: new Date().toISOString() };
const body    = JSON.stringify({ date, data: payload });

const supaUrl = new URL(config.supabaseUrl.replace(/\/$/, ''));
const options = {
  hostname: supaUrl.hostname,
  path:     '/rest/v1/smgo_daily',
  method:   'POST',
  headers: {
    'apikey':         config.supabaseKey,
    'Authorization':  `Bearer ${config.supabaseKey}`,
    'Content-Type':   'application/json',
    'Prefer':         'resolution=merge-duplicates',
    'Content-Length': Buffer.byteLength(body),
  },
};

const req = https.request(options, res => {
  console.log(`SMGo: pushed ${cards.length} cards to Supabase (HTTP ${res.statusCode})`);
});
req.on('error', e => console.error('SMGo export-cloud error:', e.message));
req.write(body);
req.end();
