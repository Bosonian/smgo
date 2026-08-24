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
    const ac = new AbortController();
    const t  = setTimeout(() => ac.abort(), 10_000);
    const res = await fetch(`${supa.url}/rest/v1/${table}`, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        apikey: supa.key, Authorization: `Bearer ${supa.key}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify(row),
    });
    clearTimeout(t);
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
let activeCollection = null;
let availableCollections = [];
let collectionEpoch = 0;
const PROTOCOL_VERSION = 2;

function collectionToken(id) {
  return String(id || '').replace(/[^a-z0-9-]/gi, '-').toLowerCase();
}

function activateCollection(data, fallbackId = null) {
  const id = data?.collectionId || data?.collection_id || fallbackId;
  if (!id) throw new Error('This export has no collection ID. Re-export it with the current SMGo version.');
  if (activeCollection && activeCollection.id !== id) cancelCollectionBoundUi();
  activeCollection = {
    id,
    name: data?.collectionName || data?.collection_name || id,
  };
  collectionEpoch++;
  localStorage.setItem('smgo_active_collection', id);
}

function collectionStorageKey(name, collectionId = activeCollection?.id) {
  if (!collectionId) throw new Error('No active collection');
  return `smgo_${collectionToken(collectionId)}_${name}`;
}

function collectionPayload(payload = {}, collectionId = payload.collectionId || activeCollection?.id) {
  if (!collectionId) throw new Error('No active collection');
  if (payload.collectionId && payload.collectionId !== collectionId) {
    throw new Error('A queued action cannot be moved to another collection');
  }
  if (payload.protocolVersion && payload.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('A queued action has an unsupported protocol version');
  }
  return { ...payload, protocolVersion: payload.protocolVersion || PROTOCOL_VERSION, collectionId };
}

function queueRow(type, payload, suffix, collectionId = payload.collectionId || activeCollection?.id) {
  const body = collectionPayload(payload, collectionId);
  const unique = suffix || body.id || `${body.elementId || 'item'}-${body.timestamp || Date.now()}`;
  const commandId = `${collectionToken(collectionId)}--${type}--${unique}`;
  return {
    id: commandId,
    type,
    collection_id: collectionId,
    payload: { ...body, commandId },
  };
}

function isCurrentCollection(collectionId, epoch = collectionEpoch) {
  return activeCollection?.id === collectionId && collectionEpoch === epoch;
}

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
const collectionSelector = $('collection-selector');

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

  // Supabase: try cloud cards first — works from any network
  if (getSupabase() && await initFromSupabase()) return;

  if (isStaticMode()) {
    serverUrlWrap.textContent = 'GitHub Pages – offline-ready';
    await initStatic();
  } else {
    serverUrlWrap.innerHTML = `Server: <a href="${getServerUrl()}" target="_blank">${getServerUrl()}</a>`;
    await initServer();
    if (activeCollection) {
      await syncAllPending();
      await syncAllExtracts();
    }
  }
}

async function initFromSupabase() {
  const supa = getSupabase();
  if (!supa) return false;
  try {
    const today = localDate();
    const res = await fetch(
      `${supa.url}/rest/v1/smgo_daily?review_date=eq.${today}&select=collection_id,data&order=collection_id`,
      { headers: { apikey: supa.key, Authorization: `Bearer ${supa.key}` } }
    );
    if (!res.ok) return false;
    const rows = await res.json();
    const usable = rows.filter(r =>
      r.collection_id &&
      r.data?.protocolVersion === PROTOCOL_VERSION &&
      r.data?.collectionId === r.collection_id &&
      Array.isArray(r.data?.cards)
    );
    if (!usable.length) return false;
    availableCollections = usable;
    const savedId = localStorage.getItem('smgo_active_collection');
    const selected = usable.find(r => r.collection_id === savedId) || usable[0];
    activateCollection(selected.data, selected.collection_id);
    renderCollectionSelector(selected.collection_id);
    loadExtracts();
    cards = selected.data.cards;
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

function renderCollectionSelector(selectedId) {
  if (!collectionSelector) return;
  collectionSelector.replaceChildren();
  if (availableCollections.length < 2) { collectionSelector.style.display = 'none'; return; }
  for (const row of availableCollections) {
    const option = document.createElement('option');
    option.value = row.collection_id;
    option.textContent = row.data?.collectionName || row.collection_id;
    option.selected = row.collection_id === selectedId;
    collectionSelector.appendChild(option);
  }
  collectionSelector.style.display = '';
}

function activateAndLoadCards(data, fallbackId, source) {
  activateCollection(data, fallbackId);
  loadExtracts();
  cards = data.cards || [];
  idx = 0;
  serverUrlWrap.textContent = `${source} · ${activeCollection.name} · ${cards.length} cards`;
  if (!cards.length) { showScreen('done', 'No items due today!', ''); return; }
  loadStoredProgress();
  showScreen('review');
  renderCard();
}

collectionSelector?.addEventListener('change', () => {
  const row = availableCollections.find(r => r.collection_id === collectionSelector.value);
  if (!row) return;
  activateAndLoadCards(row.data, row.collection_id, 'Supabase');
  syncAllPending().catch(() => {});
  syncAllExtracts().catch(() => {});
});

async function initStatic() {
  try {
    const res  = await fetch('./data/today.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    activateAndLoadCards(data, null, 'Static export');
  } catch (err) {
    try {
      const cached = await caches.match('./data/today.json');
      if (cached) {
        const data = await cached.json();
        if (data.cards) {
          activateAndLoadCards(data, null, 'Cached export');
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
    activateAndLoadCards(data, null, 'Desktop server');
  } catch (err) {
    try {
      const cached = await caches.match('/api/today');
      if (cached) {
        const data = await cached.json();
        if (data.cards) {
          activateAndLoadCards(data, null, 'Cached desktop server');
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
function todayKey(collectionId = activeCollection?.id, date = localDate()) {
  return collectionStorageKey('progress_' + date, collectionId);
}

// Persistent cross-day dismiss store — survives session reloads.
function dismissedKey(collectionId = activeCollection?.id) { return collectionStorageKey('dismissed', collectionId); }
const DISMISSED_TTL_MS = 365 * 864e5;  // 1 year — generous, unsynced entries are never pruned

// Raw store — never filtered. Use this any time you intend to write back.
function loadDismissedRaw(collectionId = activeCollection?.id) {
  try { return JSON.parse(localStorage.getItem(dismissedKey(collectionId)) || '[]'); }
  catch { return []; }
}
// Filtered view for read-only consumers (the done set).
// Only prunes entries that are BOTH synced AND older than TTL — unsynced entries
// are kept forever so SM always gets the dismiss even after weeks offline.
function loadDismissed(collectionId = activeCollection?.id) {
  const cutoff = Date.now() - DISMISSED_TTL_MS;
  return loadDismissedRaw(collectionId).filter(d =>
    !d.synced || new Date(d.timestamp).getTime() > cutoff
  );
}
function saveDismissed(list, collectionId = activeCollection?.id) {
  localStorage.setItem(dismissedKey(collectionId), JSON.stringify(list));
}

function loadStoredProgress(collectionId = activeCollection?.id) {
  try {
    const saved = JSON.parse(localStorage.getItem(todayKey(collectionId)) || '{}');
    grades    = saved.grades    || [];
    dismisses = saved.dismisses || [];
    const norm = v => String(v);
    const done = new Set([
      ...grades.map(g => norm(g.elementId)),
      ...dismisses.map(d => norm(d.elementId)),
      ...loadDismissed(collectionId).map(d => norm(d.elementId)),
    ]);
    const next = cards.findIndex(c => !done.has(norm(c.id)));
    idx = next === -1 ? cards.length : next;
  } catch { grades = []; dismisses = []; }
}
function saveProgress(collectionId = activeCollection?.id, gradesToSave = grades, dismissesToSave = dismisses) {
  const key = todayKey(collectionId);
  const prev = JSON.parse(localStorage.getItem(key) || '{}');
  localStorage.setItem(key, JSON.stringify({ ...prev, date: localDate(), collectionId,
    protocolVersion: PROTOCOL_VERSION, grades: gradesToSave, dismisses: dismissesToSave, ts: Date.now() }));
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
  } else if (c.answer) {
    // Q&A pair: show question now, answer hidden until revealed
    bodyHtml = `<div class="card-body selectable">${formatBody(c.body)}</div>
      <div class="card-answer" id="card-answer" style="display:none">
        <div class="answer-divider">Answer</div>
        <div class="card-body">${formatBody(c.answer)}</div>
      </div>`;
  } else if (c.body) {
    bodyHtml = `<div class="card-body selectable">${formatBody(c.body)}</div>`;
  } else {
    bodyHtml = `<div class="card-body" style="color:var(--muted)">No renderable content.</div>`;
  }

  const prioClass = c.priority <= 20 ? 'prio-high' : c.priority <= 50 ? 'prio-mid' : 'prio-low';
  const prioBadge = c.priority !== undefined
    ? `<span class="priority-badge ${prioClass}">${c.priority}%</span>` : '';

  const cardHeading = c.type === 'pdf-extract' && c.pdfFilename
    ? esc(c.pdfFilename.replace(/\.[^.]+$/, '').replace(/_/g, ' '))
    : '';

  cardArea.innerHTML = `
    <div class="card">
      <div class="card-top-row">
        <span class="card-type-badge ${badgeClass}">${typeLabel[c.type] || c.type}</span>
        ${prioBadge}
      </div>
      ${cardHeading ? `<div class="card-title">${cardHeading}</div>` : ''}
      ${bodyHtml}
    </div>`;

  revealBtn.style.display = 'block';
  gradeRow.style.display  = 'none';

  const isDismissable = c.type === 'topic' || c.type === 'pdf-extract' || c.type === 'image';
  $('dismiss-btn').style.display  = isDismissable ? 'inline-flex' : 'none';
  $('edit-btn').style.display     = (getSupabase() || !isStaticMode()) ? 'inline-flex' : 'none';
  const showPrio = getSupabase() && c.priority !== undefined;
  const prioBtn  = $('priority-btn');
  prioBtn.style.display = showPrio ? 'inline-flex' : 'none';
  if (showPrio) prioBtn.textContent = `P: ${c.priority}%`;

  if (c.type === 'cloze' || c.answer) {
    revealBtn.textContent = 'Show Answer';
    revealBtn.onclick = doReveal;
  } else {
    revealBtn.textContent = 'Done (read)';
    revealBtn.onclick = () => applyGrade(5);
  }
}

function doReveal() {
  revealed = true;
  document.querySelectorAll('.cloze-blank').forEach(el => el.classList.add('revealed'));
  const answerEl = document.getElementById('card-answer');
  if (answerEl) {
    answerEl.style.display = '';
    cardArea.querySelector('.card')?.classList.add('qa-revealed');
  }
  showGrades();
}

function skipCard() {
  idx++;
  renderCard();
}

function dismissCard() {
  const card = cards[idx];
  if (!card) return;
  const originId = activeCollection?.id;
  if (!originId) return;
  const now = new Date().toISOString();
  const ids = [card.id];
  if (card.answerPairId) ids.push(card.answerPairId);
  const dList = loadDismissedRaw(originId);
  for (const eid of ids) {
    dismisses.push(collectionPayload({ elementId: eid, timestamp: now }, originId));
    dList.push(collectionPayload({ elementId: eid, timestamp: now, synced: false }, originId));
  }
  saveProgress(originId);
  saveDismissed(dList, originId);
  showFlash('Dismissed');
  // Attempt upload now; syncAllDismissed handles retry if offline
  syncAllDismissed(originId).catch(() => {});
  idx++;
  renderCard();
}
function showGrades() {
  revealBtn.style.display = 'none';
  gradeRow.style.display  = 'grid';
}

// ── Priority ───────────────────────────────────────────────────────────────
let _pendingPriority = null; // priority value staged in the modal

function openPriorityModal() {
  const card = cards[idx];
  if (!card) return;
  _pendingPriority = card.priority !== undefined ? card.priority : 50;
  const slider  = $('priority-slider');
  const display = $('priority-value-display');
  slider.value  = _pendingPriority;
  display.textContent = _pendingPriority + '%';
  // Highlight matching preset if any
  document.querySelectorAll('.prio-preset').forEach(b => {
    b.classList.toggle('selected', parseInt(b.dataset.pct) === _pendingPriority);
  });
  $('priority-modal').classList.add('open');
}

async function applyPriority() {
  const card = cards[idx];
  if (!card || _pendingPriority === null) return;
  const originId = activeCollection?.id;
  if (!originId) return;
  const pct = _pendingPriority;
  $('priority-modal').classList.remove('open');
  // Update local card data so badge refreshes immediately
  card.priority = pct;
  renderCard();
  const supa = getSupabase();
  if (supa) {
    await supaUpsert('smgo_queue', queueRow('priority',
      { elementId: card.id, priority: pct, timestamp: new Date().toISOString(), collectionId: originId }, undefined, originId));
  }
  showFlash(`Priority set to ${pct}%`);
}

(function wirePriorityModal() {
  $('priority-btn').addEventListener('click', openPriorityModal);
  $('priority-modal-close').addEventListener('click', () => $('priority-modal').classList.remove('open'));
  $('priority-cancel-btn').addEventListener('click', () => $('priority-modal').classList.remove('open'));
  $('priority-set-btn').addEventListener('click', applyPriority);

  const slider  = $('priority-slider');
  const display = $('priority-value-display');
  slider.addEventListener('input', () => {
    _pendingPriority = parseInt(slider.value);
    display.textContent = _pendingPriority + '%';
    document.querySelectorAll('.prio-preset').forEach(b =>
      b.classList.toggle('selected', parseInt(b.dataset.pct) === _pendingPriority));
  });

  document.querySelectorAll('.prio-preset').forEach(b => {
    b.addEventListener('click', () => {
      _pendingPriority = parseInt(b.dataset.pct);
      slider.value     = _pendingPriority;
      display.textContent = _pendingPriority + '%';
      document.querySelectorAll('.prio-preset').forEach(p =>
        p.classList.toggle('selected', p === b));
    });
  });
})();
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
  const c = cards[idx];
  const originId = activeCollection?.id;
  if (!originId) return;
  grades.push(collectionPayload({ elementId: c.id, grade, timestamp: new Date().toISOString() }, originId));
  // Grade the answer element with the same grade when it's a Q&A pair
  if (c.answerPairId) {
    grades.push(collectionPayload({ elementId: c.answerPairId, grade, timestamp: new Date().toISOString() }, originId));
  }
  saveProgress(originId);
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
  const originId = activeCollection?.id;
  const originEpoch = collectionEpoch;
  const reviews = grades.slice();
  if (!originId) return false;

  // Try Supabase first (works anywhere)
  const supa = getSupabase();
  if (supa) {
    let allOk = true;
    for (const g of reviews) {
      const ok = await supaUpsert('smgo_queue', queueRow('grade', g, undefined, originId));
      if (!ok) allOk = false;
    }
    if (allOk) {
      const key = todayKey(originId);
      const prev = JSON.parse(localStorage.getItem(key) || '{}');
      localStorage.setItem(key, JSON.stringify({ ...prev, synced: true }));
      return true;
    }
  }

  // Fallback: local server
  if (!isStaticMode()) {
    try {
      const res = await fetch(`${getServerUrl()}/api/grades`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(collectionPayload({ date: localDate(), reviews }, originId)),
      });
      if (res.ok) {
        const key = todayKey(originId);
        const prev = JSON.parse(localStorage.getItem(key) || '{}');
        localStorage.setItem(key, JSON.stringify({ ...prev, synced: true }));
      }
      if (!isCurrentCollection(originId, originEpoch)) return res.ok;
      return res.ok;
    } catch { return false; }
  }

  return false;
}

async function syncAllPending() {
  const originId = activeCollection?.id;
  if (!originId) return;
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(collectionStorageKey('progress_', originId))) keys.push(k);
  }
  let total = 0;
  for (const k of keys) {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(k) || '{}'); } catch { continue; }
    if (saved.collectionId !== originId || !saved.grades || !saved.grades.length || saved.synced) continue;

    // Try Supabase first (works anywhere)
    const supa = getSupabase();
    if (supa) {
      let allOk = true;
      for (const g of saved.grades) {
        const ok = await supaUpsert('smgo_queue', queueRow('grade', g, undefined, originId));
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
      const date = saved.date || k.slice(collectionStorageKey('progress_').length);
      try {
        const res = await fetch(`${getServerUrl()}/api/grades`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(collectionPayload({ date, reviews: saved.grades }, originId)),
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

let _syncDismissInFlight = false;

async function syncAllDismissed(originId = activeCollection?.id) {
  if (_syncDismissInFlight) return;
  if (!originId) return;
  _syncDismissInFlight = true;
  try {
    // Snapshot only the keys to attempt; don't hold the array across awaits.
    const pending = loadDismissedRaw(originId).filter(d => !d.synced && d.collectionId === originId);
    const syncedKeys = new Set();  // `${elementId}|${timestamp}`

    for (const d of pending) {
      let ok = false;
      const supa = getSupabase();
      if (supa) {
        ok = await supaUpsert('smgo_queue', queueRow('dismiss', d, undefined, originId));
      } else if (!isStaticMode()) {
        try {
          const res = await fetch(`${getServerUrl()}/api/dismiss`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(collectionPayload({ elementId: d.elementId, timestamp: d.timestamp }, originId)),
          });
          ok = res.ok;
        } catch {}
      }
      if (ok) syncedKeys.add(`${d.elementId}|${d.timestamp}`);
    }

    if (!syncedKeys.size) return;
    // Re-read raw store right before writing — preserves any dismisses that
    // arrived via dismissCard() during our awaits above.
    const fresh = loadDismissedRaw(originId);
    let mutated = false;
    for (const d of fresh) {
      if (!d.synced && syncedKeys.has(`${d.elementId}|${d.timestamp}`)) {
        d.synced = true; mutated = true;
      }
    }
    if (mutated) saveDismissed(fresh, originId);
  } finally {
    _syncDismissInFlight = false;
  }
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

function loadExtracts(collectionId = activeCollection?.id) {
  try { pendingExtracts = JSON.parse(localStorage.getItem(collectionStorageKey('extracts', collectionId)) || '[]'); }
  catch { pendingExtracts = []; }
  try { pendingItems    = JSON.parse(localStorage.getItem(collectionStorageKey('items', collectionId))    || '[]'); }
  catch { pendingItems  = []; }
  try { pendingEdits    = JSON.parse(localStorage.getItem(collectionStorageKey('edits', collectionId))    || '[]'); }
  catch { pendingEdits  = []; }
  updateExtractBadge();
  const ls = localStorage.getItem(collectionStorageKey('last_sync', collectionId));
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
function saveExtracts(collectionId = activeCollection?.id, records = pendingExtracts) {
  localStorage.setItem(collectionStorageKey('extracts', collectionId), JSON.stringify(records));
  if (activeCollection?.id === collectionId) updateExtractBadge();
}
function saveItems(collectionId = activeCollection?.id, records = pendingItems) {
  localStorage.setItem(collectionStorageKey('items', collectionId), JSON.stringify(records));
  if (activeCollection?.id === collectionId) updateExtractBadge();
}
function saveEdits(collectionId = activeCollection?.id, records = pendingEdits) {
  localStorage.setItem(collectionStorageKey('edits', collectionId), JSON.stringify(records));
  if (activeCollection?.id === collectionId) updateExtractBadge();
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
document.addEventListener('touchend',   () => scheduleSelCheck(350), { passive: true });
// stylus lift — same delay as touch so the selection rect is settled
document.addEventListener('pointerup',  e => { if (e.pointerType === 'pen') scheduleSelCheck(200); }, { passive: true });

// S Pen mode: set html.pen-active on first pen contact or hover.
// CSS keys off this to set touch-action:none on .card (so Samsung's compositor
// never claims pen drags as scroll). Fired on pointermove (hover, before contact)
// AND pointerdown capture (belt-and-suspenders for devices that skip hover events).
// Once set, pen-active is permanent — S25 Ultra always has the pen.
function _activatePenMode() {
  if (document.documentElement.classList.contains('pen-active')) return;
  document.documentElement.classList.add('pen-active');
  _wireTouchScrollForCard();
}
// Manual finger-scroll forwarder: needed because touch-action:none on .card
// (set via .pen-active .card CSS) prevents the browser from handling scroll natively.
// Touch events still fire — we just forward them to .card-body manually.
function _wireTouchScrollForCard() {
  const area = $('card-area');
  if (!area || area._penScrollWired) return;
  area._penScrollWired = true;
  let _ty = 0;
  area.addEventListener('touchstart', e => { _ty = e.touches[0].clientY; }, { passive: true });
  area.addEventListener('touchmove', e => {
    const body = area.querySelector('.card-body');
    if (!body) return;
    const dy = _ty - e.touches[0].clientY;
    _ty = e.touches[0].clientY;
    body.scrollBy(0, dy);
  }, { passive: true });
}
window.addEventListener('pointermove', e => { if (e.pointerType === 'pen') _activatePenMode(); }, { passive: true });
// capture:true fires before element handlers — ensures pen-active CSS is set even when
// hover events were not generated before this pointerdown
window.addEventListener('pointerdown', e => { if (e.pointerType === 'pen') _activatePenMode(); }, { passive: true, capture: true });

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
  const extract = collectionPayload({
    id:          `${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    parentId:    card.id,
    parentTitle: card.title,
    text,
    timestamp:   new Date().toISOString(),
    synced:      false,
  });

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
let clozeCollectionId = null;

