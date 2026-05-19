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
  if (localStorage.getItem('smgo_server')) return false; // explicit server overrides origin check
  const h = window.location.hostname;
  if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0') return false;
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(h)) return false;
  return true;
}
function getServerUrl() {
  return localStorage.getItem('smgo_server') || window.location.origin;
}

// ── Supabase cloud sync ────────────────────────────────────────────────────
function getSupabase() {
  const url = localStorage.getItem('smgo_supa_url') || '';
  const key = localStorage.getItem('smgo_supa_key') || '';
  return (url && key) ? { url: url.replace(/\/$/, ''), key } : null;
}

async function supaUpsert(table, row) {
  const supa = getSupabase();
  if (!supa) return false;
  try {
    const res = await fetch(`${supa.url}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        apikey: supa.key, Authorization: `Bearer ${supa.key}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify(row),
    });
    return res.ok;
  } catch { return false; }
}

// ── Typography (apply before first paint) ─────────────────────────────────
(function () {
  const el = document.documentElement;
  el.setAttribute('data-font',    localStorage.getItem('smgo_font')    || 'sans');
  el.setAttribute('data-size',    localStorage.getItem('smgo_size')    || 'md');
  el.setAttribute('data-spacing', localStorage.getItem('smgo_spacing') || 'normal');
  el.setAttribute('data-width',   localStorage.getItem('smgo_width')   || 'medium');
})();

// ── State ──────────────────────────────────────────────────────────────────
let cards     = [];
let idx       = 0;
let grades    = [];
let dismisses = [];
let revealed  = false;

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

  // Supabase: try cloud cards first — works from any network
  if (getSupabase() && await initFromSupabase()) return;

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

