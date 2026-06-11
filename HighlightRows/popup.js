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
    staleHours: 4,
    trafficEnabled: false,
};

const $ = (id) => document.getElementById(id);

function genId() {
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

// --- Динамічні рядки -----------------------------------------------------

function makeEl(tag, props, children) {
    const el = document.createElement(tag);
    Object.assign(el, props || {});
    (children || []).forEach((c) => el.appendChild(c));
    return el;
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
    const notify = makeEl('input', { type: 'checkbox', className: 'tr-notify', checked: !!r.notify });
    const sound = makeEl('input', { type: 'checkbox', className: 'tr-sound', checked: !!r.sound });
    const repeat = makeEl('input', {
        type: 'number', className: 'tr-repeat', value: r.repeatMinutes || 0,
        min: 0, step: 0.1, title: 'Повтор сигналу, хв (0 = один раз)',
    });
    const remove = makeEl('button', { type: 'button', className: 'small remove', textContent: '×' });

    const row = makeEl('div', { className: 'rule-row' }, [
        query,
        color,
        makeEl('label', { className: 'icon-label' }, [notify, document.createTextNode('🔔')]),
        makeEl('label', { className: 'icon-label' }, [sound, document.createTextNode('🔊')]),
        repeat,
        remove,
    ]);
    remove.addEventListener('click', () => row.remove());
    $('tagRules').appendChild(row);
    firefoxifyColor(color); // Firefox: інлайн-пікер замість нативного діалогу
}

function addReminderRow(reminder, muted) {
    const r = reminder || { id: genId(), ticketId: '', time: '', note: '' };
    const id = r.id || genId();
    const ticket = makeEl('input', { type: 'text', className: 'rm-ticket', value: r.ticketId, placeholder: 'ID тікета' });
    const time = makeEl('input', { type: 'time', className: 'rm-time', value: r.time });
    const note = makeEl('input', { type: 'text', className: 'rm-note', value: r.note, placeholder: 'текст' });
    const mute = makeEl('button', { type: 'button', className: 'small mute' });
    setMuteBtn(mute, !!muted);
    const remove = makeEl('button', { type: 'button', className: 'small remove', textContent: '×', title: 'Видалити' });

    const row = makeEl('div', { className: 'rem-row' }, [ticket, time, note, mute, remove]);
    row.dataset.id = id;

    mute.addEventListener('click', () => toggleMute(id, mute));
    remove.addEventListener('click', () => row.remove());
    $('reminders').appendChild(row);
}

// --- Заглушення / увімкнення (storage.local, миттєво) --------------------

function isMutedToday(state, id) {
    return !!(state && state[id] && state[id].mutedDate === todayStr());
}

// Кнопка показує ПОТОЧНИЙ стан: 🔔 — активний, 🔕 — заглушено на сьогодні.
function setMuteBtn(btn, muted) {
    btn.textContent = muted ? '🔕' : '🔔';
    btn.title = muted
        ? 'Заглушено сьогодні — клікніть, щоб увімкнути'
        : 'Активний — клікніть, щоб заглушити на сьогодні';
}

function toggleMute(id, btn) {
    chrome.storage.local.get('reminderState', (data) => {
        const state = (data && data.reminderState) || {};
        const muted = isMutedToday(state, id);
        if (muted) delete state[id];
        else state[id] = { mutedDate: todayStr() };
        chrome.storage.local.set({ reminderState: state }, () => setMuteBtn(btn, !muted));
    });
}

// --- Форма ---------------------------------------------------------------

function fillForm(s, reminderState) {
    $('enabled').checked = s.enabled;
    $('names').value = (s.names || []).join('\n');
    $('thresholdMinutes').value = s.thresholdMinutes;
    $('repeatMinutes').value = s.repeatMinutes;
    $('color').value = s.color || DEFAULT_SETTINGS.color;
    $('soundEnabled').checked = s.soundEnabled;
    $('staleHours').value = s.staleHours || DEFAULT_SETTINGS.staleHours;
    $('trafficEnabled').checked = s.trafficEnabled;
    $('reminderColor').value = s.reminderColor || DEFAULT_SETTINGS.reminderColor;

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
            notify: row.querySelector('.tr-notify').checked,
            sound: row.querySelector('.tr-sound').checked,
            repeatMinutes: Math.max(0, Number(row.querySelector('.tr-repeat').value) || 0),
        }))
        .filter((r) => r.query);

    const reminders = [...document.querySelectorAll('#reminders .rem-row')]
        .map((row) => ({
            id: row.dataset.id || genId(),
            ticketId: row.querySelector('.rm-ticket').value.trim(),
            time: row.querySelector('.rm-time').value.trim(),
            note: row.querySelector('.rm-note').value,
        }))
        .filter((r) => r.ticketId && r.time);

    return {
        enabled: $('enabled').checked,
        names: $('names').value.split('\n').map((n) => n.trim()).filter(Boolean),
        thresholdMinutes: Number($('thresholdMinutes').value) || DEFAULT_SETTINGS.thresholdMinutes,
        repeatMinutes: Math.max(0, Number($('repeatMinutes').value) || 0),
        color: $('color').value,
        soundEnabled: $('soundEnabled').checked,
        staleHours: Number($('staleHours').value) > 0 ? Number($('staleHours').value) : DEFAULT_SETTINGS.staleHours,
        trafficEnabled: $('trafficEnabled').checked,
        tagRules,
        reminderColor: $('reminderColor').value,
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
        box.appendChild(makeEl('div', { className: 'hint', textContent: 'Поки порожньо.' }));
        return;
    }
    arr.forEach((t) => {
        const age = t.noReply ? `${fmtHours(t.hours)} (без відп.)` : fmtHours(t.hours);
        const item = makeEl('div', {
            className: 'stale-item',
            textContent: `#${t.ticketId} · ${age} · ${truncate(t.subject, 36)}`,
            title: t.subject + (t.client ? ' — ' + t.client : ''),
        });
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
    item.addEventListener('click', () => {
        chrome.tabs.update({ url: u });
        window.close();
    });
}

// --- Завантаження / збереження -------------------------------------------

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

function kindIcons(kinds) {
    const map = { tag: '🏷', blocked: '🔒', reminder: '⏰' };
    return (kinds || []).map((k) => map[k] || '').join('');
}

function renderMatchTickets(arr) {
    const box = $('matchTickets');
    box.innerHTML = '';
    if (!arr || !arr.length) {
        box.appendChild(makeEl('div', { className: 'hint', textContent: 'Поки порожньо.' }));
        return;
    }
    arr.forEach((m) => {
        const item = makeEl('div', {
            className: 'stale-item',
            textContent: `#${m.ticketId} ${kindIcons(m.kinds)} ${truncate(m.subject, 30)}`,
            title: m.subject,
        });
        makeClickable(item, m.url);
        box.appendChild(item);
    });
}

chrome.storage.local.get(['staleTickets', 'matchTickets'], (d) => {
    renderStaleTickets((d && d.staleTickets) || []);
    renderMatchTickets((d && d.matchTickets) || []);
});
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.staleTickets) {
        renderStaleTickets(changes.staleTickets.newValue || []);
        setRefreshing(false);
    }
    if (changes.matchTickets) {
        renderMatchTickets(changes.matchTickets.newValue || []);
    }
});

$('refreshMatches').addEventListener('click', () => sendToActiveTab('scanMatches'));

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
            if (chrome.runtime.lastError) setRefreshing(false); // вкладка не панель
        });
    });
});

// Ручне оновлення трафіку у відкритому тікеті.
$('refreshTraffic').addEventListener('click', () => sendToActiveTab('refreshTraffic'));

$('addTagRule').addEventListener('click', () => addTagRuleRow());
$('addReminder').addEventListener('click', () => addReminderRow());

$('save').addEventListener('click', () => {
    const settings = readForm();
    chrome.storage.sync.set({ settings }, () => {
        chrome.storage.sync.remove('nameToHighlight');
        const status = $('status');
        status.textContent = 'Збережено';
        setTimeout(() => { status.textContent = ''; }, 1500);
    });
});