function captureForCloze() {
  const sel  = window.getSelection();
  const text = sel?.toString().trim() ?? '';
  if (!text || !cards[idx]) { hideExtractToolbar(); return; }
  clozeParentId    = cards[idx].id;
  clozeParentTitle = cards[idx].title;
  clozeCollectionId = activeCollection?.id;
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
  if (!clozeCollectionId || !isCurrentCollection(clozeCollectionId)) {
    cancelCollectionBoundUi(); showFlash('Collection changed; cloze creation was cancelled.'); return;
  }
  if (!clozeWords.filter(w => !w.isSpace).some(w => w.blank)) {
    alert('Tap at least one word to blank it first.'); return;
  }
  const sentence = clozeWords.map(w => w.isSpace ? ' ' : w.blank ? `[${w.word}]` : w.word).join('');
  const item = collectionPayload({
    id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    type: 'cloze', parentId: clozeParentId, parentTitle: clozeParentTitle,
    sentence, timestamp: new Date().toISOString(), synced: false,
  }, clozeCollectionId);
  pendingItems.push(item);
  saveItems();
  $('cloze-modal').classList.remove('open');
  showFlash('[ ] Cloze saved');
  if (!isStaticMode()) uploadItem(item);
}

// ── Q&A via Gemini ──────────────────────────────────────────────────────────
let qaParentId = 0;
let qaParentTitle = '';
let qaCollectionId = null;

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
  qaCollectionId = activeCollection?.id;
  const qaEpoch = collectionEpoch;
  sel.removeAllRanges();
  hideExtractToolbar();

  $('qa-loading').style.display   = 'block';
  $('qa-form').style.display      = 'none';
  $('qa-modal').classList.add('open');

  try {
    const { question, answer } = await callGemini(text, apiKey);
    if (!isCurrentCollection(qaCollectionId, qaEpoch)) return;
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
  if (!qaCollectionId || !isCurrentCollection(qaCollectionId)) {
    cancelCollectionBoundUi(); showFlash('Collection changed; Q&A creation was cancelled.'); return;
  }
  const question = $('qa-question').value.trim();
  const answer   = $('qa-answer').value.trim();
  if (!question || !answer) { alert('Question and answer are required.'); return; }
  const item = collectionPayload({
    id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    type: 'qa', parentId: qaParentId, parentTitle: qaParentTitle,
    question, answer, timestamp: new Date().toISOString(), synced: false,
  }, qaCollectionId);
  pendingItems.push(item);
  saveItems();
  $('qa-modal').classList.remove('open');
  showFlash('🤖 Q&A saved');
  if (!isStaticMode()) uploadItem(item);
}

