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

## 4. Дані для розширення — ВЖЕ ВШИТО
`SUPABASE_URL` та `SUPABASE_ANON_KEY` для проєкту `wxiuucxzxhzctawzgqrr` уже
прописані у `HighlightRows/sb.js` (anon-ключ публічний за дизайном — захист RLS +
JWT). Якщо проєкт зміниться — оновити ці дві константи на початку `sb.js`.

## 5. Redirect URL розширення — що зареєструвати на кроці 3
Розширення використовує `chrome.identity.getRedirectURL()`, що повертає
`https://<EXTENSION_ID>.chromiumapp.org/`. Дізнатись `EXTENSION_ID`:
завантажити розпаковане розширення → `chrome://extensions` → ID на картці.
Цей URL додати в Supabase → Authentication → URL Configuration → Redirect URLs.
(Для стабільного ID між встановленнями — задати `key` у Chrome-маніфесті; поки
для розпакованого ID стабільний за шляхом теки.)

## Стан
Код під'єднано (`sb.js`, вхід у попапі, синхронізація через background,
`identity` + `host_permissions`, міграція локальних будильників). Лишилось:
**(1)** застосувати міграцію, **(2)** налаштувати Google-провайдер і redirect URL.
Після цього — наскрізне тестування входу та спільних будильників.
