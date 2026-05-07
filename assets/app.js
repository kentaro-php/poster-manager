/**
 * ポスター管理アプリ
 * - データ: Google スプレッドシート (Apps Script Web App経由)
 * - 写真: Cloudflare R2 (Worker経由)
 */

const STATUS_OPTIONS = [
  { key: '貼付済',   className: 's-done',    color: '#34c759' },
  { key: '未対応',   className: 's-pending', color: '#aeaeb2' },
  { key: '要確認',   className: 's-need',    color: '#ff9f0a' },
  { key: '撤去済',   className: 's-removed', color: '#6e6e73' },
  { key: '破損',     className: 's-broken',  color: '#ff3b30' },
];

const STATUS_BY_KEY = Object.fromEntries(STATUS_OPTIONS.map(s => [s.key, s]));

// 設定（localStorageに保存）
const SETTINGS_KEY = 'poster_manager_settings';
const LOCAL_PHOTO_PREFIX = 'local-photo:';
const LOCAL_PHOTO_STORAGE_PREFIX = 'poster_manager_photo_';
let settings = {
  staffName: '',
  gasUrl: '',
  photoUrl: '',
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) settings = Object.assign(settings, JSON.parse(raw));
  } catch (e) {}
}
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {}
}

// アプリ状態
const state = {
  posters: [],
  filteredPosters: [],
  searchQuery: '',
  statusFilter: 'all',
  map: null,
  cluster: null,
  mapMarkers: {},
  mapGeocoding: false,
  mapGeocodeDone: 0,
  mapGeocodeTotal: 0,
  initialMapBuilt: false,
  userLocation: null,
  userMarker: null,
  selectedPoster: null,
};

const FALLBACK_CENTER = [35.6946, 139.9826]; // 船橋市
const RENEWAL_DUE_MONTHS = 6;
const RENEWAL_OVERDUE_MONTHS = 12;

function parseLocalDate(value) {
  if (!value) return null;
  const m = String(value).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function addMonths(date, months) {
  const d = new Date(date);
  const targetMonth = d.getMonth() + months;
  d.setMonth(targetMonth);
  if (d.getMonth() !== ((targetMonth % 12) + 12) % 12) {
    d.setDate(0);
  }
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatDateJP(date) {
  if (!date) return '';
  return date.toLocaleDateString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric' });
}

function getRenewalInfo(poster) {
  const installed = parseLocalDate(poster && poster.installed_at);
  if (!installed) return null;
  const today = startOfToday();
  const dueDate = addMonths(installed, RENEWAL_DUE_MONTHS);
  const overdueDate = addMonths(installed, RENEWAL_OVERDUE_MONTHS);
  const days = Math.max(0, Math.floor((today - installed) / 86400000));

  if (today >= overdueDate) {
    return {
      level: 'overdue',
      label: '1年以上',
      message: `設置から${days}日。早めに張り替え確認`,
      dateLabel: `1年目安: ${formatDateJP(overdueDate)}`,
      days,
      dueDate,
      overdueDate,
    };
  }
  if (today >= dueDate) {
    return {
      level: 'due',
      label: '張替時期',
      message: `設置から${days}日。張り替え時期です`,
      dateLabel: `半年目安: ${formatDateJP(dueDate)}`,
      days,
      dueDate,
      overdueDate,
    };
  }
  return {
    level: 'ok',
    label: '張替前',
    message: `張り替え目安: ${formatDateJP(dueDate)}`,
    dateLabel: `半年目安: ${formatDateJP(dueDate)}`,
    days,
    dueDate,
    overdueDate,
  };
}

function getRenewalCounts() {
  return state.posters.reduce((counts, p) => {
    const info = getRenewalInfo(p);
    if (info && info.level === 'due') counts.due++;
    if (info && info.level === 'overdue') counts.overdue++;
    return counts;
  }, { due: 0, overdue: 0 });
}

function renewalBadgeHtml(poster, compact = false) {
  const info = getRenewalInfo(poster);
  if (!info || info.level === 'ok') return '';
  const text = compact ? info.label : `${info.label}: ${info.message}`;
  return `<span class="renewal-badge renewal-${info.level}">${escapeHtml(text)}</span>`;
}

function getPosterMarkerKey(poster) {
  return String((poster && poster.id) || `${poster && poster.address}|${poster && poster.lat}|${poster && poster.lng}`);
}

/* ============ Toast ============ */
function showToast(text, type = '') {
  const t = document.getElementById('toast');
  t.textContent = text;
  t.className = 'toast visible' + (type ? ' ' + type : '');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.remove('visible'), 3000);
}

/* ============ Apps Script API ============ */
async function api(action, payload, method = 'GET') {
  if (!settings.gasUrl) throw new Error('Apps Script URLが設定されていません');
  const url = new URL(settings.gasUrl);
  url.searchParams.set('action', action);

  const opts = {
    method,
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
  };
  if (method === 'POST' && payload) {
    opts.body = JSON.stringify(payload);
  } else if (method === 'GET' && payload) {
    Object.entries(payload).forEach(([k, v]) => url.searchParams.set(k, v));
  }

  const res = await fetch(url.toString(), opts);
  if (!res.ok) throw new Error('API ' + res.status);
  const data = await res.json();
  if (!data.success) throw new Error(data.error || 'API failed');
  return data.result;
}

async function fetchPosters() {
  const result = await api('list', null, 'GET');
  return result.items || [];
}

async function createPoster(obj) {
  obj.updated_by = settings.staffName;
  return api('create', obj, 'POST');
}

async function updatePoster(obj) {
  obj.updated_by = settings.staffName;
  return api('update', obj, 'POST');
}

async function deletePoster(id) {
  return api('delete', { id, updated_by: settings.staffName }, 'POST');
}

async function bulkImport(rows) {
  return api('bulk_import', { rows }, 'POST');
}

/* ============ 写真アップロード ============ */
async function uploadPhoto(file, posterId) {
  if (!settings.photoUrl) {
    throw new Error('写真アップロード未設定');
  }
  const url = settings.photoUrl.replace(/\/$/, '') + '/upload';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'image/jpeg',
      'X-Poster-Id': posterId || 'new',
    },
    body: file,
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error('Upload ' + res.status + ': ' + errText);
  }
  const data = await res.json();
  return data.url;
}

