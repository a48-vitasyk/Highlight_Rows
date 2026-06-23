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
    replySound: 'beep',
    soundVolume: 1,
    notifyMode: 'stack',
    notifyMax: 3,
    replyWatch: false,
    replyWatchEscalate: false,
    replyEscalateMinutes: 5,
    replyRepeatMinutes: 1,
    replyWarnColor: '#ffd24a',
    replyDangerColor: '#ff3b30',
    quickReplies: true,
    quickHoldText: { uk: '', ru: '', en: '' },
    quickUpdText: { uk: '', ru: '', en: '' },
    updateEveryMinutes: 20,
    staleEnabled: false,
    staleHours: 4,
    awaitWaitMinutes: 30,
    premiumDepartments: ['Премиум', 'Преміум', 'Premium'],
    premiumSlaMinutes: 30,
    premiumDeptId: '493041',
    zomAiSoundMode: 'once',
    trafficEnabled: false,
    serviceShow: { status: true, os: true, cost: true, expiredate: true, traffic: true },
    reverseEnabled: false,
    resizeEnabled: false,
    resizePx: 300,
    myLang: 'uk',
    autoTranslateIncoming: false,
    snipSuggest: true,
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

// --- Шрифт інтерфейсу ----------------------------------------------------
// hrFont у storage.local: 'inter' (дефолт) | 'plex' | 'manrope' | 'system'.
const FONT_STACKS = {
    inter: "'Inter', 'Segoe UI', system-ui, sans-serif",
    plex: "'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif",
    manrope: "'Manrope', 'Segoe UI', system-ui, sans-serif",
    system: "system-ui, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
};
function applyFont(stored) {
    const key = FONT_STACKS[stored] ? stored : 'inter';
    document.documentElement.style.setProperty('--font', FONT_STACKS[key]);
    const sel = $('uiFont');
    if (sel) sel.value = key;
}
chrome.storage.local.get('hrFont', (d) => applyFont(d && d.hrFont));
if ($('uiFont')) $('uiFont').addEventListener('change', (e) => {
    const v = e.target.value;
    chrome.storage.local.set({ hrFont: v }, () => applyFont(v));
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

// --- Швидкі відповіді: мовні версії (UA/RU/EN) ---------------------------
let quickLang = 'uk';
const quickTexts = { hold: { uk: '', ru: '', en: '' }, upd: { uk: '', ru: '', en: '' } };
function quickNormObj(v) {
    return (v && typeof v === 'object')
        ? { uk: String(v.uk || ''), ru: String(v.ru || ''), en: String(v.en || '') }
        : { uk: String(v || ''), ru: '', en: '' }; // легасі: рядок → у поле uk
}
function quickRender() {
    if ($('quickHoldText')) $('quickHoldText').value = quickTexts.hold[quickLang] || '';
    if ($('quickUpdText')) $('quickUpdText').value = quickTexts.upd[quickLang] || '';
    document.querySelectorAll('#quickLangRow [data-qlang]').forEach((b) => b.classList.toggle('active', b.dataset.qlang === quickLang));
}
document.querySelectorAll('#quickLangRow [data-qlang]').forEach((b) => b.addEventListener('click', () => { quickLang = b.dataset.qlang; quickRender(); }));
if ($('quickHoldText')) $('quickHoldText').addEventListener('input', () => { quickTexts.hold[quickLang] = $('quickHoldText').value; });
if ($('quickUpdText')) $('quickUpdText').addEventListener('input', () => { quickTexts.upd[quickLang] = $('quickUpdText').value; });
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
// Список будильників: email поточного юзера (для «Мої»), фільтр і стан згортання груп.
let myEmailPopup = '';
let remFilter = 'all'; // 'all' | 'mine'
let remGroupsCollapsed = {}; // { overdue|today|tomorrow|later|closed: bool }
function saveRemGroupsCollapsed() { try { chrome.storage.local.set({ remGroupsCollapsed }); } catch (e) { /* ignore */ } }
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
    save: svgIcon('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>', 15),
    close: svgIcon('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', 15),
    trash: svgIcon('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>', 14),
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

    text.addEventListener('input', () => { swatch.style.background = text.value; });
    input.replaceWith(swatch, text); // лише прев'ю + код кольору, без заготовок
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

function pad2(n) { return String(n).padStart(2, '0'); }
// Значення поля будильника → для <input type="datetime-local"> ("YYYY-MM-DDTHH:MM").
// Підтримує: повний datetime (як є), легасі "HH:MM" (→ сьогодні), порожньо (→ зараз+1 год).
function toDatetimeLocal(time) {
    const s = String(time || '').trim();
    const ymd = (dt) => dt.getFullYear() + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate());
    const dt = /^(\d{4}-\d{2}-\d{2})T(\d{1,2}):(\d{2})$/.exec(s);
    if (dt) return dt[1] + 'T' + pad2(dt[2]) + ':' + dt[3];
    const hm = /^(\d{1,2}):(\d{2})$/.exec(s);
    if (hm) return ymd(new Date()) + 'T' + pad2(hm[1]) + ':' + hm[2];
    const later = new Date(Date.now() + 60 * 60000);
    return ymd(later) + 'T' + pad2(later.getHours()) + ':' + pad2(later.getMinutes());
}
// Ключ хронологічного сортування (легасі "HH:MM" → сьогодні), лексика = хронологія.
function whenKey(time) { return toDatetimeLocal(time); }
function ymdToday() { const d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
// Поле будильника → окремо дата (YYYY-MM-DD) і час (HH:MM) для компактного UI.
function splitWhen(time) {
    const s = String(time || '').trim();
    const dt = /^(\d{4}-\d{2}-\d{2})T(\d{1,2}):(\d{2})$/.exec(s);
    if (dt) return { date: dt[1], time: pad2(dt[2]) + ':' + dt[3] };
    const hm = /^(\d{1,2}):(\d{2})$/.exec(s);
    if (hm) return { date: ymdToday(), time: pad2(hm[1]) + ':' + hm[2] };
    const later = new Date(Date.now() + 60 * 60000); // новий будильник → сьогодні, зараз+1 год
    return { date: ymdToday(), time: pad2(later.getHours()) + ':' + pad2(later.getMinutes()) };
}
const ICON_CAL = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';

// Час спрацювання (ms) з поля time ("HH:MM" → сьогодні; повний datetime → той момент).
function reminderWhenMs(time) {
    const v = whenKey(time);
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v);
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0, 0).getTime() : null;
}
function dayBucket(time) {
    const ms = reminderWhenMs(time);
    if (ms == null) return 'later';
    if (ms < Date.now()) return 'overdue';
    const day = whenKey(time).slice(0, 10);
    const t = new Date(Date.now() + 86400000);
    const tmr = t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate());
    if (day === ymdToday()) return 'today';
    if (day === tmr) return 'tomorrow';
    return 'later';
}
// Короткий показ: "HH:MM" або "DD.MM HH:MM", якщо не сьогодні.
function fmtRemWhen(time) {
    const w = splitWhen(time);
    if (w.date === ymdToday()) return w.time;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(w.date);
    return (m ? m[3] + '.' + m[2] : w.date) + ' ' + w.time;
}
function remStatusChip(r) {
    if (r.doneAt) return { cls: 'done', text: '✓ закрито' };
    const ms = reminderWhenMs(r.time);
    if (ms != null && ms < Date.now()) return { cls: 'overdue', text: 'прострочено' };
    if (r.scope === 'shared' && r.ownerEmail) return { cls: 'owner', text: 'взяв ' + r.ownerEmail.split('@')[0] };
    if (r.scope === 'shared') return { cls: 'shared', text: 'спільний' };
    return null;
}

