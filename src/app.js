const DB_NAME = 'karada-note';
const DB_VERSION = 2;
const backupSettingKeys = ['thresholds', 'reminderEnabled', 'reminderTime', 'reminderSchedules'];
const $ = (selector) => document.querySelector(selector);
const dbPromise = new Promise((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = event => {
    const db = request.result;
    const upgradeTx = event.target.transaction;
    if (!db.objectStoreNames.contains('records')) {
      const store = db.createObjectStore('records', { keyPath: 'id', autoIncrement: true });
      store.createIndex('measuredAt', 'measuredAt');
    }
    if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
    const backupRecords = db.objectStoreNames.contains('backupRecords')
      ? upgradeTx.objectStore('backupRecords')
      : db.createObjectStore('backupRecords', { keyPath: 'id' });
    const backupSettings = db.objectStoreNames.contains('backupSettings')
      ? upgradeTx.objectStore('backupSettings')
      : db.createObjectStore('backupSettings', { keyPath: 'key' });
    const backupMeta = db.objectStoreNames.contains('backupMeta')
      ? upgradeTx.objectStore('backupMeta')
      : db.createObjectStore('backupMeta', { keyPath: 'key' });
    if (event.oldVersion < 2) {
      if (event.oldVersion > 0) backupMeta.put({ key: 'status', updatedAt: new Date().toISOString() });
      if (db.objectStoreNames.contains('records')) {
        const cursorRequest = upgradeTx.objectStore('records').openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          backupRecords.put(cursor.value);
          cursor.continue();
        };
      }
      const cursorRequest = upgradeTx.objectStore('settings').openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        if (backupSettingKeys.includes(cursor.value.key)) backupSettings.put(cursor.value);
        cursor.continue();
      };
    }
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function storeRequest(storeName, mode, action) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const request = action(tx.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
const getRecords = () => storeRequest('records', 'readonly', store => store.getAll());
const getLocalBackupRecords = () => storeRequest('backupRecords', 'readonly', store => store.getAll());
const getLocalBackupSettings = () => storeRequest('backupSettings', 'readonly', store => store.getAll());
const getLocalBackupStatus = () => storeRequest('backupMeta', 'readonly', store => store.get('status'));
async function replaceRecordsAndLocalBackup(records) {
  const db = await dbPromise;
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['records', 'backupRecords', 'backupMeta'], 'readwrite');
    const primary = tx.objectStore('records');
    const mirror = tx.objectStore('backupRecords');
    primary.clear(); mirror.clear();
    for (const record of records) {
      const request = record.id == null ? primary.add(record) : primary.put(record);
      request.onsuccess = () => mirror.put({ ...record, id: request.result });
    }
    tx.objectStore('backupMeta').put({ key: 'status', updatedAt: new Date().toISOString() });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('記録を反映できませんでした。'));
  });
}
async function restoreLocalBackup({ forgetPin = false } = {}) {
  const [status, records, backupSettings] = await Promise.all([getLocalBackupStatus(), getLocalBackupRecords(), getLocalBackupSettings()]);
  if (!status) return null;
  const settingsMap = new Map(backupSettings.map(setting => [setting.key, setting.value]));
  const db = await dbPromise;
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['records', 'settings'], 'readwrite');
    const recordStore = tx.objectStore('records');
    const settingStore = tx.objectStore('settings');
    recordStore.clear();
    records.forEach(record => recordStore.put(record));
    for (const key of backupSettingKeys) settingStore.delete(key);
    for (const [key, value] of settingsMap) settingStore.put({ key, value });
    if (forgetPin) { settingStore.delete('pinEnabled'); settingStore.delete('pinVerifier'); }
    settingStore.put({ key: 'hasDemoData', value: records.some(record => record.demo) });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('アプリ内バックアップを復元できませんでした。'));
  });
  return records.length;
}
async function getRecentRecords(limit = 6) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction('records', 'readonly');
    const request = tx.objectStore('records').index('measuredAt').openCursor(null, 'prev');
    const records = [];
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || records.length >= limit) { resolve(records); return; }
      records.push(cursor.value);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}
async function getRecordsInRange(start, end) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction('records', 'readonly');
    const range = IDBKeyRange.bound(start.toISOString(), end.toISOString());
    const request = tx.objectStore('records').index('measuredAt').openCursor(range, 'next');
    const records = [];
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { resolve(records); return; }
      records.push(cursor.value);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}
async function saveRecord(record) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['records', 'backupRecords', 'backupMeta'], 'readwrite');
    const request = tx.objectStore('records').add(record);
    request.onsuccess = () => {
      tx.objectStore('backupRecords').put({ ...record, id: request.result });
      tx.objectStore('backupMeta').put({ key: 'status', updatedAt: new Date().toISOString() });
    };
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('記録を保存できませんでした。'));
  });
}
async function deleteRecord(id) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['records', 'backupRecords', 'backupMeta'], 'readwrite');
    tx.objectStore('records').delete(id);
    tx.objectStore('backupRecords').delete(id);
    tx.objectStore('backupMeta').put({ key: 'status', updatedAt: new Date().toISOString() });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('記録を削除できませんでした。'));
  });
}
const getSetting = key => storeRequest('settings', 'readonly', store => store.get(key));
async function saveSetting(key, value) {
  if (!backupSettingKeys.includes(key)) return storeRequest('settings', 'readwrite', store => store.put({ key, value }));
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['settings', 'backupSettings', 'backupMeta'], 'readwrite');
    const entry = { key, value };
    tx.objectStore('settings').put(entry);
    tx.objectStore('backupSettings').put(entry);
    tx.objectStore('backupMeta').put({ key: 'status', updatedAt: new Date().toISOString() });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('設定を保存できませんでした。'));
  });
}