async function initFromSupabase() {
  const supa = getSupabase();
  if (!supa) return false;
  try {
    const today = localDate();
    const res = await fetch(
      `${supa.url}/rest/v1/smgo_daily?date=eq.${today}&select=data`,
      { headers: { apikey: supa.key, Authorization: `Bearer ${supa.key}` } }
    );
    if (!res.ok) return false;
    const rows = await res.json();
    if (!rows.length || !rows[0].data?.cards?.length) return false;
    cards = rows[0].data.cards;
    idx   = 0;
    serverUrlWrap.textContent = `Supabase · ${cards.length} cards`;
    loadStoredProgress();
    showScreen('review');
    renderCard();
    await syncAllPending();
    await syncAllExtracts();
    return true;
  } catch { return false; }
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
function localDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function todayKey() { return 'smgo_progress_' + localDate(); }

function loadStoredProgress() {
  try {
    const saved = JSON.parse(localStorage.getItem(todayKey()) || '{}');
    grades    = saved.grades    || [];
    dismisses = saved.dismisses || [];
    const done = new Set([
      ...grades.map(g => g.elementId),
      ...dismisses.map(d => d.elementId),
    ]);
    const next = cards.findIndex(c => !done.has(c.id));
    idx = next === -1 ? cards.length : next;
  } catch { grades = []; dismisses = []; }
}
function saveProgress() {
  const prev = JSON.parse(localStorage.getItem(todayKey()) || '{}');
  localStorage.setItem(todayKey(), JSON.stringify({ ...prev, grades, dismisses, ts: Date.now() }));
}

// ── Screen management ──────────────────────────────────────────────────────
function showScreen(name, msg = '', sub = '') {
  screenLoading.style.display = 'none';
  screenDone.style.display    = 'none';
  screenError.style.display   = 'none';
  cardArea.style.display      = 'none';
  $('screen-library').style.display = 'none';
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
  else if (name === 'library') {
    $('screen-library').style.display = 'flex';
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

  const typeLabel  = { topic: 'Topic', 'pdf-extract': 'PDF Extract', cloze: 'Cloze', image: 'Image' };
  const badgeClass = 'badge-' + (c.type || 'topic');

  let bodyHtml = '';
  if (c.type === 'cloze' && c.clozeSentence) {
    let n = 0;
    const blanked = c.clozeSentence.replace(/\[___\]/g,
      () => `<span class="cloze-blank" data-bi="${n++}">[___]</span>`);
    bodyHtml = `<div class="cloze-sentence">${blanked}</div>`;
    if (c.body) bodyHtml += `<div class="card-body selectable">${formatBody(c.body)}</div>`;
  } else if (c.type === 'image') {
    if (!isStaticMode()) {
      bodyHtml = `<div class="card-body"><img src="${getServerUrl()}/api/images/${c.id}" class="card-image" alt="Element ${c.id}" loading="lazy"></div>`;
    } else {
      bodyHtml = `<div class="card-body" style="color:var(--muted)">Image – only available on home network.</div>`;
    }
  } else if (c.body) {
    bodyHtml = `<div class="card-body selectable">${formatBody(c.body)}</div>`;
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

  const isDismissable = c.type === 'topic' || c.type === 'pdf-extract' || c.type === 'image';
  $('dismiss-btn').style.display  = isDismissable ? 'inline-flex' : 'none';
  $('edit-btn').style.display     = (getSupabase() || !isStaticMode()) ? 'inline-flex' : 'none';
  $('pdf-open-btn').style.display = c.type === 'pdf-extract' ? 'inline-flex' : 'none';

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
  const rec = { elementId: card.id, timestamp: new Date().toISOString() };
  dismisses.push(rec);
  saveProgress();
  showFlash('Dismissed');
  // Route via Supabase first (works anywhere), fallback to local server
  const supa = getSupabase();
  if (supa) {
    supaUpsert('smgo_queue', {
      id:      `dismiss-${card.id}-${rec.timestamp}`,
      type:    'dismiss',
      payload: rec,
    }).catch(() => {});
  } else if (!isStaticMode()) {
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

// ── Text normalization ─────────────────────────────────────────────────────
// SM stores each PDF visual line as a separate paragraph block separated by
// \r\n\n. This heuristic rejoins soft-wrapped lines into proper paragraphs.
function normalizeBody(text) {
  if (!text) return [];
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = text.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
  if (!blocks.length) return [];
  let current = blocks[0];
  const paragraphs = [];
  for (let i = 1; i < blocks.length; i++) {
    const next = blocks[i];
    // Hyphenated word split across lines
    if (current.slice(-1) === '-' || current.slice(-1) === '‐') {
      current = current.slice(0, -1) + next;
      continue;
    }
    // Soft wrap: no sentence-ending punct and next starts with lowercase/digit/paren
    const softWrap = !/[.!?:;"'’”]$/.test(current) && /^[a-z0-9(]/.test(next);
    if (softWrap) {
      current = current + ' ' + next;
    } else {
      paragraphs.push(current);
      current = next;
    }
  }
  paragraphs.push(current);
  return paragraphs;
}

function formatBody(text) {
  if (!text) return '';
  return normalizeBody(text).map(para => {
    const lines = para.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) return '';
    return `<p>${lines.map(esc).join('<br>')}</p>`;
  }).filter(Boolean).join('');
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
  // If no Supabase and no local server, grades are local-only
  if (isStaticMode() && !getSupabase()) {
    showScreen('done', `${grades.length} items reviewed.`, 'Configure Supabase in ⚙ to sync grades from anywhere.');
    setSyncStatus('Grades saved locally – configure Supabase to sync', 'fail');
    return;
  }
  showScreen('done', `${grades.length} items reviewed.`, 'Syncing…');
  const ok = await pushTodayGrades();
  if (ok) {
    $('done-msg').textContent = `${grades.length} grades synced.`;
    $('done-sub').textContent = 'SM plugin will apply them automatically on next poll.';
    setSyncStatus(`✓ ${grades.length} grades synced`, 'ok');
  } else {
    $('done-sub').textContent = 'Offline – grades saved locally, will retry next session.';
    setSyncStatus('Offline – will sync when connected', 'fail');
  }
}

async function pushTodayGrades() {
  if (grades.length === 0) return true;

  // Try Supabase first (works anywhere)
  const supa = getSupabase();
  if (supa) {
    let allOk = true;
    for (const g of grades) {
      const ok = await supaUpsert('smgo_queue', {
        id:      `grade-${g.elementId}-${g.timestamp}`,
        type:    'grade',
        payload: g,
      });
      if (!ok) allOk = false;
    }
    if (allOk) {
      const prev = JSON.parse(localStorage.getItem(todayKey()) || '{}');
      localStorage.setItem(todayKey(), JSON.stringify({ ...prev, synced: true }));
      return true;
    }
  }

  // Fallback: local server
  if (!isStaticMode()) {
    try {
      const res = await fetch(`${getServerUrl()}/api/grades`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: localDate(), reviews: grades }),
      });
      if (res.ok) {
        const prev = JSON.parse(localStorage.getItem(todayKey()) || '{}');
        localStorage.setItem(todayKey(), JSON.stringify({ ...prev, synced: true }));
      }
      return res.ok;
    } catch { return false; }
  }

  return false;
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

    // Try Supabase first (works anywhere)
    const supa = getSupabase();
    if (supa) {
      let allOk = true;
      for (const g of saved.grades) {
        const ok = await supaUpsert('smgo_queue', {
          id:      `grade-${g.elementId}-${g.timestamp}`,
          type:    'grade',
          payload: g,
        });
        if (!ok) allOk = false;
      }
      if (allOk) {
        localStorage.setItem(k, JSON.stringify({ ...saved, synced: true }));
        total += saved.grades.length;
        continue;
      }
    }

    // Fallback: local server
    if (!isStaticMode()) {
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
  }
  if (total > 0) setSyncStatus(`✓ Synced ${total} pending grades`, 'ok');
}

async function trySyncPending() { await syncAllPending(); }
function setSyncStatus(msg, cls) {
  syncStatus.textContent = msg;
  syncStatus.className   = cls ? `sync-${cls}` : '';
}

// ── Extract + Items UI ─────────────────────────────────────────────────────
let pendingExtracts = [];
let pendingItems    = [];  // cloze + Q&A
let pendingEdits    = [];  // text/image notes

function loadExtracts() {
  try { pendingExtracts = JSON.parse(localStorage.getItem('smgo_extracts') || '[]'); }
  catch { pendingExtracts = []; }
  try { pendingItems    = JSON.parse(localStorage.getItem('smgo_items')    || '[]'); }
  catch { pendingItems  = []; }
  try { pendingEdits    = JSON.parse(localStorage.getItem('smgo_edits')    || '[]'); }
  catch { pendingEdits  = []; }
  updateExtractBadge();
  const ls = localStorage.getItem('smgo_last_sync');
  if (ls) {
    const d = new Date(ls);
    const isToday = d.toDateString() === new Date().toDateString();
    const label = isToday
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' '
          + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    setSyncStatus(`Last sync: ${label}`, '');
  }
}
function saveExtracts() {
  localStorage.setItem('smgo_extracts', JSON.stringify(pendingExtracts));
  updateExtractBadge();
}
function saveItems() {
  localStorage.setItem('smgo_items', JSON.stringify(pendingItems));
  updateExtractBadge();
}
function saveEdits() {
  localStorage.setItem('smgo_edits', JSON.stringify(pendingEdits));
  updateExtractBadge();
}
function updateExtractBadge() {
  const n = pendingExtracts.filter(e => !e.synced).length
          + pendingItems.filter(i => !i.synced).length
          + pendingEdits.filter(e => !e.synced).length;
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

  showSelectionBar();
}

function showSelectionBar() {
  $('selection-bar').style.display = 'flex';
}
function hideExtractToolbar() {
  $('selection-bar').style.display = 'none';
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

  // Highlight the extracted range. surroundContents() fails when the selection
  // crosses element boundaries, so we use extractContents() + insertNode() instead.
  try {
    const range = sel.getRangeAt(0);
    const mark  = document.createElement('mark');
    mark.className = 'extracted-mark';
    mark.appendChild(range.extractContents());
    range.insertNode(mark);
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

// Models tried in order; first success is cached in localStorage for next time
const GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-001',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
];

function extractGeminiJson(raw) {
  // Strategy 1: direct parse (works when responseMimeType:application/json is honoured)
  try { const r = JSON.parse(raw.trim()); if (r && r.question) return r; } catch {}
  // Strategy 2: strip ``` fences (Gemini 2.5 sometimes ignores responseMimeType)
  const fenced = raw.replace(/^```(?:json)?[\r\n]*/im, '').replace(/[\r\n]*```\s*$/m, '').trim();
  try { const r = JSON.parse(fenced); if (r && r.question) return r; } catch {}
  // Strategy 3: extract first {...} block (handles preamble / postamble text)
  const m = raw.match(/\{[\s\S]*?\}/);
  if (m) { try { const r = JSON.parse(m[0]); if (r && r.question) return r; } catch {} }
  // Strategy 4: extract largest {...} block (greedy, catches nested braces)
  const m2 = raw.match(/\{[\s\S]*\}/);
  if (m2) { try { const r = JSON.parse(m2[0]); if (r && r.question) return r; } catch {} }
  return null;
}

async function callGemini(text, apiKey) {
  const prompt = `Convert this text into ONE concise SuperMemo Q&A flashcard for spaced repetition. Return valid JSON with exactly two string fields "question" and "answer", nothing else.\n\nText: ${text}`;
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.3, maxOutputTokens: 300 },
  });

  // Put cached working model first — but discard the cache if it's no longer in our list
  const rawCached = localStorage.getItem('smgo_gemini_model');
  const cached = rawCached && GEMINI_MODELS.includes(rawCached) ? rawCached : null;
  if (rawCached && !cached) localStorage.removeItem('smgo_gemini_model');
  const models = cached
    ? [cached, ...GEMINI_MODELS.filter(m => m !== cached)]
    : GEMINI_MODELS;

  let lastErr = 'No compatible Gemini model found for this API key.';

  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    let res;
    try { res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }); }
    catch (e) { lastErr = e.message; continue; }

    // Model unavailable — try next
    if (res.status === 404 || res.status === 400) {
      try { const e = await res.json(); lastErr = e?.error?.message || lastErr; } catch {}
      continue;
    }
    // Rate-limited — wait once then retry same model
    if (res.status === 429) {
      await new Promise(r => setTimeout(r, 5000));
      try { res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }); }
      catch (e) { lastErr = e.message; continue; }
      if (!res.ok) { lastErr = 'Rate limit reached — wait a minute and try again.'; continue; }
    }
    if (!res.ok) {
      try { const e = await res.json(); lastErr = e?.error?.message || `HTTP ${res.status}`; } catch {}
      continue;
    }

    const data = await res.json();
    if (!data.candidates?.length || !data.candidates[0].content?.parts?.length) {
      lastErr = data.promptFeedback?.blockReason
        ? `Blocked by safety filter: ${data.promptFeedback.blockReason}`
        : 'Gemini returned no candidates.';
      continue;
    }
    const raw = data.candidates[0].content.parts[0].text || '';
    const result = extractGeminiJson(raw);
    if (!result) { lastErr = `Could not parse JSON from: ${raw.slice(0, 160)}`; continue; }
    localStorage.setItem('smgo_gemini_model', model);
    return result;
  }

  throw new Error(lastErr);
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
  const qType = extract.type || 'extract'; // 'extract' or 'pdf-extract-create'
  // Try Supabase first (works from anywhere)
  if (await supaUpsert('smgo_queue', { id: extract.id, type: qType, payload: extract })) {
    extract.synced = true; saveExtracts(); return;
  }
  // Fallback: local server (same-network only)
  if (!isStaticMode()) {
    try {
      const res = await fetch(`${getServerUrl()}/api/extracts`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(extract),
      });
      if (res.ok) { extract.synced = true; saveExtracts(); }
    } catch {}
  }
}

