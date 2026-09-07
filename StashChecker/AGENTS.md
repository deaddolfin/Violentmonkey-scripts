# AGENTS.md — правила работы с этим репозиторием

Общий свод для любых AI-агентов (Claude Code, Codex и др.). `CLAUDE.md` ссылается сюда.
Перед стартом сессии читать **`STATUS.md`** — там текущее состояние, открытые баги и следующие шаги.

## Что это

Userscript **Stash Checker** для Violentmonkey/Tampermonkey. Форк апстрима
[timo95/stash-checker](https://github.com/timo95/stash-checker) (вендорнут в корень репозитория,
базовая версия 1.2.4), доработанный под `TZ.txt`. На страницах порносайтов проверяет наличие
сцен/исполнителей/студий/групп/галерей в базах Stash через GraphQL и рисует символы-индикаторы
состояния + цветную рамку карточки сцены. Пользовательское описание — `README.md`, план — `PLAN.md`.

Разработка ведётся на **Windows 11** — терминальные команды писать в синтаксисе PowerShell.

## Команды

- `npm install` — установка зависимостей (все в `devDependencies`).
- `npm run build` — production-сборка (webpack, `NODE_ENV=production`) → `dist/index.prod.user.js`
  (+ `.meta.js`). Три warning'а про размер бандла — норма, ошибок быть не должно.
- `npm run dev` — dev-режим (webpack-dev-server, порт 8080, имя скрипта «… Dev», hot reload).
  Установка dev-версии: запустить и добавить в Violentmonkey скрипт с dev-URL (см. `webpack.config.js`).
- Тестов нет (`test` в `package.json` пустой). Проверка типов выполняется `ts-loader` при сборке —
  `npm run build` и есть основная проверка после правок.

## Архитектура

- Сборка: **webpack 5 + ts-loader + SCSS**. Блок метаданных `==UserScript==` генерируется плагином
  `webpack-userscript` из `metadata.js` (там же список `match` поддерживаемых сайтов, `grant`,
  `updateURL`/`downloadURL` на raw-ссылку GitHub-зеркала; версия берётся из `package.json`).
- Точка входа `src/index.ts` → инициализация tooltip/настроек/темы → `runStashChecker()`.
- `src/stashChecker.ts` — **сайто-специфичная логика**: `switch` по `window.location.host`, для каждого
  сайта задаёт CSS-селекторы и `CheckOptions`, вызывает `check()`.
- `src/check.ts` — строит GraphQL-фильтры/запросы (`getDataFields`, `queryStash`), отправляет на все
  endpoint'ы, вызывает `prefixSymbol` в колбэке. `checkElement` пробует разные идентификаторы
  (URL/Code/StashId/Name/Aliases/Title).
- `src/tooltip/tooltip.ts` — **ядро отображения и состояний** (`resolveState`, `renderSymbol`,
  `applyCardBorder`, `prefixSymbol`, `clearSymbols`).
- `src/request.ts` — транспорт через `GM.xmlHttpRequest`, батчинг, очередь (`JobQueue`, concurrency 2).
- `src/settings/*` — настройки: `providers.ts` (`OptionKey` + значения по умолчанию), `storage.ts`
  (обёртка над `GM.getValue/setValue`), `general.ts`/`display.ts`/`endpoints.ts`/`statistics.ts`
  (UI секций), `elements.ts` (фабрики полей формы), `menu.ts` (пункты меню GM).
- `src/dataTypes.ts` — все типы/enum'ы (`StashEntry`, `DataField`, `Target`, `Type`, `StashSymbol`,
  `CheckOptions` …).

## Ключевая доработанная логика (относительно апстрима)

**Состояния записи** — `resolveState(data, target)` в `src/tooltip/tooltip.ts`, приоритет сверху вниз:

| Состояние (`StashSymbol`) | Условие | Символ (`OptionKey`) | Цвет |
|---|---|---|---|
| `Cross` (нет в базе) | `data.length === 0` | `crossMark` `✗` | red |
| `Warning` (дубликат) | `data.length > 1` на одном endpoint | `warningMark` `!` | orange |
| `Tag` (содержит тег) | у записи есть тег из `tagList` (все типы с тегами) | `tagMark` `⚑` | `#d800ff` |
| `NoFile` (нет файла) | **только сцены**: `files.length === 0` | `noFileMark` `∅` | red |
| `Check` (есть в базе) | иначе | `checkMark` `✓` | green / из custom-правила |

Сравнение тегов: точное по имени, регистронезависимо (`hasSettingsTag` + `getSettingsTags`).

**Символ на каждый Stash (endpoint).** `prefixSymbol` создаёт обёртку `span.stashCheckerSymbols`
(`data-type="stash-symbols"`) и внутри — по одному `span.stashCheckerSymbol[data-endpoint-name=…]`
на endpoint. Данные каждого endpoint'а мёржатся отдельно (`mergeData`), состояние считается по
данным своего endpoint'а. На символе хранятся `data-target`, `data-symbol`, `data-queries`,
`data-data`, `data-info` — по ним удобно отлаживать.

