'use strict';

// ── Mode detection ─────────────────────────────────────────────────────────
// Static mode = GitHub Pages (or any public host). No local server available.
// Server mode = localhost or private IP. Server is running, grades can sync.
function isStaticMode() {
  const h = window.location.hostname;
  if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0') return false;
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(h)) return false;
  return true;
}

function getServerUrl() {
  return localStorage.getItem('smgo_server') || window.location.origin;
}

// ── State ──────────────────────────────────────────────────────────────────
let cards    = [];
let idx      = 0;
let grades   = [];
let revealed = false;

// ── DOM refs ───────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const screenLoading = $('screen-loading');
const screenDone    = $('screen-done');
const screenError   = $('screen-error');
const cardArea      = $('card-area');
const progressBar   = $('progress-bar');
const progressText  = $('progress-text');
const revealBtn     = $('reveal-btn');
const gradeRow      = $('grade-row');
const syncStatus    = $('sync-status');
const offlineBanner = $('offline-banner');
const serverUrlWrap = $('server-url-wrap');

// ── Offline detection ──────────────────────────────────────────────────────
window.addEventListener('online',  () => {
  offlineBanner.style.display = 'none';
  if (!isStaticMode()) trySyncPending();
});
window.addEventListener('offline', () => { offlineBanner.style.display = 'block'; });
if (!navigator.onLine) offlineBanner.style.display = 'block';

// ── Service Worker ─────────────────────────────────────────────────────────
if ('serviceWorker' in navigator)
  navigator.serviceWorker.register('./sw.js').catch(() => {});

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  showScreen('loading');

  if (isStaticMode()) {
    serverUrlWrap.textContent = 'GitHub Pages – offline-ready';
    await initStatic();
  } else {
    serverUrlWrap.innerHTML = `Server: <a href="${getServerUrl()}" target="_blank">${getServerUrl()}</a>`;
    await syncAllPending(); // upload any grades stored while on the go
    await initServer();
  }
}

async function initStatic() {
  try {
    const res  = await fetch('./data/today.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.cards || data.cards.length === 0) {
      showScreen('done', '🎉 No items due today!', '');
      return;
    }
    cards = data.cards;
    idx   = 0;
    loadStoredProgress();
    showScreen('review');
    renderCard();
  } catch (err) {
    // Try service worker cache
    try {
      const cached = await caches.match('./data/today.json');
      if (cached) {
        const data = await cached.json();
        if (data.cards && data.cards.length) {
          cards = data.cards;
          idx   = 0;
          loadStoredProgress();
          showScreen('review');
          renderCard();
          setSyncStatus('Offline – using cached items', 'fail');
          return;
        }
      }
    } catch {}
    $('error-msg').textContent = 'No exported data found.';
    $('error-hint').textContent = 'Run "node export.js" on your desktop first, then push to GitHub.';
    showScreen('error');
  }
}

async function initServer() {
  try {
    const res  = await fetch(`${getServerUrl()}/api/today`);
    const data = await res.json();
    if (!data.cards || data.cards.length === 0) {
      showScreen('done', '🎉 No items due today!', '');
      return;
    }
    cards = data.cards;
    idx   = 0;
    loadStoredProgress();
    showScreen('review');
    renderCard();
  } catch (err) {
    // Offline fallback
    try {
      const cached = await caches.match('/api/today');
      if (cached) {
        const data = await cached.json();
        if (data.cards && data.cards.length) {
          cards = data.cards;
          idx   = 0;
          loadStoredProgress();
          showScreen('review');
          renderCard();
          setSyncStatus('Offline – using cached items', 'fail');
          return;
        }
      }
    } catch {}
    $('error-msg').textContent = err.message;
    $('error-hint').textContent = 'Make sure SMGo server is running on your desktop and you\'re on the same Wi-Fi, or tap ⚙ to change the server URL.';
    showScreen('error');
  }
}