const PIN_ITERATIONS = 200000;
function toBase64(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))); }
function fromBase64(value) { return Uint8Array.from(atob(value), char => char.charCodeAt(0)); }
async function createPinVerifier(pin) {
  if (!crypto.subtle) throw new Error('この環境では暗証番号を安全に設定できません。HTTPSの公開版でご利用ください。');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: PIN_ITERATIONS, hash: 'SHA-256' }, key, 256);
  return { salt: toBase64(salt), hash: toBase64(derived), iterations: PIN_ITERATIONS };
}
async function verifyPin(pin, verifier) {
  if (!crypto.subtle || !verifier?.salt || !verifier?.hash) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const derived = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: fromBase64(verifier.salt), iterations: verifier.iterations || PIN_ITERATIONS, hash: 'SHA-256' }, key, 256));
  const expected = fromBase64(verifier.hash);
  return derived.length === expected.length && derived.every((byte, index) => byte === expected[index]);
}

const labels = { bp: '血圧', glucose: '血糖値', temperature: '体温' };
const slotLabels = { morning: '朝', noon: '昼', evening: '夕' };
function getTimeSlot(value) {
  const hour = new Date(value).getHours();
  if (hour >= 5 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 17) return 'noon';
  return 'evening';
}
const units = { glucose: 'mg/dL', temperature: '°C' };
let activeReminder = null;
let historyData = [];
let historyVisibleCount = 50;
let lastTouchZoomAt = 0;

function localDateTimeValue(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}
function formatDate(value) {
  return new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}
