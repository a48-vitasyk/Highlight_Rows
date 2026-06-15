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

// «Без відповіді понад N год» — через API billmgr (same-origin). Скан лише вручну.
const STALE_POLL_DEDUP_MS = 28 * 60 * 1000;    // не сканувати, якщо інша вкладка щойно сканувала
const STALE_FETCH_GAP_MS = 650;                // пауза між запитами деталей (м'якше до білінгу — ~1.5 зап/с, щоб не ловити бан WAF)

// Скан збігів по всій черзі (теги/блокування/будильники) — для покриття всіх сторінок.
const MATCH_POLL_INTERVAL_MS = 30 * 60 * 1000;
const MATCH_POLL_DEDUP_MS = 28 * 60 * 1000;
const MATCH_MAX_PAGES = 40;                     // запобіжник для пагінації

// Трафік у тікеті
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
    escalateMinutes: 10, // спільний HeartBeat: взяв і не закрив → через N хв дзвонить усім
    // звук і сповіщення
    reminderSound: 'beep',  // beep | ding | double | custom (custom — data URL у storage.local)
    alertSound: 'beep',     // звук тегів/блокування
    replySound: 'beep',     // звук сигналу відповіді клієнта (або 'none' — без звуку)
    soundVolume: 1,         // 0..1
    notifyMode: 'stack',    // replace | stack
    notifyMax: 3,           // 1..5 — макс. накопичених сповіщень
    replyWatch: false,      // сигнал, коли в черзі зʼявляється нове повідомлення клієнта (DOM)
    // «без відповіді понад N год» — список у popup
    staleEnabled: false, // вимкнено за замовч.: скан відкриває тікети й гасить позначку нового повідомлення
    staleHours: 4,
    // показувати дані послуги в тікеті (майстер-тогл) + які саме поля
    trafficEnabled: false,
    serviceShow: { status: true, os: true, cost: true, expiredate: true, traffic: true },
    // косметика панелі (api.zomro.com): дзеркалення чату + висота поля відповіді
    reverseEnabled: false,
    resizeEnabled: false,
    resizePx: 300,
    // переклад і підказки
    myLang: 'uk',                 // моя мова — ціль перекладу вхідних повідомлень (uk|ru|en)
    autoTranslateIncoming: false, // авто-переклад нових вхідних повідомлень
    snipSuggest: true,            // показувати рядок підказок шаблонів у тікеті
};