// ── Upload / sync ──────────────────────────────────────────────────────────
async function uploadExtract(extract, originId = extract.collectionId, records = pendingExtracts) {
  if (!originId || extract.collectionId !== originId) return;
  const qType = extract.type || 'extract'; // 'extract' or 'pdf-extract-create'
  // Try Supabase first (works from anywhere)
  if (await supaUpsert('smgo_queue', queueRow(qType, extract, undefined, originId))) {
    extract.synced = true; saveExtracts(originId, records); return;
  }
  // Fallback: local server (same-network only)
  if (!isStaticMode()) {
    try {
      const res = await fetch(`${getServerUrl()}/api/extracts`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(collectionPayload(extract, originId)),
      });
      if (res.ok) { extract.synced = true; saveExtracts(originId, records); }
    } catch {}
  }
}

async function uploadItem(item, originId = item.collectionId, records = pendingItems) {
  if (!originId || item.collectionId !== originId) return;
  // Try Supabase first
  if (await supaUpsert('smgo_queue', queueRow(item.type, item, undefined, originId))) {
    item.synced = true; saveItems(originId, records); return;
  }
  // Fallback: local server
  if (!isStaticMode()) {
    try {
      const res = await fetch(`${getServerUrl()}/api/items`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(collectionPayload(item, originId)),
      });
      if (res.ok) { item.synced = true; saveItems(originId, records); }
    } catch {}
  }
}

