// content.js — підсвічування рядків таблиці тікетів ISPmanager:
//  1) «заблокований запит» за іменем (із надійним per-row таймером, миготінням, алертом);
//  2) правила за тегами теми (свій колір + сповіщення/звук на правило);
//  3) ручні будильники-нагадування за номером тікета + часом.

const ROW_SELECTOR =
    'isp-table ispui-table-resizer cdk-virtual-scroll-viewport table tbody tr';
const SUBJECT_SELECTOR = 'td[data-table-column-name="name"] .isp-cell-content__data';
const TICKET_SELECTOR = 'td[data-table-column-name="ticket"] .isp-cell-content__data';
// «Заблокований запит» — за атрибутом (незалежно від мови інтерфейсу).
const BLOCKED_PROP_SELECTOR = 'div.isp-prop[data-table-prop-name="blocked_by"]';

// «Без відповіді понад N год» — через API billmgr (same-origin).
const STALE_POLL_INTERVAL_MS = 15 * 60 * 1000; // як часто пересканувати чергу
const STALE_POLL_DEDUP_MS = 14 * 60 * 1000;    // не сканувати, якщо інша вкладка щойно сканувала
const STALE_FETCH_GAP_MS = 150;                // пауза між запитами деталей (м'якше до білінгу)

// Скан збігів по всій черзі (теги/блокування/будильники) — для покриття всіх сторінок.
const MATCH_POLL_INTERVAL_MS = 15 * 60 * 1000;
const MATCH_POLL_DEDUP_MS = 14 * 60 * 1000;
const MATCH_MAX_PAGES = 40;                     // запобіжник для пагінації

// Трафік у тікеті
const BYTES_PER_TB = 1099511627776;            // 1 ТБ (1024^4)
const TRAFFIC_ITEM_CLASS = 'hr-traffic-item';
// Локалізовані підписи панелі (значення за замовч. — ru; реальні беремо з API).
const DEFAULT_LABELS = {
    requestInfoTitle: 'Информация о запросе',
    ticketIdLabel: 'Код запроса',
    serviceInfoTitle: 'Информация об услуге',
};

// Поля інстансу, які додаємо в блок «Информация об услуге» (значення з API
// вже локалізовані; підписи — наші).
const SERVICE_FIELDS = [
    { key: 'status', label: 'Статус' },
    { key: 'os', label: 'ОС' },
    { key: 'cost', label: 'Вартість', title: '♻️ автопродовження увімкнено · 🚫 вимкнено' },
    { key: 'expiredate', label: 'Діє до' },
];
const SERVICE_ITEM_CLASS = 'hr-service-item';

const MANAGED_CLASS = 'hr-managed';
const BLINK_CLASS = 'hr-blink';
const ALARM_CLASS = 'hr-alarm';

const REFRESH_INTERVAL_MS = 15 * 1000; // періодична перевірка без мутацій
const DEBOUNCE_MS = 300;               // згладжування MutationObserver
const REMINDER_LEAD_MS = 5 * 60 * 1000; // будильник вмикається за 5 хв до часу
const REMINDER_NOTIFY_MS = 60 * 1000;   // як часто повторювати сповіщення будильника

const DEFAULT_SETTINGS = {
    // «заблокований запит»
    names: [],
    enabled: true,
    thresholdMinutes: 10,
    repeatMinutes: 0, // 0 = нагадати лише один раз
    color: '#ffac5a',
    soundEnabled: true,
    // правила за тегами
    tagRules: [], // { query, color, notify, sound }
    // будильники
    reminderColor: '#ff5a5a',
    reminders: [], // { id, ticketId, time: "HH:MM", note }
    snoozeMinutes: 10, // тривалість снузу кнопки «Заглушити»
    // «без відповіді понад N год» — список у popup
    staleEnabled: false, // вимкнено за замовч.: скан відкриває тікети й гасить позначку нового повідомлення
    staleHours: 4,
    // показувати дані послуги в тікеті (майстер-тогл) + які саме поля
    trafficEnabled: false,
    serviceShow: { status: true, os: true, cost: true, expiredate: true, traffic: true },
};

// Кеш у пам'яті, щоб refresh() був синхронним і без гонок.
let settings = { ...DEFAULT_SETTINGS };
let rowTimers = {};       // { [key]: { firstSeen, lastAlert } } — для blocked та tag-алертів
let reminderState = {};   // { [reminderId]: { mutedDate: 'Y-M-D' } } — пише popup
let reminderNotifiedAt = {}; // { [reminderId]: ts } — троттлінг сповіщень (у пам'яті)
let trafficData = null;   // { key, used, paid, none?, notFound? } — кеш трафіку поточного тікета
let trafficLoading = false;
let panelLabels = { ...DEFAULT_LABELS }; // локалізовані підписи (оновлюються з API)
let visibleTickets = new Set(); // номери тікетів, що зараз відрендерені в DOM
let matchAlertState = {};       // { 'tag:ID'|'blocked:ID': { lastAlert } } — для off-screen алертів
let matchScanRunning = false;
let matchIntervalRef = null;

// --- Життєвий цикл -------------------------------------------------------
// Після оновлення розширення старий екземпляр скрипта лишається на сторінці,
// а будь-який виклик chrome.* кидає "Extension context invalidated". Тож
// стежимо за валідністю контексту й акуратно зупиняємось.
let alive = true;
let observerRef = null;
let intervalRef = null;
let staleIntervalRef = null;
let sbPullIntervalRef = null;
let debounceTimer = null;
let reminderAudio = null;

function extensionAlive() {
    try {
        return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
        return false;
    }
}

function teardown() {
    alive = false;
    if (intervalRef) { clearInterval(intervalRef); intervalRef = null; }
    if (staleIntervalRef) { clearInterval(staleIntervalRef); staleIntervalRef = null; }
    if (sbPullIntervalRef) { clearInterval(sbPullIntervalRef); sbPullIntervalRef = null; }
    if (matchIntervalRef) { clearInterval(matchIntervalRef); matchIntervalRef = null; }
    if (observerRef) { observerRef.disconnect(); observerRef = null; }
    clearTimeout(debounceTimer);
    stopReminderAudio();
    removeReminderBanner();
    removeUnlockListeners();
}

