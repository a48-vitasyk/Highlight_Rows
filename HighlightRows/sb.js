// sb.js — buildless Supabase-клієнт для розширення (без залежностей).
// Підключається у background (service worker, через importScripts) і в popup
// (через <script>). У content.js НЕ підключається: у MV3 fetch із контент-
// скрипта підлягає CSP сторінки, тож усі мережеві виклики йдуть через background.
// Вхід (chrome.identity.launchWebAuthFlow) можливий лише на сторінці розширення
// (popup) — у service worker chrome.identity теж доступний, але запускаємо з popup.
//
// Спільні дані: лише будильники (таблиця public.reminders). Решта налаштувань
// лишається локальною (storage.sync.settings).

const SB_URL = 'https://wxiuucxzxhzctawzgqrr.supabase.co';
const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind4aXV1Y3h6eGh6Y3Rhd3pncXJyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExODY4OTEsImV4cCI6MjA5Njc2Mjg5MX0.LIt4yG5dS79BOBlikh1sVszi6VbXWQaKDC96YrBgLBk';

const SB = {
    configured() { return !!(SB_URL && SB_ANON); },

    // --- Сесія (storage.local.sbSession) ---
    getSession() {
        return new Promise((res) => {
            try { chrome.storage.local.get('sbSession', (d) => res((d && d.sbSession) || null)); }
            catch (e) { res(null); }
        });
    },
    setSession(s) {
        return new Promise((res) => { try { chrome.storage.local.set({ sbSession: s }, () => res(s)); } catch (e) { res(s); } });
    },
    clearSession() {
        return new Promise((res) => { try { chrome.storage.local.remove('sbSession', res); } catch (e) { res(); } });
    },

    // Розкодувати payload JWT (email/sub завжди є в access_token) — щоб ім'я
    // не залежало від окремого запиту /auth/v1/user, який може не вдатися.
    _decodeJwt(token) {
        try {
            const seg = String(token || '').split('.')[1];
            if (!seg) return null;
            const bin = atob(seg.replace(/-/g, '+').replace(/_/g, '/'));
            const json = decodeURIComponent(bin.split('').map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
            return JSON.parse(json);
        } catch (e) { return null; }
    },
    _sessFromToken(j) {
        let user = j.user ? { id: j.user.id, email: j.user.email } : null;
        if ((!user || !user.email) && j.access_token) {
            const c = SB._decodeJwt(j.access_token);
            if (c) {
                const email = c.email || (c.user_metadata && c.user_metadata.email) || (user && user.email) || null;
                user = { id: c.sub || (user && user.id) || null, email };
            }
        }
        return {
            access_token: j.access_token,
            refresh_token: j.refresh_token,
            expires_at: j.expires_at || (Math.floor(Date.now() / 1000) + (Number(j.expires_in) || 3600)),
            user,
        };
    },

    async refreshIfNeeded(sess) {
        if (!sess) return null;
        if (sess.expires_at && Date.now() / 1000 < sess.expires_at - 60) return sess;
        if (!sess.refresh_token) return sess;
        try {
            const resp = await fetch(SB_URL + '/auth/v1/token?grant_type=refresh_token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', apikey: SB_ANON },
                body: JSON.stringify({ refresh_token: sess.refresh_token }),
            });
            if (!resp.ok) { await SB.clearSession(); return null; }
            const ns = SB._sessFromToken(await resp.json());
            if (!ns.user && sess.user) ns.user = sess.user;
            await SB.setSession(ns);
            return ns;
        } catch (e) { return sess; }
    },

    async loggedIn() { return !!(await SB.getSession()); },

    // --- REST-обгортка ---
    async rest(path, opts = {}) {
        let sess = await SB.getSession();
        sess = await SB.refreshIfNeeded(sess);
        const headers = { apikey: SB_ANON, 'Content-Type': 'application/json' };
        if (sess && sess.access_token) headers.Authorization = 'Bearer ' + sess.access_token;
        const resp = await fetch(SB_URL + '/rest/v1/' + path, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
        if (resp.status === 401) { await SB.clearSession(); throw new Error('unauthorized'); }
        if (!resp.ok) throw new Error('supabase ' + resp.status);
        if (resp.status === 204) return null;
        const txt = await resp.text();
        return txt ? JSON.parse(txt) : null;
    },

    // --- CRUD будильників ---
    listReminders() { return SB.rest('reminders?select=*&order=updated_at.desc'); },
    listLogs(limit) { return SB.rest('reminder_logs?select=*&order=at.desc&limit=' + (Number(limit) > 0 ? Number(limit) : 100)); },
    async insertReminder(r) {
        const sess = await SB.getSession();
        const email = (sess && sess.user && sess.user.email) || null;
        return SB.rest('reminders', {
            method: 'POST', headers: { Prefer: 'return=representation' },
            body: JSON.stringify({
                ticket_id: r.ticketId, time: r.time, note: r.note || '',
                scope: r.scope === 'shared' ? 'shared' : 'personal',
                created_by_email: email,
            }),
        });
    },
    updateReminder(r) {
        return SB.rest('reminders?id=eq.' + encodeURIComponent(r.id), {
            method: 'PATCH', body: JSON.stringify({
                ticket_id: r.ticketId, time: r.time, note: r.note || '',
                scope: r.scope === 'shared' ? 'shared' : 'personal',
            }),
        });
    },
    deleteReminder(id) { return SB.rest('reminders?id=eq.' + encodeURIComponent(id), { method: 'DELETE' }); },
    setMute(id, mutedDate) {
        return SB.rest('reminders?id=eq.' + encodeURIComponent(id), {
            method: 'PATCH', body: JSON.stringify({ muted_date: mutedDate || null }),
        });
    },
    setSnooze(id, untilMs) {
        return SB.rest('reminders?id=eq.' + encodeURIComponent(id), {
            method: 'PATCH', body: JSON.stringify({ snooze_until: untilMs ? new Date(untilMs).toISOString() : null }),
        });
    },
    async claimReminder(id) {
        const sess = await SB.getSession();
        const email = (sess && sess.user && sess.user.email) || null;
        const uid = (sess && sess.user && sess.user.id) || null;
        return SB.rest('reminders?id=eq.' + encodeURIComponent(id), {
            method: 'PATCH', body: JSON.stringify({ owner_email: email, owner_uid: uid, taken_at: new Date().toISOString() }),
        });
    },
    async doneReminder(id) {
        const sess = await SB.getSession();
        const email = (sess && sess.user && sess.user.email) || null;
        return SB.rest('reminders?id=eq.' + encodeURIComponent(id), {
            method: 'PATCH', body: JSON.stringify({ done_at: new Date().toISOString(), done_by_email: email }),
        });
    },

    // --- Дзеркало у storage (щоб content.js працював без змін) ---
    async mirror(rows) {
        rows = rows || [];
        const reminders = rows.map((x) => ({
            id: x.id, ticketId: x.ticket_id, time: x.time, note: x.note || '',
            scope: x.scope || 'personal', creatorEmail: x.created_by_email || '',
            ownerEmail: x.owner_email || '',
            takenAt: x.taken_at ? Date.parse(x.taken_at) : 0,
            doneAt: x.done_at ? Date.parse(x.done_at) : 0,
            doneByEmail: x.done_by_email || '',
        }));
        const reminderState = {};
        for (const x of rows) {
            const st = {};
            if (x.muted_date) st.mutedDate = x.muted_date;
            if (x.snooze_until) { const t = Date.parse(x.snooze_until); if (!Number.isNaN(t)) st.snoozeUntil = t; }
            if (Object.keys(st).length) reminderState[x.id] = st;
        }
        await new Promise((res) => {
            try {
                chrome.storage.sync.get('settings', (d) => {
                    const s = (d && d.settings) || {};
                    s.reminders = reminders;
                    chrome.storage.sync.set({ settings: s }, res);
                });
            } catch (e) { res(); }
        });
        await new Promise((res) => { try { chrome.storage.local.set({ reminderState }, res); } catch (e) { res(); } });
    },

    async pull() {
        if (!SB.configured() || !(await SB.loggedIn())) return null;
        const rows = await SB.listReminders();
        await SB.mirror(rows);
        return rows;
    },

    // --- Шаблони відповідей (спільні) ---
    listSnippets() { return SB.rest('snippets?select=*&order=sort.asc,updated_at.desc'); },
    async insertSnippet(s) {
        const sess = await SB.getSession();
        const email = (sess && sess.user && sess.user.email) || null;
        return SB.rest('snippets', {
            method: 'POST', headers: { Prefer: 'return=representation' },
            body: JSON.stringify({ title: s.title || '', body: s.body || '', body_ru: s.bodyRu || '', body_en: s.bodyEn || '', shortcut: s.shortcut || '', category: s.category || '', sort: s.sort || 0, created_by_email: email }),
        });
    },
    updateSnippet(s) {
        return SB.rest('snippets?id=eq.' + encodeURIComponent(s.id), {
            method: 'PATCH', body: JSON.stringify({ title: s.title || '', body: s.body || '', body_ru: s.bodyRu || '', body_en: s.bodyEn || '', shortcut: s.shortcut || '', category: s.category || '', sort: s.sort || 0 }),
        });
    },
    deleteSnippet(id) { return SB.rest('snippets?id=eq.' + encodeURIComponent(id), { method: 'DELETE' }); },
    async mirrorSnippets(rows) {
        const snippets = (rows || []).map((x) => ({ id: x.id, title: x.title || '', body: x.body || '', bodyRu: x.body_ru || '', bodyEn: x.body_en || '', shortcut: x.shortcut || '', category: x.category || '', creatorEmail: x.created_by_email || '' }));
        await new Promise((res) => { try { chrome.storage.local.set({ snippets }, res); } catch (e) { res(); } });
    },
    async pullSnippets() {
        if (!SB.configured() || !(await SB.loggedIn())) return null;
        const rows = await SB.listSnippets();
        await SB.mirrorSnippets(rows);
        return rows;
    },

    // Синхронізує будильники форми зі спільною базою: upsert рядків форми та
    // видалення ЛИШЕ явно прибраних (removedIds) — щоб не стерти чужі будильники,
    // додані паралельно (їх просто немає у нашій формі). Потім оновлює дзеркало.
    // r: {id?, ticketId, time, note, scope}.
    async syncReminders(formReminders, removedIds) {
        if (!SB.configured() || !(await SB.loggedIn())) return null;
        const existing = (await SB.listReminders()) || [];
        const existingIds = new Set(existing.map((x) => x.id));
        for (const r of formReminders) {
            if (r.id && existingIds.has(r.id)) await SB.updateReminder(r);
            else await SB.insertReminder(r);
        }
        for (const id of (removedIds || [])) {
            if (id && existingIds.has(id)) { try { await SB.deleteReminder(id); } catch (e) { /* ignore */ } }
        }
        return SB.pull();
    },

    // Одноразова міграція локальних будильників у спільну базу (прапорець sbMigrated).
    async migrateLocalOnce() {
        if (!SB.configured() || !(await SB.loggedIn())) return;
        const done = await new Promise((res) => chrome.storage.local.get('sbMigrated', (d) => res(d && d.sbMigrated)));
        if (done) return;
        const local = await new Promise((res) => chrome.storage.sync.get('settings', (d) => res(((d && d.settings) || {}).reminders || [])));
        for (const r of local) { if (r && r.ticketId && r.time) await SB.insertReminder(r); }
        await new Promise((res) => chrome.storage.local.set({ sbMigrated: true }, res));
        await SB.pull();
    },

    // --- Вхід через Google (лише там, де є chrome.identity, тобто popup) ---
    async login() {
        if (!SB.configured()) throw new Error('Supabase не налаштовано');
        if (!(chrome.identity && chrome.identity.launchWebAuthFlow)) throw new Error('identity недоступний тут');
        const redirect = chrome.identity.getRedirectURL();
        const url = SB_URL + '/auth/v1/authorize?provider=google&redirect_to=' + encodeURIComponent(redirect);
        const redirectUrl = await new Promise((res, rej) => {
            chrome.identity.launchWebAuthFlow({ url, interactive: true }, (r) => {
                if (chrome.runtime.lastError || !r) rej(new Error(chrome.runtime.lastError ? chrome.runtime.lastError.message : 'скасовано'));
                else res(r);
            });
        });
        // Токени Supabase повертає у фрагменті: #access_token=...&refresh_token=...&expires_in=...
        const frag = (redirectUrl.split('#')[1]) || (redirectUrl.split('?')[1]) || '';
        const p = new URLSearchParams(frag);
        if (p.get('error')) throw new Error(p.get('error_description') || p.get('error'));
        const access_token = p.get('access_token');
        if (!access_token) throw new Error('токен не отримано');
        const sess = SB._sessFromToken({
            access_token,
            refresh_token: p.get('refresh_token'),
            expires_in: p.get('expires_in'),
        });
        await SB.setSession(sess);
        try {
            const u = await fetch(SB_URL + '/auth/v1/user', { headers: { apikey: SB_ANON, Authorization: 'Bearer ' + access_token } });
            if (u.ok) { const uj = await u.json(); sess.user = { id: uj.id, email: uj.email }; await SB.setSession(sess); }
        } catch (e) { /* email необов'язковий */ }
        await SB.migrateLocalOnce();
        await SB.pull();
        return sess;
    },

    async logout() {
        const sess = await SB.getSession();
        try {
            if (sess && sess.access_token) {
                await fetch(SB_URL + '/auth/v1/logout', { method: 'POST', headers: { apikey: SB_ANON, Authorization: 'Bearer ' + sess.access_token } });
            }
        } catch (e) { /* ignore */ }
        await SB.clearSession();
    },
};

if (typeof self !== 'undefined') self.SB = SB;
