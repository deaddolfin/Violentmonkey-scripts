# Send to Telegram

Userscript для [Violentmonkey](https://violentmonkey.github.io/) (совместим с Tampermonkey):
отправляет в Telegram через Bot API картинку, выбранную кликом, ссылку страницы или выделенный текст.
Замена браузерному аддону «Send to Telegram», у которого перестали доходить сообщения.

Два варианта скрипта — выберите один (у каждого свои настройки, ставить оба незачем):

| Вариант | Файл | `@connect` | Как отправляет картинку |
| --- | --- | --- | --- |
| А — строгий | [`send-to-telegram.user.js`](send-to-telegram.user.js) | только `api.telegram.org` | передаёт Telegram URL, тот скачивает сам |
| Б — с резервом | [`send-to-telegram-fallback.user.js`](send-to-telegram-fallback.user.js) | `api.telegram.org` и `*` | сначала URL; если Telegram не смог — браузер качает файл и загружает сам |

Источники авто-обновления:
- А: <https://raw.githubusercontent.com/deaddolfin/Violentmonkey-scripts/main/send-to-telegram/send-to-telegram.user.js>
- Б: <https://raw.githubusercontent.com/deaddolfin/Violentmonkey-scripts/main/send-to-telegram/send-to-telegram-fallback.user.js>

Текущая версия обоих: **1.0.0**

## Установка

1. Установите Violentmonkey, откройте raw-ссылку нужного варианта — Violentmonkey предложит установку.
2. Создайте бота у [@BotFather](https://t.me/BotFather), напишите ему (или добавьте в чат/канал админом)
   и узнайте `chat_id`.
3. Меню Violentmonkey → **«Настройки: токен бота и Chat ID»**.

Токен и Chat ID хранятся в storage Violentmonkey (`GM_setValue`), в код и репозиторий не попадают.

## Использование

Меню Violentmonkey на любой странице:

- **Отправить картинку (режим выбора)** — картинки под курсором подсвечиваются, клик отправляет,
  `Esc` отменяет. То же по `Alt+Shift+S`.
- **Отправить ссылку страницы** — заголовок и URL.
- **Отправить выделенный текст** — выделение и URL страницы.
- **Переключить: картинки файлом без сжатия** — `sendDocument` вместо `sendPhoto`.
- **Переключить: подпись со ссылкой на источник**.

`sendPhoto` используется для JPEG/PNG; WebP, AVIF, GIF и крупные файлы уходят через `sendDocument`.

## Ограничения

- Вариант А не отправит картинки за авторизацией, с защитой от хотлинка, а также `blob:`/`data:` —
  Telegram не может их скачать. Лимиты URL-пути: фото 5 МБ, файл 20 МБ.
- Вариант Б в таких случаях качает файл сам (с куками и `Referer` страницы), лимиты: фото 10 МБ, файл 50 МБ.
  Платой за это служит `@connect *` — скрипт может обращаться к любому хосту.
- Нет пункта в контекстном меню браузера и скриншота вкладки — userscript до этого не дотянуться.
- Скрипт включён на всех сайтах (`@match *://*/*`), в iframe не работает (`@noframes`).
- Загрузка файла в Telegram идёт одним запросом: на VPN, рвущем канал после 30 секунд тишины,
  очень крупные файлы могут не дойти.

## Разработка

Сборки нет — два самодостаточных файла без зависимостей.

```powershell
node --check send-to-telegram.user.js
node --check send-to-telegram-fallback.user.js
```

Подробности — в [AGENTS.md](AGENTS.md), состояние работ — в [STATUS.md](STATUS.md).
