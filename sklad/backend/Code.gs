/**
 * Учёт полуфабрикатов и товаров на удалённом складе — бэкенд.
 * Google Apps Script, привязанный к таблице Google Sheets (Расширения → Apps Script).
 *
 * Листы:  Справочник · Журнал · Остатки · Зоны · Пользователи · Аудит
 * API:    POST (Content-Type: text/plain, тело — JSON) на адрес веб-приложения.
 */

var VERSION = '1.0.0';

var SHEETS = {
  REF: 'Справочник', LOG: 'Журнал', STOCK: 'Остатки',
  ZONES: 'Зоны', USERS: 'Пользователи', AUDIT: 'Аудит'
};
var REF_HEAD   = ['Артикул', 'Наименование', 'Ед. изм.', 'QR-код', 'Мин', 'Макс', 'Категория'];
var LOG_HEAD   = ['ID', 'Дата', 'Автор', 'Артикул', 'Наименование', 'Тип', 'Направление', 'Вес', 'Зона', 'Документ', 'Изменение'];
var STOCK_FIX  = ['Артикул', 'Наименование', 'Количество на складе', 'Ед. изм.', 'Категория', 'Статус'];
var ZONES_HEAD = ['Зона', 'Ответственный'];
var USERS_HEAD = ['Логин', 'Имя', 'Хэш пароля', 'Соль', 'Роль'];
var AUDIT_HEAD = ['Время', 'Пользователь', 'Действие', 'Детали'];

var DIR_IN  = 'Производство→Склад';
var DIR_OUT = 'Склад→Производство';
var TYPE_MOVE = 'Перемещение';
var TYPE_INV  = 'Инвентаризация';

var TOKEN_TTL_MS = 12 * 3600 * 1000;
var MAX_LINES = 500;

/* ───────────── Меню и первичная настройка ───────────── */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Склад')
    .addItem('Настроить таблицу', 'setup')
    .addItem('Добавить / изменить пользователя', 'addUserDialog')
    .addItem('Пересчитать остатки из журнала', 'recalcStock')
    .addToUi();
}

function setup() {
  var book = ss_();
  ensureSheet_(book, SHEETS.REF, REF_HEAD);
  ensureSheet_(book, SHEETS.LOG, LOG_HEAD);
  ensureSheet_(book, SHEETS.ZONES, ZONES_HEAD);
  ensureSheet_(book, SHEETS.USERS, USERS_HEAD);
  ensureSheet_(book, SHEETS.AUDIT, AUDIT_HEAD);
  if (!book.getSheetByName(SHEETS.STOCK)) book.insertSheet(SHEETS.STOCK);

  // артикулы и документы — всегда текст
  sheet_(SHEETS.REF).getRange('A:A').setNumberFormat('@');
  sheet_(SHEETS.REF).getRange('D:D').setNumberFormat('@');
  sheet_(SHEETS.LOG).getRange('D:D').setNumberFormat('@');
  sheet_(SHEETS.LOG).getRange('J:J').setNumberFormat('@');
  sheet_(SHEETS.LOG).getRange('B:B').setNumberFormat('dd.MM.yyyy HH:mm:ss');
  sheet_(SHEETS.AUDIT).getRange('A:A').setNumberFormat('dd.MM.yyyy HH:mm:ss');

  var zones = sheet_(SHEETS.ZONES);
  if (zones.getLastRow() < 2) {
    zones.getRange(2, 1, 5, 2).setValues([
      ['Ларь №1', ''], ['Ларь №2', ''], ['Ларь №3', ''], ['Ларь №4', ''], ['Полка сухих продуктов', '']
    ]);
  }
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('SECRET')) props.setProperty('SECRET', Utilities.getUuid() + Utilities.getUuid());

  rebuildStock_(loadStock_(), getItems_(), getZones_());
  SpreadsheetApp.getUi().alert('Таблица настроена.\n\nДалее: добавьте пользователей (меню Склад) и опубликуйте скрипт как веб-приложение (Развёртывание → Новое развёртывание → Веб-приложение, доступ: все).');
}

function ensureSheet_(book, name, head) {
  var sh = book.getSheetByName(name) || book.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#e8f0e4');
    sh.setFrozenRows(1);
  }
  return sh;
}