// Відкрити тікет будильника: активна вкладка панелі знаходить elid за номером і переходить.
function openReminderTicket(ticketId) {
    if (!ticketId) return;
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs && tabs[0];
        if (!tab) return;
        chrome.tabs.sendMessage(tab.id, { action: 'openTicket', ticketId: String(ticketId) }, () => {
            if (chrome.runtime.lastError) {
                const st = $('status');
                if (st) { st.textContent = 'Відкрийте вкладку панелі Zomro'; setTimeout(() => { if (st.textContent === 'Відкрийте вкладку панелі Zomro') st.textContent = ''; }, 3000); }
                return;
            }
            if (!IS_PANEL) window.close();
        });
    });
}
function addReminderRow(reminder, muted, opts) {
    opts = opts || {};
    const r = reminder || { id: genId(), ticketId: '', time: '', note: '', scope: 'personal' };
    const id = r.id || genId();
    const scope = r.scope === 'shared' ? 'shared' : 'personal';
    const ticket = makeEl('input', { type: 'text', className: 'rm-ticket', value: r.ticketId, placeholder: 'ID тікета' });
    const w = splitWhen(r.time);
    const time = makeEl('input', { type: 'time', className: 'rm-time', value: w.time });
    const dateInput = makeEl('input', { type: 'date', className: 'rm-date', value: w.date });
    const cal = makeEl('button', { type: 'button', className: 'small rm-cal', innerHTML: ICON_CAL });
    const syncCal = () => {
        const other = dateInput.value && dateInput.value !== ymdToday();
        cal.classList.toggle('set', !!other);
        cal.title = other ? ('Відкладено на ' + dateInput.value + ' — натисніть, щоб змінити') : 'Сьогодні · натисніть, щоб обрати інший день';
    };
    cal.addEventListener('click', (e) => {
        e.preventDefault();
        try { dateInput.showPicker(); } catch (err) { dateInput.style.cssText = 'width:auto;opacity:1;pointer-events:auto'; dateInput.focus(); }
    });
    dateInput.addEventListener('change', () => { syncCal(); markRemindersDirty(); });
    syncCal();
    const note = makeEl('input', { type: 'text', className: 'rm-note', value: r.note, placeholder: 'текст нагадування' });
    const mute = makeEl('button', { type: 'button', className: 'small mute' });
    setMuteBtn(mute, !!muted);

    const row = makeEl('div', { className: 'rem-row' });
    row.dataset.id = id;
    row.dataset.scope = scope;
    row.dataset.creator = r.creatorEmail || '';
    row.dataset.owner = r.ownerEmail || '';
    const scopeSeg = buildScopeSeg(row);

    // Підсумок (завжди видимий) — клік розгортає тіло-редактор; × видаляє.
    const summary = makeEl('div', { className: 'rem-summary' });
    summary.appendChild(makeEl('span', { className: 'rs-time', textContent: fmtRemWhen(r.time) }));
    const numEl = makeEl('span', { className: 'rs-num', textContent: r.ticketId ? '#' + r.ticketId : '—' });
    if (r.ticketId) {
        numEl.classList.add('rm-link');
        numEl.title = 'Відкрити тікет';
        numEl.addEventListener('click', (e) => { e.stopPropagation(); openReminderTicket(r.ticketId); });
    }
    summary.appendChild(numEl);
    summary.appendChild(makeEl('span', { className: 'rs-note', textContent: r.note || '' }));
    const chip = remStatusChip(r);
    if (chip) summary.appendChild(makeEl('span', { className: 'rs-chip rs-' + chip.cls, textContent: chip.text }));
    const del = makeEl('button', { type: 'button', className: 'rs-del', textContent: '×', title: 'Видалити' });
    summary.appendChild(del);
    summary.addEventListener('click', (e) => { if (e.target === del) return; row.classList.toggle('expanded'); });
    del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isUuid(row.dataset.id)) removedIds.add(row.dataset.id);
        markRemindersDirty();
        row.remove();
    });

    // Тіло-редактор: інпути (їх читає readForm незалежно від згортання/фільтра).
    const body = makeEl('div', { className: 'rem-body' });
    const actions = makeEl('div', { className: 'rem-actions' }, [scopeSeg, mute]);
    body.appendChild(ticket);
    body.appendChild(time);
    body.appendChild(cal);
    body.appendChild(dateInput);
    body.appendChild(actions);
    body.appendChild(note);
    if (scope === 'shared' && (r.creatorEmail || r.ownerEmail || r.doneAt)) {
        const auth = makeEl('div', { className: 'rem-author', innerHTML: IC.user12 });
        let txt = ' ' + (r.creatorEmail || '');
        if (r.doneAt) txt += ' · ✓ ' + (r.doneByEmail || '').split('@')[0];
        else if (r.ownerEmail) txt += ' · взяв ' + (r.ownerEmail || '').split('@')[0];
        auth.appendChild(document.createTextNode(txt));
        body.appendChild(auth);
    }

    row.appendChild(summary);
    row.appendChild(body);
    if (opts.expanded) row.classList.add('expanded');

    [ticket, time, note].forEach((el) => el.addEventListener('input', markRemindersDirty));
    mute.addEventListener('click', () => toggleMute(id, mute));
    (opts.container || $('reminders')).appendChild(row);
    return row;
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
    premiumSlaMin = s.premiumSlaMinutes || DEFAULT_SETTINGS.premiumSlaMinutes;
    if ($('premiumSlaMinutes')) $('premiumSlaMinutes').value = s.premiumSlaMinutes || DEFAULT_SETTINGS.premiumSlaMinutes;
    if (premiumCache.length) renderPremiumList(premiumCache);
    if ($('premiumDepartments')) $('premiumDepartments').value = (Array.isArray(s.premiumDepartments) ? s.premiumDepartments : DEFAULT_SETTINGS.premiumDepartments).join(', ');
    if ($('premiumDeptId')) $('premiumDeptId').value = s.premiumDeptId || DEFAULT_SETTINGS.premiumDeptId;
    if ($('zomAiSoundMode')) $('zomAiSoundMode').value = ['off', 'once', 'loop'].indexOf(s.zomAiSoundMode) !== -1 ? s.zomAiSoundMode : 'once';
    if ($('awaitWaitMinutes')) $('awaitWaitMinutes').value = s.awaitWaitMinutes || DEFAULT_SETTINGS.awaitWaitMinutes;
    $('trafficEnabled').checked = s.trafficEnabled;
    $('reverseEnabled').checked = s.reverseEnabled;
    $('resizeEnabled').checked = s.resizeEnabled;
    $('resizePx').value = s.resizePx || DEFAULT_SETTINGS.resizePx;
    if ($('snipSuggest')) $('snipSuggest').checked = s.snipSuggest !== false;
    if ($('myLang')) $('myLang').value = ['uk', 'ru', 'en'].indexOf(s.myLang) !== -1 ? s.myLang : 'uk';
    if ($('autoTranslateIncoming')) $('autoTranslateIncoming').checked = !!s.autoTranslateIncoming;
    const sv = s.serviceShow || {};
    SERVICE_KEYS.forEach((k) => { const el = $('show_' + k); if (el) el.checked = sv[k] !== false; });
    $('reminderColor').value = s.reminderColor || DEFAULT_SETTINGS.reminderColor;
    $('snoozeMinutes').value = s.snoozeMinutes || DEFAULT_SETTINGS.snoozeMinutes;
    $('escalateMinutes').value = s.escalateMinutes || DEFAULT_SETTINGS.escalateMinutes;
    $('reminderSound').value = s.reminderSound || DEFAULT_SETTINGS.reminderSound;
    $('alertSound').value = s.alertSound || DEFAULT_SETTINGS.alertSound;
    if ($('replySound')) $('replySound').value = s.replySound || DEFAULT_SETTINGS.replySound;
    $('soundVolume').value = Math.round((s.soundVolume != null ? s.soundVolume : 1) * 100);
    $('notifyMode').value = s.notifyMode === 'replace' ? 'replace' : 'stack';
    $('notifyMax').value = s.notifyMax || DEFAULT_SETTINGS.notifyMax;
    $('notifyMax').disabled = $('notifyMode').value === 'replace';
    $('replyWatch').checked = s.replyWatch;
    if ($('replyWatchEscalate')) $('replyWatchEscalate').checked = s.replyWatchEscalate;
    if ($('replyEscalateMinutes')) $('replyEscalateMinutes').value = s.replyEscalateMinutes || DEFAULT_SETTINGS.replyEscalateMinutes;
    if ($('replyRepeatMinutes')) $('replyRepeatMinutes').value = (s.replyRepeatMinutes != null ? s.replyRepeatMinutes : DEFAULT_SETTINGS.replyRepeatMinutes);
    if ($('quickReplies')) $('quickReplies').checked = s.quickReplies !== false;
    quickTexts.hold = quickNormObj(s.quickHoldText);
    quickTexts.upd = quickNormObj(s.quickUpdText);
    quickRender();
    if ($('updateEveryMinutes')) $('updateEveryMinutes').value = (s.updateEveryMinutes != null ? s.updateEveryMinutes : DEFAULT_SETTINGS.updateEveryMinutes);

    $('tagRules').innerHTML = '';
    (s.tagRules || []).forEach(addTagRuleRow);
    $('reminders').innerHTML = '';
    // Стабільне сортування за датою+часом (щоб не «стрибали»), далі — групи за днем.
    const rems = (s.reminders || []).slice().sort((a, b) => {
        const ka = whenKey(a.time), kb = whenKey(b.time);
        return ka !== kb ? (ka < kb ? -1 : 1) : String(a.ticketId || '').localeCompare(String(b.ticketId || ''));
    });
    const groups = { overdue: [], today: [], tomorrow: [], later: [], closed: [] };
    for (const r of rems) {
        if (r.scope === 'shared' && r.doneAt) groups.closed.push(r);
        else groups[dayBucket(r.time)].push(r);
    }
    const GROUP_DEFS = [
        { key: 'overdue', title: 'Прострочені', openByDefault: true },
        { key: 'today', title: 'Сьогодні', openByDefault: true },
        { key: 'tomorrow', title: 'Завтра', openByDefault: false },
        { key: 'later', title: 'Пізніше', openByDefault: false },
        { key: 'closed', title: 'Закриті', openByDefault: false },
    ];
    for (const g of GROUP_DEFS) {
        const list = groups[g.key];
        if (!list.length) continue;
        const sec = makeEl('div', { className: 'rem-group' });
        sec.dataset.group = g.key;
        const head = makeEl('div', { className: 'rem-group-head' });
        head.appendChild(makeEl('span', { className: 'rgh-arrow', textContent: '▸' }));
        head.appendChild(makeEl('span', { className: 'rgh-title', textContent: g.title }));
        const count = makeEl('span', { className: 'rem-group-count', textContent: String(list.length) });
        head.appendChild(count);
        const bodyC = makeEl('div', { className: 'rem-group-body' });
        const collapsed = (g.key in remGroupsCollapsed) ? remGroupsCollapsed[g.key] : !g.openByDefault;
        sec.classList.toggle('collapsed', collapsed);
        head.addEventListener('click', () => {
            sec.classList.toggle('collapsed');
            remGroupsCollapsed[g.key] = sec.classList.contains('collapsed');
            saveRemGroupsCollapsed();
        });
        list.forEach((r) => addReminderRow(r, isMutedToday(reminderState, r.id), { container: bodyC }));
        sec.appendChild(head);
        sec.appendChild(bodyC);
        $('reminders').appendChild(sec);
    }
    applyRemFilter();
}
// Візуальний фільтр списку будильників: пошук (#тікет/нотатка) + «Мої/Усі».
// Лише ховає рядки — інпути лишаються в DOM, тож readForm зберігає все.
function remRowMine(row) {
    if (row.dataset.scope !== 'shared') return true; // особистий = мій
    return !!myEmailPopup && (row.dataset.creator === myEmailPopup || row.dataset.owner === myEmailPopup);
}
function applyRemFilter() {
    const q = (($('remSearch') && $('remSearch').value) || '').trim().toLowerCase();
    document.querySelectorAll('#reminders .rem-group').forEach((sec) => {
        let visible = 0;
        sec.querySelectorAll('.rem-row').forEach((row) => {
            const tkt = ((row.querySelector('.rm-ticket') || {}).value || '').toLowerCase();
            const note = ((row.querySelector('.rm-note') || {}).value || '').toLowerCase();
            const matchQ = !q || tkt.includes(q) || note.includes(q);
            const matchF = remFilter === 'all' || remRowMine(row);
            const show = matchQ && matchF;
            row.classList.toggle('rm-hidden', !show);
            if (show) visible++;
        });
        sec.style.display = visible ? '' : 'none';
        const cnt = sec.querySelector('.rem-group-count');
        if (cnt) cnt.textContent = String(visible);
    });
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
        .map((row) => {
            const t = (row.querySelector('.rm-time').value || '').trim();
            const dEl = row.querySelector('.rm-date');
            const d = ((dEl && dEl.value) || '').trim() || ymdToday();
            return {
                id: row.dataset.id || genId(),
                ticketId: row.querySelector('.rm-ticket').value.trim(),
                time: t ? (d + 'T' + t) : '', // дата+час разом ("YYYY-MM-DDTHH:MM")
                note: row.querySelector('.rm-note').value,
                scope: row.dataset.scope === 'shared' ? 'shared' : 'personal',
            };
        })
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
        awaitWaitMinutes: ($('awaitWaitMinutes') && Number($('awaitWaitMinutes').value) > 0) ? Number($('awaitWaitMinutes').value) : DEFAULT_SETTINGS.awaitWaitMinutes,
        premiumSlaMinutes: ($('premiumSlaMinutes') && Number($('premiumSlaMinutes').value) > 0) ? Number($('premiumSlaMinutes').value) : DEFAULT_SETTINGS.premiumSlaMinutes,
        premiumDepartments: (($('premiumDepartments') && $('premiumDepartments').value) || '').split(',').map((d) => d.trim()).filter(Boolean),
        premiumDeptId: (($('premiumDeptId') && $('premiumDeptId').value) || '').trim() || DEFAULT_SETTINGS.premiumDeptId,
        zomAiSoundMode: $('zomAiSoundMode') ? $('zomAiSoundMode').value : 'once',
        trafficEnabled: $('trafficEnabled').checked,
        reverseEnabled: $('reverseEnabled').checked,
        resizeEnabled: $('resizeEnabled').checked,
        resizePx: Number($('resizePx').value) > 0 ? Number($('resizePx').value) : DEFAULT_SETTINGS.resizePx,
        snipSuggest: $('snipSuggest') ? $('snipSuggest').checked : true,
        myLang: $('myLang') ? $('myLang').value : 'uk',
        autoTranslateIncoming: $('autoTranslateIncoming') ? $('autoTranslateIncoming').checked : false,
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
        replySound: $('replySound') ? ($('replySound').value || 'beep') : 'beep',
        soundVolume: Math.min(1, Math.max(0, (Number($('soundVolume').value) || 100) / 100)),
        notifyMode: $('notifyMode').value === 'replace' ? 'replace' : 'stack',
        notifyMax: Math.min(5, Math.max(1, Math.round(Number($('notifyMax').value) || DEFAULT_SETTINGS.notifyMax))),
        replyWatch: $('replyWatch').checked,
        replyWatchEscalate: $('replyWatchEscalate') ? $('replyWatchEscalate').checked : false,
        replyEscalateMinutes: Number($('replyEscalateMinutes') && $('replyEscalateMinutes').value) > 0 ? Number($('replyEscalateMinutes').value) : DEFAULT_SETTINGS.replyEscalateMinutes,
        replyRepeatMinutes: $('replyRepeatMinutes') ? Math.max(0, Number($('replyRepeatMinutes').value) || 0) : DEFAULT_SETTINGS.replyRepeatMinutes,
        quickReplies: $('quickReplies') ? $('quickReplies').checked : true,
        quickHoldText: { ...quickTexts.hold },
        quickUpdText: { ...quickTexts.upd },
        updateEveryMinutes: $('updateEveryMinutes') ? Math.max(0, Number($('updateEveryMinutes').value) || 0) : DEFAULT_SETTINGS.updateEveryMinutes,
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
function goToTab(name) { const b = document.querySelector('.tab[data-tab="' + name + '"]'); if (b) b.click(); }
// Передати тікет у Будильники (HeartBeat): додає рядок із часом +1 год і веде туди.
function addTicketToReminders(t) {
    const tid = String(t.ticketId || '').trim();
    if (!tid) return;
    const rows0 = [...document.querySelectorAll('#reminders .rm-ticket')];
    const exists = rows0.some((i) => i.value.trim() === tid);
    let row;
    if (!exists) {
        const d = new Date(Date.now() + 60 * 60 * 1000);
        const hhmm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
        row = addReminderRow({ id: genId(), ticketId: tid, time: hhmm, note: truncate(t.subject || '', 40), scope: 'personal' }, false, { expanded: true });
        markRemindersDirty();
    } else {
        row = [...document.querySelectorAll('#reminders .rem-row')].find((r) => { const i = r.querySelector('.rm-ticket'); return i && i.value.trim() === tid; });
        if (row) row.classList.add('expanded');
    }
    goToTab('home');
    if (row) {
        const g = row.closest('.rem-group'); if (g) g.classList.remove('collapsed'); // якщо в згорнутій групі
        row.classList.remove('rm-hidden'); // або сховано пошуком/фільтром
        row.scrollIntoView({ block: 'center' });
        const tm = row.querySelector('.rm-time'); if (tm) tm.focus();
    }
    const st = $('status');
    if (st) {
        st.textContent = exists ? 'Цей тікет уже в Будильниках' : 'Додано в Будильники — встановіть час і Зберегти';
        setTimeout(() => { if (/Будильник/.test(st.textContent)) st.textContent = ''; }, 3500);
    }
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
        item.appendChild(listActBtn(IC.bell, 'У будильник (HeartBeat)', () => addTicketToReminders(t)));
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
        myEmailPopup = email;
        if (name) {
            name.textContent = email ? email.split('@')[0] : 'акаунт'; // частина до @
            name.title = email || 'Залогінено';
            name.style.display = '';
        }
        if (loginBtn) loginBtn.style.display = 'none';
        if (logoutBtn) { logoutBtn.title = email ? ('Вийти — ' + email) : 'Вийти'; logoutBtn.style.display = ''; }
    } else {
        myEmailPopup = '';
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

// Статистика часу відповіді на клієнта (awaiting_logs): к-сть + сер. час, по людях.
function renderAwaitingStats(rows) {
    const box = $('awaitingStats');
    if (!box) return;
    const today = todayStr();
    const isToday = (iso) => { const d = new Date(iso); return !isNaN(d) && `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` === today; };
    const per = {};
    let total = 0, sum = 0;
    for (const r of (rows || [])) {
        if (!r || !isToday(r.at)) continue;
        const who = ((r.responder_email || '').split('@')[0]) || '—';
        const ms = Number(r.waited_ms) || 0;
        per[who] = per[who] || { n: 0, ms: 0 };
        per[who].n++; per[who].ms += ms;
        total++; sum += ms;
    }
    if (!total) { box.textContent = ''; return; }
    const fmt = (ms) => (ms / 60000).toFixed(1) + ' хв';
    const perStr = Object.keys(per).sort().map((w) => `${w}: ${per[w].n} (${fmt(per[w].ms / per[w].n)})`).join(' · ');
    box.textContent = `Відповіді сьогодні — ${total}, сер. ${fmt(sum / total)}` + (perStr ? '  |  ' + perStr : '');
}
function loadAwaitingStats() {
    const box = $('awaitingStats');
    if (!box) return;
    try {
        chrome.runtime.sendMessage({ sb: 'awLogs', limit: 500 }, (resp) => {
            if (chrome.runtime.lastError) return;
            if (!resp || !resp.ok) { box.textContent = ''; return; }
            renderAwaitingStats(resp.rows || []);
        });
    } catch (e) { /* ignore */ }
}
if ($('refreshLogs')) $('refreshLogs').addEventListener('click', () => { loadLogs(); loadAwaitingStats(); });
if ($('logsFilter')) $('logsFilter').addEventListener('input', applyLogFilter);
if ($('logsSort')) $('logsSort').addEventListener('change', applyLogFilter);

function initTabs() {
    const tabs = [...document.querySelectorAll('.tab')];
    const panels = [...document.querySelectorAll('.tab-panel')];
    if (!tabs.length) return;
    const activate = (name) => {
        tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
        panels.forEach((p) => { p.hidden = p.dataset.panel !== name; });
        if (name === 'settings') { loadLogs(); loadAwaitingStats(); } // логи й статистика — унизу «Налаштувань»
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
        // Одразу підтягуємо спільні шаблони/категорії (login робить лише pull будильників),
        // щоб новий користувач бачив усе спільне без перевідкриття попапа.
        renderSnippets();
        try { chrome.runtime.sendMessage({ sb: 'snipPull' }, () => { void chrome.runtime.lastError; renderSnippets(); }); } catch (e2) { /* ignore */ }
        try { chrome.runtime.sendMessage({ sb: 'catPull' }, () => { void chrome.runtime.lastError; }); } catch (e2) { /* ignore */ }
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

// --- Блок «Клієнт чекає» (локальний ручний скан, storage.local.awaitingScan) -----
let awaitingCache = [];
function fmtWaitMs(ms) {
    const min = Math.floor(ms / 60000);
    if (min < 60) return min + ' хв';
    return Math.floor(min / 60) + 'г ' + (min % 60) + 'хв';
}
function renderAwaitingList(arr) {
    awaitingCache = Array.isArray(arr) ? arr : [];
    const box = $('awaitingList');
    if (!box) return;
    const now = Date.now();
    const list = awaitingCache.slice().sort((a, b) => (a.clientMessageAt || 0) - (b.clientMessageAt || 0));
    const st = $('awaitingStatus');
    if (st) st.textContent = list.length ? ('Чекає: ' + list.length) : '';
    box.innerHTML = '';
    if (!list.length) { box.appendChild(makeEl('div', { className: 'list-empty', textContent: 'Поки порожньо' })); return; }
    list.forEach((a) => {
        const wait = now - (a.clientMessageAt || now);
        const subj = (a.subject || '').trim();
        const item = makeEl('div', { className: 'stale-item', title: subj || ('#' + a.ticketId) });
        item.appendChild(makeEl('span', { className: 'ti-num', textContent: '#' + a.ticketId }));
        item.appendChild(makeEl('span', { className: 'ti-age ti-age--warn', textContent: fmtWaitMs(wait) }));
        item.appendChild(makeEl('span', { className: 'ti-text', textContent: truncate(subj, 32) }));
        item.appendChild(listActBtn('×', 'Прибрати зі списку', () => awaitingRemove(a.ticketId)));
        makeClickable(item, a.url);
        box.appendChild(item);
    });
}
// --- Блок «Premium · перша відповідь» (storage.local.premiumScan) ----------------
let premiumCache = [];
let premiumSlaMin = 30;
function renderPremiumList(arr) {
    premiumCache = Array.isArray(arr) ? arr : [];
    const box = $('premiumList');
    if (!box) return;
    const now = Date.now();
    const slaMs = premiumSlaMin * 60000;
    // Невідписані зверху (хто довше чекає — вище), далі відписані (новіші зверху).
    const list = premiumCache.slice().sort((a, b) => {
        const aw = a.frtMs == null, bw = b.frtMs == null;
        if (aw !== bw) return aw ? -1 : 1;
        if (aw) return (a.client0 || 0) - (b.client0 || 0);
        return (b.createdAt || 0) - (a.createdAt || 0);
    });
    box.innerHTML = '';
    if (!list.length) { box.appendChild(makeEl('div', { className: 'list-empty', textContent: 'Поки порожньо' })); return; }
    list.forEach((t) => {
        const item = makeEl('div', { className: 'stale-item', title: (t.subject || '') + (t.client ? ' — ' + t.client : '') });
        item.appendChild(makeEl('span', { className: 'ti-num', textContent: '#' + t.ticketId }));
        let badge;
        if (t.frtMs == null) {
            const wait = now - (t.client0 || t.createdAt || now);
            badge = makeEl('span', { className: 'ti-age ' + (wait > slaMs ? 'ti-frt-breach' : 'ti-frt-wait'), textContent: 'очікує ' + fmtWaitMs(wait) });
        } else {
            badge = makeEl('span', { className: 'ti-age ' + (t.frtMs > slaMs ? 'ti-frt-breach' : 'ti-frt-ok'), textContent: fmtWaitMs(t.frtMs) });
        }
        item.appendChild(badge);
        item.appendChild(makeEl('span', { className: 'ti-text', textContent: truncate(t.subject || '', 32) }));
        makeClickable(item, t.url);
        box.appendChild(item);
    });
}
// --- ZomBro AI: блок хендофів (читає zomAiState, дії — на плашці) ----------
function renderZomAiList(state) {
    const box = $('zomAiList');
    if (!box) return;
    const map = state && typeof state === 'object' ? state : {};
    // Активні (з [HANDOFF], не відписані); невзяті зверху, далі взяті; новіші вище.
    const list = Object.keys(map).map((k) => map[k])
        .filter((x) => x && x.handoff && !x.done)
        .sort((a, b) => {
            if (!!a.taken !== !!b.taken) return a.taken ? 1 : -1;
            return (b.detectedAt || 0) - (a.detectedAt || 0);
        });
    box.innerHTML = '';
    if (!list.length) { box.appendChild(makeEl('div', { className: 'list-empty', textContent: 'Поки порожньо' })); return; }
    list.forEach((x) => {
        const item = makeEl('div', { className: 'stale-item', title: x.summary || '' });
        item.appendChild(makeEl('span', { className: 'ti-num', textContent: '#' + x.ticketId }));
        item.appendChild(makeEl('span', {
            className: 'ti-age ' + (x.taken ? 'ti-frt-ok' : 'ti-frt-breach'),
            textContent: x.taken ? 'взято' : 'новий',
        }));
        item.appendChild(makeEl('span', { className: 'ti-text', textContent: truncate(x.subject || '', 30) }));
        makeClickable(item, x.url);
        if (!x.taken) item.appendChild(listActBtn('Взяв', 'Я взяв цей', () => zomAiSend('zomAiTake', x.ticketId)));
        item.appendChild(listActBtn('Відписати', 'Відкрити тікет і прибрати сигнал', () => zomAiSend('zomAiDone', x.ticketId)));
        box.appendChild(item);
    });
}
// Дія над хендофом → активній вкладці панелі (content.js володіє zomAiState).
function zomAiSend(action, ticketId) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs && tabs[0];
        if (!tab) { renderZomAiStatus({ note: 'відкрийте вкладку панелі Zomro' }); return; }
        chrome.tabs.sendMessage(tab.id, { action, ticketId: String(ticketId) }, () => {
            if (chrome.runtime.lastError) renderZomAiStatus({ note: 'відкрийте вкладку панелі Zomro' });
        });
    });
}
function renderZomAiStatus(s) {
    const el = $('zomAiStatus'); const btn = $('refreshZomAi');
    if (btn) btn.disabled = !!(s && s.scanning);
    if (!el) return;
    if (!s) { el.textContent = ''; return; }
    if (s.note) { el.textContent = s.note; return; }
    if (s.scanning) { el.textContent = 'Перевіряю…'; return; }
    el.textContent = 'Активних: ' + (s.count || 0);
}
function renderPremiumStatus(s) {
    const el = $('premiumStatus'); const btn = $('refreshPremium'); const stop = $('stopPremium');
    const scanning = !!(s && s.scanning);
    if (btn) btn.disabled = scanning;       // ↻ = старт (вимкнено під час збору)
    if (stop) stop.hidden = !scanning;      // ⏹ показуємо лише під час збору
    if (!el) return;
    if (!s) { el.textContent = ''; el.title = ''; return; }
    if (s.loading) { el.textContent = 'Збираю тікети… ' + (s.total || 0); return; }
    if (s.scanning) { el.textContent = 'Збір ' + (s.scanned || 0) + '/' + (s.total || 0); return; }
    // Помилка без результату (фільтр не застосувався / розлогінено) — лише напис.
    if (s.note && !(s.total > 0)) { el.textContent = s.note; el.title = s.note; return; }
    // Є результат: завжди показуємо число; note (напр. «показано перші 100») — поряд.
    el.textContent = 'Знайдено: ' + (s.total || 0) + (s.note ? ' · ' + s.note : '');
    el.title = s.filter ? ('Фільтр billmgr: ' + s.filter) : ''; // звірка з білінгом (наведення)
}

// Прибрати тікет із локального списку (не чіпає Supabase — список локальний).
function awaitingRemove(ticketId) {
    awaitingCache = awaitingCache.filter((a) => String(a.ticketId) !== String(ticketId));
    renderAwaitingList(awaitingCache);
    try { chrome.storage.local.set({ awaitingScan: awaitingCache }); } catch (e) { /* ignore */ }
}
// Поки попап відкритий — оновлюємо лише ВІДОБРАЖЕНИЙ час очікування (без скану/мережі).
setInterval(() => renderAwaitingList(awaitingCache), 30000);
// «Оновити»: пере-перевірити awaitingMap через API — відписані зникнуть; блок
// оновиться сам (content.js публікує awaitingScan з awaitingMap). Розсилаємо на ВСІ
// вкладки: спрацює на будь-якій вкладці панелі (навіть фоновій / коли відкрита
// бічна панель), а не лише на активній — інакше було хибне «відкрийте вкладку».
function awaitingRefresh() {
    const st = $('awaitingStatus'); const btn = $('refreshAwaiting');
    if (st) st.textContent = 'Перевіряю…';
    if (btn) btn.disabled = true;
    chrome.tabs.query({}, (tabs) => {
        const ids = (tabs || []).map((t) => t.id).filter((x) => x != null);
        let pending = ids.length, anyOk = false;
        const finish = () => {
            if (btn) btn.disabled = false;
            if (!anyOk) { if (st) st.textContent = 'відкрийте вкладку панелі Zomro'; return; }
            setTimeout(() => { renderAwaitingList(awaitingCache); if (st && st.textContent === 'Перевіряю…') st.textContent = ''; }, 2500);
        };
        if (!pending) { finish(); return; }
        ids.forEach((id) => {
            try {
                chrome.tabs.sendMessage(id, { action: 'scanAwaiting' }, () => {
                    if (!chrome.runtime.lastError) anyOk = true;
                    if (--pending === 0) finish();
                });
            } catch (e) { if (--pending === 0) finish(); }
        });
    });
}
const _refreshAwaitingBtn = $('refreshAwaiting');
if (_refreshAwaitingBtn) _refreshAwaitingBtn.addEventListener('click', awaitingRefresh);
// «Очистити все» — очистити локальний список одним кліком (з підтвердженням).
function awaitingClearAll() {
    if (!awaitingCache.length) return;
    if (!confirm('Прибрати всі тікети (' + awaitingCache.length + ') з «Клієнт чекає»?')) return;
    awaitingCache = [];
    renderAwaitingList(awaitingCache);
    try { chrome.storage.local.set({ awaitingScan: [] }); } catch (e) { /* ignore */ }
}
const _clearAwaitingBtn = $('clearAwaiting');
if (_clearAwaitingBtn) _clearAwaitingBtn.addEventListener('click', awaitingClearAll);

chrome.storage.local.get(['staleTickets', 'matchTickets', 'staleScanStatus', 'matchScanStatus', 'myTickets', 'awaitingScan', 'awaitingScanStatus', 'premiumScan', 'premiumScanStatus', 'zomAiState', 'zomAiStatus'], (d) => {
    renderStaleTickets((d && d.staleTickets) || []);
    renderMatchTickets((d && d.matchTickets) || []);
    renderStaleStatus(d && d.staleScanStatus);
    renderMatchStatus(d && d.matchScanStatus);
    renderMyTickets((d && d.myTickets) || []);
    renderAwaitingList((d && d.awaitingScan) || []);
    renderAwaitingScanStatus(d && d.awaitingScanStatus);
    renderPremiumList((d && d.premiumScan) || []);
    renderPremiumStatus(d && d.premiumScanStatus);
    renderZomAiList((d && d.zomAiState) || {});
    renderZomAiStatus(d && d.zomAiStatus);
});
// Статус скану «Клієнт чекає»: примітки/помилки + лічильник; стан кнопки.
function renderAwaitingScanStatus(s) {
    const el = $('awaitingStatus'); const btn = $('refreshAwaiting');
    if (btn) btn.disabled = !!(s && s.scanning);
    if (!el || !s) return;
    if (s.note) { el.textContent = s.note; return; }
    if (s.scanning) { el.textContent = 'Сканую…'; return; }
    el.textContent = 'Чекає: ' + (s.passed || 0);
}

// Лічильник біля «Оновити» в «Особисті тікети»: скільки тікетів зараз у списку.
function renderMatchStatus(s) {
    const el = $('matchStatus');
    if (!el) return;
    if (!s) { el.textContent = ''; return; }
    if (s.note) { el.textContent = s.note; return; }
    if (s.scanning) { el.textContent = 'Сканую…' + (s.page ? ' стор. ' + s.page : '') + (s.count ? ' (' + s.count + ')' : ''); return; }
    el.textContent = 'тікетів: ' + (s.count || 0);
}

// Індикатор біля «Оновити»: скільки тікетів просканували / пройшли поріг.
function renderStaleStatus(s) {
    const el = $('staleStatus');
    if (!el) return;
    if (!s) { el.textContent = ''; return; }
    if (s.note) { el.textContent = s.note; return; }
    if (s.loading) { el.textContent = 'Завантажую чергу… ' + (s.total || 0) + ' тікетів'; return; }
    el.textContent = s.scanning
        ? ('Сканую ' + (s.scanned || 0) + '/' + (s.total || 0) + ' · пройшло ' + (s.passed || 0))
        : ('Скановано ' + (s.scanned || 0) + ' · без відп. ' + (s.passed || 0));
}
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.staleTickets) {
        renderStaleTickets(changes.staleTickets.newValue || []);
    }
    if (changes.matchTickets) {
        renderMatchTickets(changes.matchTickets.newValue || []);
    }
    if (changes.awaitingScan) {
        renderAwaitingList(changes.awaitingScan.newValue || []);
    }
    if (changes.awaitingScanStatus) {
        renderAwaitingScanStatus(changes.awaitingScanStatus.newValue);
    }
    if (changes.premiumScan) renderPremiumList(changes.premiumScan.newValue || []);
    if (changes.premiumScanStatus) renderPremiumStatus(changes.premiumScanStatus.newValue);
    if (changes.zomAiState) renderZomAiList(changes.zomAiState.newValue || {});
    if (changes.zomAiStatus) renderZomAiStatus(changes.zomAiStatus.newValue);
    if (changes.staleScanStatus) {
        const st = changes.staleScanStatus.newValue;
        renderStaleStatus(st);
        setRefreshing(!!(st && st.scanning)); // індикатор «Оновлюю…» живе, поки скан триває
    }
    if (changes.matchScanStatus) renderMatchStatus(changes.matchScanStatus.newValue);
    if (changes.myTickets) renderMyTickets(changes.myTickets.newValue || []);
    if (changes.snippets) renderSnippets();
    if (changes.snippetCats) { snipCatsCache = changes.snippetCats.newValue || []; }
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