// --- Налаштування --------------------------------------------------------

function genId() {
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function normalizeSettings(raw) {
    const s = { ...DEFAULT_SETTINGS, ...(raw || {}) };
    s.names = (Array.isArray(s.names) ? s.names : [])
        .map((n) => String(n).trim())
        .filter(Boolean);
    s.thresholdMinutes = Number(s.thresholdMinutes) || DEFAULT_SETTINGS.thresholdMinutes;
    s.repeatMinutes = Math.max(0, Number(s.repeatMinutes) || 0);

    s.tagRules = (Array.isArray(s.tagRules) ? s.tagRules : [])
        .map((r) => ({
            query: String(r.query || '').trim(),
            color: String(r.color || DEFAULT_SETTINGS.color),
            notify: !!r.notify,
            sound: !!r.sound,
            repeatMinutes: Math.max(0, Number(r.repeatMinutes) || 0),
        }))
        .filter((r) => r.query);

    s.staleEnabled = !!s.staleEnabled;
    s.staleHours = Number(s.staleHours);
    if (!(s.staleHours > 0)) s.staleHours = DEFAULT_SETTINGS.staleHours;
    s.trafficEnabled = !!s.trafficEnabled;
    {
        const raw = (s.serviceShow && typeof s.serviceShow === 'object') ? s.serviceShow : {};
        s.serviceShow = {};
        for (const k of ['status', 'os', 'cost', 'expiredate', 'traffic']) s.serviceShow[k] = raw[k] !== false;
    }

    s.reminderColor = String(s.reminderColor || DEFAULT_SETTINGS.reminderColor);
    s.snoozeMinutes = Number(s.snoozeMinutes);
    if (!(s.snoozeMinutes > 0)) s.snoozeMinutes = DEFAULT_SETTINGS.snoozeMinutes;
    s.reminders = (Array.isArray(s.reminders) ? s.reminders : [])
        .map((r) => ({
            id: r.id || genId(),
            ticketId: String(r.ticketId || '').trim(),
            time: String(r.time || '').trim(),
            note: String(r.note || ''),
        }))
        .filter((r) => r.ticketId && r.time);

    return s;
}

function loadFromStorage(area, key, fallback) {
    return new Promise((resolve) => {
        try {
            chrome.storage[area].get(key, (data) => {
                if (chrome.runtime.lastError || !data) { resolve(fallback); return; }
                resolve(data[key] !== undefined ? data[key] : fallback);
            });
        } catch (e) {
            resolve(fallback);
        }
    });
}

function loadSettings() {
    return new Promise((resolve) => {
        try {
            chrome.storage.sync.get(['settings', 'nameToHighlight'], (data) => {
                if (chrome.runtime.lastError || !data) { resolve({ ...DEFAULT_SETTINGS }); return; }
                if (data.settings) { resolve(normalizeSettings(data.settings)); return; }
                // Міграція зі старого формату (один рядок nameToHighlight).
                if (data.nameToHighlight) {
                    const migrated = normalizeSettings({ names: [data.nameToHighlight] });
                    try {
                        chrome.storage.sync.set({ settings: migrated });
                        chrome.storage.sync.remove('nameToHighlight');
                    } catch (e) { teardown(); }
                    resolve(migrated);
                    return;
                }
                resolve({ ...DEFAULT_SETTINGS });
            });
        } catch (e) {
            resolve({ ...DEFAULT_SETTINGS });
        }
    });
}

function persistRowTimers() {
    try {
        chrome.storage.local.set({ rowTimers });
    } catch (e) {
        teardown();
    }
}

// --- Утиліти -------------------------------------------------------------

function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = (hash << 5) - hash + str.charCodeAt(i);
        hash |= 0;
    }
    return hash.toString(36);
}

// cdk-virtual-scroll переробляє DOM-вузли, тож ключ беремо зі стабільного
// атрибута ISPmanager, а не з вузла чи тексту рядка (там є живий лічильник).
function getRowKey(tr) {
    if (tr.dataset) {
        if (tr.dataset.tableRowElid) return 'e:' + tr.dataset.tableRowElid;
        if (tr.dataset.id) return 'd:' + tr.dataset.id;
    }
    if (tr.id) return 'i:' + tr.id;
    const firstCell = tr.querySelector('td');
    const cellText = firstCell ? firstCell.textContent.trim() : '';
    if (cellText) return 'c:' + cellText;
    return 'h:' + hashString(tr.textContent.trim());
}

function getCellText(tr, selector) {
    const el = tr.querySelector(selector);
    return el ? el.textContent.trim() : '';
}

// Колір зберігається як hex (#rrggbb); підсвітка напівпрозора, щоб вміст
// рядка лишався читабельним.
function colorToCss(value) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(value).trim());
    if (!m) return value;
    const int = parseInt(m[1], 16);
    return `rgba(${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255}, 0.3)`;
}

function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function targetTimeToday(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
    if (!m) return null;
    const h = +m[1];
    const min = +m[2];
    if (h > 23 || min > 59) return null;
    const d = new Date();
    d.setHours(h, min, 0, 0);
    return d.getTime();
}

// --- Звук і сповіщення ---------------------------------------------------

// Autoplay: браузер блокує програмний звук, поки користувач не взаємодіяв зі
// сторінкою (тому раніше грав лише системний звук Windows зі сповіщення, а
// beep.wav мовчав). Після ПЕРШОГО жесту «прогріваємо» аудіо тихим програвом —
// далі beep.wav і звук будильника грають нормально.
let audioUnlocked = false;

function removeUnlockListeners() {
    document.removeEventListener('pointerdown', unlockAudio, true);
    document.removeEventListener('keydown', unlockAudio, true);
}

function unlockAudio() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    removeUnlockListeners();
    try {
        const a = new Audio(chrome.runtime.getURL('beep.wav'));
        a.volume = 0;
        a.play().then(() => { a.pause(); a.currentTime = 0; }).catch(() => {});
    } catch (e) { /* ігноруємо */ }
    // Якщо будильник уже активний, але звук був заблокований — увімкнути зараз.
    if (alive) refresh();
}

