// background.js — показує desktop-сповіщення на запит content.js та є хабом
// для Supabase (усі мережеві виклики спільної бази будильників — тут, бо в MV3
// fetch із контент-скрипта підлягає CSP сторінки).
//  - redAlert: рядок перетнув поріг / спрацювало правило за тегом;
//  - reminderAlert: спрацював будильник-нагадування за тікетом;
//  - sb:* : синхронізація будильників зі спільною базою (pull / snooze / mute).

// Chrome (service_worker, один файл) тягне sb.js через importScripts; Firefox
// підключає його окремо через background.scripts, тож там importScripts немає.
if (typeof importScripts === 'function') { try { importScripts('sb.js'); } catch (e) { /* ignore */ } }

function showNotification(id, title, message) {
    const options = { type: 'basic', iconUrl: 'images/icon48.png', title, message };
    chrome.notifications.create(id, options);
}

chrome.runtime.onMessage.addListener((request) => {
    if (!request) return;

    if (request.action === 'redAlert') {
        // Унікальний id щоразу — сповіщення різних рядків накопичуються стосом.
        showNotification(
            'redAlert:' + (request.name || '') + ':' + Date.now(),
            'Увага!',
            `Рядок з «${request.name}» виділено червоним.`
        );
    } else if (request.action === 'reminderAlert') {
        const note = request.note ? ` — ${request.note}` : '';
        // Стабільний id на тікет — повторне нагадування замінює попереднє,
        // а не засмічує центр сповіщень новим стосом щохвилини.
        showNotification(
            'reminderAlarm:' + (request.ticketId || ''),
            'Нагадування по тікету',
            `Тікет ${request.ticketId}${note}`
        );
    } else if (request.action === 'setBadge') {
        const n = Number(request.count) || 0;
        try {
            chrome.action.setBadgeText({ text: n > 0 ? String(n) : '' });
            chrome.action.setBadgeBackgroundColor({ color: '#d33b2f' });
        } catch (e) { /* ignore */ }
    }
});

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
                const existing = await new Promise((res) => {
                    try { chrome.storage.sync.get('settings', (d) => res(((d && d.settings && d.settings.reminders) || []))); }
                    catch (e) { res([]); }
                });
                if (existing.some((r) => r && String(r.ticketId) === ticketId)) {
                    sendResponse({ ok: true, duplicate: true }); return;
                }
                if (await SB.loggedIn()) {
                    await SB.insertReminder({ ticketId, time, scope: 'personal', note: '' });
                    await SB.pull();
                } else {
                    const settings = await new Promise((res) => {
                        try { chrome.storage.sync.get('settings', (d) => res((d && d.settings) || {})); }
                        catch (e) { res({}); }
                    });
                    settings.reminders = Array.isArray(settings.reminders) ? settings.reminders : [];
                    const id = (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now());
                    settings.reminders.push({ id, ticketId, time, note: '', scope: 'personal' });
                    await new Promise((res) => { try { chrome.storage.sync.set({ settings }, res); } catch (e) { res(); } });
                }
                sendResponse({ ok: true });
                return;
            } else if (req.sb === 'snooze') {
                for (const id of (req.ids || [])) await SB.setSnooze(id, req.until);
                await SB.pull();
            } else if (req.sb === 'mute') {
                await SB.setMute(req.id, req.mutedDate);
                await SB.pull();
            }
            sendResponse({ ok: true });
        } catch (e) {
            sendResponse({ ok: false, error: String(e) });
        }
    })();
    return true; // відповідь асинхронна
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
    rtPullTimer = setTimeout(() => { try { SB.pull(); } catch (e) { /* ignore */ } }, 800);
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
                postgres_changes: [{ event: '*', schema: 'public', table: 'reminders' }],
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
        if (a.name === 'sbpull' && typeof SB !== 'undefined') { try { SB.pull(); } catch (e) { /* ignore */ } }
    });
}

// Старт (виконується при кожному «пробудженні» воркера).
function sbBoot() {
    if (typeof SB === 'undefined') return;
    try { chrome.alarms.create('sbpull', { periodInMinutes: 15 }); } catch (e) { /* ignore */ }
    SB.loggedIn().then((yes) => { if (yes) rtConnect(); }).catch(() => {});
}
if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(sbBoot);
if (chrome.runtime.onInstalled) chrome.runtime.onInstalled.addListener(sbBoot);
sbBoot();