/* ============ レンダリング ============ */
function renderKPIs() {
  const total = state.posters.length;
  const done = state.posters.filter(p => p.status === '貼付済').length;
  const need = state.posters.filter(p => p.status === '要確認').length;
  const totalCount = state.posters.reduce((s, p) => s + (parseInt(p.count) || 0), 0);

  document.getElementById('kpiTotal').textContent = total.toLocaleString();
  document.getElementById('kpiTotalSub').textContent = '箇所';
  document.getElementById('kpiDone').textContent = done.toLocaleString();
  document.getElementById('kpiDoneSub').textContent = total > 0
    ? Math.round(done / total * 100) + '% 完了'
    : '—';
  document.getElementById('kpiNeed').textContent = need.toLocaleString();
  document.getElementById('kpiCount').textContent = totalCount.toLocaleString();

  document.getElementById('heroSub').textContent =
    `${total}箇所 · ${new Date().toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}更新`;
}

function renderStatusLegend() {
  const counts = {};
  STATUS_OPTIONS.forEach(s => { counts[s.key] = 0; });
  state.posters.forEach(p => {
    if (counts[p.status] !== undefined) counts[p.status]++;
  });

  const total = state.posters.length || 1;
  const max = Math.max(...Object.values(counts), 1);
  const wrap = document.getElementById('statusLegend');
  wrap.innerHTML = '';

  STATUS_OPTIONS.forEach(s => {
    const c = counts[s.key];
    if (c === 0 && s.key !== '貼付済') return;
    const pct = (c / total * 100).toFixed(1);
    const widthPct = c / max * 100;
    const row = document.createElement('div');
    row.className = 'legend-item';
    row.innerHTML =
      '<span class="legend-dot" style="background:' + s.color + '"></span>' +
      '<span class="legend-label">' + s.key + '</span>' +
      '<div class="legend-bar-wrap"><div class="legend-bar-fill" style="background:' + s.color + ';width:0%"></div></div>' +
      '<span class="legend-count">' + c + ' (' + pct + '%)</span>';
    wrap.appendChild(row);
    requestAnimationFrame(() => {
      row.querySelector('.legend-bar-fill').style.width = widthPct + '%';
    });
  });
}

function renderStaffRank() {
  const counts = {};
  state.posters.forEach(p => {
    const u = p.updated_by || '不明';
    counts[u] = (counts[u] || 0) + 1;
  });
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);

  const list = document.getElementById('staffRank');
  if (sorted.length === 0) {
    list.innerHTML = '<div class="result-empty">担当者データがありません</div>';
    return;
  }
  list.innerHTML = '';
  sorted.forEach(([name, count], i) => {
    const row = document.createElement('div');
    row.className = 'rank-row' + (i < 3 ? ' top3' : '');
    row.innerHTML =
      '<div class="rank-num">' + (i + 1) + '</div>' +
      '<div class="rank-name">' + escapeHtml(name) + '</div>' +
      '<div class="rank-count">' + count + '<span class="rank-count-unit">件</span></div>';
    list.appendChild(row);
  });
}

function renderRecentLog() {
  const list = document.getElementById('recentLog');
  const sorted = [...state.posters]
    .filter(p => p.updated_at)
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    .slice(0, 10);

  if (sorted.length === 0) {
    list.innerHTML = '<div class="result-empty">更新履歴がありません</div>';
    return;
  }
  list.innerHTML = '';
  sorted.forEach(p => {
    const row = document.createElement('div');
    row.className = 'log-row';
    const time = formatRelativeTime(p.updated_at);
    row.innerHTML =
      '<div class="log-meta">' +
        '<span>' + escapeHtml(p.updated_by || '—') + '</span>' +
        '<span>·</span>' +
        '<span>' + time + '</span>' +
      '</div>' +
      '<div class="log-text">' + escapeHtml(p.address || '—') + ' を「' + escapeHtml(p.status || '—') + '」に更新</div>';
    row.style.cursor = 'pointer';
    row.addEventListener('click', () => openSheet(p));
    list.appendChild(row);
  });
}

function formatRelativeTime(timestamp) {
  if (!timestamp) return '—';
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return String(timestamp);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'たった今';
  if (diff < 3600) return Math.floor(diff / 60) + '分前';
  if (diff < 86400) return Math.floor(diff / 3600) + '時間前';
  if (diff < 86400 * 7) return Math.floor(diff / 86400) + '日前';
  return d.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' });
}

/* ============ 一覧ビュー ============ */
function setupSwipeableItem(div, poster) {
  const content = div.querySelector('.result-item-content');
  const deleteBtn = div.querySelector('.result-item-delete');

  // 削除ボタンクリック
  deleteBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const name = poster.address || poster.provider_name || poster.id || 'このポスター';
    if (!confirm(`「${name}」を削除しますか?`)) {
      div.classList.remove('swiped');
      return;
    }
    try {
      await deletePoster(poster.id);
      showToast('削除しました', 'success');
      await reload();
    } catch (e) {
      showToast('削除失敗: ' + e.message, 'error');
      div.classList.remove('swiped');
    }
  });

  // タップで詳細を開く（スワイプ中じゃない時）
  content.addEventListener('click', (e) => {
    if (div.classList.contains('swiped')) {
      // 既にスワイプ中なら閉じるだけ
      div.classList.remove('swiped');
      return;
    }
    openSheet(poster);
  });

  // スワイプ検出
  let startX = 0;
  let currentX = 0;
  let dragging = false;

  content.addEventListener('touchstart', (e) => {
    startX = e.touches[0].clientX;
    currentX = startX;
    dragging = true;
  }, { passive: true });

  content.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    currentX = e.touches[0].clientX;
  }, { passive: true });

  content.addEventListener('touchend', () => {
    if (!dragging) return;
    dragging = false;
    const diff = currentX - startX;
    // 左に40px以上スワイプで削除ボタン表示
    if (diff < -40) {
      div.classList.add('swiped');
    } else if (diff > 40) {
      div.classList.remove('swiped');
    }
  });
}