function playBeep() {
    try {
        const audio = new Audio(chrome.runtime.getURL('beep.wav'));
        audio.play().catch(() => {/* autoplay може бути заблоковано без жесту */});
    } catch (e) {
        // ігноруємо
    }
}

function fireAlert(label, opts) {
    if (opts.sound) playBeep();
    if (opts.notify) {
        try {
            chrome.runtime.sendMessage({ action: 'redAlert', name: label });
        } catch (e) {
            teardown();
        }
    }
}

function startReminderAudio() {
    try {
        if (!reminderAudio) {
            reminderAudio = new Audio(chrome.runtime.getURL('beep.wav'));
            reminderAudio.loop = true;
        }
        if (reminderAudio.paused) reminderAudio.play().catch(() => {});
    } catch (e) {
        // ігноруємо
    }
}

function stopReminderAudio() {
    try {
        if (reminderAudio && !reminderAudio.paused) {
            reminderAudio.pause();
            reminderAudio.currentTime = 0;
        }
    } catch (e) {
        // ігноруємо
    }
}

function notifyReminder(reminder, now) {
    const last = reminderNotifiedAt[reminder.id] || 0;
    if (now - last < REMINDER_NOTIFY_MS) return;
    reminderNotifiedAt[reminder.id] = now;
    try {
        chrome.runtime.sendMessage({
            action: 'reminderAlert',
            ticketId: reminder.ticketId,
            note: reminder.note || '',
        });
    } catch (e) {
        teardown();
    }
}

// --- Банер будильника на сторінці ----------------------------------------

// Плаваючий банер угорі панелі з кнопкою «Заглушити» (снуз 10 хв). Звук
// будильника йде зі сторінки, тож кнопка глушіння теж тут — працює однаково
// в Chrome і Firefox.
function ensureReminderBanner(active) {
    if (!document.body) return;
    let banner = document.getElementById('hr-reminder-banner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'hr-reminder-banner';
        const text = document.createElement('span');
        text.className = 'hr-reminder-banner-text';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'hr-reminder-banner-btn';
        btn.textContent = 'Заглушити';
        btn.addEventListener('click', (e) => { e.preventDefault(); snoozeActiveReminders(); });
        banner.appendChild(text);
        banner.appendChild(btn);
        document.body.appendChild(banner);
    }
    const label = active
        .map((r) => '#' + r.ticketId + (r.note ? ' — ' + r.note : ''))
        .join(' · ');
    const full = '⏰ ' + label;
    const textEl = banner.querySelector('.hr-reminder-banner-text');
    if (textEl.textContent !== full) textEl.textContent = full;
    const btnEl = banner.querySelector('.hr-reminder-banner-btn');
    const btnLabel = 'Відкласти на ' + settings.snoozeMinutes + ' хв';
    if (btnEl.textContent !== btnLabel) btnEl.textContent = btnLabel;
}

function removeReminderBanner() {
    const banner = document.getElementById('hr-reminder-banner');
    if (banner) banner.remove();
}

// Надсилає sb-повідомлення у background (спільна база) — лише якщо є сесія.
// Усі мережеві виклики Supabase живуть у background (CSP сторінки не заважає).
function sbSend(msg) {
    try {
        chrome.storage.local.get('sbSession', (d) => {
            if (d && d.sbSession) {
                try { chrome.runtime.sendMessage(msg, () => { void chrome.runtime.lastError; }); } catch (e) { /* ignore */ }
            }
        });
    } catch (e) { /* ignore */ }
}

// «Заглушити»: відкладає всі активні будильники на snoozeMinutes. Локально
// пишемо одразу (миттєвий ефект), а якщо залогінений — снуз стає спільним
// (background пише snooze_until у базу й оновлює дзеркало для всіх).
function snoozeActiveReminders() {
    const now = Date.now();
    const active = computeActiveReminders(now);
    if (!active.length) return;
    const until = now + Math.round(settings.snoozeMinutes * 60 * 1000);
    for (const r of active) {
        reminderState[r.id] = { ...(reminderState[r.id] || {}), snoozeUntil: until };
    }
    try {
        chrome.storage.local.set({ reminderState });
    } catch (e) {
        teardown();
        return;
    }
    sbSend({ sb: 'snooze', ids: active.map((r) => r.id), until });
    stopReminderAudio();
    removeReminderBanner();
    refresh();
}

// --- Стилізація рядка ----------------------------------------------------

function styleRow(tr, color, blink, alarm, applied) {
    const css = colorToCss(color);
    tr.style.setProperty('--hr-row-color', css);
    tr.style.backgroundColor = css;
    tr.classList.add(MANAGED_CLASS);
    tr.classList.toggle(ALARM_CLASS, !!alarm);
    tr.classList.toggle(BLINK_CLASS, !!blink && !alarm);
    applied.add(tr);
}

function clearRow(tr) {
    tr.classList.remove(MANAGED_CLASS, BLINK_CLASS, ALARM_CLASS);
    tr.style.removeProperty('background-color');
    tr.style.removeProperty('--hr-row-color');
}

// --- Збіги ---------------------------------------------------------------

function blockedNameForRow(tr) {
    // Тултип = "<локалізований префікс>: <Хто заблокував>, <дата>". Ім'я
    // блокувальника — після першого ": ". Матчимо за ПОЧАТКОМ цього імені, щоб
    // введене ім'я не збігалося як підрядок усередині імені іншої людини.
    const props = tr.querySelectorAll(BLOCKED_PROP_SELECTOR);
    for (const p of props) {
        const tip = p.getAttribute('data-ispui-tooltip-text') || '';
        const idx = tip.indexOf(': ');
        const blocker = (idx >= 0 ? tip.slice(idx + 2) : tip).trim();
        for (const name of settings.names) {
            const n = String(name || '').trim();
            if (n && blocker.toLowerCase().startsWith(n.toLowerCase())) return name;
        }
    }
    return null;
}