function recordValue(record) {
  if (record.kind === 'bp') return `${record.systolic} / ${record.diastolic} mmHg`;
  return `${record.value} ${units[record.kind]}`;
}
async function getThresholds() {
  const setting = await getSetting('thresholds');
  return setting?.value || {};
}
function isOutside(record, thresholds) {
  const test = (value, min, max) => (min !== '' && min != null && value < Number(min)) || (max !== '' && max != null && value > Number(max));
  if (record.kind === 'bp') return test(record.systolic, thresholds.sysMin, thresholds.sysMax) || test(record.diastolic, thresholds.diaMin, thresholds.diaMax);
  return test(record.value, thresholds[`${record.kind}Min`], thresholds[`${record.kind}Max`]);
}
async function renderRecords() {
  const records = await getRecentRecords(6);
  const thresholds = await getThresholds();
  const hasDemo = await getSetting('hasDemoData');
  $('#demo-banner').hidden = !Boolean(hasDemo?.value);
  const list = $('#recent-records');
  if (!records.length) {
    list.innerHTML = '<div class="empty-state"><span>▤</span><p>記録はまだありません</p><small>測定値を入力すると、ここに表示されます</small></div>';
    return;
  }
  list.replaceChildren();
  for (const record of records) {
    const outside = isOutside(record, thresholds);
    const row = document.createElement('article'); row.className = `record-row${outside ? ' record-outside' : ''}`;
    const dot = document.createElement('span'); dot.className = 'record-dot'; row.append(dot);
    const info = document.createElement('div'); info.className = 'record-info';
    const title = document.createElement('strong'); title.textContent = labels[record.kind] || '記録';
    if (record.demo) { const tag = document.createElement('em'); tag.className = 'sample-tag'; tag.textContent = 'サンプル'; title.append(' ', tag); }
    const slot = document.createElement('span'); slot.className = 'record-slot'; slot.textContent = slotLabels[getTimeSlot(record.measuredAt)];
    const date = document.createElement('span'); date.className = 'record-date';
    const parsedDate = new Date(record.measuredAt);
    date.textContent = `${Number.isNaN(parsedDate.getTime()) ? '日時不明' : formatDate(record.measuredAt)}${outside ? ' ・設定範囲外' : ''}`;
    info.append(title, slot, date); row.append(info);
    const value = document.createElement('span'); value.className = `record-value${outside ? ' outside-value' : ''}`; value.textContent = recordValue(record); row.append(value);
    const remove = document.createElement('button'); remove.className = 'record-delete'; remove.dataset.delete = String(record.id); remove.setAttribute('aria-label', 'この記録を削除'); remove.textContent = '×'; row.append(remove);
    list.append(row);
  }
  list.querySelectorAll('[data-delete]').forEach(button => button.addEventListener('click', async () => {
    if (confirm('この記録を削除しますか？')) { await deleteRecord(Number(button.dataset.delete)); await renderRecords(); }
  }));
}
function historyStart(period, now) {
  const start = new Date(now);
  if (period === '7' || period === '14') start.setDate(start.getDate() - Number(period));
  else {
    const months = Number(period.slice(0, -1));
    const day = start.getDate();
    start.setDate(1);
    start.setMonth(start.getMonth() - months);
    const lastDay = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
    start.setDate(Math.min(day, lastDay));
  }
  return start;
}
function svgElement(name, attrs = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}
function setChartZoom(card, zoomed = !card.classList.contains('chart-card-zoomed')) {
  document.querySelectorAll('.chart-card-zoomed').forEach(item => item.classList.remove('chart-card-zoomed'));
  card.classList.toggle('chart-card-zoomed', zoomed);
  document.body.classList.toggle('chart-zoom-open', zoomed);
}
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    const zoomed = document.querySelector('.chart-card-zoomed');
    if (zoomed) setChartZoom(zoomed, false);
  }
});
function appendChart(host, kind, records, scaleRecords, start, end, thresholds) {
  const card = document.createElement('article'); card.className = 'chart-card';
  const heading = document.createElement('div'); heading.className = 'chart-card-heading';
  const title = document.createElement('strong'); title.textContent = labels[kind]; heading.append(title);
  const unit = document.createElement('small'); unit.textContent = kind === 'bp' ? 'mmHg' : units[kind]; heading.append(unit);
  card.append(heading);
  const rows = records.filter(record => record.kind === kind).sort((a, b) => new Date(a.measuredAt) - new Date(b.measuredAt));
  if (!rows.length) { const empty = document.createElement('p'); empty.className = 'chart-empty'; empty.textContent = '選択期間内の記録はありません'; card.append(empty); host.append(card); return; }
  const measures = kind === 'bp'
    ? [{ key: 'systolic', label: '上', thresholdColor: '#d9796e' }, { key: 'diastolic', label: '下', thresholdColor: '#6687c8' }]
    : [{ key: 'value', label: labels[kind], thresholdColor: kind === 'glucose' ? '#c79437' : '#6687c8' }];
  const slotColors = { morning: '#2f765d', noon: '#3675b8', evening: '#c47a20' };
  const availableSlots = new Set(rows.map(record => getTimeSlot(record.measuredAt)));
  const series = ['morning', 'noon', 'evening'].filter(slot => availableSlots.has(slot)).flatMap(slot => measures.map(measure => ({
    ...measure, slot, color: slotColors[slot], label: `${slotLabels[slot]}${kind === 'bp' ? ` ${measure.label}` : ''}`
  })));
  const thresholdLines = [];
  for (const item of measures) {
    const prefix = kind === 'bp' ? (item.key === 'systolic' ? 'sys' : 'dia') : kind;
    for (const [bound, label] of [['Min', '下限'], ['Max', '上限']]) {
      const raw = thresholds[`${prefix}${bound}`];
      if (raw !== '' && raw != null && Number.isFinite(Number(raw))) thresholdLines.push({ value: Number(raw), label, series: item });
    }
  }
  const allValues = [...scaleRecords.filter(record => record.kind === kind).flatMap(record => series.map(item => Number(record[item.key]))), ...thresholdLines.map(line => line.value)].filter(Number.isFinite);
  const step = kind === 'temperature' ? 1 : 10;
  const rawMin = Math.min(...allValues), rawMax = Math.max(...allValues);
  const padding = Math.max(step * 0.5, (rawMax - rawMin) * 0.08);
  const min = Math.floor((rawMin - padding) / step) * step;
  const max = Math.ceil((rawMax + padding) / step) * step;
  const tickCount = Math.max(1, Math.round((max - min) / step));
  const left = 42, right = 348, top = 14;
  const chartHeight = Math.max(208, 46 + tickCount * 13);
  const bottom = chartHeight - 40;
  const svg = svgElement('svg', { viewBox: `0 0 360 ${chartHeight}`, role: 'img', 'aria-label': `${labels[kind]}の期間内グラフ。縦軸は${step}${kind === 'temperature' ? '度' : '単位'}刻み、下部に期間内の日付目盛り` });
  for (let i = 0; i <= tickCount; i++) {
    const value = max - i * step;
    const y = top + (bottom - top) * i / tickCount;
    svg.append(svgElement('line', { x1: left, x2: right, y1: y, y2: y, class: 'chart-gridline' }));
    const tick = svgElement('text', { x: 36, y: y + 3, 'text-anchor': 'end', class: 'chart-axis-label' });
    tick.textContent = kind === 'temperature' ? value.toFixed(0) : String(value); svg.append(tick);
  }
  const startTime = start.getTime(), endTime = end.getTime();
  for (const line of thresholdLines) {
    const y = bottom - (bottom - top) * (line.value - min) / (max - min);
    const zoneY = line.label === '上限' ? top : y;
    const zoneHeight = line.label === '上限' ? y - top : bottom - y;
    if (zoneHeight > 0) svg.append(svgElement('rect', { x: left, y: zoneY, width: right - left, height: zoneHeight, fill: line.series.thresholdColor || line.series.color, 'fill-opacity': '0.1', class: 'chart-outside-zone' }));
    const rule = svgElement('line', { x1: left, x2: right, y1: y, y2: y, class: 'chart-threshold', stroke: line.series.thresholdColor || line.series.color });
    const title = svgElement('title'); title.textContent = `${line.series.label} ${line.label}: ${line.value}`; rule.append(title); svg.append(rule);
  }
  const longPeriod = endTime - startTime >= 150 * 24 * 60 * 60 * 1000;
  for (let i = 0; i <= 4; i++) {
    const x = left + (right - left) * i / 4;
    svg.append(svgElement('line', { x1: x, x2: x, y1: top, y2: bottom, class: 'chart-date-grid' }));
    const tick = svgElement('text', { x, y: chartHeight - 12, 'text-anchor': i === 0 ? 'start' : i === 4 ? 'end' : 'middle', class: 'chart-date-label' });
    tick.textContent = new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric' }).format(new Date(startTime + (endTime - startTime) * i / 4));
    svg.append(tick);
  }
  const viewport = document.createElement('div'); viewport.className = 'chart-viewport'; viewport.append(svg); card.append(viewport);
  card.addEventListener('dblclick', event => {
    event.preventDefault();
    if (Date.now() - lastTouchZoomAt > 500) setChartZoom(card);
  });
  let touchStart = null, lastTapAt = 0;
  card.addEventListener('pointerdown', event => {
    if (event.pointerType === 'touch') touchStart = { x: event.clientX, y: event.clientY };
  });
  card.addEventListener('pointerup', event => {
    if (event.pointerType !== 'touch' || !touchStart) return;
    const moved = Math.hypot(event.clientX - touchStart.x, event.clientY - touchStart.y) > 12;
    touchStart = null;
    if (moved) { lastTapAt = 0; return; }
    const now = Date.now();
    if (now - lastTapAt <= 350) {
      lastTouchZoomAt = now; lastTapAt = 0; setChartZoom(card);
    } else lastTapAt = now;
  });
  card.setAttribute('title', 'グラフをダブルタップして拡大・縮小');
  const legend = document.createElement('div'); legend.className = 'chart-legend';
  for (const item of series) {
    const points = rows.filter(record => getTimeSlot(record.measuredAt) === item.slot).map(record => ({ x: new Date(record.measuredAt).getTime(), y: Number(record[item.key]) })).filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
    const stride = Math.max(1, Math.ceil(points.length / 220));
    const sampled = points.filter((_, index) => index % stride === 0 || index === points.length - 1);
    const coords = sampled.map(point => ({
      x: left + (right - left) * Math.max(0, Math.min(1, (point.x - startTime) / (endTime - startTime || 1))),
      y: bottom - (bottom - top) * (point.y - min) / (max - min)
    }));
    if (coords.length > 1) svg.append(svgElement('polyline', { points: coords.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' '), class: `chart-line${longPeriod ? ' chart-line-long' : ''}${kind === 'bp' && item.key === 'diastolic' ? ' chart-line-dashed' : ''}`, stroke: item.color }));
    for (const point of coords) svg.append(svgElement(kind === 'bp' && item.key === 'diastolic' ? 'rect' : 'circle', kind === 'bp' && item.key === 'diastolic' ? { x: point.x - 1, y: point.y - 1, width: 2, height: 2, fill: item.color } : { cx: point.x, cy: point.y, r: 1.4, fill: item.color }));
    const entry = document.createElement('span'); const marker = document.createElement('i'); marker.className = `chart-legend-mark${kind === 'bp' && item.key === 'diastolic' ? ' chart-legend-secondary' : ''}`; marker.style.backgroundColor = item.color; entry.append(marker, document.createTextNode(item.label)); legend.append(entry);
  }
  for (const line of thresholdLines) { const entry = document.createElement('span'); const marker = document.createElement('i'); marker.className = `chart-legend-line threshold-${kind === 'bp' ? line.series.key : kind}`; entry.append(marker, document.createTextNode(`${line.series.label} ${line.label} ${line.value}`)); legend.append(entry); }
  card.append(legend); host.append(card);
}
async function renderHistoryList() {
  const list = $('#history-records'); list.replaceChildren();
  const thresholds = await getThresholds();
  const visible = historyData.slice(0, historyVisibleCount);
  for (const record of visible) {
      const outside = isOutside(record, thresholds);
      const row = document.createElement('article'); row.className = `record-row${outside ? ' record-outside' : ''}`;
      const dot = document.createElement('span'); dot.className = 'record-dot'; row.append(dot);
      const info = document.createElement('div'); info.className = 'record-info';
      const title = document.createElement('strong'); title.textContent = labels[record.kind] || '記録';
      if (record.demo) { const tag = document.createElement('em'); tag.className = 'sample-tag'; tag.textContent = 'サンプル'; title.append(' ', tag); }
      const details = document.createElement('span'); details.className = 'record-date'; details.textContent = formatDate(record.measuredAt);
      const slot = document.createElement('span'); slot.className = 'record-slot'; slot.textContent = slotLabels[getTimeSlot(record.measuredAt)];
      info.append(title, slot, details);
      if (outside) { const status = document.createElement('span'); status.className = 'record-status'; status.textContent = '設定範囲外'; info.append(status); }
      row.append(info);
      const value = document.createElement('span'); value.className = `record-value${outside ? ' outside-value' : ''}`; value.textContent = recordValue(record); row.append(value);
      const remove = document.createElement('button'); remove.className = 'record-delete'; remove.textContent = '×'; remove.setAttribute('aria-label', 'この記録を削除');
      remove.addEventListener('click', async () => { if (confirm('この記録を削除しますか？')) { await deleteRecord(Number(record.id)); await renderRecords(); await renderHistory(); } });
      row.append(remove); list.append(row);
  }
  $('#history-more').hidden = historyVisibleCount >= historyData.length;
}
async function renderHistory() {
  const now = new Date();
  const start = historyStart($('#history-period').value, now);
  const metric = $('#history-metric').value;
  historyData = await getRecordsInRange(start, now);
  if (metric !== 'all') historyData = historyData.filter(record => record.kind === metric);
  historyData.sort((a, b) => new Date(b.measuredAt) - new Date(a.measuredAt));
  historyVisibleCount = 50;
  $('#history-count').textContent = `${historyData.length.toLocaleString('ja-JP')}件`;
  const charts = $('#history-charts'); charts.replaceChildren();
  const thresholds = await getThresholds();
  const chartKinds = metric === 'all' ? ['bp', 'glucose', 'temperature'] : [metric];
  for (const kind of chartKinds) appendChart(charts, kind, historyData, historyData, start, now, thresholds);
  await renderHistoryList();
}
function openEntry(kind) {
  $('#record-kind').value = kind;
  $('#entry-title').textContent = `${labels[kind]}を記録`;
  $('#systolic-field').hidden = kind !== 'bp';
  $('#diastolic-field').hidden = kind !== 'bp';
  $('#single-value-field').hidden = kind === 'bp';
  $('#single-label').textContent = kind === 'temperature' ? '体温' : '血糖値';
  $('#single-unit').textContent = units[kind] || '';
  $('#entry-form').reset();
  $('#measured-at').value = localDateTimeValue();
  $('#form-error').textContent = '';
  $('#entry-dialog').showModal();
}

