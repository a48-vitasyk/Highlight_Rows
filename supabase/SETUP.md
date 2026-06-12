# Спільна база будильників — налаштування Supabase

Схема готова (`supabase/migrations/0001_shared_reminders.sql`). Коли буде
Supabase-проєкт (на потрібному акаунті), пройти ці кроки — після цього
під'єднаємо розширення.

## 1. Застосувати схему
Виконати міграції **по порядку** (SQL Editor → вставити вміст → Run; або
`supabase db push`; або MCP `apply_migration`):
- `0001_shared_reminders.sql` — таблиця `reminders`, RLS, тригери.
- `0002_scope_realtime.sql` — scope (особистий/загальний) + Realtime.
- `0003_harden_function_search_path.sql` — гартування функцій.
- `0004_audit_log.sql` — **журнал дій** (таблиця `reminder_logs` + тригер
  `reminders_log`): хто створив / змінив scope / заглушив / відклав /
  відредагував / видалив будильник, з email автора та часом.

Перевірити: таблиці `public.reminders` і `public.reminder_logs` створені, RLS
увімкнено, є тригери `reminders_touch`, `enforce_domain`, `reminders_log`.

> Переглянути історію: Supabase → Table Editor → `reminder_logs` (або
> `select * from public.reminder_logs order by at desc`). У самому розширенні
> поки не показується — за потреби додам вкладку «Історія».

## 2. Увімкнути вхід через Google (SSO)
1. Google Cloud Console → APIs & Services → Credentials → **OAuth client ID**
   (тип «Web application»).
   - Authorized redirect URI: `https://<PROJECT_REF>.supabase.co/auth/v1/callback`
   - На OAuth consent screen — внутрішній тип / обмеження домену за потреби.
2. Supabase → Authentication → Providers → **Google**: вставити Client ID і
   Client Secret, увімкнути.
3. Обмеження доменом `@your-domain.example` забезпечує тригер `enforce_domain` у БД
   (додатково в розширенні передаємо Google-підказку `hd=your-domain.example`).

## 3. Redirect URLs для розширення
Supabase → Authentication → URL Configuration → Redirect URLs, додати:
- Chrome: `https://<EXTENSION_ID>.chromiumapp.org/`
- Firefox: значення з `browser.identity.getRedirectURL()`

> `EXTENSION_ID` стабільний, якщо у `manifest.json` задано `key` (Chrome) або
> `browser_specific_settings.gecko.id` (Firefox, уже є). Інакше — взяти ID із
> `chrome://extensions` після завантаження розпакованого.

## 4. Дані для розширення — ВЖЕ ВШИТО
`SUPABASE_URL` та `SUPABASE_ANON_KEY` для проєкту `wxiuucxzxhzctawzgqrr` уже
прописані у `HighlightRows/sb.js` (anon-ключ публічний за дизайном — захист RLS +
JWT). Якщо проєкт зміниться — оновити ці дві константи на початку `sb.js`.

## 5. Redirect URL розширення — що зареєструвати на кроці 3
У Chrome-маніфесті задано фіксований `key`, тож ID розширення **стабільний**
(не залежить від шляху теки):
```
liccfkhgchjadllannpjbodhgfaoconc
```
Тому в Supabase → Authentication → URL Configuration → Redirect URLs має бути:
```
https://liccfkhgchjadllannpjbodhgfaoconc.chromiumapp.org/
```
(Firefox використовує `chrome.identity.getRedirectURL()` зі своїм ID — для
Firefox-збірки redirect додається окремо.)

## Стан
Код під'єднано (`sb.js`, вхід у попапі, синхронізація через background,
`identity` + `host_permissions`, міграція локальних будильників). Лишилось:
**(1)** застосувати міграцію, **(2)** налаштувати Google-провайдер і redirect URL.
Після цього — наскрізне тестування входу та спільних будильників.