// ── Progress persistence ───────────────────────────────────────────────────
function todayKey() {
  return 'smgo_progress_' + new Date().toISOString().slice(0, 10);
}
function loadStoredProgress() {
  try {
    const saved = JSON.parse(localStorage.getItem(todayKey()) || '{}');
    grades = saved.grades || [];
    const done = new Set(grades.map(g => g.elementId));
    const next = cards.findIndex(c => !done.has(c.id));
    idx = next === -1 ? cards.length : next;
  } catch { grades = []; }
}
function saveProgress() {
  const key  = todayKey();
  const prev = JSON.parse(localStorage.getItem(key) || '{}');
  localStorage.setItem(key, JSON.stringify({ ...prev, grades, ts: Date.now() }));
}

// ── Screen management ──────────────────────────────────────────────────────
function showScreen(name, msg = '', sub = '') {
  screenLoading.style.display = 'none';
  screenDone.style.display    = 'none';
  screenError.style.display   = 'none';
  cardArea.style.display      = 'none';
  $('action-area').style.display = 'none';

  if (name === 'loading') {
    screenLoading.style.display = 'flex';
  } else if (name === 'done') {
    $('done-msg').textContent = msg || `${grades.length} items reviewed.`;
    $('done-sub').textContent = sub;
    screenDone.style.display = 'flex';
  } else if (name === 'error') {
    screenError.style.display = 'flex';
  } else if (name === 'review') {
    cardArea.style.display = 'flex';
    $('action-area').style.display = 'flex';
  }
}

// ── Card rendering ─────────────────────────────────────────────────────────
function renderCard() {
  if (idx >= cards.length) {
    syncAndDone();
    return;
  }

  revealed = false;
  const c     = cards[idx];
  const total = cards.length;
  const done  = idx;

  progressBar.style.width = `${(done / total) * 100}%`;
  progressText.textContent = `${done} / ${total}`;

  const typeLabel = { topic: 'Topic', 'pdf-extract': 'PDF Extract', cloze: 'Cloze' };
  const badgeClass = 'badge-' + (c.type || 'topic');

  let bodyHtml = '';
  if (c.type === 'cloze' && c.clozeSentence) {
    const blanked = c.clozeSentence.replace('[___]', '<span class="cloze-blank" id="cloze-blank">[___]</span>');
    bodyHtml = `<div class="cloze-sentence">${blanked}</div>`;
    if (c.body) bodyHtml += `<div class="card-body">${esc(c.body)}</div>`;
  } else if (c.body) {
    bodyHtml = `<div class="card-body">${esc(c.body)}</div>`;
  } else {
    bodyHtml = `<div class="card-body" style="color:var(--muted)">No renderable content.</div>`;
  }

  cardArea.innerHTML = `
    <div class="card">
      <span class="card-type-badge ${badgeClass}">${typeLabel[c.type] || c.type}</span>
      <div class="card-title">${esc(c.title)}</div>
      ${bodyHtml}
    </div>`;

  revealBtn.style.display = 'block';
  gradeRow.style.display  = 'none';

  if (c.type === 'cloze') {
    revealBtn.textContent = 'Reveal Answer';
    revealBtn.onclick = doReveal;
  } else {
    // Topics and PDF extracts are for reading/extraction — no grading needed
    revealBtn.textContent = 'Done (read)';
    revealBtn.onclick = () => applyGrade(5);
  }
}

function doReveal() {
  revealed = true;
  const blank = document.getElementById('cloze-blank');
  if (blank) blank.classList.add('revealed');
  showGrades();
}

function showGrades() {
  revealBtn.style.display = 'none';
  gradeRow.style.display  = 'grid';
}

