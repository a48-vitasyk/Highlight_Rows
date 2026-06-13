// popup.js — читає/записує settings (storage.sync). content.js реагує миттєво
// через chrome.storage.onChanged. Заглушення будильників пише reminderState
// у storage.local окремо (діє одразу, без «Зберегти»).

const DEFAULT_SETTINGS = {
    names: [],
    enabled: true,
    thresholdMinutes: 10,
    repeatMinutes: 0,
    color: '#ffac5a',
    soundEnabled: true,
    tagRules: [],
    reminderColor: '#ff5a5a',
    reminders: [],
    snoozeMinutes: 10,
    escalateMinutes: 10,
    reminderSound: 'beep',
    alertSound: 'beep',
    soundVolume: 1,
    notifyMode: 'stack',
    notifyMax: 3,
    replyWatch: false,
    staleEnabled: false,
    staleHours: 4,
    trafficEnabled: false,
    serviceShow: { status: true, os: true, cost: true, expiredate: true, traffic: true },
    reverseEnabled: false,
    resizeEnabled: false,
    resizePx: 300,
};

const SERVICE_KEYS = ['status', 'os', 'cost', 'expiredate', 'traffic'];

const $ = (id) => document.getElementById(id);

// Безпечна вставка SVG-іконки (через DOMParser, без innerHTML — щоб не чіпляв
// статичний аналізатор AMO). svg — рядок виду '<svg …>…</svg>'.
function setSvg(el, svg) {
    if (!el) return;
    el.textContent = '';
    if (!svg) return;
    // Без xmlns DOMParser(image/svg+xml) кладе <svg> у нульовий неймспейс і він
    // не рендериться — додаємо неймспейс SVG, якщо його немає.
    if (svg.indexOf('xmlns') === -1) svg = svg.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
    const node = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
    if (node && node.nodeName.toLowerCase() === 'svg') el.appendChild(document.importNode(node, true));
}

// Контекст відображення: 'panel' (бічна панель Chrome / сайдбар Firefox) задаємо
// через ?view=panel у side_panel/sidebar_action маніфесту. У попапі параметра немає.
const IS_PANEL = new URLSearchParams(location.search).get('view') === 'panel';
if (IS_PANEL && document.body) document.body.dataset.view = 'panel';

// Версія з маніфесту в шапку (без мережі).
{
    const verEl = $('appVersion');
    const ver = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '';
    if (verEl && ver) verEl.textContent = 'v' + ver;
}

// --- Тема (світла/темна) -------------------------------------------------
// hrTheme у storage.local: 'light' | 'dark' | відсутнє (= за системою).
function effectiveTheme(stored) {
    if (stored === 'light' || stored === 'dark') return stored;
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
}
function applyTheme(stored) {
    if (stored === 'light' || stored === 'dark') document.documentElement.setAttribute('data-theme', stored);
    else document.documentElement.removeAttribute('data-theme');
    const btn = $('themeBtn');
    if (btn) {
        const eff = effectiveTheme(stored);
        setSvg(btn, eff === 'dark' ? IC.sun : IC.moon);
        btn.title = eff === 'dark' ? 'Світла тема' : 'Темна тема';
    }
}
chrome.storage.local.get('hrTheme', (d) => applyTheme(d && d.hrTheme));
if ($('themeBtn')) $('themeBtn').addEventListener('click', () => {
    chrome.storage.local.get('hrTheme', (d) => {
        const next = effectiveTheme(d && d.hrTheme) === 'dark' ? 'light' : 'dark';
        chrome.storage.local.set({ hrTheme: next }, () => applyTheme(next));
    });
});

function genId() {
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

// --- Стан синку будильників ----------------------------------------------
// Явно видалені (× по рядку з бази) — щоб синк видаляв ЛИШЕ їх, а не «всіх, кого
// немає у формі» (інакше можна стерти чужі будильники, додані паралельно).
let removedIds = new Set();
// Чи є сесія — щоб «Загальний» (shared) був доступний лише залогіненим.
let isLoggedIn = false;
function applyScopeLock() {
    document.querySelectorAll('.scope-opt[data-scope="shared"]').forEach((b) => {
        b.classList.toggle('locked', !isLoggedIn);
        b.title = isLoggedIn ? 'Загальний (бачать усі)' : 'Увійдіть через Google, щоб робити загальні';
    });
}
function promptLogin() {
    const st = $('status');
    if (st) { st.textContent = 'Увійдіть через Google, щоб робити загальні'; setTimeout(() => { if (st.textContent.indexOf('Увійдіть') === 0) st.textContent = ''; }, 3000); }
    const lb = $('loginBtn');
    if (lb) { lb.classList.add('pulse'); setTimeout(() => lb.classList.remove('pulse'), 1600); }
}
// Незбережені правки в секції будильників — щоб live-оновлення не перетирало їх.
let remindersDirty = false;
function markRemindersDirty() { remindersDirty = true; }
// Під час власного збереження ігноруємо storage-подію (щоб не блимав reload-лінк).
let savingNow = false;

function isUuid(s) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));
}

// Тип будильника — сегмент-пілоу з двох опцій: 🔒 особистий / 👥 загальний.
// Монохромні SVG (currentColor): активна опція білим на акценті — контрастно.
const SVG_LOCK = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="11" width="15" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
const SVG_USERS = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';

function buildScopeSeg(row) {
    const seg = makeEl('div', { className: 'scope-seg' });
    const opts = [
        { v: 'personal', svg: SVG_LOCK, t: 'Особистий (лише ви)' },
        { v: 'shared', svg: SVG_USERS, t: 'Загальний (бачать усі)' },
    ];
    const sync = () => [...seg.children].forEach((c) => c.classList.toggle('active', c.dataset.scope === row.dataset.scope));
    opts.forEach((o) => {
        const b = makeEl('button', { type: 'button', className: 'scope-opt', title: o.t, innerHTML: o.svg });
        b.dataset.scope = o.v;
        b.addEventListener('click', () => {
            if (o.v === 'shared' && !isLoggedIn) { promptLogin(); return; } // лише для залогінених
            row.dataset.scope = o.v; sync(); markRemindersDirty();
        });
        seg.appendChild(b);
    });
    sync();
    applyScopeLock();
    return seg;
}