// Ручна перевірка черги на хендофи ZomBro AI (активна вкладка панелі).
const _refreshZomAiBtn = $('refreshZomAi');
if (_refreshZomAiBtn) _refreshZomAiBtn.addEventListener('click', () => {
    renderZomAiStatus({ scanning: true });
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs && tabs[0];
        if (!tab) { renderZomAiStatus({ note: 'відкрийте вкладку панелі Zomro' }); return; }
        chrome.tabs.sendMessage(tab.id, { action: 'scanZomAi' }, () => {
            if (chrome.runtime.lastError) renderZomAiStatus({ note: 'відкрийте вкладку панелі Zomro' });
        });
    });
});

// --- Premium: вибір періоду (за датою створення) + «Оновити» (активна вкладка) ---
// Випадайка розширення → ключ періоду billmgr (message_post = «Дата сообщения»).
const PREMIUM_PERIOD_MAP = {
    thisWeek: 'currentweek', lastWeek: 'lastweek', thisMonth: 'currentmonth',
    lastMonth: 'lastmonth', quarter: 'quarter', '6m': 'halfyear', '1y': 'year', range: 'other',
};
function premiumRefresh() {
    const sel = ($('premiumPeriod') && $('premiumPeriod').value) || 'thisWeek';
    const period = PREMIUM_PERIOD_MAP[sel] || 'currentmonth';
    const msg = { action: 'scanPremium', period };
    if (period === 'other') { // діапазон → billmgr message_poststart/end (YYYY-MM-DD)
        msg.start = ($('premiumFrom') && $('premiumFrom').value) || '';
        msg.end = ($('premiumTo') && $('premiumTo').value) || '';
        if (!msg.start || !msg.end) { renderPremiumStatus({ note: 'оберіть обидві дати діапазону' }); return; }
    }
    try { chrome.storage.local.set({ premiumPeriod: sel }); } catch (e) { /* ignore */ }
    const st = $('premiumStatus'); if (st) st.textContent = 'Перевіряю…';
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs && tabs[0];
        if (!tab) { renderPremiumStatus({ note: 'відкрийте вкладку панелі Zomro' }); return; }
        chrome.tabs.sendMessage(tab.id, msg, () => {
            if (chrome.runtime.lastError) renderPremiumStatus({ note: 'відкрийте вкладку панелі Zomro' });
        });
    });
}
function premiumStop() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs && tabs[0];
        if (tab) { try { chrome.tabs.sendMessage(tab.id, { action: 'stopPremium' }, () => { void chrome.runtime.lastError; }); } catch (e) { /* ignore */ } }
    });
}
const _premiumPeriodSel = $('premiumPeriod');
// Зміна періоду одразу стартує збір (для «Діапазон…» — лише показує поля, старт по ↻).
if (_premiumPeriodSel) _premiumPeriodSel.addEventListener('change', () => {
    const range = document.querySelector('.premium-range');
    if (range) range.hidden = (_premiumPeriodSel.value !== 'range');
    try { chrome.storage.local.set({ premiumPeriod: _premiumPeriodSel.value }); } catch (e) { /* ignore */ }
    if (_premiumPeriodSel.value !== 'range') premiumRefresh();
});
// Діапазон: коли обидві дати задано — стартуємо.
['premiumFrom', 'premiumTo'].forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener('change', () => {
        if (($('premiumPeriod') || {}).value === 'range' && $('premiumFrom').value && $('premiumTo').value) premiumRefresh();
    });
});
const _refreshPremiumBtn = $('refreshPremium');
if (_refreshPremiumBtn) _refreshPremiumBtn.addEventListener('click', premiumRefresh); // ↻ = старт збору
const _stopPremiumBtn = $('stopPremium');
if (_stopPremiumBtn) _stopPremiumBtn.addEventListener('click', premiumStop);
chrome.storage.local.get('premiumPeriod', (d) => {
    const p = (d && d.premiumPeriod) || 'thisWeek';
    if ($('premiumPeriod')) $('premiumPeriod').value = p;
    const range = document.querySelector('.premium-range');
    if (range) range.hidden = (p !== 'range');
});
// Живий лічильник очікування для невідписаних (поки попап відкрито).
setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (premiumCache.some((t) => t && t.frtMs == null)) renderPremiumList(premiumCache);
}, 30000);

