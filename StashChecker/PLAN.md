# План реализации StashChecker

План доработки userscript на основе апстрима [timo95/stash-checker](https://github.com/timo95/stash-checker) под требования `TZ.txt`.

## 1. Контекст и архитектура апстрима

- Userscript живёт в подкаталоге **`userscript/`**, ветка по умолчанию **`master`**.
- Сборка: **webpack 5 + ts-loader + SCSS**, метаблок `==UserScript==` генерируется плагином `webpack-userscript` из `userscript/metadata.js`. Скрипты: `npm run build` (prod), `npm run dev` (webpack-dev-server, порт 8080). Тестов нет.
- Хранилище настроек: обёртки над `GM.getValue/setValue` в `src/settings/storage.ts`; опции — `enum OptionKey` + карты значений по умолчанию в `src/settings/providers.ts`; UI секций — `src/settings/*.ts`, фабрики полей — `src/settings/elements.ts`.
- **Определение состояния записи** — в `prefixSymbol()` (`src/tooltip/tooltip.ts`), а не в `check.ts`. Сейчас 3 состояния: `enum StashSymbol { Check, Warning, Cross }` (`src/dataTypes.ts`):
  - `Cross` (нет в базе) — `data.length === 0`;
  - `Warning` (дубликат) — на одном endpoint больше одной записи;
  - `Check` (есть в базе) — иначе.
- Символ сейчас **один на элемент** — данные всех endpoint'ов сливаются в него (`getExistingSymbol` + дозапись).
- GraphQL для сцены уже запрашивает `files{path,video_codec,width,height,size,bit_rate,duration}` и `tags{id,name}`, НО поля `Files`/`Tags` вырезаются из запроса (`getDataFields` в `check.ts`), если выключены опции `showFiles`/`showTags`.

## 2. Стратегия базы кода

Наш репозиторий пуст. Предлагаемый подход: **вендорить содержимое `userscript/` из апстрима в корень нашего репозитория** (как форк), сохранив историю через upstream remote для будущих подтягиваний. Все правки — поверх этой базы.

## 3. Целевая модель состояний

Расширяем `enum StashSymbol` двумя значениями: `Tag`, `NoFile`. Состояние вычисляется **для каждого Stash (endpoint) отдельно** по приоритету (сверху вниз, ТЗ п.3):

| Приоритет | Состояние | Условие | Символ (по умолч.) | Цвет символа |
|---|---|---|---|---|
| — | Cross (нет в базе) | `count === 0` | `✗` (`crossMark`) | red |
| 1 | Warning (дубликат) | несколько записей с одним StashID на endpoint | `!` (`warningMark`) | orange |
| 2 | Tag (содержит тег) | у записи есть тег из списка настроек | `⚑` (`tagMark`, настр.) | `#d800ff` |
| 3 | NoFile (нет файла) | **только сцены**: `entry.files?.length === 0` | `∅` (`noFileMark`, настр.) | red |
| 4 | Check (есть в базе) | иначе | `✓` (`checkMark`) | green |

Псевдокод для `prefixSymbol` (на данных одного endpoint'а):
```
if (count === 0)                          → Cross
else if (duplicate)                       → Warning
else if (hasSettingsTag(entries))         → Tag
else if (isScene && anyMissingFile(entries)) → NoFile
else                                      → Check
```

## 4. Фазы реализации

### Фаза 0 — Инициализация репозитория
- Скопировать `userscript/` из апстрима, `npm install`, убедиться что `npm run build`/`npm run dev` работают.
- Настроить `metadata.js` (name, updateURL/downloadURL, match — при необходимости).

### Фаза 1 — Слой данных: всегда запрашивать files и tags
- Файл: `src/check.ts`, функция `getDataFields`.
- Гарантировать, что для `Target.Scene` поле `Files` (минимум `Path`/`Id`) запрашивается **всегда**, а `Tags` — всегда (нужно для состояния Tag), независимо от `showFiles`/`showTags`. Опции `showFiles`/`showTags` продолжают управлять только отображением в tooltip, не запросом.

### Фаза 2 — Настройки: список тегов и символы новых состояний
- `src/settings/providers.ts`: добавить в `OptionKey` ключи `tagList` (string), `tagMark` (string), `noFileMark` (string); значения по умолчанию (`tagMark="⚑"`, `noFileMark="∅"`, `tagList=""`). При желании — `showTagMark`/`showNoFileMark` (boolean).
- `src/settings/general.ts`: добавить поля в секцию General через `charBox` (символы) и текстовое поле для списка тегов (разделитель — запятая).
- Хелпер разбора: `parseTagList(): string[]` (trim, отбросить пустые, привести к нижнему регистру для сравнения).

### Фаза 3 — Модель состояний
- `src/dataTypes.ts`: расширить `enum StashSymbol` значениями `Tag = "tag"`, `NoFile = "noFile"`.
- `src/tooltip/tooltip.ts`: вынести вычисление состояния в чистую функцию `resolveState(entries, target): StashSymbol` с приоритетом из раздела 3. Реализовать `hasSettingsTag` (сравнение имён тегов записи со списком из настроек, case-insensitive) и `anyMissingFile` (только для `Target.Scene`).

### Фаза 4 — Отдельный символ на каждый Stash (ТЗ п.1)
- `src/tooltip/tooltip.ts`, `prefixSymbol`: перейти от одного слитого символа к **отдельному символу на endpoint**. Каждый символ:
  - хранит `data-endpoint`, `data-symbol` (состояние по разделу 3), `data-info` (tooltip только этого endpoint'а);
  - вставляется в общий контейнер-обёртку (`span.stashCheckerSymbols`) перед первым текстовым узлом, чтобы символы шли группой.
- Обновить `getExistingSymbol`/дозапись: искать/дополнять контейнер, добавляя символ endpoint'а, если его ещё нет.
- Проверить `statistics.ts` — подсчёт символов должен корректно работать с новой разметкой и новыми состояниями.

### Фаза 5 — Символы и цвета новых состояний, tooltip
- `src/tooltip/tooltip.ts`: сопоставление `StashSymbol → символ/цвет` (Tag → `tagMark`/`#d800ff`, NoFile → `noFileMark`/red). Тексты tooltip: «содержит тег из списка», «отсутствует файл».
- При необходимости — стили в `src/style/main_important.scss`.

### Фаза 6 — Border карточки сцены (ТЗ п.4)
- Ввести в `CheckOptions` (`src/dataTypes.ts`) опциональный `cardSelector` — селектор контейнера карточки сцены относительно проверяемого элемента (`element.closest(cardSelector)`). Задать его для каждого поддерживаемого сайта в `src/stashChecker.ts` (там уже есть `switch` по `window.location.host`) — **только для сцен**.
- После простановки символов агрегировать состояния всех Stash-символов внутри карточки и красить `border` контейнера по приоритету (мэппинг ТЗ п.4):
  - дубликат → `yellow`; содержит тег → `#d800ff`; нет файла → `red`; есть в базе → `lightgreen`; нет в базе → без рамки.
- Реализовать как отдельную функцию `applyCardBorder(card)`, вызываемую после `prefixSymbol` (и при догрузке новых endpoint'ов, и через `observer`).

### Фаза 7 — Проверка и полировка
- Ручное тестирование в браузере (Violentmonkey + `npm run dev`) на 2–3 поддерживаемых сайтах: корректность 5 состояний, приоритета, отдельных символов на endpoint, рамки карточки.
- Обновить `CLAUDE.md` реальными командами сборки и картой изменённых модулей.

## 5. Открытые вопросы (нужно решение)

1. **База кода**: вендорить `userscript/` в корень (рекомендуется) или иначе?
2. **Символы по умолчанию** для Tag (`⚑`) и NoFile (`∅`) — устраивают?
3. **Сравнение тегов**: по имени, регистронезависимо, точное совпадение (а не подстрока)? Рекомендуется точное по имени.
4. **Приоритет цвета рамки** при нескольких статусах на карточке: использовать тот же приоритет, что для состояний (дубликат > тег > нет файла > есть в базе). Подтвердить.
5. **Рамка** — только для карточек сцен (ТЗ так говорит), для остальных типов не трогаем. Подтвердить.

## 6. Риски

- **`cardSelector` по сайтам** — самый трудоёмкий и хрупкий пункт: у каждого сайта своя вёрстка карточки; требует ручной настройки и тестирования per-site.
- **Рефакторинг `prefixSymbol`** (переход на символ-на-endpoint) затрагивает мультиэндпоинт-дозапись, tooltip и статистику — центральное место, требует аккуратности.
- Апстрим активно развивается — вендоринг усложнит подтягивание обновлений.