function addUserDialog() {
  var ui = SpreadsheetApp.getUi();
  var l = ui.prompt('Логин (латиницей, без пробелов)'); if (l.getSelectedButton() !== ui.Button.OK) return;
  var n = ui.prompt('Имя для журнала (например: Иван П.)'); if (n.getSelectedButton() !== ui.Button.OK) return;
  var p = ui.prompt('Пароль (не короче 6 символов)'); if (p.getSelectedButton() !== ui.Button.OK) return;
  var r = ui.prompt('Роль: повар / кладовщик / админ'); if (r.getSelectedButton() !== ui.Button.OK) return;
  setUser_(l.getResponseText(), n.getResponseText(), p.getResponseText(), r.getResponseText());
  ui.alert('Пользователь сохранён.');
}

/* ───────────── Вспомогательное ───────────── */

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function sheet_(name) {
  var s = ss_().getSheetByName(name);
  if (!s) throw new Error('Нет листа «' + name + '». Запустите меню Склад → Настроить таблицу.');
  return s;
}

function num_(v) {
  if (v === '' || v === null || v === undefined) return null;
  var n = Number(String(v).replace(',', '.').replace(/\s/g, ''));
  return isFinite(n) ? n : null;
}
function round_(n) { return Math.round(n * 1000) / 1000; }
function str_(v) { return String(v === null || v === undefined ? '' : v).trim(); }
function cmp_(a, b) { return String(a).localeCompare(String(b), 'ru'); }
function fail_(msg, code) { var e = new Error(msg); e.code = code; return e; }

function readRows_(sh, ncols) {
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, ncols).getValues();
}

function getItems_() {
  var out = [];
  readRows_(sheet_(SHEETS.REF), REF_HEAD.length).forEach(function (r, i) {
    var art = str_(r[0]);
    if (!art) return;
    out.push({
      article: art, name: str_(r[1]), unit: str_(r[2]) || 'кг', qr: str_(r[3]),
      min: num_(r[4]), max: num_(r[5]), category: str_(r[6]), row: i + 2
    });
  });
  return out;
}

function getZones_() {
  return readRows_(sheet_(SHEETS.ZONES), 2)
    .filter(function (r) { return str_(r[0]) !== ''; })
    .map(function (r) { return { name: str_(r[0]), owner: str_(r[1]) }; });
}

function audit_(user, action, details) {
  sheet_(SHEETS.AUDIT).appendRow([new Date(), user, action, details || '']);
}

/* ───────────── Остатки ───────────── */

/** Читает лист «Остатки» в карту {артикул: {зона: количество}}. */
function loadStock_() {
  var sh = sheet_(SHEETS.STOCK);
  var last = sh.getLastRow(), cols = sh.getLastColumn(), map = {};
  if (last < 2 || cols <= STOCK_FIX.length) return map;
  var v = sh.getRange(1, 1, last, cols).getValues();
  var zones = v[0].slice(STOCK_FIX.length).map(String);
  for (var r = 1; r < v.length; r++) {
    var art = str_(v[r][0]);
    if (!art) continue;
    var z = {};
    for (var i = 0; i < zones.length; i++) {
      var q = num_(v[r][STOCK_FIX.length + i]);
      if (q) z[zones[i]] = q;
    }
    map[art] = z;
  }
  return map;
}

function totalOf_(z) {
  var t = 0;
  for (var k in z) t += z[k];
  return round_(t);
}

function statusOf_(total, it) {
  if (total < -0.0005) return 'Отрицательный остаток';
  if (it.min !== null && total < it.min) return 'Ниже минимума';
  if (it.max !== null && it.max > 0 && total > it.max) return 'Выше максимума';
  return '';
}