function tagRuleForRow(subject) {
    if (!subject) return null;
    const lower = subject.toLowerCase();
    // Найдовший збіг має пріоритет: [CLIENT-RETENTION] є підрядком
    // [CLIENT-RETENTION-PROMO], тож для PROMO-теми виграє довше правило.
    let best = null;
    for (let i = 0; i < settings.tagRules.length; i++) {
        const q = settings.tagRules[i].query.toLowerCase();
        if (lower.includes(q) && (!best || q.length > best.rule.query.length)) {
            best = { rule: settings.tagRules[i], index: i };
        }
    }
    return best;
}

function computeActiveReminders(now) {
    const today = todayStr();
    const active = [];
    for (const r of settings.reminders) {
        const st = reminderState[r.id];
        if (st && st.mutedDate === today) continue; // заглушено сьогодні
        if (st && st.snoozeUntil && now < st.snoozeUntil) continue; // відкладено (снуз)
        const target = targetTimeToday(r.time);
        if (target === null) continue;
        if (now >= target - REMINDER_LEAD_MS) active.push(r);
    }
    return active;
}

// --- Основний прохід -----------------------------------------------------

function refresh() {
    if (!alive) return;
    if (!extensionAlive()) { teardown(); return; }

    const now = Date.now();
    const applied = new Set();
    const matchedTimerKeys = new Set();
    const visible = new Set();
    let timersDirty = false;

    // Час-залежні будильники рахуються незалежно від наявності рядка.
    const activeReminders = computeActiveReminders(now);
    const activeTicketIds = new Set(activeReminders.map((r) => r.ticketId));

    document.querySelectorAll(ROW_SELECTOR).forEach((row) => {
        const subject = getCellText(row, SUBJECT_SELECTOR);
        const ticket = getCellText(row, TICKET_SELECTOR);
        if (ticket) visible.add(ticket); // для API-скану: цей тікет зараз видно

        // 1) Правило за тегом (найнижчий пріоритет).
        const tag = tagRuleForRow(subject);
        if (tag) {
            styleRow(row, tag.rule.color, false, false, applied);
            if (tag.rule.notify || tag.rule.sound) {
                const key = 'tag:' + tag.index + ':' + getRowKey(row);
                matchedTimerKeys.add(key);
                if (!rowTimers[key]) { rowTimers[key] = { firstSeen: now, lastAlert: 0 }; timersDirty = true; }
                const t = rowTimers[key];
                const repeatMs = (tag.rule.repeatMinutes || 0) * 60 * 1000;
                const due = !t.lastAlert || (repeatMs > 0 && now - t.lastAlert >= repeatMs);
                if (due) {
                    t.lastAlert = now;
                    timersDirty = true;
                    fireAlert(subject || tag.rule.query, { sound: tag.rule.sound, notify: tag.rule.notify });
                }
            }
        }

        // 2) Заблокований запит за іменем (середній пріоритет).
        if (settings.enabled && settings.names.length) {
            const blockedName = blockedNameForRow(row);
            if (blockedName) {
                const key = getRowKey(row);
                matchedTimerKeys.add(key);
                if (!rowTimers[key]) { rowTimers[key] = { firstSeen: now, lastAlert: 0 }; timersDirty = true; }
                const timer = rowTimers[key];
                const elapsed = now - timer.firstSeen;
                const overThreshold = elapsed >= settings.thresholdMinutes * 60 * 1000;
                styleRow(row, settings.color, overThreshold, false, applied);
                if (overThreshold) {
                    const repeatMs = settings.repeatMinutes * 60 * 1000;
                    const due = !timer.lastAlert || (repeatMs > 0 && now - timer.lastAlert >= repeatMs);
                    if (due) {
                        timer.lastAlert = now;
                        timersDirty = true;
                        fireAlert(blockedName, { sound: settings.soundEnabled, notify: true });
                    }
                }
            }
        }

        // 3) Будильник-нагадування (найвищий пріоритет).
        if (ticket && activeTicketIds.has(ticket)) {
            styleRow(row, settings.reminderColor, false, true, applied);
        }
    });

    visibleTickets = visible; // для API-скану: які тікети зараз на екрані

    // Прибрати стилі з рядків, які цього проходу не оформлювали (зокрема
    // перероблені віртуальним скролом вузли).
    document.querySelectorAll('.' + MANAGED_CLASS).forEach((tr) => {
        if (!applied.has(tr)) clearRow(tr);
    });

    // Прибрати таймери, які більше не збігаються (розблоковані / знятий тег).
    for (const key of Object.keys(rowTimers)) {
        if (!matchedTimerKeys.has(key)) { delete rowTimers[key]; timersDirty = true; }
    }
    if (timersDirty) persistRowTimers();

    // Безперервний звук + банер + повторювані сповіщення будильників.
    if (activeReminders.length) {
        startReminderAudio();
        ensureReminderBanner(activeReminders);
        activeReminders.forEach((r) => notifyReminder(r, now));
    } else {
        stopReminderAudio();
        removeReminderBanner();
    }

    // Трафік клієнта в тікеті.
    maybeTraffic();
}

// --- «Без відповіді понад N год» через API billmgr ----------------------

function onBillmgr() {
    // Панель і API на одному origin (api.zomro.com/billmgr) — fetch same-origin.
    return /(^|\/)billmgr$/.test(location.pathname.replace(/\/+$/, ''));
}

function fieldVal(f) {
    if (f == null) return '';
    if (typeof f === 'object') return f.$ !== undefined ? f.$ : '';
    return String(f);
}

function asArray(x) {
    if (Array.isArray(x)) return x;
    if (x == null) return [];
    return [x];
}