document.querySelectorAll('[data-kind]').forEach(button => button.addEventListener('click', () => openEntry(button.dataset.kind)));
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $(`#${button.dataset.close}`).close()));
$('#entry-form').addEventListener('submit', async event => {
  event.preventDefault();
  const kind = $('#record-kind').value;
  const record = { kind, measuredAt: new Date($('#measured-at').value).toISOString(), createdAt: new Date().toISOString() };
  if (kind === 'bp') {
    record.systolic = Number($('#systolic').value);
    record.diastolic = Number($('#diastolic').value);
    if (!record.systolic || !record.diastolic) { $('#form-error').textContent = '上と下の血圧を入力してください。'; return; }
  } else {
    record.value = Number($('#single-value').value);
    if (!Number.isFinite(record.value)) { $('#form-error').textContent = '測定値を入力してください。'; return; }
  }
  await saveRecord(record);
  $('#entry-dialog').close();
  await renderRecords();
  if (!$('#history-page').hidden) await renderHistory();
});

const weekdayNames = ['日', '月', '火', '水', '木', '金', '土'];
async function getReminderSchedules() {
  const saved = await getSetting('reminderSchedules');
  if (Array.isArray(saved?.value)) return saved.value;
  const legacy = await getSetting('reminderTime');
  return [{ time: legacy?.value || '09:00', days: [0, 1, 2, 3, 4, 5, 6] }];
}
function renderReminderSchedules(schedules) {
  const host = $('#reminder-schedules'); host.replaceChildren();
  schedules.forEach((schedule, index) => {
    const card = document.createElement('fieldset'); card.className = 'reminder-schedule';
    const legend = document.createElement('legend'); legend.textContent = `お知らせ ${index + 1}`; card.append(legend);
    const timeLabel = document.createElement('label'); timeLabel.className = 'reminder-time-field';
    const timeTitle = document.createElement('span'); timeTitle.textContent = '時刻';
    const timeInput = document.createElement('input'); timeInput.type = 'time'; timeInput.required = true; timeInput.dataset.reminderTime = ''; timeInput.value = schedule.time || '09:00';
    timeLabel.append(timeTitle, timeInput); card.append(timeLabel);
    const days = document.createElement('div'); days.className = 'weekday-picker'; days.setAttribute('aria-label', `お知らせ${index + 1}の曜日`);
    weekdayNames.forEach((name, day) => {
      const label = document.createElement('label'); label.className = 'weekday-chip';
      const input = document.createElement('input'); input.type = 'checkbox'; input.value = String(day); input.checked = (schedule.days || []).includes(day);
      const text = document.createElement('span'); text.textContent = name; label.append(input, text); days.append(label);
    });
    card.append(days);
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove-reminder'; remove.dataset.removeReminder = String(index); remove.textContent = 'この時刻を削除'; card.append(remove);
    host.append(card);
  });
  $('#add-reminder-schedule').disabled = schedules.length >= 8;
}
function readReminderSchedules() {
  return [...$('#reminder-schedules').querySelectorAll('.reminder-schedule')].map(card => ({
    time: card.querySelector('[data-reminder-time]').value,
    days: [...card.querySelectorAll('.weekday-picker input:checked')].map(input => Number(input.value))
  }));
}
function reminderSummary(schedules) {
  if (!schedules.length) return '曜日・時刻を設定してお知らせ';
  return schedules.map(schedule => {
    const days = [...new Set(schedule.days)].sort((a, b) => a - b);
    return `${days.length === 7 ? '毎日' : days.length ? `${days.map(day => weekdayNames[day]).join('・')}曜日` : '曜日未選択'} ${schedule.time}`;
  }).join(' ／ ');
}
function nextReminderDate(schedules, now = new Date()) {
  let next = null;
  for (const schedule of schedules) {
    if (!/^\d{2}:\d{2}$/.test(schedule.time || '') || !schedule.days?.length) continue;
    const [hours, minutes] = schedule.time.split(':').map(Number);
    for (const day of schedule.days) {
      const candidate = new Date(now);
      candidate.setDate(candidate.getDate() + ((day - candidate.getDay() + 7) % 7));
      candidate.setHours(hours, minutes, 0, 0);
      if (candidate <= now) candidate.setDate(candidate.getDate() + 7);
      if (!next || candidate < next) next = candidate;
    }
  }
  return next;
}
function armReminder(schedules) {
  clearTimeout(activeReminder);
  const now = new Date();
  const target = nextReminderDate(schedules, now);
  if (!target) return;
  activeReminder = setTimeout(async () => {
    const permission = 'Notification' in window ? Notification.permission : 'unsupported';
    if (permission === 'granted' && 'serviceWorker' in navigator && navigator.serviceWorker.controller) {
      try { await navigator.serviceWorker.ready.then(registration => registration.showNotification('からだノート', { body: 'そろそろ計測の時間です。体調に合わせて測定してください。', icon: 'icons/icon-192-bleed.png' })); }
      catch { $('#notice-dialog').showModal(); }
    } else $('#notice-dialog').showModal();
    await saveSetting('lastReminderDate', new Date().toLocaleDateString('sv-SE'));
    armReminder(schedules);
  }, Math.max(0, target - now));
}
async function loadReminder() {
  const enabled = await getSetting('reminderEnabled');
  const schedules = await getReminderSchedules();
  $('#reminder-enabled').checked = Boolean(enabled?.value);
  renderReminderSchedules(schedules);
  $('#reminder-summary').textContent = enabled?.value ? reminderSummary(schedules) : '時刻を設定してお知らせ';
  if (enabled?.value) armReminder(schedules); else clearTimeout(activeReminder);
}
$('#reminder-button').addEventListener('click', async () => {
  const schedules = await getReminderSchedules();
  $('#reminder-error').textContent = '';
  renderReminderSchedules(schedules);
  $('#reminder-dialog').showModal();
});
$('#add-reminder-schedule').addEventListener('click', () => {
  const schedules = readReminderSchedules();
  if (schedules.length >= 8) return;
  const defaults = ['09:00', '12:00', '18:00', '08:00', '13:00', '19:00', '10:00', '20:00'];
  schedules.push({ time: defaults[schedules.length], days: [0, 1, 2, 3, 4, 5, 6] });
  renderReminderSchedules(schedules);
});
$('#reminder-schedules').addEventListener('click', event => {
  const button = event.target.closest('[data-remove-reminder]');
  if (!button) return;
  const schedules = readReminderSchedules(); schedules.splice(Number(button.dataset.removeReminder), 1); renderReminderSchedules(schedules);
});
$('#reminder-form').addEventListener('submit', async event => {
  event.preventDefault();
  const enabled = $('#reminder-enabled').checked;
  const schedules = readReminderSchedules();
  $('#reminder-error').textContent = '';
  if (enabled && (!schedules.length || schedules.some(schedule => !schedule.time || !schedule.days.length))) {
    $('#reminder-error').textContent = 'お知らせごとに時刻と曜日を1つ以上選んでください。'; return;
  }
  if (enabled && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
  await saveSetting('reminderEnabled', enabled);
  await saveSetting('reminderSchedules', schedules);
  $('#reminder-summary').textContent = enabled ? reminderSummary(schedules) : '時刻を設定してお知らせ';
  if (enabled) armReminder(schedules); else clearTimeout(activeReminder);
  $('#reminder-dialog').close();
});
$('#dismiss-notice').addEventListener('click', () => $('#notice-dialog').close());
$('#today-label').textContent = new Intl.DateTimeFormat('ja-JP', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date()) + '\n今日の体調を記録しましょう';
$('#today-label').classList.add('pre-line');
function showPage(page) {
  const history = page === 'history';
  $('#app').hidden = history;
  $('#history-page').hidden = !history;
  document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.page === (history ? 'history' : 'home')));
  if (history) renderHistory();
}
$('#all-records').addEventListener('click', () => showPage('history'));
$('#history-shortcut').addEventListener('click', () => showPage('history'));
$('#history-metric').addEventListener('change', renderHistory);
$('#history-period').addEventListener('change', renderHistory);
$('#history-more').addEventListener('click', async () => { historyVisibleCount += 50; await renderHistoryList(); });
$('#settings-button').addEventListener('click', openSettings);
async function openSettings() {
  const thresholds = await getThresholds();
  const fields = { 'bp-sys-min':'sysMin', 'bp-sys-max':'sysMax', 'bp-dia-min':'diaMin', 'bp-dia-max':'diaMax', 'glucose-min':'glucoseMin', 'glucose-max':'glucoseMax', 'temperature-min':'temperatureMin', 'temperature-max':'temperatureMax' };
  for (const [id, key] of Object.entries(fields)) $(`#${id}`).value = thresholds[key] ?? '';
  const lockEnabled = await getSetting('pinEnabled');
  $('#pin-enabled').checked = Boolean(lockEnabled?.value);
  $('#pin-status').textContent = `現在：${lockEnabled?.value ? 'ON' : 'OFF'}`;
  await updateLocalBackupStatus();
  $('#settings-dialog').showModal();
}
async function updateLocalBackupStatus() {
  const status = await getLocalBackupStatus();
  const target = $('#local-backup-status');
  if (!status) {
    target.textContent = 'アプリ内の自動バックアップはまだありません。測定記録や基準値を保存すると、この端末内に自動作成されます。';
    $('#restore-local-backup').disabled = true;
    return;
  }
  const date = status.updatedAt ? new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(status.updatedAt)) : '日時不明';
  target.textContent = `アプリ内バックアップ：自動保存済み（最終更新 ${date}）`;
  $('#restore-local-backup').disabled = false;
}
function openPinSetup() {
  $('#pin-new').value = '';
  $('#pin-confirm').value = '';
  for (const id of ['pin-new', 'pin-confirm']) { $(`#${id}`).type = 'password'; $(`[data-toggle-password="${id}"]`).textContent = '表示'; $(`[data-toggle-password="${id}"]`).setAttribute('aria-pressed', 'false'); }
  $('#pin-setup-error').textContent = '';
  $('#pin-setup-dialog').showModal();
}
document.querySelectorAll('[data-toggle-password]').forEach(button => button.addEventListener('click', () => {
  const input = $(`#${button.dataset.togglePassword}`);
  const reveal = input.type === 'password';
  input.type = reveal ? 'text' : 'password';
  button.textContent = reveal ? '隠す' : '表示';
  button.setAttribute('aria-pressed', String(reveal));
}));
$('#pin-enabled').addEventListener('change', async () => {
  if ($('#pin-enabled').checked) {
    const verifier = await getSetting('pinVerifier');
    if (!verifier?.value) { openPinSetup(); return; }
    await saveSetting('pinEnabled', true);
    $('#pin-status').textContent = '現在：ON';
  } else {
    await saveSetting('pinEnabled', false);
    $('#pin-status').textContent = '現在：OFF';
  }
});
$('#change-pin-button').addEventListener('click', openPinSetup);
$('#pin-setup-form').addEventListener('submit', async event => {
  event.preventDefault();
  const pin = $('#pin-new').value;
  if (!/^\d{4}$/.test(pin)) { $('#pin-setup-error').textContent = '半角数字4桁で入力してください。'; return; }
  if (pin !== $('#pin-confirm').value) { $('#pin-setup-error').textContent = '2つの暗証番号が一致しません。'; return; }
  try {
    const verifier = await createPinVerifier(pin);
    await saveSetting('pinVerifier', verifier);
    await saveSetting('pinEnabled', true);
    $('#pin-enabled').checked = true;
    $('#pin-status').textContent = '現在：ON';
    $('#pin-setup-dialog').close();
  } catch (error) {
    $('#pin-setup-error').textContent = error.message || '暗証番号を保存できませんでした。';
  }
});
$('#pin-setup-dialog').addEventListener('close', async () => {
  const enabled = await getSetting('pinEnabled');
  $('#pin-enabled').checked = Boolean(enabled?.value);
  $('#pin-status').textContent = `現在：${enabled?.value ? 'ON' : 'OFF'}`;
});
async function unlockApp() {
  document.body.classList.remove('startup-locked');
  const hasDemo = await getSetting('hasDemoData');
  if (!hasDemo) await saveSetting('hasDemoData', (await getRecords()).some(record => record.demo));
  await Promise.all([renderRecords(), loadReminder()]);
}
$('#pin-unlock-form').addEventListener('submit', async event => {
  event.preventDefault();
  const entry = $('#pin-entry');
  const verifier = await getSetting('pinVerifier');
  if (await verifyPin(entry.value, verifier?.value)) {
    $('#pin-unlock-dialog').close();
    await unlockApp();
    return;
  }
  entry.value = '';
  $('#pin-unlock-error').textContent = '暗証番号が違います。もう一度入力してください。';
  entry.focus();
});
async function bootApp() {
  const enabled = await getSetting('pinEnabled');
  if (enabled?.value) {
    $('#pin-unlock-dialog').showModal();
    $('#pin-entry').focus();
  } else await unlockApp();
}