**Рамка карточки сцены.** `CheckOptions.cardSelector` (задаётся per-site в `stashChecker.ts`, только
для сцен) → `applyCardBorder(node, cardSelector, target)` агрегирует состояния символов **того же
target** внутри `element.closest(cardSelector)` (фильтр по `data-target` — чтобы статус студии или
исполнителя внутри карточки не влиял на рамку сцены) и красит `border: 3px solid` по приоритету
`cardBorderPriority`: дубликат `yellow` > тег `#d800ff` > нет файла `red` > есть в базе `lightgreen` >
нет в базе (рамка снимается). Помеченные карточки получают класс `stashCheckerBordered`
(сбрасывается в `clearSymbols`).
Сейчас `cardSelector` настроен для `iwara.tv` (`.videoTeaser`), `javdb.com` (`.item`) и стеш-боксов
`stashdb.org`/`fansdb.*`/`javstash.org`/`pmvstash.org` (`.SceneCard, .SearchPage-scene` для списков
и страницы поиска, `.scene-info` для страницы сцены).
**Для остальных сайтов селектор карточки нужно добавлять и проверять вручную** (самый хрупкий момент).

**Запрос данных.** `getDataFields` (`src/check.ts`) **всегда** запрашивает `tags` и `files` (нужны для
состояний); опции `showTags`/`showFiles` управляют только показом в tooltip (фильтрация в
`formatEntryData`). Не возвращайте фильтрацию полей в запрос — сломаются состояния Tag/NoFile.

**Настройки.** Новые ключи в `OptionKey` (`src/settings/providers.ts`): `tagList`, `tagMark`,
`noFileMark`, `showTagMark`, `showNoFileMark`. UI — в `src/settings/general.ts`
(секции «Symbol» и «Tags»).

## Соглашения по коду

- TypeScript, стиль апстрима: 4 пробела, `let` вместо `const` для локальных переменных, точки с
  запятой не везде — не переформатируйте вендорнутый код без нужды.
- Комментарии в коде — на английском (как в апстриме), документация в `.md` — на русском.
- Новая настройка = ключ в `OptionKey` + значение по умолчанию в соответствующей `default*Options`
  + поле в `general.ts` через фабрики из `elements.ts`.
- Новый сайт = ветка `switch` в `stashChecker.ts` с селекторами и `CheckOptions`;
  домен добавить в `match` в `metadata.js`.
- Сетевые запросы — только через `request()` (`GM.xmlHttpRequest`), не `fetch`: нужен обход CORS.

## Версионирование и публикация

- Версия скрипта берётся из `package.json` → `metadata.js`. Любое изменение кода → поднять `version`
  в `package.json`, иначе Violentmonkey не увидит обновление.
- После правок обязательно `npm run build` — публикуется именно `dist/index.prod.user.js`.
- Каноническая копия — `StashChecker/dist/index.prod.user.js` в репозитории
  (Forgejo → зеркало на GitHub); публикация = коммит и пуш.
  Напоминайте об этом и отражайте факт публикации в `STATUS.md`.
- `updateURL`/`downloadURL` в `metadata.js` указывают на raw-ссылку ветки `main` без хэша ревизии — не менять.

## Проверка изменений

Полноценно проверить можно только вручную в браузере (нужны настоящие endpoint'ы Stash и авторизация
на сайтах) — агент этого сделать не может. Что доступно агенту:

- `npm run build` — типы и сборка.
- Отладка разметки на сохранённых страницах из `temp/`: поднять статический HTTP-сервер над папкой
  (`file:` в браузере заблокирован), открыть страницу и прогнать логику через evaluate по
  `.stashCheckerSymbol[data-target=…]` — так проверялись `.SceneCard` и `.SearchPage-scene`.

Любые правки селекторов помечайте как непроверенные и пишите об этом пользователю.

## Обновление из апстрима

Код вендорнут (не submodule). Апстрим: `https://github.com/timo95/stash-checker`, ветка `master`,
подкаталог `userscript/`. Доработки сосредоточены в `tooltip.ts`, `check.ts`, `dataTypes.ts`,
`stashChecker.ts`, `settings/providers.ts`, `settings/general.ts`, `settings/elements.ts`,
`settings/statistics.ts`, `observer.ts`, `util/nodeUtils.ts` — при подтягивании обновлений
сверяйте именно их.

## Работа с документацией

- `STATUS.md` обновлять в конце содержательной сессии: дата, версия, что сделано, следующие шаги,
  открытые вопросы. Даты — абсолютные (`2026-08-16`).
- README — для пользователя (установка, настройки, состояния), AGENTS — для агента (архитектура,
  как менять код, что проверять). Не дублировать одно в другом.

## Общение

Отвечать пользователю по-русски. Идентификаторы, имена опций и GraphQL-полей — в оригинальном виде.
