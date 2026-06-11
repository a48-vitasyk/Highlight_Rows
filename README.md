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