async function uploadItem(item) {
  // Try Supabase first
  if (await supaUpsert('smgo_queue', { id: item.id, type: item.type, payload: item })) {
    item.synced = true; saveItems(); return;
  }
  // Fallback: local server
  if (!isStaticMode()) {
    try {
      const res = await fetch(`${getServerUrl()}/api/items`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item),
      });
      if (res.ok) { item.synced = true; saveItems(); }
    } catch {}
  }
}

async function uploadEdit(edit) {
  const supa = getSupabase();
  if (!supa) return;
  const ok = await supaUpsert('smgo_queue', { id: edit.id, type: 'edit', payload: edit });
  if (ok) { edit.synced = true; saveEdits(); }
}

async function syncAllExtracts() {
  for (const e of pendingExtracts.filter(x => !x.synced)) await uploadExtract(e);
  for (const i of pendingItems.filter(x => !x.synced))    await uploadItem(i);
  for (const e of pendingEdits.filter(x => !x.synced))    await uploadEdit(e);
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
  updateDrawerSyncTime();
  extractDrawer.classList.add('open');
  $('extract-drawer-backdrop').classList.add('open');
}

function updateDrawerSyncTime() {
  const ls = localStorage.getItem('smgo_last_sync');
  const el = $('extract-last-sync');
  if (!el) return;
  if (ls) {
    const d = new Date(ls);
    const isToday = d.toDateString() === new Date().toDateString();
    const label = isToday
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' '
          + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    el.textContent = `Last sync: ${label}`;
  } else {
    el.textContent = 'Not yet synced';
  }
}
function closeExtractDrawer() {
  extractDrawer.classList.remove('open');
  $('extract-drawer-backdrop').classList.remove('open');
}

function renderExtractList() {
  const all = [
    ...pendingExtracts.map(e => ({ ...e, _kind: e.type || 'extract' })),
    ...pendingItems.map(i => ({ ...i, _kind: i.type })),
  ].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  if (all.length === 0) {
    extractList.innerHTML = '<p style="color:var(--muted);text-align:center;padding:24px;font-size:.85rem">No pending items</p>';
    return;
  }

  const kindLabel = { extract: '✂ Extract', 'pdf-extract-create': '📄 PDF Extract', cloze: '[ ] Cloze', qa: '🤖 Q&A' };
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
    'Settings\n\n1) Server URL (local network)\n2) Gemini API key\n3) Supabase URL\n4) Supabase anon key\n5) PDF folder (for PDF viewer)\n6) PDF parent element ID (for library extracts)\n\nEnter number:',
  );
  if (choice === '1') {
    const url = prompt('SMGo server URL (e.g. http://192.168.1.x:3001)', getServerUrl());
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
  } else if (choice === '3') {
    const url = prompt('Supabase project URL\n(e.g. https://abcxyz.supabase.co)', localStorage.getItem('smgo_supa_url') || '');
    if (url !== null) {
      if (url.trim()) localStorage.setItem('smgo_supa_url', url.trim());
      else localStorage.removeItem('smgo_supa_url');
    }
  } else if (choice === '4') {
    const key = prompt('Supabase anon key (from Project Settings → API):', localStorage.getItem('smgo_supa_key') || '');
    if (key !== null) {
      if (key.trim()) localStorage.setItem('smgo_supa_key', key.trim());
      else localStorage.removeItem('smgo_supa_key');
    }
  } else if (choice === '5') {
    pickPdfFolder();
  } else if (choice === '6') {
    const current = localStorage.getItem('smgo_pdf_parent_id') || '';
    const id = prompt('Parent element ID in SM for standalone PDF extracts\n(leave blank to clear):', current);
    if (id !== null) {
      if (id.trim() && /^\d+$/.test(id.trim())) localStorage.setItem('smgo_pdf_parent_id', id.trim());
      else if (!id.trim()) localStorage.removeItem('smgo_pdf_parent_id');
      else alert('Must be a numeric element ID.');
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
  if (!getSupabase() && isStaticMode()) {
    alert('No sync route available.\n\nOptions:\n• Set server URL in ⚙ (same WiFi)\n• Configure Supabase in ⚙ (anywhere)');
    return;
  }
  const btn = $('extract-sync-btn');
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  await syncAllExtracts();
  btn.disabled = false;
  btn.textContent = 'Sync to server';
  renderExtractList();
  updateExtractBadge();

  const synced = pendingExtracts.filter(e => e.synced).length
               + pendingItems.filter(i => i.synced).length;
  const total  = pendingExtracts.length + pendingItems.length;
  const now    = new Date();
  const time   = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  localStorage.setItem('smgo_last_sync', now.toISOString());
  updateDrawerSyncTime();
  showFlash(`✓ ${synced} of ${total} synced`);
  setSyncStatus(`✓ Last sync: ${time}`, 'ok');
});

// ── Edit / Add Note modal ─────────────────────────────────────────────────
let editImageData = null;

function openEditModal() {
  if (!cards[idx]) return;
  $('edit-note-text').value = '';
  editImageData = null;
  $('edit-image-preview').style.display = 'none';
  $('edit-image-clear').style.display = 'none';
  $('edit-image-hint').style.display = '';
  $('edit-modal').classList.add('open');
  setTimeout(() => $('edit-note-text').focus(), 150);
}

async function saveEdit() {
  const card = cards[idx];
  if (!card) return;
  const text = $('edit-note-text').value.trim();
  if (!text && !editImageData) { showFlash('Add text or paste an image first.'); return; }

  const rec = {
    id:          `edit-${card.id}-${Date.now()}-${Math.random().toString(36).slice(2,5)}`,
    elementId:   card.id,
    parentTitle: card.title,
    text,
    imageData:   editImageData || null,
    timestamp:   new Date().toISOString(),
    synced:      false,
  };

  // Always persist locally first so the note is never lost
  pendingEdits.push(rec);
  saveEdits();

  $('edit-modal').classList.remove('open');

  // Attempt immediate Supabase upload
  const supa = getSupabase();
  if (supa) {
    const ok = await supaUpsert('smgo_queue', { id: rec.id, type: 'edit', payload: rec });
    if (ok) { rec.synced = true; saveEdits(); showFlash('✓ Note synced to SM'); return; }
  }
  showFlash('✓ Note saved — will sync later');
}

