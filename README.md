# Violentmonkey Userscripts

Набор userscript-расширений для Violentmonkey/Tampermonkey

## Проекты

### [StashChecker](StashChecker/) v1.3.0

Отмечает сцены, исполнителей и студии, присутствующие в вашей библиотеке Stash, с помощью галочек и цветных рамок карточек. Использует GraphQL-запросы к нескольким endpoint'ам Stash.

**Функции:**
- Поддержка ~60 доменов stash-box сайтов (stashdb.org, fansdb, javstash, pmvstash и др.)
- Интеграция с базами данных (javdb, iwara, iafd, Brazzers и др.)
- Настройка нескольких endpoint'ов Stash
- Статистика и настройки отображения
- Тултипы с подробной информацией

**Установка:**
```bash
cd StashChecker
npm install
npm run build
```

Скомпилированный файл `dist/index.prod.user.js` готов к установке в Violentmonkey.

**Разработка:**
```bash
npm run dev  # Запуск dev-server на :8080 с hot reload
```

### [gallery-scroll-view](gallery-scroll-view/) v1.0.13

Превращает читалки галерей на imhentai-like сайтах и hitomi.la в непрерывную вертикальную прокрутку с зумом, автоскроллом и управлением с клавиатуры.

**Требования:** Violentmonkey/Tampermonkey  
**Установка:** Просто импортируйте файл `gallery-scroll-view.user.js`

### [stashdb-to-stash](stashdb-to-stash/) v1.1.1

Добавляет кнопку "Import to Stash" на страницах сцен на stashdb.org, создавая записи сцен в вашей локальной Stash через GraphQL.

**Требования:** Violentmonkey/Tampermonkey + Stash  
**Установка:** Просто импортируйте файл `stashdb-to-stash.user.js`

## Технологии

- **TypeScript** (ES2024) — основной язык разработки StashChecker
- **Webpack 5** — сборка проекта
- **GreaseMonkey API** (GM.xmlHttpRequest, GM.getValue/setValue и др.)
- **GraphQL** — взаимодействие со Stash API
- **Vanilla JavaScript** — standalone скрипты без зависимостей

## Лицензия

MIT License
