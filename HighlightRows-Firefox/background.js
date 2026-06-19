// background.js — показує desktop-сповіщення на запит content.js та є хабом
// для Supabase (усі мережеві виклики спільної бази будильників — тут, бо в MV3
// fetch із контент-скрипта підлягає CSP сторінки).
//  - redAlert: рядок перетнув поріг / спрацювало правило за тегом;
//  - reminderAlert: спрацював будильник-нагадування за тікетом;
//  - sb:* : синхронізація будильників зі спільною базою (pull / snooze / mute).

// Chrome (service_worker, один файл) тягне sb.js через importScripts; Firefox
// підключає його окремо через background.scripts, тож там importScripts немає.
if (typeof importScripts === 'function') { try { importScripts('sb.js'); } catch (e) { /* ignore */ } }

const notifUrls = {};   // id → url (клік по сповіщенню відкриває тікет)
let redGroup = [];      // останні події для згрупованого сповіщення (режим «накопичувати»)
let redGroupUrl = '';   // url останньої події групи (клік відкриває її)
const RED_GROUP_ID = 'redAlertGroup';
// Заголовок+текст за типом події (для режиму «заміняти»).
const RED_TYPES = {
    blocked: { title: '🔴 Заблокований запит', msg: (r) => r.name || '' },
    tag: { title: '🏷️ Тег', msg: (r) => r.name || '' },
    reply: { title: '✉️ Відповідь клієнта', msg: (r) => 'Нове повідомлення у тікеті #' + (r.ticket || '') },
};
// Короткий рядок події для згрупованого списку.
function redEventLabel(r) {
    if (r.kind === 'tag') return '🏷️ ' + (r.name || '');
    if (r.kind === 'reply') return '✉️ #' + (r.ticket || '');
    return '🔴 ' + (r.name || '');
}

function getSyncSettings() {
    return new Promise((res) => {
        try { chrome.storage.sync.get('settings', (d) => res((d && d.settings) || {})); }
        catch (e) { res({}); }
    });
}

function showNotification(id, title, message, url, cb) {
    const opts = { type: 'basic', iconUrl: chrome.runtime.getURL('images/icon48.png'), title, message };
    const create = () => {
        try {
            chrome.notifications.create(id, opts, () => {
                const err = chrome.runtime.lastError;
                if (err) { try { console.warn('[HR] notify:', err.message || err); } catch (e) { /* ignore */ } }
                if (cb) cb(err);
            });
        } catch (e) { if (cb) cb(e); }
    };
    // Прибрати наявне сповіщення з тим самим id, щоб тост вискочив ЗАНОВО — інакше
    // Chrome лише мовчки оновлює наявне й не перепоказує (звук є, попапа нема).
    // Для нового id clear — фактично no-op.
    try { chrome.notifications.clear(id, () => create()); } catch (e) { create(); }
    if (url) notifUrls[id] = url;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request) return;

    if (request.action === 'testNotify') {
        const finish = (err, level) => { try { sendResponse({ ok: !err, error: err ? (err.message || String(err)) : '', level: level || '' }); } catch (e) { /* ignore */ } };
        const create = (level) => showNotification('hrTest:' + Date.now(), '⏰ Тест сповіщення',
            'Якщо ви це бачите — сповіщення працюють.', '', (err) => finish(err, level));
        try {
            // Обчислений ключ — getPermissionLevel є лише в Chrome; так уникаємо
            // статичного попередження AMO-лінтера у Firefox-збірці (там — фолбек).
            const gplKey = 'getPermission' + 'Level';
            if (chrome.notifications && typeof chrome.notifications[gplKey] === 'function') {
                chrome.notifications[gplKey]((lvl) => create(lvl));
            } else { create(''); }
        } catch (e) { finish(e, ''); }
        return true; // відповідь асинхронна
    }

    if (request.action === 'redAlert') {
        getSyncSettings().then((s) => {
            const stack = (s.notifyMode || 'stack') !== 'replace';
            const max = Math.min(5, Math.max(1, Math.round(Number(s.notifyMax) || 3)));
            if (stack) {
                // Накопичувати: одне згруповане сповіщення зі списком останніх N подій.
                redGroup.push(redEventLabel(request));
                while (redGroup.length > max) redGroup.shift();
                if (request.url) redGroupUrl = request.url;
                const title = redGroup.length > 1 ? 'Нові події (' + redGroup.length + ')' : (RED_TYPES[request.kind] || RED_TYPES.blocked).title;
                showNotification(RED_GROUP_ID, title, redGroup.join('\n'), redGroupUrl);
            } else {
                const t = RED_TYPES[request.kind] || RED_TYPES.blocked;
                showNotification('redAlert', t.title, t.msg(request), request.url || '');
            }
        });
    } else if (request.action === 'reminderAlert') {
        const note = request.note ? ` — ${request.note}` : '';
        // Стабільний id на тікет — повторне нагадування замінює попереднє.
        showNotification(
            'reminderAlarm:' + (request.ticketId || ''),
            '⏰ Нагадування по тікету',
            `Тікет #${request.ticketId}${note}`,
            request.url || ''
        );
    } else if (request.action === 'setBadge') {
        if (request.count !== undefined) badgeMatch = Number(request.count) || 0;
        if (request.awaiting !== undefined) badgeAwaiting = Number(request.awaiting) || 0;
        if (request.longestMin !== undefined) badgeLongest = Number(request.longestMin) || 0;
        renderBadge();
    }
});