function parseServerDate(s) {
    // "2026-06-09 14:56:46" -> ms (локальний час)
    const t = Date.parse(String(s).replace(' ', 'T'));
    return Number.isNaN(t) ? null : t;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function fetchBillmgr(params) {
    const url = location.origin + '/billmgr?' + params + '&out=xjson';
    const resp = await fetch(url, { credentials: 'include' });
    const json = await resp.json();
    return json.doc || json;
}

let staleScanRunning = false;

// Сканує чергу через API: для кожного тікета знаходить останню відповідь
// підтримки (повідомлення $type="outcoming") і відбирає ті, де від неї минуло
// понад settings.staleHours. Якщо підтримка ще не відповідала — рахує від
// дати створення. Результат пише в storage.local.staleTickets (читає popup).
async function scanStaleTickets(force) {
    if (!alive || !extensionAlive() || !onBillmgr() || staleScanRunning) return;
    // Вимкнено — не скануємо: інакше відкриття тікетів через ticket.edit гасить
    // позначку нового повідомлення (p-newmsg). Стосується й ручного оновлення.
    if (!settings.staleEnabled) return;

    // Дедуплікація між вкладками: не сканувати, якщо нещодавно вже сканували.
    // Ручне оновлення (force) ігнорує цей таймер.
    if (!force) {
        const last = await loadFromStorage('local', 'stalePollAt', 0);
        if (Date.now() - (last || 0) < STALE_POLL_DEDUP_MS) return;
    }
    try { chrome.storage.local.set({ stalePollAt: Date.now() }); } catch (e) { return; }

    staleScanRunning = true;
    try {
        // Скануємо всю чергу (всі сторінки), а не лише поточну — інакше тікети
        // з інших сторінок не потраплять у монітор. fetchAllTickets() сам
        // оновлює локалізовані підписи й повертає користувача на його сторінку.
        const elems = await fetchAllTickets();
        const thresholdMs = settings.staleHours * 60 * 60 * 1000;
        const now = Date.now();
        const result = [];

        for (const el of elems) {
            if (!alive || !extensionAlive()) break;
            const elid = fieldVal(el.id);
            const ticketNo = fieldVal(el.ticket);
            if (!elid) continue;

            let lastSupport = null;
            try {
                const det = await fetchBillmgr('func=ticket.edit&elid=' + encodeURIComponent(elid));
                const msgs = asArray(det.mlist).flatMap((m) => asArray(m.message));
                for (const msg of msgs) {
                    if (msg && msg.$type === 'outcoming') {
                        const t = parseServerDate(fieldVal(msg.date_post));
                        if (t !== null && (lastSupport === null || t > lastSupport)) lastSupport = t;
                    }
                }
            } catch (e) { /* пропускаємо цей тікет */ }

            const ref = lastSupport !== null ? lastSupport : parseServerDate(fieldVal(el.date_start));
            if (ref === null) continue;
            const ageMs = now - ref;
            if (ageMs > thresholdMs) {
                result.push({
                    ticketId: ticketNo,
                    subject: fieldVal(el.name),
                    client: fieldVal(el.client),
                    hours: ageMs / 3600000,
                    noReply: lastSupport === null,
                    url: elid ? location.origin + '/billmgr?startform=ticket.edit&elid=' + encodeURIComponent(elid) : '',
                });
            }
            await sleep(STALE_FETCH_GAP_MS);
        }

        result.sort((a, b) => b.hours - a.hours);
        try { chrome.storage.local.set({ staleTickets: result }); } catch (e) {}
    } catch (e) {
        // мережа/парсинг — спробуємо наступного разу
    } finally {
        staleScanRunning = false;
    }
}

// --- Скан збігів по всій черзі (теги/блокування/будильники) -------------

// Дата блокування з поля blocked_by: "Эдвард Г., 2026-06-09 16:07:42".
function parseBlockTime(str) {
    const m = /(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/.exec(String(str || ''));
    return m ? parseServerDate(m[1]) : null;
}

// Тягне всі тікети черги, гортаючи сторінки через p_num (БЕЗ p_cnt — щоб не
// скидати «рядків на сторінці»), і повертає користувача на його сторінку.
async function fetchAllTickets() {
    let origPnum = '1';
    try {
        const probe = await fetchBillmgr('func=ticket');
        updatePanelLabelsFrom(probe);
        origPnum = fieldVal(probe.p_num) || '1';
    } catch (e) { return []; }

    const all = [];
    let pageSize = 0;
    let lastPnum = 1;
    for (let pnum = 1; pnum <= MATCH_MAX_PAGES; pnum++) {
        if (!alive || !extensionAlive()) break;
        let doc;
        try { doc = await fetchBillmgr('func=ticket&p_num=' + pnum); } catch (e) { break; }
        const elems = asArray(doc.elem);
        all.push(...elems);
        lastPnum = pnum;
        if (pnum === 1) pageSize = elems.length;
        if (elems.length === 0 || (pageSize > 0 && elems.length < pageSize)) break;
        await sleep(STALE_FETCH_GAP_MS);
    }
    if (String(origPnum) !== String(lastPnum)) {
        try { await fetchBillmgr('func=ticket&p_num=' + encodeURIComponent(origPnum)); } catch (e) {}
    }
    return all;
}

function tagRuleForSubject(subject) {
    const lower = String(subject || '').toLowerCase();
    let best = null;
    for (const r of settings.tagRules) {
        const q = String(r.query || '').toLowerCase();
        if (q && lower.includes(q) && (!best || q.length > best.query.length)) best = r;
    }
    return best;
}

let lastMatchJson = '';

async function scanMatches(force) {
    if (!alive || !extensionAlive() || !onBillmgr() || matchScanRunning) return;
    if (!force) {
        const last = await loadFromStorage('local', 'matchPollAt', 0);
        if (Date.now() - (last || 0) < MATCH_POLL_DEDUP_MS) return;
    }
    try { chrome.storage.local.set({ matchPollAt: Date.now() }); } catch (e) { return; }

    matchScanRunning = true;
    try {
        const tickets = await fetchAllTickets();
        const now = Date.now();
        const byId = {};
        const activeKeys = new Set();
        let stateDirty = false;
        const reminderIds = new Set(computeActiveReminders(now).map((r) => r.ticketId));

        const ensure = (ticketId, elid, subject) => {
            if (!byId[ticketId]) {
                byId[ticketId] = {
                    ticketId, subject,
                    kinds: [],
                    // startform відкриває форму в SPA (func=… повертає лише JSON).
                    url: elid ? location.origin + '/billmgr?startform=ticket.edit&elid=' + encodeURIComponent(elid) : '',
                };
            }
            return byId[ticketId];
        };

        for (const t of tickets) {
            const ticketId = fieldVal(t.ticket);
            if (!ticketId) continue;
            const elid = fieldVal(t.id);
            const subject = fieldVal(t.name);
            const visible = visibleTickets.has(ticketId); // видимі алертить DOM — тут не дублюємо

            // Тег
            const rule = tagRuleForSubject(subject);
            if (rule) {
                ensure(ticketId, elid, subject).kinds.push('tag');
                if (!visible && (rule.notify || rule.sound)) {
                    const key = 'tag:' + ticketId;
                    activeKeys.add(key);
                    if (!matchAlertState[key]) { matchAlertState[key] = { lastAlert: 0 }; stateDirty = true; }
                    const st = matchAlertState[key];
                    const repeatMs = (rule.repeatMinutes || 0) * 60 * 1000;
                    if (!st.lastAlert || (repeatMs > 0 && now - st.lastAlert >= repeatMs)) {
                        st.lastAlert = now; stateDirty = true;
                        fireAlert(subject || rule.query, { sound: rule.sound, notify: rule.notify });
                    }
                }
            }

            // Заблокований запит за іменем
            if (settings.enabled && settings.names.length) {
                const blk = fieldVal(t.blocked_by);
                const name = blk ? settings.names.find((n) => n && blk.includes(n)) : null;
                if (name) {
                    ensure(ticketId, elid, subject).kinds.push('blocked');
                    if (!visible) {
                        const blockTime = parseBlockTime(blk);
                        const overThreshold = blockTime !== null &&
                            now - blockTime >= settings.thresholdMinutes * 60 * 1000;
                        if (overThreshold) {
                            const key = 'blocked:' + ticketId;
                            activeKeys.add(key);
                            if (!matchAlertState[key]) { matchAlertState[key] = { lastAlert: 0 }; stateDirty = true; }
                            const st = matchAlertState[key];
                            const repeatMs = settings.repeatMinutes * 60 * 1000;
                            if (!st.lastAlert || (repeatMs > 0 && now - st.lastAlert >= repeatMs)) {
                                st.lastAlert = now; stateDirty = true;
                                fireAlert(name, { sound: settings.soundEnabled, notify: true });
                            }
                        }
                    }
                }
            }

            // Активний будильник
            if (reminderIds.has(ticketId)) ensure(ticketId, elid, subject).kinds.push('reminder');
        }

        // Будильники для тікетів, яких немає в поточній черзі (показати за номером).
        for (const r of settings.reminders) {
            if (reminderIds.has(r.ticketId) && !byId[r.ticketId]) {
                byId[r.ticketId] = { ticketId: r.ticketId, subject: r.note || '', kinds: ['reminder'], url: '' };
            }
        }

        // Чистимо стан алертів для неактивних збігів.
        for (const key of Object.keys(matchAlertState)) {
            if (!activeKeys.has(key)) { delete matchAlertState[key]; stateDirty = true; }
        }
        if (stateDirty) { try { chrome.storage.local.set({ matchAlertState }); } catch (e) {} }

        const list = Object.values(byId).map((m) => ({ ...m, kinds: [...new Set(m.kinds)] }));
        const json = JSON.stringify(list);
        if (json !== lastMatchJson) {
            lastMatchJson = json;
            try { chrome.storage.local.set({ matchTickets: list }); } catch (e) {}
        }
        try { chrome.runtime.sendMessage({ action: 'setBadge', count: list.length }); } catch (e) {}
    } catch (e) {
        // мережа/парсинг — наступного разу
    } finally {
        matchScanRunning = false;
    }
}

// --- Трафік клієнта в тікеті --------------------------------------------

// Чи ми на перегляді тікета — за тегом компонента (не залежить від мови).
function onTicketView() {
    return !!document.querySelector('isp-chat-summary-group');
}

// Оновлює локалізовані підписи з messages.msg будь-якої відповіді billmgr.
function updatePanelLabelsFrom(doc) {
    try {
        const msg = doc && doc.messages && doc.messages.msg;
        if (!msg) return;
        let changed = false;
        if (msg.info_ticket_title && msg.info_ticket_title !== panelLabels.requestInfoTitle) {
            panelLabels.requestInfoTitle = msg.info_ticket_title;
            changed = true;
        }
        if (msg.info_ticket_id && msg.info_ticket_id !== panelLabels.ticketIdLabel) {
            panelLabels.ticketIdLabel = msg.info_ticket_id;
            changed = true;
        }
        if (msg.info_item_title && msg.info_item_title !== panelLabels.serviceInfoTitle) {
            panelLabels.serviceInfoTitle = msg.info_item_title;
            changed = true;
        }
        if (changed) { try { chrome.storage.local.set({ panelLabels }); } catch (e) {} }
    } catch (e) { /* ignore */ }
}

function currentElid() {
    try {
        return new URLSearchParams(location.search).get('elid') || '';
    } catch (e) {
        return '';
    }
}

function formatTB(bytes) {
    // Значення може бути порожнім або з пробілами-роздільниками — чистимо.
    const n = Number(String(bytes == null ? '' : bytes).replace(/[\s ]/g, ''));
    const raw = String(bytes == null ? '' : bytes).trim();
    const v = (raw === '' || raw === '-') ? 0 : n;
    return Number.isFinite(v) ? (v / BYTES_PER_TB).toFixed(3) : '?';
}

// Знаходить контейнер пунктів summary-блоку за його (локалізованим) заголовком.
function findSummaryItems(title) {
    const groups = document.querySelectorAll('isp-chat-summary-group');
    for (const g of groups) {
        const t = g.querySelector('.isp-summary-group__title-text');
        if (t && t.textContent.replace(/\s+/g, ' ').trim() === title) {
            return g.querySelector('.isp-summary-items');
        }
    }
    return null;
}

function findRequestInfoItems() {
    return findSummaryItems(panelLabels.requestInfoTitle);
}

function findServiceInfoItems() {
    return findSummaryItems(panelLabels.serviceInfoTitle);
}

function removeTrafficDom() {
    document.querySelectorAll('.' + TRAFFIC_ITEM_CLASS + ', .' + SERVICE_ITEM_CLASS).forEach((el) => el.remove());
}

// Додає поля інстансу (вартість/автопродовження/дати) у блок «Информация об услуге».
function injectServiceDom() {
    if (!trafficData || !trafficData.service) return;
    const box = findServiceInfoItems();
    if (!box) return;
    for (const f of SERVICE_FIELDS) {
        const val = trafficData.service[f.key];
        let item = box.querySelector('.' + SERVICE_ITEM_CLASS + '[data-hr-field="' + f.key + '"]');
        // Поле вимкнене в налаштуваннях або порожнє — прибрати й пропустити.
        const hidden = settings.serviceShow && settings.serviceShow[f.key] === false;
        if (hidden || val == null || val === '' || val === '-') {
            if (item) item.remove();
            continue;
        }
        if (!item) {
            item = document.createElement('div');
            item.className = SERVICE_ITEM_CLASS;
            item.dataset.hrField = f.key;
            const label = document.createElement('div');
            label.className = 'isp-item-label';
            label.textContent = f.label;
            const value = document.createElement('div');
            value.className = 'isp-item-value hr-service-value';
            item.appendChild(label);
            item.appendChild(value);
            box.appendChild(item);
        }
        if (f.title) item.title = f.title; // пояснення при наведенні
        const valueEl = item.querySelector('.hr-service-value');
        if (valueEl.textContent !== val) valueEl.textContent = val;
    }
}

// Інжект усієї нашої інформації (трафік + поля послуги).
function injectInfo() {
    // Спершу поля послуги, потім трафік — щоб «Трафік» був у самому низу блоку.
    injectServiceDom();
    injectTrafficDom();
}

function trafficValueText() {
    if (!trafficData) return '';
    if (trafficData.none) return 'немає прив\'язаної послуги';
    if (trafficData.notFound) return '—';
    return `${formatTB(trafficData.used)} / ${formatTB(trafficData.paid)} TB`;
}

function injectTrafficDom() {
    if (!trafficData) return;
    const box = findServiceInfoItems(); // «Трафік» тепер у блоці «Информация об услуге»
    if (!box) return; // блок ще не відрендерився
    // Трафік вимкнено в налаштуваннях — прибрати, якщо був.
    if (settings.serviceShow && settings.serviceShow.traffic === false) {
        const existing = box.querySelector('.' + TRAFFIC_ITEM_CLASS);
        if (existing) existing.remove();
        return;
    }
    let item = box.querySelector('.' + TRAFFIC_ITEM_CLASS);
    if (!item) {
        item = document.createElement('div');
        item.className = TRAFFIC_ITEM_CLASS;

        const label = document.createElement('div');
        label.className = 'isp-item-label';
        label.textContent = 'Трафік';

        const value = document.createElement('div');
        value.className = 'isp-item-value';

        const text = document.createElement('span');
        text.className = 'hr-traffic-text';

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'hr-traffic-refresh';
        btn.title = 'Оновити трафік';
        btn.textContent = '↻';
        btn.style.cssText = 'margin-left:6px;cursor:pointer;border:none;background:transparent;font:inherit;line-height:1;padding:0;color:var(--isp-main-color,#1a76e2)';
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const tEl = item.querySelector('.hr-traffic-text');
            if (tEl) tEl.textContent = 'оновлення…';
            loadTraffic(true);
        });

        value.appendChild(text);
        value.appendChild(btn);
        item.appendChild(label);
        item.appendChild(value);
        box.appendChild(item);
    }
    const textEl = item.querySelector('.hr-traffic-text');
    const text = trafficValueText();
    if (textEl.textContent !== text) textEl.textContent = text;
}