$('addTagRule').addEventListener('click', () => addTagRuleRow());
$('addReminder').addEventListener('click', () => { addReminderRow(undefined, false, { expanded: true }); markRemindersDirty(); });

// Тулбар будильників: пошук + фільтр «Мої/Усі» (стан памʼятаємо локально).
chrome.storage.local.get(['remFilter', 'remGroupsCollapsed'], (d) => {
    remFilter = (d && d.remFilter === 'mine') ? 'mine' : 'all';
    remGroupsCollapsed = (d && d.remGroupsCollapsed && typeof d.remGroupsCollapsed === 'object') ? d.remGroupsCollapsed : {};
    document.querySelectorAll('.rem-filter [data-remf]').forEach((b) => b.classList.toggle('active', b.dataset.remf === remFilter));
    // Якщо групи вже відмальовано до завантаження стану — застосувати збережене згортання.
    document.querySelectorAll('#reminders .rem-group').forEach((sec) => {
        if (sec.dataset.group in remGroupsCollapsed) sec.classList.toggle('collapsed', !!remGroupsCollapsed[sec.dataset.group]);
    });
    applyRemFilter();
});
if ($('remSearch')) $('remSearch').addEventListener('input', applyRemFilter);
document.querySelectorAll('.rem-filter [data-remf]').forEach((b) => {
    b.addEventListener('click', () => {
        remFilter = b.dataset.remf === 'mine' ? 'mine' : 'all';
        document.querySelectorAll('.rem-filter [data-remf]').forEach((x) => x.classList.toggle('active', x === b));
        try { chrome.storage.local.set({ remFilter }); } catch (e) { /* ignore */ }
        applyRemFilter();
    });
});

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
        let syncFailed = false;
        if (loggedIn) {
            status.textContent = 'Збереження…';
            // Будильники — у спільну базу (решта налаштувань лишається локальною).
            try {
                await SB.syncReminders(settings.reminders, [...removedIds]);
                status.textContent = 'Збережено (спільне)';
                loadForm(); // перемалювати рядки з реальними id (uuid) з бази — щоб mute/scope працювали одразу
            } catch (e) {
                const msg = String((e && e.message) || e);
                // 403 = RLS відмовив (напр. спроба зробити чужий спільний «особистим»):
                // це ОЧІКУВАНО — у базі він лишився загальним. Не червоний error, а warn.
                if (/\b403\b/.test(msg)) {
                    console.warn('[HR] reminder stayed shared (RLS 403):', msg);
                    status.textContent = 'Залишився загальним — змінити чужий спільний може лише автор';
                } else {
                    console.error('[HR] syncReminders failed:', e);
                    status.textContent = 'Збережено локально; синк не вдався: ' + msg;
                }
                syncFailed = true;
                // Відкат: підтягуємо базу й перемальовуємо форму, щоб локальна (невдала)
                // зміна scope не лишалась і не давала 403 на КОЖНОМУ наступному збереженні.
                try { await SB.pull(); } catch (_) { /* офлайн — лишаємо локальне */ }
                loadForm();
            }
        } else {
            status.textContent = 'Збережено';
        }
        savingNow = false;
        setTimeout(() => { status.textContent = ''; }, syncFailed ? 9000 : 1800);
    });
});

