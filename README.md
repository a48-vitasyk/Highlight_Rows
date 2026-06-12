# Highlight Rows

Розширення-помічник для панелі тікетів **Zomro** (ISPmanager / billmgr). Працює
на `*.zomro.com` та `*.omro.host`.

## Можливості

- **Заблокований запит** — підсвічує рядок, якщо тікет заблоковано вказаним
  іменем; після порогу починає миготіти + звук/сповіщення.
- **Правила за тегами** — якщо тема тікета містить тег (напр. `[TAG]`), рядок
  отримує свій колір + опційні сповіщення/звук.
- **Будильники** — нагадування за номером тікета й часом; спрацьовують за 5 хв
  до часу. Банер на сторінці з кнопкою **«Заглушити (снуз 10 хв)»**.
- **Без відповіді > N год** — монітор черги через API billmgr: тікети, де давно
  не відповідала підтримка (скан усіх сторінок).
- **Трафік та інфо про послугу** — у відкритому тікеті дописує трафік клієнта,
  статус/ОС/вартість/дату закінчення послуги.

## Структура

| Тека | Призначення |
|---|---|
| `HighlightRows/` | збірка для Chrome (Manifest V3, service worker) |
| `HighlightRows-Firefox/` | збірка для Firefox (`background.scripts`, `browser_specific_settings`) |
| `build.ps1` | пакування збірок у `dist/` |
| `dist/` | артефакти збірки (у git кладеться лише готовий `.xpi`) |

Код `content.js` / `background.js` / `popup.*` / `styles.css` в обох збірках
ідентичний — відрізняється тільки `manifest.json`.

## Встановлення

**Chrome:** `chrome://extensions` → увімкнути «Режим розробника» →
«Завантажити розпаковане» → вказати теку `HighlightRows`.

**Firefox:**
- _тимчасово (до перезапуску):_ `about:debugging` → This Firefox →
  «Load Temporary Add-on» → вибрати `.xpi` із `dist/` (або `manifest.json` із
  теки `HighlightRows-Firefox`);
- _постійно без підпису:_ лише у Firefox Developer Edition / Nightly з
  `about:config` → `xpinstall.signatures.required = false`;
- _для розповсюдження:_ підписати `.xpi` через
  [addons.mozilla.org](https://addons.mozilla.org/developers/).

## Оновлення (для користувачів)

Розширення **саме перевіряє** наявність нової версії: при старті та що 4 год
порівнює свою версію з `HighlightRows/manifest.json` у гілці `main` на GitHub.
Коли зʼявляється новіша — у футері попапа загоряється **червона крапка** і напис
«Є нова: X». Клік по кнопці ↻ перевіряє вручну.

Розширення **не може застосувати** код само (обмеження Manifest V3 + воно
встановлене «з теки»). Щоб усе **завантажувалось автоматично**, кожен користувач
один раз:

1. **Клонує репозиторій** замість копіювання теки:
   ```powershell
   git clone https://github.com/a48-vitasyk/Highlight_Rows.git
   ```
   і встановлює розширення з теки `Highlight_Rows\HighlightRows` (Chrome) або
   `…\HighlightRows-Firefox` (Firefox) — див. «Встановлення» нижче.

2. **Налаштовує автоматичний `git pull`** (щоб код підтягувався сам). Windows,
   Планувальник завдань — наприклад, що годину:
   ```powershell
   schtasks /create /tn "HighlightRows pull" /tr ^
     "powershell -NoProfile -Command \"cd 'C:\шлях\до\Highlight_Rows'; git pull\"" ^
     /sc hourly /f
   ```
   (шлях замінити на свій). Після `pull` код у теці вже новий — лишається лише
   застосувати його в браузері.

3. **Застосовує оновлення.** Коли у попапі видно «Є нова…», натиснути кнопку
   **«Перезавантажити»** поряд (вона перезапускає розширення) — або вручну
   `chrome://extensions` → ↻ Reload, та перезавантажити відкриті сторінки панелі.

> Повністю «магазинне» авто-оновлення (без `git pull`) можливе лише через
> публікацію в Chrome Web Store / підписаний `.xpi` з `update_url` — це окремий
> канал розповсюдження.

## Збірка

Із теки репозиторію:

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1
```

Скрипт читає версію з `manifest.json` кожної збірки й створює в `dist/`:

- `HighlightRows-<версія>.zip` — пакет для Chrome Web Store;
- `HighlightRows-Firefox-<версія>.xpi` — пакет для Firefox.

Архіви формуються через `System.IO.Compression` з прямими слешами в шляхах
(`images/icon48.png`) і `manifest.json` у корені — як вимагають Chrome/Firefox
(`Compress-Archive` у Windows PowerShell 5.1 цього не гарантує).

## Випуск нової версії

1. Підняти `version` у `HighlightRows/manifest.json` та
   `HighlightRows-Firefox/manifest.json` (тримати однаковими).
2. Виконати `build.ps1`.
3. Закомітити зміни (готовий `.xpi` з `dist/` теж версіонується).
