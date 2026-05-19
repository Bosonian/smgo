'use strict';

// ── Theme ──────────────────────────────────────────────────────────────────
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = t === 'light' ? '🌙' : '☀️';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = t === 'light' ? '#f8fafc' : '#0f172a';
}
applyTheme(localStorage.getItem('smgo_theme') || 'dark');

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
    let n = 0;
    const blanked = c.clozeSentence.replace(/\[___\]/g,
      () => `<span class="cloze-blank" data-bi="${n++}">[___]</span>`);
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

  const isDismissable = c.type === 'topic' || c.type === 'pdf-extract';
  $('dismiss-btn').style.display = isDismissable ? 'inline-flex' : 'none';

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
  document.querySelectorAll('.cloze-blank').forEach(el => el.classList.add('revealed'));
  showGrades();
}

function skipCard() {
  idx++;
  renderCard();
}

function dismissCard() {
  const card = cards[idx];
  if (!card) return;
  // Record dismiss for server sync
  const rec = { elementId: card.id, timestamp: new Date().toISOString() };
  if (!isStaticMode()) {
    fetch(`${getServerUrl()}/api/dismiss`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rec),
    }).catch(() => {});
  }
  idx++;
  renderCard();
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
const GRADE_LABELS = [['0','Null'],['1','Bad'],['2','Fail'],['3','Pass'],['4','Good'],['5','Bright']];

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

// ── Extract + Items UI ─────────────────────────────────────────────────────
let pendingExtracts = [];
let pendingItems    = [];  // cloze + Q&A

function loadExtracts() {
  try { pendingExtracts = JSON.parse(localStorage.getItem('smgo_extracts') || '[]'); }
  catch { pendingExtracts = []; }
  try { pendingItems    = JSON.parse(localStorage.getItem('smgo_items')    || '[]'); }
  catch { pendingItems  = []; }
  updateExtractBadge();
}
function saveExtracts() {
  localStorage.setItem('smgo_extracts', JSON.stringify(pendingExtracts));
  updateExtractBadge();
}
function saveItems() {
  localStorage.setItem('smgo_items', JSON.stringify(pendingItems));
  updateExtractBadge();
}
function updateExtractBadge() {
  const n = pendingExtracts.length + pendingItems.length;
  extractCount.textContent = n;
  extractBadgeBtn.style.display = n > 0 ? 'flex' : 'none';
}

// Floating toolbar: appears above text selection inside card body
let selTimer = null;
function scheduleSelCheck(ms) {
  clearTimeout(selTimer);
  selTimer = setTimeout(onSelectionChange, ms);
}

document.addEventListener('selectionchange', () => scheduleSelCheck(250));
// touchend is more reliable on mobile — fire after finger lifts
document.addEventListener('touchend', () => scheduleSelCheck(350), { passive: true });

function onSelectionChange() {
  const sel  = window.getSelection();
  const text = sel?.toString().trim() ?? '';
  if (text.length < 2) { hideExtractToolbar(); return; }
  if (!sel.rangeCount)  { hideExtractToolbar(); return; }

  const range = sel.getRangeAt(0);
  const inSelectable = n => {
    const el = (n instanceof Element) ? n : n.parentElement;
    return !!el?.closest('.selectable');
  };
  // check startContainer OR commonAncestor (cross-element selections differ)
  if (!inSelectable(range.startContainer) && !inSelectable(range.commonAncestorContainer)) {
    hideExtractToolbar(); return;
  }

  positionExtractToolbar(range);
}

function positionExtractToolbar(range) {
  const rect  = range.getBoundingClientRect();
  // clamp x so toolbar stays within viewport edges
  const cx    = Math.max(60, Math.min(rect.left + rect.width / 2, window.innerWidth - 60));
  const above = rect.top - 8;
  const below = rect.bottom + 8;
  // if selection is near the top (e.g. behind header), show toolbar below instead
  const flip  = above < 60;

  extractToolbar.style.left      = cx + 'px';
  extractToolbar.style.top       = (flip ? below : above) + 'px';
  extractToolbar.style.transform = flip ? 'translate(-50%, 0)' : 'translate(-50%, -100%)';
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

  // Wrap the selected range in a highlight mark (matches native SM behaviour)
  try {
    const range = sel.getRangeAt(0);
    const mark  = document.createElement('mark');
    mark.className = 'extracted-mark';
    range.surroundContents(mark);
  } catch {}
  sel.removeAllRanges();
  hideExtractToolbar();
  showExtractFlash(text);

  if (!isStaticMode()) uploadExtract(extract);
}

// ── Cloze creation ─────────────────────────────────────────────────────────
let clozeWords = [];
let clozeParentId = 0;
let clozeParentTitle = '';

