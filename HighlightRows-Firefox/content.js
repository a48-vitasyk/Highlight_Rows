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
    // «Клієнт чекає на відповідь» — постійний наростаючий стан + ескалація на команду
    replyWatchEscalate: false,
    replyEscalateMinutes: 5,   // через скільки хв очікування підключати всю команду
    replyRepeatMinutes: 1,     // як часто повторювати сигнал, поки не відповіси (0 = раз)
    replyWarnColor: '#ffd24a', // колір рядка/таймера на старті очікування
    replyDangerColor: '#ff3b30', // колір при довгому очікуванні (після ескалації)
    quickReplies: true,        // панель швидких дій у таймері «клієнт чекає»
    quickHoldText: { uk: '', ru: '', en: '' }, // «Вже дивимось» за мовою (порожньо → вбудований дефолт)
    quickUpdText: { uk: '', ru: '', en: '' },  // «Апдейт» за мовою (порожньо → вбудований дефолт)
    updateEveryMinutes: 20,    // нагадати надіслати апдейт після N хв очікування (0 = вимкнено)
    // «без відповіді понад N год» — список у popup
    staleEnabled: false, // вимкнено за замовч.: скан відкриває тікети й гасить позначку нового повідомлення
    staleHours: 4,
    // «Клієнт чекає» (блок на Головній) — ручний локальний скан: клієнт без відповіді > N хв
    awaitWaitMinutes: 30,
    // Premium-тікети (вкладка «Тікети»): відділи (підрядки responsible) + SLA першої відповіді
    premiumDepartments: ['Премиум', 'Преміум', 'Premium'],
    premiumSlaMinutes: 30,
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
// «Клієнт чекає на відповідь»
let awaitingMap = {};     // { [ticketId]: { elid, subject, url, waitingSince, ownerEmail, lastAlert, lastRecheck } } — мої виявлення
let awaitingShared = [];  // дзеркало спільного пулу (storage.local.awaitingShared) — уся команда
let awAnchorQueue = [];   // [{ ticket, elid }] — нові тікети на анкоринг (ticket.edit)
let awDraining = false;   // чи виконується awDrain зараз
let awNotifiedAt = {};    // { [ticketId]: ms } — троттл повтору сповіщень
let awSnooze = {};        // { [ticketId]: untilMs } — банер+сигнал по тікету приглушено до цього ms
let awSharedRecheck = {}; // { [ticketId]: ms } — коли востаннє перевіряли чужий тікет пулу через API
let awBubbleBaseline = null; // { ticketId, count } — для миттєвого очищення на вихідному баблі
let knownElids = {};        // { [номер тікета]: elid } — для відкриття тікета з будильника/сповіщення
let awOpenWait = { ticket: '', since: undefined, at: 0, fetching: false }; // wait відкритого тікета (коли ескалацію вимкнено)
let replyAudio = null;    // окремий зацикл. звук відповіді (не плутати з reminderAudio)
let awTimerInterval = null; // 1с-тік таймера в тікеті
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
let matchTickets = [];          // дзеркало storage.local.matchTickets — для live-очищення блок-збігів
let matchBubbleBaseline = null; // { ticketId, count } — базлайн вихідних баблів відкритого тікета
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
    if (awTimerInterval) { clearInterval(awTimerInterval); awTimerInterval = null; }
    if (observerRef) { observerRef.disconnect(); observerRef = null; }
    clearTimeout(debounceTimer);
    stopReminderAudio();
    removeReminderBanner();
    removeAwaitingBanner();
    awRemoveTimer();
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
    s.awaitWaitMinutes = Number(s.awaitWaitMinutes);
    if (!(s.awaitWaitMinutes > 0)) s.awaitWaitMinutes = DEFAULT_SETTINGS.awaitWaitMinutes;
    s.premiumDepartments = (Array.isArray(s.premiumDepartments) ? s.premiumDepartments : [])
        .map((d) => String(d).trim()).filter(Boolean);
    if (!s.premiumDepartments.length) s.premiumDepartments = DEFAULT_SETTINGS.premiumDepartments.slice();
    s.premiumSlaMinutes = Number(s.premiumSlaMinutes);
    if (!(s.premiumSlaMinutes > 0)) s.premiumSlaMinutes = DEFAULT_SETTINGS.premiumSlaMinutes;
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
    s.replyWatchEscalate = !!s.replyWatchEscalate;
    s.replyEscalateMinutes = Number(s.replyEscalateMinutes);
    if (!(s.replyEscalateMinutes > 0)) s.replyEscalateMinutes = DEFAULT_SETTINGS.replyEscalateMinutes;
    s.replyRepeatMinutes = Math.max(0, Number(s.replyRepeatMinutes) || 0);
    s.replyWarnColor = String(s.replyWarnColor || DEFAULT_SETTINGS.replyWarnColor);
    s.replyDangerColor = String(s.replyDangerColor || DEFAULT_SETTINGS.replyDangerColor);
    s.quickReplies = s.quickReplies !== false;
    const nq = (v) => (v && typeof v === 'object')
        ? { uk: String(v.uk || ''), ru: String(v.ru || ''), en: String(v.en || '') }
        : { uk: String(v || ''), ru: '', en: '' }; // легасі: рядок → у поле uk
    s.quickHoldText = nq(s.quickHoldText);
    s.quickUpdText = nq(s.quickUpdText);
    s.updateEveryMinutes = Math.max(0, Number(s.updateEveryMinutes) || 0);
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

// Час спрацювання будильника (ms). Підтримує два формати поля time:
//  - "YYYY-MM-DDTHH:MM" (datetime-local) → конкретний момент (разово);
//  - "HH:MM" (легасі) → сьогодні о цій годині (добове).
function reminderTarget(s) {
    s = String(s || '').trim();
    const dt = /^(\d{4})-(\d{2})-(\d{2})T(\d{1,2}):(\d{2})$/.exec(s);
    if (dt) {
        const h = +dt[4], min = +dt[5];
        if (h > 23 || min > 59) return null;
        return new Date(+dt[1], +dt[2] - 1, +dt[3], h, min, 0, 0).getTime();
    }
    const m = /^(\d{1,2}):(\d{2})$/.exec(s);
    if (!m) return null;
    const h = +m[1], min = +m[2];
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

let knownElidsTimer = null;
function persistKnownElids() {
    clearTimeout(knownElidsTimer);
    knownElidsTimer = setTimeout(() => {
        try {
            if (Object.keys(knownElids).length > 1500) knownElids = {}; // обмежити кеш — наступні скани наповнять знову
            chrome.storage.local.set({ ticketElids: knownElids });
        } catch (e) { /* ignore */ }
    }, 1000);
}
function elidUrl(elid) { return location.origin + '/billmgr?startform=ticket.edit&elid=' + encodeURIComponent(elid); }
// Відкрити тікет за номером: elid із кешу → інакше дорезолв через чергу billmgr.
async function openTicketByNumber(num) {
    num = String(num || '').trim();
    if (!num) return;
    let elid = knownElids[num];
    if (!elid && onBillmgr() && !sessionInCooldown()) {
        let pageSize = 0;
        for (let pnum = 1; pnum <= MATCH_MAX_PAGES; pnum++) {
            if (!alive || !extensionAlive()) break;
            let doc; try { doc = await fetchBillmgr('func=ticket&p_num=' + pnum); } catch (e) { break; }
            const elems = asArray(doc.elem);
            for (const el of elems) { const t = fieldVal(el.ticket), id = fieldVal(el.id); if (id && t) knownElids[t] = id; if (String(t) === num) elid = id; }
            if (elid) break;
            if (pnum === 1) pageSize = elems.length;
            if (elems.length === 0 || (pageSize > 0 && elems.length < pageSize)) break;
            await sleep(STALE_FETCH_GAP_MS);
        }
        persistKnownElids();
    }
    if (elid) location.href = elidUrl(elid);
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
            url: knownElids[reminder.ticketId] ? elidUrl(knownElids[reminder.ticketId]) : '',
        });
    } catch (e) {
        teardown();
    }
}

// --- Банер будильника на сторінці ----------------------------------------