$('#export-backup').addEventListener('click', async () => {
  const records = await getRecords();
  const settings = {};
  for (const key of backupSettingKeys) {
    const setting = await getSetting(key);
    if (setting) settings[key] = setting.value;
  }
  const backup = { app: DB_NAME, version: 1, exportedAt: new Date().toISOString(), records, settings };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `karada-note-backup-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  alert(`記録 ${records.length} 件を書き出しました。このファイルは暗号化されていません。端末故障・機種変更に備える場合は、端末外の安全な場所に保管してください。`);
});
$('#reset-app-data').addEventListener('click', async () => {
  const records = await getRecords();
  const message = `記録 ${records.length} 件、基準値・通知設定・PIN・アプリ内コピーをすべて削除します。端末外に書き出したバックアップファイルは削除されませんが、書き出していないデータは元に戻せません。初期化しますか？`;
  if (!confirm(message)) return;
  try {
    const db = await dbPromise;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['records', 'settings', 'backupRecords', 'backupSettings', 'backupMeta'], 'readwrite');
      for (const name of ['records', 'settings', 'backupRecords', 'backupSettings', 'backupMeta']) tx.objectStore(name).clear();
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('初期化を完了できませんでした。'));
    });
    location.reload();
  } catch (error) { alert(error.message || '初期化できませんでした。'); }
});
$('#restore-local-backup').addEventListener('click', async () => {
  const status = await getLocalBackupStatus();
  if (!status) { alert('アプリ内バックアップはまだありません。'); return; }
  if (!confirm('現在の記録と基準値・リマインダー設定を、同じ端末内の最新バックアップで置き換えます。PIN設定は維持されます。続けますか？')) return;
  try {
    const count = await restoreLocalBackup();
    await renderRecords();
    await loadReminder();
    await updateLocalBackupStatus();
    alert(`アプリ内バックアップから記録 ${count} 件を復元しました。`);
  } catch (error) { alert(error.message || 'アプリ内バックアップを復元できませんでした。'); }
});
$('#select-backup').addEventListener('click', () => $('#backup-file').click());
$('#backup-file').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  try {
    const backup = JSON.parse(await file.text());
    if (backup.app !== DB_NAME || backup.version !== 1 || !Array.isArray(backup.records) || !backup.settings || typeof backup.settings !== 'object') {
      throw new Error('このアプリのバックアップ形式ではありません。');
    }
    const records = backup.records.map(record => {
      if (!['bp', 'glucose', 'temperature'].includes(record.kind) || Number.isNaN(new Date(record.measuredAt).getTime())) throw new Error('記録データの形式が正しくありません。');
      const safe = { kind: record.kind, measuredAt: new Date(record.measuredAt).toISOString(), createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date().toISOString(), demo: Boolean(record.demo) };
      if (record.kind === 'bp') {
        if (!Number.isFinite(Number(record.systolic)) || !Number.isFinite(Number(record.diastolic))) throw new Error('血圧の記録形式が正しくありません。');
        safe.systolic = Number(record.systolic); safe.diastolic = Number(record.diastolic);
      } else {
        if (!Number.isFinite(Number(record.value))) throw new Error('測定値の形式が正しくありません。');
        safe.value = Number(record.value);
      }
      return safe;
    });
    if (!confirm(`バックアップの ${records.length} 件で、現在の記録を置き換えます。PIN設定は維持されます。続けますか？`)) return;
    await replaceRecordsAndLocalBackup(records);
    const db = await dbPromise;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['settings', 'backupSettings'], 'readwrite');
      const settingsStore = tx.objectStore('settings');
      const backupSettingsStore = tx.objectStore('backupSettings');
      backupSettingKeys.forEach(key => { settingsStore.delete(key); backupSettingsStore.delete(key); });
      for (const key of backupSettingKeys) if (Object.hasOwn(backup.settings, key)) {
        const entry = { key, value: backup.settings[key] };
        settingsStore.put(entry); backupSettingsStore.put(entry);
      }
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('復元を完了できませんでした。'));
    });
    await saveSetting('hasDemoData', records.some(record => record.demo));
    $('#settings-dialog').close();
    await renderRecords();
    await loadReminder();
    await updateLocalBackupStatus();
    alert(`バックアップから ${records.length} 件を復元しました。`);
  } catch (error) {
    alert(error.message || 'バックアップを読み込めませんでした。');
  }
});
$('#forgot-pin-button').addEventListener('click', async () => {
  const status = await getLocalBackupStatus();
  $('#reset-description').textContent = status
    ? 'アプリ内の自動保存コピーから記録と基準値・リマインダー設定を復元し、PINを解除します。端末故障やブラウザーデータ消去には備えられないため、端末外への書き出しもおすすめします。'
    : 'アプリ内バックアップがありません。PINを解除すると記録と設定は初期化され、バックアップファイルがなければ記録を戻せません。';
  $('#confirm-reset').textContent = status ? 'PINを解除して復元' : '記録を消去してPINを解除';
  $('#pin-unlock-dialog').close();
  $('#reset-dialog').showModal();
});
$('#reset-dialog').addEventListener('close', () => {
  if (document.body.classList.contains('startup-locked')) $('#pin-unlock-dialog').showModal();
});
$('#confirm-reset').addEventListener('click', async () => {
  try {
    const status = await getLocalBackupStatus();
    const confirmation = status
      ? 'アプリ内の自動保存コピーから記録と設定を戻し、PINを解除します。続けますか？'
      : 'アプリ内バックアップはありません。記録と設定を消去してPINを解除します。外部バックアップがなければ記録を復元できません。続けますか？';
    if (!confirm(confirmation)) return;
    const count = await restoreLocalBackup({ forgetPin: true });
    if (count === null) {
      const db = await dbPromise;
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['records', 'settings'], 'readwrite');
        tx.objectStore('records').clear();
        tx.objectStore('settings').clear();
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('初期化を完了できませんでした。'));
      });
    }
    location.reload();
  } catch (error) {
    alert(error.message || '初期化できませんでした。');
  }
});
$('#settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  const fields = { 'bp-sys-min':'sysMin', 'bp-sys-max':'sysMax', 'bp-dia-min':'diaMin', 'bp-dia-max':'diaMax', 'glucose-min':'glucoseMin', 'glucose-max':'glucoseMax', 'temperature-min':'temperatureMin', 'temperature-max':'temperatureMax' };
  const thresholds = {};
  for (const [id, key] of Object.entries(fields)) thresholds[key] = $(`#${id}`).value;
  await saveSetting('thresholds', thresholds);
  $('#settings-dialog').close();
  await renderRecords();
  if (!$('#history-page').hidden) await renderHistory();
});
$('#add-demo-data').addEventListener('click', async () => {
  const existing = await getRecords();
  if (existing.some(record => record.demo)) { alert('サンプルデータはすでに追加されています。'); return; }
  if (!confirm('約3か月分の架空のサンプル記録を追加します。よろしいですか？')) return;
  const db = await dbPromise;
  const tx = db.transaction(['records', 'backupRecords', 'backupMeta'], 'readwrite');
  const store = tx.objectStore('records');
  const backupStore = tx.objectStore('backupRecords');
  const now = new Date();
  for (let day = 89; day >= 0; day--) {
    const date = new Date(now); date.setDate(date.getDate() - day);
    const timeSlot = ['morning', 'noon', 'evening'][day % 3];
    date.setHours(timeSlot === 'morning' ? 7 : timeSlot === 'noon' ? 12 : 18, Math.floor(Math.random() * 60), 0, 0);
    const shift = Math.sin(day / 8) * 5;
    const bp = { kind: 'bp', systolic: Math.round(121 + shift + (Math.random() - .5) * 16), diastolic: Math.round(78 + shift * .45 + (Math.random() - .5) * 10), measuredAt: date.toISOString(), timeSlot, createdAt: date.toISOString(), demo: true };
    const bpRequest = store.add(bp); bpRequest.onsuccess = () => backupStore.put({ ...bp, id: bpRequest.result });
    const glucose = { kind: 'glucose', value: Math.round(105 + shift * 1.5 + (Math.random() - .5) * 35), measuredAt: date.toISOString(), timeSlot, createdAt: date.toISOString(), demo: true };
    const glucoseRequest = store.add(glucose); glucoseRequest.onsuccess = () => backupStore.put({ ...glucose, id: glucoseRequest.result });
    const temp = Math.round((36.5 + Math.sin(day / 9) * .16 + (Math.random() - .5) * .4) * 10) / 10;
    const temperature = { kind: 'temperature', value: temp, measuredAt: date.toISOString(), timeSlot, createdAt: date.toISOString(), demo: true };
    const tempRequest = store.add(temperature); tempRequest.onsuccess = () => backupStore.put({ ...temperature, id: tempRequest.result });
  }
  tx.objectStore('backupMeta').put({ key: 'status', updatedAt: new Date().toISOString() });
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  await saveSetting('hasDemoData', true);
  $('#settings-dialog').close();
  await renderRecords();
  alert('約3か月分のサンプルデータを追加しました。各記録に「サンプル」と表示されます。');
});
$('#remove-demo-data').addEventListener('click', async () => {
  const all = await getRecords();
  const demoIds = all.filter(record => record.demo).map(record => record.id);
  if (!demoIds.length) { alert('削除できるサンプルデータはありません。'); return; }
  if (!confirm(`サンプル記録 ${demoIds.length} 件を削除しますか？実際の記録は削除されません。`)) return;
  const db = await dbPromise;
  const tx = db.transaction(['records', 'backupRecords', 'backupMeta'], 'readwrite');
  const store = tx.objectStore('records');
  const backupStore = tx.objectStore('backupRecords');
  demoIds.forEach(id => { store.delete(id); backupStore.delete(id); });
  tx.objectStore('backupMeta').put({ key: 'status', updatedAt: new Date().toISOString() });
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  await saveSetting('hasDemoData', false);
  await renderRecords();
});
document.querySelectorAll('.nav-item').forEach(button => button.addEventListener('click', () => {
  if (button.dataset.page === 'settings') openSettings();
  else showPage(button.dataset.page);
}));

bootApp().catch(error => {
  console.error('アプリの起動に失敗しました', error);
  alert('アプリを起動できませんでした。ブラウザーの保存機能をご確認ください。');
});

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./service-worker.js').catch(error => console.error('オフライン対応の登録に失敗しました', error));
}
