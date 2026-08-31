'use strict';
const fs   = require('fs');
const path = require('path');
const { getTodayCards, collection } = require('./sm-parser');

const date    = new Date().toISOString().slice(0, 10);
// The static/local JSON path cannot enrich PDF wrappers. Do not export an
// empty card that the PWA can only label "No renderable content".
const cards   = getTodayCards()
  .filter(c => c.type !== 'pdf-extract' || Boolean(c.body?.trim()));
const payload = {
  protocolVersion: 2,
  collectionId: collection.id,
  collectionName: collection.name,
  date, count: cards.length, cards, generated: new Date().toISOString(),
};

const dataDir  = path.join(__dirname, 'docs', 'data');
const outFile  = path.join(dataDir, 'today.json');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
console.log(`Exported ${cards.length} items → docs/data/today.json`);

console.log('Generation only; publishing is an explicit separate step.');