// Номер тікета з блоку «Информация о запросе» (пункт «Код запроса»).
function getTicketNumberFromDom() {
    const box = findRequestInfoItems();
    if (!box) return '';
    for (const lab of box.querySelectorAll('.isp-item-label')) {
        if (lab.textContent.replace(/\s+/g, ' ').trim() === panelLabels.ticketIdLabel) {
            const val = lab.parentElement && lab.parentElement.querySelector('.isp-item-value');
            if (val) return val.textContent.trim();
        }
    }
    return '';
}

// elid тікета: з URL, якщо є; інакше шукаємо в черзі за номером.
async function resolveElid(num) {
    const fromUrl = currentElid();
    if (fromUrl) return fromUrl;
    // НЕ передаємо p_cnt — billmgr зберігає його як «рядків на сторінці» й
    // скидав би налаштування користувача. Беремо поточну сторінку черги.
    const list = await fetchBillmgr('func=ticket');
    updatePanelLabelsFrom(list);
    const match = asArray(list.elem).find((e) => fieldVal(e.ticket) === num);
    return match ? fieldVal(match.id) : '';
}

// Тягне трафік сервера, прив'язаного до тікета (ticket.item == instances.id).
// Стабільний ключ тікета: elid із URL (мовонезалежний) або номер із DOM.
function currentTicketKey() {
    return currentElid() || getTicketNumberFromDom();
}