// --- Звук: тест + завантаження свого + перемикач режиму сповіщень ---
const SOUND_BUILTIN = {
    beep: 'beep.wav', ding: 'sounds/ding.wav', double: 'sounds/double.wav',
    chime: 'sounds/chime.wav', bell: 'sounds/bell.wav', alarm: 'sounds/alarm.wav',
    pop: 'sounds/pop.wav', marimba: 'sounds/marimba.wav', soft: 'sounds/soft.wav',
    digital: 'sounds/digital.wav', triple: 'sounds/triple.wav', rising: 'sounds/rising.wav',
    falling: 'sounds/falling.wav', knock: 'sounds/knock.wav', bubble: 'sounds/bubble.wav',
};
function popupPlaySound(which) {
    const selId = which === 'reminder' ? 'reminderSound' : which === 'reply' ? 'replySound' : 'alertSound';
    const sel = $(selId).value;
    if (sel === 'none') return; // «Без звуку»
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
if ($('testReplySound')) $('testReplySound').addEventListener('click', () => popupPlaySound('reply'));
if ($('testNotify')) $('testNotify').addEventListener('click', () => {
    const st = $('status');
    if (st) st.textContent = 'Перевірка…';
    try {
        chrome.runtime.sendMessage({ action: 'testNotify' }, (resp) => {
            const le = chrome.runtime.lastError;
            if (!st) return;
            if (!resp) { st.textContent = 'Немає відповіді від фону' + (le ? ' (' + le.message + ')' : '') + ' — перезавантажте розширення'; return; }
            if (resp.level === 'denied') { st.textContent = 'Сповіщення ЗАБЛОКОВАНІ у браузері (denied) — увімкніть для розширення'; return; }
            if (resp.ok) {
                st.textContent = 'Створено (рівень: ' + (resp.level || '?') + '). Не видно банера → увімкніть сповіщення Chrome в ОС';
                setTimeout(() => { if (st.textContent.indexOf('Створено') === 0) st.textContent = ''; }, 6000);
            } else {
                st.textContent = 'Помилка: ' + (resp.error || 'невідомо');
            }
        });
    } catch (e) { if (st) st.textContent = 'Помилка перевірки'; }
});

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
wireSoundUpload('reply', 'replySoundFile', 'replySound');
if ($('reminderSoundUpload')) $('reminderSoundUpload').addEventListener('click', () => $('reminderSoundFile').click());
if ($('alertSoundUpload')) $('alertSoundUpload').addEventListener('click', () => $('alertSoundFile').click());
if ($('replySoundUpload')) $('replySoundUpload').addEventListener('click', () => $('replySoundFile').click());

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
let snipSearch = ''; // поточний фільтр списку шаблонів
const NO_CAT = 'Без категорії';
function snipMatchesSearch(s, q) {
    if (!q) return true;
    q = q.toLowerCase();
    return [s.title, s.shortcut, s.body, s.bodyRu, s.bodyEn, s.category]
        .some((x) => (x || '').toLowerCase().includes(q));
}
let snipListCache = []; // останній прочитаний список шаблонів (для категорій)
let snipCatsCache = []; // стійкий спільний список категорій (storage.local.snippetCats)
function getSnippetCategories() {
    const fromSnips = snipListCache.map((s) => (s.category || '').trim()).filter(Boolean);
    return [...new Set([...snipCatsCache, ...fromSnips])].sort((a, b) => a.localeCompare(b));
}
// Видалити категорію: прибрати зі спільного списку + з усіх шаблонів, що її мають.
function deleteCategory(name, onDone) {
    const affected = snipListCache.filter((s) => (s.category || '').trim() === name && s.id);
    const msg = affected.length
        ? 'Видалити категорію «' + name + '»? Її буде прибрано з ' + affected.length + ' шаблон(ів).'
        : 'Видалити категорію «' + name + '»?';
    if (!confirm(msg)) return;
    snipCatsCache = snipCatsCache.filter((c) => c !== name); // оптимістично
    try { chrome.runtime.sendMessage({ sb: 'catDel', name }, () => { void chrome.runtime.lastError; }); } catch (e) { /* ignore */ }
    let left = affected.length;
    if (!left) { onDone && onDone(); return; }
    affected.forEach((s) => {
        const snippet = { id: s.id, title: s.title, body: s.body, bodyRu: s.bodyRu, bodyEn: s.bodyEn, shortcut: s.shortcut, category: '' };
        try {
            chrome.runtime.sendMessage({ sb: 'snipUpdate', snippet }, () => {
                void chrome.runtime.lastError;
                if (--left <= 0) { renderSnippets(); onDone && onDone(); }
            });
        } catch (e) { if (--left <= 0) { renderSnippets(); onDone && onDone(); } }
    });
}
let curEditor = null; // активний рядок редагування { row, snippet } (один за раз)
function clearEditorActions() { const a = $('snipActions'); if (a) a.innerHTML = ''; }
function closeEditor() {
    if (curEditor) {
        const { row, snippet } = curEditor;
        if (snippet && snippet.id) { try { row.replaceWith(snipViewRow(snippet)); } catch (e) { /* ignore */ } }
        else { try { row.remove(); } catch (e) { /* ignore */ } }
        curEditor = null;
    }
    clearEditorActions();
    hideSnipFmtBar();
}
function renderSnippets() {
    const box = $('snippetsList');
    if (!box) return;
    curEditor = null; clearEditorActions(); hideSnipFmtBar(); // список перебудовується — редактор закривається
    box.innerHTML = '';
    if (!isLoggedIn) {
        box.appendChild(makeEl('div', { className: 'list-empty', textContent: 'Увійдіть через Google, щоб керувати шаблонами' }));
        return;
    }
    chrome.storage.local.get('snippets', (d) => {
        const all = (d && d.snippets) || [];
        const active = all.filter((s) => !s.archived);
        const archived = all.filter((s) => s.archived);
        snipListCache = active;
        box.innerHTML = '';
        if (!all.length) { box.appendChild(makeEl('div', { className: 'list-empty', textContent: 'Поки немає шаблонів' })); return; }
        const q = snipSearch.trim();
        const list = active.filter((s) => snipMatchesSearch(s, q));
        if (!list.length && !archived.length) { box.appendChild(makeEl('div', { className: 'list-empty', textContent: 'Нічого не знайдено' })); return; }
        // Групування за категорією (без категорії — в кінці).
        const groups = new Map();
        list.forEach((s) => { const c = (s.category || '').trim() || NO_CAT; if (!groups.has(c)) groups.set(c, []); groups.get(c).push(s); });
        const names = [...groups.keys()].sort((a, b) => (a === NO_CAT ? 1 : b === NO_CAT ? -1 : a.localeCompare(b)));
        names.forEach((name) => {
            const head = makeEl('div', { className: 'snip-group' });
            head.appendChild(makeEl('span', { className: 'snip-group-name', textContent: name }));
            head.appendChild(makeEl('span', { className: 'snip-group-n', textContent: String(groups.get(name).length) }));
            const wrap = makeEl('div', { className: 'snip-grp-body' });
            groups.get(name).forEach((s) => wrap.appendChild(snipViewRow(s)));
            head.addEventListener('click', () => { wrap.hidden = !wrap.hidden; head.classList.toggle('collapsed', wrap.hidden); });
            box.appendChild(head);
            box.appendChild(wrap);
        });
        // Архів (згорнутий за замовчуванням) — відновлення видалених шаблонів.
        if (archived.length) {
            const head = makeEl('div', { className: 'snip-group collapsed' });
            head.appendChild(makeEl('span', { className: 'snip-group-name', textContent: 'Архів' }));
            head.appendChild(makeEl('span', { className: 'snip-group-n', textContent: String(archived.length) }));
            const wrap = makeEl('div', { className: 'snip-grp-body' });
            wrap.hidden = true;
            archived.forEach((s) => wrap.appendChild(snipArchRow(s)));
            head.addEventListener('click', () => { wrap.hidden = !wrap.hidden; head.classList.toggle('collapsed', wrap.hidden); });
            box.appendChild(head);
            box.appendChild(wrap);
        }
    });
}
if ($('snipSearch')) $('snipSearch').addEventListener('input', (e) => { snipSearch = e.target.value; renderSnippets(); });
// Дропдаун вибору категорії в редакторі: вибір наявної / додати нову / видалити.
function snipCatSelector(initial) {
    const wrap = makeEl('div', { className: 'snip-cat' });
    let value = (initial || '').trim();
    const btn = makeEl('button', { type: 'button', className: 'snip-cat-btn' });
    const menu = makeEl('div', { className: 'snip-cat-menu' });
    menu.hidden = true;
    const setLabel = () => { btn.textContent = (value || 'Категорія…') + ' ▾'; btn.classList.toggle('empty', !value); };
    const opt = (name, label, isMuted) => {
        const o = makeEl('div', { className: 'snip-cat-opt' + (name === value ? ' sel' : '') });
        o.appendChild(makeEl('span', { className: 'snip-cat-opt-name' + (isMuted ? ' muted' : ''), textContent: label }));
        o.querySelector('.snip-cat-opt-name').addEventListener('click', () => { value = name; setLabel(); menu.hidden = true; });
        return o;
    };
    function buildMenu() {
        menu.innerHTML = '';
        menu.appendChild(opt('', '(без категорії)', true));
        // показуємо збережені категорії + поточну (щойно введену, ще не збережену).
        const cats = [...new Set([...(value ? [value] : []), ...getSnippetCategories()])].sort((a, b) => a.localeCompare(b));
        cats.forEach((c) => {
            const o = opt(c, c, false);
            const del = makeEl('button', { type: 'button', className: 'snip-cat-del', textContent: '×', title: 'Видалити категорію' });
            del.addEventListener('click', (e) => { e.stopPropagation(); deleteCategory(c, () => { if (value === c) value = ''; setLabel(); buildMenu(); }); });
            o.appendChild(del);
            menu.appendChild(o);
        });
        const add = makeEl('div', { className: 'snip-cat-add' });
        const inp = makeEl('input', { type: 'text', placeholder: 'Нова категорія' });
        const addBtn = makeEl('button', { type: 'button', className: 'small', textContent: '+' });
        const doAdd = () => {
            const v = inp.value.trim();
            if (!v) return;
            value = v;
            setLabel();
            menu.hidden = true;
            if (!snipCatsCache.includes(v)) {
                snipCatsCache = [...snipCatsCache, v]; // оптимістично — щоб одразу зʼявилась у списку
                try { chrome.runtime.sendMessage({ sb: 'catAdd', name: v }, () => { void chrome.runtime.lastError; }); } catch (e) { /* ignore */ }
            }
        };
        addBtn.addEventListener('click', doAdd);
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doAdd(); } });
        add.appendChild(inp); add.appendChild(addBtn);
        menu.appendChild(add);
    }
    btn.addEventListener('click', () => { if (menu.hidden) { buildMenu(); menu.hidden = false; } else menu.hidden = true; });
    setLabel();
    wrap.appendChild(btn);
    wrap.appendChild(menu);
    wrap.getValue = () => value;
    return wrap;
}
// Закрити відкриті дропдауни категорій при кліку поза ними.
document.addEventListener('click', (e) => {
    document.querySelectorAll('.snip-cat-menu:not([hidden])').forEach((m) => {
        if (!m.parentNode.contains(e.target)) m.hidden = true;
    });
});
function snipDelete(id, onDone) {
    if (!id) { onDone && onDone(); return; }
    if (!confirm('Перемістити шаблон в архів?\nЙого можна відновити внизу списку, у розділі «Архів».')) { onDone && onDone(); return; }
    try { chrome.runtime.sendMessage({ sb: 'snipDel', id }, () => { void chrome.runtime.lastError; renderSnippets(); }); } catch (e) { /* ignore */ }
}
function snipRestore(id) {
    if (!id) return;
    try { chrome.runtime.sendMessage({ sb: 'snipRestore', id }, () => { void chrome.runtime.lastError; renderSnippets(); }); } catch (e) { /* ignore */ }
}
function snipPurge(id) {
    if (!id) return;
    if (!confirm('Видалити шаблон НАЗАВЖДИ?\nЦю дію не можна скасувати.')) return;
    try { chrome.runtime.sendMessage({ sb: 'snipPurge', id }, () => { void chrome.runtime.lastError; renderSnippets(); }); } catch (e) { /* ignore */ }
}
// Згорнутий рядок збереженого шаблону: назва + ✎ редагувати + × видалити.
function snipViewRow(s) {
    const row = makeEl('div', { className: 'snip-row snip-view' });
    if (s.id) row.dataset.id = s.id;
    if (s.shortcut) {
        const sc = makeEl('span', { className: 'snip-sc', textContent: s.shortcut, title: 'Скорочення (Tab у полі відповіді)' });
        row.appendChild(sc);
    }
    const label = makeEl('span', { className: 'snip-label', textContent: s.title || (s.body || '').slice(0, 48) || '(без назви)' });
    label.title = s.body || '';
    const have = [(s.bodyRu || '').trim() && 'RU', (s.bodyEn || '').trim() && 'EN'].filter(Boolean);
    const edit = makeEl('button', { type: 'button', className: 'small', textContent: '✎', title: 'Редагувати' });
    const del = makeEl('button', { type: 'button', className: 'small remove', innerHTML: IC.trash, title: 'В архів' });
    edit.addEventListener('click', () => row.replaceWith(snipEditRow(s)));
    del.addEventListener('click', () => snipDelete(row.dataset.id));
    row.appendChild(label);
    if (have.length) row.appendChild(makeEl('span', { className: 'snip-langs-have', textContent: have.join('·'), title: 'Є переклади: ' + have.join(', ') }));
    row.appendChild(edit);
    row.appendChild(del);
    return row;
}
// Рядок архівованого шаблону: назва + ↩ відновити.
function snipArchRow(s) {
    const row = makeEl('div', { className: 'snip-row snip-view snip-arch' });
    if (s.id) row.dataset.id = s.id;
    const label = makeEl('span', { className: 'snip-label', textContent: s.title || (s.body || '').slice(0, 48) || '(без назви)' });
    label.title = s.body || '';
    const restore = makeEl('button', { type: 'button', className: 'small', textContent: '↩', title: 'Відновити з архіву' });
    restore.addEventListener('click', () => snipRestore(row.dataset.id));
    const del = makeEl('button', { type: 'button', className: 'small remove', innerHTML: IC.trash, title: 'Видалити назавжди' });
    del.addEventListener('click', () => snipPurge(row.dataset.id));
    row.appendChild(label);
    row.appendChild(restore);
    row.appendChild(del);
    return row;
}
// Маркери форматування (стандартний Markdown — BILLmanager рендерить його в тікетах).
const FMT_WRAP = { bold: ['**', '**'], italic: ['_', '_'], strike: ['~~', '~~'], code: ['`', '`'] };
function fmtWrap(ta, pre, post) {
    const s = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
    const e = ta.selectionEnd != null ? ta.selectionEnd : ta.value.length;
    const sel = ta.value.slice(s, e);
    ta.value = ta.value.slice(0, s) + pre + sel + post + ta.value.slice(e);
    ta.focus();
    const ns = s + pre.length;
    try { ta.setSelectionRange(ns, ns + sel.length); } catch (err) { /* ignore */ }
    ta.dispatchEvent(new Event('input', { bubbles: true }));
}
function fmtPrefixLines(ta, prefix) {
    const s = ta.selectionStart != null ? ta.selectionStart : 0;
    const e = ta.selectionEnd != null ? ta.selectionEnd : ta.value.length;
    const start = ta.value.lastIndexOf('\n', s - 1) + 1;
    const block = ta.value.slice(start, e) || '';
    const replaced = block.split('\n').map((l) => prefix + l).join('\n');
    ta.value = ta.value.slice(0, start) + replaced + ta.value.slice(e);
    ta.focus();
    try { ta.setSelectionRange(start, start + replaced.length); } catch (err) { /* ignore */ }
    ta.dispatchEvent(new Event('input', { bubbles: true }));
}
// Спливаюча панель форматування знизу поля тексту шаблону (на фокусі).
let snipFmtBar = null;
let snipFmtTa = null;
function posSnipFmtBar(ta) {
    const r = ta.getBoundingClientRect();
    const bw = snipFmtBar.offsetWidth || 180;
    snipFmtBar.style.left = Math.round(r.left + (r.width - bw) / 2) + 'px'; // по центру нижньої кромки
    snipFmtBar.style.top = Math.round(r.bottom - 30) + 'px';
}
function updateSnipFmtBar(ta) {
    if (ta.selectionStart != null && ta.selectionStart !== ta.selectionEnd) showSnipFmtBar(ta);
    else hideSnipFmtBar();
}
function ensureSnipFmtBar() {
    if (snipFmtBar) return snipFmtBar;
    snipFmtBar = makeEl('div', { className: 'snip-fmt-bar' });
    snipFmtBar.hidden = true;
    const mk = (html, title, fn) => {
        const b = makeEl('button', { type: 'button', className: 'snip-fmt-btn', title, innerHTML: html });
        b.addEventListener('mousedown', (e) => e.preventDefault()); // не губити виділення
        b.addEventListener('click', (e) => { e.preventDefault(); if (snipFmtTa) fn(snipFmtTa); });
        return b;
    };
    snipFmtBar.appendChild(mk('<b>B</b>', 'Жирний (Ctrl+B)', (ta) => fmtWrap(ta, FMT_WRAP.bold[0], FMT_WRAP.bold[1])));
    snipFmtBar.appendChild(mk('<i>I</i>', 'Курсив (Ctrl+I)', (ta) => fmtWrap(ta, FMT_WRAP.italic[0], FMT_WRAP.italic[1])));
    snipFmtBar.appendChild(mk('<s>S</s>', 'Закреслений', (ta) => fmtWrap(ta, FMT_WRAP.strike[0], FMT_WRAP.strike[1])));
    snipFmtBar.appendChild(mk('&lt;/&gt;', 'Код', (ta) => fmtWrap(ta, FMT_WRAP.code[0], FMT_WRAP.code[1])));
    snipFmtBar.appendChild(mk('•', 'Список', (ta) => fmtPrefixLines(ta, '- ')));
    snipFmtBar.appendChild(mk('&rsaquo;', 'Цитата', (ta) => fmtPrefixLines(ta, '> ')));
    document.body.appendChild(snipFmtBar);
    window.addEventListener('scroll', () => { if (!snipFmtBar.hidden && snipFmtTa) posSnipFmtBar(snipFmtTa); }, true);
    // Надійне відстеження виділення: панель видно лише поки воно є.
    document.addEventListener('selectionchange', () => {
        const ae = document.activeElement;
        if (ae && ae.classList && ae.classList.contains('snip-body') && ae.selectionStart !== ae.selectionEnd) updateSnipFmtBar(ae);
        else hideSnipFmtBar();
    });
    return snipFmtBar;
}
function showSnipFmtBar(ta) { ensureSnipFmtBar(); snipFmtTa = ta; snipFmtBar.hidden = false; posSnipFmtBar(ta); }
function hideSnipFmtBar() { if (snipFmtBar) snipFmtBar.hidden = true; }
// Рядок редагування: назва + текст + 💾 зберегти + × (видалити/скасувати).
function snipEditRow(s) {
    s = s || { title: '', body: '' };
    closeEditor(); // лише один редактор одночасно
    const row = makeEl('div', { className: 'snip-row snip-edit' });
    if (s.id) row.dataset.id = s.id;
    const head = makeEl('div', { className: 'snip-head' });
    const title = makeEl('input', { type: 'text', className: 'snip-title', placeholder: 'Назва' });
    title.value = s.title || '';
    const sc = makeEl('input', { type: 'text', className: 'snip-sc-input', placeholder: 'скор.', title: 'Скорочення: Tab у полі відповіді. Кілька варіантів через | (напр. перезапуск|gthtpfgecr) — спрацює будь-який, навіть із забутою розкладкою.' });
    sc.value = s.shortcut || '';
    const cat = snipCatSelector(s.category || '');
    head.appendChild(title);
    head.appendChild(sc);
    // Мовні версії: UA (основна) / RU / EN. Порожній переклад → підставиться UA.
    const bodies = { uk: s.body || '', ru: s.bodyRu || '', en: s.bodyEn || '' };
    let curLang = 'uk';
    const langs = makeEl('div', { className: 'snip-langs' });
    const body = makeEl('textarea', { className: 'snip-body', placeholder: 'Текст шаблону…' });
    [['uk', 'UA'], ['ru', 'RU'], ['en', 'EN']].forEach(([code, lbl]) => {
        const b = makeEl('button', { type: 'button', className: 'snip-lang' + (code === curLang ? ' active' : ''), textContent: lbl });
        b.addEventListener('click', () => {
            bodies[curLang] = body.value;
            curLang = code;
            body.value = bodies[code];
            autoGrowSnipBody(body);
            langs.querySelectorAll('.snip-lang').forEach((x) => x.classList.toggle('active', x === b));
            body.placeholder = code === 'uk' ? 'Текст шаблону…' : 'Переклад (' + lbl + '), порожньо → береться UA';
            body.focus();
        });
        langs.appendChild(b);
    });
    // Автопереклад UA → RU/EN (Google Translate). Результат можна редагувати.
    const tr = makeEl('button', { type: 'button', className: 'snip-lang snip-tr', textContent: '🌐', title: 'Перекласти UA → RU і EN (Google)' });
    tr.addEventListener('click', () => {
        if (curLang === 'uk') bodies.uk = body.value;
        const src = (bodies.uk || '').trim();
        if (!src) { $('status').textContent = 'Спершу введіть текст UA'; return; }
        $('status').textContent = 'Переклад…';
        ['ru', 'en'].forEach((target) => {
            try {
                chrome.runtime.sendMessage({ gt: 'translate', q: bodies.uk, target, source: 'uk' }, (resp) => {
                    void chrome.runtime.lastError;
                    if (!resp || !resp.ok) {
                        $('status').textContent = 'Помилка перекладу' + ((resp && resp.error) ? ': ' + resp.error : '');
                        return;
                    }
                    bodies[target] = resp.text;
                    if (curLang === target) { body.value = resp.text; autoGrowSnipBody(body); }
                    $('status').textContent = 'Перекладено';
                    setTimeout(() => { if ($('status').textContent === 'Перекладено') $('status').textContent = ''; }, 1500);
                });
            } catch (e) { /* ignore */ }
        });
    });
    langs.appendChild(tr);
    langs.appendChild(cat); // категорія — на одному рівні з вибором мови (праворуч)
    body.value = bodies.uk;
    body.style.paddingBottom = '34px'; // місце під спливаючу панель форматування
    setTimeout(() => autoGrowSnipBody(body), 0); // початкова висота під наявний текст (після монтування в DOM)
    body.addEventListener('focus', () => { lastSnipBody = body; });
    // Панель зʼявляється лише коли виділено текст.
    body.addEventListener('select', () => updateSnipFmtBar(body));
    body.addEventListener('keyup', () => updateSnipFmtBar(body));
    body.addEventListener('mouseup', () => updateSnipFmtBar(body));
    body.addEventListener('blur', () => setTimeout(() => { if (snipFmtTa === body) hideSnipFmtBar(); }, 200));
    body.addEventListener('input', () => { bodies[curLang] = body.value; autoGrowSnipBody(body); });
    body.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && !e.altKey) {
            const k = (e.key || '').toLowerCase();
            if (k === 'b') { e.preventDefault(); fmtWrap(body, FMT_WRAP.bold[0], FMT_WRAP.bold[1]); }
            else if (k === 'i') { e.preventDefault(); fmtWrap(body, FMT_WRAP.italic[0], FMT_WRAP.italic[1]); }
        }
        if (e.key === 'Escape') hideSnipFmtBar();
    });
    const save = makeEl('button', { type: 'button', className: 'small snip-save', title: 'Зберегти', innerHTML: IC.save });
    const close = makeEl('button', { type: 'button', className: 'small remove', title: 'Закрити без збереження', innerHTML: IC.close });
    save.addEventListener('click', () => {
        bodies[curLang] = body.value;
        const snippet = { id: row.dataset.id || undefined, title: title.value.trim(), body: bodies.uk, bodyRu: bodies.ru.trim(), bodyEn: bodies.en.trim(), shortcut: sc.value.trim(), category: cat.getValue() };
        if (!snippet.title && !snippet.body) return;
        const action = row.dataset.id ? 'snipUpdate' : 'snipAdd';
        $('status').textContent = 'Збереження…';
        try {
            chrome.runtime.sendMessage({ sb: action, snippet }, (resp) => {
                void chrome.runtime.lastError;
                if (!resp || !resp.ok) {
                    const err = String((resp && resp.error) || '');
                    if (/not-logged-in|unauthorized|401/i.test(err)) { $('status').textContent = 'Не збережено: увійдіть через Google'; promptLogin(); }
                    else { $('status').textContent = 'Помилка збереження' + (err ? ': ' + err : ''); }
                    return;
                }
                $('status').textContent = 'Шаблон збережено';
                setTimeout(() => { if ($('status').textContent === 'Шаблон збережено') $('status').textContent = ''; }, 1500);
                renderSnippets();
            });
        } catch (e) { /* ignore */ }
    });
    close.addEventListener('click', () => closeEditor()); // нове — прибрати рядок; наявне — повернути перегляд
    row.appendChild(head);
    row.appendChild(langs);
    row.appendChild(body);
    // Кнопки-іконки праворуч під полем: клас .snip-actions дає margin-left:auto + стилі як раніше.
    const acts = makeEl('div', { className: 'snip-actions' });
    acts.appendChild(save);
    acts.appendChild(close);
    row.appendChild(acts);
    curEditor = { row, snippet: s };
    return row;
}
// Авто-розширення textarea шаблону по висоті тексту (без ручного тягнення).
function autoGrowSnipBody(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
}
if ($('addSnippet')) $('addSnippet').addEventListener('click', () => {
    const box = $('snippetsList');
    if (!box) return;
    const empty = box.querySelector('.list-empty');
    if (empty) empty.remove();
    box.appendChild(snipEditRow({}));
});
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
        autoGrowSnipBody(el);
    });
});
// Початковий підтяг спільних шаблонів і категорій (оновити дзеркало) + рендер.
chrome.storage.local.get('snippetCats', (d) => { snipCatsCache = (d && d.snippetCats) || []; });
try { chrome.runtime.sendMessage({ sb: 'snipPull' }, () => { void chrome.runtime.lastError; renderSnippets(); }); } catch (e) { /* ignore */ }
try { chrome.runtime.sendMessage({ sb: 'catPull' }, () => { void chrome.runtime.lastError; }); } catch (e) { /* ignore */ }