// Клік по сповіщенню → відкрити тікет (якщо знаємо url).
if (chrome.notifications && chrome.notifications.onClicked) {
    chrome.notifications.onClicked.addListener((id) => {
        const url = notifUrls[id];
        if (url) { try { chrome.tabs.create({ url }); } catch (e) { /* ignore */ } }
        try { chrome.notifications.clear(id); } catch (e) { /* ignore */ }
        delete notifUrls[id];
        if (id === RED_GROUP_ID) { redGroup = []; redGroupUrl = ''; }
    });
}
// Користувач закрив згруповане сповіщення → почати лічильник наново. Лише byUser:
// наш власний clear() при перепоказі тоста НЕ має скидати накопичення.
if (chrome.notifications && chrome.notifications.onClosed) {
    chrome.notifications.onClosed.addListener((id, byUser) => {
        if (byUser && id === RED_GROUP_ID) { redGroup = []; redGroupUrl = ''; }
    });
}

// --- Бейдж на іконці: «клієнт чекає» (пріоритет) або лічильник збігів ----
let badgeMatch = 0, badgeAwaiting = 0, badgeLongest = 0;
function renderBadge() {
    try {
        if (badgeAwaiting > 0) {
            chrome.action.setBadgeText({ text: String(badgeAwaiting) });
            chrome.action.setBadgeBackgroundColor({ color: '#ff3b30' });
            chrome.action.setTitle({ title: 'Клієнтів чекає: ' + badgeAwaiting + (badgeLongest > 0 ? ' · найдовше ' + badgeLongest + ' хв' : '') });
        } else if (badgeMatch > 0) {
            chrome.action.setBadgeText({ text: String(badgeMatch) });
            chrome.action.setBadgeBackgroundColor({ color: '#d33b2f' });
            chrome.action.setTitle({ title: '' });
        } else {
            chrome.action.setBadgeText({ text: '' });
            chrome.action.setTitle({ title: '' });
        }
    } catch (e) { /* ignore */ }
}