// Іконка за статусом інстансу (instance_status).
function statusIcon(s) {
    const v = String(s || '').toLowerCase();
    const map = {
        active: '✅',
        suspended: '⛔', blocked: '⛔', abusesuspend: '⛔', employeesuspend: '⛔', autosuspend: '⛔',
        stopped: '⏹️', stop: '⏹️', disabled: '⏹️', off: '⏹️',
        pending: '⏳', order: '⏳', new: '⏳',
        processing: '🔄', progress: '🔄', installing: '🔄',
        error: '⚠️', failed: '⚠️',
        deleted: '🗑️', archived: '📦', closed: '📦',
    };
    return map[v] || 'ℹ️';
}

// Поля для блоку «Информация об услуге». До вартості додаємо стан
// автопродовження іконкою (порожнє/-/off вважаємо вимкненим).
function buildService(match) {
    const cost = fieldVal(match.cost);
    const ap = String(fieldVal(match.autoprolong) || '').trim();
    const apOn = ap !== '' && ap !== '-' && ap.toLowerCase() !== 'off';
    const st = fieldVal(match.instance_status);
    return {
        status: st ? statusIcon(st) + ' ' + st : '',
        os: (fieldVal(match.os_distro) + ' ' + fieldVal(match.os_version)).trim(),
        cost: (apOn ? '♻️' : '🚫') + (cost ? ' ' + cost : ''),
        expiredate: fieldVal(match.expiredate),
    };
}