function captureForCloze() {
  const sel  = window.getSelection();
  const text = sel?.toString().trim() ?? '';
  if (!text || !cards[idx]) { hideExtractToolbar(); return; }
  clozeParentId    = cards[idx].id;
  clozeParentTitle = cards[idx].title;
  clozeWords       = text.split(/(\s+)/).map(t => ({ word: t, blank: false, isSpace: /^\s+$/.test(t) }));
  sel.removeAllRanges();
  hideExtractToolbar();
  renderClozeEditor();
  $('cloze-modal').classList.add('open');
}

function renderClozeEditor() {
  const editor = $('cloze-word-editor');
  editor.innerHTML = clozeWords.map((w, i) =>
    w.isSpace ? ' '
    : `<span class="cloze-word${w.blank ? ' blanked' : ''}" data-i="${i}">${esc(w.word)}</span>`
  ).join('');
  editor.querySelectorAll('.cloze-word').forEach(el => {
    el.addEventListener('click', () => {
      clozeWords[+el.dataset.i].blank = !clozeWords[+el.dataset.i].blank;
      renderClozeEditor();
    });
  });
  $('cloze-preview').textContent = clozeWords.map(w =>
    w.isSpace ? ' ' : w.blank ? `[${w.word}]` : w.word
  ).join('');
}

function saveCloze() {
  if (!clozeWords.filter(w => !w.isSpace).some(w => w.blank)) {
    alert('Tap at least one word to blank it first.'); return;
  }
  const sentence = clozeWords.map(w => w.isSpace ? ' ' : w.blank ? `[${w.word}]` : w.word).join('');
  const item = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    type: 'cloze', parentId: clozeParentId, parentTitle: clozeParentTitle,
    sentence, timestamp: new Date().toISOString(), synced: false,
  };
  pendingItems.push(item);
  saveItems();
  $('cloze-modal').classList.remove('open');
  showFlash('[ ] Cloze saved');
  if (!isStaticMode()) uploadItem(item);
}

// ── Q&A via Gemini ──────────────────────────────────────────────────────────
let qaParentId = 0;
let qaParentTitle = '';

async function captureForQA() {
  const sel  = window.getSelection();
  const text = sel?.toString().trim() ?? '';
  if (!text || !cards[idx]) { hideExtractToolbar(); return; }

  let apiKey = localStorage.getItem('smgo_gemini_key') || '';
  if (!apiKey) {
    apiKey = prompt('Enter your Gemini API key:') || '';
    if (!apiKey) return;
    localStorage.setItem('smgo_gemini_key', apiKey.trim());
    apiKey = apiKey.trim();
  }

  qaParentId    = cards[idx].id;
  qaParentTitle = cards[idx].title;
  sel.removeAllRanges();
  hideExtractToolbar();

  $('qa-loading').style.display   = 'block';
  $('qa-form').style.display      = 'none';
  $('qa-modal').classList.add('open');

  try {
    const { question, answer } = await callGemini(text, apiKey);
    $('qa-question').value        = question;
    $('qa-answer').value          = answer;
    $('qa-loading').style.display = 'none';
    $('qa-form').style.display    = 'block';
  } catch (err) {
    $('qa-modal').classList.remove('open');
    alert(`Gemini error: ${err.message}`);
  }
}

async function callGemini(text, apiKey) {
  const prompt = `Convert this text into ONE concise SuperMemo Q&A flashcard for spaced repetition. Return valid JSON with exactly two string fields "question" and "answer", nothing else.\n\nText: ${text}`;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.3, maxOutputTokens: 300 } }) }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return JSON.parse(data.candidates[0].content.parts[0].text);
}

function saveQA() {
  const question = $('qa-question').value.trim();
  const answer   = $('qa-answer').value.trim();
  if (!question || !answer) { alert('Question and answer are required.'); return; }
  const item = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    type: 'qa', parentId: qaParentId, parentTitle: qaParentTitle,
    question, answer, timestamp: new Date().toISOString(), synced: false,
  };
  pendingItems.push(item);
  saveItems();
  $('qa-modal').classList.remove('open');
  showFlash('🤖 Q&A saved');
  if (!isStaticMode()) uploadItem(item);
}