// Синхронізація спільних будильників (виклики від content.js / popup).
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    if (!req || !req.sb || typeof SB === 'undefined') return; // не sb-повідомлення
    (async () => {
        try {
            if (req.sb === 'pull') {
                await SB.pull();
            } else if (req.sb === 'add') {
                // Додати тікет у будильники (кнопка з панелі). Завжди власний.
                const ticketId = String(req.ticketId || '').trim();
                const time = String(req.time || '').trim();
                if (!ticketId || !time) { sendResponse({ ok: false, error: 'no ticket/time' }); return; }
                const settings = await new Promise((res) => {
                    try { chrome.storage.sync.get('settings', (d) => res((d && d.settings) || {})); }
                    catch (e) { res({}); }
                });
                settings.reminders = Array.isArray(settings.reminders) ? settings.reminders : [];
                if (settings.reminders.some((r) => r && String(r.ticketId) === ticketId)) {
                    sendResponse({ ok: true, duplicate: true }); return;
                }
                // 1) Пишемо локально ОДРАЗУ (з часом) — щоб попап показав будильник миттєво
                //    в обох браузерах, не чекаючи кругообігу Supabase (у Firefox він повільніший).
                const id = (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now());
                settings.reminders.push({ id, ticketId, time, note: '', scope: 'personal' });
                await new Promise((res) => { try { chrome.storage.sync.set({ settings }, res); } catch (e) { res(); } });
                // 2) Синк у спільну базу (для інших пристроїв); pull замінить локальний id на uuid із бази.
                if (await SB.loggedIn()) {
                    try { await SB.insertReminder({ ticketId, time, scope: 'personal', note: '' }); await SB.pull(); }
                    catch (e) { /* локально вже додано — синк підхопиться згодом */ }
                }
                sendResponse({ ok: true });
                return;
            } else if (req.sb === 'logs') {
                if (!(await SB.loggedIn())) { sendResponse({ ok: false, error: 'not-logged-in' }); return; }
                const rows = await SB.listLogs(req.limit);
                sendResponse({ ok: true, rows: rows || [] });
                return;
            } else if (req.sb === 'snooze') {
                for (const id of (req.ids || [])) await SB.setSnooze(id, req.until);
                await SB.pull();
            } else if (req.sb === 'mute') {
                await SB.setMute(req.id, req.mutedDate);
                await SB.pull();
            } else if (req.sb === 'claim') {
                for (const id of (req.ids || [])) await SB.claimReminder(id);
                await SB.pull();
            } else if (req.sb === 'done') {
                for (const id of (req.ids || [])) await SB.doneReminder(id);
                await SB.pull();
            } else if (req.sb === 'snipPull') {
                if (!(await SB.loggedIn())) { sendResponse({ ok: false, error: 'not-logged-in' }); return; }
                const rows = await SB.pullSnippets();
                sendResponse({ ok: true, rows: rows || [] });
                return;
            } else if (req.sb === 'snipAdd') {
                await SB.insertSnippet(req.snippet || {});
                await SB.pullSnippets();
            } else if (req.sb === 'snipUpdate') {
                await SB.updateSnippet(req.snippet || {});
                await SB.pullSnippets();
            } else if (req.sb === 'snipDel') {
                await SB.archiveSnippet(req.id);
                await SB.pullSnippets();
            } else if (req.sb === 'snipRestore') {
                await SB.unarchiveSnippet(req.id);
                await SB.pullSnippets();
            } else if (req.sb === 'snipPurge') {
                await SB.purgeSnippet(req.id);
                await SB.pullSnippets();
            } else if (req.sb === 'catPull') {
                if (!(await SB.loggedIn())) { sendResponse({ ok: false, error: 'not-logged-in' }); return; }
                const rows = await SB.pullCategories();
                sendResponse({ ok: true, rows: rows || [] });
                return;
            } else if (req.sb === 'catAdd') {
                await SB.insertCategory(req.name || '');
                await SB.pullCategories();
            } else if (req.sb === 'catDel') {
                await SB.deleteCategory(req.name || '');
                await SB.pullCategories();
            } else if (req.sb === 'awPull') {
                if (!(await SB.loggedIn())) { sendResponse({ ok: false, error: 'not-logged-in' }); return; }
                const rows = await SB.pullAwaiting();
                sendResponse({ ok: true, rows: rows || [] });
                return;
            } else if (req.sb === 'awUpsert') {
                await SB.upsertAwaiting(req.awaiting || {});
                await SB.pullAwaiting();
            } else if (req.sb === 'awResolve') {
                await SB.resolveAwaiting(req.ticketId);
                await SB.pullAwaiting();
            } else if (req.sb === 'awLogs') {
                if (!(await SB.loggedIn())) { sendResponse({ ok: false, error: 'not-logged-in' }); return; }
                const rows = await SB.listAwaitingLogs(req.limit);
                sendResponse({ ok: true, rows: rows || [] });
                return;
            }
            sendResponse({ ok: true });
        } catch (e) {
            sendResponse({ ok: false, error: String(e) });
        }
    })();
    return true; // відповідь асинхронна
});

// --- Google Cloud Translation (переклад шаблонів) -----------------------
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    if (!req || req.gt !== 'translate') return; // не translate-повідомлення
    (async () => {
        try {
            const q = String(req.q || '');
            const target = String(req.target || '');
            const source = req.source || 'uk';
            if (!q.trim() || !target) { sendResponse({ ok: true, text: '' }); return; }
            // Безкоштовний неофіційний ендпоінт Google Translate (без ключа).
            const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=' + encodeURIComponent(source) + '&tl=' + encodeURIComponent(target) + '&dt=t&q=' + encodeURIComponent(q);
            const resp = await fetch(url);
            if (!resp.ok) { sendResponse({ ok: false, error: 'HTTP ' + resp.status }); return; }
            const data = await resp.json().catch(() => null);
            const text = (data && Array.isArray(data[0])) ? data[0].map((s) => (s && s[0]) || '').join('') : '';
            sendResponse({ ok: true, text });
        } catch (e) {
            sendResponse({ ok: false, error: String(e) });
        }
    })();
    return true;
});

// --- Realtime: миттєве поширення змін будильників ------------------------
// WebSocket тримаємо у service worker (CSP сторінки не заважає). На будь-яку
// зміну в reminders робимо повний SB.pull() — простіше й надійніше за розбір
// події. Heartbeat кожні 20с тримає і Phoenix-канал, і живий MV3-воркер.
let rtWs = null;
let rtHeartbeat = null;
let rtReconnect = null;
let rtPullTimer = null;
let rtJoinRef = 0;