/** Полностью перезаписывает лист «Остатки»: группировка по категории, внутри — по алфавиту. */
function rebuildStock_(map, items, zones) {
  var sh = sheet_(SHEETS.STOCK);
  var names = zones.map(function (z) { return z.name; });
  Object.keys(map).forEach(function (a) {
    Object.keys(map[a]).forEach(function (n) { if (names.indexOf(n) < 0) names.push(n); });
  });
  var sorted = items.slice().sort(function (a, b) {
    return cmp_(a.category || 'яяя', b.category || 'яяя') || cmp_(a.name, b.name);
  });
  var rows = [], colors = [], prevCat = null, edges = [];
  sorted.forEach(function (it, i) {
    var z = map[it.article] || {}, total = 0;
    var zv = names.map(function (n) { var q = round_(z[n] || 0); total += q; return q; });
    total = round_(total);
    var st = statusOf_(total, it);
    rows.push([it.article, it.name, total, it.unit, it.category, st].concat(zv));
    colors.push([st === 'Ниже минимума' ? '#fde2c8' : st ? '#f8c9c9' : null]);
    if (it.category !== prevCat) { edges.push(i + 2); prevCat = it.category; }
  });
  var head = STOCK_FIX.concat(names);
  sh.clear();
  sh.getRange(1, 1, sh.getMaxRows(), 1).setNumberFormat('@');
  sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#e8f0e4');
  if (rows.length) {
    sh.getRange(2, 1, rows.length, head.length).setValues(rows);
    sh.getRange(2, 6, rows.length, 1).setBackgrounds(colors);
    edges.forEach(function (r) {
      sh.getRange(r, 1, 1, head.length).setBorder(true, null, null, null, null, null, '#6b8f5e', SpreadsheetApp.BorderStyle.SOLID);
    });
  }
  sh.setFrozenRows(1);
  sh.setFrozenColumns(2);
}

/** Публичный вид остатков для приложения. */
function stockPublic_(map) {
  var out = {};
  Object.keys(map).forEach(function (a) {
    var z = {};
    Object.keys(map[a]).forEach(function (n) { if (Math.abs(map[a][n]) > 0.0004) z[n] = round_(map[a][n]); });
    out[a] = { t: totalOf_(map[a]), z: z };
  });
  return out;
}

/** Пересчёт остатков с нуля из журнала (суммирование столбца «Изменение»). */
function recalcStock() {
  var rows = readRows_(sheet_(SHEETS.LOG), LOG_HEAD.length), map = {};
  rows.forEach(function (r) {
    var d = num_(r[10]), art = str_(r[3]), zone = str_(r[8]);
    if (!art || !zone || !d) return;
    map[art] = map[art] || {};
    map[art][zone] = round_((map[art][zone] || 0) + d);
  });
  rebuildStock_(map, getItems_(), getZones_());
  try { SpreadsheetApp.getUi().alert('Остатки пересчитаны из журнала.'); } catch (e) { /* не из меню */ }
  return map;
}

/* ───────────── Пользователи и токены ───────────── */

function hash_(salt, pass) {
  var h = salt + pass;
  for (var i = 0; i < 300; i++) {
    h = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + salt, Utilities.Charset.UTF_8));
  }
  return h;
}

function setUser_(login, name, pass, role) {
  login = str_(login).toLowerCase(); pass = String(pass || '');
  if (!/^[a-z0-9._-]{2,32}$/.test(login)) throw new Error('Логин: 2–32 символа, латиница, цифры, . _ -');
  if (pass.length < 6) throw new Error('Пароль слишком короткий');
  role = str_(role).toLowerCase();
  if (['повар', 'кладовщик', 'админ'].indexOf(role) < 0) role = 'повар';
  var sh = sheet_(SHEETS.USERS), salt = Utilities.getUuid().slice(0, 12);
  var row = [login, str_(name) || login, hash_(salt, pass), salt, role];
  var rows = readRows_(sh, 5);
  for (var i = 0; i < rows.length; i++) {
    if (str_(rows[i][0]).toLowerCase() === login) { sh.getRange(i + 2, 1, 1, 5).setValues([row]); return; }
  }
  sh.appendRow(row);
}

function findUser_(login) {
  login = str_(login).toLowerCase();
  var rows = readRows_(sheet_(SHEETS.USERS), 5);
  for (var i = 0; i < rows.length; i++) {
    if (str_(rows[i][0]).toLowerCase() === login) {
      return { login: login, name: str_(rows[i][1]), hash: str_(rows[i][2]), salt: str_(rows[i][3]), role: str_(rows[i][4]) };
    }
  }
  return null;
}

function b64w_(bytes) { return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, ''); }

function sign_(payload) {
  var secret = PropertiesService.getScriptProperties().getProperty('SECRET');
  if (!secret) throw new Error('Не выполнена настройка (меню Склад → Настроить таблицу).');
  return b64w_(Utilities.computeHmacSha256Signature(payload, secret));
}

function makeToken_(login) {
  var payload = login + '|' + (Date.now() + TOKEN_TTL_MS);
  return b64w_(Utilities.newBlob(payload).getBytes()) + '.' + sign_(payload);
}