function showReloadLink() {
    if ($('reloadHint')) return;
    const link = makeEl('div', {
        id: 'reloadHint', className: 'hint',
        textContent: '↻ Список будильників змінено — натисніть, щоб оновити',
    });
    link.style.cssText = 'cursor:pointer;color:#1a76e2;font-weight:600';
    link.addEventListener('click', () => loadForm());
    const box = $('reminders');
    if (box && box.parentNode) box.parentNode.insertBefore(link, box);
}
function hideReloadLink() {
    const el = $('reloadHint');
    if (el) el.remove();
}

// --- Динамічні рядки -----------------------------------------------------

function makeEl(tag, props, children) {
    const el = document.createElement(tag);
    Object.assign(el, props || {});
    (children || []).forEach((c) => el.appendChild(c));
    return el;
}

// Монохромні SVG-іконки (currentColor) — єдиний стиль для всього попапа.
function svgIcon(inner, size) {
    return '<svg viewBox="0 0 24 24" width="' + (size || 16) + '" height="' + (size || 16) +
        '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
}
const IC = {
    bell: svgIcon('<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>'),
    bellOff: svgIcon('<path d="M13.73 21a2 2 0 0 1-3.46 0"/><path d="M18.63 13A17.9 17.9 0 0 1 18 8"/><path d="M6.26 6.26A5.9 5.9 0 0 0 6 8c0 7-3 9-3 9h14"/><path d="M18 8a6 6 0 0 0-9.33-5"/><line x1="2" y1="2" x2="22" y2="22"/>'),
    vol: svgIcon('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>'),
    volX: svgIcon('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>'),
    moon: svgIcon('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'),
    sun: svgIcon('<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.2" y1="4.2" x2="5.6" y2="5.6"/><line x1="18.4" y1="18.4" x2="19.8" y2="19.8"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.2" y1="19.8" x2="5.6" y2="18.4"/><line x1="18.4" y1="5.6" x2="19.8" y2="4.2"/>'),
    tag12: svgIcon('<path d="M20.59 13.41 13.42 20.59a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>', 12),
    lock12: svgIcon('<rect x="4.5" y="11" width="15" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', 12),
    clock12: svgIcon('<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>', 12),
    user12: svgIcon('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>', 12),
    user16: svgIcon('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
    userOff16: svgIcon('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="17" y1="8" x2="22" y2="13"/><line x1="22" y1="8" x2="17" y2="13"/>'),
    logout: svgIcon('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>'),
    bookmark: svgIcon('<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>', 14),
};

// Кнопка-тоглер: іконка показує стан (swap SVG), без заливки.
function setToggle(btn, on) {
    btn.classList.toggle('on', !!on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (btn._onHtml || btn._offHtml) setSvg(btn, on ? (btn._onHtml || '') : (btn._offHtml || ''));
}
function wireToggle(btn) { btn.addEventListener('click', () => setToggle(btn, !btn.classList.contains('on'))); }
function makeToggle(onHtml, offHtml, on, title) {
    const b = makeEl('button', { type: 'button', className: 'itoggle', title: title || '' });
    b._onHtml = onHtml; b._offHtml = offHtml;
    setToggle(b, on); wireToggle(b); return b;
}

// У Firefox нативний діалог кольору (input[type=color]) відкривається окремим
// вікном і popup закривається. Тож у Firefox замінюємо такі поля на інлайн-
// пікер: прев'ю + hex-поле + пресети (id/клас зберігаємо, щоб форма читалась).
const IS_FIREFOX = /firefox/i.test(navigator.userAgent || '');
const COLOR_PRESETS = ['#ffac5a', '#ff5a5a', '#ffd93b', '#7be25b', '#5ab0ff', '#c08bff', '#ffffff', '#b0b0b0'];

function firefoxifyColor(input) {
    if (!IS_FIREFOX || !input || input.type !== 'color') return;
    const val = input.value || '#ffac5a';

    const swatch = document.createElement('span');
    swatch.style.cssText = 'display:inline-block;width:16px;height:16px;border:1px solid #999;border-radius:3px;vertical-align:middle;margin-right:4px;background:' + val;

    const text = document.createElement('input');
    text.type = 'text';
    text.id = input.id;
    text.className = input.className;
    text.value = val;
    text.maxLength = 7;
    text.placeholder = '#rrggbb';
    text.style.width = '70px';
    text.style.verticalAlign = 'middle';

    const palette = document.createElement('span');
    palette.style.cssText = 'display:inline-flex;gap:3px;margin-left:6px;vertical-align:middle';
    COLOR_PRESETS.forEach((c) => {
        const sq = document.createElement('span');
        sq.title = c;
        sq.style.cssText = 'display:inline-block;width:14px;height:14px;border:1px solid #999;border-radius:3px;cursor:pointer;background:' + c;
        sq.addEventListener('click', () => { text.value = c; swatch.style.background = c; });
        palette.appendChild(sq);
    });

    text.addEventListener('input', () => { swatch.style.background = text.value; });
    input.replaceWith(swatch, text, palette);
}

function addTagRuleRow(rule) {
    const r = rule || { query: '', color: '#ffac5a', notify: true, sound: true, repeatMinutes: 0 };
    const query = makeEl('input', { type: 'text', className: 'tr-query', value: r.query, placeholder: '[TAG]' });
    const color = makeEl('input', { type: 'color', className: 'tr-color', value: r.color || '#ffac5a' });
    const notify = makeToggle(IC.bell, IC.bellOff, !!r.notify, 'Сповіщення');
    notify.classList.add('tr-notify');
    const sound = makeToggle(IC.vol, IC.volX, !!r.sound, 'Звук');
    sound.classList.add('tr-sound');
    const repeat = makeEl('input', {
        type: 'number', className: 'tr-repeat', value: r.repeatMinutes || 0,
        min: 0, step: 0.1, title: 'Повтор сигналу, хв (0 = один раз)',
    });
    const remove = makeEl('button', { type: 'button', className: 'small remove', textContent: '×' });

    const row = makeEl('div', { className: 'rule-row' }, [query, color, notify, sound, repeat, remove]);
    remove.addEventListener('click', () => row.remove());
    $('tagRules').appendChild(row);
    firefoxifyColor(color); // Firefox: інлайн-пікер замість нативного діалогу
}

function addReminderRow(reminder, muted) {
    const r = reminder || { id: genId(), ticketId: '', time: '', note: '', scope: 'personal' };
    const id = r.id || genId();
    const scope = r.scope === 'shared' ? 'shared' : 'personal';
    const ticket = makeEl('input', { type: 'text', className: 'rm-ticket', value: r.ticketId, placeholder: 'ID тікета' });
    const time = makeEl('input', { type: 'time', className: 'rm-time', value: r.time });
    const note = makeEl('input', { type: 'text', className: 'rm-note', value: r.note, placeholder: 'текст нагадування' });
    const mute = makeEl('button', { type: 'button', className: 'small mute' });
    setMuteBtn(mute, !!muted);
    const remove = makeEl('button', { type: 'button', className: 'small remove', textContent: '×', title: 'Видалити' });

    const row = makeEl('div', { className: 'rem-row' });
    row.dataset.id = id;
    row.dataset.scope = scope;
    const scopeSeg = buildScopeSeg(row);

    // Рядок 1: тікет, час, група дій (сегмент типу + заглушити + видалити).
    // Дії — один блок (.rem-actions), тож переносяться РАЗОМ, а поля тікета/часу
    // стискаються першими. .rm-note має flex-basis:100% → рядок 2; автор — рядок 3.
    const actions = makeEl('div', { className: 'rem-actions' }, [scopeSeg, mute, remove]);
    row.appendChild(ticket);
    row.appendChild(time);
    row.appendChild(actions);
    row.appendChild(note);
    if (scope === 'shared' && (r.creatorEmail || r.ownerEmail || r.doneAt)) {
        const auth = makeEl('div', { className: 'rem-author', innerHTML: IC.user12 });
        let txt = ' ' + (r.creatorEmail || '');
        if (r.doneAt) txt += ' · ✓ ' + (r.doneByEmail || '').split('@')[0];
        else if (r.ownerEmail) txt += ' · взяв ' + (r.ownerEmail || '').split('@')[0];
        auth.appendChild(document.createTextNode(txt));
        row.appendChild(auth);
    }

    [ticket, time, note].forEach((el) => el.addEventListener('input', markRemindersDirty));
    mute.addEventListener('click', () => toggleMute(id, mute));
    remove.addEventListener('click', () => {
        if (isUuid(row.dataset.id)) removedIds.add(row.dataset.id); // видалити в базі лише наявні там
        markRemindersDirty();
        row.remove();
    });
    $('reminders').appendChild(row);
}

// --- Заглушення / увімкнення (storage.local, миттєво) --------------------

function isMutedToday(state, id) {
    return !!(state && state[id] && state[id].mutedDate === todayStr());
}

// Кнопка показує ПОТОЧНИЙ стан: 🔔 — активний, 🔕 — заглушено на сьогодні.
function setMuteBtn(btn, muted) {
    setSvg(btn, muted ? IC.volX : IC.vol);
    btn.title = muted
        ? 'Заглушено сьогодні — клікніть, щоб увімкнути'
        : 'Активний — клікніть, щоб заглушити на сьогодні';
}

function toggleMute(id, btn) {
    chrome.storage.local.get('reminderState', async (data) => {
        const state = (data && data.reminderState) || {};
        const muted = isMutedToday(state, id);
        // Залогінений — заглушення спільне (колонка muted_date у базі).
        if (typeof SB !== 'undefined' && await SB.loggedIn()) {
            try { await SB.setMute(id, muted ? null : todayStr()); await SB.pull(); setMuteBtn(btn, !muted); }
            catch (e) { /* лишаємо як є */ }
            return;
        }
        if (muted) delete state[id];
        else state[id] = { mutedDate: todayStr() };
        chrome.storage.local.set({ reminderState: state }, () => setMuteBtn(btn, !muted));
    });
}

// --- Форма ---------------------------------------------------------------

function fillForm(s, reminderState) {
    $('enabled').checked = s.enabled;
    $('names').value = (s.names || [])[0] || '';
    $('thresholdMinutes').value = s.thresholdMinutes;
    $('repeatMinutes').value = s.repeatMinutes;
    $('color').value = s.color || DEFAULT_SETTINGS.color;
    setToggle($('soundEnabled'), s.soundEnabled);
    $('staleEnabled').checked = s.staleEnabled;
    $('staleHours').value = s.staleHours || DEFAULT_SETTINGS.staleHours;
    $('trafficEnabled').checked = s.trafficEnabled;
    $('reverseEnabled').checked = s.reverseEnabled;
    $('resizeEnabled').checked = s.resizeEnabled;
    $('resizePx').value = s.resizePx || DEFAULT_SETTINGS.resizePx;
    const sv = s.serviceShow || {};
    SERVICE_KEYS.forEach((k) => { const el = $('show_' + k); if (el) el.checked = sv[k] !== false; });
    $('reminderColor').value = s.reminderColor || DEFAULT_SETTINGS.reminderColor;
    $('snoozeMinutes').value = s.snoozeMinutes || DEFAULT_SETTINGS.snoozeMinutes;
    $('escalateMinutes').value = s.escalateMinutes || DEFAULT_SETTINGS.escalateMinutes;
    $('reminderSound').value = s.reminderSound || DEFAULT_SETTINGS.reminderSound;
    $('alertSound').value = s.alertSound || DEFAULT_SETTINGS.alertSound;
    $('soundVolume').value = Math.round((s.soundVolume != null ? s.soundVolume : 1) * 100);
    $('notifyMode').value = s.notifyMode === 'replace' ? 'replace' : 'stack';
    $('notifyMax').value = s.notifyMax || DEFAULT_SETTINGS.notifyMax;
    $('notifyMax').disabled = $('notifyMode').value === 'replace';
    $('replyWatch').checked = s.replyWatch;

    $('tagRules').innerHTML = '';
    (s.tagRules || []).forEach(addTagRuleRow);
    $('reminders').innerHTML = '';
    (s.reminders || []).forEach((r) => addReminderRow(r, isMutedToday(reminderState, r.id)));
}

function readForm() {
    const tagRules = [...document.querySelectorAll('#tagRules .rule-row')]
        .map((row) => ({
            query: row.querySelector('.tr-query').value.trim(),
            color: row.querySelector('.tr-color').value,
            notify: row.querySelector('.tr-notify').classList.contains('on'),
            sound: row.querySelector('.tr-sound').classList.contains('on'),
            repeatMinutes: Math.max(0, Number(row.querySelector('.tr-repeat').value) || 0),
        }))
        .filter((r) => r.query);

    const reminders = [...document.querySelectorAll('#reminders .rem-row')]
        .map((row) => ({
            id: row.dataset.id || genId(),
            ticketId: row.querySelector('.rm-ticket').value.trim(),
            time: row.querySelector('.rm-time').value.trim(),
            note: row.querySelector('.rm-note').value,
            scope: row.dataset.scope === 'shared' ? 'shared' : 'personal',
        }))
        .filter((r) => r.ticketId && r.time);

    return {
        enabled: $('enabled').checked,
        names: $('names').value.trim() ? [$('names').value.trim()] : [],
        thresholdMinutes: Number($('thresholdMinutes').value) || DEFAULT_SETTINGS.thresholdMinutes,
        repeatMinutes: Math.max(0, Number($('repeatMinutes').value) || 0),
        color: $('color').value,
        soundEnabled: $('soundEnabled').classList.contains('on'),
        staleEnabled: $('staleEnabled').checked,
        staleHours: Number($('staleHours').value) > 0 ? Number($('staleHours').value) : DEFAULT_SETTINGS.staleHours,
        trafficEnabled: $('trafficEnabled').checked,
        reverseEnabled: $('reverseEnabled').checked,
        resizeEnabled: $('resizeEnabled').checked,
        resizePx: Number($('resizePx').value) > 0 ? Number($('resizePx').value) : DEFAULT_SETTINGS.resizePx,
        serviceShow: {
            status: $('show_status').checked,
            os: $('show_os').checked,
            cost: $('show_cost').checked,
            expiredate: $('show_expiredate').checked,
            traffic: $('show_traffic').checked,
        },
        tagRules,
        reminderColor: $('reminderColor').value,
        snoozeMinutes: Number($('snoozeMinutes').value) > 0 ? Number($('snoozeMinutes').value) : DEFAULT_SETTINGS.snoozeMinutes,
        escalateMinutes: Number($('escalateMinutes').value) > 0 ? Number($('escalateMinutes').value) : DEFAULT_SETTINGS.escalateMinutes,
        reminderSound: $('reminderSound').value || 'beep',
        alertSound: $('alertSound').value || 'beep',
        soundVolume: Math.min(1, Math.max(0, (Number($('soundVolume').value) || 100) / 100)),
        notifyMode: $('notifyMode').value === 'replace' ? 'replace' : 'stack',
        notifyMax: Math.min(5, Math.max(1, Math.round(Number($('notifyMax').value) || DEFAULT_SETTINGS.notifyMax))),
        replyWatch: $('replyWatch').checked,
        reminders,
    };
}

// --- Список «без відповіді» (читаємо зі storage.local) -------------------

function fmtHours(h) {
    const hh = Math.floor(h);
    const mm = Math.round((h - hh) * 60);
    return `${hh}г ${mm}хв`;
}

function truncate(s, n) {
    s = s || '';
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function renderStaleTickets(arr) {
    const box = $('staleTickets');
    box.innerHTML = '';
    if (!arr || !arr.length) {
        box.appendChild(makeEl('div', { className: 'list-empty', textContent: 'Поки порожньо' }));
        return;
    }
    arr.forEach((t) => {
        const item = makeEl('div', { className: 'stale-item', title: t.subject + (t.client ? ' — ' + t.client : '') });
        item.appendChild(makeEl('span', { className: 'ti-num', textContent: '#' + t.ticketId }));
        item.appendChild(makeEl('span', {
            className: 'ti-age' + (t.noReply ? ' ti-age--warn' : ''),
            textContent: fmtHours(t.hours),
        }));
        item.appendChild(makeEl('span', { className: 'ti-text', textContent: truncate(t.subject, 30) }));
        makeClickable(item, t.url);
        box.appendChild(item);
    });
}

// Робить елемент списку клікабельним: відкриває тікет у тій самій вкладці.
// SPA відкриває форму через startform=… (func=… дає JSON), тож нормалізуємо.
function makeClickable(item, url) {
    const u = (url || '').replace('func=ticket.edit', 'startform=ticket.edit');
    if (!u) return;
    item.style.cursor = 'pointer';
    // Відкриваємо ПОДВІЙНИМ кліком — щоб одиночний клік по кнопках у рядку
    // (додати в «Мої тікети» / прибрати) не відкривав тікет.
    item.addEventListener('dblclick', () => {
        chrome.tabs.update({ url: u });
        if (!IS_PANEL) window.close(); // у панелі window.close() закрив би саму панель
    });
}

// Дрібна кнопка-дія в рядку списку (не запускає відкриття подвійним кліком).
function listActBtn(html, title, onClick) {
    const b = makeEl('button', { type: 'button', className: 'ti-act', title: title || '', innerHTML: html });
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    b.addEventListener('dblclick', (e) => e.stopPropagation());
    return b;
}

// --- «Мої тікети» (особистий список, storage.local) ----------------------
function addToMyTickets(t) {
    if (!t || !t.ticketId) return;
    chrome.storage.local.get('myTickets', (d) => {
        const arr = (d && d.myTickets) || [];
        if (arr.some((x) => x.ticketId === t.ticketId)) return; // вже є
        arr.push({ ticketId: t.ticketId, subject: t.subject || '', url: t.url || '' });
        chrome.storage.local.set({ myTickets: arr });
    });
}
function removeFromMyTickets(id) {
    chrome.storage.local.get('myTickets', (d) => {
        const arr = ((d && d.myTickets) || []).filter((x) => x.ticketId !== id);
        chrome.storage.local.set({ myTickets: arr });
    });
}
function renderMyTickets(arr) {
    const box = $('myTickets');
    if (!box) return;
    box.innerHTML = '';
    if (!arr || !arr.length) {
        box.appendChild(makeEl('div', { className: 'list-empty', textContent: 'Порожньо — додайте з «Мої тікети» кнопкою закладки' }));
        return;
    }
    arr.forEach((t) => {
        const item = makeEl('div', { className: 'stale-item', title: t.subject || '' });
        item.appendChild(makeEl('span', { className: 'ti-num', textContent: '#' + t.ticketId }));
        item.appendChild(makeEl('span', { className: 'ti-text', textContent: truncate(t.subject || '', 30) }));
        item.appendChild(listActBtn('×', 'Прибрати', () => removeFromMyTickets(t.ticketId)));
        makeClickable(item, t.url);
        box.appendChild(item);
    });
}

// --- Акаунт (спільна база) -----------------------------------------------

async function renderAccount() {
    const sess = (typeof SB !== 'undefined') ? await SB.getSession() : null;
    isLoggedIn = !!sess;
    applyScopeLock();
    const name = $('accountName');
    const loginBtn = $('loginBtn');
    const logoutBtn = $('logoutBtn');
    if (sess) {
        const email = (sess.user && sess.user.email) || '';
        if (name) {
            name.textContent = email ? email.split('@')[0] : 'акаунт'; // частина до @
            name.title = email || 'Залогінено';
            name.style.display = '';
        }
        if (loginBtn) loginBtn.style.display = 'none';
        if (logoutBtn) { logoutBtn.title = email ? ('Вийти — ' + email) : 'Вийти'; logoutBtn.style.display = ''; }
    } else {
        if (name) { name.style.display = 'none'; name.textContent = ''; }
        if (loginBtn) loginBtn.style.display = '';
        if (logoutBtn) logoutBtn.style.display = 'none';
    }
}

// --- Завантаження / збереження -------------------------------------------

function loadForm() {
    removedIds = new Set();
    remindersDirty = false;
    hideReloadLink();
    chrome.storage.local.get('reminderState', (local) => {
        const reminderState = (local && local.reminderState) || {};
        chrome.storage.sync.get(['settings', 'nameToHighlight'], (data) => {
            if (data.settings) {
                fillForm({ ...DEFAULT_SETTINGS, ...data.settings }, reminderState);
            } else if (data.nameToHighlight) {
                fillForm({ ...DEFAULT_SETTINGS, names: [data.nameToHighlight] }, reminderState);
            } else {
                fillForm(DEFAULT_SETTINGS, reminderState);
            }
            // Firefox: статичні поля кольору — на інлайн-пікер.
            firefoxifyColor($('color'));
            firefoxifyColor($('reminderColor'));
        });
    });
}

async function initPopup() {
    await renderAccount();
    if (typeof SB !== 'undefined' && SB.configured() && await SB.loggedIn()) {
        try { await SB.pull(); } catch (e) { /* офлайн/помилка — покажемо локальне дзеркало */ }
    }
    loadForm();
}
{ const se = $('soundEnabled'); if (se) { se._onHtml = IC.vol; se._offHtml = IC.volX; wireToggle(se); } }
initPopup();
initCardDnD();
initTabs();

// --- Верхні вкладки (активна зберігається локально) -----------------------
// --- Логи (аудит спільних будильників) ---
const LOG_ACTIONS = {
    create: 'створив', edit: 'змінив',
    scope_shared: 'зробив загальним', scope_personal: 'зробив особистим',
    mute: 'заглушив', unmute: 'увімкнув звук',
    snooze: 'відклав', snooze_clear: 'скасував відкладення',
    claim: 'взяв', release: 'віддав', done: 'відписав', reopen: 'знову відкрив',
    delete: 'видалив',
};
function logActionLabel(a) { return LOG_ACTIONS[a] || a || ''; }
function fmtLogTime(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getDate()) + '.' + p(d.getMonth() + 1) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function renderLogs(rows) {
    const box = $('logsList');
    if (!box) return;
    box.innerHTML = '';
    if (!rows || !rows.length) {
        box.appendChild(makeEl('div', { className: 'list-empty', textContent: 'Поки немає записів' }));
        return;
    }
    rows.forEach((r) => {
        const item = makeEl('div', { className: 'stale-item', title: r.details || '' });
        item.appendChild(makeEl('span', { className: 'log-when', textContent: fmtLogTime(r.at) }));
        item.appendChild(makeEl('span', { className: 'log-act', textContent: logActionLabel(r.action) }));
        item.appendChild(makeEl('span', { className: 'ti-num', textContent: '#' + (r.ticket_id || '') }));
        item.appendChild(makeEl('span', { className: 'ti-text', textContent: (r.actor_email || '').split('@')[0] }));
        box.appendChild(item);
    });
}
let logsCache = [];
function applyLogFilter() {
    const ql = (($('logsFilter') && $('logsFilter').value.trim()) || '').toLowerCase();
    const match = (r) => !ql || [r.ticket_id, r.action, logActionLabel(r.action), r.actor_email, r.details]
        .some((v) => String(v || '').toLowerCase().includes(ql));
    const rows = logsCache.filter(match).slice();
    const sort = ($('logsSort') && $('logsSort').value) || 'at_desc';
    const t = (r) => Date.parse(r.at) || 0;
    const num = (r) => { const n = parseInt(r.ticket_id, 10); return isNaN(n) ? 0 : n; };
    if (sort === 'at_asc') rows.sort((a, b) => t(a) - t(b));
    else if (sort === 'ticket') rows.sort((a, b) => num(b) - num(a) || t(b) - t(a));
    else if (sort === 'action') rows.sort((a, b) => String(a.action).localeCompare(String(b.action)) || t(b) - t(a));
    else if (sort === 'actor') rows.sort((a, b) => String(a.actor_email || '').localeCompare(String(b.actor_email || '')) || t(b) - t(a));
    else rows.sort((a, b) => t(b) - t(a)); // at_desc (новіші)
    renderLogs(rows);
}
// Статистика за сьогодні з завантажених логів.
function renderLogsStats() {
    const box = $('logsStats');
    if (!box) return;
    const today = todayStr();
    const isToday = (iso) => { const d = new Date(iso); return !isNaN(d) && `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` === today; };
    let created = 0, done = 0, claimed = 0;
    const per = {};
    for (const r of logsCache) {
        if (!isToday(r.at)) continue;
        const who = ((r.actor_email || '').split('@')[0]) || '—';
        per[who] = per[who] || { c: 0, d: 0 };
        if (r.action === 'create') { created++; per[who].c++; }
        else if (r.action === 'done') { done++; per[who].d++; }
        else if (r.action === 'claim') { claimed++; }
    }
    const perStr = Object.keys(per).sort().map((w) => `${w}: ✎${per[w].c} ✓${per[w].d}`).join(' · ');
    box.textContent = `Сьогодні — створено ${created} · взято ${claimed} · відписано ${done}` + (perStr ? '  |  ' + perStr : '');
}

function loadLogs() {
    const box = $('logsList');
    const st = $('logsStatus');
    if (!box) return;
    if (st) st.textContent = 'Завантаження…';
    try {
        chrome.runtime.sendMessage({ sb: 'logs', limit: 500 }, (resp) => {
            if (chrome.runtime.lastError) { if (st) st.textContent = 'помилка'; return; }
            if (!resp || !resp.ok) {
                if (st) st.textContent = '';
                logsCache = [];
                box.innerHTML = '';
                if ($('logsStats')) $('logsStats').textContent = '';
                const msg = (resp && resp.error === 'not-logged-in') ? 'Увійдіть через Google, щоб бачити логи' : 'Не вдалось завантажити';
                box.appendChild(makeEl('div', { className: 'list-empty', textContent: msg }));
                return;
            }
            if (st) st.textContent = '';
            logsCache = resp.rows || [];
            renderLogsStats();
            applyLogFilter();
        });
    } catch (e) { if (st) st.textContent = 'помилка'; }
}
if ($('refreshLogs')) $('refreshLogs').addEventListener('click', loadLogs);
if ($('logsFilter')) $('logsFilter').addEventListener('input', applyLogFilter);
if ($('logsSort')) $('logsSort').addEventListener('change', applyLogFilter);

function initTabs() {
    const tabs = [...document.querySelectorAll('.tab')];
    const panels = [...document.querySelectorAll('.tab-panel')];
    if (!tabs.length) return;
    const activate = (name) => {
        tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
        panels.forEach((p) => { p.hidden = p.dataset.panel !== name; });
        if (name === 'logs') loadLogs();
    };
    tabs.forEach((t) => t.addEventListener('click', () => {
        activate(t.dataset.tab);
        try { chrome.storage.local.set({ activeTab: t.dataset.tab }); } catch (e) { /* ignore */ }
    }));
    chrome.storage.local.get('activeTab', (d) => {
        const name = (d && d.activeTab) || 'home';
        if (tabs.some((t) => t.dataset.tab === name)) activate(name);
    });
}

// --- Перетягування блоків (порядок зберігається локально, для кожного) ----
function saveCardOrder(container) {
    const order = [...container.querySelectorAll('.card')].map((c) => c.dataset.card);
    try { chrome.storage.local.set({ cardOrder: order }); } catch (e) { /* ignore */ }
}

function cardAfter(container, y) {
    const items = [...container.querySelectorAll('.card:not(.dragging)')];
    let closest = null, closestOffset = -Infinity;
    for (const el of items) {
        const r = el.getBoundingClientRect();
        const offset = y - r.top - r.height / 2;
        if (offset < 0 && offset > closestOffset) { closestOffset = offset; closest = el; }
    }
    return closest;
}

function initCardDnD() {
    const container = $('cards');
    if (!container) return;

    // Відновити збережений порядок (storage.local — індивідуально на цей профіль).
    chrome.storage.local.get('cardOrder', (d) => {
        const order = (d && Array.isArray(d.cardOrder)) ? d.cardOrder : null;
        if (order) order.forEach((key) => {
            const c = container.querySelector('.card[data-card="' + key + '"]');
            if (c) container.appendChild(c); // переносимо в кінець у збереженому порядку
        });
    });

    let dragCard = null;
    container.querySelectorAll('.card').forEach((card) => {
        const head = card.querySelector('.card-head');
        if (!head || head.querySelector('.card-grip')) return;
        const grip = makeEl('span', { className: 'card-grip', textContent: '⠿', title: 'Перетягнути блок' });
        grip.setAttribute('draggable', 'true');
        head.insertBefore(grip, head.firstChild);
        grip.addEventListener('dragstart', (e) => {
            dragCard = card;
            card.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            try { e.dataTransfer.setData('text/plain', card.dataset.card || ''); } catch (x) { /* ignore */ }
            try { e.dataTransfer.setDragImage(card, 20, 16); } catch (x) { /* ignore */ }
        });
        grip.addEventListener('dragend', () => {
            card.classList.remove('dragging');
            dragCard = null;
            saveCardOrder(container);
        });
    });

    container.addEventListener('dragover', (e) => {
        if (!dragCard) return;
        e.preventDefault();
        const after = cardAfter(container, e.clientY);
        if (after == null) container.appendChild(dragCard);
        else if (after !== dragCard) container.insertBefore(dragCard, after);
    });
}

if ($('loginBtn')) $('loginBtn').addEventListener('click', async () => {
    const status = $('status');
    status.textContent = 'Вхід…';
    try {
        await SB.login();
        status.textContent = 'Увійшли';
        await renderAccount();
        loadForm();
    } catch (e) {
        status.textContent = 'Помилка входу: ' + (e && e.message ? e.message : e);
    }
    setTimeout(() => { status.textContent = ''; }, 3000);
});

if ($('logoutBtn')) $('logoutBtn').addEventListener('click', async () => {
    await SB.logout();
    await renderAccount();
    loadForm();
});

// «Відкрити збоку»: попап → бічна панель (Chrome) / сайдбар (Firefox). У самій
// панелі кнопка зайва — ховаємо. Виклик відкриття має йти від жесту (тут — клік).
if ($('expandBtn')) {
    if (IS_PANEL) $('expandBtn').style.display = 'none';
    $('expandBtn').addEventListener('click', async () => {
        try {
            const sp = chrome['side' + 'Panel']; // динамічний доступ: Chrome-only API
            if (sp && sp.open) {
                const win = await chrome.windows.getCurrent();
                await sp.open({ windowId: win.id });
                window.close();
            } else if (typeof browser !== 'undefined' && browser.sidebarAction) {
                await browser.sidebarAction.open();
                window.close();
            }
        } catch (e) { /* ignore */ }
    });
}

// Список «без відповіді»: показати поточний і оновлювати наживо.
let refreshTimeout = null;
function setRefreshing(on) {
    const btn = $('refreshStale');
    btn.disabled = on;
    btn.textContent = on ? 'Оновлюю…' : 'Оновити';
    clearTimeout(refreshTimeout);
    if (on) refreshTimeout = setTimeout(() => setRefreshing(false), 30000);
}

// --- Список збігів (теги/блокування/будильники, усі сторінки) ------------

function renderMatchTickets(arr) {
    const box = $('matchTickets');
    box.innerHTML = '';
    if (!arr || !arr.length) {
        box.appendChild(makeEl('div', { className: 'list-empty', textContent: 'Поки порожньо' }));
        return;
    }
    const map = { tag: IC.tag12, blocked: IC.lock12, reminder: IC.clock12 };
    arr.forEach((m) => {
        const item = makeEl('div', { className: 'stale-item', title: m.subject });
        const chips = makeEl('span', { className: 'ti-chips' });
        (m.kinds || []).forEach((k) => chips.appendChild(makeEl('span', { className: 'chip chip-' + k, innerHTML: map[k] || '' })));
        item.appendChild(chips);
        item.appendChild(makeEl('span', { className: 'ti-num', textContent: '#' + m.ticketId }));
        item.appendChild(makeEl('span', { className: 'ti-text', textContent: truncate(m.subject, 30) }));
        item.appendChild(listActBtn(IC.bookmark, 'Додати в «Тікети»', () => addToMyTickets({ ticketId: m.ticketId, subject: m.subject, url: m.url })));
        makeClickable(item, m.url);
        box.appendChild(item);
    });
}

chrome.storage.local.get(['staleTickets', 'matchTickets', 'staleScanStatus', 'matchScanStatus', 'myTickets'], (d) => {
    renderStaleTickets((d && d.staleTickets) || []);
    renderMatchTickets((d && d.matchTickets) || []);
    renderStaleStatus(d && d.staleScanStatus);
    renderMatchStatus(d && d.matchScanStatus);
    renderMyTickets((d && d.myTickets) || []);
});

// Лічильник біля «Оновити» в «Особисті тікети»: скільки тікетів зараз у списку.
function renderMatchStatus(s) {
    const el = $('matchStatus');
    if (!el) return;
    if (!s) { el.textContent = ''; return; }
    if (s.note) { el.textContent = s.note; return; }
    el.textContent = s.scanning ? 'Сканую…' : ('тікетів: ' + (s.count || 0));
}

// Індикатор біля «Оновити»: скільки тікетів просканували / пройшли поріг.
function renderStaleStatus(s) {
    const el = $('staleStatus');
    if (!el) return;
    if (!s) { el.textContent = ''; return; }
    if (s.note) { el.textContent = s.note; return; }
    el.textContent = s.scanning
        ? ('Сканую ' + (s.scanned || 0) + '/' + (s.total || 0) + ' · пройшло ' + (s.passed || 0))
        : ('Скановано ' + (s.scanned || 0) + ' · без відп. ' + (s.passed || 0));
}
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.staleTickets) {
        renderStaleTickets(changes.staleTickets.newValue || []);
        setRefreshing(false);
    }
    if (changes.matchTickets) {
        renderMatchTickets(changes.matchTickets.newValue || []);
    }
    if (changes.staleScanStatus) renderStaleStatus(changes.staleScanStatus.newValue);
    if (changes.matchScanStatus) renderMatchStatus(changes.matchScanStatus.newValue);
    if (changes.myTickets) renderMyTickets(changes.myTickets.newValue || []);
});