function renderListView() {
  applyFilters();
  const list = document.getElementById('resultList');
  document.getElementById('listSub').textContent =
    state.filteredPosters.length + '件';

  if (state.filteredPosters.length === 0) {
    list.innerHTML = '<div class="result-empty">該当するポスターがありません</div>';
    return;
  }
  list.innerHTML = '';
  state.filteredPosters.slice(0, 200).forEach(p => {
    const status = STATUS_BY_KEY[p.status] || STATUS_OPTIONS[0];
    const displayName = p.address
      || p.provider_name
      || (p.notes ? String(p.notes).split('\n')[0].slice(0, 40) : '')
      || '名称未設定';
    const div = document.createElement('div');
    div.className = 'result-item';
    div.innerHTML =
      '<div class="result-item-actions">' +
        '<button class="result-item-delete" type="button">🗑 削除</button>' +
      '</div>' +
      '<div class="result-item-content">' +
        '<div class="result-item-row">' +
          '<div class="result-name">' + escapeHtml(displayName) + '</div>' +
          '<span class="status-badge ' + status.className + '">' + escapeHtml(p.status || '—') + '</span>' +
        '</div>' +
        '<div class="result-meta">' +
          (p.provider_name && p.provider_name !== displayName ? '<span>' + escapeHtml(p.provider_name) + '</span>' : '') +
          (p.count ? '<span>· ' + p.count + '枚</span>' : '') +
          (p.updated_by ? '<span>· ' + escapeHtml(p.updated_by) + '</span>' : '') +
        '</div>' +
        renewalBadgeHtml(p) +
      '</div>';
    setupSwipeableItem(div, p);
    list.appendChild(div);
  });
  if (state.filteredPosters.length > 200) {
    const more = document.createElement('div');
    more.className = 'result-empty';
    more.textContent = `上位200件まで表示（全${state.filteredPosters.length}件）`;
    list.appendChild(more);
  }
}

function renderFilterChips() {
  const wrap = document.getElementById('filterChips');
  const counts = { all: state.posters.length };
  const renewalCounts = getRenewalCounts();
  state.posters.forEach(p => {
    counts[p.status] = (counts[p.status] || 0) + 1;
  });
  wrap.innerHTML = '';

  const allBtn = document.createElement('button');
  allBtn.className = 'chip' + (state.statusFilter === 'all' ? ' active' : '');
  allBtn.innerHTML = '<span>すべて</span><span class="rank-count-unit">' + counts.all + '</span>';
  allBtn.addEventListener('click', () => {
    state.statusFilter = 'all';
    renderFilterChips();
    renderListView();
  });
  wrap.appendChild(allBtn);

  const dueBtn = document.createElement('button');
  dueBtn.className = 'chip chip-renewal-due' + (state.statusFilter === 'renewal_due' ? ' active' : '');
  dueBtn.innerHTML = '<span>張替時期</span><span class="rank-count-unit">' + renewalCounts.due + '</span>';
  dueBtn.addEventListener('click', () => {
    state.statusFilter = 'renewal_due';
    renderFilterChips();
    renderListView();
  });
  wrap.appendChild(dueBtn);

  const overdueBtn = document.createElement('button');
  overdueBtn.className = 'chip chip-renewal-overdue' + (state.statusFilter === 'renewal_overdue' ? ' active' : '');
  overdueBtn.innerHTML = '<span>1年以上</span><span class="rank-count-unit">' + renewalCounts.overdue + '</span>';
  overdueBtn.addEventListener('click', () => {
    state.statusFilter = 'renewal_overdue';
    renderFilterChips();
    renderListView();
  });
  wrap.appendChild(overdueBtn);

  STATUS_OPTIONS.forEach(s => {
    const c = counts[s.key] || 0;
    if (c === 0) return;
    const btn = document.createElement('button');
    btn.className = 'chip' + (state.statusFilter === s.key ? ' active' : '');
    btn.innerHTML =
      '<span class="chip-dot" style="background:' + s.color + '"></span>' +
      '<span>' + s.key + '</span>' +
      '<span class="rank-count-unit">' + c + '</span>';
    btn.addEventListener('click', () => {
      state.statusFilter = s.key;
      renderFilterChips();
      renderListView();
    });
    wrap.appendChild(btn);
  });
}