// Плаваючий банер угорі панелі з кнопкою «Заглушити» (снуз 10 хв). Звук
// будильника йде зі сторінки, тож кнопка глушіння теж тут — працює однаково
// в Chrome і Firefox.
function rbMkBtn(cls, label, title, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hr-reminder-banner-btn ' + cls;
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener('click', (e) => { e.preventDefault(); onClick(); });
    return b;
}
// Сигнатура активних — щоб перебудовувати список лише коли він змінився (анти-флікер).
function rbSignature(active) {
    return active.map((r) => r.id + ':' + (r.scope || '') + ':' + (r.ownerEmail || '')).join('|');
}
function ensureReminderBanner(active) {
    if (!document.body) return;
    let banner = document.getElementById('hr-reminder-banner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'hr-reminder-banner';
        const head = document.createElement('div');
        head.className = 'hr-rb-head';
        const title = document.createElement('span');
        title.className = 'hr-rb-title';
        head.appendChild(title);
        const acts = document.createElement('div');
        acts.className = 'hr-rb-head-acts';
        acts.appendChild(rbMkBtn('hr-rb-take', 'Взяти всі', 'Взяти всі (клавіша T)', claimActiveShared));
        acts.appendChild(rbMkBtn('hr-rb-done', 'Відписав всі', 'Відписав всі (клавіша D)', doneActiveShared));
        acts.appendChild(rbMkBtn('hr-rb-snooze', 'Відкласти всі', 'Заглушити всі (клавіша S)', snoozeActiveReminders));
        head.appendChild(acts);
        banner.appendChild(head);
        const list = document.createElement('div');
        list.className = 'hr-rb-list';
        banner.appendChild(list);
        document.body.appendChild(banner);
    }
    // Шапка: заголовок + видимість гуртових «взяти/відписав» (лише якщо є спільні).
    const hasShared = !!myEmail && active.some((r) => r.scope === 'shared');
    const titleEl = banner.querySelector('.hr-rb-title');
    const titleTxt = '⏰ Будильники (' + active.length + ')';
    if (titleEl.textContent !== titleTxt) titleEl.textContent = titleTxt;
    const takeAll = banner.querySelector('.hr-rb-head .hr-rb-take');
    const doneAll = banner.querySelector('.hr-rb-head .hr-rb-done');
    const snoozeAll = banner.querySelector('.hr-rb-head .hr-rb-snooze');
    if (takeAll) takeAll.hidden = !hasShared;
    if (doneAll) doneAll.hidden = !hasShared;
    if (snoozeAll) { const sl = 'Відкласти всі (' + settings.snoozeMinutes + ' хв)'; if (snoozeAll.textContent !== sl) snoozeAll.textContent = sl; }
    // Рядки — перебудовуємо лише коли змінилась сигнатура (анти-флікер).
    const list = banner.querySelector('.hr-rb-list');
    const sig = rbSignature(active);
    if (list.dataset.sig === sig) return;
    list.dataset.sig = sig;
    list.innerHTML = '';
    const snoozeLabel = '× ' + settings.snoozeMinutes + ' хв';
    for (const r of active) {
        const row = document.createElement('div');
        row.className = 'hr-rb-row';
        const txt = document.createElement('span');
        txt.className = 'hr-rb-row-text';
        let s = '#' + r.ticketId + (r.note ? ' — ' + r.note : '');
        if (r.scope === 'shared' && r.ownerEmail) s += (r.ownerEmail === myEmail ? ' (ви)' : ' (взяв ' + r.ownerEmail.split('@')[0] + ')');
        txt.textContent = s;
        row.appendChild(txt);
        const acts = document.createElement('div');
        acts.className = 'hr-rb-row-acts';
        if (r.scope === 'shared' && myEmail && r.ownerEmail !== myEmail) {
            acts.appendChild(rbMkBtn('hr-rb-take', 'Взяв', 'Взяти цей', () => claimReminderOne(r.id)));
        }
        if (r.scope === 'shared' && myEmail) {
            acts.appendChild(rbMkBtn('hr-rb-done', 'Відписав', 'Відписав цей', () => doneReminderOne(r.id)));
        }
        acts.appendChild(rbMkBtn('hr-rb-snooze', snoozeLabel, 'Відкласти цей', () => snoozeReminderOne(r.id)));
        row.appendChild(acts);
        list.appendChild(row);
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

// --- Дії над ОДНИМ будильником у банері (адресно за id) -------------------
// Оптимістично оновлюємо локально, шлемо в базу (ids:[id]), а refresh() сам
// вирішує: лишились інші активні → звук і банер тривають; ні → стоп.
function claimReminderOne(id) {
    if (!myEmail) return;
    const r = settings.reminders.find((x) => x.id === id);
    if (!r || r.scope !== 'shared' || r.ownerEmail === myEmail) return;
    r.ownerEmail = myEmail; r.takenAt = Date.now();
    sbSend({ sb: 'claim', ids: [id] });
    refresh();
}
function doneReminderOne(id) {
    if (!myEmail) return;
    const r = settings.reminders.find((x) => x.id === id);
    if (!r || r.scope !== 'shared') return;
    r.doneAt = Date.now(); r.doneByEmail = myEmail;
    sbSend({ sb: 'done', ids: [id] });
    refresh();
}
function snoozeReminderOne(id) {
    const r = settings.reminders.find((x) => x.id === id);
    if (!r) return;
    const until = Date.now() + Math.round(settings.snoozeMinutes * 60 * 1000);
    reminderState[id] = { ...(reminderState[id] || {}), snoozeUntil: until };
    try { chrome.storage.local.set({ reminderState }); } catch (e) { teardown(); return; }
    sbSend({ sb: 'snooze', ids: [id], until });
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
        const target = reminderTarget(r.time);
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
        expire: '', traffic: '', service: '', serviceid: '',
    };
    if (trafficData && trafficData.service) {
        if (!v.os) v.os = trafficData.service.os || '';
        v.expire = trafficData.service.expiredate || '';
    }
    if (trafficData) {
        if (trafficData.used != null && trafficData.paid != null && !trafficData.notFound && !trafficData.none) {
            v.traffic = formatTB(trafficData.used) + ' / ' + formatTB(trafficData.paid);
        }
        v.service = trafficData.name || '';
        v.serviceid = trafficData.id || '';
        if (trafficData.ip) v.ip = trafficData.ip; // IP саме вибраної/матчингової послуги (DOM — резерв вище)
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
    return String(text || '').replace(/\{(ticket|ip|os|start|expire|traffic|serviceid|service|greeting|date|time)\}/g, (m, k) => v[k] || '');
}
// Tab-розгортання: токен перед курсором → шаблон, чия назва починається з токена
// (або будь-яке слово назви починається з нього). Повертає true, якщо розгорнули.
// Скорочення може містити кілька варіантів через «|» (напр. «перезапуск|gthtpfgecr»),
// щоб спрацьовувало навіть із забутою розкладкою. Повертає список варіантів (lowercase).
function shortcutAliases(s) {
    return String((s && s.shortcut) || '').split('|').map((a) => a.trim().toLowerCase()).filter(Boolean);
}
// Перший варіант (оригінальний регістр) — для показу в підказці.
function shortcutLabel(s) {
    const first = String((s && s.shortcut) || '').split('|').map((a) => a.trim()).filter(Boolean)[0];
    return first || '';
}
function findSnippetByToken(token, allowTitle) {
    const t = token.toLowerCase();
    // 1) точний збіг по скороченню (будь-який варіант) — працює навіть для 1 літери
    let m = snippets.find((s) => shortcutAliases(s).indexOf(t) !== -1);
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
    snippets.forEach((s) => { if (shortcutAliases(s).some((a) => a.startsWith(t))) add(s); });
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
        if (s.shortcut) it.appendChild(makeElc('span', 'hr-snip-ac-sc', shortcutLabel(s)));
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
        const aliases = shortcutAliases(s);
        const body = (s.body || '').toLowerCase();
        let score = 0;
        if (aliases.indexOf(q) !== -1) score = 100;
        else if (aliases.some((a) => a.startsWith(q))) score = 80;
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
        if (s.shortcut) it.appendChild(makeElc('span', 'hr-snip-ac-sc', shortcutLabel(s)));
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

// --- Виправлення розкладки (Punto-lite): кнопка «⇄» + Ctrl+Shift+L ----------
// QWERTY-клавіша → кирилиця. База спільна для UA/RU; відмінності окремо.
const QW_CYR_BASE = {
    q: 'й', w: 'ц', e: 'у', r: 'к', t: 'е', y: 'н', u: 'г', i: 'ш', o: 'щ', p: 'з', '[': 'х',
    a: 'ф', d: 'в', f: 'а', g: 'п', h: 'р', j: 'о', k: 'л', l: 'д', ';': 'ж',
    z: 'я', x: 'ч', c: 'с', v: 'м', b: 'и', n: 'т', m: 'ь', ',': 'б', '.': 'ю',
};
const QW_CYR_UA = Object.assign({}, QW_CYR_BASE, { s: 'і', ']': 'ї', "'": 'є' });
const QW_CYR_RU = Object.assign({}, QW_CYR_BASE, { s: 'ы', ']': 'ъ', "'": 'э' });
// Кирилиця → QWERTY-клавіша (інверсія обох розкладок).
const CYR_TO_LAT = (function () {
    const m = {};
    [QW_CYR_UA, QW_CYR_RU].forEach((map) => { for (const k in map) if (!(map[k] in m)) m[map[k]] = k; });
    return m;
})();
function convChar(ch, toLat) {
    const low = ch.toLowerCase();
    const table = toLat ? CYR_TO_LAT : (settings.myLang === 'ru' ? QW_CYR_RU : QW_CYR_UA);
    const out = table[low];
    if (out == null) return ch; // невідомий символ лишаємо як є
    return (ch !== low) ? out.toUpperCase() : out;
}
// Авто-напрям: більше кирилиці → користувач хотів латиницю (і навпаки).
function convertLayout(text) {
    let cyr = 0, lat = 0;
    for (const ch of text) {
        if (/[а-яёіїєґ]/i.test(ch)) cyr++;
        else if (/[a-z]/i.test(ch)) lat++;
    }
    if (!cyr && !lat) return text;
    const toLat = cyr >= lat;
    let out = '';
    for (const ch of text) out += convChar(ch, toLat);
    return out;
}
function isEditableField(el) {
    if (!el) return false;
    if (el.tagName === 'TEXTAREA') return true;
    return el.tagName === 'INPUT' && /^(text|search|)$/i.test(el.type || '');
}
function fixLayoutInField(el) {
    if (!isEditableField(el) || el.value == null || el.selectionStart == null) return;
    let s = el.selectionStart, e = el.selectionEnd;
    if (s === e) { s = 0; e = el.value.length; } // нема виділення → усе поле
    const seg = el.value.slice(s, e);
    if (!seg) return;
    const fixed = convertLayout(seg);
    if (fixed === seg) return;
    el.value = el.value.slice(0, s) + fixed + el.value.slice(e);
    try { el.setSelectionRange(s, s + fixed.length); } catch (err) { /* ignore */ }
    el.focus();
    el.dispatchEvent(new Event('input', { bubbles: true })); // щоб Angular ngModel підхопив
}
function injectLayoutFixBtn() {
    const ta = document.querySelector('textarea.ispui-input__textarea');
    const bar = ta && ta.closest('isp-chat-input') ? ta.closest('isp-chat-input').querySelector('.isp-buttons-block') : null;
    if (!bar) return;
    const existing = document.getElementById('hr-layoutfix');
    if (existing && existing.isConnected && bar.contains(existing)) return; // вже стоїть
    if (existing) existing.remove();
    const btn = makeElc('button', 'hr-layoutfix', '⇄');
    btn.id = 'hr-layoutfix';
    btn.type = 'button';
    btn.title = 'Виправити розкладку: виділене або все поле (Ctrl+Shift+L)';
    btn.addEventListener('mousedown', (e) => e.preventDefault()); // не губити виділення
    btn.addEventListener('click', (e) => { e.preventDefault(); fixLayoutInField(document.querySelector('textarea.ispui-input__textarea')); });
    bar.appendChild(btn);
}
// Гаряча клавіша Ctrl+Shift+L. Саме e.code — при кривій розкладці e.key буде кирилицею.
document.addEventListener('keydown', (e) => {
    if (!alive || !e.ctrlKey || !e.shiftKey || e.altKey || e.code !== 'KeyL') return;
    const el = document.activeElement;
    if (!isEditableField(el)) return;
    e.preventDefault();
    fixLayoutInField(el);
}, true);
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
let suggestDismissed = null;
let suggestObserver = null;
function injectSnippetSuggest() {
    const ta = document.querySelector('textarea.ispui-input__textarea');
    // Верхній бар поля відповіді (поряд із рідним «Шаблоны»).
    const bar = ta && ta.closest('isp-chat-input') ? ta.closest('isp-chat-input').querySelector('.isp-buttons-block') : null;
    if (!ta || !bar) return;
    const existing = document.getElementById('hr-suggest');
    if (!settings.snipSuggest) { if (existing) existing.remove(); return; }
    if (!snippets.length) return; // шаблони ще не завантажились — спробуємо наступного refresh
    const tid = readTicketId() || '';
    if (suggestDismissed === tid) { if (existing) existing.remove(); return; }
    // Самовідновлення: якщо рядок уже стоїть у барі для цього тікета — нічого.
    // Інакше (панель перемалювала бар, або змінився тікет) — будуємо.
    if (existing && existing.isConnected && existing.dataset.tid === tid && bar.contains(existing)) return;
    if (existing) existing.remove();
    const sugg = suggestSnippets(3);
    if (!sugg.length) return;
    const row = makeElc('div', 'hr-suggest');
    row.id = 'hr-suggest';
    row.dataset.tid = tid;
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
    // У бар, ОДРАЗУ після «Шаблоны» (isp-saved-messages).
    const anchor = bar.querySelector('isp-saved-messages');
    if (anchor) anchor.insertAdjacentElement('afterend', row);
    else bar.appendChild(row);
    // Панель (Angular) може прибрати наш вузол — спостерігач миттєво повертає його.
    if (!suggestObserver) {
        suggestObserver = new MutationObserver(() => {
            if (!alive || !settings.snipSuggest) return;
            if (!document.getElementById('hr-suggest')) { try { injectSnippetSuggest(); } catch (e) { /* ignore */ } }
        });
        const host = bar.closest('isp-chat-input') || document.body;
        try { suggestObserver.observe(host, { childList: true, subtree: true }); } catch (e) { /* ignore */ }
    }
}

function refresh() {
    if (!alive) return;
    if (!extensionAlive()) { teardown(); return; }
    injectAddReminderButton();
    injectSnippetButton();
    injectMsgTranslate();
    injectSnippetSuggest();
    injectLayoutFixBtn();

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
    const blockedNow = new Set(); // тікети, які зараз видно в черзі ЗАБЛОКОВАНИМИ на нас
    const ticketElid = {};
    const ticketSubject = {}; // тема тікета з рядка черги — для блоку «Клієнт чекає»
    let timersDirty = false;

    // Час-залежні будильники рахуються незалежно від наявності рядка.
    const activeReminders = computeActiveReminders(now);
    const activeTicketIds = new Set(activeReminders.map((r) => r.ticketId));
    // «Клієнт чекає»: лукап старту очікування за тікетом (мої + спільні).
    const awWatch = !!settings.replyWatchEscalate;
    const awSince = awWatch ? awWaitingByTicket() : null;

    document.querySelectorAll(ROW_SELECTOR).forEach((row) => {
        const subject = getCellText(row, SUBJECT_SELECTOR);
        const ticket = getCellText(row, TICKET_SELECTOR);
        if (ticket) visible.add(ticket); // для API-скану: цей тікет зараз видно
        if (ticket) ticketSubject[ticket] = subject;
        if (ticket && row.dataset && row.dataset.tableRowElid) {
            ticketElid[ticket] = row.dataset.tableRowElid;
            if (knownElids[ticket] !== row.dataset.tableRowElid) { knownElids[ticket] = row.dataset.tableRowElid; persistKnownElids(); }
        }
        if ((settings.replyWatch || awWatch) && ticket && rowHasNewMsg(row)) newMsgNow.add(ticket);

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
                if (ticket) blockedNow.add(ticket);
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

        // 3) Клієнт чекає на відповідь (нижче за будильник).
        if (awWatch && ticket && awSince[ticket] !== undefined && !activeTicketIds.has(ticket)) {
            const wait = now - awSince[ticket];
            const escMs = (settings.replyEscalateMinutes || 5) * 60000;
            styleRow(row, awRampColor(wait), wait >= escMs, false, applied);
        }

        // 4) Будильник-нагадування (найвищий пріоритет).
        if (ticket && activeTicketIds.has(ticket)) {
            styleRow(row, settings.reminderColor, false, true, applied);
        }
    });

    visibleTickets = visible; // для API-скану: які тікети зараз на екрані

    // Live-очищення «Мої тікети»: блок-збіг, який зараз видно в черзі вже БЕЗ
    // блокування на нас (опрацьований/перепризначений) — прибираємо без API.
    // Лише коли детект блокування активний (інакше blockedNow завжди порожній).
    if (settings.enabled && settings.names.length && matchTickets.length) {
        let changed = false;
        const kept = [];
        for (const m of matchTickets) {
            if (m && m.kinds && m.kinds.includes('blocked') && visible.has(m.ticketId) && !blockedNow.has(m.ticketId)) {
                const kinds = m.kinds.filter((k) => k !== 'blocked');
                changed = true;
                if (kinds.length) kept.push({ ...m, kinds }); // лишилися tag/reminder — тримаємо
                // інакше повністю прибираємо рядок
            } else {
                kept.push(m);
            }
        }
        if (changed) { matchTickets = kept; try { chrome.storage.local.set({ matchTickets: kept }); } catch (e) { /* ignore */ } }
    }
    // Закриття/відповідь у відкритому тікеті → миттєво прибрати його з «Мої тікети».
    matchClearOpenOnReply();

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
        if (repliedVisible && !settings.replyWatchEscalate) {
            // Одноразовий сигнал. Коли ввімкнено наростаючий режим — його не чіпаємо
            // (тиск дає awTick), щоб не дублювати.
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

    // «Клієнт чекає на відповідь»: збір нових, очищення, сигнали, бейдж, таймер.
    awTick(now, newMsgNow, visible, ticketElid, ticketSubject);

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
    // Ручний скан: одразу скидаємо список і показуємо статус — щоб було видно, що
    // скан стартував і йде завантаження черги (а не «висить»).
    if (force) { try { chrome.storage.local.set({ staleTickets: [] }); } catch (e) { /* ignore */ } }
    setStaleStatus({ scanning: true, loading: true, total: 0, scanned: 0, passed: 0, at: Date.now() });
    try {
        // Лише ПОТОЧНА сторінка черги (те, що зараз на екрані) — без гортання всіх
        // сторінок: легше для білінгу й без ризику 301/WAF. Інші сторінки — гортайте
        // у черзі та тисніть «Оновити» ще раз.
        const list = await fetchBillmgr('func=ticket');
        updatePanelLabelsFrom(list);
        const elems = asArray(list.elem);
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
                // Інкрементально оновлюємо список — знайдені тікети зʼявляються одразу.
                const sorted = result.slice().sort((a, b) => b.hours - a.hours);
                try { chrome.storage.local.set({ staleTickets: sorted }); } catch (e) { /* ignore */ }
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

// --- Premium-тікети: час першої відповіді (FRT, SLA) ----------------------
// Джерело — func=ticket_all (усі тікети, поле responsible=відділ). Для FRT
// відкриваємо func=ticket_all.edit&elid=<id> (elid == id зі списку) і беремо
// перше вихідне (працівник) мінус перше вхідне (клієнт) / дату створення.
let premiumScanRunning = false;
let premiumStopRequested = false; // користувач натиснув «Стоп»
function setPremiumStatus(o) { try { chrome.storage.local.set({ premiumScanStatus: o }); } catch (e) { /* ignore */ } }

function premiumMsgTimes(det) {
    let firstIn = null, firstOut = null;
    const msgs = asArray(det.mlist).flatMap((m) => asArray(m.message));
    for (const msg of msgs) {
        if (!msg) continue;
        const t = parseServerDate(fieldVal(msg.date_post));
        if (t === null) continue;
        if (msg.$type === 'incoming') { if (firstIn === null || t < firstIn) firstIn = t; }
        else if (msg.$type === 'outcoming') { if (firstOut === null || t < firstOut) firstOut = t; }
    }
    return { firstIn, firstOut };
}
function isPremiumDept(responsible) {
    const r = String(responsible || '').toLowerCase();
    return (settings.premiumDepartments || []).some((d) => d && r.indexOf(String(d).toLowerCase()) !== -1);
}

async function scanPremium(fromMs, toMs) {
    if (!alive || !extensionAlive() || premiumScanRunning) return;
    if (!onBillmgr()) { setPremiumStatus({ scanning: false, note: 'відкрийте сторінку панелі (billmgr)' }); return; }
    if (sessionInCooldown()) { setPremiumStatus({ scanning: false, note: 'панель розлогінено — оновіть сторінку' }); return; }
    const from = Number(fromMs) || 0;
    const to = Number(toMs) || Date.now();

    premiumScanRunning = true;
    premiumStopRequested = false;
    let sessionLost = false, note = '', stopped = false;
    const found = [];
    const seen = new Set(); // дедуп: billmgr клемпить p_num на останню сторінку й повторює її
    try {
        try { chrome.storage.local.set({ premiumScan: [] }); } catch (e) { /* ignore */ }
        setPremiumStatus({ scanning: true, loading: true, total: 0, scanned: 0, at: Date.now() });

        // 1) Гортаємо ticket_all (за last_message спадаюче). Фільтр у розширенні: відділ
        //    Premium + дата СТВОРЕННЯ в [from,to]. Рання зупинка: коли вся сторінка має
        //    last_message < from (created ≤ last_message ⟹ далі нічого з періоду).
        const MAX_PAGES = 50;
        for (let p = 1; p <= MAX_PAGES; p++) {
            if (!alive || !extensionAlive()) break;
            if (premiumStopRequested) { stopped = true; break; }
            // Сортуємо за `id` спадаюче. id тікета монотонно зростає з часом створення
            // (date_start НЕ сортована колонка, тож billmgr її ігнорує), тож це фактично
            // порядок створення — період стає суцільним зрізом, рання зупинка працює.
            const list = await fetchBillmgr('func=ticket_all&p_sort=id&p_order=desc&p_num=' + p);
            if (p === 1) updatePanelLabelsFrom(list);
            const elems = asArray(list.elem);
            if (!elems.length) break;
            let newOnPage = 0, pageAllOld = true;
            for (const el of elems) {
                const id = fieldVal(el.id);
                if (!id || seen.has(id)) continue; // дубль (клемп) — пропускаємо
                seen.add(id);
                newOnPage++;
                const created = parseServerDate(fieldVal(el.date_start));
                // Сортування за date_start спадаюче: доки трапляються тікети з created ≥ from,
                // ми ще не пройшли період (новіші за `to` — пропускаємо, але не зупиняємось).
                if (created !== null && created >= from) pageAllOld = false;
                if (created === null || created < from || created > to) continue; // поза періодом
                if (!isPremiumDept(fieldVal(el.responsible))) continue; // лише Premium-відділ
                found.push({
                    elid: id,
                    subject: fieldVal(el.name),
                    client: fieldVal(el.client),
                    createdAt: created,
                });
            }
            setPremiumStatus({ scanning: true, loading: true, total: found.length, scanned: 0, at: Date.now() });
            if (newOnPage === 0 || pageAllOld) break; // кінець: клемп/повтор або все старіше за період
            if (p === MAX_PAGES) note = 'показано перші ' + MAX_PAGES + ' стор. — звузьте період';
        }

        // 2) Для кожного — час першої відповіді + ім'я сапорта через ticket_all.edit.
        const CAP = 100;
        if (found.length > CAP) note = 'забагато тікетів — показано перші ' + CAP;
        const work = found.slice(0, CAP).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        const result = [];
        let scanned = 0;
        for (const f of work) {
            if (!alive || !extensionAlive()) break;
            if (premiumStopRequested) { stopped = true; break; }
            scanned++;
            let frtMs = null, client0 = f.createdAt;
            try {
                const det = await fetchBillmgr('func=ticket_all.edit&elid=' + encodeURIComponent(f.elid));
                const tm = premiumMsgTimes(det);
                if (tm.firstIn !== null) client0 = tm.firstIn;
                if (tm.firstOut !== null) frtMs = Math.max(0, tm.firstOut - (client0 != null ? client0 : tm.firstOut));
            } catch (e) {
                if (e && e.message === 'session-redirect') { sessionLost = true; break; }
            }
            result.push({
                ticketId: f.elid, subject: f.subject, client: f.client,
                createdAt: f.createdAt, client0, frtMs,
                url: location.origin + '/billmgr?startform=ticket_all.edit&elid=' + encodeURIComponent(f.elid),
            });
            try { chrome.storage.local.set({ premiumScan: result.slice() }); } catch (e) { /* ignore */ }
            setPremiumStatus({ scanning: true, total: work.length, scanned, at: Date.now(), note });
            await sleep(STALE_FETCH_GAP_MS);
        }
        try { chrome.storage.local.set({ premiumScan: result }); } catch (e) { /* ignore */ }
    } catch (e) {
        if (e && e.message === 'session-redirect') sessionLost = true;
    } finally {
        premiumScanRunning = false;
        premiumStopRequested = false;
        if (sessionLost) setPremiumStatus({ scanning: false, note: 'панель розлогінено — оновіть сторінку' });
        else setPremiumStatus({ scanning: false, total: found.length, at: Date.now(), note: stopped ? 'зупинено' : note });
    }
}

// --- «Клієнт чекає»: блок на Головній = скан списку черги за полем `delay` --------
// Надійно й стабільно: `delay` ("Nd+HH:MM") у func=ticket — це час очікування в
// черзі (скільки клієнту не відповідали), є в КОЖНОГО тікета й НЕ залежить від того,
// прочитали його чи ні (на відміну від позначки `unread`, що гасне при прочитанні).
// Скан — лише ПОТОЧНА сторінка черги (один func=ticket), без відкриття тікетів
// (колокольчики не гасить). Інші сторінки — гортайте й тисніть «Оновити» ще раз.
let awaitingScanRunning = false;
function setAwaitingScanStatus(o) { try { chrome.storage.local.set({ awaitingScanStatus: o }); } catch (e) { /* ignore */ } }
function parseDelayMinutes(s) {
    const m = /(\d+)d\+(\d{1,2}):(\d{2})/.exec(String(s || ''));
    if (!m) return null;
    return (+m[1]) * 1440 + (+m[2]) * 60 + (+m[3]);
}
async function scanAwaiting() {
    if (!alive || !extensionAlive() || awaitingScanRunning) return;
    if (!onBillmgr()) { setAwaitingScanStatus({ scanning: false, note: 'відкрийте сторінку черги (billmgr)' }); return; }
    if (sessionInCooldown()) { setAwaitingScanStatus({ scanning: false, note: 'панель щойно розлогінилась — оновіть' }); return; }
    awaitingScanRunning = true;
    const thresholdMin = Math.max(1, settings.awaitWaitMinutes || 30);
    setAwaitingScanStatus({ scanning: true, at: Date.now() });
    const result = [];
    try {
        const list = await fetchBillmgr('func=ticket'); // лише поточна сторінка
        updatePanelLabelsFrom(list);
        const elems = asArray(list.elem);
        const now = Date.now();
        for (const el of elems) {
            const delayMin = parseDelayMinutes(fieldVal(el.delay));
            if (delayMin === null || delayMin < thresholdMin) continue;
            const elid = fieldVal(el.id);
            result.push({
                ticketId: fieldVal(el.ticket),
                subject: fieldVal(el.name),
                clientMessageAt: now - delayMin * 60000, // приблизний момент для показу часу
                url: elid ? location.origin + '/billmgr?startform=ticket.edit&elid=' + encodeURIComponent(elid) : '',
            });
        }
        result.sort((a, b) => a.clientMessageAt - b.clientMessageAt);
        try { chrome.storage.local.set({ awaitingScan: result }); } catch (e) { /* ignore */ }
        setAwaitingScanStatus({ scanning: false, total: elems.length, passed: result.length, at: Date.now() });
    } catch (e) {
        if (e && e.message === 'session-redirect') setAwaitingScanStatus({ scanning: false, note: 'панель розлогінено — оновіть сторінку' });
        else setAwaitingScanStatus({ scanning: false, note: 'помилка скану' });
    } finally {
        awaitingScanRunning = false;
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

// --- «Клієнт чекає на відповідь»: трекер + ескалація ---------------------
const AW_RECHECK_MS = 60 * 1000;        // як часто пере-перевіряти, чи відписали
const AW_FETCH_DEDUP_MS = 1200;         // мін. пауза між ticket.edit по всіх вкладках
const AW_SNOOZE_MS = 10 * 60 * 1000;    // «Відкласти» банер «Клієнт чекає» на 10 хв
const AW_SHARED_RECHECK_MS = 3 * 60 * 1000; // як часто будь-яка вкладка перевіряє чужі тікети пулу
const AW_SHOW_MS = 30 * 60 * 1000;      // показувати тікет/швидкі дії лише після N хв очікування

function persistAwaiting() { try { chrome.storage.local.set({ awaitingMap }); } catch (e) { /* ignore */ } }

// Останні часи вхідного/вихідного повідомлень з ticket.edit.
function awMsgTimes(det) {
    let lastIncoming = null, lastOutgoing = null;
    const msgs = asArray(det && det.mlist).flatMap((m) => asArray(m.message));
    for (const msg of msgs) {
        if (!msg) continue;
        const t = parseServerDate(fieldVal(msg.date_post));
        if (t === null) continue;
        if (msg.$type === 'incoming') { if (lastIncoming === null || t > lastIncoming) lastIncoming = t; }
        else if (msg.$type === 'outcoming') { if (lastOutgoing === null || t > lastOutgoing) lastOutgoing = t; }
    }
    return { lastIncoming, lastOutgoing };
}

// Старт очікування за тікетом: спільні + мої (мої свіжіші мають пріоритет).
function awWaitingByTicket() {
    const m = {};
    for (const a of awaitingShared) if (a && a.ticketId) m[a.ticketId] = a.clientMessageAt || 0;
    for (const t of Object.keys(awaitingMap)) m[t] = awaitingMap[t].waitingSince;
    return m;
}

function awHexToRgb(s) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(s).trim());
    if (!m) return null;
    const i = parseInt(m[1], 16);
    return { r: (i >> 16) & 255, g: (i >> 8) & 255, b: i & 255 };
}
function awRampColor(waitMs) {
    const escMs = (settings.replyEscalateMinutes || 5) * 60000;
    const f = Math.max(0, Math.min(1, escMs > 0 ? waitMs / escMs : 1));
    const a = awHexToRgb(settings.replyWarnColor), b = awHexToRgb(settings.replyDangerColor);
    if (!a || !b) return settings.replyDangerColor;
    const c = (k) => Math.round(a[k] + (b[k] - a[k]) * f);
    return '#' + [c('r'), c('g'), c('b')].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// Які очікування зараз мають дзвонити: мої — завжди; чужі — лише після ескалації.
function computeActiveAwaiting(now) {
    const escMs = (settings.replyEscalateMinutes || 5) * 60000;
    const byT = {};
    for (const a of awaitingShared) if (a && a.ticketId) byT[a.ticketId] = { ticketId: a.ticketId, waitingSince: a.clientMessageAt || now, ownerEmail: a.ownerEmail || '' };
    for (const t of Object.keys(awaitingMap)) byT[t] = { ticketId: t, waitingSince: awaitingMap[t].waitingSince, ownerEmail: awaitingMap[t].ownerEmail || '' };
    const out = [];
    for (const t of Object.keys(byT)) {
        const e = byT[t];
        const escalated = now >= e.waitingSince + escMs;
        if (e.ownerEmail && myEmail && e.ownerEmail !== myEmail && !escalated) continue; // чужий, ще не ескальовано
        out.push(e);
    }
    return out;
}

function awNotify(a, now) {
    const repeatMs = (settings.replyRepeatMinutes || 0) * 60000;
    const last = awNotifiedAt[a.ticketId] || 0;
    const due = !last || (repeatMs > 0 && now - last >= repeatMs);
    if (!due) return;
    awNotifiedAt[a.ticketId] = now;
    const url = (awaitingMap[a.ticketId] && awaitingMap[a.ticketId].url) || '';
    fireAlert('#' + a.ticketId, { sound: settings.replySound !== 'none', notify: true, kind: 'reply', ticket: a.ticketId, soundWhich: 'reply', url });
}

function awBadge(count, longestMin) {
    try { chrome.runtime.sendMessage({ action: 'setBadge', awaiting: count, longestMin }); } catch (e) { /* ignore */ }
}

// Банер «Клієнт чекає»: один чип на тікет, у кожного власна кнопка «×»
// (відкласти саме цей тікет на 10 хв). Перебудовуємо лише коли змінився набір/час.
function ensureAwaitingBanner(active, now) {
    if (!document.body) return;
    let banner = document.getElementById('hr-awaiting-banner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'hr-awaiting-banner';
        banner.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:12px;z-index:2147483646;display:flex;align-items:center;flex-wrap:wrap;gap:6px;background:#b3261e;color:#fff;padding:8px 14px;border-radius:8px;font:600 13px/1.3 system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.3);max-width:92vw';
        document.body.appendChild(banner);
    }
    const sorted = active.slice().sort((x, y) => x.waitingSince - y.waitingSince);
    const sig = sorted.map((a) => a.ticketId + ':' + Math.floor((now - a.waitingSince) / 60000)).join('|');
    if (banner.dataset.sig === sig) return; // нічого не змінилось — не смикаємо DOM
    banner.dataset.sig = sig;
    banner.textContent = '';
    const lead = document.createElement('span');
    lead.textContent = '✉️ Клієнт чекає — відпишіть:';
    lead.style.cssText = 'white-space:nowrap';
    banner.appendChild(lead);
    sorted.forEach((a) => {
        const chip = document.createElement('span');
        chip.style.cssText = 'display:inline-flex;align-items:center;gap:3px;background:rgba(255,255,255,.18);border-radius:6px;padding:2px 3px 2px 8px;white-space:nowrap';
        const label = document.createElement('span');
        label.textContent = '#' + a.ticketId + ' (' + Math.floor((now - a.waitingSince) / 60000) + ' хв)';
        chip.appendChild(label);
        const x = document.createElement('button');
        x.type = 'button';
        x.textContent = '×';
        x.title = 'Відкласти #' + a.ticketId + ' на 10 хв';
        x.style.cssText = 'border:none;background:transparent;color:#fff;font:700 15px/1 system-ui,sans-serif;cursor:pointer;padding:0 3px';
        const tid = a.ticketId;
        x.addEventListener('click', (e) => { e.preventDefault(); awSnoozeTicket(tid); });
        chip.appendChild(x);
        banner.appendChild(chip);
    });
    // Закрити весь банер одним кліком — відкласти всі поточні тікети на 10 хв.
    const closeAll = document.createElement('button');
    closeAll.type = 'button';
    closeAll.textContent = '✕ Сховати';
    closeAll.title = 'Закрити весь банер на 10 хв';
    closeAll.style.cssText = 'flex:none;border:none;background:#fff;color:#b3261e;font:700 12px system-ui,sans-serif;padding:3px 9px;border-radius:6px;cursor:pointer;white-space:nowrap;margin-left:4px';
    const allIds = sorted.map((a) => a.ticketId);
    closeAll.addEventListener('click', (e) => { e.preventDefault(); awSnoozeMany(allIds); });
    banner.appendChild(closeAll);
}
function removeAwaitingBanner() { const b = document.getElementById('hr-awaiting-banner'); if (b) b.remove(); }

// «×» на чипі: приглушити банер і сигнал саме для цього тікета на 10 хв.
function awSnoozeTicket(ticketId) { awSnoozeMany([ticketId]); }

// Відкласти кілька тікетів (або весь банер) на 10 хв.
function awSnoozeMany(ids) {
    const now = Date.now();
    for (const t of Object.keys(awSnooze)) if (!awSnooze[t] || awSnooze[t] <= now) delete awSnooze[t]; // прибрати протерміновані
    (ids || []).forEach((t) => { awSnooze[t] = now + AW_SNOOZE_MS; });
    try { chrome.storage.local.set({ awSnooze }); } catch (e) { /* ignore */ }
    refresh();
}

// Миттєве очищення: у відкритому тікеті зʼявився новий вихідний бабл (відписали).
// «Мої тікети»: ви відписали у відкритому тікеті (зріс лік вихідних баблів) →
// опрацьовано, прибираємо його блок-ознаку зі списку одразу (без API). Якщо тікет
// усе ще заблокований на вас — наступний повний скан його поверне (self-correct).
function matchClearOpenOnReply() {
    const t = readTicketId();
    if (!t) { matchBubbleBaseline = null; return; }
    const count = document.querySelectorAll('.isp-chat-bubble_type-outcoming').length;
    if (!matchBubbleBaseline || matchBubbleBaseline.ticketId !== t) { matchBubbleBaseline = { ticketId: t, count }; return; }
    if (count <= matchBubbleBaseline.count) return;
    matchBubbleBaseline.count = count;
    if (!matchTickets.length) return;
    const idx = matchTickets.findIndex((x) => x && String(x.ticketId) === String(t) && x.kinds && x.kinds.includes('blocked'));
    if (idx === -1) return;
    const kinds = matchTickets[idx].kinds.filter((k) => k !== 'blocked');
    const next = matchTickets.slice();
    if (kinds.length) next[idx] = { ...matchTickets[idx], kinds }; else next.splice(idx, 1);
    matchTickets = next;
    try { chrome.storage.local.set({ matchTickets: next }); } catch (e) { /* ignore */ }
}

function awInstantClearOpen() {
    const t = readTicketId();
    if (!t) { awBubbleBaseline = null; return; }
    const count = document.querySelectorAll('.isp-chat-bubble_type-outcoming').length;
    if (!awBubbleBaseline || awBubbleBaseline.ticketId !== t) { awBubbleBaseline = { ticketId: t, count }; return; }
    if (count > awBubbleBaseline.count) {
        awBubbleBaseline.count = count;
        if (awaitingMap[t] || awaitingShared.some((a) => a.ticketId === t)) awResolve(t);
    }
}

function awResolve(ticketId) {
    if (awaitingMap[ticketId]) { delete awaitingMap[ticketId]; persistAwaiting(); }
    delete awNotifiedAt[ticketId];
    delete awSharedRecheck[ticketId];
    if (awSnooze[ticketId]) { delete awSnooze[ticketId]; try { chrome.storage.local.set({ awSnooze }); } catch (e) { /* ignore */ } }
    sbSend({ sb: 'awResolve', ticketId });
}

// elid із збереженого url рядка пулу (…&elid=<n>) — щоб перевірити чужий тікет.
function awElidFromUrl(url) {
    const m = /[?&]elid=([^&]+)/.exec(String(url || ''));
    return m ? decodeURIComponent(m[1]) : '';
}

// Перевірка чужого тікета пулу через API: якщо підтримка вже відписала
// (lastOutgoing ≥ момент очікування) — знімаємо з пулу для всієї команди.
async function awRecheckShared(a) {
    const elid = awElidFromUrl(a && a.url);
    if (!elid) return;
    let det;
    try { det = await fetchBillmgr('func=ticket.edit&elid=' + encodeURIComponent(elid)); } catch (e) { return; }
    const times = awMsgTimes(det);
    if (times.lastOutgoing !== null && times.lastOutgoing >= (a.clientMessageAt || 0)) awResolve(a.ticketId);
}

async function awAnchorOne(ticket, elid, subject) {
    if (!elid) return;
    let det;
    try { det = await fetchBillmgr('func=ticket.edit&elid=' + encodeURIComponent(elid)); } catch (e) { return; }
    const times = awMsgTimes(det);
    if (times.lastIncoming === null) return;
    if (times.lastOutgoing !== null && times.lastOutgoing >= times.lastIncoming) return; // вже відписано/прочитано
    const subj = (subject || '').trim();
    awaitingMap[ticket] = {
        elid, ticket, subject: subj,
        url: location.origin + '/billmgr?startform=ticket.edit&elid=' + encodeURIComponent(elid),
        waitingSince: times.lastIncoming, ownerEmail: myEmail || '', lastAlert: 0, lastRecheck: Date.now(),
    };
    persistAwaiting();
    sbSend({ sb: 'awUpsert', awaiting: { ticketId: ticket, clientMessageAt: times.lastIncoming, subject: subj, url: awaitingMap[ticket].url } });
}

async function awRecheckOne(t) {
    const e = awaitingMap[t];
    if (!e || !e.elid) return;
    let det;
    try { det = await fetchBillmgr('func=ticket.edit&elid=' + encodeURIComponent(e.elid)); } catch (err) { return; }
    const times = awMsgTimes(det);
    e.lastRecheck = Date.now();
    if (times.lastOutgoing !== null && times.lastOutgoing >= e.waitingSince) { awResolve(t); return; }
    if (times.lastIncoming !== null && times.lastIncoming > e.waitingSince) e.waitingSince = times.lastIncoming;
    persistAwaiting();
}

async function awDrain(force) {
    if (awDraining || !settings.replyWatchEscalate) return;
    if (!onBillmgr() || sessionInCooldown()) return;
    if (!force && !tabVisible()) return; // примусовий (кнопка «Оновити») працює й на фоновій вкладці
    if (!force) {
        const last = await loadFromStorage('local', 'awaitingFetchAt', 0);
        if (Date.now() - (last || 0) < AW_FETCH_DEDUP_MS) return;
    }
    awDraining = true;
    try {
        while (awAnchorQueue.length && alive && extensionAlive() && (force || tabVisible())) {
            const item = awAnchorQueue.shift();
            if (!item || !item.ticket || awaitingMap[item.ticket]) continue;
            try { chrome.storage.local.set({ awaitingFetchAt: Date.now() }); } catch (e) { /* ignore */ }
            await awAnchorOne(item.ticket, item.elid, item.subject);
            await sleep(STALE_FETCH_GAP_MS);
        }
        const due = Object.keys(awaitingMap).filter((t) => Date.now() - (awaitingMap[t].lastRecheck || 0) >= AW_RECHECK_MS);
        for (const t of due) {
            if (!alive || !extensionAlive() || (!force && !tabVisible())) break;
            try { chrome.storage.local.set({ awaitingFetchAt: Date.now() }); } catch (e) { /* ignore */ }
            await awRecheckOne(t);
            await sleep(STALE_FETCH_GAP_MS);
        }
        // Чужі тікети пулу (власник може бути офлайн) — рідша перевірка через API,
        // щоб застарілі (де вже відписали) самі зникали з блоку «Клієнт чекає».
        const sharedDue = awaitingShared.filter((a) => a && a.ticketId && a.url
            && !awaitingMap[a.ticketId]
            && Date.now() - (awSharedRecheck[a.ticketId] || 0) >= AW_SHARED_RECHECK_MS);
        for (const a of sharedDue) {
            if (!alive || !extensionAlive() || (!force && !tabVisible())) break;
            awSharedRecheck[a.ticketId] = Date.now();
            try { chrome.storage.local.set({ awaitingFetchAt: Date.now() }); } catch (e) { /* ignore */ }
            await awRecheckShared(a);
            await sleep(STALE_FETCH_GAP_MS);
        }
    } catch (e) { /* ignore */ } finally { awDraining = false; }
}

// Примусова перевірка ВСІХ тікетів пулу (кнопка «Оновити» в попапі): скидаємо
// таймери recheck і одразу проганяємо awDrain — відписані/закриті самі зникають.
async function awForceRecheck() {
    if (!settings.replyWatchEscalate || !onBillmgr()) return;
    for (const t of Object.keys(awaitingMap)) awaitingMap[t].lastRecheck = 0;
    awSharedRecheck = {};
    await awDrain(true);
}

// Викликається з refresh() щопроходу.
function awTick(now, newMsgNow, visible, ticketElid, ticketSubject) {
    if (!settings.replyWatchEscalate) {
        if (Object.keys(awaitingMap).length) { awaitingMap = {}; persistAwaiting(); }
        awAnchorQueue = [];
        removeAwaitingBanner();
        awBadge(0, 0);
        return;
    }
    const sharedSet = new Set(awaitingShared.map((a) => a && a.ticketId));
    // нові тікети з позначкою → у чергу анкорингу (якщо ще не відстежуємо)
    newMsgNow.forEach((t) => {
        if (awaitingMap[t] || sharedSet.has(t)) return;
        if (awAnchorQueue.some((q) => q.ticket === t)) return;
        awAnchorQueue.push({ ticket: t, elid: ticketElid[t] || '', subject: (ticketSubject && ticketSubject[t]) || '' });
    });
    // (Прибрано авто-зняття «видно в черзі без позначки» — позначка гасне і коли
    // тікет лише прочитали, тож тікети хибно зникали. Знімаємо лише за реальною
    // відповіддю: awInstantClearOpen / awRecheckOne / awRecheckShared / вручну.)
    awInstantClearOpen();
    awDrain();
    // сигнали (з урахуванням «× Відкласти 10 хв» по кожному тікету)
    const active = computeActiveAwaiting(now).filter((a) => !(awSnooze[a.ticketId] && now < awSnooze[a.ticketId]));
    if (active.length) { ensureAwaitingBanner(active, now); active.forEach((a) => awNotify(a, now)); }
    else { removeAwaitingBanner(); }
    // бейдж — командний лічильник + найдовше очікування
    const all = awWaitingByTicket();
    const keys = Object.keys(all);
    let longest = 0;
    for (const k of keys) longest = Math.max(longest, now - (all[k] || now));
    awBadge(keys.length, Math.floor(longest / 60000));
}

// --- Швидкі дії проти невдоволення клієнта (холдинг/апдейт/нагад) --------
function plusMinutesHHMM(min) {
    const d = new Date(Date.now() + min * 60000);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
// Вбудовані дефолти, якщо нема шаблону з відповідним скороченням (hold/upd).
const AW_DEFAULT_TEXT = {
    hold: {
        uk: 'Я вже взяв Ваш запит у роботу, і працюю над ним. Як тільки буде оновлення, я Вас повідомлю. Очікуйте, будь ласка.',
        ru: 'Я уже взял Ваш запрос в работу и занимаюсь им. Как только будет обновление, я Вас уведомлю. Пожалуйста, ожидайте.',
        en: 'I have already taken your request and am working on it. As soon as there is an update, I will let you know. Please bear with me.',
    },
    upd: {
        uk: 'Ваш запит ще в роботі, продовжую ним займатися. Нажаль це займає більше часу ніж очікувалось. Як тільки буде результат, одразу напишу Вам. Дякую за очікування.',
        ru: 'Ваш запрос ещё в работе, продолжаю им заниматься. К сожалению, это занимает больше времени, чем ожидалось. Как только будет результат, сразу напишу Вам. Спасибо за ожидание.',
        en: 'Your request is still in progress and I am continuing to work on it. Unfortunately, it is taking longer than expected. As soon as I have a result, I will write to you right away. Thank you for waiting.',
    },
};
function awInsertReserved(kind) {
    const ta = document.querySelector('textarea.ispui-input__textarea');
    if (!ta) return;
    const snip = findSnippetByToken(kind);
    let text;
    if (snip) text = fillSnippet(snip);
    else {
        const lang = detectTicketLang();
        // Власний текст із налаштувань (за мовою тікета), інакше вбудований дефолт.
        const obj = kind === 'hold' ? settings.quickHoldText : kind === 'upd' ? settings.quickUpdText : null;
        let custom = '';
        if (obj && typeof obj === 'object') custom = obj[lang] || obj.uk || '';
        else if (typeof obj === 'string') custom = obj;
        if (custom && custom.trim()) text = fillSnippet(custom);
        else { const map = AW_DEFAULT_TEXT[kind] || {}; text = fillSnippet(map[lang] || map.uk || ''); }
    }
    if (text) insertIntoReply(ta, text);
}
function awFlash(btn, txt) {
    if (!btn.dataset.orig) btn.dataset.orig = btn.textContent;
    btn.textContent = txt;
    clearTimeout(btn._t);
    btn._t = setTimeout(() => { btn.textContent = btn.dataset.orig; }, 1600);
}
function awPromise(min, btn) {
    const tid = readTicketId();
    if (!tid) { awFlash(btn, '✕'); return; }
    const time = plusMinutesHHMM(min);
    try {
        chrome.runtime.sendMessage({ sb: 'add', ticketId: tid, time }, (resp) => {
            if (chrome.runtime.lastError) { awFlash(btn, '✕'); return; }
            if (resp && resp.duplicate) awFlash(btn, '✓ вже');
            else if (resp && resp.ok) awFlash(btn, '✓ ' + time);
            else awFlash(btn, '✕');
        });
    } catch (e) { awFlash(btn, '✕'); }
}
function awBuildActions() {
    const row = document.createElement('span');
    row.style.cssText = 'display:inline-flex;gap:6px;flex-wrap:wrap';
    const mk = (id, label, title, onClick) => {
        const b = document.createElement('button');
        b.type = 'button';
        if (id) b.id = id;
        b.textContent = label;
        b.title = title || '';
        b.style.cssText = 'cursor:pointer;border:1px solid #c4c8d0;background:#eef0f3;color:#2b3038;border-radius:6px;padding:3px 8px;font:600 11px/1 system-ui,sans-serif';
        b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onClick(b); });
        row.appendChild(b);
        return b;
    };
    mk('hr-act-hold', 'Вже дивимось', 'Вставити «ми вже дивимось» у поле відповіді (шаблон зі скороченням hold або типовий)', () => awInsertReserved('hold'));
    mk('hr-act-upd', 'Апдейт', 'Вставити проміжний апдейт (шаблон зі скороченням upd або типовий)', () => awInsertReserved('upd'));
    mk('', '⏰+30', 'Нагадати про тікет через 30 хв', (b) => awPromise(30, b));
    mk('', '⏰+1г', 'Нагадати про тікет через 1 год', (b) => awPromise(60, b));
    mk('', '⏰+2г', 'Нагадати про тікет через 2 год', (b) => awPromise(120, b));
    return row;
}

// Коли «Наполягати…» вимкнено, пул порожній — для ВІДКРИТОГО тікета визначаємо
// час очікування одним (тротленим, раз на ~60с) запитом ticket.edit. Повертає
// since(ms) якщо клієнт чекає (без відповіді), null якщо відписано, undefined поки невідомо.
function awOpenWaitSince(ticket, elid) {
    if (awOpenWait.ticket === ticket && (Date.now() - awOpenWait.at < 60000) && !awOpenWait.fetching) return awOpenWait.since;
    if (!awOpenWait.fetching && elid && onBillmgr() && tabVisible() && !sessionInCooldown()) {
        awOpenWait.fetching = true;
        if (awOpenWait.ticket !== ticket) awOpenWait.since = undefined; // новий тікет — поки невідомо
        (async () => {
            let since = null;
            try {
                const det = await fetchBillmgr('func=ticket.edit&elid=' + encodeURIComponent(elid));
                const times = awMsgTimes(det);
                if (times.lastIncoming !== null && !(times.lastOutgoing !== null && times.lastOutgoing >= times.lastIncoming)) since = times.lastIncoming;
            } catch (e) { since = (awOpenWait.ticket === ticket ? awOpenWait.since : null) ?? null; }
            awOpenWait = { ticket, since, at: Date.now(), fetching: false };
        })();
    }
    return awOpenWait.ticket === ticket ? awOpenWait.since : undefined;
}

// Таймер у відкритому тікеті (1с-тік, окремо від 15с refresh) + панель дій.
// Працює і коли «Наполягати…» вимкнено: тоді показуємо лише після AW_SHOW_MS (30 хв).
function awTimerTick() {
    if (!alive) { awRemoveTimer(); return; }
    const t = readTicketId();
    if (!t) { awRemoveTimer(); return; }
    let since = awWaitingByTicket()[t];            // з пулу (коли ескалацію ввімкнено)
    if (since === undefined) since = awOpenWaitSince(t, currentElid()); // інакше — легка перевірка
    if (since === undefined || since === null) { awRemoveTimer(); return; }
    // Без ескалації — показуємо таймер і дії лише коли клієнт чекає > 30 хв.
    if (!settings.replyWatchEscalate && (Date.now() - since) < AW_SHOW_MS) { awRemoveTimer(); return; }
    const ta = document.querySelector('textarea.ispui-input__textarea');
    if (!ta) { awRemoveTimer(); return; }
    let el = document.getElementById('hr-await-timer');
    const input = ta.closest('isp-chat-input') || ta.closest('.isp-chat-input');
    const bar = input ? input.querySelector('.isp-buttons-block') : null;
    if (!el) {
        el = document.createElement('div');
        el.id = 'hr-await-timer';
        el.style.cssText = 'margin:6px 0 2px;display:flex;align-items:center;gap:8px;flex-wrap:wrap';
        const pill = document.createElement('span');
        pill.id = 'hr-await-timer-text';
        pill.style.cssText = 'padding:3px 10px;border-radius:6px;font:700 12px/1.4 system-ui,sans-serif;color:#fff';
        el.appendChild(pill);
        if (settings.quickReplies) el.appendChild(awBuildActions());
    }
    // Тримаємо таймер ПІД панеллю Сообщение/Комментарий/Шаблоны (.isp-buttons-block),
    // а не у «порожнечі». Якщо Angular перемалював — повертаємо на місце.
    if (bar) { if (el.previousElementSibling !== bar) bar.insertAdjacentElement('afterend', el); }
    else if (!el.isConnected) {
        const host = ta.closest('.isp-chat-input') || ta.parentElement;
        if (host && host.parentElement) host.parentElement.insertBefore(el, host);
        else if (ta.parentElement) ta.parentElement.insertBefore(el, ta);
    }
    const waitMs = Date.now() - since;
    const mm = Math.floor(waitMs / 60000), ss = Math.floor((waitMs % 60000) / 1000);
    const everyMs = (settings.updateEveryMinutes || 0) * 60000;
    const needUpdate = everyMs > 0 && waitMs >= everyMs;
    const pill = el.querySelector('#hr-await-timer-text');
    if (pill) {
        pill.textContent = '✉️ Клієнт чекає ' + mm + ':' + String(ss).padStart(2, '0') + (needUpdate ? ' — час надіслати апдейт' : ' — відпишіть');
        pill.style.backgroundColor = awRampColor(waitMs);
    }
    const upd = el.querySelector('#hr-act-upd');
    if (upd) upd.style.boxShadow = needUpdate ? '0 0 0 2px #ff3b30' : 'none';
}
function awRemoveTimer() { const el = document.getElementById('hr-await-timer'); if (el) el.remove(); }

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
    if (trafficData.used == null || trafficData.paid == null) return '—'; // послуга без трафіку (напр. info-послуга)
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
// Вибрана послуга з поля «Услуга». Текст анкора: «#<id> <Назва> (<host>, <ip>)».
// Беремо текст із .ispui-select-anchor__text (новий DOM) або .isp-select__text (старий),
// що починається з «#<цифри>» — це і є селект послуги.
function readSelectedService() {
    let txt = '';
    const cands = document.querySelectorAll('.ispui-select-anchor__text, ispui-select-v2[name="item"] .isp-select__text, .isp-select__text');
    for (const el of cands) {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (/#\d+/.test(t)) { txt = t; break; }
    }
    const idm = txt.match(/#(\d+)/);
    const ipm = txt.match(/((?:\d{1,3}\.){3}\d{1,3})/); // ip будь-де (всередині дужки після хоста)
    const nm = txt.match(/#\d+\s+([^(]+?)\s*(?:\(|$)/); // назва між «#id» і «(»
    return { id: idm ? idm[1] : '', ip: ipm ? ipm[1] : '', name: nm ? nm[1].trim() : '' };
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

// Послуга з info-блоку тікета (rowgroup «info_item_title») — для послуг, яких немає
// у func=instances (ліцензії/панелі). Повертає мапу { row.$name: row.$ } або {}.
function parseTicketServiceInfo(ticket) {
    const out = {};
    for (const ml of asArray(ticket && ticket.mlist)) {
        for (const m of asArray(ml.message)) {
            for (const g of asArray(m.rowgroup)) {
                if (!g || g.$name !== 'info_item_title') continue;
                for (const row of asArray(g.row)) {
                    if (row && row.$name) out[row.$name] = fieldVal(row);
                }
            }
        }
    }
    return out;
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
            if (match) {
                trafficData = {
                    key,
                    id: fieldVal(match.id),
                    name: fieldVal(match.pricelist) || fieldVal(match.name) || svc.name || '',
                    ip: fieldVal(match.ip) || svc.ip || '',
                    used: fieldVal(match.used_traffic),
                    paid: fieldVal(match.paid_traffic),
                    service: buildService(match),
                };
            } else {
                // Послуга не з instances — розпізнаємо з info-блоку вже завантаженого тікета.
                const info = parseTicketServiceInfo(ticket);
                if (info.panel_enumeration || info.info_item_serverid || info.info_item_ostempl || info.info_item_ip) {
                    trafficData = {
                        key,
                        id: item || info.info_item_serverid || '',
                        name: info.panel_enumeration || svc.name || '',
                        ip: info.info_item_ip || svc.ip || '',
                        source: 'ticketinfo', // лише розпізнавання — без полів у блоці
                    };
                } else {
                    trafficData = { key, notFound: true, name: svc.name || '', ip: svc.ip || '' };
                }
            }
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
    const resolved = trafficData && trafficData.key === key && (trafficData.none || trafficData.service != null || trafficData.source === 'ticketinfo');
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
        loadFromStorage('local', 'matchTickets', []),
        loadFromStorage('local', 'awaitingMap', {}),
        loadFromStorage('local', 'awaitingShared', []),
        loadFromStorage('local', 'awSnooze', {}),
        loadFromStorage('local', 'ticketElids', {}),
    ]).then(([loadedSettings, loadedTimers, loadedReminderState, loadedLabels, loadedMatchState, loadedMatchTickets, loadedAwaiting, loadedAwShared, loadedAwSnooze, loadedElids]) => {
        if (!extensionAlive()) { teardown(); return; }

        settings = loadedSettings;
        rowTimers = loadedTimers && typeof loadedTimers === 'object' ? loadedTimers : {};
        reminderState = loadedReminderState && typeof loadedReminderState === 'object' ? loadedReminderState : {};
        if (loadedLabels && typeof loadedLabels === 'object') panelLabels = { ...DEFAULT_LABELS, ...loadedLabels };
        matchAlertState = loadedMatchState && typeof loadedMatchState === 'object' ? loadedMatchState : {};
        matchTickets = Array.isArray(loadedMatchTickets) ? loadedMatchTickets : [];
        awaitingMap = loadedAwaiting && typeof loadedAwaiting === 'object' ? loadedAwaiting : {};
        awaitingShared = Array.isArray(loadedAwShared) ? loadedAwShared : [];
        awSnooze = loadedAwSnooze && typeof loadedAwSnooze === 'object' ? loadedAwSnooze : {};
        knownElids = loadedElids && typeof loadedElids === 'object' ? loadedElids : {};
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
                } else if (area === 'local' && changes.awaitingShared) {
                    awaitingShared = changes.awaitingShared.newValue || [];
                    refresh();
                } else if (area === 'local' && changes.awSnooze) {
                    awSnooze = changes.awSnooze.newValue || {};
                    refresh();
                } else if (area === 'local' && changes.matchTickets) {
                    matchTickets = Array.isArray(changes.matchTickets.newValue) ? changes.matchTickets.newValue : [];
                }
            });

            // Ручні дії з popup.
            chrome.runtime.onMessage.addListener((req) => {
                if (!req) return;
                if (req.action === 'scanStaleTickets') scanStaleTickets(true);
                else if (req.action === 'scanMatches') scanMatches(true);
                else if (req.action === 'scanAwaiting') scanAwaiting();
                else if (req.action === 'scanPremium') scanPremium(req.from, req.to);
                else if (req.action === 'stopPremium') premiumStopRequested = true;
                else if (req.action === 'awRecheckNow') awForceRecheck();
                else if (req.action === 'openTicket') openTicketByNumber(req.ticketId);
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
            awTimerInterval = setInterval(awTimerTick, 1000); // таймер «клієнт чекає» у тікеті

            // «Без відповіді» та збіги по всій черзі («Особисті тікети») —
            // лише вручну, за кнопкою «Оновити» (без авто/періодичного обходу черги).

            // Спільні будильники: періодично підтягувати зі спільної бази
            // (фактичний fetch робить background; тут лише тригеримо з активної вкладки).
            setTimeout(() => { if (tabVisible()) { sbSend({ sb: 'pull' }); sbSend({ sb: 'awPull' }); } }, 4000);
            sbPullIntervalRef = setInterval(() => { if (tabVisible()) { sbSend({ sb: 'pull' }); sbSend({ sb: 'awPull' }); } }, MATCH_POLL_INTERVAL_MS);

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