$('refreshMatches').addEventListener('click', () => {
    renderMatchStatus({ scanning: true, count: 0 });
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs && tabs[0];
        if (!tab) return;
        chrome.tabs.sendMessage(tab.id, { action: 'scanMatches' }, () => {
            if (chrome.runtime.lastError) renderMatchStatus({ note: 'відкрийте вкладку панелі Zomro' });
        });
    });
});

// Надсилає дію активній вкладці панелі (де живе content.js).
function sendToActiveTab(action) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs && tabs[0];
        if (!tab) return;
        chrome.tabs.sendMessage(tab.id, { action }, () => { void chrome.runtime.lastError; });
    });
}

// Ручне оновлення: просимо content.js (активна вкладка панелі) пересканувати.
$('refreshStale').addEventListener('click', () => {
    setRefreshing(true);
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs && tabs[0];
        if (!tab) { setRefreshing(false); return; }
        chrome.tabs.sendMessage(tab.id, { action: 'scanStaleTickets' }, () => {
            if (chrome.runtime.lastError) { // вкладка не панель / content.js не запущено
                setRefreshing(false);
                renderStaleStatus({ note: 'відкрийте вкладку панелі Zomro' });
            }
        });
    });
});

$('addTagRule').addEventListener('click', () => addTagRuleRow());
$('addReminder').addEventListener('click', () => { addReminderRow(); markRemindersDirty(); });