function applyFilters() {
  const q = state.searchQuery.toLowerCase().trim();
  state.filteredPosters = state.posters.filter(p => {
    if (state.statusFilter === 'renewal_due') {
      const info = getRenewalInfo(p);
      if (!info || info.level !== 'due') return false;
    } else if (state.statusFilter === 'renewal_overdue') {
      const info = getRenewalInfo(p);
      if (!info || info.level !== 'overdue') return false;
    } else if (state.statusFilter !== 'all' && p.status !== state.statusFilter) {
      return false;
    }
    if (q) {
      const hay = [p.address, p.provider_name, p.notes, p.updated_by, p.id]
        .filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/* ============ ナビURL構築ヘルパー ============ */
function buildNavUrl(p) {
  if (p.lat && p.lng) {
    return `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`;
  }
  const address = getPosterAddress(p);
  if (address) {
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`;
  }
  return null;
}

function getPosterAddress(p) {
  if (!p) return '';
  const address = String(p.address || '').trim();
  if (address) return address;
  const notes = String(p.notes || '').trim();
  if (!notes) return '';
  const match = notes.match(/(?:設置場所|住所|所在地)\s*[：:]\s*([^\n\r]+)/);
  if (match && match[1]) return match[1].trim();
  const firstLine = notes.split(/\r?\n/).map(s => s.trim()).find(Boolean);
  return firstLine && firstLine.length <= 40 ? firstLine : '';
}

function normalizeMapAddress(address) {
  const raw = String(address || '').trim();
  if (!raw) return '';
  if (raw.includes('千葉県') || raw.includes('船橋市')) return raw;
  return '千葉県船橋市' + raw;
}

function hasCoords(p) {
  const lat = parseFloat(p && p.lat);
  const lng = parseFloat(p && p.lng);
  return !isNaN(lat) && !isNaN(lng);
}

function mapFilterMatches(p, q) {
  if (!q) return true;
  const hay = [getPosterAddress(p), p.provider_name, p.notes, p.status, p.id]
    .filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q);
}

/* ============ 詳細・編集シート ============ */
function openSheet(poster) {
  state.selectedPoster = poster ? { ...poster } : { status: '貼付済', count: 1 };
  const isNew = !poster;
  const status = STATUS_BY_KEY[state.selectedPoster.status] || STATUS_OPTIONS[0];
  const photos = parsePhotoUrls(state.selectedPoster.photo_urls);
  const renewalInfo = getRenewalInfo(state.selectedPoster);
  const sheetTitle = isNew
    ? '新規追加'
    : (state.selectedPoster.address
      || state.selectedPoster.provider_name
      || (state.selectedPoster.notes ? String(state.selectedPoster.notes).split('\n')[0].slice(0, 40) : '')
      || 'ポスター詳細');

  const navUrl = buildNavUrl(state.selectedPoster);

  document.getElementById('sheetContent').innerHTML = `
    <div class="sheet-header">
      <div class="sheet-title">${escapeHtml(sheetTitle)}</div>
      ${!isNew ? `<div class="sheet-meta">
        <span class="status-badge ${status.className}">${escapeHtml(state.selectedPoster.status)}</span>
        ${state.selectedPoster.id ? `<span>${escapeHtml(state.selectedPoster.id)}</span>` : ''}
        ${state.selectedPoster.updated_at ? `<span>· ${formatRelativeTime(state.selectedPoster.updated_at)}</span>` : ''}
        ${renewalBadgeHtml(state.selectedPoster, true)}
      </div>` : ''}
    </div>
    <div class="sheet-body" id="sheetBody">
      <form id="posterForm">
        <div class="form-group">
          <label>ステータス</label>
          <div class="status-selector" id="statusSelector"></div>
        </div>

        <div class="form-group">
          <label>住所</label>
          <div style="display:flex;gap:6px;align-items:center">
            <input type="text" id="f_address" value="${escapeAttr(state.selectedPoster.address || '')}" placeholder="船橋市○○町X-Y-Z" style="flex:1">
            <button type="button" class="btn btn-secondary" id="btnOpenMap" style="flex:0 0 auto;width:auto">🗺️ 地図</button>
          </div>
          <small>「🗺️ 地図」をタップでGoogle Mapsナビ起動</small>
        </div>

        <div class="form-group">
          <label>緯度・経度</label>
          <div style="display:flex;gap:6px;align-items:center">
            <input type="text" id="f_coords" placeholder="35.6946, 139.9826" value="${state.selectedPoster.lat && state.selectedPoster.lng ? state.selectedPoster.lat + ', ' + state.selectedPoster.lng : ''}" style="flex:1">
            <button type="button" class="btn btn-secondary" id="btnUseLoc" style="flex:0 0 auto;width:auto">📍 現在地</button>
          </div>
          <small>地図ピン位置の精度向上に必要</small>
        </div>

        <div class="form-group">
          <label>氏名</label>
          <input type="text" id="f_provider" value="${escapeAttr(state.selectedPoster.provider_name || '')}" placeholder="山田太郎">
        </div>

        <div class="form-group">
          <label>連絡先</label>
          <input type="tel" id="f_phone" value="${escapeAttr(state.selectedPoster.phone || '')}" placeholder="090-xxxx-xxxx">
        </div>

        <div class="form-group">
          <label>枚数</label>
          <input type="number" id="f_count" value="${state.selectedPoster.count || 1}" min="1" max="99">
        </div>

        <div class="form-group">
          <label>設置日</label>
          <input type="date" id="f_installed" value="${escapeAttr(state.selectedPoster.installed_at || '')}">
          <div class="renewal-alert ${renewalInfo ? 'renewal-' + renewalInfo.level : ''}" id="renewalAlert">
            ${renewalInfo ? escapeHtml(renewalInfo.message) + '<br><span>' + escapeHtml(renewalInfo.dateLabel) + '</span>' : '設置日を入れると張り替え目安を表示します'}
          </div>
        </div>

        <div class="form-group">
          <label>備考</label>
          <textarea id="f_notes" rows="3" placeholder="設置場所の特徴、注意点など">${escapeHtml(state.selectedPoster.notes || '')}</textarea>
        </div>

        <div class="form-group">
          <label>写真</label>
          <input type="file" id="f_photo" accept="image/*" capture="environment" style="display:none">
          <button type="button" class="btn btn-secondary" id="btnAddPhoto" style="width:100%">📷 写真を撮影・選択</button>
          <div class="photo-gallery" id="photoGallery"></div>
        </div>
      </form>
    </div>
    <div class="sheet-footer">
      <div class="btn-row">
        <button type="button" class="btn btn-primary" id="btnSave">💾 ${isNew ? '追加' : '保存'}</button>
        ${navUrl ? `<a href="${navUrl}" target="_blank" rel="noopener" class="btn">ナビ</a>` : ''}
      </div>
      ${!isNew ? '<button type="button" class="btn btn-danger" id="btnDelete">🗑 削除する</button>' : ''}
    </div>
  `;

  // ステータスセレクター
  const sel = document.getElementById('statusSelector');
  STATUS_OPTIONS.forEach(s => {
    const opt = document.createElement('div');
    opt.className = 'status-option' + (s.key === state.selectedPoster.status ? ' selected' : '');
    opt.innerHTML = '<span class="legend-dot" style="background:' + s.color + '"></span><span>' + s.key + '</span>';
    opt.addEventListener('click', () => {
      state.selectedPoster.status = s.key;
      sel.querySelectorAll('.status-option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
    });
    sel.appendChild(opt);
  });

  // 写真ギャラリー
  renderPhotoGallery(photos);

  document.getElementById('f_installed').addEventListener('input', () => {
    state.selectedPoster.installed_at = document.getElementById('f_installed').value;
    const alert = document.getElementById('renewalAlert');
    const info = getRenewalInfo(state.selectedPoster);
    alert.className = 'renewal-alert ' + (info ? 'renewal-' + info.level : '');
    alert.innerHTML = info
      ? escapeHtml(info.message) + '<br><span>' + escapeHtml(info.dateLabel) + '</span>'
      : '設置日を入れると張り替え目安を表示します';
  });

  // 現在地ボタン
  document.getElementById('btnUseLoc').addEventListener('click', () => {
    showToast('位置情報を取得中…');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude.toFixed(6);
        const lng = pos.coords.longitude.toFixed(6);
        document.getElementById('f_coords').value = lat + ', ' + lng;
        showToast('位置情報を取得しました', 'success');
      },
      (err) => {
        showToast('位置情報の取得に失敗', 'error');
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  // 住所横の「🗺️ 地図」ボタン → Google Maps ナビ起動
  document.getElementById('btnOpenMap').addEventListener('click', () => {
    const addr = document.getElementById('f_address').value.trim();
    const coords = document.getElementById('f_coords').value.trim();
    let url = null;
    const m = coords.match(/^(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)$/);
    if (m) {
      url = `https://www.google.com/maps/dir/?api=1&destination=${m[1]},${m[2]}`;
    } else if (addr) {
      url = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(addr)}`;
    } else {
      showToast('住所か緯度経度を入力してください', 'error');
      return;
    }
    window.open(url, '_blank');
  });

  // 写真追加
  document.getElementById('btnAddPhoto').addEventListener('click', () => {
    document.getElementById('f_photo').click();
  });
  document.getElementById('f_photo').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    showToast(settings.photoUrl ? '写真をアップロード中…' : '写真を表示用に処理中…');
    try {
      let url = null;
      if (settings.photoUrl) {
        try {
          url = await uploadPhoto(file, state.selectedPoster.id || 'new');
        } catch (err) {
          showToast('アップロード失敗。端末内プレビューで追加します', 'error');
        }
      }
      if (!url) {
        const dataUrl = await resizePhotoForStorage(file);
        url = saveLocalPhoto(dataUrl);
      }
      const current = parsePhotoUrls(state.selectedPoster.photo_urls);
      current.push(url);
      state.selectedPoster.photo_urls = serializePhotoUrls(current);
      renderPhotoGallery(current);
      showToast(settings.photoUrl ? '写真を追加しました' : '写真を表示しました。保存で記録されます', 'success');
    } catch (err) {
      showToast('写真追加失敗: ' + err.message, 'error');
    }
    e.target.value = '';
  });

  // 削除
  if (!isNew) {
    document.getElementById('btnDelete').addEventListener('click', async () => {
      if (!confirm('このポスター情報を削除しますか?')) return;
      try {
        await deletePoster(state.selectedPoster.id);
        showToast('削除しました', 'success');
        closeSheet();
        await reload();
      } catch (e) {
        showToast('削除失敗: ' + e.message, 'error');
      }
    });
  }

  // フォーム送信
  document.getElementById('btnSave').addEventListener('click', async (e) => {
    e.preventDefault();
    const obj = collectFormData();
    try {
      showToast(isNew ? '追加中…' : '保存中…');
      if (isNew) {
        await createPoster(obj);
        showToast('追加しました', 'success');
      } else {
        await updatePoster(obj);
        showToast('保存しました', 'success');
      }
      closeSheet();
      await reload();
    } catch (e) {
      showToast('エラー: ' + e.message, 'error');
    }
  });

  document.getElementById('sheet').classList.add('visible');
  document.getElementById('sheetBackdrop').classList.add('visible');
}

function collectFormData() {
  const obj = {
    id: state.selectedPoster.id,
    status: state.selectedPoster.status,
    address: document.getElementById('f_address').value.trim(),
    provider_name: document.getElementById('f_provider').value.trim(),
    phone: document.getElementById('f_phone').value.trim(),
    count: parseInt(document.getElementById('f_count').value) || 1,
    installed_at: document.getElementById('f_installed').value,
    notes: document.getElementById('f_notes').value.trim(),
    photo_urls: serializePhotoUrls(parsePhotoUrls(state.selectedPoster.photo_urls)),
  };
  const coords = document.getElementById('f_coords').value.trim();
  if (coords) {
    const m = coords.match(/^(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)$/);
    if (m) {
      obj.lat = parseFloat(m[1]);
      obj.lng = parseFloat(m[2]);
    }
  }
  return obj;
}

function parsePhotoUrls(s) {
  if (!s) return [];
  const raw = String(s).trim();
  if (!raw) return [];
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(u => String(u).trim()).filter(Boolean);
    } catch (e) {}
  }
  if (raw.includes('\n')) {
    return raw.split('\n').map(u => u.trim()).filter(Boolean);
  }
  if (raw.startsWith('data:image/')) {
    return [raw];
  }
  return raw.split(',').map(u => u.trim()).filter(Boolean);
}

function serializePhotoUrls(urls) {
  const clean = (urls || []).map(u => String(u).trim()).filter(Boolean);
  return clean.length ? JSON.stringify(clean) : '';
}

function saveLocalPhoto(dataUrl) {
  const id = LOCAL_PHOTO_PREFIX + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  try {
    localStorage.setItem(LOCAL_PHOTO_STORAGE_PREFIX + id, dataUrl);
  } catch (e) {
    throw new Error('端末の写真保存容量が不足しています');
  }
  return id;
}

function resolvePhotoSrc(url) {
  if (!url) return '';
  if (String(url).startsWith(LOCAL_PHOTO_PREFIX)) {
    return localStorage.getItem(LOCAL_PHOTO_STORAGE_PREFIX + url) || '';
  }
  return url;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('写真を読み込めません'));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('画像を表示できません'));
    img.src = dataUrl;
  });
}

async function resizePhotoForStorage(file) {
  const dataUrl = await readFileAsDataUrl(file);
  const img = await loadImage(dataUrl);
  const maxSide = 900;
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', 0.68);
}

function renderPhotoGallery(photos) {
  const wrap = document.getElementById('photoGallery');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!photos.length) {
    wrap.innerHTML = '<div class="photo-empty">写真はまだありません</div>';
    return;
  }
  photos.forEach((url, i) => {
    const src = resolvePhotoSrc(url);
    if (!src) return;
    const thumb = document.createElement('figure');
    thumb.className = 'photo-card';
    thumb.innerHTML =
      '<img src="' + escapeAttr(src) + '" alt="ポスター写真">' +
      '<button type="button" class="photo-thumb-remove" aria-label="削除">×</button>';
    thumb.querySelector('img').addEventListener('click', () => openPhotoViewer(src));
    thumb.querySelector('.photo-thumb-remove').addEventListener('click', (e) => {
      if (e.target.classList.contains('photo-thumb-remove')) {
        e.stopPropagation();
        if (String(url).startsWith(LOCAL_PHOTO_PREFIX)) {
          try { localStorage.removeItem(LOCAL_PHOTO_STORAGE_PREFIX + url); } catch (err) {}
        }
        photos.splice(i, 1);
        state.selectedPoster.photo_urls = serializePhotoUrls(photos);
        renderPhotoGallery(photos);
      }
    });
    wrap.appendChild(thumb);
  });
  if (!wrap.children.length) {
    wrap.innerHTML = '<div class="photo-empty">この端末では写真を表示できません</div>';
  }
}

function openPhotoViewer(src) {
  let viewer = document.getElementById('photoViewer');
  if (!viewer) {
    viewer = document.createElement('div');
    viewer.id = 'photoViewer';
    viewer.className = 'photo-viewer';
    viewer.innerHTML =
      '<button type="button" class="photo-viewer-close" aria-label="写真を閉じる">×</button>' +
      '<div class="photo-viewer-stage">' +
        '<img alt="拡大写真">' +
      '</div>';
    document.body.appendChild(viewer);

    viewer.addEventListener('click', (e) => {
      if (e.target === viewer || e.target.classList.contains('photo-viewer-stage')) {
        closePhotoViewer();
      }
    });
    viewer.querySelector('.photo-viewer-close').addEventListener('click', closePhotoViewer);
    viewer.querySelector('img').addEventListener('click', (e) => {
      e.stopPropagation();
      e.currentTarget.classList.toggle('zoomed');
    });
  }

  const img = viewer.querySelector('img');
  img.classList.remove('zoomed');
  img.src = src;
  viewer.classList.add('visible');
  document.body.classList.add('photo-viewer-open');
}

function closePhotoViewer() {
  const viewer = document.getElementById('photoViewer');
  if (!viewer) return;
  viewer.classList.remove('visible');
  document.body.classList.remove('photo-viewer-open');
}

function closeSheet() {
  document.getElementById('sheet').classList.remove('visible');
  document.getElementById('sheetBackdrop').classList.remove('visible');
  state.selectedPoster = null;
}

/* ============ 検索 ============ */
function setupSearch() {
  const input = document.getElementById('searchInput');
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.searchQuery = input.value;
      renderListView();
    }, 200);
  });

  // 地図検索
  const mapInput = document.getElementById('mapSearchInput');
  let mapTimer;
  mapInput.addEventListener('input', () => {
    clearTimeout(mapTimer);
    mapTimer = setTimeout(() => buildMapMarkers(mapInput.value), 200);
  });
}

/* ============ CSV インポート ============ */
function setupCsvImport() {
  const input = document.getElementById('csvInput');
  document.getElementById('csvBtn').addEventListener('click', () => input.click());

  input.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const result = document.getElementById('csvResult');
    result.className = 'csv-result';
    result.textContent = 'パース中…';

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (parsed) => {
        if (parsed.errors.length > 0) {
          result.className = 'csv-result error';
          result.textContent = 'CSV解析エラー: ' + parsed.errors[0].message;
          return;
        }
        if (!parsed.data.length) {
          result.className = 'csv-result error';
          result.textContent = 'データが空です';
          return;
        }
        result.textContent = `${parsed.data.length}件をインポート中…`;
        try {
          const imp = await bulkImport(parsed.data);
          result.className = 'csv-result success';
          result.textContent = `✓ ${imp.imported}件追加${imp.errors && imp.errors.length ? ` (エラー${imp.errors.length}件)` : ''}`;
          await reload();
        } catch (e) {
          result.className = 'csv-result error';
          result.textContent = 'インポート失敗: ' + e.message;
        }
      },
      error: (err) => {
        result.className = 'csv-result error';
        result.textContent = 'CSV読込エラー: ' + err.message;
      }
    });
    input.value = '';
  });
}

/* ============ タブ切替 ============ */
function setupTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', async () => {
      const target = tab.dataset.view;
      document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === target));
      document.getElementById('fabAdd').style.display = target === 'mapView' ? 'none' : '';

      if (target === 'mapView' && state.posters.length === 0) {
        await reload();
      }

      if (target === 'mapView' && !state.initialMapBuilt) {
        initMap();
        state.initialMapBuilt = true;
      } else if (target === 'mapView' && state.map) {
        setTimeout(() => state.map.invalidateSize(), 100);
        buildMapMarkers(document.getElementById('mapSearchInput').value);
        // 検索入力が無ければ全ピンフィット
        if (!document.getElementById('mapSearchInput').value) {
          setTimeout(() => fitMapToMarkers(), 150);
        }
      } else if (target === 'listView') {
        renderFilterChips();
        renderListView();
      }
    });
  });
}

/* ============ 地図 ============ */
function initMap() {
  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const center = guessMapCenter();
  state.map = L.map('map', { zoomControl: false }).setView(center, 14);
  L.tileLayer(
    isDark
      ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
      : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    { attribution: '© OSM © CARTO', maxZoom: 19 }
  ).addTo(state.map);
  L.control.zoom({ position: 'bottomright' }).addTo(state.map);

  state.cluster = L.layerGroup();
  state.map.addLayer(state.cluster);

  buildMapMarkers('');
  fitMapToMarkers();
  setupMapPinRefresh();

  // 住所はあるが座標が無いものを自動ジオコーディング
  setTimeout(() => geocodePostersWithoutCoords(), 1000);
}

function readGeocodeCache() {
  try {
    return JSON.parse(localStorage.getItem('poster_geocode_v1') || '{}');
  } catch (e) {
    return {};
  }
}

function writeGeocodeCache(cache) {
  try { localStorage.setItem('poster_geocode_v1', JSON.stringify(cache)); } catch (e) {}
}

async function geocodePoster(p, cache = readGeocodeCache(), persist = true) {
  const posterAddress = getPosterAddress(p);
  if (!p || !posterAddress) return null;
  const cacheKey = normalizeMapAddress(posterAddress);
  let coords = cache[cacheKey] || cache[posterAddress];
  if (!coords) {
    const queries = [
      normalizeMapAddress(posterAddress),
      '千葉県 ' + normalizeMapAddress(posterAddress),
      posterAddress,
    ].filter((v, i, arr) => v && arr.indexOf(v) === i);

    for (const query of queries) {
      try {
        const url = 'https://nominatim.openstreetmap.org/search?q=' +
          encodeURIComponent(query) +
          '&format=json&limit=1&countrycodes=jp&accept-language=ja' +
          '&viewbox=139.85,35.85,140.15,35.55&bounded=1';
        const res = await fetch(url);
        if (!res.ok) continue;
        const data = await res.json();
        if (data && data[0]) {
          const lat = parseFloat(data[0].lat);
          const lon = parseFloat(data[0].lon);
          if (lat > 35.55 && lat < 35.85 && lon > 139.85 && lon < 140.15) {
            coords = { lat, lng: lon };
            cache[cacheKey] = coords;
            cache[posterAddress] = coords;
            break;
          }
        }
      } catch (e) {}
    }
  }

  if (!coords) return null;
  p.lat = coords.lat;
  p.lng = coords.lng;
  if (persist) {
    try { await updatePoster({ id: p.id, lat: coords.lat, lng: coords.lng }); } catch (e) {}
  }
  writeGeocodeCache(cache);
  return coords;
}

/* 住所はあるが lat/lng がないポスターを Nominatim で自動ジオコーディング */
async function geocodePostersWithoutCoords() {
  const cache = readGeocodeCache();

  const targets = state.posters.filter(p => {
    if (!getPosterAddress(p)) return false;
    if (hasCoords(p)) return false;
    return true;
  });
  if (targets.length === 0) return;

  state.mapGeocoding = true;
  state.mapGeocodeDone = 0;
  state.mapGeocodeTotal = targets.length;
  buildMapMarkers(document.getElementById('mapSearchInput').value || '');
  showToast(`${targets.length}件の住所からピンを作成中…`);

  let done = 0;
  for (const p of targets) {
    await geocodePoster(p, cache, true);
    done++;
    state.mapGeocodeDone = done;
    if (done % 5 === 0 || done === targets.length) {
      buildMapMarkers(document.getElementById('mapSearchInput').value || '');
      writeGeocodeCache(cache);
    }
    // Nominatim 利用規約（1秒あたり1リクエスト）
    await new Promise(r => setTimeout(r, 1100));
  }

  state.mapGeocoding = false;
  buildMapMarkers(document.getElementById('mapSearchInput').value || '');
  fitMapToMarkers();
  const withCoords = targets.filter(hasCoords).length;
  showToast(`${withCoords}件のピンを作成しました`, withCoords ? 'success' : 'error');
  writeGeocodeCache(cache);
}

/* 全ピンが入る範囲に地図を自動フィット */
function fitMapToMarkers() {
  if (!state.map) return;
  const withCoords = state.posters.filter(p => {
    const lat = parseFloat(p.lat), lng = parseFloat(p.lng);
    return !isNaN(lat) && !isNaN(lng);
  });
  if (withCoords.length === 0) return;
  if (withCoords.length === 1) {
    state.map.setView([parseFloat(withCoords[0].lat), parseFloat(withCoords[0].lng)], 16);
    return;
  }
  const bounds = L.latLngBounds(withCoords.map(p => [parseFloat(p.lat), parseFloat(p.lng)]));
  state.map.fitBounds(bounds, { padding: [50, 50], maxZoom: 16 });
}

function guessMapCenter() {
  const withCoords = state.posters.filter(p => p.lat && p.lng);
  if (withCoords.length === 0) return FALLBACK_CENTER;
  const lat = withCoords.reduce((s, p) => s + parseFloat(p.lat), 0) / withCoords.length;
  const lng = withCoords.reduce((s, p) => s + parseFloat(p.lng), 0) / withCoords.length;
  return [lat, lng];
}

function buildMapMarkers(query) {
  if (!state.cluster) return;
  state.cluster.clearLayers();
  state.mapMarkers = {};
  const q = (query || '').toLowerCase().trim();
  const allPosters = state.posters.filter(p => (getPosterAddress(p) || hasCoords(p)) && mapFilterMatches(p, q));
  const visiblePosters = [];

  allPosters.forEach(p => {
    const lat = parseFloat(p.lat), lng = parseFloat(p.lng);
    if (isNaN(lat) || isNaN(lng)) return;
    visiblePosters.push(p);
    const status = STATUS_BY_KEY[p.status] || STATUS_OPTIONS[0];
    const marker = L.marker([lat, lng], {
      icon: L.divIcon({
        className: '',
        html: '<div class="cust-marker ' + status.className + '"></div>',
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      })
    });
    marker.bindPopup(() => {
      const div = document.createElement('div');
      const navUrl = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
      const title = getPosterAddress(p) || p.provider_name || (p.notes ? String(p.notes).split('\n')[0].slice(0, 30) : '名称未設定');
      div.innerHTML =
        '<div style="font-weight:600;margin-bottom:4px;font-size:14px">' + escapeHtml(title) + '</div>' +
        '<div style="color:var(--text-2);font-size:13px;margin-bottom:10px">' +
          '<span class="status-badge ' + status.className + '" style="font-size:12px">' + escapeHtml(p.status) + '</span> ' +
          (p.count ? p.count + '枚' : '') +
          renewalBadgeHtml(p, true) +
        '</div>' +
        '<div style="display:flex;gap:6px">' +
          '<a href="' + navUrl + '" target="_blank" rel="noopener" style="flex:1;background:var(--primary);color:white;padding:8px 10px;border-radius:8px;text-align:center;font-size:13px;font-weight:600;text-decoration:none">ナビ</a>' +
          '<a class="popup-detail-link" style="flex:1;background:var(--bg-3);color:var(--text);padding:8px 10px;border-radius:8px;text-align:center;font-size:13px;font-weight:600;cursor:pointer">編集</a>' +
        '</div>';
      div.querySelector('.popup-detail-link').addEventListener('click', () => {
        state.map.closePopup();
        openSheet(p);
      });
      return div;
    });
    marker.bindTooltip(title, { direction: 'top', offset: [0, -8], opacity: 0.9 });
    state.mapMarkers[getPosterMarkerKey(p)] = marker;
    state.cluster.addLayer(marker);
  });
  renderMapPinList(allPosters, visiblePosters.length);
}

function renderMapPinList(posters, visibleCount = posters.length) {
  const wrap = document.getElementById('mapPinList');
  if (!wrap) return;
  const sorted = [...posters].sort((a, b) => String(getPosterAddress(a) || '').localeCompare(String(getPosterAddress(b) || ''), 'ja'));
  if (sorted.length === 0) {
    wrap.innerHTML =
      '<div class="map-pin-head"><strong>ピン一覧</strong><span>0件</span></div>' +
      '<div class="map-pin-empty">住所データがありません</div>';
    return;
  }
  wrap.innerHTML =
    '<div class="map-pin-head"><strong>ピン一覧</strong><span>' + visibleCount + '/' + sorted.length + '件</span></div>' +
    (state.mapGeocoding ? '<div class="map-pin-progress">住所からピン作成中 ' + state.mapGeocodeDone + '/' + state.mapGeocodeTotal + '</div>' : '') +
    '<div class="map-pin-scroll"></div>';
  const scroll = wrap.querySelector('.map-pin-scroll');
  sorted.forEach(p => {
    const status = STATUS_BY_KEY[p.status] || STATUS_OPTIONS[0];
    const title = getPosterAddress(p) || p.provider_name || p.id || '名称未設定';
    const coordsReady = hasCoords(p);
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'map-pin-item' + (coordsReady ? '' : ' pending');
    item.dataset.markerKey = getPosterMarkerKey(p);
    item.innerHTML =
      '<span class="chip-dot" style="background:' + status.color + '"></span>' +
      '<span class="map-pin-main">' +
        '<span class="map-pin-title">' + escapeHtml(title) + '</span>' +
        '<span class="map-pin-meta">' +
          escapeHtml(p.status || '—') +
          (p.count ? ' · ' + escapeHtml(p.count) + '枚' : '') +
          (p.provider_name ? ' · ' + escapeHtml(p.provider_name) : '') +
          (coordsReady ? '' : ' · ピン作成待ち') +
        '</span>' +
        renewalBadgeHtml(p, true) +
      '</span>';
    item.addEventListener('click', async () => {
      const marker = state.mapMarkers[item.dataset.markerKey];
      if (marker && state.map) {
        const ll = marker.getLatLng();
        state.map.setView(ll, Math.max(state.map.getZoom(), 17), { animate: true });
        marker.openPopup();
      } else {
        showToast('この住所のピンを作成中…');
        const coords = await geocodePoster(p);
        buildMapMarkers(document.getElementById('mapSearchInput').value || '');
        if (coords && state.map) {
          state.map.setView([coords.lat, coords.lng], 17, { animate: true });
          const newMarker = state.mapMarkers[getPosterMarkerKey(p)];
          if (newMarker) newMarker.openPopup();
          showToast('ピンを作成しました', 'success');
        } else {
          showToast('この住所はピン化できませんでした', 'error');
          openSheet(p);
        }
      }
    });
    scroll.appendChild(item);
  });
}

function setupMapPinRefresh() {
  const btn = document.getElementById('locateMeBtn');
  btn.addEventListener('click', async () => {
    if (state.mapGeocoding) {
      showToast('住所ピンを作成中です');
      return;
    }
    showToast('住所ピンを更新します');
    await geocodePostersWithoutCoords();
    buildMapMarkers(document.getElementById('mapSearchInput').value || '');
    fitMapToMarkers();
  });
}

/* ============ シート閉じる手段 ============ */
function setupSheetCloseHandlers() {
  document.getElementById('sheetBackdrop').addEventListener('click', closeSheet);
  document.getElementById('sheet').addEventListener('click', (e) => e.stopPropagation());
  document.getElementById('sheetClose').addEventListener('click', closeSheet);
  document.getElementById('sheetHandle').addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (document.getElementById('photoViewer')?.classList.contains('visible')) {
        closePhotoViewer();
      } else {
        closeSheet();
      }
    }
  });
}

/* ============ 設定モーダル ============ */
function setupSettingsModal() {
  document.getElementById('setupSave').addEventListener('click', () => {
    const name = document.getElementById('setupName').value.trim();
    const gas = document.getElementById('setupGasUrl').value.trim();
    const photo = document.getElementById('setupPhotoUrl').value.trim();
    if (!name) { showToast('スタッフ名を入力してください', 'error'); return; }
    if (!gas) { showToast('Apps Script URLを入力してください', 'error'); return; }
    settings.staffName = name;
    settings.gasUrl = gas;
    settings.photoUrl = photo;
    saveSettings();
    document.getElementById('setupModal').classList.add('hidden');
    document.getElementById('app').style.display = '';
    document.getElementById('tabbar').style.display = '';
    document.getElementById('fabAdd').style.display = '';
    bootstrap();
  });

  // 設定再表示
  document.getElementById('settingsBtn').addEventListener('click', showSettings);
}

function showSettings() {
  document.getElementById('setupName').value = settings.staffName;
  document.getElementById('setupGasUrl').value = settings.gasUrl;
  document.getElementById('setupPhotoUrl').value = settings.photoUrl;
  document.getElementById('setupModal').classList.remove('hidden');
}

/* ============ FAB（新規追加） ============ */
function setupFab() {
  document.getElementById('fabAdd').addEventListener('click', () => openSheet(null));
}

/* ============ 起動 ============ */
async function reload() {
  try {
    state.posters = await fetchPosters();
    document.getElementById('userPill').textContent = settings.staffName;
    document.getElementById('userPill2').textContent = settings.staffName;
    renderKPIs();
    renderStatusLegend();
    renderStaffRank();
    renderRecentLog();
    renderFilterChips();
    renderListView();
    if (state.initialMapBuilt) {
      buildMapMarkers(document.getElementById('mapSearchInput').value);
    }
  } catch (e) {
    showToast('データ取得失敗: ' + e.message, 'error');
    console.error(e);
  }
}

async function bootstrap() {
  // 共通ハンドラ
  setupSheetCloseHandlers();
  setupTabs();
  setupSearch();
  setupCsvImport();
  setupFab();

  // ライブラリロード待ち
  await new Promise(resolve => {
    if (window.L && window.Papa) return resolve();
    const check = setInterval(() => {
      if (window.L && window.Papa) {
        clearInterval(check);
        resolve();
      }
    }, 50);
  });

  await reload();
}

// 初期化
loadSettings();
setupSettingsModal();
if (settings.staffName && settings.gasUrl) {
  document.getElementById('setupModal').classList.add('hidden');
  document.getElementById('app').style.display = '';
  document.getElementById('tabbar').style.display = '';
  document.getElementById('fabAdd').style.display = '';
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
}

/* ============ ユーティリティ ============ */
function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s);
}