// Кеш у пам'яті, щоб refresh() був синхронним і без гонок.
let settings = { ...DEFAULT_SETTINGS };
let rowTimers = {};       // { [key]: { firstSeen, lastAlert } } — для blocked та tag-алертів
let reminderState = {};   // { [reminderId]: { mutedDate: 'Y-M-D' } } — пише popup
let repliedSeen = null;   // Set тікетів із позначкою нового повідомлення (минулий прохід)
let repliedVisible = null; // Set видимих тікетів минулого проходу (для виявлення появи)
function rowHasNewMsg(row) {
    return !!row.querySelector('[class*="newmsg"], use[href*="newmsg"], use[*|href*="newmsg"]');
}
let myEmail = '';         // email поточної сесії (для маршрутизації дзвінка shared HeartBeat)
function loadMyEmail() {
    try {
        chrome.storage.local.get('sbSession', (d) => {
            myEmail = (d && d.sbSession && d.sbSession.user && d.sbSession.user.email) || '';
        });
    } catch (e) { /* ignore */ }
}
let snippets = []; // спільні шаблони відповідей (дзеркало storage.local)
function loadSnippets() {
    try { chrome.storage.local.get('snippets', (d) => { snippets = (d && d.snippets) || []; }); } catch (e) { /* ignore */ }
}
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
    s.reverseEnabled = !!s.reverseEnabled;
    s.resizeEnabled = !!s.resizeEnabled;
    s.resizePx = Number(s.resizePx);
    if (!(s.resizePx > 0)) s.resizePx = DEFAULT_SETTINGS.resizePx;
    if (s.resizePx > 2000) s.resizePx = 2000;
    s.myLang = ['uk', 'ru', 'en'].indexOf(s.myLang) !== -1 ? s.myLang : DEFAULT_SETTINGS.myLang;
    s.autoTranslateIncoming = !!s.autoTranslateIncoming;
    s.snipSuggest = s.snipSuggest !== false;
    {
        const raw = (s.serviceShow && typeof s.serviceShow === 'object') ? s.serviceShow : {};
        s.serviceShow = {};
        for (const k of ['status', 'os', 'cost', 'expiredate', 'traffic']) s.serviceShow[k] = raw[k] !== false;
    }

    s.reminderColor = String(s.reminderColor || DEFAULT_SETTINGS.reminderColor);
    s.snoozeMinutes = Number(s.snoozeMinutes);
    if (!(s.snoozeMinutes > 0)) s.snoozeMinutes = DEFAULT_SETTINGS.snoozeMinutes;
    s.escalateMinutes = Number(s.escalateMinutes);
    if (!(s.escalateMinutes > 0)) s.escalateMinutes = DEFAULT_SETTINGS.escalateMinutes;
    s.reminderSound = String(s.reminderSound || DEFAULT_SETTINGS.reminderSound);
    s.alertSound = String(s.alertSound || DEFAULT_SETTINGS.alertSound);
    s.replySound = String(s.replySound || DEFAULT_SETTINGS.replySound);
    s.soundVolume = Number(s.soundVolume);
    if (!(s.soundVolume >= 0 && s.soundVolume <= 1)) s.soundVolume = DEFAULT_SETTINGS.soundVolume;
    s.notifyMode = s.notifyMode === 'replace' ? 'replace' : 'stack';
    s.notifyMax = Math.min(5, Math.max(1, Math.round(Number(s.notifyMax) || DEFAULT_SETTINGS.notifyMax)));
    s.replyWatch = !!s.replyWatch;
    s.reminders = (Array.isArray(s.reminders) ? s.reminders : [])
        .map((r) => ({
            id: r.id || genId(),
            ticketId: String(r.ticketId || '').trim(),
            time: String(r.time || '').trim(),
            note: String(r.note || ''),
            scope: r.scope === 'shared' ? 'shared' : 'personal',
            creatorEmail: String(r.creatorEmail || ''),
            ownerEmail: String(r.ownerEmail || ''),
            takenAt: Number(r.takenAt) || 0,
            doneAt: Number(r.doneAt) || 0,
            doneByEmail: String(r.doneByEmail || ''),
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

const BUILTIN_SOUNDS = {
    beep: 'beep.wav', ding: 'sounds/ding.wav', double: 'sounds/double.wav',
    chime: 'sounds/chime.wav', bell: 'sounds/bell.wav', alarm: 'sounds/alarm.wav',
    pop: 'sounds/pop.wav', marimba: 'sounds/marimba.wav', soft: 'sounds/soft.wav',
    digital: 'sounds/digital.wav', triple: 'sounds/triple.wav', rising: 'sounds/rising.wav',
    falling: 'sounds/falling.wav', knock: 'sounds/knock.wav', bubble: 'sounds/bubble.wav',
};
let customSounds = { reminder: '', alert: '', reply: '' }; // data URL зі storage.local
function loadCustomSounds() {
    try {
        chrome.storage.local.get('soundData', (d) => {
            const sd = (d && d.soundData) || {};
            customSounds = { reminder: sd.reminder || '', alert: sd.alert || '', reply: sd.reply || '' };
            if (reminderAudio) { try { reminderAudio.pause(); } catch (e) { /* ignore */ } reminderAudio = null; }
        });
    } catch (e) { /* ignore */ }
}
function soundSrc(which) {
    const key = which === 'reminder' ? settings.reminderSound
        : which === 'reply' ? settings.replySound
            : settings.alertSound;
    if (key === 'custom') return customSounds[which] || chrome.runtime.getURL('beep.wav');
    return chrome.runtime.getURL(BUILTIN_SOUNDS[key] || 'beep.wav');
}

function playBeep(which) {
    try {
        const audio = new Audio(soundSrc(which || 'alert'));
        audio.volume = settings.soundVolume;
        audio.play().catch(() => {/* autoplay може бути заблоковано без жесту */});
    } catch (e) {
        // ігноруємо
    }
}

function fireAlert(label, opts) {
    if (opts.sound) playBeep(opts.soundWhich);
    if (opts.notify) {
        try {
            chrome.runtime.sendMessage({ action: 'redAlert', kind: opts.kind || 'blocked', name: label, ticket: opts.ticket || '', url: (opts && opts.url) || '' });
        } catch (e) {
            teardown();
        }
    }
}

function startReminderAudio() {
    try {
        const src = soundSrc('reminder');
        if (!reminderAudio || reminderAudio._hrSrc !== src) {
            if (reminderAudio) { try { reminderAudio.pause(); } catch (e) { /* ignore */ } }
            reminderAudio = new Audio(src);
            reminderAudio._hrSrc = src;
            reminderAudio.loop = true;
        }
        reminderAudio.volume = settings.soundVolume;
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
        banner.appendChild(text);
        const mkBtn = (cls, onClick) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'hr-reminder-banner-btn ' + cls;
            b.addEventListener('click', (e) => { e.preventDefault(); onClick(); });
            banner.appendChild(b);
            return b;
        };
        mkBtn('hr-rb-take', claimActiveShared);
        mkBtn('hr-rb-done', doneActiveShared);
        mkBtn('hr-rb-snooze', snoozeActiveReminders);
        document.body.appendChild(banner);
    }
    const label = active
        .map((r) => {
            let s = '#' + r.ticketId + (r.note ? ' — ' + r.note : '');
            if (r.scope === 'shared' && r.ownerEmail) s += ' (взяв ' + r.ownerEmail.split('@')[0] + ')';
            return s;
        })
        .join(' · ');
    const full = '⏰ ' + label;
    const textEl = banner.querySelector('.hr-reminder-banner-text');
    if (textEl.textContent !== full) textEl.textContent = full;
    // «Взяти»/«Відписав» — лише коли серед активних є спільні й ми залогінені.
    const hasShared = !!myEmail && active.some((r) => r.scope === 'shared');
    const takeBtn = banner.querySelector('.hr-rb-take');
    const doneBtn = banner.querySelector('.hr-rb-done');
    const snoozeBtn = banner.querySelector('.hr-rb-snooze');
    if (takeBtn) { takeBtn.hidden = !hasShared; if (takeBtn.textContent !== 'Взяти') takeBtn.textContent = 'Взяти'; takeBtn.title = 'Взяти (клавіша T)'; }
    if (doneBtn) { doneBtn.hidden = !hasShared; if (doneBtn.textContent !== 'Відписав') doneBtn.textContent = 'Відписав'; doneBtn.title = 'Відписав (клавіша D)'; }
    if (snoozeBtn) {
        const sl = 'Відкласти на ' + settings.snoozeMinutes + ' хв';
        if (snoozeBtn.textContent !== sl) snoozeBtn.textContent = sl;
        snoozeBtn.title = 'Заглушити (клавіша S)';
    }
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

// «Взяти»: спільні активні HeartBeat стають моїми → дзвонять лише мені (іншим
// тихо). Локально оновлюємо одразу, у базу — через background (потім pull).
function claimActiveShared() {
    if (!myEmail) return;
    const active = computeActiveReminders(Date.now()).filter((r) => r.scope === 'shared' && r.ownerEmail !== myEmail);
    if (!active.length) return;
    active.forEach((r) => { r.ownerEmail = myEmail; r.takenAt = Date.now(); });
    sbSend({ sb: 'claim', ids: active.map((r) => r.id) });
    refresh();
}

// «Відписав»: спільні активні HeartBeat закриваються для всіх (запис у лог).
function doneActiveShared() {
    if (!myEmail) return;
    const active = computeActiveReminders(Date.now()).filter((r) => r.scope === 'shared');
    if (!active.length) return;
    active.forEach((r) => { r.doneAt = Date.now(); r.doneByEmail = myEmail; });
    sbSend({ sb: 'done', ids: active.map((r) => r.id) });
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
        if (now < target - REMINDER_LEAD_MS) continue;
        // Передача зміни (лише shared): закрито → не дзвонить; взято кимось →
        // дзвонить лише власнику, доки не мине ескалація (тоді знову всім).
        if (r.doneAt) continue;
        if (r.scope === 'shared' && r.ownerEmail) {
            const escalated = now >= target + (settings.escalateMinutes || 10) * 60000;
            if (r.ownerEmail !== myEmail && !escalated) continue;
        }
        active.push(r);
    }
    return active;
}

// B — пінг при передачі: щойно зʼявляється новий спільний HeartBeat (не мій і не
// закритий) — один раз сповіщаємо зміну (не чекаючи його часу). Перший запуск
// лише засіває множину без дзвінка (щоб не задзвеніли всі наявні одразу).
function pingNewShared() {
    if (!alive) return;
    try {
        chrome.storage.local.get('pingedShared', (d) => {
            const hadList = !!(d && Array.isArray(d.pingedShared));
            const seen = new Set(hadList ? d.pingedShared : []);
            let changed = false;
            for (const r of settings.reminders) {
                if (r.scope !== 'shared' || r.doneAt) continue;
                if (seen.has(r.id)) continue;
                if (hadList && r.ownerEmail !== myEmail && r.creatorEmail !== myEmail) {
                    notifyReminder(r, Date.now()); // разовий пінг зміні
                }
                seen.add(r.id);
                changed = true;
            }
            if (changed || !hadList) { try { chrome.storage.local.set({ pingedShared: [...seen] }); } catch (e) { /* ignore */ } }
        });
    } catch (e) { /* ignore */ }
}

// --- Основний прохід -----------------------------------------------------

// --- Кнопка «У будильник» у блоці «Информация о запросе» ------------------
// Додає поточний тікет у будильники: time = зараз + 1 год, scope = власний.
const ADD_REM_BTN_CLASS = 'hr-add-reminder';

// Номер тікета читаємо з блока «Информация о запросе» (мітка «Код запроса»).
function readTicketId() {
    const wanted = (panelLabels.ticketIdLabel || DEFAULT_LABELS.ticketIdLabel);
    const labels = document.querySelectorAll('.isp-item-label');
    for (const lbl of labels) {
        if ((lbl.textContent || '').trim() === wanted) {
            const row = lbl.parentElement;
            const val = row && row.querySelector('.isp-item-value');
            if (val) return (val.textContent || '').trim();
        }
    }
    return '';
}

function plusOneHourHHMM() {
    const d = new Date(Date.now() + 60 * 60 * 1000);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

// Коротка візуальна реакція кольором іконки (без зміни вмісту — лишаємо SVG).
function flashBtn(btn, state, title) {
    if (title) btn.title = title;
    btn.classList.remove('hr-ok', 'hr-dup', 'hr-err');
    if (state) btn.classList.add(state);
    clearTimeout(btn._flashT);
    btn._flashT = setTimeout(() => { btn.classList.remove('hr-ok', 'hr-dup', 'hr-err'); btn.title = btn.dataset.title; }, 1800);
}

// Іконка-дзвіночок (нативний вигляд: тонкі лінії, currentColor — як стрілки панелі).
const ADD_REM_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';

// Безпечна вставка SVG (через DOMParser, без innerHTML — щоб не чіпляв лінтер AMO).
function setSvg(el, svg) {
    if (!el) return;
    el.textContent = '';
    if (!svg) return;
    // Без xmlns DOMParser кладе <svg> у нульовий неймспейс і він не рендериться.
    if (svg.indexOf('xmlns') === -1) svg = svg.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
    const node = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
    if (node && node.nodeName.toLowerCase() === 'svg') el.appendChild(document.importNode(node, true));
}

// Група «Информация о запросе» — та, що містить мітку «Код запроса».
function findRequestInfoGroup() {
    const wanted = (panelLabels.ticketIdLabel || DEFAULT_LABELS.ticketIdLabel);
    const groups = document.querySelectorAll('isp-chat-summary-group, .isp-summary-group');
    for (const g of groups) {
        const labels = g.querySelectorAll('.isp-item-label');
        for (const lbl of labels) {
            if ((lbl.textContent || '').trim() === wanted) return g;
        }
    }
    return null;
}

// Кнопку-дзвіночок ставимо в заголовок блока «Информация о запросе» — біля стрілки.
function injectAddReminderButton() {
    const group = findRequestInfoGroup();
    if (!group || group.querySelector('.' + ADD_REM_BTN_CLASS)) return;
    const anchor = group.querySelector('.isp-summary-group__title') || group;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = ADD_REM_BTN_CLASS;
    btn.dataset.title = 'Додати тікет у будильники на +1 год (власний)';
    btn.title = btn.dataset.title;
    setSvg(btn, ADD_REM_ICON);
    btn.addEventListener('click', (e) => {
        // не згортати блок при кліку по кнопці
        e.preventDefault();
        e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
        const tid = readTicketId();
        if (!tid) { flashBtn(btn, 'hr-err', 'Не знайдено ID тікета'); return; }
        const time = plusOneHourHHMM();
        btn.disabled = true;
        try {
            chrome.runtime.sendMessage({ sb: 'add', ticketId: tid, time }, (resp) => {
                btn.disabled = false;
                if (chrome.runtime.lastError) { flashBtn(btn, 'hr-err', 'Помилка'); return; }
                if (resp && resp.duplicate) flashBtn(btn, 'hr-dup', 'Вже додано');
                else if (resp && resp.ok) flashBtn(btn, 'hr-ok', 'Додано на ' + time);
                else flashBtn(btn, 'hr-err', 'Помилка');
            });
        } catch (e2) { btn.disabled = false; flashBtn(btn, 'hr-err', 'Помилка'); }
    });

    anchor.appendChild(btn);
}

// --- Косметика панелі: «Реверс» (дзеркалення чату) і «Ресайз» (висота поля) ---
// Уся поведінка двох вихідних розширень зводиться до CSS, тож тримаємо її в двох
// керованих <style> — додаємо/прибираємо за станом тоглів (прибирання повертає
// вихідний вигляд).
function setStyleEl(id, css) {
    let el = document.getElementById(id);
    if (!css) { if (el) el.remove(); return; }
    if (!el) {
        el = document.createElement('style');
        el.id = id;
        (document.head || document.documentElement).appendChild(el);
    }
    if (el.textContent !== css) el.textContent = css;
}

function applyPanelTweaks() {
    setStyleEl('hr-reverse-style', settings.reverseEnabled ? (
        '.isp-chat-bubble{max-width:none!important}' +
        '.form__content.ng-star-inserted{padding-right:60px!important}' +
        '.isp-inline-group{--isp-layout-header-height:1px}' +
        '.isp-chat-bubble.isp-chat-bubble_type-outcoming,' +
        '.isp-chat-bubble.isp-chat-bubble_type-ticketnote,' +
        '.isp-chat-bubble.isp-chat-bubble_type-system,' +
        '.isp-chat-bubble.isp-chat-bubble_type-inner{display:flex;flex-direction:row-reverse}' +
        '.scroll-buttons{transform:matrix(1,0,0,1,45,-80)!important}'
    ) : '');

    setStyleEl('hr-resize-style', settings.resizeEnabled ? (
        '.form.isp-dynamic-form-scrollable-container{scroll-margin-top:initial!important}' +
        'textarea.ispui-input__textarea{height:' + settings.resizePx + 'px!important;scroll-margin-top:initial!important}'
    ) : '');
}

// --- Шаблони відповідей: кнопка «Шаблони ▾» біля поля відповіді ------------
function readSummaryItemValue(labels) {
    const arr = Array.isArray(labels) ? labels : [labels];
    for (const lbl of document.querySelectorAll('.isp-item-label')) {
        const t = (lbl.textContent || '').trim();
        if (arr.indexOf(t) !== -1) {
            const v = lbl.parentElement && lbl.parentElement.querySelector('.isp-item-value');
            if (v) return (v.textContent || '').trim();
        }
    }
    return '';
}
// Значення підстановок: ОС/IP/дата відкриття — з DOM панелі; діє-до/трафік/id
// послуги — із завантажених даних послуги (trafficData; якщо є).
function snippetVars() {
    const v = {
        ticket: readTicketId() || '',
        ip: readSummaryItemValue(['IP адрес', 'IP адреса', 'IP-адреса']),
        os: readSummaryItemValue(['Операционная система', 'Операційна система', 'ОС']),
        start: readSummaryItemValue(['Дата открытия', 'Дата відкриття']),
        expire: '', traffic: '', service: '',
    };
    if (trafficData && trafficData.service) {
        if (!v.os) v.os = trafficData.service.os || '';
        v.expire = trafficData.service.expiredate || '';
    }
    if (trafficData) {
        if (trafficData.used != null && trafficData.paid != null && !trafficData.notFound && !trafficData.none) {
            v.traffic = formatTB(trafficData.used) + ' / ' + formatTB(trafficData.paid);
        }
        v.service = trafficData.id || '';
    }
    return v;
}
// Тіло вхідного (клієнтського) повідомлення — лише текст, без імені/дати.
const INCOMING_MSG_SEL = '.isp-chat-bubble_type-incoming isp-chat-message-body';
// Тіла повідомлень для кнопки перекладу — і клієнта, і сапорта (вихідні).
const TRANSLATABLE_MSG_SEL = '.isp-chat-bubble_type-incoming isp-chat-message-body, .isp-chat-bubble_type-outcoming isp-chat-message-body';
// SVG-іконка перекладу (глобус) у монохромному стилі панелі (як дзвіночок).
const HR_TR_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';
// Мова тікета за текстом вхідних повідомлень клієнта (укр-специфічні літери →
// uk; рос-специфічні → ru; лише латиниця → en). Запасний варіант — uk.
function detectTicketLang() {
    let text = '';
    document.querySelectorAll(INCOMING_MSG_SEL).forEach((b) => { text += ' ' + (b.textContent || ''); });
    text = text.slice(-4000);
    if (/[іїєґ]/i.test(text)) return 'uk';
    if (/[ыэъё]/i.test(text)) return 'ru';
    const cyr = (text.match(/[а-я]/gi) || []).length;
    const lat = (text.match(/[a-z]/gi) || []).length;
    if (cyr > 0) return 'ru';      // кирилиця без укр-маркерів — вважаємо ru
    if (lat > 3) return 'en';
    return 'uk';
}
function greetingFor(lang) {
    const h = new Date().getHours();
    const idx = (h >= 5 && h < 12) ? 0 : (h >= 12 && h < 18) ? 1 : 2;
    const map = {
        uk: ['Доброго ранку', 'Доброго дня', 'Доброго вечора'],
        ru: ['Доброе утро', 'Добрый день', 'Добрый вечер'],
        en: ['Good morning', 'Good afternoon', 'Good evening'],
    };
    return (map[lang] || map.uk)[idx];
}
// Тіло шаблону у мові тікета (з відкатом на основне тіло, якщо переклад порожній).
function snippetBody(snip, lang) {
    if (lang === 'ru' && (snip.bodyRu || '').trim()) return snip.bodyRu;
    if (lang === 'en' && (snip.bodyEn || '').trim()) return snip.bodyEn;
    return snip.body || '';
}
function fillSnippet(snip) {
    const lang = detectTicketLang();
    const text = (typeof snip === 'string') ? snip : snippetBody(snip, lang);
    const v = snippetVars();
    const now = new Date();
    v.greeting = greetingFor(lang);
    v.date = now.toLocaleDateString();
    v.time = now.toLocaleTimeString().slice(0, 5);
    return String(text || '').replace(/\{(ticket|ip|os|start|expire|traffic|service|greeting|date|time)\}/g, (m, k) => v[k] || '');
}
// Tab-розгортання: токен перед курсором → шаблон, чия назва починається з токена
// (або будь-яке слово назви починається з нього). Повертає true, якщо розгорнули.
function findSnippetByToken(token, allowTitle) {
    const t = token.toLowerCase();
    // 1) точний збіг по скороченню (тригер) — працює навіть для 1 літери
    let m = snippets.find((s) => (s.shortcut || '').trim().toLowerCase() === t);
    if (!m && allowTitle) {
        // 2) назва починається з токена
        m = snippets.find((s) => (s.title || '').toLowerCase().startsWith(t));
        // 3) будь-яке слово назви починається з токена
        if (!m) m = snippets.find((s) => (s.title || '').toLowerCase().split(/\s+/).some((w) => w.startsWith(t)));
    }
    return m || null;
}
function tokenBeforeCursor(ta) {
    const pos = ta.selectionStart;
    if (pos == null) return null;
    const before = ta.value.slice(0, pos);
    const mt = before.match(/(\S+)$/);
    if (!mt) return null;
    return { token: mt[1], start: pos - mt[1].length, end: pos };
}
// Замінює слово перед курсором на тіло шаблону (з підстановками).
function applySnippetAtCursor(ta, snip) {
    const info = tokenBeforeCursor(ta);
    if (!info) return false;
    const body = fillSnippet(snip);
    acInserting = true;
    ta.value = ta.value.slice(0, info.start) + body + ta.value.slice(info.end);
    const np = info.start + body.length;
    try { ta.setSelectionRange(np, np); } catch (e) { /* ignore */ }
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    acInserting = false;
    return true;
}
function expandSnippetTab(ta) {
    const info = tokenBeforeCursor(ta);
    if (!info || !info.token) return false;
    // по назві — від 2 символів (щоб не розгортати випадково); по скороченню — від 1
    const snip = findSnippetByToken(info.token, info.token.length >= 2);
    if (!snip) return false;
    return applySnippetAtCursor(ta, snip);
}

// --- Інлайн-автодоповнення шаблонів у полі відповіді -----------------------
let acEl = null;        // плаваючий список підказок
let acItems = [];       // поточні збіги
let acIndex = 0;        // підсвічений
let acInserting = false; // прапор, щоб вставка не перезапускала список
function findSnippetMatches(token) {
    const t = token.toLowerCase();
    const seen = new Set();
    const out = [];
    const add = (s) => { const k = s.id || s.title; if (s && !seen.has(k)) { seen.add(k); out.push(s); } };
    snippets.forEach((s) => { if ((s.shortcut || '').trim().toLowerCase().startsWith(t)) add(s); });
    snippets.forEach((s) => { if ((s.title || '').toLowerCase().startsWith(t)) add(s); });
    snippets.forEach((s) => { if ((s.title || '').toLowerCase().split(/\s+/).some((w) => w.startsWith(t))) add(s); });
    return out.slice(0, 8);
}
function hideAc() { if (acEl) acEl.hidden = true; acItems = []; }
function renderAc(ta) {
    if (!acEl) { acEl = makeElc('div', 'hr-snip-ac'); acEl.hidden = true; document.body.appendChild(acEl); }
    acEl.textContent = '';
    acItems.forEach((s, i) => {
        const it = makeElc('div', 'hr-snip-ac-item' + (i === acIndex ? ' sel' : ''));
        if (s.shortcut) it.appendChild(makeElc('span', 'hr-snip-ac-sc', s.shortcut));
        it.appendChild(makeElc('span', 'hr-snip-ac-title', s.title || (s.body || '').slice(0, 40)));
        it.addEventListener('mousedown', (e) => { e.preventDefault(); applySnippetAtCursor(ta, s); hideAc(); });
        acEl.appendChild(it);
    });
    const r = ta.getBoundingClientRect();
    acEl.style.left = Math.round(r.left) + 'px';
    acEl.style.top = Math.round(r.top + 22) + 'px';
    acEl.style.minWidth = Math.round(Math.min(320, Math.max(200, r.width))) + 'px';
    acEl.hidden = false;
}
function updateAc(ta) {
    if (acInserting) return;
    const info = tokenBeforeCursor(ta);
    if (!info || info.token.length < 2) { hideAc(); return; }
    const matches = findSnippetMatches(info.token);
    if (!matches.length) { hideAc(); return; }
    acItems = matches;
    acIndex = 0;
    renderAc(ta);
}

// --- Ctrl+K: палітра швидкого пошуку шаблонів ------------------------------
let paletteEl = null;   // { overlay, input, list, ta }
let palItems = [];
let palIndex = 0;
function paletteMatches(q) {
    q = q.trim().toLowerCase();
    if (!q) {
        // Порожній запит — найрелевантніші до відкритого тікета вгорі.
        const kw = ticketKeywords();
        if (!kw.size) return snippets.slice(0, 30);
        return snippets
            .map((s) => ({ s, score: snippetScore(s, kw) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 30)
            .map((x) => x.s);
    }
    const scored = [];
    snippets.forEach((s) => {
        const title = (s.title || '').toLowerCase();
        const sc = (s.shortcut || '').trim().toLowerCase();
        const body = (s.body || '').toLowerCase();
        let score = 0;
        if (sc && sc === q) score = 100;
        else if (sc && sc.startsWith(q)) score = 80;
        else if (title.startsWith(q)) score = 60;
        else if (title.includes(q)) score = 40;
        else if (body.includes(q)) score = 20;
        if (score) scored.push({ s, score });
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 30).map((x) => x.s);
}
function renderPaletteList() {
    const { input, list } = paletteEl;
    palItems = paletteMatches(input.value);
    if (palIndex >= palItems.length) palIndex = 0;
    list.textContent = '';
    if (!palItems.length) { list.appendChild(makeElc('div', 'hr-pal-empty', 'Нічого не знайдено')); return; }
    palItems.forEach((s, i) => {
        const it = makeElc('div', 'hr-pal-item' + (i === palIndex ? ' sel' : ''));
        if (s.shortcut) it.appendChild(makeElc('span', 'hr-snip-ac-sc', s.shortcut));
        it.appendChild(makeElc('span', 'hr-pal-title', s.title || (s.body || '').slice(0, 60)));
        it.appendChild(makeElc('span', 'hr-pal-prev', (s.body || '').replace(/\s+/g, ' ').slice(0, 90)));
        it.addEventListener('mousedown', (e) => { e.preventDefault(); choosePalette(i); });
        it.addEventListener('mousemove', () => { if (palIndex !== i) { palIndex = i; markPaletteSel(); } });
        list.appendChild(it);
    });
}
function markPaletteSel() {
    const items = paletteEl.list.querySelectorAll('.hr-pal-item');
    items.forEach((el, i) => el.classList.toggle('sel', i === palIndex));
    const sel = items[palIndex];
    if (sel) sel.scrollIntoView({ block: 'nearest' });
}
function choosePalette(i) {
    const s = palItems[i];
    const ta = paletteEl && paletteEl.ta;
    closePalette();
    if (s && ta) insertIntoReply(ta, fillSnippet(s));
}
function closePalette() { if (paletteEl) { paletteEl.overlay.remove(); paletteEl = null; } }
function openPalette() {
    const ta = document.querySelector('textarea.ispui-input__textarea');
    const overlay = makeElc('div', 'hr-pal-overlay');
    const box = makeElc('div', 'hr-pal');
    const input = makeElc('input', 'hr-pal-input');
    input.type = 'text';
    input.placeholder = 'Пошук шаблону… (↑↓ · Enter — вставити · Esc — закрити)';
    const list = makeElc('div', 'hr-pal-list');
    box.appendChild(input);
    box.appendChild(list);
    overlay.appendChild(box);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closePalette(); });
    input.addEventListener('input', () => { palIndex = 0; renderPaletteList(); });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { palIndex = Math.min(palIndex + 1, palItems.length - 1); markPaletteSel(); e.preventDefault(); }
        else if (e.key === 'ArrowUp') { palIndex = Math.max(palIndex - 1, 0); markPaletteSel(); e.preventDefault(); }
        else if (e.key === 'Enter') { choosePalette(palIndex); e.preventDefault(); }
        else if (e.key === 'Escape') { closePalette(); e.preventDefault(); }
    });
    document.body.appendChild(overlay);
    paletteEl = { overlay, input, list, ta };
    palIndex = 0;
    renderPaletteList();
    input.focus();
}
function insertIntoReply(ta, text) {
    const start = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
    const end = ta.selectionEnd != null ? ta.selectionEnd : ta.value.length;
    ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
    const pos = start + text.length;
    try { ta.setSelectionRange(pos, pos); } catch (e) { /* ignore */ }
    ta.dispatchEvent(new Event('input', { bubbles: true })); // щоб Angular ngModel підхопив
    ta.focus();
}
function makeElc(tag, cls, text) {
    const el = document.createElement(tag);
    el.className = cls;
    if (text != null) el.textContent = text;
    return el;
}
// --- Панель форматування у полі відповіді (Markdown, як у BILLmanager) -----
const HR_FMT = { bold: ['**', '**'], italic: ['_', '_'], strike: ['~~', '~~'], code: ['`', '`'] };
function hrFmtWrap(ta, pre, post) {
    if (!ta || ta.selectionStart == null) return;
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const sel = ta.value.slice(s, e);
    ta.value = ta.value.slice(0, s) + pre + sel + post + ta.value.slice(e);
    const ns = s + pre.length;
    try { ta.setSelectionRange(ns, ns + sel.length); } catch (err) { /* ignore */ }
    ta.focus();
    ta.dispatchEvent(new Event('input', { bubbles: true }));
}
function hrFmtPrefix(ta, prefix) {
    if (!ta || ta.selectionStart == null) return;
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const start = ta.value.lastIndexOf('\n', s - 1) + 1;
    const block = ta.value.slice(start, e) || '';
    const replaced = block.split('\n').map((l) => prefix + l).join('\n');
    ta.value = ta.value.slice(0, start) + replaced + ta.value.slice(e);
    try { ta.setSelectionRange(start, start + replaced.length); } catch (err) { /* ignore */ }
    ta.focus();
    ta.dispatchEvent(new Event('input', { bubbles: true }));
}
// Переклад через фоновий безключовий ендпоінт. cb(text|null).
function hrTranslate(text, target, cb) {
    try {
        chrome.runtime.sendMessage({ gt: 'translate', q: text, target, source: 'auto' }, (resp) => {
            void chrome.runtime.lastError;
            cb(resp && resp.ok ? (resp.text || '') : null);
        });
    } catch (e) { cb(null); }
}
// Цільова мова перекладу чернетки: 'auto' (мова клієнта) | uk | ru | en.
let fmtLang = 'auto';
const FMT_LANGS = ['auto', 'uk', 'ru', 'en'];
const fmtLangLabel = () => (fmtLang === 'auto' ? 'Авто' : fmtLang.toUpperCase());
// Перекласти виділений текст у полі відповіді (заміна на місці) на обрану мову.
function hrTranslateSelection(ta) {
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    if (s == null || s === e) return;
    const sel = ta.value.slice(s, e);
    const target = fmtLang === 'auto' ? detectTicketLang() : fmtLang;
    hrTranslate(sel, target, (out) => {
        if (out == null) return;
        ta.value = ta.value.slice(0, s) + out + ta.value.slice(e);
        try { ta.setSelectionRange(s, s + out.length); } catch (err) { /* ignore */ }
        ta.focus();
        ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
}
let fmtBar = null;
let fmtBarTa = null;
function positionFmtBar(ta) {
    const r = ta.getBoundingClientRect();
    const bw = fmtBar.offsetWidth || 200;
    fmtBar.style.left = Math.round(r.left + (r.width - bw) / 2) + 'px'; // по центру нижньої кромки
    fmtBar.style.top = Math.round(r.bottom - 32) + 'px';
}
function updateFmtBar(ta) {
    if (ta.selectionStart != null && ta.selectionStart !== ta.selectionEnd) showFmtBar(ta);
    else hideFmtBar();
}
function ensureFmtBar() {
    if (fmtBar) return fmtBar;
    fmtBar = makeElc('div', 'hr-fmt-bar');
    fmtBar.hidden = true;
    const mk = (label, cls, title, fn) => {
        const b = makeElc('button', 'hr-fmt-btn' + (cls ? ' ' + cls : ''), label);
        b.type = 'button';
        b.title = title;
        b.addEventListener('mousedown', (e) => e.preventDefault()); // не губити виділення/фокус
        b.addEventListener('click', (e) => { e.preventDefault(); if (fmtBarTa) fn(fmtBarTa); });
        return b;
    };
    fmtBar.appendChild(mk('B', 'hr-fmt-b', 'Жирний (Ctrl+B)', (ta) => hrFmtWrap(ta, HR_FMT.bold[0], HR_FMT.bold[1])));
    fmtBar.appendChild(mk('I', 'hr-fmt-i', 'Курсив (Ctrl+I)', (ta) => hrFmtWrap(ta, HR_FMT.italic[0], HR_FMT.italic[1])));
    fmtBar.appendChild(mk('S', 'hr-fmt-s', 'Закреслений', (ta) => hrFmtWrap(ta, HR_FMT.strike[0], HR_FMT.strike[1])));
    fmtBar.appendChild(mk('</>', '', 'Код', (ta) => hrFmtWrap(ta, HR_FMT.code[0], HR_FMT.code[1])));
    fmtBar.appendChild(mk('•', '', 'Список', (ta) => hrFmtPrefix(ta, '- ')));
    fmtBar.appendChild(mk('›', '', 'Цитата', (ta) => hrFmtPrefix(ta, '> ')));
    // Перемикач мови перекладу (цикл Авто→UA→RU→EN) — клік не губить виділення.
    const langBtn = makeElc('button', 'hr-fmt-btn hr-fmt-lang', fmtLangLabel());
    langBtn.type = 'button';
    langBtn.title = 'Мова перекладу: ' + fmtLangLabel() + ' (клік — змінити)';
    langBtn.addEventListener('mousedown', (e) => e.preventDefault());
    langBtn.addEventListener('click', (e) => {
        e.preventDefault();
        fmtLang = FMT_LANGS[(FMT_LANGS.indexOf(fmtLang) + 1) % FMT_LANGS.length];
        langBtn.textContent = fmtLangLabel();
        langBtn.title = 'Мова перекладу: ' + fmtLangLabel() + ' (клік — змінити)';
    });
    fmtBar.appendChild(langBtn);
    fmtBar.appendChild(mk('🌐→', 'hr-fmt-tr', 'Перекласти виділене на обрану мову (Ctrl+A — все)', (ta) => hrTranslateSelection(ta)));
    document.body.appendChild(fmtBar);
    window.addEventListener('scroll', () => { if (!fmtBar.hidden && fmtBarTa) positionFmtBar(fmtBarTa); }, true);
    window.addEventListener('resize', () => { if (!fmtBar.hidden && fmtBarTa) positionFmtBar(fmtBarTa); });
    // Надійне відстеження виділення: панель видно лише поки воно є.
    document.addEventListener('selectionchange', () => {
        const ae = document.activeElement;
        if (ae && ae.classList && ae.classList.contains('ispui-input__textarea') && ae.selectionStart !== ae.selectionEnd) updateFmtBar(ae);
        else hideFmtBar();
    });
    return fmtBar;
}
function showFmtBar(ta) { ensureFmtBar(); fmtBarTa = ta; fmtBar.hidden = false; positionFmtBar(ta); }
function hideFmtBar() { if (fmtBar) fmtBar.hidden = true; }
function injectSnippetButton() {
    const ta = document.querySelector('textarea.ispui-input__textarea');
    if (!ta || !ta.parentNode || ta.dataset.hrSnip === '1') return;
    ta.dataset.hrSnip = '1';
    // Місце знизу під панель форматування (щоб не перекривала текст).
    ta.style.setProperty('padding-bottom', '36px', 'important');
    // Панель зʼявляється лише коли виділено текст.
    ta.addEventListener('select', () => updateFmtBar(ta));
    ta.addEventListener('keyup', () => updateFmtBar(ta));
    ta.addEventListener('mouseup', () => updateFmtBar(ta));
    ta.addEventListener('blur', () => setTimeout(hideFmtBar, 200));
    ta.addEventListener('input', () => { if (fmtBar && !fmtBar.hidden) positionFmtBar(ta); });
    // Інлайн-автодоповнення: під час набору показуємо список збігів.
    ta.addEventListener('input', () => updateAc(ta));
    ta.addEventListener('keydown', (e) => {
        // Навігація по списку підказок, якщо він відкритий.
        if (acEl && !acEl.hidden && acItems.length) {
            if (e.key === 'ArrowDown') { acIndex = (acIndex + 1) % acItems.length; renderAc(ta); e.preventDefault(); return; }
            if (e.key === 'ArrowUp') { acIndex = (acIndex - 1 + acItems.length) % acItems.length; renderAc(ta); e.preventDefault(); return; }
            if (e.key === 'Enter' || e.key === 'Tab') { applySnippetAtCursor(ta, acItems[acIndex]); hideAc(); e.preventDefault(); return; }
            if (e.key === 'Escape') { hideAc(); e.preventDefault(); return; }
        }
        // Tab без списку → розгорнути шаблон за скороченням/початком назви.
        if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
            if (expandSnippetTab(ta)) e.preventDefault();
        }
        // Ctrl/Cmd+B / +I → форматування.
        if ((e.ctrlKey || e.metaKey) && !e.altKey) {
            const k = (e.key || '').toLowerCase();
            if (k === 'b') { e.preventDefault(); hrFmtWrap(ta, HR_FMT.bold[0], HR_FMT.bold[1]); }
            else if (k === 'i') { e.preventDefault(); hrFmtWrap(ta, HR_FMT.italic[0], HR_FMT.italic[1]); }
        }
        if (e.key === 'Escape') hideFmtBar();
    });
    ta.addEventListener('blur', () => setTimeout(hideAc, 150));
    ta.addEventListener('scroll', hideAc);
}

// Кнопка перекладу під кожним вхідним повідомленням клієнта (перекладає лише
// текст повідомлення — без імені/дати; одна кнопка на повідомлення).
function injectMsgTranslate() {
    document.querySelectorAll(TRANSLATABLE_MSG_SEL).forEach((msgBody) => {
        if (msgBody.dataset.hrTr === '1') return;
        msgBody.dataset.hrTr = '1';
        const original = (msgBody.textContent || '').trim();
        let box = null;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'hr-msg-tr';
        btn.title = 'Перекласти повідомлення';
        setSvg(btn, HR_TR_ICON);
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            if (box) { box.remove(); box = null; return; }
            if (!original) return;
            btn.disabled = true; btn.style.opacity = '0.4';
            hrTranslate(original, settings.myLang, (out) => {
                btn.disabled = false; btn.style.opacity = '';
                if (out == null) return;
                box = makeElc('div', 'hr-msg-tr-text', out);
                btn.parentNode.insertBefore(box, btn.nextSibling); // під кнопкою/повідомленням
            });
        });
        msgBody.parentNode.insertBefore(btn, msgBody.nextSibling); // одразу під текстом
        if (settings.autoTranslateIncoming && original) btn.click();
    });
}

// --- Розумні підказки шаблонів за змістом тікета ---------------------------
function ticketKeywords() {
    let text = '';
    document.querySelectorAll(INCOMING_MSG_SEL).forEach((b) => { text += ' ' + (b.textContent || ''); });
    const title = document.querySelector('.isp-inline-group__title, h1');
    if (title) text += ' ' + (title.textContent || '');
    const words = (text.slice(0, 4000).match(/[a-zа-яіїєґ0-9]{4,}/gi) || []).map((w) => w.toLowerCase());
    return new Set(words);
}
function snippetScore(s, kw) {
    if (!kw.size) return 0;
    const cnt = (str, weight) => {
        let n = 0;
        (String(str || '').match(/[a-zа-яіїєґ0-9]{4,}/gi) || []).forEach((w) => { if (kw.has(w.toLowerCase())) n += weight; });
        return n;
    };
    return cnt(s.title, 3) + cnt(s.category, 3) + cnt(s.body, 1);
}
function suggestSnippets(limit) {
    const kw = ticketKeywords();
    return snippets
        .map((s) => ({ s, score: snippetScore(s, kw) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit || 3)
        .map((x) => x.s);
}
let lastSuggestTicket = null;
let suggestDismissed = null;
function injectSnippetSuggest() {
    const ta = document.querySelector('textarea.ispui-input__textarea');
    // Верхній бар поля відповіді (поряд із рідним «Шаблоны»).
    const bar = ta && ta.closest('isp-chat-input') ? ta.closest('isp-chat-input').querySelector('.isp-buttons-block') : null;
    if (!ta || !bar) return;
    if (!settings.snipSuggest) {
        const ex = document.getElementById('hr-suggest');
        if (ex) ex.remove();
        lastSuggestTicket = null;
        return;
    }
    if (!snippets.length) return; // шаблони ще не завантажились — спробуємо наступного refresh
    const tid = readTicketId() || '';
    if (suggestDismissed === tid) return;
    if (lastSuggestTicket === tid && document.getElementById('hr-suggest')) return;
    lastSuggestTicket = tid;
    const old = document.getElementById('hr-suggest');
    if (old) old.remove();
    const sugg = suggestSnippets(3);
    if (!sugg.length) return;
    const row = makeElc('div', 'hr-suggest');
    row.id = 'hr-suggest';
    row.appendChild(makeElc('span', 'hr-suggest-label', 'Підказки:'));
    sugg.forEach((s) => {
        const chip = makeElc('button', 'hr-suggest-chip', s.title || (s.body || '').slice(0, 24));
        chip.type = 'button';
        chip.title = (s.body || '').slice(0, 200);
        chip.addEventListener('click', (ev) => { ev.preventDefault(); insertIntoReply(ta, fillSnippet(s)); });
        row.appendChild(chip);
    });
    const close = makeElc('button', 'hr-suggest-x', '×');
    close.type = 'button';
    close.title = 'Сховати';
    close.addEventListener('click', (ev) => { ev.preventDefault(); row.remove(); suggestDismissed = tid; });
    row.appendChild(close);
    bar.appendChild(row); // у верхній бар, праворуч від «Шаблоны»
}

function refresh() {
    if (!alive) return;
    if (!extensionAlive()) { teardown(); return; }
    injectAddReminderButton();
    injectSnippetButton();
    injectMsgTranslate();
    injectSnippetSuggest();

    // Підстраховка висоти поля відповіді (стильову таблицю міг перебити inline).
    const ta = document.querySelector('textarea.ispui-input__textarea');
    if (ta) {
        if (settings.resizeEnabled) {
            ta.style.setProperty('height', settings.resizePx + 'px', 'important');
            ta.style.scrollMarginTop = 'initial';
            ta.dataset.hrResized = '1';
        } else if (ta.dataset.hrResized) {
            ta.style.removeProperty('height');
            ta.style.removeProperty('scroll-margin-top');
            delete ta.dataset.hrResized;
        }
    }

    const now = Date.now();
    const applied = new Set();
    const matchedTimerKeys = new Set();
    const visible = new Set();
    const newMsgNow = new Set();
    let timersDirty = false;

    // Час-залежні будильники рахуються незалежно від наявності рядка.
    const activeReminders = computeActiveReminders(now);
    const activeTicketIds = new Set(activeReminders.map((r) => r.ticketId));

    document.querySelectorAll(ROW_SELECTOR).forEach((row) => {
        const subject = getCellText(row, SUBJECT_SELECTOR);
        const ticket = getCellText(row, TICKET_SELECTOR);
        if (ticket) visible.add(ticket); // для API-скану: цей тікет зараз видно
        if (settings.replyWatch && ticket && rowHasNewMsg(row)) newMsgNow.add(ticket);

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
                    fireAlert(subject || tag.rule.query, { sound: tag.rule.sound, notify: tag.rule.notify, kind: 'tag' });
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
                        fireAlert(blockedName, { sound: settings.soundEnabled, notify: true, kind: 'blocked' });
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

    // Стеження за відповіддю клієнта (DOM): сигналимо ЛИШЕ коли тікет, який МИНУЛОГО
    // проходу був на екрані БЕЗ позначки, тепер її отримав (реальна поява повідомлення).
    // Перемикання сторінок не сигналить — ті рядки не були видимі раніше.
    if (settings.replyWatch) {
        if (repliedVisible) {
            const soundOn = settings.replySound !== 'none';
            newMsgNow.forEach((t) => {
                if (repliedVisible.has(t) && !repliedSeen.has(t)) {
                    fireAlert('#' + t, { sound: soundOn, notify: true, kind: 'reply', ticket: t, soundWhich: 'reply' });
                }
            });
        }
        repliedVisible = visible;
        repliedSeen = newMsgNow;
    } else {
        repliedVisible = null;
        repliedSeen = null;
    }

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

// Коли сесія злетіла, billmgr редіректить на логін (інший домен). Розпізнаємо
// це, щоб не йти за редіректом (зайва CORS-помилка) і не довбати білінг, поки
// користувач розлогінений.
const SESSION_LOST_COOLDOWN_MS = 15 * 60 * 1000;
let sessionLostAt = 0;
function noteSessionLost() { sessionLostAt = Date.now(); }
function sessionInCooldown() { return Date.now() - sessionLostAt < SESSION_LOST_COOLDOWN_MS; }

// Автоматичні мережеві скани робить лише видима (активна) вкладка — щоб reload
// усіх вкладок Zomro не давав синхронного сплеску запитів до білінгу.
function tabVisible() { return document.visibilityState === 'visible'; }

async function fetchBillmgr(params) {
    // sfrom=ajax — як рідні запити панелі: без нього billmgr віддає 301 на
    // ticket.edit і це ламає сесійну куку (панель кидає на логін). out=xjson — JSON.
    const url = location.origin + '/billmgr?' + params + '&sfrom=ajax&out=xjson';
    const resp = await fetch(url, { credentials: 'include', redirect: 'manual' });
    // Сесія злетіла = редірект на логін: opaqueredirect (status 0), 3xx або
    // HTML-сторінка логіну. НЕ чіпаємо «не-json» content-type — billmgr для ajax
    // інколи віддає text/plain з валідним JSON (інакше хибно гасили б трафік).
    const ct = resp.headers ? (resp.headers.get('content-type') || '') : '';
    if (resp.type === 'opaqueredirect' || resp.redirected ||
        (resp.status >= 300 && resp.status < 400) ||
        (ct && ct.indexOf('html') !== -1)) {
        noteSessionLost();
        throw new Error('session-redirect');
    }
    const json = await resp.json();
    sessionLostAt = 0; // успішна відповідь — сесія жива
    return json.doc || json;
}

let staleScanRunning = false;

// Сканує чергу через API: для кожного тікета знаходить останню відповідь
// підтримки (повідомлення $type="outcoming") і відбирає ті, де від неї минуло
// понад settings.staleHours. Якщо підтримка ще не відповідала — рахує від
// дати створення. Результат пише в storage.local.staleTickets (читає popup).
// Прогрес скану для popup (скільки тікетів просканували / пройшли поріг).
function setStaleStatus(o) { try { chrome.storage.local.set({ staleScanStatus: o }); } catch (e) { /* ignore */ } }

async function scanStaleTickets(force) {
    if (!alive || !extensionAlive() || staleScanRunning) return;
    // Вимкнено — не скануємо (інакше ticket.edit гасить позначку нового повідомлення).
    if (!settings.staleEnabled) { if (force) setStaleStatus({ scanning: false, note: 'монітор вимкнено' }); return; }
    // Скан ходить у billmgr same-origin — лише на сторінці панелі.
    if (!onBillmgr()) { if (force) setStaleStatus({ scanning: false, note: 'відкрийте сторінку панелі (billmgr)' }); return; }
    // Сесія нещодавно злетіла — не довбати білінг (ручний force усе ж пробує).
    if (!force && sessionInCooldown()) return;
    // Авто-скан — лише з активної вкладки (фонові мовчать).
    if (!force && !tabVisible()) return;

    // Дедуплікація між вкладками: не сканувати, якщо нещодавно вже сканували.
    // Ручне оновлення (force) ігнорує цей таймер.
    if (!force) {
        const last = await loadFromStorage('local', 'stalePollAt', 0);
        if (Date.now() - (last || 0) < STALE_POLL_DEDUP_MS) return;
    }
    try { chrome.storage.local.set({ stalePollAt: Date.now() }); } catch (e) { return; }

    staleScanRunning = true;
    let total = 0, scanned = 0;
    let sessionLost = false;
    const result = [];
    try {
        // Скануємо всю чергу (всі сторінки), а не лише поточну — інакше тікети
        // з інших сторінок не потраплять у монітор. fetchAllTickets() сам
        // оновлює локалізовані підписи й повертає користувача на його сторінку.
        const elems = await fetchAllTickets();
        total = elems.length;
        setStaleStatus({ scanning: true, total, scanned: 0, passed: 0, at: Date.now() });
        const thresholdMs = settings.staleHours * 60 * 60 * 1000;
        const now = Date.now();

        for (const el of elems) {
            if (!alive || !extensionAlive()) break;
            const elid = fieldVal(el.id);
            const ticketNo = fieldVal(el.ticket);
            if (!elid) continue;
            scanned++;

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
            if (ref !== null && (now - ref) > thresholdMs) {
                result.push({
                    ticketId: ticketNo,
                    subject: fieldVal(el.name),
                    client: fieldVal(el.client),
                    hours: (now - ref) / 3600000,
                    noReply: lastSupport === null,
                    url: elid ? location.origin + '/billmgr?startform=ticket.edit&elid=' + encodeURIComponent(elid) : '',
                });
            }
            setStaleStatus({ scanning: true, total, scanned, passed: result.length, at: Date.now() });
            await sleep(STALE_FETCH_GAP_MS);
        }

        result.sort((a, b) => b.hours - a.hours);
        try { chrome.storage.local.set({ staleTickets: result }); } catch (e) {}
    } catch (e) {
        if (e && e.message === 'session-redirect') sessionLost = true;
        // інакше мережа/парсинг — спробуємо наступного разу
    } finally {
        staleScanRunning = false;
        if (sessionLost) setStaleStatus({ scanning: false, note: 'панель розлогінено — оновіть сторінку' });
        else setStaleStatus({ scanning: false, total, scanned, passed: result.length, at: Date.now() });
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
async function fetchAllTickets(onPage) {
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
        if (onPage) { try { onPage(all, pnum); } catch (e) { /* ignore */ } }
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

function setMatchStatus(o) { try { chrome.storage.local.set({ matchScanStatus: o }); } catch (e) { /* ignore */ } }

// Чистий збір збігів (тег/блок/будильник) із переліку тікетів — без алертів.
// Використовується для проміжного рендера під час скану (щоб тікети з'являлися
// поступово, а не тільки в кінці).
function extractMatchList(tickets, reminderIds) {
    const byId = {};
    const ensure = (ticketId, elid, subject) => {
        if (!byId[ticketId]) {
            byId[ticketId] = {
                ticketId, subject, kinds: [],
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
        if (tagRuleForSubject(subject)) ensure(ticketId, elid, subject).kinds.push('tag');
        if (settings.enabled && settings.names.length) {
            const blk = fieldVal(t.blocked_by);
            if (blk && settings.names.find((n) => n && blk.includes(n))) ensure(ticketId, elid, subject).kinds.push('blocked');
        }
        if (reminderIds && reminderIds.has(ticketId)) ensure(ticketId, elid, subject).kinds.push('reminder');
    }
    return Object.values(byId).map((m) => ({ ...m, kinds: [...new Set(m.kinds)] }));
}

async function scanMatches(force) {
    if (!alive || !extensionAlive() || matchScanRunning) return;
    if (!onBillmgr()) { if (force) setMatchStatus({ scanning: false, note: 'відкрийте сторінку панелі (billmgr)' }); return; }
    if (!force && sessionInCooldown()) return;
    if (!force) {
        const last = await loadFromStorage('local', 'matchPollAt', 0);
        if (Date.now() - (last || 0) < MATCH_POLL_DEDUP_MS) return;
    }
    try { chrome.storage.local.set({ matchPollAt: Date.now() }); } catch (e) { return; }

    matchScanRunning = true;
    let matchCount = 0;
    let sessionLost = false;
    try {
        setMatchStatus({ scanning: true, count: 0 });
        const now = Date.now();
        const reminderIds = new Set(computeActiveReminders(now).map((r) => r.ticketId));
        // Проміжний рендер: після кожної сторінки показуємо знайдене + прогрес.
        const tickets = await fetchAllTickets((soFar, pnum) => {
            const partial = extractMatchList(soFar, reminderIds);
            try { chrome.storage.local.set({ matchTickets: partial }); } catch (e) { /* ignore */ }
            setMatchStatus({ scanning: true, count: partial.length, page: pnum });
        });
        const byId = {};
        const activeKeys = new Set();
        let stateDirty = false;

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
                        fireAlert(subject || rule.query, { sound: rule.sound, notify: rule.notify, kind: 'tag', url: elid ? location.origin + '/billmgr?startform=ticket.edit&elid=' + encodeURIComponent(elid) : '' });
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
                                fireAlert(name, { sound: settings.soundEnabled, notify: true, kind: 'blocked', url: elid ? location.origin + '/billmgr?startform=ticket.edit&elid=' + encodeURIComponent(elid) : '' });
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
        matchCount = list.length;
        const json = JSON.stringify(list);
        if (json !== lastMatchJson) {
            lastMatchJson = json;
            try { chrome.storage.local.set({ matchTickets: list }); } catch (e) {}
        }
        try { chrome.runtime.sendMessage({ action: 'setBadge', count: list.length }); } catch (e) {}
    } catch (e) {
        if (e && e.message === 'session-redirect') sessionLost = true;
        // інакше мережа/парсинг — наступного разу
    } finally {
        matchScanRunning = false;
        if (sessionLost) setMatchStatus({ scanning: false, note: 'панель розлогінено — оновіть сторінку' });
        else setMatchStatus({ scanning: false, count: matchCount });
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
    // Адаптивні одиниці: малі обсяги не мають показуватись як «0.000 TB».
    if (raw === '' || raw === '-') return '—';
    if (!Number.isFinite(n)) return '?';
    const TB = 1024 ** 4, GB = 1024 ** 3, MB = 1024 ** 2, KB = 1024;
    const fmt = (x, d) => x.toFixed(d).replace(/\.?0+$/, '');
    if (n >= TB) return fmt(n / TB, 2) + ' ТБ';
    if (n >= GB) return fmt(n / GB, 2) + ' ГБ';
    if (n >= MB) return fmt(n / MB, 1) + ' МБ';
    if (n >= KB) return fmt(n / KB, 0) + ' КБ';
    return n + ' Б';
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
    return `${formatTB(trafficData.used)} / ${formatTB(trafficData.paid)}`;
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
// Вибрана послуга з поля «Услуга» (select name="item"). Текст: «#<id> ... (<ip>)».
function readSelectedService() {
    const el = document.querySelector('ispui-select-v2[name="item"] .isp-select__text');
    const txt = el ? (el.textContent || '') : '';
    const idm = txt.match(/#(\d+)/);
    const ipm = txt.match(/\(\s*((?:\d{1,3}\.){3}\d{1,3})\s*\)/);
    return { id: idm ? idm[1] : '', ip: ipm ? ipm[1] : '' };
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
            // Прив'язка до ВИБРАНОЇ послуги в полі «Услуга» (name="item"): у тексті
            // — «#<id> ... (<ip>)». Це надійніше за ticket.item (він не завжди збігається).
            const svc = readSelectedService();
            const item = svc.id || fieldVal(ticket.item);
            // Контекст клієнта (як кнопка «По клиенту») — інакше func=instances
            // не поверне його сервер.
            const plid = fieldVal(ticket.plid) || fieldVal(ticket.id);
            try {
                await fetchBillmgr('func=ticket.setfilter&elid=' + encodeURIComponent(elid) +
                    '&plid=' + encodeURIComponent(plid));
            } catch (e) { /* контекст міг бути вже виставлений */ }

            const inst = await fetchBillmgr('func=instances' + (item ? '&id=' + encodeURIComponent(item) : ''));
            const elems = asArray(inst.elem);
            // Збіг ЛИШЕ за унікальними ідентифікаторами (id послуги або uuid інстансу).
            // intname/itemtype НЕ унікальні (спільні для багатьох серверів) — за ними
            // підхоплювався не той сервер. Якщо у клієнта лише один сервер — беремо його.
            let match = item ? elems.find((e) =>
                fieldVal(e.id) === item ||
                fieldVal(e.instances_uuid) === item) : null;
            // Резерв: збіг за IP вибраної послуги (якщо id не зійшовся).
            if (!match && svc.ip) match = elems.find((e) => fieldVal(e.ip) === svc.ip);
            if (!match && elems.length === 1) match = elems[0];
            trafficData = match
                ? {
                    key,
                    id: fieldVal(match.id),
                    used: fieldVal(match.used_traffic),
                    paid: fieldVal(match.paid_traffic),
                    service: buildService(match),
                }
                : { key, notFound: true };
        }
        injectInfo();
    } catch (e) {
        // мережа/парсинг — спробуємо при наступному refresh
    } finally {
        trafficLoading = false;
    }
}

let trafficAttempts = {};
function maybeTraffic() {
    if (!settings.trafficEnabled) {
        if (trafficData) { trafficData = null; removeTrafficDom(); }
        return;
    }
    if (!onTicketView()) return; // не сторінка тікета
    const key = currentTicketKey();
    if (!key) return;
    // Дані вже є (успіх або «немає послуги») — лише перемалювати: Angular міг
    // стерти наш DOM при ре-рендері блоку.
    const resolved = trafficData && trafficData.key === key && (trafficData.none || trafficData.service != null);
    if (resolved) { injectInfo(); return; }
    // Ще не вийшло (блок ще не відрендерився / тимчасовий збій) — повторюємо до
    // кількох спроб, поки не підтягнеться. Без хибного 15-хв блокування.
    if (!tabVisible() || trafficLoading) return;
    const n = trafficAttempts[key] || 0;
    if (n >= 4) return; // здаємось — лишається ручний ↻
    trafficAttempts[key] = n + 1;
    loadTraffic(false);
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
        applyPanelTweaks();
        loadMyEmail();
        loadCustomSounds();
        loadSnippets();
        refresh();
        pingNewShared();

        try {
            chrome.storage.onChanged.addListener((changes, area) => {
                if (!alive) return;
                if (area === 'sync' && changes.settings) {
                    const oldHours = settings.staleHours;
                    settings = normalizeSettings(changes.settings.newValue);
                    applyPanelTweaks();
                    pingNewShared();
                    if (!settings.staleEnabled) {
                        // Вимкнули монітор — прибираємо застарілий список і статус.
                        try { chrome.storage.local.set({ staleTickets: [], staleScanStatus: null }); } catch (e) {}
                    } else if (settings.staleHours !== oldHours) {
                        // Змінили поріг: лише локально прибрати ті, що вже не підпадають
                        // (за збереженим віком). Повний скан — тільки за кнопкою «Оновити».
                        try {
                            chrome.storage.local.get('staleTickets', (d) => {
                                const arr = (d && d.staleTickets) || [];
                                const filtered = arr.filter((t) => t && t.hours > settings.staleHours);
                                if (filtered.length !== arr.length) chrome.storage.local.set({ staleTickets: filtered });
                            });
                        } catch (e) { /* ignore */ }
                    }
                    refresh();
                } else if (area === 'local' && changes.reminderState) {
                    reminderState = changes.reminderState.newValue || {};
                    refresh();
                } else if (area === 'local' && changes.sbSession) {
                    loadMyEmail();
                } else if (area === 'local' && changes.soundData) {
                    loadCustomSounds();
                } else if (area === 'local' && changes.snippets) {
                    loadSnippets();
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

            // Гарячі клавіші — лише коли висить банер HeartBeat і фокус не в полі вводу.
            document.addEventListener('keydown', (e) => {
                if (!alive || !document.getElementById('hr-reminder-banner')) return;
                if (e.ctrlKey || e.altKey || e.metaKey) return;
                const el = document.activeElement;
                const tag = el && el.tagName;
                if (tag === 'INPUT' || tag === 'TEXTAREA' || (el && el.isContentEditable)) return;
                const k = (e.key || '').toLowerCase();
                if (k === 't') { e.preventDefault(); claimActiveShared(); }
                else if (k === 'd') { e.preventDefault(); doneActiveShared(); }
                else if (k === 's') { e.preventDefault(); snoozeActiveReminders(); }
            });

            // Ctrl+K (Cmd+K) — палітра швидкого пошуку шаблонів (лише в тікеті з полем відповіді).
            document.addEventListener('keydown', (e) => {
                if (!alive) return;
                if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K')) {
                    if (!document.querySelector('textarea.ispui-input__textarea')) return;
                    e.preventDefault();
                    if (paletteEl) closePalette(); else openPalette();
                }
            }, true);


            observerRef = new MutationObserver(scheduleRefresh);
            observerRef.observe(document.body, { childList: true, subtree: true });

            intervalRef = setInterval(refresh, REFRESH_INTERVAL_MS);

            // «Без відповіді» та збіги по всій черзі («Особисті тікети») —
            // лише вручну, за кнопкою «Оновити» (без авто/періодичного обходу черги).

            // Спільні будильники: періодично підтягувати зі спільної бази
            // (фактичний fetch робить background; тут лише тригеримо з активної вкладки).
            setTimeout(() => { if (tabVisible()) sbSend({ sb: 'pull' }); }, 4000);
            sbPullIntervalRef = setInterval(() => { if (tabVisible()) sbSend({ sb: 'pull' }); }, MATCH_POLL_INTERVAL_MS);

            // Коли вкладка стає активною — довантажити що треба (кожен виклик
            // поважає власний дедуп/кеш, тож без сплеску).
            document.addEventListener('visibilitychange', () => {
                if (!alive || !tabVisible()) return;
                maybeTraffic();
                sbSend({ sb: 'pull' });
            });
        } catch (e) {
            teardown();
        }
    });
}

init();