async function uploadEdit(edit, originId = edit.collectionId, records = pendingEdits) {
  const supa = getSupabase();
  if (!supa || !originId || edit.collectionId !== originId) return;
  const ok = await supaUpsert('smgo_queue', queueRow('edit', edit, undefined, originId));
  if (ok) { edit.synced = true; saveEdits(originId, records); }
}

async function syncAllExtracts() {
  const originId = activeCollection?.id;
  const extracts = pendingExtracts, items = pendingItems, edits = pendingEdits;
  if (!originId) return;
  for (const e of extracts.filter(x => !x.synced)) await uploadExtract(e, originId, extracts);
  for (const i of items.filter(x => !x.synced))    await uploadItem(i, originId, items);
  for (const e of edits.filter(x => !x.synced))    await uploadEdit(e, originId, edits);
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
  const ls = localStorage.getItem(collectionStorageKey('last_sync'));
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

function readLegacyJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }
  catch { return fallback; }
}

function tagLegacyRecords(records, collectionId) {
  return (Array.isArray(records) ? records : []).map(record =>
    collectionPayload({ ...record, collectionId: record.collectionId || collectionId }, collectionId));
}

function importLegacyFacharztState() {
  const targetId = activeCollection?.id;
  const targetName = activeCollection?.name || '';
  if (!targetId || !/facharzt/i.test(targetName)) {
    alert('Legacy browser state can only be imported while the Facharzt collection is selected.');
    return;
  }
  const marker = collectionStorageKey('legacy_facharzt_imported', targetId);
  if (localStorage.getItem(marker)) { alert('Facharzt legacy state was already imported for this collection.'); return; }
  if (prompt('Type IMPORT to copy old unscoped Facharzt browser state into this collection:') !== 'IMPORT') return;

  const copied = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    const match = key && /^smgo_progress_(\d{4}-\d{2}-\d{2})$/.exec(key);
    if (!match) continue;
    const destination = todayKey(targetId, match[1]);
    if (localStorage.getItem(destination)) continue;
    const state = readLegacyJson(key, {});
    localStorage.setItem(destination, JSON.stringify({ ...state, protocolVersion: PROTOCOL_VERSION,
      collectionId: targetId, grades: tagLegacyRecords(state.grades, targetId),
      dismisses: tagLegacyRecords(state.dismisses, targetId) }));
    copied.push(key);
  }
  const arrayKeys = [['smgo_dismissed', 'dismissed'], ['smgo_extracts', 'extracts'],
    ['smgo_items', 'items'], ['smgo_edits', 'edits']];
  for (const [legacy, destinationName] of arrayKeys) {
    const destination = collectionStorageKey(destinationName, targetId);
    if (!localStorage.getItem(destination) && localStorage.getItem(legacy)) {
      localStorage.setItem(destination, JSON.stringify(tagLegacyRecords(readLegacyJson(legacy, []), targetId)));
      copied.push(legacy);
    }
  }
  const legacyLastSync = localStorage.getItem('smgo_last_sync');
  if (legacyLastSync && !localStorage.getItem(collectionStorageKey('last_sync', targetId)))
    localStorage.setItem(collectionStorageKey('last_sync', targetId), legacyLastSync);
  localStorage.setItem(marker, new Date().toISOString());
  loadExtracts(targetId);
  loadStoredProgress(targetId);
  renderCard();
  alert(`Imported ${copied.length} legacy state record(s). The old keys were left untouched.`);
}