function checkToken_(token) {
  var bad = fail_('Сессия истекла, войдите снова', 'AUTH');
  if (!token || String(token).indexOf('.') < 0) throw bad;
  var parts = String(token).split('.');
  var payload;
  try { payload = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0] + '==')).getDataAsString(); } catch (e) { throw bad; }
  if (sign_(payload) !== parts[1]) throw bad;
  var p = payload.split('|');
  if (Number(p[1]) < Date.now()) throw bad;
  var u = findUser_(p[0]);
  if (!u) throw bad;
  return u;
}

function login_(req) {
  var login = str_(req.login).toLowerCase();
  var cache = CacheService.getScriptCache(), key = 'fail:' + login;
  if (Number(cache.get(key) || 0) >= 5) throw new Error('Слишком много попыток. Подождите 10 минут.');
  var u = findUser_(login);
  if (!u || hash_(u.salt, String(req.password || '')) !== u.hash) {
    cache.put(key, String(Number(cache.get(key) || 0) + 1), 600);
    audit_(login || '?', 'Неудачный вход', '');
    throw new Error('Неверный логин или пароль');
  }
  cache.remove(key);
  audit_(u.login, 'Вход', '');
  return { ok: true, token: makeToken_(u.login), user: { login: u.login, name: u.name, role: u.role } };
}

/* ───────────── API ───────────── */

function doGet() {
  return json_({ ok: true, service: 'warehouse', version: VERSION });
}

