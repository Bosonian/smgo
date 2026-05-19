'use strict';

// ── Mode detection ─────────────────────────────────────────────────────────
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
const screenLoading  = $('screen-loading');
const screenDone     = $('screen-done');
const screenError    = $('screen-error');
const cardArea       = $('card-area');
const progressBar    = $('progress-bar');
const progressText   = $('progress-text');
const revealBtn      = $('reveal-btn');
const gradeRow       = $('grade-row');
const syncStatus     = $('sync-status');
const offlineBanner  = $('offline-banner');
const serverUrlWrap  = $('server-url-wrap');
const extractToolbar = $('extract-toolbar');
const extractBadgeBtn= $('extract-badge-btn');
const extractCount   = $('extract-count');
const extractDrawer  = $('extract-drawer');
const extractList    = $('extract-list');

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
  loadExtracts();

  if (isStaticMode()) {
    serverUrlWrap.textContent = 'GitHub Pages – offline-ready';
    await initStatic();
  } else {
    serverUrlWrap.innerHTML = `Server: <a href="${getServerUrl()}" target="_blank">${getServerUrl()}</a>`;
    await syncAllPending();
    await syncAllExtracts();
    await initServer();
  }
}

async function initStatic() {
  try {
    const res  = await fetch('./data/today.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.cards || data.cards.length === 0) {
      showScreen('done', 'No items due today!', '');
      return;
    }
    cards = data.cards;
    idx   = 0;
    loadStoredProgress();
    showScreen('review');
    renderCard();
  } catch (err) {
    try {
      const cached = await caches.match('./data/today.json');
      if (cached) {
        const data = await cached.json();
        if (data.cards && data.cards.length) {
          cards = data.cards; idx = 0;
          loadStoredProgress(); showScreen('review'); renderCard();
          setSyncStatus('Offline – using cached items', 'fail');
          return;
        }
      }
    } catch {}
    $('error-msg').textContent = 'No exported data found.';
    $('error-hint').textContent = 'Run export.bat on your desktop first, then push to GitHub.';
    showScreen('error');
  }
}

async function initServer() {
  try {
    const res  = await fetch(`${getServerUrl()}/api/today`);
    const data = await res.json();
    if (!data.cards || data.cards.length === 0) {
      showScreen('done', 'No items due today!', '');
      return;
    }
    cards = data.cards; idx = 0;
    loadStoredProgress(); showScreen('review'); renderCard();
  } catch (err) {
    try {
      const cached = await caches.match('/api/today');
      if (cached) {
        const data = await cached.json();
        if (data.cards && data.cards.length) {
          cards = data.cards; idx = 0;
          loadStoredProgress(); showScreen('review'); renderCard();
          setSyncStatus('Offline – using cached items', 'fail');
          return;
        }
      }
    } catch {}
    $('error-msg').textContent = err.message;
    $('error-hint').textContent = "Make sure SMGo server is running and you're on the same Wi-Fi, or tap ⚙ to set the server URL.";
    showScreen('error');
  }
}

// ── Progress persistence ───────────────────────────────────────────────────
function todayKey() { return 'smgo_progress_' + new Date().toISOString().slice(0, 10); }

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
  const prev = JSON.parse(localStorage.getItem(todayKey()) || '{}');
  localStorage.setItem(todayKey(), JSON.stringify({ ...prev, grades, ts: Date.now() }));
}

// ── Screen management ──────────────────────────────────────────────────────
function showScreen(name, msg = '', sub = '') {
  screenLoading.style.display = 'none';
  screenDone.style.display    = 'none';
  screenError.style.display   = 'none';
  cardArea.style.display      = 'none';
  $('action-area').style.display = 'none';

  if (name === 'loading') { screenLoading.style.display = 'flex'; }
  else if (name === 'done') {
    $('done-msg').textContent = msg || `${grades.length} items reviewed.`;
    $('done-sub').textContent = sub;
    screenDone.style.display = 'flex';
  }
  else if (name === 'error') { screenError.style.display = 'flex'; }
  else if (name === 'review') {
    cardArea.style.display = 'flex';
    $('action-area').style.display = 'flex';
  }
}