function rtSchedulePull() {
    clearTimeout(rtPullTimer);
    rtPullTimer = setTimeout(() => {
        try { SB.pull(); } catch (e) { /* ignore */ }
        try { SB.pullAwaiting(); } catch (e) { /* ignore */ }
        try { SB.pullSnippets(); } catch (e) { /* ignore */ } // шаблони — live для всіх залогінених
        try { SB.pullCategories(); } catch (e) { /* ignore */ }
    }, 800);
}

let rtBackoff = 5000; // back-off перепідключення: 5с → ×2 → до 5 хв (без шторму)
function rtScheduleReconnect() {
    clearTimeout(rtReconnect);
    rtReconnect = setTimeout(async () => {
        try { if (await SB.loggedIn()) rtConnect(); } catch (e) { /* ignore */ }
    }, rtBackoff);
    rtBackoff = Math.min(rtBackoff * 2, 5 * 60 * 1000);
}

function rtClose(stopReconnect) {
    if (rtHeartbeat) { clearInterval(rtHeartbeat); rtHeartbeat = null; }
    if (stopReconnect && rtReconnect) { clearTimeout(rtReconnect); rtReconnect = null; }
    if (rtWs) { try { rtWs.onclose = null; rtWs.close(); } catch (e) { /* ignore */ } rtWs = null; }
}

async function rtConnect() {
    if (typeof SB === 'undefined' || !SB.configured()) return;
    let sess = await SB.getSession();
    sess = await SB.refreshIfNeeded(sess);
    if (!sess || !sess.access_token) return; // не залогінений — realtime не потрібен
    rtClose(false);
    try {
        rtWs = new WebSocket(SB_URL.replace(/^http/, 'ws') +
            '/realtime/v1/websocket?apikey=' + encodeURIComponent(SB_ANON) + '&vsn=2.0.0');
    } catch (e) { rtScheduleReconnect(); return; }

    rtWs.onopen = () => {
        rtBackoff = 5000; // успішне підключення — скидаємо back-off
        rtJoinRef++;
        const ref = String(rtJoinRef);
        rtWs.send(JSON.stringify([ref, ref, 'realtime:public.reminders', 'phx_join', {
            config: {
                broadcast: { ack: false, self: false },
                presence: { enabled: false },
                postgres_changes: [
                    { event: '*', schema: 'public', table: 'reminders' },
                    { event: '*', schema: 'public', table: 'awaiting_reply' },
                    { event: '*', schema: 'public', table: 'snippets' },
                    { event: '*', schema: 'public', table: 'snippet_categories' },
                ],
                private: false,
            },
            access_token: sess.access_token,
        }]));
        if (rtHeartbeat) clearInterval(rtHeartbeat);
        rtHeartbeat = setInterval(() => {
            if (rtWs && rtWs.readyState === WebSocket.OPEN) {
                rtWs.send(JSON.stringify([null, String(Date.now()), 'phoenix', 'heartbeat', {}]));
            }
        }, 20000);
        rtSchedulePull(); // початкова синхронізація після підключення
    };
    rtWs.onmessage = (ev) => {
        try {
            const msg = JSON.parse(ev.data);
            const event = Array.isArray(msg) ? msg[3] : (msg && msg.event);
            if (event === 'postgres_changes') rtSchedulePull();
        } catch (e) { /* ignore */ }
    };
    rtWs.onclose = () => { if (rtHeartbeat) { clearInterval(rtHeartbeat); rtHeartbeat = null; } rtScheduleReconnect(); };
    rtWs.onerror = () => { try { rtWs.close(); } catch (e) { /* ignore */ } };
}

// Відкривати/закривати realtime за станом сесії (логін/логаут).
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.sbSession) {
        if (changes.sbSession.newValue) rtConnect();
        else rtClose(true);
    }
});

// Фолбек-синхронізація через alarms (коли realtime/SW заснули чи Firefox).
if (chrome.alarms && chrome.alarms.onAlarm) {
    chrome.alarms.onAlarm.addListener((a) => {
        if (!a) return;
        if (a.name === 'sbpull' && typeof SB !== 'undefined') { try { SB.pull(); SB.pullSnippets(); SB.pullCategories(); SB.pullAwaiting(); } catch (e) { /* ignore */ } }
    });
}

// Старт (виконується при кожному «пробудженні» воркера).
function sbBoot() {
    if (typeof SB === 'undefined') return;
    try { chrome.alarms.create('sbpull', { periodInMinutes: 15 }); } catch (e) { /* ignore */ }
    SB.loggedIn().then((yes) => { if (yes) { rtConnect(); try { SB.pullSnippets(); SB.pullCategories(); SB.pullAwaiting(); } catch (e) { /* ignore */ } } }).catch(() => {});
}
if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(sbBoot);
if (chrome.runtime.onInstalled) chrome.runtime.onInstalled.addListener(sbBoot);
sbBoot();