// Paste handler at document level so it works on mobile (Android/iOS
// fire paste on document, not on the focused custom element)
document.addEventListener('paste', e => {
  if (!$('edit-modal')?.classList.contains('open')) return;
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const blob = item.getAsFile();
      if (!blob) continue;
      const reader = new FileReader();
      reader.onload = ev => {
        editImageData = ev.target.result;
        const img = $('edit-image-preview');
        img.src = editImageData;
        img.style.display = 'block';
        $('edit-image-clear').style.display = 'inline-block';
        $('edit-image-hint').style.display = 'none';
      };
      reader.readAsDataURL(blob);
      break;
    }
  }
});

$('edit-btn').addEventListener('click', openEditModal);
$('edit-modal-close').addEventListener('click',  () => $('edit-modal').classList.remove('open'));
$('edit-cancel-btn').addEventListener('click',   () => $('edit-modal').classList.remove('open'));
$('edit-save-btn').addEventListener('click',     saveEdit);
$('edit-image-clear').addEventListener('click', () => {
  editImageData = null;
  $('edit-image-preview').src = '';
  $('edit-image-preview').style.display = 'none';
  $('edit-image-clear').style.display = 'none';
  $('edit-image-hint').style.display = '';
});

// ── PDF folder (File System Access API + IndexedDB) ────────────────────────
let _pdfDB = null;

function openPdfDB() {
  if (_pdfDB) return Promise.resolve(_pdfDB);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('smgo', 2);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (e.oldVersion < 1) db.createObjectStore('handles');
      if (e.oldVersion < 2) db.createObjectStore('highlights');
    };
    req.onsuccess = e => { _pdfDB = e.target.result; resolve(_pdfDB); };
    req.onerror   = () => reject(req.error);
  });
}

async function loadPdfHighlights(filename) {
  if (!filename) return [];
  try {
    const db = await openPdfDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction('highlights','readonly').objectStore('highlights').get(filename);
      req.onsuccess = () => resolve(req.result?.highlights || []);
      req.onerror   = () => reject(req.error);
    });
  } catch { return []; }
}

async function savePdfHighlights(filename, highlights) {
  if (!filename) return;
  try {
    const db = await openPdfDB();
    await new Promise((resolve, reject) => {
      const req = db.transaction('highlights','readwrite').objectStore('highlights')
        .put({ filename, highlights }, filename);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
    localStorage.setItem(`smgo_pdf_hlcount_${filename}`, String(highlights.length));
  } catch {}
}

// ── Rect computation (ported from react-pdf-highlighter, MIT) ──────────────
function getSelectionRects() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return [];
  const range = sel.getRangeAt(0);
  const wrap  = $('pdf-canvas-wrap');
  if (!wrap) return [];
  const wr = wrap.getBoundingClientRect();
  if (!wr.width || !wr.height) return [];
  const raw = [];
  for (const r of range.getClientRects()) {
    if (r.width < 1 || r.height < 1) continue;
    if (r.right <= wr.left || r.left >= wr.right) continue;
    if (r.bottom <= wr.top  || r.top  >= wr.bottom) continue;
    raw.push({
      l: ((r.left - wr.left) / wr.width)  * 100,
      t: ((r.top  - wr.top)  / wr.height) * 100,
      w: (r.width  / wr.width)  * 100,
      h: (r.height / wr.height) * 100,
    });
  }
  return _mergeRects(raw);
}

function _mergeRects(rects) {
  if (!rects.length) return rects;
  rects.sort((a, b) => a.t - b.t || a.l - b.l);
  const out = [];
  for (const r of rects) {
    const prev = out[out.length - 1];
    // Use 30% of line height as tolerance — handles sub-pixel jitter on the same
    // line without falsely merging adjacent lines (which are a full line height apart)
    const tol = r.h * 0.3;
    if (prev && Math.abs(r.t - prev.t) < tol && Math.abs(r.h - prev.h) < tol) {
      const newL = Math.min(r.l, prev.l);
      prev.w = Math.max(r.l + r.w, prev.l + prev.w) - newL;
      prev.l = newL;
      prev.h = Math.max(prev.h, r.h);
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

function renderHighlightLayer(pageNum) {
  const layer = $('pdf-highlight-layer');
  if (!layer) return;
  layer.innerHTML = '';
  for (const hl of _pdfHighlights) {
    if (hl.page !== pageNum) continue;
    for (const r of hl.rects) {
      const div = document.createElement('div');
      div.className = `pdf-hl pdf-hl-${hl.type}`;
      div.style.left   = r.l + '%';
      div.style.top    = r.t + '%';
      div.style.width  = r.w + '%';
      div.style.height = r.h + '%';
      layer.appendChild(div);
    }
  }
}

async function addAndRenderHighlight(filename, page, rects, text, type) {
  if (!rects.length || !filename) return;
  const hl = {
    id:   `hl-${Date.now()}-${Math.random().toString(36).slice(2,5)}`,
    page, rects, text, type, ts: Date.now(),
  };
  _pdfHighlights.push(hl);
  renderHighlightLayer(page);
  savePdfHighlights(filename, _pdfHighlights); // fire and forget
}

function getPdfParentId(filename) {
  const per = parseInt(localStorage.getItem(`smgo_pdf_parent_${filename}`) || '0', 10);
  if (per) return per;
  return parseInt(localStorage.getItem('smgo_pdf_parent_id') || '0', 10);
}

async function getPdfDirHandle() {
  try {
    const db = await openPdfDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction('handles','readonly').objectStore('handles').get('pdfDir');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror   = () => reject(req.error);
    });
  } catch { return null; }
}

async function setPdfDirHandle(handle) {
  try {
    const db = await openPdfDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction('handles','readwrite').objectStore('handles').put(handle, 'pdfDir');
      req.onsuccess = () => resolve(true);
      req.onerror   = () => reject(req.error);
    });
  } catch { return false; }
}

async function pickPdfFolder() {
  if (!window.showDirectoryPicker) {
    alert('Your browser does not support folder access.\nUse Chrome or Edge on Android/macOS.');
    return null;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: 'read' });
    await setPdfDirHandle(handle);
    showFlash('PDF folder saved');
    return handle;
  } catch (e) {
    if (e.name !== 'AbortError') showFlash('Could not select folder');
    return null;
  }
}

async function getPdfFile(filename) {
  if (!filename) return null;
  let dirHandle = await getPdfDirHandle();
  if (!dirHandle) return null;
  try {
    const perm = await dirHandle.queryPermission({ mode: 'read' });
    if (perm !== 'granted') {
      const granted = await dirHandle.requestPermission({ mode: 'read' });
      if (granted !== 'granted') return null;
    }
    const fileHandle = await dirHandle.getFileHandle(filename);
    return await fileHandle.getFile();
  } catch { return null; }
}

// ── PDF viewer ──────────────────────────────────────────────────────────────
let pdfjsLib              = null;
let pdfViewerDoc          = null;
let pdfViewerPage         = 1;
let pdfViewerCard         = null;
let pdfViewerBlobUrl      = null;
let _activeRenderTask     = null;
let _pdfJsPromise         = null;
let _pdfHighlights        = [];
let _pdfHighlightsFilename = null;
let _pdfHeaderTimer       = null;
let _imgCropMode          = false;
let _imgCropStart         = null;
let _pdfStagedSegments    = [];
let _pendingCropData      = null;