// ── Upload / sync ──────────────────────────────────────────────────────────
async function uploadExtract(extract) {
  try {
    const res = await fetch(`${getServerUrl()}/api/extracts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(extract),
    });
    if (res.ok) { extract.synced = true; saveExtracts(); }
  } catch {}
}

async function uploadItem(item) {
  try {
    const res = await fetch(`${getServerUrl()}/api/items`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item),
    });
    if (res.ok) { item.synced = true; saveItems(); }
  } catch {}
}

async function syncAllExtracts() {
  for (const e of pendingExtracts.filter(x => !x.synced)) await uploadExtract(e);
  for (const i of pendingItems.filter(x => !x.synced))    await uploadItem(i);
}

function showFlash(msg) {
  const el = document.createElement('div');
  el.className   = 'extract-flash';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2000);
}

function showExtractFlash(text) {
  showFlash(`Extracted: "${text.slice(0, 40)}${text.length > 40 ? '…' : ''}"`);
}

// ── Pending items drawer ───────────────────────────────────────────────────
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
  const all = [
    ...pendingExtracts.map(e => ({ ...e, _kind: 'extract' })),
    ...pendingItems.map(i => ({ ...i, _kind: i.type })),
  ].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  if (all.length === 0) {
    extractList.innerHTML = '<p style="color:var(--muted);text-align:center;padding:24px;font-size:.85rem">No pending items</p>';
    return;
  }

  const kindLabel = { extract: '✂ Extract', cloze: '[ ] Cloze', qa: '🤖 Q&A' };
  extractList.innerHTML = all.map((item) => {
    let preview = '';
    if (item._kind === 'extract') preview = esc((item.text  || '').slice(0, 120));
    if (item._kind === 'cloze')   preview = esc((item.sentence || '').slice(0, 120));
    if (item._kind === 'qa')      preview = `Q: ${esc((item.question||'').slice(0,80))}`;
    return `<div class="extract-item">
      <div class="extract-parent">
        <span class="kind-badge kind-${item._kind}">${kindLabel[item._kind] || item._kind}</span>
        #${item.parentId} · ${esc((item.parentTitle||'').slice(0,40))}
      </div>
      <div class="extract-text">${preview}</div>
      <div class="extract-meta">${new Date(item.timestamp).toLocaleString()}${item.synced ? ' · ✓' : ''}</div>
    </div>`;
  }).join('');
}

// ── Settings ───────────────────────────────────────────────────────────────
$('theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  localStorage.setItem('smgo_theme', next);
  applyTheme(next);
});

$('settings-icon').addEventListener('click', () => {
  const choice = prompt(
    'Settings\n\n1) Server URL\n2) Gemini API key\n\nEnter 1 or 2:',
  );
  if (choice === '1') {
    const url = prompt('SMGo server URL', getServerUrl());
    if (url !== null) {
      if (url.trim()) localStorage.setItem('smgo_server', url.trim());
      else localStorage.removeItem('smgo_server');
      location.reload();
    }
  } else if (choice === '2') {
    const key = prompt('Gemini API key (leave blank to clear):', localStorage.getItem('smgo_gemini_key') || '');
    if (key !== null) {
      if (key.trim()) localStorage.setItem('smgo_gemini_key', key.trim());
      else localStorage.removeItem('smgo_gemini_key');
    }
  }
});

$('retry-btn').addEventListener('click', () => location.reload());
$('done-restart-btn').addEventListener('click', () => {
  localStorage.removeItem(todayKey());
  location.reload();
});

// Extract toolbar buttons
$('extract-btn').addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); captureExtract(); });
$('cloze-btn').addEventListener('click',   e => { e.preventDefault(); e.stopPropagation(); captureForCloze(); });
$('qa-btn').addEventListener('click',      e => { e.preventDefault(); e.stopPropagation(); captureForQA(); });

// Skip / dismiss
$('skip-btn').addEventListener('click',    () => skipCard());
$('dismiss-btn').addEventListener('click', () => {
  if (confirm('Dismiss this element? It will be marked Done in SuperMemo.')) dismissCard();
});

// Cloze modal
$('cloze-modal-close').addEventListener('click',  () => $('cloze-modal').classList.remove('open'));
$('cloze-cancel-btn').addEventListener('click',   () => $('cloze-modal').classList.remove('open'));
$('cloze-save-btn').addEventListener('click',     saveCloze);

// Q&A modal
$('qa-modal-close').addEventListener('click',  () => $('qa-modal').classList.remove('open'));
$('qa-cancel-btn').addEventListener('click',   () => $('qa-modal').classList.remove('open'));
$('qa-save-btn').addEventListener('click',     saveQA);

// Drawer
extractBadgeBtn.addEventListener('click', openExtractDrawer);
$('extract-drawer-close').addEventListener('click', closeExtractDrawer);
$('extract-drawer-backdrop').addEventListener('click', closeExtractDrawer);
$('extract-clear-btn').addEventListener('click', () => {
  if (confirm('Clear all pending items?')) {
    pendingExtracts = []; pendingItems = [];
    saveExtracts(); saveItems();
    renderExtractList();
  }
});
$('extract-sync-btn').addEventListener('click', async () => {
  if (isStaticMode()) { alert('Sync only available on home network.'); return; }
  await syncAllExtracts();
  renderExtractList();
  const n = pendingExtracts.filter(e=>e.synced).length + pendingItems.filter(i=>i.synced).length;
  setSyncStatus(`✓ ${n} items synced`, 'ok');
});

// ── Start ──────────────────────────────────────────────────────────────────
init();