// Живе оновлення: коли спільні будильники змінились (синк/realtime оновив дзеркало),
// перемалювати форму — але не перетирати незбережені правки (тоді лише підказка).
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.settings) {
        if (savingNow) return; // власне збереження — не реагуємо
        if (remindersDirty) showReloadLink();
        else loadForm();
    }
});

$('save').addEventListener('click', async () => {
    const settings = readForm();
    const loggedIn = (typeof SB !== 'undefined') && await SB.loggedIn();
    savingNow = true;
    chrome.storage.sync.set({ settings }, async () => {
        chrome.storage.sync.remove('nameToHighlight');
        // Монітор «Без відповіді» вимкнено → прибрати список і статус одразу,
        // не чекаючи на вкладку Zomro з контент-скриптом.
        if (!settings.staleEnabled) {
            try { chrome.storage.local.set({ staleTickets: [], staleScanStatus: null }); } catch (e) { /* ignore */ }
        }
        const status = $('status');
        if (loggedIn) {
            status.textContent = 'Збереження…';
            // Будильники — у спільну базу (решта налаштувань лишається локальною).
            try {
                await SB.syncReminders(settings.reminders, [...removedIds]);
                status.textContent = 'Збережено (спільне)';
                loadForm(); // перемалювати рядки з реальними id (uuid) з бази — щоб mute/scope працювали одразу
            } catch (e) { status.textContent = 'Збережено локально; синк не вдався'; }
        } else {
            status.textContent = 'Збережено';
        }
        savingNow = false;
        setTimeout(() => { status.textContent = ''; }, 1800);
    });
});

