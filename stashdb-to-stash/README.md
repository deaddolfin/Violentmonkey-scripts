# StashDB → Stash Scene Importer

Userscript для [Violentmonkey](https://violentmonkey.github.io/) (совместим с Tampermonkey),
который добавляет на сайте [stashdb.org](https://stashdb.org/) кнопку **«→ Stash»** рядом
со ссылками на сцены. По нажатию скрипт забирает данные сцены из StashBox через GraphQL
и создаёт соответствующую сцену в вашем локальном [Stash](https://github.com/stashapp/stash).

- Файл скрипта: [`stashdb-to-stash.user.js`](stashdb-to-stash.user.js)
- Источник авто-обновления: <https://raw.githubusercontent.com/deaddolfin/Violentmonkey-scripts/main/stashdb-to-stash/stashdb-to-stash.user.js>
- Текущая версия: **1.1.1**

## Установка

1. Установите расширение Violentmonkey в браузер.
2. Откройте
   [raw-ссылку скрипта](https://raw.githubusercontent.com/deaddolfin/Violentmonkey-scripts/main/stashdb-to-stash/stashdb-to-stash.user.js) —
   Violentmonkey предложит установку.
   Либо: дашборд Violentmonkey → «Установить из файла» → выбрать локальный `stashdb-to-stash.user.js`.
3. Обновления подтягиваются автоматически из репозитория (`@updateURL`/`@downloadURL`).

## Настройка

Меню Violentmonkey (иконка расширения на странице stashdb.org) → **«⚙️ Настройки импорта в Stash»**.

| Параметр | По умолчанию | Назначение |
| --- | --- | --- |
| StashBox GraphQL URL | `https://stashdb.org/graphql` | Источник данных о сцене |
| StashBox API key | — | Ключ из профиля на stashdb.org |
| Stash GraphQL URL | `http://localhost:9999/graphql` | Ваш инстанс Stash |
| Stash API key | — | Ключ из Stash → Settings → Security |
| Доп. теги | — | Список через запятую, добавляется к тегам каждой импортируемой сцены |

Настройки хранятся в storage Violentmonkey (`GM_setValue`), поля с ключами вводятся как `password`.
API-ключи передаются в заголовке `ApiKey`.

## Как работает

Кнопка появляется в трёх местах:

- рядом со ссылками `/scenes/<uuid>` в списках;
- одна кнопка на карточку сцены (`.SceneCard` / `.card`) — чтобы не дублироваться на превью и заголовке;
- на самой странице сцены — после заголовка, с корректной заменой при SPA-переходе между сценами.

Поток импорта (`importScene`):

1. `findScene(id)` в StashBox — title, details, release_date, director, code, urls, images,
   studio, performers, tags.
2. Проверка дубликата в Stash по `stash_id_endpoint` (endpoint StashBox + id сцены).
   Если сцена уже есть — показывается ссылка на неё, ничего не создаётся.
3. Сопоставление сущностей в Stash по схеме «найти-или-создать»: студия, актёры, теги.
   При создании студии и актёра проставляется `stash_ids`, чтобы связь с StashBox сохранилась.
4. `sceneCreate` — создание сцены; обложка передаётся URL-ом (`cover_image`), Stash скачивает её сам.

Статус выводится прямо у кнопки: жёлтый — в работе, зелёный со ссылкой — готово, красный — ошибка
(подробности дублируются в консоль с префиксом `[StashDB→Stash]`).

CORS обходится через `GM_xmlhttpRequest` (`@connect *`), таймаут запроса — 30 секунд.

## Ограничения

- Сопоставление студий, актёров и тегов идёт по **точному совпадению имени** без учёта регистра.
  Тёзки могут быть привязаны неверно.
- Обложка подтягивается только если у инстанса Stash есть доступ в интернет.
- `@connect *` разрешает запросы к любому хосту — необходимо, потому что адрес вашего Stash
  задаётся в настройках и заранее неизвестен.
- Селектор заголовка на странице сцены подобран эвристически — при смене вёрстки stashdb.org
  кнопку на странице сцены может «унести» не туда (правится в `scanScenePage()`).

## Разработка

Сборки нет — это один самодостаточный файл без зависимостей.

```powershell
node --check stashdb-to-stash.user.js   # единственная автоматическая проверка
```

При изменении кода поднимайте `@version` в шапке и пушьте файл в репозиторий, иначе авто-обновление
не сработает. Подробности — в [AGENTS.md](AGENTS.md), текущее состояние работ — в [STATUS.md](STATUS.md).
