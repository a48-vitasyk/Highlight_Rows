# Спільна база будильників — налаштування Supabase

Схема готова (`supabase/migrations/0001_shared_reminders.sql`). Коли буде
Supabase-проєкт (на потрібному акаунті), пройти ці кроки — після цього
під'єднаємо розширення.

## 1. Застосувати схему
- SQL Editor → вставити вміст `0001_shared_reminders.sql` → Run; **або**
- `supabase db push`; **або** MCP `apply_migration`.

Перевірити: таблиця `public.reminders` створена, RLS увімкнено, є тригери
`reminders_touch` і `enforce_domain`.

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

## 4. Дані для розширення
Узяти **Project URL** і **anon (publishable) key** (Settings → API).
Вони підуть у конфіг `sb.js` (буде доданий на етапі під'єднання) —
`SUPABASE_URL` та `SUPABASE_ANON_KEY`. anon-ключ публічний за дизайном
(захист — RLS + JWT), його можна вшивати в розширення.

## 5. Під'єднання розширення (наступний етап)
Після кроків 1–4 додаємо `sb.js` (клієнт buildless через `fetch`), блок входу в
попапі, синхронізацію будильників і `host_permissions` на `https://*.supabase.co/*`
+ дозвіл `identity`. Тоді ж — одноразова міграція наявних локальних будильників
у спільну базу й наскрізне тестування.
