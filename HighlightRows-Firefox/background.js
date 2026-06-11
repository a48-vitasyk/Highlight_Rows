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
