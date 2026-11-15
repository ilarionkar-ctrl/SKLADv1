/* Склад: мобильное рабочее место — перемещения, инвентаризация, остатки, QR-коды. */
(function () {
  'use strict';

  /* ───────── утилиты ───────── */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var LS = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* нет места/запрещено */ } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { } }
  };
  var pad = function (n) { return ('0' + n).slice(-2); };
  var fmtDate = function (d) { d = d instanceof Date ? d : new Date(d); return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  var fmtQty = function (n) { return (Math.round(n * 1000) / 1000).toString().replace('.', ','); };
  var cmp = function (a, b) { return String(a).localeCompare(String(b), 'ru'); };
  var uid = function () { return 'D' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); };
  var DIR = { in: 'Производство → Склад', out: 'Склад → Производство' };

  /* ───────── состояние ───────── */
  var S = {
    url: (window.APP_CONFIG && window.APP_CONFIG.API_URL) || LS.get('url', ''),
    token: LS.get('token', ''), user: LS.get('user', null),
    items: [], zones: [], stock: {}, sheetUrl: '', synced: 0,
    queue: LS.get('queue', []),
    label: LS.get('label', { w: 58, h: 40 }),
    screen: 'login', doc: LS.get('draft', null), online: navigator.onLine,
    scanMode: 'doc', bindItem: null, err: ''
  };
  var cached = LS.get('cache', null);
  if (cached) { S.items = cached.items || []; S.zones = cached.zones || []; S.stock = cached.stock || {}; S.sheetUrl = cached.sheetUrl || ''; S.synced = cached.synced || 0; }
  var saveCache = function () { LS.set('cache', { items: S.items, zones: S.zones, stock: S.stock, sheetUrl: S.sheetUrl, synced: S.synced }); };
  var saveQueue = function () { LS.set('queue', S.queue); };
  var saveDraft = function () { S.doc ? LS.set('draft', S.doc) : LS.del('draft'); };
  var itemBy = function (article) { return S.items.filter(function (i) { return i.article === article; })[0]; };
  var stockOf = function (article, zone) { var s = S.stock[article]; if (!s) return 0; return zone ? (s.z[zone] || 0) : s.t; };

  /* ───────── сеть ───────── */
  function api(action, payload) {
    if (!S.url) return Promise.reject(new Error('Не указан адрес сервера'));
    var ctrl = new AbortController(), timer = setTimeout(function () { ctrl.abort(); }, 30000);
    var body = Object.assign({ action: action, token: S.token }, payload || {});
    return fetch(S.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), signal: ctrl.signal })
      .catch(function () { var e = new Error('Нет связи с сервером'); e.net = true; throw e; })
      .then(function (r) { return r.json().catch(function () { var e = new Error('Некорректный ответ сервера'); e.net = true; throw e; }); })
      .then(function (d) {
        if (!d.ok) { var e = new Error(d.error || 'Ошибка'); e.auth = d.code === 'AUTH'; throw e; }
        return d;
      })
      .finally(function () { clearTimeout(timer); });
  }

  function loadData() {
    return api('bootstrap').then(function (d) {
      S.items = d.items; S.zones = d.zones; S.stock = d.stock; S.sheetUrl = d.sheetUrl; S.synced = Date.now(); S.user = d.user;
      LS.set('user', S.user); saveCache(); return d;
    });
  }

  var syncing = null;
  /** Отправляет очередь документов. Возвращает {sent, warnings, errors}. */
  function syncQueue() {
    if (syncing) return syncing;
    var res = { sent: 0, warnings: [], errors: [] };
    syncing = (function next() {
      var d = S.queue.filter(function (x) { return !x.error; })[0];
      if (!d || !S.token) return Promise.resolve(res);
      return api('submitDocument', { doc: d }).then(function (r) {
        S.queue = S.queue.filter(function (x) { return x !== d; }); saveQueue();
        res.sent++; (r.warnings || []).forEach(function (w) { res.warnings.push(w); });
        if (r.stock) { S.stock = r.stock; S.synced = Date.now(); saveCache(); }
        return next();
      }).catch(function (e) {
        if (e.auth) { logout(true); return res; }
        if (!e.net) { d.error = e.message; saveQueue(); res.errors.push(e.message); return next(); }
        return res;
      });
    })().finally(function () { syncing = null; renderBadge(); });
    return syncing;
  }

  /* ───────── навигация / рендер ───────── */
  var app = $('#app');
  function go(screen, extra) {
    if (S.screen === 'scan' && screen !== 'scan') stopCamera();
    S.screen = screen; Object.assign(S, extra || {});
    S.err = '';
    render();
  }
  function render() {
    var v = { login: vLogin, menu: vMenu, setup: vSetup, scan: vScan, doc: vDoc, stock: vStock, qr: vQr, settings: vSettings }[S.screen];
    app.innerHTML = v();
    renderBadge();
    if (S.screen === 'scan') startCamera();
    window.scrollTo(0, 0);
  }
  function renderBadge() {
    var b = $('#badge'); if (!b) return;
    var q = S.queue.length, bad = S.queue.filter(function (x) { return x.error; }).length;
    b.className = 'badge' + (!S.online || q ? ' off' : '');
    b.textContent = !S.online ? 'Офлайн' + (q ? ' · ' + q : '') : q ? (bad ? 'Ошибок: ' + bad : 'В очереди: ' + q) : 'Онлайн';
  }
  function top(title, back) {
    return '<header class="top">' + (back ? '<button class="back" data-act="back" aria-label="Назад">‹</button>' : '') +
      '<h1>' + esc(title) + '</h1><span id="badge" class="badge"></span></header>';
  }
  var toastT;
  function toast(msg, bad) {
    var t = $('#toast'); t.textContent = msg; t.className = 'on' + (bad ? ' bad' : '');
    clearTimeout(toastT); toastT = setTimeout(function () { t.className = ''; }, bad ? 5000 : 2600);
  }
  function overlay(html) { var o = $('#ov'); o.innerHTML = '<div class="sheet">' + html + '</div>'; o.className = 'on'; return o; }
  function closeOverlay() { var o = $('#ov'); o.className = ''; o.innerHTML = ''; }
  function dialog(text, buttons) {
    return new Promise(function (resolve) {
      var o = overlay('<h2>' + esc(text.title) + '</h2><div>' + (text.html || esc(text.body || '')) + '</div>' +
        buttons.map(function (b, i) { return '<button class="btn ' + (b.cls || '') + '" data-dlg="' + i + '">' + esc(b.label) + '</button>'; }).join(''));
      o.onclick = function (e) {
        var i = e.target.closest('[data-dlg]'); if (!i) return;
        o.onclick = null; closeOverlay(); resolve(buttons[+i.dataset.dlg].value);
      };
    });
  }

  /* ───────── экраны ───────── */
  function vLogin() {
    return top('Склад') + '<main><div class="card" style="display:flex;flex-direction:column;gap:14px">' +
      '<h2>Вход</h2>' +
      (window.APP_CONFIG && window.APP_CONFIG.API_URL ? '' :
        '<label class="f">Адрес сервера (Apps Script)<input id="f-url" type="text" inputmode="url" autocapitalize="off" value="' + esc(S.url) + '" placeholder="https://script.google.com/macros/s/…/exec"></label>') +
      '<label class="f">Логин<input id="f-login" type="text" autocapitalize="off" autocomplete="username"></label>' +
      '<label class="f">Пароль<input id="f-pass" type="password" autocomplete="current-password"></label>' +
      (S.err ? '<div class="err">' + esc(S.err) + '</div>' : '') +
      '<button class="btn" data-act="login">Войти</button></div></main>';
  }

  function vMenu() {
    var q = S.queue.length;
    return top('Склад · ' + (S.user ? S.user.name : '')) + '<main>' +
      '<div class="tiles">' +
      '<button class="tile t1" data-act="start-move">Сканировать QR<small>Перемещение полуфабрикатов</small></button>' +
      '<button class="tile t2" data-act="start-inv">Инвентаризация<small>Подсчёт и Excel</small></button>' +
      '<button class="tile t3" data-act="stock">Остатки<small>' + (S.synced ? 'обновлено ' + fmtDate(S.synced) : 'нет данных') + '</small></button>' +
      '<button class="tile t5" data-act="qr">QR-коды<small>Привязка и печать</small></button>' +
      '<button class="tile t4" data-act="settings">Настройки<small>Очередь, этикетки</small></button></div>' +
      (S.doc ? '<button class="btn sec" data-act="resume">Продолжить черновик: ' + (S.doc.mode === 'move' ? 'перемещение' : 'инвентаризация') + ' (' + S.doc.lines.length + ')</button>' : '') +
      (q ? '<div class="card muted">Неотправленных документов: ' + q + '. Они уйдут автоматически при появлении связи.</div>' : '') +
      '</main>';
  }

  function zoneOptions(sel) {
    return '<option value="">— выберите —</option>' + S.zones.map(function (z) {
      return '<option value="' + esc(z.name) + '"' + (z.name === sel ? ' selected' : '') + '>' + esc(z.name) + '</option>';
    }).join('');
  }

  function vSetup() {
    var inv = S.setup.mode === 'inventory';
    return top(inv ? 'Инвентаризация' : 'Перемещение', true) + '<main><div class="card" style="display:flex;flex-direction:column;gap:14px">' +
      (inv ? '' : '<div class="seg"><button class="in' + (S.setup.direction === 'in' ? ' on' : '') + '" data-act="dir" data-v="in">Производство<br>→ Склад</button>' +
        '<button class="out' + (S.setup.direction === 'out' ? ' on' : '') + '" data-act="dir" data-v="out">Склад<br>→ Производство</button></div>') +
      '<label class="f">' + (inv ? 'Зона хранения' : 'Место хранения на складе') + '<select id="f-zone">' + zoneOptions(S.setup.zone) + '</select></label>' +
      '<div id="zone-owner" class="muted"></div>' +
      (inv ? '<label class="chk"><input type="checkbox" id="f-apply"' + (S.setup.apply ? ' checked' : '') + '> Скорректировать остатки по факту</label>' +
        '<div class="muted">Если включено, после отправки остаток в этой зоне станет равен подсчитанному. Если выключено — документ только фиксируется в журнале и Excel.</div>' : '') +
      (S.err ? '<div class="err">' + esc(S.err) + '</div>' : '') +
      '<button class="btn" data-act="begin">Начать сканирование</button></div></main>';
  }

  function vScan() {
    var d = S.doc, bind = S.scanMode === 'bind';
    var ctx = bind ? '<span class="pill">Привязка QR: ' + esc(S.bindItem.name) + '</span>' :
      (d.mode === 'move' ? '<span class="pill ' + d.direction + '">' + DIR[d.direction] + '</span>' : '<span class="pill">Инвентаризация</span>') +
      '<span class="pill">' + esc(d.zone) + '</span>';
    return top(bind ? 'Привязка QR' : 'Сканирование', true) + '<main>' +
      '<div class="ctx">' + ctx + '</div>' +
      '<div class="scan"><video id="cam" playsinline muted></video><div class="frame"></div><div class="hint">Наведите камеру на QR-код упаковки</div>' +
      '<button class="torch" id="torch" data-act="torch" hidden>Фонарик</button><div class="none" id="cam-none" hidden></div></div>' +
      '<form id="manual" class="row" style="gap:8px"><input type="text" id="f-code" placeholder="Код вручную" autocapitalize="off" autocomplete="off"><button class="btn sm" style="flex:none;width:auto">OK</button></form>' +
      (bind ? '' : '<div class="row"><button class="btn sec" data-act="search">Найти по названию</button>' +
        '<button class="btn" data-act="doc" id="docbtn">Документ (' + d.lines.length + ')</button></div>') +
      '</main>';
  }

  function totalsByUnit(lines) {
    var t = {};
    lines.forEach(function (l) { var it = itemBy(l.article); var u = it ? it.unit : ''; t[u] = (t[u] || 0) + l.qty; });
    return Object.keys(t).map(function (u) { return fmtQty(t[u]) + ' ' + u; }).join(' · ') || '—';
  }
  function expectedInZone(zone) {
    return S.items.filter(function (i) { return stockOf(i.article, zone) > 0.0004; }).sort(function (a, b) { return cmp(a.name, b.name); });
  }

  function vDoc() {
    var d = S.doc, inv = d.mode === 'inventory';
    var list = d.lines.map(function (l, i) {
      var it = itemBy(l.article) || { name: l.article, unit: '' };
      return '<div class="li"><div class="n"><b>' + esc(it.name) + '</b><span class="muted">' + esc(l.article) + ' · ' + fmtDate(l.at) + '</span></div>' +
        '<div class="q" data-act="edit-line" data-i="' + i + '">' + fmtQty(l.qty) + ' ' + esc(it.unit) + '</div>' +
        '<button class="x" data-act="del-line" data-i="' + i + '" aria-label="Удалить">×</button></div>';
    }).join('') || '<div class="muted">Позиций пока нет</div>';
    var prog = '';
    if (inv) {
      var exp = expectedInZone(d.zone), counted = {};
      d.lines.forEach(function (l) { counted[l.article] = 1; });
      var done = exp.filter(function (i) { return counted[i.article]; }).length;
      var left = exp.filter(function (i) { return !counted[i.article]; });
      var z = S.zones.filter(function (z) { return z.name === d.zone; })[0];
      prog = '<div class="card" style="display:flex;flex-direction:column;gap:8px"><b>Зона «' + esc(d.zone) + '»' + (z && z.owner ? ' · отв.: ' + esc(z.owner) : '') + '</b>' +
        '<div class="bar"><i style="width:' + (exp.length ? Math.round(done / exp.length * 100) : 100) + '%"></i></div>' +
        '<span class="muted">Посчитано ' + done + ' из ' + exp.length + ' позиций по учёту</span>' +
        (left.length ? '<details><summary class="muted">Не посчитано (' + left.length + ')</summary>' + left.map(function (i) { return '<div class="li"><div class="n">' + esc(i.name) + '</div><span class="muted">' + fmtQty(stockOf(i.article, d.zone)) + ' ' + esc(i.unit) + '</span></div>'; }).join('') + '</details>' : '') + '</div>';
    }
    return top('Документ', true) + '<main>' +
      '<div class="ctx">' + (inv ? '<span class="pill">Инвентаризация</span>' : '<span class="pill ' + d.direction + '">' + DIR[d.direction] + '</span>') + '<span class="pill">' + esc(d.zone) + '</span></div>' +
      prog + '<div class="card"><div class="list">' + list + '</div></div>' +
      '<div class="card"><b>Итого:</b> ' + totalsByUnit(d.lines) + '</div>' +
      '<div class="sticky"><button class="btn sec" data-act="scan-more">Сканировать ещё</button>' +
      '<button class="btn" data-act="send"' + (d.lines.length ? '' : ' disabled') + '>' + (inv ? 'Сформировать документ' : 'Отправить документ') + '</button>' +
      '<button class="btn danger" data-act="discard">Удалить черновик</button></div></main>';
  }

  function vStock() {
    var q = (S.q || '').toLowerCase();
    var items = S.items.filter(function (i) { return !q || i.name.toLowerCase().indexOf(q) >= 0 || i.article.toLowerCase().indexOf(q) >= 0; })
      .sort(function (a, b) { return cmp(a.category || 'яяя', b.category || 'яяя') || cmp(a.name, b.name); });
    var html = '', cat = null;
    items.forEach(function (i) {
      if (i.category !== cat) { cat = i.category; html += '<div class="grp">' + esc(cat || 'Без категории') + '</div>'; }
      var s = S.stock[i.article] || { t: 0, z: {} };
      var zs = Object.keys(s.z).sort(cmp).map(function (z) { return esc(z) + ': ' + fmtQty(s.z[z]); }).join(' · ');
      var tag = s.t < -0.0005 ? '<span class="tag bad">минус</span>' : i.min != null && s.t < i.min ? '<span class="tag warn">ниже мин.</span>' : i.max && s.t > i.max ? '<span class="tag warn">выше макс.</span>' : '';
      html += '<div class="li"><div class="n"><b>' + esc(i.name) + '</b><span class="muted">' + (zs || 'нет на складе') + '</span></div><div class="q">' + fmtQty(s.t) + ' ' + esc(i.unit) + '</div>' + tag + '</div>';
    });
    return top('Остатки', true) + '<main><input type="search" id="f-q" placeholder="Поиск" value="' + esc(S.q || '') + '">' +
      '<div class="row"><button class="btn sec sm" data-act="refresh">Обновить</button>' + (S.sheetUrl ? '<a class="btn sec sm" style="text-decoration:none" href="' + esc(S.sheetUrl) + '" target="_blank" rel="noopener">Google Sheets</a>' : '') + '</div>' +
      '<div class="card"><div class="list">' + (html || '<div class="muted">Ничего не найдено</div>') + '</div></div>' +
      '<div class="muted">Данные на ' + (S.synced ? fmtDate(S.synced) : '—') + '</div></main>';
  }

  function vQr() {
    var q = (S.q || '').toLowerCase();
    var items = S.items.filter(function (i) { return !q || i.name.toLowerCase().indexOf(q) >= 0; }).sort(function (a, b) { return cmp(a.name, b.name); });
    S.sel = S.sel || {};
    var html = items.map(function (i) {
      return '<div class="li"><input type="checkbox" class="selbox" data-a="' + esc(i.article) + '"' + (S.sel[i.article] ? ' checked' : '') + ' style="width:26px;height:26px">' +
        '<div class="n"><b>' + esc(i.name) + '</b><span class="muted">' + esc(i.article) + '</span></div>' +
        '<span class="tag ' + (i.qr ? 'ok' : '') + '">' + (i.qr ? 'QR ✓' : 'нет QR') + '</span>' +
        '<button class="btn sec sm" data-act="bind" data-a="' + esc(i.article) + '">Скан</button></div>';
    }).join('');
    return top('QR-коды', true) + '<main><input type="search" id="f-q" placeholder="Поиск" value="' + esc(S.q || '') + '">' +
      '<div class="card"><div class="list">' + (html || '<div class="muted">Справочник пуст</div>') + '</div></div>' +
      '<div class="sticky"><button class="btn" data-act="print">Печать выбранных этикеток</button></div></main>';
  }

  function vSettings() {
    var bad = S.queue.filter(function (x) { return x.error; });
    return top('Настройки', true) + '<main>' +
      '<div class="card" style="display:flex;flex-direction:column;gap:10px"><b>Очередь отправки</b>' +
      (S.queue.length ? S.queue.map(function (d, i) {
        return '<div class="li"><div class="n"><b>' + (d.type === 'move' ? 'Перемещение' : 'Инвентаризация') + ' · ' + d.lines.length + ' поз.</b><span class="muted">' + fmtDate(d.created) + ' · ' + esc(d.zone) + (d.error ? '<br><span class="err">' + esc(d.error) + '</span>' : '') + '</span></div>' +
          (d.error ? '<button class="btn sm danger" data-act="q-del" data-i="' + i + '">Удалить</button>' : '') + '</div>';
      }).join('') : '<span class="muted">Пусто</span>') +
      (S.queue.length ? '<button class="btn sec" data-act="q-retry">' + (bad.length ? 'Повторить отправку' : 'Отправить сейчас') + '</button>' : '') + '</div>' +
      '<div class="card" style="display:flex;flex-direction:column;gap:10px"><b>Этикетка, мм</b><div class="row">' +
      '<label class="f">Ширина<input type="number" id="f-lw" inputmode="numeric" value="' + S.label.w + '"></label>' +
      '<label class="f">Высота<input type="number" id="f-lh" inputmode="numeric" value="' + S.label.h + '"></label></div></div>' +
      (window.APP_CONFIG && window.APP_CONFIG.API_URL ? '' : '<div class="card"><label class="f">Адрес сервера<input id="f-url" type="text" value="' + esc(S.url) + '"></label></div>') +
      '<div class="muted">Пользователь: ' + esc(S.user ? S.user.name : '') + ' (' + esc(S.user ? S.user.role : '') + ')</div>' +
      '<button class="btn danger" data-act="logout">Выйти</button></main>';
  }

  /* ───────── авторизация ───────── */
  function logout(expired) {
    S.token = ''; S.user = null; LS.del('token'); LS.del('user');
    go('login', { err: expired ? 'Сессия истекла, войдите снова' : '' });
  }
  function doLogin() {
    var urlEl = $('#f-url'); if (urlEl) { S.url = urlEl.value.trim(); LS.set('url', S.url); }
    var l = $('#f-login').value.trim(), p = $('#f-pass').value;
    if (!l || !p) { S.err = 'Введите логин и пароль'; return render(); }
    var btn = $('[data-act=login]'); btn.disabled = true; btn.textContent = 'Входим…';
    api('login', { login: l, password: p }).then(function (r) {
      S.token = r.token; S.user = r.user; LS.set('token', S.token); LS.set('user', S.user);
      return loadData().catch(function () { }).then(function () { go('menu'); syncQueue(); });
    }).catch(function (e) { S.err = e.message; render(); });
  }

  /* ───────── камера и распознавание ───────── */
  var cam = { stream: null, det: null, run: false, last: '', lastT: 0, busy: false, timer: 0 };
  function startCamera() {
    stopCamera();
    var video = $('#cam'), none = $('#cam-none');
    var noCam = function (msg) { none.hidden = false; none.textContent = msg; };
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return noCam('Камера недоступна. Введите код вручную.');
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false }).then(function (stream) {
      if (S.screen !== 'scan') { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      cam.stream = stream; video.srcObject = stream;
      var track = stream.getVideoTracks()[0], caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.torch) { $('#torch').hidden = false; }
      return video.play().then(function () {
        if (!('BarcodeDetector' in window)) return noCam('Этот браузер не умеет читать QR. Откройте приложение в Chrome на Android или вводите код вручную.');
        var want = ['qr_code', 'ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a'];
        return (BarcodeDetector.getSupportedFormats ? BarcodeDetector.getSupportedFormats() : Promise.resolve(want)).then(function (sup) {
          cam.det = new BarcodeDetector({ formats: want.filter(function (f) { return sup.indexOf(f) >= 0; }) });
          cam.run = true; tick();
        });
      });
    }).catch(function (e) {
      noCam(e && e.name === 'NotAllowedError' ? 'Нет доступа к камере. Разрешите камеру в настройках сайта или введите код вручную.' : 'Не удалось запустить камеру. Введите код вручную.');
    });
  }
  function tick() {
    if (!cam.run) return;
    cam.timer = setTimeout(function () {
      var video = $('#cam');
      if (!cam.run || !video || cam.busy || video.readyState < 2) return tick();
      cam.busy = true;
      cam.det.detect(video).then(function (codes) {
        cam.busy = false;
        if (codes.length && cam.run) {
          var v = codes[0].rawValue;
          if (v && (v !== cam.last || Date.now() - cam.lastT > 2500)) {
            cam.last = v; cam.lastT = Date.now();
            if (navigator.vibrate) navigator.vibrate(60);
            cam.run = false; return onCode(v);
          }
        }
        tick();
      }).catch(function () { cam.busy = false; tick(); });
    }, 140);
  }
  function stopCamera() {
    cam.run = false; clearTimeout(cam.timer);
    if (cam.stream) { cam.stream.getTracks().forEach(function (t) { t.stop(); }); cam.stream = null; }
  }
  function resumeScan() { if (S.screen === 'scan' && cam.stream && cam.det) { cam.run = true; tick(); } }
  function toggleTorch() {
    var tr = cam.stream && cam.stream.getVideoTracks()[0]; if (!tr) return;
    cam.torchOn = !cam.torchOn; tr.applyConstraints({ advanced: [{ torch: cam.torchOn }] }).catch(function () { });
  }

  /* ───────── распознавание кода → позиция ───────── */
  function resolveCode(code) {
    code = String(code).trim(); if (!code) return null;
    var low = code.toLowerCase(), it;
    it = S.items.filter(function (i) { return i.qr && i.qr.toLowerCase() === low; })[0] || S.items.filter(function (i) { return i.article.toLowerCase() === low; })[0];
    if (it) return { item: it };
    if (/^2\d{12}$/.test(code)) { // весовой штрих-код EAN-13: 2 + PLU(5) + граммы(5) + контрольная
      var z0 = function (s) { return /^\d+$/.test(s) ? s.replace(/^0+/, '') : null; }, plu0 = z0(code.slice(1, 6));
      it = S.items.filter(function (i) { return z0(i.article) === plu0 || z0(i.qr) === plu0; })[0];
      if (it) return { item: it, qty: Math.round(Number(code.slice(6, 11))) / 1000 };
    }
    return null;
  }
  function onCode(code) {
    if (S.scanMode === 'bind') return bindScanned(code);
    var r = resolveCode(code);
    if (r) return lineForm(r.item, r.qty);
    unknownCode(code);
  }

  function unknownCode(code) {
    var o = overlay('<h2>Код не найден</h2><div class="muted" style="overflow-wrap:anywhere">' + esc(code) + '</div>' +
      '<button class="btn" data-u="bind">Привязать к позиции из справочника</button>' +
      '<button class="btn sec" data-u="new">Добавить как новую позицию</button>' +
      '<button class="btn danger" data-u="cancel">Отмена</button>');
    o.onclick = function (e) {
      var b = e.target.closest('[data-u]'); if (!b) return; o.onclick = null;
      if (b.dataset.u === 'cancel') { closeOverlay(); return resumeScan(); }
      if (b.dataset.u === 'bind') return pickItem('Привязать код к…', false, function (it) {
        api('bindQr', { article: it.article, qr: code }).then(function () { it.qr = code; saveCache(); toast('Код привязан'); lineForm(it); }).catch(function (e) { toast(e.message, true); resumeScan(); });
      }, resumeScan);
      newItemForm(code);
    };
  }

  function bindScanned(code) {
    var it = S.bindItem;
    api('bindQr', { article: it.article, qr: code.trim() }).then(function () {
      it.qr = code.trim(); saveCache(); toast('QR привязан: ' + it.name); go('qr');
    }).catch(function (e) { toast(e.message, true); resumeScan(); });
  }

  /* ───────── выбор позиции / новая позиция ───────── */
  function pickItem(title, allowNew, onPick, onCancel) {
    var o = overlay('<h2>' + esc(title) + '</h2><input type="search" id="pk-q" placeholder="Название или артикул"><div id="pk-list" class="card list"></div>' +
      (allowNew ? '<button class="btn sec" data-p="new">Добавить вручную</button>' : '') + '<button class="btn danger" data-p="cancel">Отмена</button>');
    var fill = function () {
      var q = $('#pk-q').value.toLowerCase();
      var arr = S.items.filter(function (i) { return !q || i.name.toLowerCase().indexOf(q) >= 0 || i.article.toLowerCase().indexOf(q) >= 0; }).sort(function (a, b) { return cmp(a.name, b.name); }).slice(0, 40);
      $('#pk-list').innerHTML = arr.map(function (i) { return '<div class="li" data-pick="' + esc(i.article) + '"><div class="n"><b>' + esc(i.name) + '</b><span class="muted">' + esc(i.article) + ' · ' + esc(i.unit) + '</span></div></div>'; }).join('') || '<div class="muted">Не найдено</div>';
    };
    fill(); $('#pk-q').oninput = fill;
    o.onclick = function (e) {
      var p = e.target.closest('[data-pick]'), b = e.target.closest('[data-p]');
      if (p) { o.onclick = null; closeOverlay(); return onPick(itemBy(p.dataset.pick)); }
      if (b && b.dataset.p === 'cancel') { o.onclick = null; closeOverlay(); if (onCancel) onCancel(); }
      if (b && b.dataset.p === 'new') { o.onclick = null; newItemForm(''); }
    };
  }

  function newItemForm(qr) {
    var cats = {}; S.items.forEach(function (i) { if (i.category) cats[i.category] = 1; });
    var o = overlay('<h2>Новая позиция</h2><label class="f">Наименование<input type="text" id="n-name" autocomplete="off"></label>' +
      '<label class="f">Единица<select id="n-unit"><option>кг</option><option>шт</option></select></label>' +
      '<label class="f">Категория<input type="text" id="n-cat" list="n-cats" autocomplete="off"></label><datalist id="n-cats">' + Object.keys(cats).sort(cmp).map(function (c) { return '<option value="' + esc(c) + '">'; }).join('') + '</datalist>' +
      (qr ? '<div class="muted">QR-код: ' + esc(qr) + '</div>' : '') + '<div class="err" id="n-err"></div>' +
      '<button class="btn" data-n="ok">Добавить в справочник</button><button class="btn danger" data-n="cancel">Отмена</button>');
    o.onclick = function (e) {
      var b = e.target.closest('[data-n]'); if (!b) return;
      if (b.dataset.n === 'cancel') { o.onclick = null; closeOverlay(); return resumeScan(); }
      var name = $('#n-name').value.trim(); if (!name) { $('#n-err').textContent = 'Введите наименование'; return; }
      b.disabled = true;
      api('addItem', { name: name, unit: $('#n-unit').value, category: $('#n-cat').value.trim(), qr: qr || '' }).then(function (r) {
        S.items.push(r.item); saveCache(); o.onclick = null; closeOverlay(); toast('Добавлено: ' + name);
        if (S.screen === 'scan') lineForm(r.item);
      }).catch(function (e) { b.disabled = false; $('#n-err').textContent = e.message; });
    };
  }

  /* ───────── форма строки + калькулятор ───────── */
  function evalExpr(s) {
    s = String(s).replace(/,/g, '.').replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-').replace(/\s/g, '');
    if (!s || !/^[0-9+\-*/.()]+$/.test(s)) return NaN;
    try { var v = Function('"use strict";return (' + s + ')')(); return typeof v === 'number' && isFinite(v) ? Math.round(v * 1000) / 1000 : NaN; } catch (e) { return NaN; }
  }

  function lineForm(item, presetQty, editIdx) {
    stopScanLoop();
    var d = S.doc, inv = d.mode === 'inventory';
    var plan = inv ? stockOf(item.article, d.zone) : null;
    var o = overlay('<h2>' + esc(item.name) + '</h2><div class="muted">' + esc(item.article) + (inv ? ' · по учёту в зоне: ' + fmtQty(plan) + ' ' + esc(item.unit) : (d.direction === 'out' ? ' · в зоне: ' + fmtQty(stockOf(item.article, d.zone)) + ' ' + esc(item.unit) : '')) + '</div>' +
      '<label class="f">' + (inv ? 'Фактическое количество' : 'Масса / количество') + ', ' + esc(item.unit) + '<input type="text" id="l-qty" inputmode="decimal" autocomplete="off" value="' + (presetQty != null ? fmtQty(presetQty) : '') + '" placeholder="0"></label>' +
      '<div id="l-hint" class="muted"></div>' +
      '<div class="keys" id="keys" hidden>' + ['7', '8', '9', '÷', '4', '5', '6', '×', '1', '2', '3', '−', '0', ',', '⌫', '+'].map(function (k) { return '<button data-k="' + k + '" class="' + (/[÷×−+]/.test(k) ? 'op' : '') + '">' + k + '</button>'; }).join('') +
      '<button data-k="C" class="op">C</button><button data-k="=" class="eq" style="grid-column:span 3">=</button></div>' +
      '<button class="btn sec" data-l="calc">Калькулятор</button>' +
      '<button class="btn" data-l="ok">' + (editIdx != null ? 'Сохранить' : 'Добавить в документ') + '</button><button class="btn danger" data-l="cancel">Отмена</button>');
    var inp = $('#l-qty'); if (presetQty == null) setTimeout(function () { inp.focus(); }, 60);
    var commit = function () {
      var raw = inp.value, v = /[+\-*/×÷−]/.test(raw.replace(/^-/, '')) ? evalExpr(raw) : evalExpr(raw.replace(/\s/g, ''));
      var minOk = inv ? v >= 0 : v > 0;
      if (!isFinite(v) || !minOk) { $('#l-hint').innerHTML = '<span class="err">Введите ' + (inv ? 'число 0 или больше' : 'число больше нуля') + '</span>'; return; }
      if (item.unit === 'шт' && Math.abs(v - Math.round(v)) > 1e-9) { $('#l-hint').innerHTML = '<span class="err">Штуки — целое число</span>'; return; }
      if (editIdx != null) d.lines[editIdx].qty = v; else d.lines.push({ article: item.article, qty: v, at: Date.now() });
      saveDraft(); o.onclick = null; closeOverlay();
      if (S.screen === 'doc') render(); else { var b = $('#docbtn'); if (b) b.textContent = 'Документ (' + d.lines.length + ')'; toast('Добавлено · ' + fmtQty(v) + ' ' + item.unit); resumeScan(); }
    };
    o.onclick = function (e) {
      var k = e.target.closest('[data-k]'), b = e.target.closest('[data-l]');
      if (k) {
        var key = k.dataset.k;
        if (key === 'C') inp.value = ''; else if (key === '⌫') inp.value = inp.value.slice(0, -1);
        else if (key === '=') { var r = evalExpr(inp.value); if (isFinite(r)) inp.value = fmtQty(r); else $('#l-hint').innerHTML = '<span class="err">Не удалось вычислить</span>'; }
        else inp.value += key;
      } else if (b) {
        if (b.dataset.l === 'calc') { var kk = $('#keys'); kk.hidden = !kk.hidden; inp.blur(); }
        else if (b.dataset.l === 'ok') commit();
        else { o.onclick = null; closeOverlay(); resumeScan(); }
      }
    };
    inp.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); commit(); } };
  }
  function stopScanLoop() { cam.run = false; clearTimeout(cam.timer); }

  /* ───────── отправка документа ───────── */
  function buildInventoryXlsx(d, lines) {
    var agg = {}; lines.forEach(function (l) { agg[l.article] = (agg[l.article] || 0) + l.qty; });
    var arr = Object.keys(agg).map(function (a) { var it = itemBy(a) || { name: a, unit: '' }; return { article: a, name: it.name, unit: it.unit, plan: stockOf(a, d.zone), fact: Math.round(agg[a] * 1000) / 1000 }; }).sort(function (a, b) { return cmp(a.name, b.name); });
    var z = S.zones.filter(function (z) { return z.name === d.zone; })[0];
    var rows = [[{ v: 'Инвентаризация склада', s: 1 }], ['Дата', fmtDate(Date.now())], ['Автор', S.user.name], ['Зона хранения', d.zone + (z && z.owner ? ' (отв.: ' + z.owner + ')' : '')], [],
      ['№', 'Артикул', 'Наименование', 'Ед. изм.', 'По учёту', 'Фактически', 'Расхождение'].map(function (h) { return { v: h, s: 2 }; })];
    arr.forEach(function (r, i) { rows.push([i + 1, r.article, r.name, r.unit, { v: r.plan, s: 3 }, { v: r.fact, s: 3 }, { v: Math.round((r.fact - r.plan) * 1000) / 1000, s: 3 }]); });
    return makeXlsx({ name: 'Инвентаризация', rows: rows, widths: [5, 12, 42, 10, 12, 12, 14] });
  }
  function translit(str) {
    var m = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', '№': 'N' };
    return String(str).replace(/./g, function (c) { var l = c.toLowerCase(), r = m[l]; return r === undefined ? c : (c !== l ? r.charAt(0).toUpperCase() + r.slice(1) : r); });
  }
  function download(blob, name) {
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }

  function sendDoc() {
    var d = S.doc; if (!d || !d.lines.length) return;
    var go2 = function (lines) {
      if (d.mode === 'inventory') {
        var t = new Date();
        download(buildInventoryXlsx(d, lines), 'Inventarizatsiya_' + translit(d.zone).replace(/[^\w]+/g, '_').replace(/^_|_$/g, '') + '_' + t.getFullYear() + pad(t.getMonth() + 1) + pad(t.getDate()) + '_' + pad(t.getHours()) + pad(t.getMinutes()) + '.xlsx');
      }
      S.queue.push({ docId: d.id, type: d.mode, direction: d.direction || null, zone: d.zone, apply: !!d.apply, created: Date.now(), lines: lines.map(function (l) { return { article: l.article, qty: l.qty }; }) });
      saveQueue(); S.doc = null; saveDraft(); go('menu');
      toast('Отправляем…');
      syncQueue().then(function (r) {
        if (S.screen === 'menu') render();
        if (r.errors.length) return dialog({ title: 'Документ отклонён', body: r.errors.join('\n') + '\nОн сохранён в очереди (Настройки).' }, [{ label: 'Понятно', value: 1 }]);
        if (r.warnings.length) return dialog({ title: 'Документ отправлен', html: r.warnings.map(function (w) { return '<p>⚠ ' + esc(w) + '</p>'; }).join('') }, [{ label: 'Понятно', value: 1 }]);
        toast(S.queue.length ? 'Нет связи: документ сохранён и уйдёт позже' : 'Документ отправлен, остатки обновлены');
      });
    };
    if (d.mode !== 'inventory') return go2(d.lines);
    var counted = {}; d.lines.forEach(function (l) { counted[l.article] = 1; });
    var left = expectedInZone(d.zone).filter(function (i) { return !counted[i.article]; });
    if (!left.length) return go2(d.lines);
    dialog({ title: 'Не посчитано: ' + left.length, html: '<div class="muted">' + left.slice(0, 12).map(function (i) { return esc(i.name); }).join(', ') + (left.length > 12 ? '…' : '') + '</div><p>Считать непосчитанные позиции нулевыми?</p>' },
      [{ label: 'Да, остаток 0', value: 'zero' }, { label: 'Нет, только посчитанные', cls: 'sec', value: 'skip' }, { label: 'Вернуться к подсчёту', cls: 'danger', value: 'back' }]).then(function (a) {
      if (a === 'back') return;
      go2(a === 'zero' ? d.lines.concat(left.map(function (i) { return { article: i.article, qty: 0, at: Date.now() }; })) : d.lines);
    });
  }

  /* ───────── печать этикеток ───────── */
  function printLabels() {
    var sel = Object.keys(S.sel || {}).filter(function (a) { return S.sel[a]; }).map(itemBy).filter(Boolean);
    if (!sel.length) return toast('Отметьте позиции галочками', true);
    var o = overlay('<h2>Печать этикеток</h2><div class="muted">Позиций: ' + sel.length + '. Формат ' + S.label.w + '×' + S.label.h + ' мм (меняется в настройках).</div>' +
      '<label class="f">Копий каждой<input type="number" id="p-n" inputmode="numeric" value="1" min="1" max="50"></label>' +
      '<label class="f">Дата на этикетке<input type="text" id="p-d" value="' + fmtDate(Date.now()).slice(0, 10) + '"></label>' +
      '<button class="btn" data-pr="ok">Печать</button><button class="btn danger" data-pr="cancel">Отмена</button>');
    o.onclick = function (e) {
      var b = e.target.closest('[data-pr]'); if (!b) return;
      if (b.dataset.pr === 'cancel') { o.onclick = null; return closeOverlay(); }
      b.disabled = true;
      var copies = Math.max(1, Math.min(50, parseInt($('#p-n').value, 10) || 1)), date = $('#p-d').value;
      // у позиции без QR кодом становится артикул — сохраняем в справочник
      Promise.all(sel.filter(function (i) { return !i.qr; }).map(function (i) {
        return api('bindQr', { article: i.article, qr: i.article }).then(function () { i.qr = i.article; });
      })).then(function () {
        saveCache(); o.onclick = null; closeOverlay(); doPrint(sel, copies, date);
      }).catch(function (e2) { b.disabled = false; toast(e2.message, true); });
    };
  }
  function doPrint(items, copies, date) {
    var w = S.label.w, h = S.label.h, q = Math.min(h - 3, Math.round(w * 0.5));
    var st = $('#print-style'); if (!st) { st = document.createElement('style'); st.id = 'print-style'; document.head.appendChild(st); }
    st.textContent = '@page{size:' + w + 'mm ' + h + 'mm;margin:0}@media print{.lbl{width:' + w + 'mm;height:' + h + 'mm}.lbl .qr{width:' + q + 'mm;height:' + q + 'mm}}';
    var html = '';
    items.forEach(function (it) {
      var qr = new QRCodeLib.QRCode(-1, QRCodeLib.ECL.M); qr.addData(it.qr); qr.make();
      var n = qr.getModuleCount(), path = '';
      for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (qr.isDark(r, c)) path += 'M' + c + ' ' + r + 'h1v1h-1z';
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + ' ' + n + '" shape-rendering="crispEdges"><path d="' + path + '"/></svg>';
      for (var k = 0; k < copies; k++) html += '<div class="lbl"><div class="qr">' + svg + '</div><div class="txt"><b>' + esc(it.name) + '</b><span>' + esc(it.article) + (date ? ' · ' + esc(date) : '') + '</span></div></div>';
    });
    $('#print').innerHTML = html;
    setTimeout(function () { window.print(); }, 150);
  }

  /* ───────── обработчики ───────── */
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]'); if (!el) return;
    var a = el.dataset.act, i = +el.dataset.i;
    switch (a) {
      case 'login': return doLogin();
      case 'back':
        if (S.screen === 'doc') return go('scan');
        if (S.screen === 'scan') return S.scanMode === 'bind' ? go('qr') : S.doc && S.doc.lines.length ? go('doc') : go('menu');
        return go('menu');
      case 'start-move': S.setup = { mode: 'move', direction: 'in', zone: '' }; return go('setup');
      case 'start-inv': S.setup = { mode: 'inventory', zone: '', apply: false }; return go('setup');
      case 'resume': return go(S.doc.lines.length ? 'doc' : 'scan', { scanMode: 'doc' });
      case 'dir': S.setup.direction = el.dataset.v; S.setup.zone = $('#f-zone').value; return render();
      case 'begin':
        S.setup.zone = $('#f-zone').value; var ap = $('#f-apply'); if (ap) S.setup.apply = ap.checked;
        if (!S.setup.zone) { S.err = 'Выберите место хранения'; return render(); }
        if (S.doc && S.doc.lines.length && !confirm('Есть неотправленный черновик. Заменить его новым документом?')) return go('menu');
        S.doc = { id: uid(), mode: S.setup.mode, direction: S.setup.mode === 'move' ? S.setup.direction : null, zone: S.setup.zone, apply: !!S.setup.apply, lines: [] };
        saveDraft(); return go('scan', { scanMode: 'doc' });
      case 'torch': return toggleTorch();
      case 'search': stopScanLoop(); return pickItem('Найти позицию', true, function (it) { lineForm(it); }, resumeScan);
      case 'doc': return go('doc');
      case 'scan-more': return go('scan', { scanMode: 'doc' });
      case 'edit-line': var l = S.doc.lines[i]; return lineForm(itemBy(l.article) || { article: l.article, name: l.article, unit: '' }, l.qty, i);
      case 'del-line': S.doc.lines.splice(i, 1); saveDraft(); return render();
      case 'discard': if (confirm('Удалить черновик документа?')) { S.doc = null; saveDraft(); go('menu'); } return;
      case 'send': return sendDoc();
      case 'stock': S.q = ''; go('stock'); return loadData().then(function () { if (S.screen === 'stock') render(); }).catch(function () { });
      case 'refresh': return loadData().then(function () { render(); toast('Обновлено'); }).catch(function (e2) { toast(e2.message, true); });
      case 'qr': S.q = ''; return go('qr');
      case 'bind': S.bindItem = itemBy(el.dataset.a); return go('scan', { scanMode: 'bind' });
      case 'print': return printLabels();
      case 'settings': return go('settings');
      case 'q-del': S.queue.splice(i, 1); saveQueue(); return render();
      case 'q-retry': S.queue.forEach(function (d) { delete d.error; }); saveQueue(); return syncQueue().then(function (r) { render(); toast(r.errors.length ? r.errors[0] : S.queue.length ? 'Нет связи' : 'Отправлено', !!r.errors.length); });
      case 'logout': if (!S.queue.length || confirm('Есть неотправленные документы. Всё равно выйти?')) logout(); return;
    }
  });

  document.addEventListener('input', function (e) {
    var t = e.target;
    if (t.id === 'f-q') { S.q = t.value; var pos = t.selectionStart; render(); var n = $('#f-q'); n.focus(); n.setSelectionRange(pos, pos); }
    if (t.id === 'f-lw' || t.id === 'f-lh') { S.label = { w: +$('#f-lw').value || 58, h: +$('#f-lh').value || 40 }; LS.set('label', S.label); }
    if (t.id === 'f-url') { S.url = t.value.trim(); LS.set('url', S.url); }
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.id === 'f-zone') {
      S.setup.zone = t.value;
      var z = S.zones.filter(function (z) { return z.name === t.value; })[0];
      $('#zone-owner').textContent = z && z.owner ? 'Ответственный: ' + z.owner : '';
    }
    if (t.classList.contains('selbox')) { S.sel[t.dataset.a] = t.checked; }
  });
  document.addEventListener('submit', function (e) {
    if (e.target.id === 'manual') {
      e.preventDefault(); var v = $('#f-code').value.trim(); if (!v) return;
      $('#f-code').value = ''; stopScanLoop(); onCode(v);
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && S.screen === 'login' && e.target.tagName === 'INPUT') doLogin();
  });
  window.addEventListener('online', function () { S.online = true; renderBadge(); syncQueue(); });
  window.addEventListener('offline', function () { S.online = false; renderBadge(); });
  document.addEventListener('visibilitychange', function () { if (document.hidden) stopCamera(); else if (S.screen === 'scan') startCamera(); });

  /* ───────── запуск ───────── */
  if (S.token && S.user) {
    S.screen = 'menu'; render();
    loadData().then(function () { if (S.screen === 'menu') render(); }).catch(function (e) { if (e.auth) logout(true); });
    syncQueue();
  } else render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () { });
})();