// ── Card rendering ─────────────────────────────────────────────────────────
function renderCard() {
  if (idx >= cards.length) { syncAndDone(); return; }

  revealed = false;
  hideExtractToolbar();
  const c     = cards[idx];
  const total = cards.length;

  progressBar.style.width  = `${(idx / total) * 100}%`;
  progressText.textContent = `${idx} / ${total}`;

  const typeLabel  = { topic: 'Topic', 'pdf-extract': 'PDF Extract', cloze: 'Cloze' };
  const badgeClass = 'badge-' + (c.type || 'topic');

  let bodyHtml = '';
  if (c.type === 'cloze' && c.clozeSentence) {
    const blanked = c.clozeSentence.replace('[___]',
      '<span class="cloze-blank" id="cloze-blank">[___]</span>');
    bodyHtml = `<div class="cloze-sentence">${blanked}</div>`;
    if (c.body) bodyHtml += `<div class="card-body selectable">${esc(c.body)}</div>`;
  } else if (c.body) {
    bodyHtml = `<div class="card-body selectable">${esc(c.body)}</div>`;
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
const GRADE_LABELS = [['0','Null'],['1','Fail'],['2','Hard'],['3','Pass'],['4','Good'],['5','Bright']];

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
  grades.push({ elementId: cards[idx].id, grade, timestamp: new Date().toISOString() });
  saveProgress();
  idx++;
  renderCard();
}

// ── Sync & Done ────────────────────────────────────────────────────────────
async function syncAndDone() {
  if (isStaticMode()) {
    const serverUrl = localStorage.getItem('smgo_server') || '';
    const hint = serverUrl
      ? `Open ${serverUrl} on home network to sync grades.`
      : 'Open SMGo on your home network to sync grades.';
    showScreen('done', `${grades.length} items reviewed.`, hint);
    setSyncStatus('Grades saved locally – sync at home', 'fail');
    return;
  }
  showScreen('done', `${grades.length} items reviewed.`, 'Syncing…');
  const ok = await pushTodayGrades();
  if (ok) {
    $('done-msg').textContent = `${grades.length} grades synced.`;
    $('done-sub').textContent = 'Run apply-grades.bat to apply in SuperMemo.';
    setSyncStatus(`✓ ${grades.length} grades synced`, 'ok');
  } else {
    $('done-sub').textContent = 'Offline – grades saved locally.';
    setSyncStatus('Offline – will sync when connected', 'fail');
  }
}

async function pushTodayGrades() {
  if (grades.length === 0) return true;
  try {
    const res = await fetch(`${getServerUrl()}/api/grades`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: new Date().toISOString().slice(0,10), reviews: grades }),
    });
    if (res.ok) {
      const prev = JSON.parse(localStorage.getItem(todayKey()) || '{}');
      localStorage.setItem(todayKey(), JSON.stringify({ ...prev, synced: true }));
    }
    return res.ok;
  } catch { return false; }
}

async function syncAllPending() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith('smgo_progress_')) keys.push(k);
  }
  let total = 0;
  for (const k of keys) {
    const saved = JSON.parse(localStorage.getItem(k) || '{}');
    if (!saved.grades || !saved.grades.length || saved.synced) continue;
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

async function trySyncPending() { await syncAllPending(); }
function setSyncStatus(msg, cls) {
  syncStatus.textContent = msg;
  syncStatus.className   = cls ? `sync-${cls}` : '';
}

// ── Extract UI ─────────────────────────────────────────────────────────────
let pendingExtracts = [];

function loadExtracts() {
  try { pendingExtracts = JSON.parse(localStorage.getItem('smgo_extracts') || '[]'); }
  catch { pendingExtracts = []; }
  updateExtractBadge();
}
function saveExtracts() {
  localStorage.setItem('smgo_extracts', JSON.stringify(pendingExtracts));
  updateExtractBadge();
}
function updateExtractBadge() {
  const n = pendingExtracts.length;
  extractCount.textContent = n;
  extractBadgeBtn.style.display = n > 0 ? 'flex' : 'none';
}

// Floating toolbar: appears above text selection inside card body
let selTimer = null;
document.addEventListener('selectionchange', () => {
  clearTimeout(selTimer);
  selTimer = setTimeout(onSelectionChange, 250);
});

function onSelectionChange() {
  const sel = window.getSelection();
  const text = sel?.toString().trim() ?? '';
  if (text.length < 5) { hideExtractToolbar(); return; }

  // Only show when selection is inside .selectable
  if (!sel.rangeCount) { hideExtractToolbar(); return; }
  const anchor = sel.getRangeAt(0).commonAncestorContainer;
  const node   = anchor instanceof Element ? anchor : anchor.parentElement;
  if (!node?.closest('.selectable')) { hideExtractToolbar(); return; }

  positionExtractToolbar(sel.getRangeAt(0));
}

function positionExtractToolbar(range) {
  const rect = range.getBoundingClientRect();
  // Centre the toolbar horizontally over the selection, just above it
  const cx = rect.left + rect.width / 2;
  const ty = rect.top - 8;   // 8px gap above selection
  extractToolbar.style.left = cx + 'px';
  extractToolbar.style.top  = ty + 'px';
  extractToolbar.classList.add('visible');
}
function hideExtractToolbar() {
  extractToolbar.classList.remove('visible');
}

function captureExtract() {
  const sel  = window.getSelection();
  const text = sel?.toString().trim() ?? '';
  if (!text || !cards[idx]) { hideExtractToolbar(); return; }

  const card = cards[idx];
  const extract = {
    id:          `${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    parentId:    card.id,
    parentTitle: card.title,
    text,
    timestamp:   new Date().toISOString(),
    synced:      false,
  };

  pendingExtracts.push(extract);
  saveExtracts();

  sel.removeAllRanges();
  hideExtractToolbar();
  showExtractFlash(text);

  if (!isStaticMode()) uploadExtract(extract);
}

async function uploadExtract(extract) {
  try {
    const res = await fetch(`${getServerUrl()}/api/extracts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(extract),
    });
    if (res.ok) {
      extract.synced = true;
      saveExtracts();
    }
  } catch {}
}

