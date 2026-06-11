// background.js — показує desktop-сповіщення на запит content.js.
//  - redAlert: рядок перетнув поріг / спрацювало правило за тегом;
//  - reminderAlert: спрацював будильник-нагадування за тікетом.

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