async function loadPdfJs() {
  if (pdfjsLib) return pdfjsLib;
  if (window.pdfjsLib) { pdfjsLib = window.pdfjsLib; return pdfjsLib; }
  if (_pdfJsPromise) return _pdfJsPromise;
  _pdfJsPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
    s.onload = () => {
      pdfjsLib = window.pdfjsLib;
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
      resolve(pdfjsLib);
    };
    s.onerror = e => { _pdfJsPromise = null; reject(e); };
    document.head.appendChild(s);
  });
  return _pdfJsPromise;
}

function showPdfHeader() {
  const hdr = $('pdf-modal-header');
  hdr.classList.remove('hidden');
  clearTimeout(_pdfHeaderTimer);
  _pdfHeaderTimer = setTimeout(() => hdr.classList.add('hidden'), 3000);
}

async function openPdfViewer(card) {
  pdfViewerCard = card;
  $('pdf-modal').classList.add('open');
  $('pdf-title-label').textContent = card.pdfFilename || card.title || '';
  $('pdf-canvas-wrap').style.display = 'none';
  $('pdf-loading-msg').style.display = 'block';
  $('pdf-error-msg').style.display   = 'none';
  $('pdf-no-folder-msg').style.display = 'none';
  updatePdfActionButtons(false);

  // Load saved highlights for this PDF
  const hlKey = card.pdfFilename || `card-${card.id}`;
  _pdfHighlights        = await loadPdfHighlights(hlKey);
  _pdfHighlightsFilename = hlKey;

  // Start auto-hide header countdown
  showPdfHeader();

  // pdfSource is either a URL string (blob: or http:) passed to PDF.js
  let pdfSource = null;
  let _blobUrl  = null; // track for revocation on close

  // 1. Try local folder first — use blob URL so PDF.js can range-request internally
  if (card.pdfFilename) {
    const file = await getPdfFile(card.pdfFilename);
    if (file) {
      _blobUrl  = URL.createObjectURL(file);
      pdfSource = _blobUrl;
    }
  }

  // 2. LAN fallback: plugin serves the PDF
  if (!pdfSource && !isStaticMode()) {
    pdfSource = `${getServerUrl()}/api/pdf/${card.id}`;
  }

  if (!pdfSource) {
    $('pdf-loading-msg').style.display = 'none';
    const hasFSAPI = !!window.showDirectoryPicker;
    if (hasFSAPI) {
      $('pdf-no-folder-msg').style.display = 'flex';
    } else {
      $('pdf-error-msg').textContent = 'PDF not available. Connect to home Wi-Fi or use Chrome to select a PDF folder.';
      $('pdf-error-msg').style.display = 'block';
    }
    return;
  }

  try {
    const lib = await loadPdfJs();
    pdfViewerDoc    = await lib.getDocument(pdfSource).promise;
    pdfViewerBlobUrl = _blobUrl; // remember for cleanup on close
    // pdfPage is 0-indexed; PDF.js getPage() is 1-indexed
    pdfViewerPage = card.pdfPage != null ? card.pdfPage + 1 : 1;
    pdfViewerPage = Math.max(1, Math.min(pdfViewerPage, pdfViewerDoc.numPages));
    $('pdf-loading-msg').style.display = 'none';
    await renderPdfPage(pdfViewerPage);
  } catch (e) {
    if (_blobUrl) URL.revokeObjectURL(_blobUrl);
    $('pdf-loading-msg').style.display = 'none';
    const msg = e?.message || String(e);
    $('pdf-error-msg').textContent = msg.includes('fetch') || msg.includes('Load')
      ? 'Could not load PDF viewer — internet required for first use.'
      : `Could not render PDF: ${msg}`;
    $('pdf-error-msg').style.display = 'block';
  }
}

async function renderPdfPage(pageNum) {
  if (!pdfViewerDoc) return;

  // Cancel any in-progress render so rapid prev/next clicks don't overlap on the canvas
  if (_activeRenderTask) {
    try { _activeRenderTask.cancel(); } catch {}
    _activeRenderTask = null;
  }

  const page     = await pdfViewerDoc.getPage(pageNum);
  const canvas   = $('pdf-canvas');
  const textDiv  = $('pdf-text-layer');

  const vpWidth  = $('pdf-viewport').clientWidth || window.innerWidth;
  const vp1      = page.getViewport({ scale: 1 });
  const scale    = Math.max(0.5, Math.min(vpWidth / vp1.width, 3));
  const viewport = page.getViewport({ scale });

  canvas.width  = viewport.width;
  canvas.height = viewport.height;
  canvas.style.width  = '';
  canvas.style.height = '';
  textDiv.style.width  = viewport.width  + 'px';
  textDiv.style.height = viewport.height + 'px';

  const renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport });
  _activeRenderTask = renderTask;
  try {
    await renderTask.promise;
  } catch (e) {
    if (e?.name === 'RenderingCancelledException') return;
    throw e;
  }
  _activeRenderTask = null;

  // Text layer for selection
  textDiv.innerHTML = '';
  const textContent = await page.getTextContent();
  const textTask = pdfjsLib.renderTextLayer({
    textContentSource: textContent,
    container:         textDiv,
    viewport,
    textDivs:          [],
  });
  try {
    await textTask.promise;
  } catch (e) {
    if (e?.name !== 'RenderingCancelledException') throw e;
  }

  pdfViewerPage = pageNum;
  $('pdf-page-info').textContent = `${pageNum} / ${pdfViewerDoc.numPages}`;
  $('pdf-prev-btn').disabled     = pageNum <= 1;
  $('pdf-next-btn').disabled     = pageNum >= pdfViewerDoc.numPages;
  $('pdf-canvas-wrap').style.display = '';

  if (pdfViewerCard?._fromLibrary && pdfViewerCard.pdfFilename)
    localStorage.setItem(`smgo_pdf_pos_${pdfViewerCard.pdfFilename}`, String(pageNum));

  renderHighlightLayer(pageNum);
  updatePdfActionButtons(false);
  window.getSelection()?.removeAllRanges();
}

function closePdfViewer() {
  $('pdf-modal').classList.remove('open');
  if (_activeRenderTask) { try { _activeRenderTask.cancel(); } catch {} _activeRenderTask = null; }
  if (pdfViewerDoc) { pdfViewerDoc.destroy(); pdfViewerDoc = null; }
  if (pdfViewerBlobUrl) { URL.revokeObjectURL(pdfViewerBlobUrl); pdfViewerBlobUrl = null; }
  clearTimeout(_pdfHeaderTimer);
  if (_imgCropMode) { _imgCropMode = false; $('pdf-img-crop-overlay').classList.remove('active'); }
  _pdfHighlights = []; _pdfHighlightsFilename = null;
  _imgCropStart  = null;
  pdfViewerCard  = null;
  _pdfStagedSegments = [];
  _pendingCropData   = null;
  $('pdf-crop-choice-bar').style.display = 'none';
  updateStagedBar();
  window.getSelection()?.removeAllRanges();
  updatePdfActionButtons(false);
}

function updatePdfActionButtons(hasSelection) {
  $('pdf-extract-btn').disabled = !hasSelection;
  $('pdf-cloze-btn').disabled   = !hasSelection;
  $('pdf-qa-btn').disabled      = !hasSelection;
  $('pdf-stage-btn').disabled   = !hasSelection;
  ['pdf-extract-btn','pdf-cloze-btn','pdf-qa-btn','pdf-stage-btn'].forEach(id =>
    $(id).classList.toggle('sel-active', hasSelection)
  );
}