// --- Звук: тест + завантаження свого + перемикач режиму сповіщень ---
const SOUND_BUILTIN = { beep: 'beep.wav', ding: 'sounds/ding.wav', double: 'sounds/double.wav' };
function popupPlaySound(which) {
    const sel = $(which === 'reminder' ? 'reminderSound' : 'alertSound').value;
    const vol = Math.min(1, Math.max(0, (Number($('soundVolume').value) || 100) / 100));
    const play = (src) => { try { const a = new Audio(src); a.volume = vol; a.play().catch(() => {}); } catch (e) { /* ignore */ } };
    if (sel === 'custom') {
        chrome.storage.local.get('soundData', (d) => { const sd = (d && d.soundData) || {}; play(sd[which] || chrome.runtime.getURL('beep.wav')); });
    } else {
        play(chrome.runtime.getURL(SOUND_BUILTIN[sel] || 'beep.wav'));
    }
}
if ($('testReminderSound')) $('testReminderSound').addEventListener('click', () => popupPlaySound('reminder'));
if ($('testAlertSound')) $('testAlertSound').addEventListener('click', () => popupPlaySound('alert'));

function wireSoundUpload(which, inputId, selectId) {
    const inp = $(inputId);
    if (!inp) return;
    inp.addEventListener('change', () => {
        const f = inp.files && inp.files[0];
        if (!f) return;
        if (f.size > 1024 * 1024) { $('status').textContent = 'Файл завеликий (макс 1 МБ)'; inp.value = ''; return; }
        const fr = new FileReader();
        fr.onload = () => {
            chrome.storage.local.get('soundData', (d) => {
                const sd = (d && d.soundData) || {};
                sd[which] = fr.result;
                chrome.storage.local.set({ soundData: sd }, () => {
                    $(selectId).value = 'custom';
                    $('status').textContent = 'Звук завантажено — натисніть «Зберегти»';
                    setTimeout(() => { $('status').textContent = ''; }, 2500);
                });
            });
        };
        fr.readAsDataURL(f);
    });
}
wireSoundUpload('reminder', 'reminderSoundFile', 'reminderSound');
wireSoundUpload('alert', 'alertSoundFile', 'alertSound');
if ($('reminderSoundUpload')) $('reminderSoundUpload').addEventListener('click', () => $('reminderSoundFile').click());
if ($('alertSoundUpload')) $('alertSoundUpload').addEventListener('click', () => $('alertSoundFile').click());