function esc(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Grading ────────────────────────────────────────────────────────────────
const GRADE_LABELS = [
  ['0','Null'],['1','Fail'],['2','Hard'],['3','Pass'],['4','Good'],['5','Bright']
];

(function buildGradeButtons() {
  gradeRow.innerHTML = '';
  GRADE_LABELS.forEach(([g, label]) => {
    const btn = document.createElement('button');
    btn.className = `grade-btn g${g}`;
    btn.innerHTML = `${g}<br><small>${label}</small>`;
    btn.addEventListener('click', () => applyGrade(parseInt(g)));
    gradeRow.appendChild(btn);
  });
})();

function applyGrade(grade) {
  const card = cards[idx];
  grades.push({ elementId: card.id, grade, timestamp: new Date().toISOString() });
  saveProgress();
  idx++;
  renderCard();
}

// ── Sync & Done ────────────────────────────────────────────────────────────
async function syncAndDone() {
  if (isStaticMode()) {
    // Grades stay in localStorage; user syncs when home
    const serverUrl = localStorage.getItem('smgo_server') || '';
    const hint = serverUrl
      ? `Open ${serverUrl} on your home network to sync.`
      : 'Connect to your home Wi-Fi and open the SMGo server to sync grades.';
    showScreen('done', `${grades.length} items reviewed.`, hint);
    setSyncStatus('Grades saved locally – sync at home', 'fail');
    return;
  }

  showScreen('done', `${grades.length} items reviewed.`, 'Syncing…');
  setSyncStatus('Syncing grades…', '');
  const ok = await pushTodayGrades();
  if (ok) {
    $('done-msg').textContent = `${grades.length} grades synced to desktop.`;
    $('done-sub').textContent = 'Run apply-grades.bat to apply them in SuperMemo.';
    setSyncStatus(`✓ ${grades.length} grades synced`, 'ok');
  } else {
    $('done-sub').textContent = `Offline – grades saved locally.`;
    setSyncStatus('Offline – will sync when connected', 'fail');
  }
}

async function pushTodayGrades() {
  if (grades.length === 0) return true;
  try {
    const res = await fetch(`${getServerUrl()}/api/grades`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date: new Date().toISOString().slice(0, 10),
        reviews: grades,
      }),
    });
    if (res.ok) {
      // Mark today as synced
      const key  = todayKey();
      const prev = JSON.parse(localStorage.getItem(key) || '{}');
      localStorage.setItem(key, JSON.stringify({ ...prev, synced: true }));
    }
    return res.ok;
  } catch { return false; }
}

// Upload all unsynced grade sets (called on server-mode init)
async function syncAllPending() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith('smgo_progress_')) keys.push(k);
  }
  let total = 0;
  for (const k of keys) {
    const saved = JSON.parse(localStorage.getItem(k) || '{}');
    if (!saved.grades || saved.grades.length === 0 || saved.synced) continue;
    const date = k.replace('smgo_progress_', '');
    try {
      const res = await fetch(`${getServerUrl()}/api/grades`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, reviews: saved.grades }),
      });
      if (res.ok) {
        localStorage.setItem(k, JSON.stringify({ ...saved, synced: true }));
        total += saved.grades.length;
      }
    } catch {}
  }
  if (total > 0) setSyncStatus(`✓ Synced ${total} pending grades from phone`, 'ok');
}

async function trySyncPending() {
  await syncAllPending();
}

function setSyncStatus(msg, cls) {
  syncStatus.textContent = msg;
  syncStatus.className   = cls ? `sync-${cls}` : '';
}

// ── Settings ───────────────────────────────────────────────────────────────
$('settings-icon').addEventListener('click', () => {
  const cur = getServerUrl();
  const url = prompt('SMGo server URL (e.g. http://192.168.1.10:3001)\nLeave blank to use current origin.', cur);
  if (url !== null) {
    if (url.trim()) localStorage.setItem('smgo_server', url.trim());
    else localStorage.removeItem('smgo_server');
    location.reload();
  }
});

$('retry-btn').addEventListener('click', () => location.reload());
$('done-restart-btn').addEventListener('click', () => {
  localStorage.removeItem(todayKey());
  location.reload();
});

// ── Start ──────────────────────────────────────────────────────────────────
init();