// Watch for text selection inside the PDF text layer
document.addEventListener('selectionchange', () => {
  if (!$('pdf-modal')?.classList.contains('open')) return;
  if (_imgCropMode) return;
  const sel  = window.getSelection();
  const text = sel?.toString().trim() ?? '';
  if (text.length < 2) { updatePdfActionButtons(false); return; }
  if (!sel.rangeCount)  { updatePdfActionButtons(false); return; }
  const inTextLayer = n => {
    const el = n instanceof Element ? n : n.parentElement;
    return !!el?.closest('.textLayer');
  };
  const range = sel.getRangeAt(0);
  const active = inTextLayer(range.startContainer) || inTextLayer(range.commonAncestorContainer);
  updatePdfActionButtons(active);
});

async function extractFromPdf() {
  const sel  = window.getSelection();
  const text = sel?.toString().trim() ?? '';
  if (!text || !pdfViewerCard) return;

  const filename = _pdfHighlightsFilename;
  const parentId = getPdfParentId(filename) || pdfViewerCard.pdfElementId || 0;
  if (!parentId) {
    showFlash('Set SM parent in library (SM button) or ⚙ Settings → 6');
    return;
  }

  const rects = getSelectionRects();
  if (rects.length) addAndRenderHighlight(filename, pdfViewerPage, rects, text, 'extract');

  const rec = {
    id:          `pdfex-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    type:        'pdf-extract-create',
    parentId,
    parentTitle: filename || pdfViewerCard.title,
    text,
    pdfPage:     pdfViewerPage - 1,
    timestamp:   new Date().toISOString(),
    synced:      false,
  };
  pendingExtracts.push(rec);
  saveExtracts();
  sel.removeAllRanges();
  updatePdfActionButtons(false);
  showFlash(`✂ "${text.slice(0,40)}${text.length>40?'…':''}"`);
  uploadExtract(rec);
}

function pdfCaptureForCloze() {
  const sel  = window.getSelection();
  const text = sel?.toString().trim() ?? '';
  if (!text || !pdfViewerCard) return;

  const filename = _pdfHighlightsFilename;
  const parentId = getPdfParentId(filename) || pdfViewerCard.pdfElementId || 0;
  if (!parentId) { showFlash('Set SM parent in library first'); return; }

  const rects = getSelectionRects();
  if (rects.length) addAndRenderHighlight(filename, pdfViewerPage, rects, text, 'cloze');

  clozeParentId    = parentId;
  clozeParentTitle = filename || pdfViewerCard.title;
  clozeWords       = text.split(/(\s+)/).map(t => ({ word: t, blank: false, isSpace: /^\s+$/.test(t) }));
  sel.removeAllRanges();
  updatePdfActionButtons(false);
  renderClozeEditor();
  $('cloze-modal').classList.add('open');
}

async function pdfCaptureForQA() {
  const sel  = window.getSelection();
  const text = sel?.toString().trim() ?? '';
  if (!text || !pdfViewerCard) return;

  const filename = _pdfHighlightsFilename;
  const parentId = getPdfParentId(filename) || pdfViewerCard.pdfElementId || 0;
  if (!parentId) { showFlash('Set SM parent in library first'); return; }

  let apiKey = localStorage.getItem('smgo_gemini_key') || '';
  if (!apiKey) {
    apiKey = prompt('Enter your Gemini API key:') || '';
    if (!apiKey) return;
    localStorage.setItem('smgo_gemini_key', apiKey.trim());
    apiKey = apiKey.trim();
  }

  const rects = getSelectionRects();
  if (rects.length) addAndRenderHighlight(filename, pdfViewerPage, rects, text, 'qa');

  qaParentId    = parentId;
  qaParentTitle = filename || pdfViewerCard.title;
  sel.removeAllRanges();
  updatePdfActionButtons(false);

  $('qa-loading').style.display = 'block';
  $('qa-form').style.display    = 'none';
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

function markPageAsRead() {
  const filename = _pdfHighlightsFilename;
  if (!filename) return;
  // Full-page read marker — remove old read marker for this page first
  _pdfHighlights = _pdfHighlights.filter(h => !(h.page === pdfViewerPage && h.type === 'read'));
  addAndRenderHighlight(filename, pdfViewerPage, [{l:0,t:0,w:100,h:100}], '', 'read');
  showFlash('◉ Page marked as read');
}

function stageSelection() {
  const sel  = window.getSelection();
  const text = sel?.toString().trim() ?? '';
  if (!text || !pdfViewerCard) return;
  const rects = getSelectionRects();
  if (rects.length) addAndRenderHighlight(_pdfHighlightsFilename, pdfViewerPage, rects, text, 'staged');
  _pdfStagedSegments.push({ kind: 'text', text, rects, page: pdfViewerPage });
  sel.removeAllRanges();
  updatePdfActionButtons(false);
  updateStagedBar();
  showFlash(`+ Staged "${text.slice(0,30)}${text.length>30?'…':''}"`);
}

function updateStagedBar() {
  const bar = $('pdf-staged-bar');
  if (!bar) return;
  if (!_pdfStagedSegments.length) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  const textCount = _pdfStagedSegments.filter(s => s.kind === 'text').length;
  const imgCount  = _pdfStagedSegments.filter(s => s.kind === 'image').length;
  const parts = [];
  if (textCount) parts.push(`${textCount} text`);
  if (imgCount)  parts.push(`${imgCount} img`);
  $('pdf-staged-count').textContent = parts.join(' + ') + ' staged';
}

function clearStaged() {
  _pdfStagedSegments = [];
  _pdfHighlights = _pdfHighlights.filter(h => h.type !== 'staged');
  renderHighlightLayer(pdfViewerPage);
  updateStagedBar();
}

async function extractAllStaged() {
  if (!_pdfStagedSegments.length || !pdfViewerCard) return;
  const filename = _pdfHighlightsFilename;
  const parentId = getPdfParentId(filename) || pdfViewerCard.pdfElementId || 0;
  if (!parentId) { showFlash('Set SM parent in library first'); return; }

  // Convert staged highlights to extract (green)
  _pdfHighlights = _pdfHighlights.map(h => h.type === 'staged' ? { ...h, type: 'extract' } : h);
  savePdfHighlights(filename, _pdfHighlights);
  renderHighlightLayer(pdfViewerPage);

  const segments = _pdfStagedSegments.map(s =>
    s.kind === 'text' ? { kind: 'text', text: s.text } : { kind: 'image', dataUrl: s.dataUrl }
  );
  const rec = {
    id:          `pdfstage-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    type:        'pdf-extract-create',
    parentId,
    parentTitle: filename || pdfViewerCard.title,
    segments,
    pdfPage:     pdfViewerPage - 1,
    timestamp:   new Date().toISOString(),
    synced:      false,
  };
  _pdfStagedSegments = [];
  updateStagedBar();

  pendingExtracts.push(rec);
  saveExtracts();
  showFlash(`✂ Staged extract (${segments.length} segments)`);
  uploadExtract(rec);
}

// ── Image region extraction ─────────────────────────────────────────────────
function toggleImgCropMode() {
  _imgCropMode = !_imgCropMode;
  $('pdf-img-btn').classList.toggle('mode-active', _imgCropMode);
  const overlay = $('pdf-img-crop-overlay');
  overlay.classList.toggle('active', _imgCropMode);
  // Disable text layer pointer events so drag works
  $('pdf-text-layer').style.pointerEvents = _imgCropMode ? 'none' : '';
  if (!_imgCropMode) {
    _imgCropStart = null;
    const box = document.getElementById('pdf-img-crop-box');
    if (box) box.remove();
  }
}