$('settings-icon').addEventListener('click', () => {
  const choice = prompt(
    'Settings\n\n1) Server URL (local network)\n2) Gemini API key\n3) Supabase URL\n4) Supabase anon key\n5) Import old Facharzt browser state\n\nEnter number:',
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
    importLegacyFacharztState();
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
  const originId = activeCollection?.id;
  const originEpoch = collectionEpoch;
  if (!originId) return;
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
  localStorage.setItem(collectionStorageKey('last_sync', originId), now.toISOString());
  if (!isCurrentCollection(originId, originEpoch)) return;
  updateDrawerSyncTime();
  showFlash(`✓ ${synced} of ${total} synced`);
  setSyncStatus(`✓ Last sync: ${time}`, 'ok');
});

// ── Edit / Add Note modal ─────────────────────────────────────────────────
let editImageData = null;
let editCollectionId = null;

function cancelCollectionBoundUi() {
  clozeWords = [];
  clozeCollectionId = null;
  qaCollectionId = null;
  editCollectionId = null;
  editImageData = null;
  ['cloze-modal', 'qa-modal', 'edit-modal', 'priority-modal'].forEach(id => $(id)?.classList.remove('open'));
  hideExtractToolbar();
}

function openEditModal() {
  if (!cards[idx]) return;
  editCollectionId = activeCollection?.id;
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
  const originId = editCollectionId;
  if (!originId || !isCurrentCollection(originId)) {
    cancelCollectionBoundUi(); showFlash('Collection changed; note was not saved.'); return;
  }
  const text = $('edit-note-text').value.trim();
  if (!text && !editImageData) { showFlash('Add text or paste an image first.'); return; }

  const rec = collectionPayload({
    id:          `edit-${card.id}-${Date.now()}-${Math.random().toString(36).slice(2,5)}`,
    elementId:   card.id,
    parentTitle: card.title,
    text,
    imageData:   editImageData || null,
    timestamp:   new Date().toISOString(),
    synced:      false,
  }, originId);

  // Always persist locally first so the note is never lost
  pendingEdits.push(rec);
  const originRecords = pendingEdits;
  saveEdits(originId, originRecords);

  $('edit-modal').classList.remove('open');

  // Attempt immediate Supabase upload
  const supa = getSupabase();
  if (supa) {
    const ok = await supaUpsert('smgo_queue', queueRow('edit', rec, undefined, originId));
    if (ok) { rec.synced = true; saveEdits(originId, originRecords); showFlash('✓ Note synced to SM'); return; }
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





// Card text selection: handled natively by Samsung's S Pen selection engine.
// html.pen-active .card { touch-action: none } (CSS) prevents Samsung's compositor
// from claiming pen drags as scroll, so the S Pen can drag-select freely.
// The existing selectionchange → scheduleSelCheck pipeline shows the toolbar.
// S Pen barrel button still works for word-select via the pointerdown handler below.

// Shared helper: select the word under (x, y) and fire the extract toolbar.
function penSelectWordAt(x, y) {
  const caret = document.caretRangeFromPoint(x, y);
  if (!caret) return;
  try {
    const tmp = document.createRange();
    tmp.setStart(caret.startContainer, caret.startOffset);
    tmp.setEnd(caret.startContainer, caret.startOffset);
    tmp.expand('word');
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(tmp);
    scheduleSelCheck(100);
  } catch {}
}

document.addEventListener('pointerdown', e => {
  if (e.pointerType === 'pen' && e.button === 2) {
    // Side button: word select anywhere in the card
    if (e.target.closest('#card-area')) {
      penSelectWordAt(e.clientX, e.clientY);
      e.preventDefault();
    }
  }
}, { passive: false });

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
  const anyModal = ['edit-modal','qa-modal','cloze-modal'].some(id => $(id)?.classList.contains('open'));
  if (anyModal) {
    if (e.key === 'Escape') {
      ['edit-modal','qa-modal','cloze-modal'].forEach(id => $(id)?.classList.remove('open'));
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
    case 'Escape': $('typo-panel')?.classList.remove('open'); break;
  }
});

// ── Supabase background polling ────────────────────────────────────────────
let _pollTimer    = null;
let _pollInFlight = false;   // reentrancy guard — prevents tick overlap on slow networks
const POLL_INTERVAL_MS = 30_000;

async function _pollTick() {
  if (_pollInFlight || !getSupabase()) return;
  _pollInFlight = true;
  try {
    await syncAllPending();
    await syncAllExtracts();
    await syncAllDismissed();
  } catch {}
  finally { _pollInFlight = false; }
}

// _startPolling only starts the interval — no immediate tick here.
// init() handles the first sync at startup; visibilitychange handles restore.
function _startPolling() {
  if (_pollTimer) return;
  _pollTimer = setInterval(_pollTick, POLL_INTERVAL_MS);
}

function _stopPolling() { clearInterval(_pollTimer); _pollTimer = null; }

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    _pollTick();      // sync immediately on restore from background
    _startPolling();  // then resume the interval
  } else {
    _stopPolling();
  }
});
if (document.visibilityState === 'visible') _startPolling();

// ── Start ──────────────────────────────────────────────────────────────────
init();
