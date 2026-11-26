/* Склад: мобильное рабочее место — перемещения, инвентаризация, остатки, QR-коды. */
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* нет места / запрещено */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { } }
  };
  const pad = n => ('0' + n).slice(-2);
  const fmtDate = d => { d = new Date(d); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const round3 = n => Math.round(n * 1000) / 1000;
  const fmtQty = n => round3(n).toString().replace('.', ',');
  const cmp = (a, b) => String(a).localeCompare(String(b), 'ru');
  const uid = () => 'D' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const DIR = { in: 'Производство → Склад', out: 'Склад → Производство', zone: 'Между ларями' };
  const SURNAME_RE = /^[A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё' -]{1,59}$/;
  const CFG_URL = (window.APP_CONFIG && window.APP_CONFIG.API_URL) || '';

  /* ───────── состояние ───────── */
  const cached = LS.get('cache', null) || {};
  const S = {
    url: CFG_URL,
    token: LS.get('token', ''), user: LS.get('user', null),
    items: cached.items || [], zones: cached.zones || [], stock: cached.stock || {},
    sheetUrl: cached.sheetUrl || '', synced: cached.synced || 0,
    queue: LS.get('queue', []), fbq: LS.get('fbq', []), label: LS.get('label', { w: 58, h: 40 }),
    screen: 'login', doc: LS.get('draft', null), online: navigator.onLine,
    scanMode: 'doc', bindItem: null, err: '', q: '', sel: {}, setup: null, cat: '', nz: false
  };
  const saveCache = () => LS.set('cache', { items: S.items, zones: S.zones, stock: S.stock, sheetUrl: S.sheetUrl, synced: S.synced });
  const saveQueue = () => LS.set('queue', S.queue);
  const saveFb = () => LS.set('fbq', S.fbq);
  const FB_KINDS = ['Нет штрих-кода на позицию', 'Ошибка в приложении', 'Ошибка в справочнике или остатках', 'Предложение', 'Другое'];
  const APP_VER = 'sklad-v8';
  const saveDraft = () => S.doc ? LS.set('draft', S.doc) : LS.del('draft');
  /** Роль: повар (перемещения и остатки), кладовщик (всё, кроме таблицы), админ (всё). Неизвестная роль = повар. */
  const role = () => { const r = String((S.user && S.user.role) || '').toLowerCase(); return r === 'админ' || r === 'кладовщик' ? r : 'повар'; };
  const isKeeper = () => role() !== 'повар';
  const itemBy = article => S.items.find(i => i.article === article);
  const stockOf = (article, zone) => { const s = S.stock[article]; return !s ? 0 : zone ? (s.z[zone] || 0) : s.t; };
  const matches = (i, q) => !q || i.name.toLowerCase().includes(q) || i.article.toLowerCase().includes(q);

  /* ───────── сеть ───────── */
  const api = (action, payload) => {
    if (!S.url) return Promise.reject(new Error('Адрес сервера не задан в config.js'));
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 30000);
    const netErr = msg => Object.assign(new Error(msg), { net: true });
    return fetch(S.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action, token: S.token, ...payload }), signal: ctrl.signal })
      .catch(() => { throw netErr('Нет связи с сервером'); })
      .then(r => r.json().catch(() => { throw netErr('Некорректный ответ сервера'); }))
      .then(d => { if (!d.ok) throw Object.assign(new Error(d.error || 'Ошибка'), { auth: d.code === 'AUTH' }); return d; })
      .finally(() => clearTimeout(timer));
  };

  const loadData = () => api('bootstrap').then(d => {
    Object.assign(S, { items: d.items, zones: d.zones, stock: d.stock, sheetUrl: d.sheetUrl, synced: Date.now(), user: d.user });
    LS.set('user', S.user); saveCache(); return d;
  });

  const bindQr = (item, qr) => api('bindQr', { article: item.article, qr }).then(() => { item.qr = qr; saveCache(); });

  /** Отправляет очередь документов; возвращает { sent, warnings, errors }. */
  let syncing = null;
  const syncQueue = () => {
    if (syncing) return syncing;
    const res = { sent: 0, warnings: [], errors: [] };
    const nextFb = () => {
      const f = S.fbq[0]; if (!f || !S.token) return Promise.resolve();
      return api('feedback', f).then(() => { S.fbq.shift(); saveFb(); return nextFb(); })
        .catch(e => { if (e.auth) { logout(true); return; } if (!e.net) { S.fbq.shift(); saveFb(); return nextFb(); } });
    };
    const next = () => {
      const d = S.queue.find(x => !x.error);
      if (!d || !S.token) return nextFb().then(() => res);
      return api('submitDocument', { doc: d }).then(r => {
        S.queue = S.queue.filter(x => x !== d); saveQueue();
        res.sent++; res.warnings.push(...(r.warnings || []));
        if (r.stock) { S.stock = r.stock; S.synced = Date.now(); saveCache(); }
        return next();
      }).catch(e => {
        if (e.auth) { logout(true); return res; }
        if (!e.net) { d.error = e.message; saveQueue(); res.errors.push(e.message); return next(); }
        return res;
      });
    };
    return (syncing = next().finally(() => { syncing = null; renderBadge(); }));
  };

  /* ───────── навигация и общие элементы ───────── */
  const app = $('#app');
  const go = (screen, extra) => {
    if (S.screen === 'scan' && screen !== 'scan') stopCamera();
    Object.assign(S, { screen, err: '' }, extra);
    render();
  };
  function render() {
    app.innerHTML = ({ login: vLogin, menu: vMenu, setup: vSetup, scan: vScan, doc: vDoc, stock: vStock, qr: vQr, settings: vSettings, feedback: vFeedback })[S.screen]();
    renderBadge();
    if (S.screen === 'scan') startCamera();
    window.scrollTo(0, 0);
  }
  function renderBadge() {
    const b = $('#badge'); if (!b) return;
    const q = S.queue.length, bad = S.queue.filter(x => x.error).length;
    b.className = 'badge' + (!S.online || q ? ' off' : '');
    b.textContent = !S.online ? 'Офлайн' + (q ? ' · ' + q : '') : q ? (bad ? 'Ошибок: ' + bad : 'В очереди: ' + q) : 'Онлайн';
  }
  const top = (title, back) => `<header class="top">${back ? '<button class="back" data-act="back" aria-label="Назад">‹</button>' : ''}<h1>${esc(title)}</h1><span id="badge" class="badge"></span></header>`;

  let toastT;
  const toast = (msg, bad) => {
    const t = $('#toast'); t.textContent = msg; t.className = 'on' + (bad ? ' bad' : '');
    clearTimeout(toastT); toastT = setTimeout(() => { t.className = ''; }, bad ? 5000 : 2600);
  };
  const overlay = html => { const o = $('#ov'); o.innerHTML = `<div class="sheet">${html}</div>`; o.className = 'on'; return o; };
  const closeOverlay = () => { const o = $('#ov'); o.onclick = null; o.className = ''; o.innerHTML = ''; };
  const dialog = (text, buttons) => new Promise(resolve => {
    const o = overlay(`<h2>${esc(text.title)}</h2><div>${text.html || esc(text.body || '')}</div>` +
      buttons.map((b, i) => `<button class="btn ${b.cls || ''}" data-dlg="${i}">${esc(b.label)}</button>`).join(''));
    o.onclick = e => {
      const b = e.target.closest('[data-dlg]'); if (!b) return;
      closeOverlay(); resolve(buttons[+b.dataset.dlg].value);
    };
  });

  /* ───────── экраны ───────── */
  const docPills = d => (d.mode === 'move' ? `<span class="pill ${d.direction}">${DIR[d.direction]}</span>` : '<span class="pill">Инвентаризация</span>') + `<span class="pill">${esc(d.direction === 'zone' ? d.zone + ' → ' + d.zoneTo : d.zone)}</span>`;
  const ctxHtml = d => docPills(d) + (d.mode === 'move' ? '<button class="btn sec sm" data-act="edit-type">Изменить тип</button>' : '');
  const zoneOptions = sel => '<option value="">— выберите —</option>' + S.zones.map(z => `<option value="${esc(z.name)}"${z.name === sel ? ' selected' : ''}>${esc(z.name)}</option>`).join('');
  const expectedInZone = zone => S.items.filter(i => stockOf(i.article, zone) > 0.0004).sort((a, b) => cmp(a.name, b.name));

  function vLogin() {
    return top('Склад') + `<main><div class="card col"><h2>Вход</h2>
      <label class="f">Логин<input id="f-login" type="text" autocapitalize="off" autocomplete="username"></label>
      <label class="f">Пароль<input id="f-pass" type="password" autocomplete="current-password"></label>
      ${S.err ? `<div class="err">${esc(S.err)}</div>` : ''}
      <button class="btn" data-act="login">Войти</button></div></main>`;
  }

  function vMenu() {
    const q = S.queue.length, d = S.doc;
    return top('Склад · ' + (S.user ? S.user.name : '')) + `<main><div class="tiles">
      <button class="tile t1" data-act="start-move">Сканировать QR<small>Перемещение полуфабрикатов</small></button>
      ${isKeeper() ? '<button class="tile t2" data-act="start-inv">Инвентаризация<small>Подсчёт и Excel</small></button>' : ''}
      <button class="tile t3" data-act="stock">Остатки<small>${S.synced ? 'обновлено ' + fmtDate(S.synced) : 'нет данных'}</small></button>
      ${isKeeper() ? '<button class="tile t5" data-act="qr">QR-коды<small>Привязка и печать</small></button>' : ''}
      <button class="tile t4" data-act="settings">Настройки<small>Очередь${isKeeper() ? ', этикетки' : ''}, обратная связь</small></button></div>
      ${d && (d.mode !== 'inventory' || isKeeper()) ? `<button class="btn sec" data-act="resume">Продолжить черновик: ${d.mode === 'move' ? 'перемещение' : 'инвентаризация'} (${d.lines.length})</button>` : ''}
      ${q ? `<div class="card muted">Неотправленных документов: ${q}. Они уйдут автоматически при появлении связи.</div>` : ''}</main>`;
  }

  function vSetup() {
    const inv = S.setup.mode === 'inventory', dir = S.setup.direction;
    return top(inv ? 'Инвентаризация' : 'Перемещение', true) + `<main><div class="card col">
      ${inv ? '' : `<div class="seg"><button class="in${dir === 'in' ? ' on' : ''}" data-act="dir" data-v="in">Производство<br>→ Склад</button><button class="out${dir === 'out' ? ' on' : ''}" data-act="dir" data-v="out">Склад<br>→ Производство</button><button class="zone zn${dir === 'zone' ? ' on' : ''}" data-act="dir" data-v="zone">Между ларями</button></div>`}
      <label class="f">${inv ? 'Зона хранения' : dir === 'zone' ? 'Из ларя (откуда)' : 'Место хранения на складе'}<select id="f-zone">${zoneOptions(S.setup.zone)}</select></label>
      ${dir === 'zone' ? `<label class="f">В ларь (куда)<select id="f-zone2">${zoneOptions(S.setup.zoneTo)}</select></label>` : ''}
      <div id="zone-owner" class="muted"></div>
      ${inv ? `<label class="chk"><input type="checkbox" id="f-apply"${S.setup.apply ? ' checked' : ''}> Скорректировать остатки по факту</label>
        <div class="muted">Если включено, после отправки остаток в этой зоне станет равен подсчитанному. Если выключено — документ только фиксируется в журнале и Excel.</div>` : ''}
      ${S.err ? `<div class="err">${esc(S.err)}</div>` : ''}
      <button class="btn" data-act="begin">Начать сканирование</button></div></main>`;
  }

  function vScan() {
    const d = S.doc, bind = S.scanMode === 'bind';
    return top(bind ? 'Привязка QR' : 'Сканирование', true) + `<main>
      <div class="ctx">${bind ? `<span class="pill">Привязка QR: ${esc(S.bindItem.name)}</span>` : ctxHtml(d)}</div>
      <div class="scan"><video id="cam" playsinline muted></video><div class="frame"></div><div class="hint">Наведите камеру на QR-код упаковки</div>
        <button class="torch" id="torch" data-act="torch" hidden>Фонарик</button><div class="none" id="cam-none" hidden></div></div>
      <form id="manual" class="row" style="gap:8px"><input type="text" id="f-code" placeholder="Код вручную" autocapitalize="off" autocomplete="off"><button class="btn sm" style="flex:none;width:auto">OK</button></form>
      ${bind ? '' : `<div class="row"><button class="btn sec" data-act="search">Найти по названию</button><button class="btn" data-act="doc" id="docbtn">Документ (${d.lines.length})</button></div>`}</main>`;
  }

  function totalsByUnit(lines) {
    const t = {};
    lines.forEach(l => { const u = (itemBy(l.article) || {}).unit || ''; t[u] = (t[u] || 0) + l.qty; });
    return Object.keys(t).map(u => `${fmtQty(t[u])} ${u}`).join(' · ') || '—';
  }

  function vDoc() {
    const d = S.doc, inv = d.mode === 'inventory';
    const list = d.lines.map((l, i) => {
      const it = itemBy(l.article) || { name: l.article, unit: '' };
      return `<div class="li"><div class="n"><b>${esc(it.name)}</b><span class="muted">${esc(l.article)} · ${fmtDate(l.at)}</span></div>
        <div class="q" data-act="edit-line" data-i="${i}">${fmtQty(l.qty)} ${esc(it.unit)}</div>
        <button class="x" data-act="del-line" data-i="${i}" aria-label="Удалить">×</button></div>`;
    }).join('') || '<div class="muted">Позиций пока нет</div>';
    let prog = '';
    if (inv) {
      const exp = expectedInZone(d.zone), counted = new Set(d.lines.map(l => l.article));
      const left = exp.filter(i => !counted.has(i.article)), done = exp.length - left.length;
      const z = S.zones.find(z => z.name === d.zone);
      prog = `<div class="card col"><b>Зона «${esc(d.zone)}»${z && z.owner ? ' · отв.: ' + esc(z.owner) : ''}</b>
        <div class="bar"><i style="width:${exp.length ? Math.round(done / exp.length * 100) : 100}%"></i></div>
        <span class="muted">Посчитано ${done} из ${exp.length} позиций по учёту</span>
        ${left.length ? `<details><summary class="muted">Не посчитано (${left.length})</summary>${left.map(i => `<div class="li"><div class="n">${esc(i.name)}</div><span class="muted">${fmtQty(stockOf(i.article, d.zone))} ${esc(i.unit)}</span></div>`).join('')}</details>` : ''}</div>`;
    }
    return top('Документ', true) + `<main><div class="ctx">${ctxHtml(d)}</div>${prog}
      <div class="card"><div class="list">${list}</div></div>
      <div class="card"><b>Итого:</b> ${totalsByUnit(d.lines)}</div>
      <div class="sticky"><button class="btn sec" data-act="scan-more">Сканировать ещё</button>
        <button class="btn" data-act="send"${d.lines.length ? '' : ' disabled'}>${inv ? 'Сформировать документ' : 'Отправить документ'}</button>
        <button class="btn danger" data-act="discard">Удалить черновик</button></div></main>`;
  }

  const NO_CAT = '__none';
  const canOpenSheet = () => !!S.sheetUrl && role() === 'админ';
  function vStock() {
    const q = S.q.toLowerCase();
    const cats = [...new Set(S.items.map(i => i.category).filter(Boolean))].sort(cmp);
    const hasNone = S.items.some(i => !i.category);
    if (S.cat && S.cat !== NO_CAT && !cats.includes(S.cat)) S.cat = '';
    const items = S.items.filter(i => matches(i, q)
      && (!S.cat || (S.cat === NO_CAT ? !i.category : i.category === S.cat))
      && (!S.nz || Math.abs(stockOf(i.article)) > 0.0004)).sort((a, b) => cmp(a.category || 'яяя', b.category || 'яяя') || cmp(a.name, b.name));
    let html = '', cat = null;
    items.forEach(i => {
      if (i.category !== cat) { cat = i.category; html += `<div class="grp">${esc(cat || 'Без категории')}</div>`; }
      const s = S.stock[i.article] || { t: 0, z: {} };
      const zs = Object.keys(s.z).sort(cmp).map(z => `${esc(z)}: ${fmtQty(s.z[z])}`).join(' · ');
      const tag = s.t < -0.0005 ? '<span class="tag bad">минус</span>' : i.min != null && s.t < i.min ? '<span class="tag warn">ниже мин.</span>' : i.max && s.t > i.max ? '<span class="tag warn">выше макс.</span>' : '';
      html += `<div class="li"><div class="n"><b>${esc(i.name)}</b><span class="muted">${zs || 'нет на складе'}</span></div><div class="q">${fmtQty(s.t)} ${esc(i.unit)}</div>${tag}</div>`;
    });
    const catOpts = `<option value="">Все категории</option>` + cats.map(c => `<option value="${esc(c)}"${c === S.cat ? ' selected' : ''}>${esc(c)}</option>`).join('')
      + (hasNone ? `<option value="${NO_CAT}"${S.cat === NO_CAT ? ' selected' : ''}>Без категории</option>` : '');
    return top('Остатки', true) + `<main><input type="search" id="f-q" placeholder="Поиск" value="${esc(S.q)}">
      <select id="f-cat" aria-label="Категория">${catOpts}</select>
      <label class="chk"><input type="checkbox" id="f-nz"${S.nz ? ' checked' : ''}> Только с ненулевым остатком</label>
      <div class="row"><button class="btn sec sm" data-act="refresh">Обновить</button>${canOpenSheet() ? `<a class="btn sec sm" style="text-decoration:none" href="${esc(S.sheetUrl)}" target="_blank" rel="noopener">Google Sheets</a>` : ''}</div>
      <div class="card"><div class="list">${html || '<div class="muted">Ничего не найдено</div>'}</div></div>
      <div class="muted">Данные на ${S.synced ? fmtDate(S.synced) : '—'}</div></main>`;
  }

  function vQr() {
    const q = S.q.toLowerCase();
    const html = S.items.filter(i => matches(i, q)).sort((a, b) => cmp(a.name, b.name)).map(i =>
      `<div class="li"><input type="checkbox" class="selbox" data-a="${esc(i.article)}"${S.sel[i.article] ? ' checked' : ''}>
        <div class="n"><b>${esc(i.name)}</b><span class="muted">${esc(i.article)}</span></div>
        <span class="tag ${i.qr ? 'ok' : ''}">${i.qr ? 'QR ✓' : 'нет QR'}</span>
        <button class="btn sec sm" data-act="bind" data-a="${esc(i.article)}">Скан</button></div>`).join('');
    return top('QR-коды', true) + `<main><input type="search" id="f-q" placeholder="Поиск" value="${esc(S.q)}">
      <div class="card"><div class="list">${html || '<div class="muted">Справочник пуст</div>'}</div></div>
      <div class="sticky"><button class="btn" data-act="print">Печать выбранных этикеток</button></div></main>`;
  }

  function vSettings() {
    const bad = S.queue.some(x => x.error), u = S.user;
    const queue = S.queue.map((d, i) => `<div class="li"><div class="n"><b>${d.type === 'move' ? 'Перемещение' : 'Инвентаризация'} · ${d.lines.length} поз.</b>
      <span class="muted">${fmtDate(d.created)} · ${esc(d.direction === 'zone' ? d.zone + ' → ' + d.zoneTo : d.zone)}${d.error ? `<br><span class="err">${esc(d.error)}</span>` : ''}</span></div>
      ${d.error ? `<button class="btn sm danger" data-act="q-del" data-i="${i}">Удалить</button>` : ''}</div>`).join('');
    return top('Настройки', true) + `<main>
      <div class="card col"><b>Очередь отправки</b>${queue || '<span class="muted">Пусто</span>'}
        ${S.queue.length ? `<button class="btn sec" data-act="q-retry">${bad ? 'Повторить отправку' : 'Отправить сейчас'}</button>` : ''}</div>
      ${isKeeper() ? `<div class="card col"><b>Этикетка, мм</b><div class="row">
        <label class="f">Ширина<input type="number" id="f-lw" inputmode="numeric" value="${S.label.w}"></label>
        <label class="f">Высота<input type="number" id="f-lh" inputmode="numeric" value="${S.label.h}"></label></div></div>` : ''}
      <div class="card col"><b>Обратная связь</b><span class="muted">Нет штрих-кода, ошибка или идея? Напишите нам.${S.fbq.length ? ` Ожидает отправки: ${S.fbq.length}.` : ''}</span>
        <button class="btn sec" data-act="feedback">Обратная связь</button></div>
      <div class="muted">Пользователь: ${esc(u ? u.name : '')} (${esc(u ? u.role : '')})</div>
      <button class="btn danger" data-act="logout">Выйти</button></main>`;
  }

  function vFeedback() {
    return top('Обратная связь', true) + `<main><div class="card col">
      <label class="f">Тема<select id="fb-kind">${FB_KINDS.map(k => `<option${k === S.fbKind ? ' selected' : ''}>${esc(k)}</option>`).join('')}</select></label>
      <label class="f">Сообщение<textarea id="fb-text" rows="6" maxlength="1000" placeholder="Например: нет штрих-кода на «Фарш куриный», артикул 123">${esc(S.fbText || '')}</textarea></label>
      <button class="btn" data-act="fb-send">Отправить</button></div></main>`;
  }
  function sendFeedback() {
    const text = $('#fb-text').value.trim(), kind = $('#fb-kind').value;
    S.fbText = text; S.fbKind = kind;
    if (text.length < 5) return toast('Опишите проблему подробнее', true);
    const f = { id: uid(), kind, text, ver: APP_VER }, btn = $('[data-act=fb-send]'); btn.disabled = true;
    api('feedback', f).then(() => { S.fbText = ''; toast('Сообщение отправлено'); go('settings'); })
      .catch(e => {
        if (e.auth) return logout(true);
        if (!e.net) { btn.disabled = false; return toast(e.message, true); }
        S.fbq.push(f); saveFb(); S.fbText = '';
        toast('Нет связи: сообщение отправится позже'); go('settings');
      });
  }

  /* ───────── авторизация ───────── */
  function logout(expired) {
    S.token = ''; S.user = null; LS.del('token'); LS.del('user');
    go('login', { err: expired ? 'Сессия истекла, войдите снова' : '' });
  }
  function doLogin() {
    const login = $('#f-login').value.trim(), password = $('#f-pass').value;
    if (!login || !password) { S.err = 'Введите логин и пароль'; return render(); }
    const btn = $('[data-act=login]'); btn.disabled = true; btn.textContent = 'Входим…';
    api('login', { login, password }).then(r => {
      S.token = r.token; S.user = r.user; LS.set('token', S.token); LS.set('user', S.user);
      return loadData().catch(() => { }).then(() => { go('menu'); syncQueue(); });
    }).catch(e => { S.err = e.message; render(); });
  }

  /* ───────── камера и распознавание ───────── */
  const cam = { stream: null, det: null, run: false, last: '', lastT: 0, busy: false, timer: 0, torchOn: false };
  const pauseScan = () => { cam.run = false; clearTimeout(cam.timer); };
  const resumeScan = () => { if (S.screen === 'scan' && cam.stream && cam.det) { cam.run = true; tick(); } };
  function stopCamera() {
    pauseScan();
    if (cam.stream) { cam.stream.getTracks().forEach(t => t.stop()); cam.stream = null; }
  }
  function startCamera() {
    stopCamera();
    const video = $('#cam'), none = $('#cam-none');
    const noCam = msg => { none.hidden = false; none.textContent = msg; };
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return noCam('Камера недоступна. Введите код вручную.');
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false }).then(stream => {
      if (S.screen !== 'scan') { stream.getTracks().forEach(t => t.stop()); return; }
      cam.stream = stream; video.srcObject = stream;
      const track = stream.getVideoTracks()[0], caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.torch) $('#torch').hidden = false;
      video.muted = true; // iOS: автозапуск видео только без звука
      return video.play().then(() => {
        if (!('BarcodeDetector' in window)) { // iPhone/iPad и другие браузеры без BarcodeDetector: запасной распознаватель
          return loadFallbackLibs().then(() => {
            if (S.screen !== 'scan' || !cam.stream) return;
            cam.det = fallbackDetector(); cam.run = true; tick();
          }).catch(() => noCam('Сканирование на этом устройстве недоступно. Введите код вручную.'));
        }
        const want = ['qr_code', 'ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a'];
        return (BarcodeDetector.getSupportedFormats ? BarcodeDetector.getSupportedFormats() : Promise.resolve(want)).then(sup => {
          cam.det = new BarcodeDetector({ formats: want.filter(f => sup.includes(f)) });
          cam.run = true; tick();
        });
      });
    }).catch(e => noCam(e && e.name === 'NotAllowedError' ? 'Нет доступа к камере. Разрешите камеру в настройках сайта или введите код вручную.' : 'Не удалось запустить камеру. Введите код вручную.'));
  }
  /* Запасной распознаватель для браузеров без BarcodeDetector (iPhone, iPad). Библиотеки подгружаются из vendor/:
     zxing.min.js (ZXing: штрихкоды и QR) и jsQR.js (резерв для QR). Достаточно любой одной из них. */
  const libLoading = {};
  const loadLib = (global, src) => window[global] ? Promise.resolve() : (libLoading[src] = libLoading[src] || new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = src; s.onload = ok; s.onerror = () => { libLoading[src] = null; fail(new Error(src)); };
    document.head.appendChild(s);
  }));
  /** Готово, как только загрузилась любая из библиотек; ошибка — только если не загрузилась ни одна. */
  const loadFallbackLibs = () => new Promise((ok, fail) => {
    let left = 2;
    const done = good => { if (good) ok(); else if (--left === 0) fail(new Error('no libs')); };
    loadLib('ZXing', 'vendor/zxing.min.js').then(() => done(true), () => done(false));
    loadLib('jsQR', 'vendor/jsQR.js').then(() => done(true), () => done(false));
  });

  /** Серый кадр (яркость пикселей) для ZXing. */
  const toGray = rgba => {
    const n = rgba.length >> 2, out = new Uint8ClampedArray(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) out[i] = (rgba[j] * 299 + rgba[j + 1] * 587 + rgba[j + 2] * 114) / 1000;
    return out;
  };
  /**
   * Читает только центр кадра, чтобы брался код, на который наведена рамка, а не соседние.
   * ZXing смотрит на широкую центральную полосу (для штрихкодов), jsQR — на центральный квадрат (для QR).
   */
  function fallbackDetector() {
    const cv = document.createElement('canvas'), g = cv.getContext('2d', { willReadFrequently: true });
    let hints = null;
    const getHints = () => { // ZXing может догрузиться после старта камеры
      if (!hints && window.ZXing) {
        const Z = window.ZXing, F = Z.BarcodeFormat;
        hints = new Map();
        hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [F.QR_CODE, F.EAN_13, F.EAN_8, F.UPC_A, F.CODE_128, F.CODE_39]);
        hints.set(Z.DecodeHintType.TRY_HARDER, true);
      }
      return hints;
    };
    const crop = (video, sx, sy, sw, sh, ow, oh) => {
      cv.width = ow; cv.height = oh;
      g.drawImage(video, sx, sy, sw, sh, 0, 0, ow, oh);
      return g.getImageData(0, 0, ow, oh);
    };
    return {
      detect: video => {
        const vw = video.videoWidth, vh = video.videoHeight; let text = null;
        const hs = getHints();
        if (hs) {
          const Z = window.ZXing, cw = Math.floor(vw * 0.9), ch = Math.floor(Math.min(vh * 0.5, cw * 0.75)), k = Math.min(1, 800 / cw);
          const ow = Math.floor(cw * k), oh = Math.floor(ch * k);
          const img = crop(video, Math.floor((vw - cw) / 2), Math.floor((vh - ch) / 2), cw, ch, ow, oh);
          try {
            const bmp = new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.RGBLuminanceSource(toGray(img.data), ow, oh)));
            text = new Z.MultiFormatReader().decode(bmp, hs).getText();
          } catch (e) { /* код не найден в этом кадре */ }
        }
        if (!text && window.jsQR) {
          const side = Math.floor(Math.min(vw, vh) * 0.7), out = Math.min(side, 480);
          const img = crop(video, Math.floor((vw - side) / 2), Math.floor((vh - side) / 2), side, side, out, out);
          const r = window.jsQR(img.data, out, out, { inversionAttempts: 'dontInvert' });
          text = r && r.data;
        }
        return Promise.resolve(text ? [{ rawValue: text, boundingBox: { x: vw / 2, y: vh / 2, width: 0, height: 0 } }] : []);
      }
    };
  }
  /** Из нескольких кодов в кадре берёт тот, чей центр ближе всего к центру рамки. */
  function pickCentral(codes, video) {
    const cx = video.videoWidth / 2, cy = video.videoHeight / 2, r = Math.min(cx, cy) * 0.6;
    let best = null, bd = Infinity;
    codes.forEach(c => {
      const b = c.boundingBox, d = Math.hypot(b.x + b.width / 2 - cx, b.y + b.height / 2 - cy);
      if (d < bd) { bd = d; best = c; }
    });
    return bd <= r ? best : null;
  }
  function tick() {
    if (!cam.run) return;
    cam.timer = setTimeout(() => {
      const video = $('#cam');
      if (!cam.run || !video || cam.busy || video.readyState < 2) return tick();
      cam.busy = true;
      cam.det.detect(video).then(codes => {
        cam.busy = false;
        const c = cam.run && pickCentral(codes, video), v = c && c.rawValue;
        if (v && (v !== cam.last || Date.now() - cam.lastT > 2500)) {
          cam.last = v; cam.lastT = Date.now();
          if (navigator.vibrate) navigator.vibrate(60);
          cam.run = false; return onCode(v);
        }
        tick();
      }).catch(() => { cam.busy = false; tick(); });
    }, 140);
  }
  function toggleTorch() {
    const tr = cam.stream && cam.stream.getVideoTracks()[0]; if (!tr) return;
    cam.torchOn = !cam.torchOn; tr.applyConstraints({ advanced: [{ torch: cam.torchOn }] }).catch(() => { });
  }

  /* ───────── код → позиция ───────── */
  function resolveCode(code) {
    code = String(code).trim(); if (!code) return null;
    const low = code.toLowerCase();
    let it = S.items.find(i => i.qr && i.qr.toLowerCase() === low) || S.items.find(i => i.article.toLowerCase() === low);
    if (it) return { item: it };
    if (/^2\d{12}$/.test(code)) { // весовой EAN-13: 2 + PLU(5) + граммы(5) + контрольная цифра
      const z0 = s => /^\d+$/.test(s) ? s.replace(/^0+/, '') : null, plu = z0(code.slice(1, 6));
      it = S.items.find(i => z0(i.article) === plu || z0(i.qr) === plu);
      if (it) return { item: it, qty: Number(code.slice(6, 11)) / 1000 };
    }
    return null;
  }
  function onCode(code) {
    if (S.scanMode === 'bind') return bindScanned(code);
    const r = resolveCode(code);
    if (r) lineForm(r.item, r.qty); else unknownCode(code);
  }
  function unknownCode(code) {
    const o = overlay(`<h2>Код не найден</h2><div class="muted" style="overflow-wrap:anywhere">${esc(code)}</div>
      ${isKeeper() ? `<button class="btn" data-u="bind">Привязать к позиции из справочника</button>
      <button class="btn sec" data-u="new">Добавить как новую позицию</button>` : '<div class="muted">Этого кода нет в справочнике. Обратитесь к кладовщику.</div>'}
      <button class="btn danger" data-u="cancel">Отмена</button>`);
    o.onclick = e => {
      const b = e.target.closest('[data-u]'); if (!b) return;
      if (b.dataset.u === 'cancel') { closeOverlay(); return resumeScan(); }
      if (b.dataset.u === 'new') return newItemForm(code);
      pickItem('Привязать код к…', false, it => bindQr(it, code)
        .then(() => { toast('Код привязан'); lineForm(it); })
        .catch(e2 => { toast(e2.message, true); resumeScan(); }), resumeScan);
    };
  }
  function bindScanned(code) {
    const it = S.bindItem;
    bindQr(it, code.trim()).then(() => { toast('QR привязан: ' + it.name); go('qr'); }).catch(e => { toast(e.message, true); resumeScan(); });
  }

  /* ───────── выбор позиции и новая позиция ───────── */
  function pickItem(title, allowNew, onPick, onCancel) {
    const o = overlay(`<h2>${esc(title)}</h2><input type="search" id="pk-q" placeholder="Название или артикул"><div id="pk-list" class="card list"></div>
      ${allowNew ? '<button class="btn sec" data-p="new">Добавить вручную</button>' : ''}<button class="btn danger" data-p="cancel">Отмена</button>`);
    const fill = () => {
      const q = $('#pk-q').value.toLowerCase();
      $('#pk-list').innerHTML = S.items.filter(i => matches(i, q)).sort((a, b) => cmp(a.name, b.name)).slice(0, 40)
        .map(i => `<div class="li" data-pick="${esc(i.article)}"><div class="n"><b>${esc(i.name)}</b><span class="muted">${esc(i.article)} · ${esc(i.unit)}</span></div></div>`).join('') || '<div class="muted">Не найдено</div>';
    };
    fill(); $('#pk-q').oninput = fill;
    o.onclick = e => {
      const p = e.target.closest('[data-pick]'), b = e.target.closest('[data-p]');
      if (p) { closeOverlay(); return onPick(itemBy(p.dataset.pick)); }
      if (!b) return;
      if (b.dataset.p === 'new') return newItemForm('');
      closeOverlay(); if (onCancel) onCancel();
    };
  }

  function newItemForm(qr) {
    const cats = [...new Set(S.items.map(i => i.category).filter(Boolean))].sort(cmp);
    const o = overlay(`<h2>Новая позиция</h2><label class="f">Наименование<input type="text" id="n-name" autocomplete="off"></label>
      <label class="f">Единица<select id="n-unit"><option>кг</option><option>шт</option></select></label>
      <label class="f">Категория<input type="text" id="n-cat" list="n-cats" autocomplete="off"></label>
      <datalist id="n-cats">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
      ${qr ? `<div class="muted">QR-код: ${esc(qr)}</div>` : ''}<div class="err" id="n-err"></div>
      <button class="btn" data-n="ok">Добавить в справочник</button><button class="btn danger" data-n="cancel">Отмена</button>`);
    o.onclick = e => {
      const b = e.target.closest('[data-n]'); if (!b) return;
      if (b.dataset.n === 'cancel') { closeOverlay(); return resumeScan(); }
      const name = $('#n-name').value.trim();
      if (!name) { $('#n-err').textContent = 'Введите наименование'; return; }
      b.disabled = true;
      api('addItem', { name, unit: $('#n-unit').value, category: $('#n-cat').value.trim(), qr }).then(r => {
        S.items.push(r.item); saveCache(); closeOverlay(); toast('Добавлено: ' + name);
        if (S.screen === 'scan') lineForm(r.item);
      }).catch(e2 => { b.disabled = false; $('#n-err').textContent = e2.message; });
    };
  }

  /* ───────── форма строки и калькулятор ───────── */
  function evalExpr(s) {
    s = String(s).replace(/,/g, '.').replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-').replace(/\s/g, '');
    if (!/^[0-9+\-*/.()]+$/.test(s)) return NaN;
    try { const v = Function('"use strict";return (' + s + ')')(); return typeof v === 'number' && isFinite(v) ? round3(v) : NaN; } catch (e) { return NaN; }
  }

  function lineForm(item, presetQty, editIdx) {
    pauseScan();
    const d = S.doc, inv = d.mode === 'inventory';
    const inZone = `${fmtQty(stockOf(item.article, d.zone))} ${esc(item.unit)}`;
    const note = inv ? ` · по учёту в зоне: ${inZone}` : d.direction !== 'in' ? ` · в зоне: ${inZone}` : '';
    const keys = ['7', '8', '9', '÷', '4', '5', '6', '×', '1', '2', '3', '−', '0', ',', '⌫', '+']
      .map(k => `<button data-k="${k}"${/[÷×−+]/.test(k) ? ' class="op"' : ''}>${k}</button>`).join('');
    const o = overlay(`<h2>${esc(item.name)}</h2><div class="muted">${esc(item.article)}${note}</div>
      <label class="f">${inv ? 'Фактическое количество' : 'Масса / количество'}, ${esc(item.unit)}<input type="text" id="l-qty" inputmode="decimal" autocomplete="off" value="${presetQty != null ? fmtQty(presetQty) : ''}" placeholder="0"></label>
      <div id="l-hint" class="muted"></div>
      <div class="keys" id="keys" hidden>${keys}<button data-k="C" class="op">C</button><button data-k="=" class="eq" style="grid-column:span 3">=</button></div>
      <button class="btn sec" data-l="calc">Калькулятор</button>
      <button class="btn" data-l="ok">${editIdx != null ? 'Сохранить' : 'Добавить в документ'}</button><button class="btn danger" data-l="cancel">Отмена</button>`);
    const inp = $('#l-qty'), hint = $('#l-hint');
    if (presetQty == null) setTimeout(() => inp.focus(), 60);
    const commit = () => {
      const v = evalExpr(inp.value);
      if (!isFinite(v) || (inv ? v < 0 : v <= 0)) { hint.innerHTML = `<span class="err">Введите ${inv ? 'число 0 или больше' : 'число больше нуля'}</span>`; return; }
      if (item.unit === 'шт' && !Number.isInteger(v)) { hint.innerHTML = '<span class="err">Штуки — целое число</span>'; return; }
      if (editIdx != null) d.lines[editIdx].qty = v; else d.lines.push({ article: item.article, qty: v, at: Date.now() });
      saveDraft(); closeOverlay();
      if (S.screen === 'doc') return render();
      const b = $('#docbtn'); if (b) b.textContent = `Документ (${d.lines.length})`;
      toast(`Добавлено · ${fmtQty(v)} ${item.unit}`); resumeScan();
    };
    o.onclick = e => {
      const k = e.target.closest('[data-k]'), b = e.target.closest('[data-l]');
      if (k) {
        const key = k.dataset.k;
        if (key === 'C') inp.value = '';
        else if (key === '⌫') inp.value = inp.value.slice(0, -1);
        else if (key === '=') { const r = evalExpr(inp.value); if (isFinite(r)) inp.value = fmtQty(r); else hint.innerHTML = '<span class="err">Не удалось вычислить</span>'; }
        else inp.value += key;
      } else if (b) {
        if (b.dataset.l === 'calc') { const kk = $('#keys'); kk.hidden = !kk.hidden; inp.blur(); }
        else if (b.dataset.l === 'ok') commit();
        else { closeOverlay(); resumeScan(); }
      }
    };
    inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } };
  }

  /* ───────── отправка документа ───────── */
  function buildInventoryXlsx(d, lines, surname) {
    const agg = {};
    lines.forEach(l => { agg[l.article] = (agg[l.article] || 0) + l.qty; });
    const arr = Object.keys(agg).map(a => { const it = itemBy(a) || { name: a, unit: '' }; return { article: a, name: it.name, unit: it.unit, plan: stockOf(a, d.zone), fact: round3(agg[a]) }; })
      .sort((a, b) => cmp(a.name, b.name));
    const z = S.zones.find(z => z.name === d.zone);
    const head = ['№', 'Артикул', 'Наименование', 'Ед. изм.', 'По учёту', 'Фактически', 'Расхождение'].map(h => ({ v: h, s: 2 }));
    const rows = [[{ v: 'Инвентаризация склада', s: 1 }], ['Дата', fmtDate(Date.now())], ['Автор', S.user.name], ['Составил (фамилия)', surname],
      ['Зона хранения', d.zone + (z && z.owner ? ` (отв.: ${z.owner})` : '')], [], head];
    arr.forEach((r, i) => rows.push([i + 1, r.article, r.name, r.unit, { v: r.plan, s: 3 }, { v: r.fact, s: 3 }, { v: round3(r.fact - r.plan), s: 3 }]));
    return makeXlsx({ name: 'Инвентаризация', rows, widths: [5, 12, 42, 10, 12, 12, 14] });
  }
  const TR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', '№': 'N' };
  const translit = str => String(str).replace(/./g, c => { const l = c.toLowerCase(), r = TR[l]; return r === undefined ? c : c !== l ? r.charAt(0).toUpperCase() + r.slice(1) : r; });
  function download(blob, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }

  /** Запрашивает фамилию вручную; без корректной фамилии возвращает null и документ не отправляется. */
  const askSurname = () => new Promise(resolve => {
    const o = overlay(`<h2>Кто оформил документ?</h2>
      <label class="f">Фамилия (введите вручную)<input type="text" id="s-name" autocomplete="off" autocapitalize="words"></label>
      <div class="err" id="s-err"></div>
      <button class="btn" data-s="ok">Отправить документ</button><button class="btn danger" data-s="cancel">Отмена</button>`);
    const inp = $('#s-name');
    setTimeout(() => inp.focus(), 60);
    const ok = () => {
      const v = inp.value.trim().replace(/\s+/g, ' ');
      if (!SURNAME_RE.test(v)) { $('#s-err').textContent = 'Введите фамилию буквами (не короче 2 символов)'; return; }
      closeOverlay(); resolve(v);
    };
    o.onclick = e => {
      const b = e.target.closest('[data-s]'); if (!b) return;
      if (b.dataset.s === 'ok') ok(); else { closeOverlay(); resolve(null); }
    };
    inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); ok(); } };
  });

  function sendDoc() {
    const d = S.doc; if (!d || !d.lines.length) return;
    const submit = (lines, surname) => {
      if (d.mode === 'inventory') {
        const t = new Date(), zone = translit(d.zone).replace(/[^\w]+/g, '_').replace(/^_|_$/g, '');
        download(buildInventoryXlsx(d, lines, surname),`Inventarizatsiya_${zone}_${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}_${pad(t.getHours())}${pad(t.getMinutes())}.xlsx`);
      }
      S.queue.push({ docId: d.id, type: d.mode, direction: d.direction, zone: d.zone, zoneTo: d.zoneTo || '', apply: !!d.apply, surname, created: Date.now(), lines: lines.map(l => ({ article: l.article, qty: l.qty })) });
      saveQueue(); S.doc = null; saveDraft(); go('menu'); toast('Отправляем…');
      syncQueue().then(r => {
        if (S.screen === 'menu') render();
        const ok = [{ label: 'Понятно', value: 1 }];
        if (r.errors.length) return dialog({ title: 'Документ отклонён', html: r.errors.map(esc).join('<br>') + '<br>Он сохранён в очереди (Настройки).' }, ok);
        if (r.warnings.length) return dialog({ title: 'Документ отправлен', html: r.warnings.map(w => `<p>⚠ ${esc(w)}</p>`).join('') }, ok);
        toast(S.queue.length ? 'Нет связи: документ сохранён и уйдёт позже' : 'Документ отправлен, остатки обновлены');
      });
    };
    const finish = lines => askSurname().then(s => { if (s) submit(lines, s); });
    if (d.mode !== 'inventory') return finish(d.lines);
    const counted = new Set(d.lines.map(l => l.article));
    const left = expectedInZone(d.zone).filter(i => !counted.has(i.article));
    if (!left.length) return finish(d.lines);
    dialog({ title: `Не посчитано: ${left.length}`, html: `<div class="muted">${left.slice(0, 12).map(i => esc(i.name)).join(', ')}${left.length > 12 ? '…' : ''}</div><p>Считать непосчитанные позиции нулевыми?</p>` },
      [{ label: 'Да, остаток 0', value: 'zero' }, { label: 'Нет, только посчитанные', cls: 'sec', value: 'skip' }, { label: 'Вернуться к подсчёту', cls: 'danger', value: 'back' }]).then(a => {
      if (a !== 'back') finish(a === 'zero' ? d.lines.concat(left.map(i => ({ article: i.article, qty: 0, at: Date.now() }))) : d.lines);
    });
  }

  /** Смена типа перемещения (и ларей) прямо в заполняемом документе; позиции сохраняются. */
  function editType() {
    const d = S.doc; if (!d || d.mode !== 'move') return;
    pauseScan();
    const ed = { direction: d.direction, zone: d.zone, zoneTo: d.zoneTo || '' };
    const sync = () => { const a = $('#e-zone'), b = $('#e-zone2'); if (a) ed.zone = a.value; if (b) ed.zoneTo = b.value; };
    const done = changed => {
      closeOverlay();
      if (S.screen === 'doc') return render();
      const c = $('.ctx'); if (c && changed) c.innerHTML = ctxHtml(d);
      resumeScan();
    };
    const draw = err => {
      const dir = ed.direction;
      const o = overlay(`<h2>Тип перемещения</h2>
        <div class="seg"><button class="in${dir === 'in' ? ' on' : ''}" data-e="in">Производство<br>→ Склад</button><button class="out${dir === 'out' ? ' on' : ''}" data-e="out">Склад<br>→ Производство</button><button class="zone zn${dir === 'zone' ? ' on' : ''}" data-e="zone">Между ларями</button></div>
        <label class="f">${dir === 'zone' ? 'Из ларя (откуда)' : 'Место хранения на складе'}<select id="e-zone">${zoneOptions(ed.zone)}</select></label>
        ${dir === 'zone' ? `<label class="f">В ларь (куда)<select id="e-zone2">${zoneOptions(ed.zoneTo)}</select></label>` : ''}
        <div class="muted">Уже добавленные позиции (${d.lines.length}) сохранятся.</div>
        <div class="err">${esc(err || '')}</div>
        <button class="btn" data-e="save">Применить</button><button class="btn danger" data-e="cancel">Отмена</button>`);
      o.onclick = e => {
        const b = e.target.closest('[data-e]'); if (!b) return;
        const v = b.dataset.e; sync();
        if (v === 'cancel') return done(false);
        if (v !== 'save') { ed.direction = v; return draw(); }
        const tr = ed.direction === 'zone';
        if (!ed.zone) return draw(tr ? 'Выберите ларь, откуда перемещаем' : 'Выберите место хранения');
        if (tr && !ed.zoneTo) return draw('Выберите ларь, куда перемещаем');
        if (tr && ed.zoneTo === ed.zone) return draw('Ларь-источник и ларь-получатель должны различаться');
        Object.assign(d, { direction: ed.direction, zone: ed.zone, zoneTo: tr ? ed.zoneTo : '' });
        saveDraft(); done(true);
      };
    };
    draw();
  }

  function beginDoc() {
    const st = S.setup, ap = $('#f-apply');
    st.zone = $('#f-zone').value; if (ap) st.apply = ap.checked;
    const z2 = $('#f-zone2'), tr = st.mode === 'move' && st.direction === 'zone';
    st.zoneTo = tr && z2 ? z2.value : '';
    if (!st.zone) { S.err = tr ? 'Выберите ларь, откуда перемещаем' : 'Выберите место хранения'; return render(); }
    if (tr && !st.zoneTo) { S.err = 'Выберите ларь, куда перемещаем'; return render(); }
    if (tr && st.zoneTo === st.zone) { S.err = 'Ларь-источник и ларь-получатель должны различаться'; return render(); }
    if (S.doc && S.doc.lines.length && !confirm('Есть неотправленный черновик. Заменить его новым документом?')) return go('menu');
    S.doc = { id: uid(), mode: st.mode, direction: st.mode === 'move' ? st.direction : null, zone: st.zone, zoneTo: st.zoneTo || '', apply: !!st.apply, lines: [] };
    saveDraft(); go('scan', { scanMode: 'doc' });
  }

  /* ───────── печать этикеток ───────── */
  function printLabels() {
    const sel = S.items.filter(i => S.sel[i.article]);
    if (!sel.length) return toast('Отметьте позиции галочками', true);
    const o = overlay(`<h2>Печать этикеток</h2><div class="muted">Позиций: ${sel.length}. Формат ${S.label.w}×${S.label.h} мм (меняется в настройках).</div>
      <label class="f">Копий каждой<input type="number" id="p-n" inputmode="numeric" value="1" min="1" max="50"></label>
      <label class="f">Дата на этикетке<input type="text" id="p-d" value="${fmtDate(Date.now()).slice(0, 10)}"></label>
      <button class="btn" data-pr="ok">Печать</button><button class="btn danger" data-pr="cancel">Отмена</button>`);
    o.onclick = e => {
      const b = e.target.closest('[data-pr]'); if (!b) return;
      if (b.dataset.pr === 'cancel') return closeOverlay();
      b.disabled = true;
      const copies = Math.max(1, Math.min(50, parseInt($('#p-n').value, 10) || 1)), date = $('#p-d').value;
      // у позиции без QR кодом становится артикул — сохраняем в справочник
      Promise.all(sel.filter(i => !i.qr).map(i => bindQr(i, i.article)))
        .then(() => { closeOverlay(); doPrint(sel, copies, date); })
        .catch(e2 => { b.disabled = false; toast(e2.message, true); });
    };
  }
  function doPrint(items, copies, date) {
    const { w, h } = S.label, q = Math.min(h - 3, Math.round(w * 0.5));
    let st = $('#print-style');
    if (!st) { st = document.createElement('style'); st.id = 'print-style'; document.head.appendChild(st); }
    st.textContent = `@page{size:${w}mm ${h}mm;margin:0}@media print{.lbl{width:${w}mm;height:${h}mm}.lbl .qr{width:${q}mm;height:${q}mm}}`;
    $('#print').innerHTML = items.map(it => {
      const qr = new QRCodeLib.QRCode(-1, QRCodeLib.ECL.M); qr.addData(it.qr); qr.make();
      const n = qr.getModuleCount();
      let path = '';
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) path += `M${c} ${r}h1v1h-1z`;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><path d="${path}"/></svg>`;
      return `<div class="lbl"><div class="qr">${svg}</div><div class="txt"><b>${esc(it.name)}</b><span>${esc(it.article)}${date ? ' · ' + esc(date) : ''}</span></div></div>`.repeat(copies);
    }).join('');
    setTimeout(() => window.print(), 150);
  }

  /* ───────── обработчики ───────── */
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]'); if (!el) return;
    const i = +el.dataset.i;
    switch (el.dataset.act) {
      case 'login': return doLogin();
      case 'back':
        if (S.screen === 'feedback') return go('settings');
        if (S.screen === 'doc') return go('scan');
        if (S.screen === 'scan') return S.scanMode === 'bind' ? go('qr') : S.doc && S.doc.lines.length ? go('doc') : go('menu');
        return go('menu');
      case 'start-move': S.setup = { mode: 'move', direction: 'in', zone: '' }; return go('setup');
      case 'start-inv': if (!isKeeper()) return; S.setup = { mode: 'inventory', zone: '', apply: false }; return go('setup');
      case 'resume': return go(S.doc.lines.length ? 'doc' : 'scan', { scanMode: 'doc' });
      case 'dir': { S.setup.direction = el.dataset.v; S.setup.zone = $('#f-zone').value; const z2 = $('#f-zone2'); if (z2) S.setup.zoneTo = z2.value; return render(); }
      case 'begin': return beginDoc();
      case 'torch': return toggleTorch();
      case 'search': pauseScan(); return pickItem('Найти позицию', isKeeper(), it => lineForm(it), resumeScan);
      case 'doc': return go('doc');
      case 'edit-type': return editType();
      case 'scan-more': return go('scan', { scanMode: 'doc' });
      case 'edit-line': { const l = S.doc.lines[i]; return lineForm(itemBy(l.article) || { article: l.article, name: l.article, unit: '' }, l.qty, i); }
      case 'del-line': S.doc.lines.splice(i, 1); saveDraft(); return render();
      case 'discard': if (confirm('Удалить черновик документа?')) { S.doc = null; saveDraft(); go('menu'); } return;
      case 'send': return sendDoc();
      case 'stock': S.q = ''; S.cat = ''; go('stock'); return loadData().then(() => { if (S.screen === 'stock') render(); }).catch(() => { });
      case 'refresh': return loadData().then(() => { render(); toast('Обновлено'); }).catch(e2 => toast(e2.message, true));
      case 'qr': if (!isKeeper()) return; S.q = ''; return go('qr');
      case 'bind': if (!isKeeper()) return; S.bindItem = itemBy(el.dataset.a); return go('scan', { scanMode: 'bind' });
      case 'print': return isKeeper() ? printLabels() : undefined;
      case 'settings': return go('settings');
      case 'feedback': return go('feedback');
      case 'fb-send': return sendFeedback();
      case 'q-del': S.queue.splice(i, 1); saveQueue(); return render();
      case 'q-retry': S.queue.forEach(d => { delete d.error; }); saveQueue();
        return syncQueue().then(r => { render(); toast(r.errors.length ? r.errors[0] : S.queue.length ? 'Нет связи' : 'Отправлено', !!r.errors.length); });
      case 'logout': if (!S.queue.length || confirm('Есть неотправленные документы. Всё равно выйти?')) logout(); return;
    }
  });

  document.addEventListener('input', e => {
    const t = e.target;
    if (t.id === 'f-q') { S.q = t.value; const pos = t.selectionStart; render(); const n = $('#f-q'); n.focus(); n.setSelectionRange(pos, pos); }
    if (t.id === 'f-lw' || t.id === 'f-lh') { S.label = { w: +$('#f-lw').value || 58, h: +$('#f-lh').value || 40 }; LS.set('label', S.label); }
  });
  document.addEventListener('change', e => {
    const t = e.target;
    if (t.id === 'f-zone') {
      S.setup.zone = t.value;
      const z = S.zones.find(z => z.name === t.value);
      $('#zone-owner').textContent = z && z.owner ? 'Ответственный: ' + z.owner : '';
    }
    if (t.classList.contains('selbox')) S.sel[t.dataset.a] = t.checked;
    if (t.id === 'f-zone2') S.setup.zoneTo = t.value;
    if (t.id === 'f-cat') { S.cat = t.value; render(); }
    if (t.id === 'f-nz') { S.nz = t.checked; render(); }
  });
  document.addEventListener('submit', e => {
    if (e.target.id !== 'manual') return;
    e.preventDefault();
    const v = $('#f-code').value.trim(); if (!v) return;
    $('#f-code').value = ''; pauseScan(); onCode(v);
  });
  document.addEventListener('keydown', e => { if (e.key === 'Enter' && S.screen === 'login' && e.target.tagName === 'INPUT') doLogin(); });
  window.addEventListener('online', () => { S.online = true; renderBadge(); syncQueue(); });
  window.addEventListener('offline', () => { S.online = false; renderBadge(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopCamera(); else if (S.screen === 'scan') startCamera(); });

  /* ───────── запуск ───────── */
  LS.del('url'); // адрес сервера больше не хранится на телефоне, только config.js
  if (!('BarcodeDetector' in window)) loadFallbackLibs().catch(() => { }); // заранее, чтобы библиотеки попали в кэш и работали офлайн
  if (S.token && S.user) {
    S.screen = 'menu'; render();
    loadData().then(() => { if (S.screen === 'menu') render(); }).catch(e => { if (e.auth) logout(true); });
    syncQueue();
  } else render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
})();