(function wireImgCrop() {
  const overlay = $('pdf-img-crop-overlay');

  overlay.addEventListener('pointerdown', e => {
    if (!_imgCropMode) return;
    const r = overlay.getBoundingClientRect();
    _imgCropStart = { x: e.clientX - r.left, y: e.clientY - r.top };
    overlay.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  overlay.addEventListener('pointermove', e => {
    if (!_imgCropMode || !_imgCropStart) return;
    const r    = overlay.getBoundingClientRect();
    const cx   = e.clientX - r.left;
    const cy   = e.clientY - r.top;
    const left = Math.min(_imgCropStart.x, cx);
    const top  = Math.min(_imgCropStart.y, cy);
    const w    = Math.abs(cx - _imgCropStart.x);
    const h    = Math.abs(cy - _imgCropStart.y);
    let box = document.getElementById('pdf-img-crop-box');
    if (!box) { box = document.createElement('div'); box.id = 'pdf-img-crop-box'; overlay.appendChild(box); }
    Object.assign(box.style, { left: left+'px', top: top+'px', width: w+'px', height: h+'px' });
  });

  overlay.addEventListener('pointerup', async e => {
    if (!_imgCropMode || !_imgCropStart) return;
    const r    = overlay.getBoundingClientRect();
    const cx   = e.clientX - r.left;
    const cy   = e.clientY - r.top;
    const cropRect = {
      left:   Math.min(_imgCropStart.x, cx),
      top:    Math.min(_imgCropStart.y, cy),
      width:  Math.abs(cx - _imgCropStart.x),
      height: Math.abs(cy - _imgCropStart.y),
    };
    toggleImgCropMode();
    if (cropRect.width < 8 || cropRect.height < 8) return;

    if (_pdfStagedSegments.length > 0) {
      // Buffer already has content — auto-stage without asking
      await stageImageCrop(cropRect);
    } else {
      // Buffer is empty — offer choice: extract now or start staging
      const dataUrl = await renderCropToDataUrl(cropRect);
      if (!dataUrl) { showFlash('Image render failed'); return; }
      _pendingCropData = { dataUrl };
      $('pdf-crop-choice-bar').style.display = 'flex';
    }
  });
})();

async function renderCropToDataUrl(crop) {
  if (!pdfViewerDoc) return null;
  try {
    const page  = await pdfViewerDoc.getPage(pdfViewerPage);
    const vp1   = page.getViewport({ scale: 1 });
    const cur   = ($('pdf-viewport').clientWidth || window.innerWidth) / vp1.width;
    const scale = Math.max(0.5, Math.min(cur, 3)) * 2;
    const vp    = page.getViewport({ scale });
    const off   = document.createElement('canvas');
    off.width   = vp.width; off.height = vp.height;
    await page.render({ canvasContext: off.getContext('2d'), viewport: vp }).promise;
    const dst = document.createElement('canvas');
    dst.width  = crop.width  * 2;
    dst.height = crop.height * 2;
    dst.getContext('2d').drawImage(off, crop.left*2, crop.top*2, crop.width*2, crop.height*2, 0, 0, dst.width, dst.height);
    return await new Promise(res => dst.toBlob(b => {
      const fr = new FileReader(); fr.onloadend = () => res(fr.result); fr.readAsDataURL(b);
    }, 'image/png'));
  } catch { return null; }
}

async function stageImageCrop(cropRect) {
  const dataUrl = await renderCropToDataUrl(cropRect);
  if (!dataUrl) { showFlash('Image render failed'); return; }
  _pdfStagedSegments.push({ kind: 'image', dataUrl, page: pdfViewerPage });
  updateStagedBar();
  showFlash('+ Image staged');
}

function hideCropChoiceBar() {
  $('pdf-crop-choice-bar').style.display = 'none';
  _pendingCropData = null;
}

async function extractImageCrop(dataUrl) {
  if (!pdfViewerCard) return;
  const filename = _pdfHighlightsFilename;
  const parentId = getPdfParentId(filename) || pdfViewerCard.pdfElementId || 0;
  if (!parentId) { showFlash('Set SM parent in library first'); return; }

  const rec = {
    id:          `pdfimg-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    type:        'image-extract',
    parentId,
    parentTitle: filename || pdfViewerCard.title,
    imageData:   dataUrl,
    pdfPage:     pdfViewerPage - 1,
    timestamp:   new Date().toISOString(),
    synced:      false,
  };
  pendingExtracts.push(rec);
  saveExtracts();
  showFlash('🖼 Image extracted');
  uploadExtract(rec);
}

// ── PDF Library ─────────────────────────────────────────────────────────────
async function goToLibrary() {
  showScreen('library');
  await openLibrary();
}

function closeLibrary() {
  if (idx < cards.length) { showScreen('review'); renderCard(); }
  else if (cards.length > 0) { syncAndDone(); }
  else { showScreen('loading'); init(); }
}

async function openLibrary() {
  const listEl = $('library-list');
  listEl.innerHTML = '<p class="lib-empty">Loading…</p>';

  const dirHandle = await getPdfDirHandle();
  if (!dirHandle) {
    if (window.showDirectoryPicker) {
      listEl.innerHTML = `<div class="lib-no-folder">
        <p>No PDF folder set.</p>
        <button id="lib-setup-folder-btn" class="primary-btn">Select PDF folder</button>
      </div>`;
      $('lib-setup-folder-btn').addEventListener('click', async () => {
        const h = await pickPdfFolder();
        if (h) openLibrary();
      });
    } else {
      listEl.innerHTML = '<p class="lib-empty">File access not supported. Use Chrome or Edge.</p>';
    }
    return;
  }

  let pdfs = [];
  try {
    const perm = await dirHandle.queryPermission({ mode: 'read' });
    if (perm !== 'granted') {
      const granted = await dirHandle.requestPermission({ mode: 'read' });
      if (granted !== 'granted') {
        listEl.innerHTML = '<p class="lib-empty">Folder access denied.</p>';
        return;
      }
    }
    for await (const entry of dirHandle.values()) {
      if (entry.kind === 'file' && entry.name.toLowerCase().endsWith('.pdf'))
        pdfs.push(entry.name);
    }
  } catch (e) {
    listEl.innerHTML = `<p class="lib-empty">Could not read folder: ${esc(e.message)}</p>`;
    return;
  }

  pdfs.sort((a, b) => a.localeCompare(b));

  if (!pdfs.length) {
    listEl.innerHTML = '<p class="lib-empty">No PDF files found in this folder.</p>';
    return;
  }

  const globalParent = parseInt(localStorage.getItem('smgo_pdf_parent_id') || '0', 10);
  listEl.innerHTML = pdfs.map(name => {
    const page     = localStorage.getItem(`smgo_pdf_pos_${name}`);
    const hlCount  = parseInt(localStorage.getItem(`smgo_pdf_hlcount_${name}`) || '0', 10);
    const perPar   = parseInt(localStorage.getItem(`smgo_pdf_parent_${name}`) || '0', 10);
    const parLabel = perPar ? `#${perPar}` : (globalParent ? `#${globalParent}` : '–');
    return `<div class="pdf-lib-item" data-name="${esc(name)}">
      <div class="pdf-lib-info">
        <div class="pdf-lib-name">${esc(name.replace(/\.pdf$/i, ''))}</div>
        <div class="pdf-lib-meta">
          <span>${page ? `p. ${page}` : 'Not started'}</span>
          ${hlCount ? `<span class="pdf-lib-hl-count">${hlCount} extracts</span>` : ''}
        </div>
      </div>
      <button class="pdf-lib-parent-btn" data-name="${esc(name)}" title="Set SM parent element">SM: ${esc(parLabel)}</button>
    </div>`;
  }).join('');

  listEl.querySelectorAll('.pdf-lib-item').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('.pdf-lib-parent-btn')) return;
      openPdfFromLibrary(el.dataset.name);
    });
  });
  listEl.querySelectorAll('.pdf-lib-parent-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const name    = btn.dataset.name;
      const current = localStorage.getItem(`smgo_pdf_parent_${name}`) || '';
      const id      = prompt(`SM parent element ID for:\n"${name.replace(/\.pdf$/i,'')}"\n(blank = use global default #${globalParent||'none'}):`, current);
      if (id === null) return;
      if (id.trim() && /^\d+$/.test(id.trim())) {
        localStorage.setItem(`smgo_pdf_parent_${name}`, id.trim());
        btn.textContent = `SM: #${id.trim()}`;
        showFlash('Parent ID saved');
      } else if (!id.trim()) {
        localStorage.removeItem(`smgo_pdf_parent_${name}`);
        btn.textContent = `SM: ${globalParent ? `#${globalParent}` : '–'}`;
        showFlash('Using global parent');
      } else {
        alert('Must be a numeric element ID.');
      }
    });
  });
}