async function loadTraffic(force) {
    if (!alive || !extensionAlive() || !settings.trafficEnabled || !onBillmgr()) return;
    const key = currentTicketKey();
    if (!key) return;
    if (!force && trafficData && trafficData.key === key) return;
    if (trafficLoading) return;

    trafficLoading = true;
    try {
        const elid = await resolveElid(getTicketNumberFromDom());
        if (!elid) {
            trafficData = { key, notFound: true };
        } else {
            const ticket = await fetchBillmgr('func=ticket.edit&elid=' + encodeURIComponent(elid));
            updatePanelLabelsFrom(ticket); // локалізовані підписи поточною мовою
            const item = fieldVal(ticket.item);
            if (!item) {
                trafficData = { key, none: true };
            } else {
                // Виставляємо контекст клієнта (як кнопка «По клиенту») — інакше
                // func=instances не поверне його сервер. Фільтр не знімаємо (за
                // рішенням користувача).
                const plid = fieldVal(ticket.plid) || fieldVal(ticket.id);
                try {
                    await fetchBillmgr('func=ticket.setfilter&elid=' + encodeURIComponent(elid) +
                        '&plid=' + encodeURIComponent(plid));
                } catch (e) { /* контекст міг бути вже виставлений */ }

                // Без p_cnt (щоб не скидати «рядків на сторінці» у списку серверів);
                // контекст клієнта вже звужує список до його інстансів.
                const inst = await fetchBillmgr('func=instances&id=' + encodeURIComponent(item));
                const match = asArray(inst.elem).find((e) => fieldVal(e.id) === item);
                trafficData = match
                    ? {
                        key,
                        used: fieldVal(match.used_traffic),
                        paid: fieldVal(match.paid_traffic),
                        service: buildService(match),
                    }
                    : { key, notFound: true };
            }
        }
        injectInfo();
    } catch (e) {
        // мережа/парсинг — спробуємо при наступному refresh
    } finally {
        trafficLoading = false;
    }
}

function maybeTraffic() {
    if (!settings.trafficEnabled) {
        if (trafficData) { trafficData = null; removeTrafficDom(); }
        return;
    }
    if (!onTicketView()) return; // не сторінка тікета
    if (!trafficData || trafficData.key !== currentTicketKey()) {
        loadTraffic(false);
    } else {
        injectInfo();
    }
}

// --- Тригери refresh -----------------------------------------------------

function scheduleRefresh() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(refresh, DEBOUNCE_MS);
}

function init() {
    if (!extensionAlive()) return;

    Promise.all([
        loadSettings(),
        loadFromStorage('local', 'rowTimers', {}),
        loadFromStorage('local', 'reminderState', {}),
        loadFromStorage('local', 'panelLabels', null),
        loadFromStorage('local', 'matchAlertState', {}),
    ]).then(([loadedSettings, loadedTimers, loadedReminderState, loadedLabels, loadedMatchState]) => {
        if (!extensionAlive()) { teardown(); return; }

        settings = loadedSettings;
        rowTimers = loadedTimers && typeof loadedTimers === 'object' ? loadedTimers : {};
        reminderState = loadedReminderState && typeof loadedReminderState === 'object' ? loadedReminderState : {};
        if (loadedLabels && typeof loadedLabels === 'object') panelLabels = { ...DEFAULT_LABELS, ...loadedLabels };
        matchAlertState = loadedMatchState && typeof loadedMatchState === 'object' ? loadedMatchState : {};
        refresh();

        try {
            chrome.storage.onChanged.addListener((changes, area) => {
                if (!alive) return;
                if (area === 'sync' && changes.settings) {
                    settings = normalizeSettings(changes.settings.newValue);
                    // Вимкнули монітор — прибираємо застарілий список у popup.
                    if (!settings.staleEnabled) { try { chrome.storage.local.set({ staleTickets: [] }); } catch (e) {} }
                    refresh();
                } else if (area === 'local' && changes.reminderState) {
                    reminderState = changes.reminderState.newValue || {};
                    refresh();
                }
            });

            // Ручні дії з popup.
            chrome.runtime.onMessage.addListener((req) => {
                if (!req) return;
                if (req.action === 'scanStaleTickets') scanStaleTickets(true);
                else if (req.action === 'scanMatches') scanMatches(true);
                else if (req.action === 'refreshTraffic') loadTraffic(true);
            });

            // Розблокування звуку після першого жесту користувача (autoplay).
            document.addEventListener('pointerdown', unlockAudio, true);
            document.addEventListener('keydown', unlockAudio, true);

            observerRef = new MutationObserver(scheduleRefresh);
            observerRef.observe(document.body, { childList: true, subtree: true });

            intervalRef = setInterval(refresh, REFRESH_INTERVAL_MS);

            // «Без відповіді»: початкове сканування + періодичне (кожні 15 хв).
            setTimeout(scanStaleTickets, 5000);
            staleIntervalRef = setInterval(scanStaleTickets, STALE_POLL_INTERVAL_MS);

            // Збіги по всій черзі (теги/блокування/будильники).
            setTimeout(scanMatches, 8000);
            matchIntervalRef = setInterval(scanMatches, MATCH_POLL_INTERVAL_MS);

            // Спільні будильники: періодично підтягувати зі спільної бази
            // (фактичний fetch робить background; тут лише тригеримо).
            setTimeout(() => sbSend({ sb: 'pull' }), 4000);
            sbPullIntervalRef = setInterval(() => sbSend({ sb: 'pull' }), MATCH_POLL_INTERVAL_MS);
        } catch (e) {
            teardown();
        }
    });
}

init();
