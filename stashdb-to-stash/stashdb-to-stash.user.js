// ==UserScript==
// @name         StashDB → Stash Scene Importer
// @namespace    https://gist.github.com/deaddolfin/11a719ab06fd3b5424e491ff45c56b87
// @version      1.1.1
// @description  Добавляет рядом со ссылками на сцены StashDB кнопку импорта: тянет данные сцены из StashBox (GraphQL) и создаёт сцену в локальном Stash (GraphQL).
// @author       boikov.vv
// @homepageURL  https://gist.github.com/deaddolfin/11a719ab06fd3b5424e491ff45c56b87
// @supportURL   https://gist.github.com/deaddolfin/11a719ab06fd3b5424e491ff45c56b87
// @downloadURL  https://gist.githubusercontent.com/deaddolfin/11a719ab06fd3b5424e491ff45c56b87/raw/stashdb-to-stash.user.js
// @updateURL    https://gist.githubusercontent.com/deaddolfin/11a719ab06fd3b5424e491ff45c56b87/raw/stashdb-to-stash.user.js
// @match        https://stashdb.org/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Настройки
  // ---------------------------------------------------------------------------
  const SETTINGS = {
    stashboxUrl: { def: 'https://stashdb.org/graphql', label: 'StashBox GraphQL URL' },
    stashboxApiKey: { def: '', label: 'StashBox API key' },
    stashUrl: { def: 'http://localhost:9999/graphql', label: 'Stash GraphQL URL' },
    stashApiKey: { def: '', label: 'Stash API key' },
    extraTags: { def: '', label: 'Доп. теги (через запятую)' },
  };

  const getCfg = () => {
    const c = {};
    for (const k of Object.keys(SETTINGS)) c[k] = GM_getValue(k, SETTINGS[k].def);
    return c;
  };

  // Базовый URL Stash без /graphql — для формирования ссылки на созданную сцену.
  const stashBase = (url) => url.replace(/\/graphql\/?$/i, '').replace(/\/+$/, '');

  // ---------------------------------------------------------------------------
  // GraphQL-клиент поверх GM_xmlhttpRequest (обходит CORS)
  // ---------------------------------------------------------------------------
  function gql(endpoint, apiKey, query, variables) {
    return new Promise((resolve, reject) => {
      if (!endpoint) return reject(new Error('Не задан GraphQL URL. Откройте настройки скрипта.'));
      GM_xmlhttpRequest({
        method: 'POST',
        url: endpoint,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(apiKey ? { ApiKey: apiKey } : {}),
        },
        data: JSON.stringify({ query, variables }),
        onload: (res) => {
          if (res.status < 200 || res.status >= 300) {
            return reject(new Error(`HTTP ${res.status}: ${res.responseText?.slice(0, 300)}`));
          }
          let body;
          try {
            body = JSON.parse(res.responseText);
          } catch (e) {
            return reject(new Error('Ответ не является JSON: ' + res.responseText?.slice(0, 200)));
          }
          if (body.errors?.length) {
            return reject(new Error('GraphQL: ' + body.errors.map((e) => e.message).join('; ')));
          }
          resolve(body.data);
        },
        onerror: () => reject(new Error('Сетевая ошибка при запросе к ' + endpoint)),
        ontimeout: () => reject(new Error('Таймаут запроса к ' + endpoint)),
        timeout: 30000,
      });
    });
  }

  const stashbox = (cfg, q, v) => gql(cfg.stashboxUrl, cfg.stashboxApiKey, q, v);
  const stash = (cfg, q, v) => gql(cfg.stashUrl, cfg.stashApiKey, q, v);

  // ---------------------------------------------------------------------------
  // Запросы к StashBox
  // ---------------------------------------------------------------------------
  const FIND_SCENE = `
    query ($id: ID!) {
      findScene(id: $id) {
        id
        title
        details
        release_date
        duration
        director
        code
        urls { url site { name url } }
        images { url width height }
        studio { id name urls { url } }
        performers { as performer { id name gender } }
        tags { id name }
      }
    }`;

  // ---------------------------------------------------------------------------
  // Запросы/мутации к Stash: поиск-или-создание сущностей
  // ---------------------------------------------------------------------------
  const norm = (s) => (s || '').trim().toLowerCase();

  async function resolveStudio(cfg, endpoint, studio) {
    if (!studio) return null;
    const found = await stash(
      cfg,
      `query ($q: String!) { findStudios(filter: {q: $q, per_page: 10}) { studios { id name } } }`,
      { q: studio.name }
    );
    const hit = found.findStudios.studios.find((s) => norm(s.name) === norm(studio.name));
    if (hit) return hit.id;
    const created = await stash(
      cfg,
      `mutation ($input: StudioCreateInput!) { studioCreate(input: $input) { id } }`,
      {
        input: {
          name: studio.name,
          urls: (studio.urls || []).map((u) => u.url),
          stash_ids: [{ endpoint, stash_id: studio.id }],
        },
      }
    );
    return created.studioCreate.id;
  }

  async function resolvePerformer(cfg, endpoint, app) {
    const p = app.performer;
    const found = await stash(
      cfg,
      `query ($q: String!) { findPerformers(filter: {q: $q, per_page: 10}) { performers { id name } } }`,
      { q: p.name }
    );
    const hit = found.findPerformers.performers.find((x) => norm(x.name) === norm(p.name));
    if (hit) return hit.id;
    const created = await stash(
      cfg,
      `mutation ($input: PerformerCreateInput!) { performerCreate(input: $input) { id } }`,
      {
        input: {
          name: p.name,
          ...(p.gender ? { gender: p.gender } : {}),
          stash_ids: [{ endpoint, stash_id: p.id }],
        },
      }
    );
    return created.performerCreate.id;
  }

  async function resolveTag(cfg, tag) {
    const found = await stash(
      cfg,
      `query ($q: String!) { findTags(filter: {q: $q, per_page: 10}) { tags { id name } } }`,
      { q: tag.name }
    );
    const hit = found.findTags.tags.find((t) => norm(t.name) === norm(tag.name));
    if (hit) return hit.id;
    const created = await stash(
      cfg,
      `mutation ($input: TagCreateInput!) { tagCreate(input: $input) { id } }`,
      { input: { name: tag.name } }
    );
    return created.tagCreate.id;
  }

  // Проверка на дубликат по stash_id (endpoint StashBox + id сцены).
  async function findExisting(cfg, endpoint, stashId) {
    const data = await stash(
      cfg,
      `query ($f: SceneFilterType) { findScenes(scene_filter: $f, filter: {per_page: 1}) { scenes { id title } } }`,
      { f: { stash_id_endpoint: { endpoint, stash_id: stashId, modifier: 'EQUALS' } } }
    );
    return data.findScenes.scenes[0] || null;
  }

  // ---------------------------------------------------------------------------
  // Основной поток импорта одной сцены
  // ---------------------------------------------------------------------------
  async function importScene(sceneId, onStatus) {
    const cfg = getCfg();
    const endpoint = cfg.stashboxUrl;

    onStatus('load', 'Запрос сцены из StashBox…');
    const { findScene: sc } = await stashbox(cfg, FIND_SCENE, { id: sceneId });
    if (!sc) throw new Error('Сцена не найдена в StashBox: ' + sceneId);

    onStatus('load', 'Проверка дубликата в Stash…');
    const dup = await findExisting(cfg, endpoint, sc.id);
    if (dup) {
      onStatus('done', 'Уже есть в Stash', `${stashBase(cfg.stashUrl)}/scenes/${dup.id}`);
      return;
    }

    onStatus('load', 'Сопоставление студии/актёров/тегов…');
    const studioId = await resolveStudio(cfg, endpoint, sc.studio).catch(() => null);
    const performerIds = [];
    for (const app of sc.performers || []) {
      const id = await resolvePerformer(cfg, endpoint, app).catch(() => null);
      if (id) performerIds.push(id);
    }
    // Теги сцены + доп. теги из настроек (через запятую), с дедупликацией по имени.
    const tagNames = new Map(); // norm(name) -> name
    for (const t of sc.tags || []) if (t.name) tagNames.set(norm(t.name), t.name);
    for (const raw of (cfg.extraTags || '').split(',')) {
      const name = raw.trim();
      if (name) tagNames.set(norm(name), name);
    }
    const tagIds = [];
    for (const name of tagNames.values()) {
      const id = await resolveTag(cfg, { name }).catch(() => null);
      if (id) tagIds.push(id);
    }

    onStatus('load', 'Создание сцены в Stash…');
    const input = {
      title: sc.title || undefined,
      details: sc.details || undefined,
      date: sc.release_date || undefined,
      director: sc.director || undefined,
      code: sc.code || undefined,
      urls: (sc.urls || []).map((u) => u.url),
      cover_image: sc.images?.[0]?.url || undefined,
      studio_id: studioId || undefined,
      performer_ids: performerIds,
      tag_ids: tagIds,
      stash_ids: [{ endpoint, stash_id: sc.id }],
    };
    const created = await stash(
      cfg,
      `mutation ($input: SceneCreateInput!) { sceneCreate(input: $input) { id title } }`,
      { input }
    );
    const newId = created.sceneCreate.id;
    onStatus('done', 'Создано в Stash', `${stashBase(cfg.stashUrl)}/scenes/${newId}`);
  }

  // ---------------------------------------------------------------------------
  // UI: кнопка рядом со ссылкой
  // ---------------------------------------------------------------------------
  const SCENE_RE = /\/scenes\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

  function makeButton(sceneId) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'vm-stash-import-btn';
    btn.textContent = '→ Stash';
    btn.title = 'Импортировать сцену в Stash';

    const status = document.createElement('span');
    status.className = 'vm-stash-import-status';

    const setStatus = (state, msg, link) => {
      status.className = 'vm-stash-import-status vm-' + state;
      if (link) {
        status.innerHTML = '';
        const a = document.createElement('a');
        a.href = link;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = msg + ' ↗';
        status.appendChild(a);
      } else {
        status.textContent = msg;
      }
    };

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      btn.disabled = true;
      try {
        await importScene(sceneId, setStatus);
      } catch (err) {
        setStatus('error', 'Ошибка: ' + err.message);
        console.error('[StashDB→Stash]', err);
      } finally {
        btn.disabled = false;
      }
    });

    const wrap = document.createElement('span');
    wrap.className = 'vm-stash-import-wrap';
    wrap.appendChild(btn);
    wrap.appendChild(status);
    return wrap;
  }

  function scan(root) {
    const scope = root instanceof Element ? root : document;
    const links = scope.querySelectorAll('a[href*="/scenes/"]:not([data-vm-stash-done])');
    for (const link of links) {
      const m = link.getAttribute('href')?.match(SCENE_RE);
      if (!m) continue;

      // В карточке сцены две ссылки на одну сцену (превью + заголовок) —
      // ставим одну кнопку на карточку, после заголовка.
      const card = link.closest('.SceneCard, .card');
      if (card) {
        // Помечаем все ссылки сцены в карточке обработанными, чтобы не плодить кнопки.
        card
          .querySelectorAll('a[href*="/scenes/"]')
          .forEach((a) => a.setAttribute('data-vm-stash-done', '1'));
        if (card.querySelector('.vm-stash-import-wrap')) continue; // кнопка уже есть
        const target = card.querySelector('a[href*="/scenes/"]:not(.SceneCard-image)') || link;
        target.insertAdjacentElement('afterend', makeButton(m[1]));
        continue;
      }

      // Одиночная ссылка вне карточки — прежнее поведение.
      link.setAttribute('data-vm-stash-done', '1');
      link.insertAdjacentElement('afterend', makeButton(m[1]));
    }
  }

  // Страница самой сцены: ссылки нет — кнопку ставим после заголовка.
  function scanScenePage() {
    const m = location.pathname.match(SCENE_RE);
    if (!m) return;
    const sceneId = m[1];

    // Заголовок страницы сцены: пробуем наиболее вероятные варианты по порядку.
    const heading =
      document.querySelector('main h1, main h3, .NarrowPage h3, h1') ||
      document.querySelector('h1, h3');
    if (!heading) return; // React ещё не отрисовал — MutationObserver вызовет повторно.

    const existing = heading.nextElementSibling;
    const isOurBtn = existing?.classList?.contains('vm-stash-import-wrap');

    // Кнопка уже стоит для этой же сцены — ничего не делаем.
    if (isOurBtn && heading.getAttribute('data-vm-stash-scene') === sceneId) return;

    // SPA перешёл на другую сцену — убираем старую кнопку.
    if (isOurBtn) existing.remove();

    heading.setAttribute('data-vm-stash-scene', sceneId);
    heading.insertAdjacentElement('afterend', makeButton(sceneId));
  }

  const scanAll = () => {
    scan(document);
    scanScenePage();
  };

  // SPA: страница перерисовывается — наблюдаем за DOM с дебаунсом.
  let scanTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanAll, 300);
  });

  // ---------------------------------------------------------------------------
  // UI: модальное окно настроек
  // ---------------------------------------------------------------------------
  function openSettings() {
    const cfg = getCfg();
    const overlay = document.createElement('div');
    overlay.className = 'vm-stash-overlay';

    const box = document.createElement('div');
    box.className = 'vm-stash-modal';
    box.innerHTML = '<h2>Настройки импорта в Stash</h2>';

    const inputs = {};
    for (const k of Object.keys(SETTINGS)) {
      const row = document.createElement('label');
      row.className = 'vm-stash-row';
      row.textContent = SETTINGS[k].label;
      const inp = document.createElement('input');
      inp.type = k.toLowerCase().includes('key') ? 'password' : 'text';
      inp.value = cfg[k];
      inp.placeholder = SETTINGS[k].def;
      inputs[k] = inp;
      row.appendChild(inp);
      box.appendChild(row);
    }

    const actions = document.createElement('div');
    actions.className = 'vm-stash-actions';
    const save = document.createElement('button');
    save.textContent = 'Сохранить';
    save.className = 'vm-stash-save';
    save.addEventListener('click', () => {
      for (const k of Object.keys(SETTINGS)) GM_setValue(k, inputs[k].value.trim());
      overlay.remove();
    });
    const cancel = document.createElement('button');
    cancel.textContent = 'Отмена';
    cancel.addEventListener('click', () => overlay.remove());
    actions.appendChild(cancel);
    actions.appendChild(save);
    box.appendChild(actions);

    overlay.appendChild(box);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });
    document.body.appendChild(overlay);
  }

  // ---------------------------------------------------------------------------
  // Стили
  // ---------------------------------------------------------------------------
  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .vm-stash-import-wrap { display: inline-flex; align-items: center; gap: 6px; margin-left: 6px; vertical-align: middle; }
      .vm-stash-import-btn { font-size: 11px; line-height: 1; padding: 3px 7px; border-radius: 4px; border: 1px solid #3b82f6; background: #3b82f6; color: #fff; cursor: pointer; white-space: nowrap; }
      .vm-stash-import-btn:hover { background: #2563eb; }
      .vm-stash-import-btn:disabled { opacity: .6; cursor: default; }
      .vm-stash-import-status { font-size: 11px; }
      .vm-stash-import-status.vm-load { color: #a16207; }
      .vm-stash-import-status.vm-done a { color: #16a34a; text-decoration: none; }
      .vm-stash-import-status.vm-error { color: #dc2626; }
      .vm-stash-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 999999; display: flex; align-items: center; justify-content: center; }
      .vm-stash-modal { background: #1f2937; color: #f3f4f6; width: 420px; max-width: 90vw; padding: 20px; border-radius: 8px; font-family: sans-serif; box-shadow: 0 10px 40px rgba(0,0,0,.5); }
      .vm-stash-modal h2 { margin: 0 0 14px; font-size: 16px; }
      .vm-stash-row { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; font-size: 12px; }
      .vm-stash-row input { padding: 7px 9px; border-radius: 4px; border: 1px solid #4b5563; background: #111827; color: #f3f4f6; font-size: 13px; }
      .vm-stash-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
      .vm-stash-actions button { padding: 7px 14px; border-radius: 4px; border: 1px solid #4b5563; background: #374151; color: #f3f4f6; cursor: pointer; font-size: 13px; }
      .vm-stash-actions .vm-stash-save { background: #3b82f6; border-color: #3b82f6; }
    `;
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------------------
  // Запуск
  // ---------------------------------------------------------------------------
  injectStyles();
  GM_registerMenuCommand('⚙️ Настройки импорта в Stash', openSettings);
  scanAll();
  observer.observe(document.body, { childList: true, subtree: true });
})();