async function syncAllExtracts() {
  for (const e of pendingExtracts.filter(x => !x.synced)) {
    await uploadExtract(e);
  }
}

function showExtractFlash(text) {
  const el = document.createElement('div');
  el.className = 'extract-flash';
  el.textContent = `Extracted: "${text.slice(0, 40)}${text.length > 40 ? '…' : ''}"`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2000);
}

// Extract drawer
function openExtractDrawer() {
  renderExtractList();
  extractDrawer.classList.add('open');
  $('extract-drawer-backdrop').classList.add('open');
}
function closeExtractDrawer() {
  extractDrawer.classList.remove('open');
  $('extract-drawer-backdrop').classList.remove('open');
}

function renderExtractList() {
  if (pendingExtracts.length === 0) {
    extractList.innerHTML = '<p style="color:var(--muted);text-align:center;padding:24px;font-size:.85rem">No pending extracts</p>';
    return;
  }
  extractList.innerHTML = pendingExtracts.map((e, i) => `
    <div class="extract-item">
      <div class="extract-parent">#${e.parentId} · ${esc(e.parentTitle.slice(0,50))}</div>
      <div class="extract-text">${esc(e.text.slice(0, 120))}${e.text.length > 120 ? '…' : ''}</div>
      <div class="extract-meta">${new Date(e.timestamp).toLocaleString()}${e.synced ? ' · ✓ synced' : ''}</div>
      <button class="extract-delete-btn" data-i="${i}">✕</button>
    </div>`).join('');

  extractList.querySelectorAll('.extract-delete-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      pendingExtracts.splice(parseInt(btn.dataset.i), 1);
      saveExtracts();
      renderExtractList();
    });
  });
}

// ── Settings ───────────────────────────────────────────────────────────────
$('settings-icon').addEventListener('click', () => {
  const url = prompt('SMGo server URL (e.g. http://192.168.1.10:3001)', getServerUrl());
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

$('extract-btn').addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  captureExtract();
});
extractBadgeBtn.addEventListener('click', openExtractDrawer);
$('extract-drawer-close').addEventListener('click', closeExtractDrawer);
$('extract-drawer-backdrop').addEventListener('click', closeExtractDrawer);
$('extract-clear-btn').addEventListener('click', () => {
  if (confirm('Clear all pending extracts?')) {
    pendingExtracts = [];
    saveExtracts();
    renderExtractList();
  }
});
$('extract-sync-btn').addEventListener('click', async () => {
  if (isStaticMode()) { alert('Sync only available on home network.'); return; }
  await syncAllExtracts();
  renderExtractList();
  setSyncStatus(`✓ ${pendingExtracts.filter(e=>e.synced).length} extracts synced`, 'ok');
});

// ── Start ──────────────────────────────────────────────────────────────────
init();