function doPost(e) {
  var out;
  try {
    var req = JSON.parse(e.postData.contents);
    out = route_(req);
  } catch (err) {
    out = { ok: false, error: String(err.message || err), code: err.code || 'ERR' };
  }
  return json_(out);
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function route_(req) {
  if (req.action === 'login') return login_(req);
  var user = checkToken_(req.token);
  switch (req.action) {
    case 'bootstrap':      return bootstrap_(user);
    case 'submitDocument': return submitDocument_(req.doc, user);
    case 'addItem':        return addItem_(req, user);
    case 'bindQr':         return bindQr_(req, user);
    case 'recalc':
      if (user.role !== 'админ') throw new Error('Нет прав');
      return { ok: true, stock: stockPublic_(recalcStock()) };
    default: throw new Error('Неизвестное действие');
  }
}

function bootstrap_(user) {
  var items = getItems_().map(function (i) { delete i.row; return i; });
  return {
    ok: true, version: VERSION, time: Date.now(),
    user: { login: user.login, name: user.name, role: user.role },
    items: items, zones: getZones_(), stock: stockPublic_(loadStock_()),
    sheetUrl: ss_().getUrl()
  };
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/**
 * Документ перемещения или инвентаризации.
 * doc = { docId, type: 'move'|'inventory', direction: 'in'|'out', zone, apply, lines: [{article, qty}] }
 */
function submitDocument_(doc, user) {
  if (!doc || !doc.docId) throw new Error('Пустой документ');
  var type = doc.type;
  if (type !== 'move' && type !== 'inventory') throw new Error('Неизвестный тип документа');
  if (!doc.lines || !doc.lines.length) throw new Error('В документе нет позиций');
  if (doc.lines.length > MAX_LINES) throw new Error('Слишком много строк в документе (максимум ' + MAX_LINES + ')');

  return withLock_(function () {
    var log = sheet_(SHEETS.LOG);
    var docId = str_(doc.docId);

    // защита от повторной отправки (офлайн-очередь)
    var last = log.getLastRow();
    if (last >= 2) {
      var hit = log.getRange(2, 10, last - 1, 1).createTextFinder(docId).matchEntireCell(true).findNext();
      if (hit) return { ok: true, duplicate: true, warnings: [], stock: stockPublic_(loadStock_()) };
    }

    var zoneName = str_(doc.zone);
    var zones = getZones_();
    if (!zones.some(function (z) { return z.name === zoneName; })) throw new Error('Неизвестное место хранения: «' + zoneName + '»');

    var items = getItems_(), byArt = {};
    items.forEach(function (i) { byArt[i.article] = i; });
    var map = loadStock_();
    var warnings = [], rows = [], now = new Date();
    var nextId = last >= 2 ? (num_(log.getRange(last, 1).getValue()) || last - 1) + 1 : 1;

    function logRow(it, kind, dir, qty, delta) {
      rows.push([nextId++, now, user.name, it.article, it.name, kind, dir, qty, zoneName, docId, delta]);
    }
    function bump(art, delta) {
      map[art] = map[art] || {};
      map[art][zoneName] = round_((map[art][zoneName] || 0) + delta);
    }

    if (type === 'move') {
      if (doc.direction !== 'in' && doc.direction !== 'out') throw new Error('Не указано направление');
      var sign = doc.direction === 'in' ? 1 : -1;
      var dirLabel = doc.direction === 'in' ? DIR_IN : DIR_OUT;
      doc.lines.forEach(function (l) {
        var it = byArt[str_(l.article)];
        if (!it) throw new Error('Нет в справочнике: ' + l.article);
        var q = round_(Number(l.qty));
        if (!isFinite(q) || q <= 0) throw new Error('Некорректное количество: ' + it.name);
        bump(it.article, sign * q);
        logRow(it, TYPE_MOVE, dirLabel, q, sign * q);
        if (sign < 0 && map[it.article][zoneName] < -0.0005) {
          warnings.push('«' + it.name + '»: в «' + zoneName + '» остаток стал отрицательным (' + map[it.article][zoneName] + ' ' + it.unit + ')');
        }
      });
    } else {
      var agg = {}, order = [];
      doc.lines.forEach(function (l) {
        var it = byArt[str_(l.article)];
        if (!it) throw new Error('Нет в справочнике: ' + l.article);
        var q = Number(l.qty);
        if (!isFinite(q) || q < 0) throw new Error('Некорректное количество: ' + it.name);
        if (!(it.article in agg)) { agg[it.article] = 0; order.push(it); }
        agg[it.article] = round_(agg[it.article] + q);
      });
      order.forEach(function (it) {
        var fact = agg[it.article], plan = round_((map[it.article] || {})[zoneName] || 0);
        var delta = doc.apply ? round_(fact - plan) : 0;
        if (doc.apply) bump(it.article, delta);
        logRow(it, TYPE_INV, '', fact, delta);
      });
    }

    log.getRange(last + 1, 1, rows.length, LOG_HEAD.length).setValues(rows);
    rebuildStock_(map, items, zones);
    audit_(user.login, type === 'move' ? 'Перемещение' : 'Инвентаризация',
      docId + ' · ' + zoneName + ' · строк: ' + rows.length + (doc.apply ? ' · с корректировкой' : ''));
    return { ok: true, warnings: warnings, rows: rows.length, stock: stockPublic_(map) };
  });
}

function addItem_(req, user) {
  var name = str_(req.name).replace(/\s+/g, ' ');
  if (!name || name.length > 120) throw new Error('Укажите наименование (до 120 символов)');
  var unit = req.unit === 'шт' ? 'шт' : 'кг';
  var category = str_(req.category).slice(0, 60);
  var qr = str_(req.qr);
  return withLock_(function () {
    var items = getItems_(), maxN = 0;
    items.forEach(function (i) {
      if (i.name.toLowerCase() === name.toLowerCase()) throw new Error('Позиция «' + i.name + '» уже есть в справочнике');
      if (qr && i.qr === qr) throw new Error('Этот QR-код уже привязан к «' + i.name + '»');
      var m = /^Н-(\d+)$/.exec(i.article);
      if (m) maxN = Math.max(maxN, Number(m[1]));
    });
    var article = 'Н-' + ('0000' + (maxN + 1)).slice(-4);
    sheet_(SHEETS.REF).appendRow([article, name, unit, qr, '', '', category]);
    var item = { article: article, name: name, unit: unit, qr: qr, min: null, max: null, category: category };
    items.push(item);
    rebuildStock_(loadStock_(), items, getZones_());
    audit_(user.login, 'Новая позиция', article + ' · ' + name);
    return { ok: true, item: item };
  });
}

function bindQr_(req, user) {
  var art = str_(req.article), qr = str_(req.qr);
  return withLock_(function () {
    var items = getItems_(), target = null;
    items.forEach(function (i) {
      if (i.article === art) target = i;
      else if (qr && i.qr === qr) throw new Error('Этот QR-код уже привязан к «' + i.name + '»');
    });
    if (!target) throw new Error('Нет в справочнике: ' + art);
    sheet_(SHEETS.REF).getRange(target.row, 4).setNumberFormat('@').setValue(qr);
    audit_(user.login, 'Привязка QR', art + ' · ' + (qr || '(снят)'));
    return { ok: true, article: art, qr: qr };
  });
}