function openPdfFromLibrary(filename) {
  const savedPage = parseInt(localStorage.getItem(`smgo_pdf_pos_${filename}`) || '1', 10) - 1;
  openPdfViewer({
    id:           0,
    type:         'pdf-extract',
    title:        filename.replace(/\.pdf$/i, ''),
    pdfFilename:  filename,
    pdfElementId: getPdfParentId(filename) || null,
    pdfPage:      Math.max(0, savedPage),
    _fromLibrary: true,
  });
}

$('lib-btn').addEventListener('click', goToLibrary);
$('done-library-btn').addEventListener('click', goToLibrary);
$('lib-back-btn').addEventListener('click', closeLibrary);
$('lib-pick-btn').addEventListener('click', async () => {
  const h = await pickPdfFolder();
  if (h) openLibrary();
});

// Wire up PDF modal buttons
$('pdf-close-btn').addEventListener('click', closePdfViewer);
$('pdf-prev-btn').addEventListener('click', () => {
  if (pdfViewerPage > 1) renderPdfPage(pdfViewerPage - 1);
});
$('pdf-next-btn').addEventListener('click', () => {
  if (pdfViewerDoc && pdfViewerPage < pdfViewerDoc.numPages) renderPdfPage(pdfViewerPage + 1);
});
$('pdf-stage-btn').addEventListener('click', stageSelection);
$('pdf-extract-btn').addEventListener('click', extractFromPdf);
$('pdf-cloze-btn').addEventListener('click', pdfCaptureForCloze);
$('pdf-qa-btn').addEventListener('click', pdfCaptureForQA);
$('pdf-img-btn').addEventListener('click', toggleImgCropMode);
$('pdf-mark-btn').addEventListener('click', markPageAsRead);
$('pdf-stage-extract-btn').addEventListener('click', extractAllStaged);
$('pdf-stage-clear-btn').addEventListener('click', clearStaged);
$('pdf-crop-extract-now-btn').addEventListener('click', async () => {
  if (!_pendingCropData) return;
  const { dataUrl } = _pendingCropData;
  hideCropChoiceBar();
  await extractImageCrop(dataUrl);
});
$('pdf-crop-stage-btn').addEventListener('click', () => {
  if (!_pendingCropData) return;
  const { dataUrl } = _pendingCropData;
  hideCropChoiceBar();
  _pdfStagedSegments.push({ kind: 'image', dataUrl, page: pdfViewerPage });
  updateStagedBar();
  showFlash('+ Image staged');
});
$('pdf-set-folder-btn').addEventListener('click', async () => {
  const handle = await pickPdfFolder();
  if (handle && pdfViewerCard) {
    $('pdf-no-folder-msg').style.display = 'none';
    await openPdfViewer(pdfViewerCard);
  }
});
// Tap viewport to restore auto-hidden header
$('pdf-viewport').addEventListener('click', () => {
  if ($('pdf-modal').classList.contains('open')) showPdfHeader();
});
$('pdf-open-btn').addEventListener('click', () => {
  if (cards[idx]) openPdfViewer(cards[idx]);
});

// ── Typography panel ──────────────────────────────────────────────────────
const TYPO_DEFAULTS = { font: 'sans', size: 'md', spacing: 'normal', width: 'medium' };

function syncTypoPanel() {
  Object.keys(TYPO_DEFAULTS).forEach(key => {
    const val = localStorage.getItem(`smgo_${key}`) || TYPO_DEFAULTS[key];
    document.querySelectorAll(`[data-typo="${key}"] button`).forEach(btn => {
      btn.classList.toggle('active', btn.dataset.val === val);
    });
  });
}

$('typo-toggle').addEventListener('click', () => {
  const panel = $('typo-panel');
  const open  = panel.classList.toggle('open');
  $('typo-toggle').classList.toggle('active', open);
  if (open) syncTypoPanel();
});

document.querySelectorAll('[data-typo]').forEach(group => {
  group.addEventListener('click', e => {
    const btn = e.target.closest('button[data-val]');
    if (!btn) return;
    const key = group.dataset.typo;
    const val = btn.dataset.val;
    localStorage.setItem(`smgo_${key}`, val);
    document.documentElement.setAttribute(`data-${key}`, val);
    group.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
  });
});

// ── Keyboard shortcuts (desktop / MacBook) ────────────────────────────────
document.addEventListener('keydown', e => {
  const anyModal = ['edit-modal','qa-modal','cloze-modal','pdf-modal'].some(id => $(id)?.classList.contains('open'));
  if (anyModal) {
    if (e.key === 'Escape') {
      ['edit-modal','qa-modal','cloze-modal'].forEach(id => $(id)?.classList.remove('open'));
      if ($('pdf-modal')?.classList.contains('open')) closePdfViewer();
    }
    return;
  }
  if ($('extract-drawer')?.classList.contains('open')) { if (e.key === 'Escape') closeExtractDrawer(); return; }
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
  switch (e.key) {
    case ' ':
    case 'Enter':
      e.preventDefault();
      if (revealBtn.style.display !== 'none') revealBtn.click();
      break;
    case '0': case '1': case '2': case '3': case '4': case '5':
      if (gradeRow.style.display === 'grid') { e.preventDefault(); applyGrade(parseInt(e.key)); }
      break;
    case 's': case 'S': e.preventDefault(); skipCard(); break;
    case 'd': case 'D':
      if ($('dismiss-btn').style.display !== 'none')
        if (confirm('Dismiss this element? It will be marked Done in SuperMemo.')) dismissCard();
      break;
    case 'n': case 'N': e.preventDefault(); openEditModal(); break;
    case 'p': case 'P':
      if (cards[idx]?.type === 'pdf-extract') { e.preventDefault(); openPdfViewer(cards[idx]); }
      break;
    case 'Escape': $('typo-panel')?.classList.remove('open'); break;
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
init();
