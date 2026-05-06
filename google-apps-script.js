/**
 * ポスター管理 - Google Apps Script Web App
 *
 * 使い方:
 * 1. スプレッドシートを開く
 * 2. 拡張機能 > Apps Script
 * 3. このコードを貼り付け
 * 4. デプロイ > 新しいデプロイ
 *    - 種類: ウェブアプリ
 *    - 説明: poster-manager
 *    - 次のユーザーとして実行: 自分（オーナー）
 *    - アクセスできるユーザー: 全員
 * 5. URLをコピーしてフロントエンドに設定
 *
 * 認証は「公開URLを知っている人だけ」方式（簡易）
 * 書き込み時はスタッフ名（updated_by）を必須にする
 */

const SHEET_NAME = 'posters';
// 列の順序（spreadsheetの1行目と一致させる）
const COLUMNS = [
  'id', 'address', 'lat', 'lng', 'provider_name', 'phone',
  'count', 'status', 'installed_at', 'notes', 'photo_urls',
  'updated_at', 'updated_by'
];

function doGet(e) {
  return handleRequest(e, 'GET');
}

function doPost(e) {
  return handleRequest(e, 'POST');
}

function handleRequest(e, method) {
  try {
    const action = (e.parameter.action || '').toLowerCase();
    let result;

    if (method === 'GET') {
      if (action === 'list' || !action) {
        result = listAll();
      } else if (action === 'get') {
        result = getOne(e.parameter.id);
      } else {
        throw new Error('Unknown action: ' + action);
      }
    } else if (method === 'POST') {
      const payload = e.postData ? JSON.parse(e.postData.contents) : {};
      if (action === 'create') {
        result = createOne(payload);
      } else if (action === 'update') {
        result = updateOne(payload);
      } else if (action === 'delete') {
        result = deleteOne(payload.id);
      } else if (action === 'bulk_import') {
        result = bulkImport(payload.rows || []);
      } else {
        throw new Error('Unknown action: ' + action);
      }
    }

    return jsonResponse({ success: true, result });
  } catch (err) {
    return jsonResponse({ success: false, error: String(err) });
  }
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(COLUMNS);
    sheet.getRange(1, 1, 1, COLUMNS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function rowToObject(row, headers) {
  const obj = {};
  headers.forEach((h, i) => { obj[h] = row[i]; });
  return obj;
}

function objectToRow(obj, headers) {
  return headers.map(h => obj[h] !== undefined ? obj[h] : '');
}

function listAll() {
  const sheet = getSheet();
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return { items: [], total: 0 };
  const headers = data[0];
  const items = data.slice(1)
    .filter(row => row[0])  // idがある行のみ
    .map(row => rowToObject(row, headers));
  return { items, total: items.length };
}

function getOne(id) {
  const sheet = getSheet();
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const idCol = headers.indexOf('id');
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) === String(id)) {
      return rowToObject(data[i], headers);
    }
  }
  throw new Error('Not found: ' + id);
}

function generateId() {
  const sheet = getSheet();
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const idCol = headers.indexOf('id');
  let maxNum = 0;
  for (let i = 1; i < data.length; i++) {
    const id = String(data[i][idCol] || '');
    const m = id.match(/^P(\d+)$/);
    if (m) {
      const n = parseInt(m[1]);
      if (n > maxNum) maxNum = n;
    }
  }
  return 'P' + String(maxNum + 1).padStart(3, '0');
}

function nowJST() {
  const d = new Date();
  // JST形式 (ISO8601 + JST offset)
  const offset = 9 * 60;
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  const jst = new Date(utc + offset * 60000);
  const pad = (n) => String(n).padStart(2, '0');
  return jst.getFullYear() + '-' +
    pad(jst.getMonth() + 1) + '-' +
    pad(jst.getDate()) + 'T' +
    pad(jst.getHours()) + ':' +
    pad(jst.getMinutes()) + ':' +
    pad(jst.getSeconds()) + '+09:00';
}

function createOne(obj) {
  if (!obj.updated_by) throw new Error('updated_by is required');
  if (!obj.address) throw new Error('address is required');
  const sheet = getSheet();
  if (!obj.id) obj.id = generateId();
  obj.updated_at = nowJST();
  if (!obj.installed_at) obj.installed_at = obj.updated_at.split('T')[0];
  if (!obj.status) obj.status = '貼付済';
  if (!obj.count) obj.count = 1;
  const row = objectToRow(obj, COLUMNS);
  sheet.appendRow(row);
  return obj;
}

function updateOne(obj) {
  if (!obj.id) throw new Error('id is required');
  if (!obj.updated_by) throw new Error('updated_by is required');
  const sheet = getSheet();
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const idCol = headers.indexOf('id');
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) === String(obj.id)) {
      const current = rowToObject(data[i], headers);
      const merged = Object.assign({}, current, obj);
      merged.updated_at = nowJST();
      const row = objectToRow(merged, COLUMNS);
      sheet.getRange(i + 1, 1, 1, COLUMNS.length).setValues([row]);
      return merged;
    }
  }
  throw new Error('Not found: ' + obj.id);
}

function deleteOne(id) {
  if (!id) throw new Error('id is required');
  const sheet = getSheet();
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const idCol = headers.indexOf('id');
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) === String(id)) {
      sheet.deleteRow(i + 1);
      return { id, deleted: true };
    }
  }
  throw new Error('Not found: ' + id);
}

function bulkImport(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('rows array is required');
  }
  const sheet = getSheet();
  const now = nowJST();
  const results = { imported: 0, errors: [] };

  rows.forEach((obj, idx) => {
    try {
      if (!obj.address) throw new Error('address required');
      if (!obj.id) obj.id = generateId();
      obj.updated_at = obj.updated_at || now;
      if (!obj.updated_by) obj.updated_by = 'CSV Import';
      if (!obj.status) obj.status = '貼付済';
      if (!obj.count) obj.count = 1;
      const row = objectToRow(obj, COLUMNS);
      sheet.appendRow(row);
      results.imported++;
    } catch (e) {
      results.errors.push({ row: idx, error: String(e) });
    }
  });
  return results;
}

/* ============ ヘルパー ============
 * テスト用: スクリプトエディタで直接実行できる関数
 */
function testInit() {
  // シート初期化（ヘッダー行を作成）
  getSheet();
  Logger.log('Sheet initialized: ' + SHEET_NAME);
}

function testList() {
  const result = listAll();
  Logger.log(JSON.stringify(result, null, 2));
}
