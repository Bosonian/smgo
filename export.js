'use strict';
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { getTodayCards } = require('./sm-parser');

const date    = new Date().toISOString().slice(0, 10);
const cards   = getTodayCards();
const payload = { date, count: cards.length, cards, generated: new Date().toISOString() };

const dataDir  = path.join(__dirname, 'docs', 'data');
const outFile  = path.join(dataDir, 'today.json');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
console.log(`Exported ${cards.length} items → docs/data/today.json`);

// Git: stage, commit, push
try {
  execSync('git add docs/data/today.json', { cwd: __dirname, stdio: 'inherit' });
  execSync(`git commit -m "export: ${date} (${cards.length} items)"`, { cwd: __dirname, stdio: 'inherit' });
  execSync('git push', { cwd: __dirname, stdio: 'inherit' });
  console.log(`Pushed. Open https://bosonian.github.io/smgo/ on your phone.`);
} catch (e) {
  console.error('Git step failed:', e.message);
  console.log('If this is a fresh repo, run: git push -u origin main');
}