if ($('notifyMode')) $('notifyMode').addEventListener('change', () => { $('notifyMax').disabled = $('notifyMode').value === 'replace'; });

// --- Шаблони відповідей (спільні) — керування у Налаштуваннях ---
let lastSnipBody = null; // останнє сфокусоване поле тексту шаблону (для вставки чипів)
function insertAtCursor(el, text) {
    const start = el.selectionStart != null ? el.selectionStart : el.value.length;
    const end = el.selectionEnd != null ? el.selectionEnd : el.value.length;
    el.value = el.value.slice(0, start) + text + el.value.slice(end);
    const pos = start + text.length;
    el.focus();
    try { el.setSelectionRange(pos, pos); } catch (e) { /* ignore */ }
}
function renderSnippets() {
    const box = $('snippetsList');
    if (!box) return;
    box.innerHTML = '';
    if (!isLoggedIn) {
        box.appendChild(makeEl('div', { className: 'list-empty', textContent: 'Увійдіть через Google, щоб керувати шаблонами' }));
        return;
    }
    chrome.storage.local.get('snippets', (d) => {
        const list = (d && d.snippets) || [];
        box.innerHTML = '';
        if (!list.length) { box.appendChild(makeEl('div', { className: 'list-empty', textContent: 'Поки немає шаблонів' })); return; }
        list.forEach(addSnippetRow);
    });
}
function addSnippetRow(s) {
    s = s || { title: '', body: '' };
    const box = $('snippetsList');
    if (!box) return;
    const empty = box.querySelector('.list-empty');
    if (empty) empty.remove();
    const row = makeEl('div', { className: 'snip-row' });
    if (s.id) row.dataset.id = s.id;
    const title = makeEl('input', { type: 'text', className: 'snip-title', placeholder: 'Назва' });
    title.value = s.title || '';
    const body = makeEl('textarea', { className: 'snip-body', placeholder: 'Текст шаблону…' });
    body.value = s.body || '';
    body.addEventListener('focus', () => { lastSnipBody = body; });
    const save = makeEl('button', { type: 'button', className: 'small', textContent: '💾', title: 'Зберегти' });
    const del = makeEl('button', { type: 'button', className: 'small remove', textContent: '×', title: 'Видалити' });
    save.addEventListener('click', () => {
        const snippet = { id: row.dataset.id || undefined, title: title.value.trim(), body: body.value };
        if (!snippet.title && !snippet.body) return;
        const action = row.dataset.id ? 'snipUpdate' : 'snipAdd';
        $('status').textContent = 'Збереження…';
        try {
            chrome.runtime.sendMessage({ sb: action, snippet }, () => {
                void chrome.runtime.lastError;
                $('status').textContent = 'Шаблон збережено';
                setTimeout(() => { if ($('status').textContent === 'Шаблон збережено') $('status').textContent = ''; }, 1500);
                renderSnippets();
            });
        } catch (e) { /* ignore */ }
    });
    del.addEventListener('click', () => {
        if (row.dataset.id) {
            try { chrome.runtime.sendMessage({ sb: 'snipDel', id: row.dataset.id }, () => { void chrome.runtime.lastError; renderSnippets(); }); } catch (e) { /* ignore */ }
        } else { row.remove(); }
    });
    row.appendChild(title);
    row.appendChild(body);
    row.appendChild(save);
    row.appendChild(del);
    box.appendChild(row);
}
if ($('addSnippet')) $('addSnippet').addEventListener('click', () => addSnippetRow({}));
// Чипи підстановок: клік вставляє токен у поточне поле тексту шаблону.
document.querySelectorAll('#snipVars .chip-var').forEach((chip) => {
    chip.addEventListener('mousedown', (e) => e.preventDefault()); // не забирати фокус з textarea
    chip.addEventListener('click', () => {
        const a = document.activeElement;
        const el = (a && a.classList && a.classList.contains('snip-body')) ? a : lastSnipBody;
        if (!el) {
            $('status').textContent = 'Клікніть у текст шаблону, потім — підстановку';
            setTimeout(() => { if ($('status').textContent.indexOf('Клікніть') === 0) $('status').textContent = ''; }, 2500);
            return;
        }
        insertAtCursor(el, chip.dataset.token);
    });
});
// Початковий підтяг спільних шаблонів (оновити дзеркало) + рендер.
try { chrome.runtime.sendMessage({ sb: 'snipPull' }, () => { void chrome.runtime.lastError; renderSnippets(); }); } catch (e) { /* ignore */ }
