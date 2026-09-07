// ==UserScript==
// @name         Gallery Scroll View (imhentai / hentaiera / hentaienvy / hitomi)
// @namespace    https://github.com/deaddolfin/Violentmonkey-scripts/tree/main/gallery-scroll-view
// @version      1.0.14
// @description  Свиток-просмотр галереи: вертикальная лента из ±10 страниц вокруг текущей. Плавающая панель с зумом, скоростью, автопрокруткой и кнопками ↑/↓. Управление с клавиатуры (стрелки, PageUp/Down, Home/End, +/− зум, * // скорость, пробел, Esc). Кнопка открытия встраивается на reader-странице. Поддержка imhentai/hentaiera/hentaienvy и hitomi.la.
// @author       DeadDolfin
// @match        https://imhentai.xxx/view/*
// @match        https://hentaiera.com/view/*
// @match        https://hentaienvy.com/g/*
// @match        https://hitomi.la/reader/*
// @run-at       document-idle
// @grant        none
// @noframes
// @homepageURL  https://github.com/deaddolfin/Violentmonkey-scripts/tree/main/gallery-scroll-view
// @supportURL   https://github.com/deaddolfin/Violentmonkey-scripts/issues
// @downloadURL  https://raw.githubusercontent.com/deaddolfin/Violentmonkey-scripts/main/gallery-scroll-view/gallery-scroll-view.user.js
// @updateURL    https://raw.githubusercontent.com/deaddolfin/Violentmonkey-scripts/main/gallery-scroll-view/gallery-scroll-view.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ─── Настройки ──────────────────────────────────────────────────────────────
  const IMAGES_BEFORE = 10;          // сколько страниц подгружать вверх от текущей
  const IMAGES_AFTER = 10;           // сколько страниц подгружать вниз от текущей
  const TOP_OFFSET = 56;             // высота верхней панели (для якорной прокрутки)
  const DEFAULT_WIDTH = '90%';       // базовая ширина ленты (значение селектора Width)
  const WIDTH_OPTIONS = ['100%', '90%', '75%', '60%', '1200px', '900px', '600px'];
  const DEFAULT_ZOOM = 0;            // прибавка зума в % (итог = Width + Zoom); сбрасывается при смене Width
  const DEFAULT_SPEED = 0.6;         // скорость прокрутки (0.30–2.20)
  const SPEED_MIN = 0.30;            // границы ползунка Speed (кратны шагу 0.05)
  const SPEED_MAX = 2.20;
  const SPEED_STEP = 0.05;
  // Пикселей за кадр на единицу скорости. Единый множитель для удержания кнопок/стрелок
  // и автопрокрутки — чтобы при одном значении Speed скорость совпадала.
  const SCROLL_SPEED_FACTOR = 8;

  // Первый символ записи g_th кодирует расширение файла страницы.
  const EXT_MAP = { j: 'jpg', p: 'png', g: 'gif', w: 'webp', b: 'bmp' };

  // ─── Сохранение настроек панели (localStorage) ───────────────────────────────
  // Сохраняем позицию панели, её состояние (свёрнута/скрыта) и скорость прокрутки.
  const STORAGE_KEY = 'gsv-panel-state';

  function loadState() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  let stateCache = loadState();

  function saveState(patch) {
    stateCache = Object.assign({}, stateCache, patch);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stateCache));
    } catch (e) {
      /* хранилище недоступно (приватный режим и т.п.) — тихо игнорируем */
    }
  }

  // ─── Разбор данных reader-страницы ───────────────────────────────────────────

  // Reader-картинка: #gimg (imhentai/hentaiera) или #fimg (hentaienvy),
  // с запасным вариантом по классу image_N и числовому пути.
  function getReaderImage() {
    return (
      document.getElementById('gimg') ||
      document.getElementById('fimg') ||
      document.querySelector('img[class*="image_"]') ||
      null
    );
  }

  function getReaderImageSrc(img) {
    if (!img) return null;
    return img.currentSrc || img.src || img.getAttribute('data-src') || null;
  }

  // Базовый CDN-путь и расширение текущей страницы из src вида
  // https://m11.host/032/abc/5.webp  →  base="https://m11.host/032/abc/", page=5, ext="webp"
  function parseImageSrc(src) {
    if (!src) return null;
    const m = src.match(/^(.*\/)(\d+)\.([a-z0-9]+)(?:\?.*)?$/i);
    if (!m) return null;
    return { base: m[1], page: Number.parseInt(m[2], 10), ext: m[3].toLowerCase() };
  }

  function getTotalPages(gth) {
    const el = document.getElementById('pages') || document.getElementById('load_pages');
    const fromInput = el ? Number.parseInt(el.value, 10) : NaN;
    if (Number.isFinite(fromInput) && fromInput > 0) return fromInput;
    // Запасной вариант — число ключей в g_th.
    if (gth) {
      const keys = Object.keys(gth).map((k) => Number.parseInt(k, 10)).filter(Number.isFinite);
      if (keys.length) return Math.max(...keys);
    }
    return null;
  }

  // Текущая страница из URL: /view/{id}/{page}/ или /g/{id}/{page}/
  function getCurrentPageFromUrl() {
    const m = window.location.pathname.match(/\/(?:view|g)\/\d+\/(\d+)/);
    return m ? Number.parseInt(m[1], 10) : null;
  }

  // g_th = $.parseJSON('{"1":"j,560,420","2":"w,1280,1791",...}') — словарь страница→тип,ширина,высота.
  function parseGth() {
    const scripts = document.querySelectorAll('script:not([src])');
    for (const s of scripts) {
      const text = s.textContent;
      if (!text || text.indexOf('g_th') === -1) continue;
      const m = text.match(/g_th\s*=\s*\$\.parseJSON\(\s*'(\{[\s\S]*?\})'\s*\)/);
      if (m) {
        try {
          return JSON.parse(m[1]);
        } catch (e) {
          /* игнорируем повреждённый словарь */
        }
      }
    }
    return null;
  }

  function extForPage(n, gth, fallbackExt) {
    const meta = gth && gth[String(n)];
    if (meta) {
      const code = String(meta).split(',')[0];
      if (EXT_MAP[code]) return EXT_MAP[code];
    }
    return fallbackExt || 'jpg';
  }

  function windowRange(current, total) {
    return {
      start: Math.max(1, current - IMAGES_BEFORE),
      end: Math.min(total, current + IMAGES_AFTER),
    };
  }

  // Размеры страницы из g_th (imhentai): запись "тип,ширина,высота".
  function dimsForPage(n, gth) {
    const meta = gth && gth[String(n)];
    if (!meta) return {};
    const parts = String(meta).split(',');
    const width = Number.parseInt(parts[1], 10);
    const height = Number.parseInt(parts[2], 10);
    return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : {};
  }

  // Адаптеры отдают контекст { total, current, makeItem(page) }, где makeItem
  // строит данные одной страницы по требованию — это позволяет подгружать
  // новые страницы при прокрутке (бесконечная лента), а не фиксированное окно.

  // ── Адаптер: семейство imhentai (imhentai.xxx / hentaiera.com / hentaienvy.com) ──
  const imhentaiAdapter = {
    ready() {
      return !!getReaderImage();
    },
    getContext() {
      const parsed = parseImageSrc(getReaderImageSrc(getReaderImage()));
      if (!parsed) return null;
      const gth = parseGth();
      const total = getTotalPages(gth) || parsed.page;
      const current = getCurrentPageFromUrl() || parsed.page;
      return {
        total,
        current,
        makeItem(n) {
          const dims = dimsForPage(n, gth);
          return {
            page: n,
            url: parsed.base + n + '.' + extForPage(n, gth, parsed.ext),
            allowExtFallback: true,
            referrerPolicy: 'no-referrer', // CDN imhentai отдаёт без реферера
            width: dims.width,
            height: dims.height,
          };
        },
      };
    },
  };

  // ── Адаптер: hitomi.la (другой движок) ──────────────────────────────────────
  // galleryinfo и построитель URL уже загружены страницей: window.galleryinfo
  // и window.make_image_element. Переиспользуем их — устойчиво к ротации gg.js.
  // (Требует @grant none — userscript исполняется в контексте страницы.)
  function getHitomiCurrentPage(total) {
    const m = window.location.hash.match(/#(\d+)/);
    const n = m ? Number.parseInt(m[1], 10) : 1;
    return Math.min(Math.max(1, Number.isFinite(n) ? n : 1), total || 1);
  }

  const hitomiAdapter = {
    ready() {
      const w = window;
      return !!(w.galleryinfo && Array.isArray(w.galleryinfo.files)
        && w.galleryinfo.files.length && typeof w.make_image_element === 'function');
    },
    getContext() {
      const w = window;
      if (!this.ready()) return null;
      const files = w.galleryinfo.files;
      const total = files.length;
      const id = (window.location.pathname.match(/(\d+)\.html/) || [])[1];
      if (!id) return null;
      const current = getHitomiCurrentPage(total);
      return {
        total,
        current,
        makeItem(n) {
          const file = files[n - 1];
          if (!file) return null;
          let url = null;
          try {
            // make_image_element строит <picture> с верными поддоменами; берём webp <img>.
            url = w.make_image_element(id, file).querySelector('img')?.src || null;
          } catch (e) {
            /* построитель сайта недоступен для этого файла */
          }
          if (!url) return null;
          return { page: n, url, width: file.width, height: file.height };
        },
      };
    },
  };

  function getAdapter() {
    const host = window.location.hostname;
    if (host === 'hitomi.la') return hitomiAdapter;
    if (host === 'imhentai.xxx' || host === 'hentaiera.com' || host === 'hentaienvy.com') {
      return imhentaiAdapter;
    }
    return null;
  }

  // ─── Оверлей со свитком ───────────────────────────────────────────────────────

  let overlay = null;
  let keydownHandler = null; // обработчики клавиатуры активного оверлея (для снятия при закрытии)
  let keyupHandler = null;

  function closeScrollView() {
    overlay?.remove();
    overlay = null;
    if (keydownHandler) {
      document.removeEventListener('keydown', keydownHandler);
      keydownHandler = null;
    }
    if (keyupHandler) {
      document.removeEventListener('keyup', keyupHandler);
      keyupHandler = null;
    }
    document.body.style.overflow = '';
  }

  function openScrollView(context) {
    closeScrollView();
    const { total, current, makeItem } = context;

    document.body.style.overflow = 'hidden';

    overlay = document.createElement('div');
    overlay.id = 'gsv-overlay';
    Object.assign(overlay.style, {
      position: 'fixed',
      inset: '0',
      background: '#111',
      zIndex: '2147483600',
      overflowY: 'auto',
      overflowX: 'hidden',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      touchAction: 'none',
      cursor: 'grab',
      // Отключаем встроенный scroll anchoring браузера: при подгрузке/удалении
      // строк сверху мы компенсируем scrollTop вручную (prependPrev/trimFar),
      // а параллельная компенсация браузера вызывала «отскок» при быстром скролле.
      overflowAnchor: 'none',
    });

    // ── Верхняя панель ─────────────────────────────────────────────────────────
    const bar = document.createElement('div');
    Object.assign(bar.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      right: '0',
      width: '100%',
      background: 'rgba(20,20,20,0.92)',
      padding: '8px 14px',
      display: 'flex',
      flexWrap: 'wrap',
      gap: '6px 10px',
      alignItems: 'center',
      zIndex: '2147483601',
      boxSizing: 'border-box',
      borderBottom: '1px solid #333',
      font: '13px/1.2 sans-serif',
    });

    const counter = document.createElement('span');
    counter.style.cssText = 'color:#ccc;flex:1 1 auto;min-width:120px;';
    bar.appendChild(counter);

    // Селектор Width — базовая ширина ленты, на которую умножается Zoom.
    const widthWrap = document.createElement('div');
    widthWrap.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const widthLabel = document.createElement('label');
    widthLabel.textContent = 'Width:';
    widthLabel.style.cssText = 'color:#aaa;font-size:12px;';
    const widthSelect = document.createElement('select');
    widthSelect.style.cssText = 'background:#333;color:#fff;border:1px solid #555;border-radius:3px;padding:3px 6px;font-size:12px;';
    WIDTH_OPTIONS.forEach((v) => {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      if (v === DEFAULT_WIDTH) opt.selected = true;
      widthSelect.appendChild(opt);
    });
    widthSelect.onchange = () => {
      zoom = 0;
      if (zoomInput) zoomInput.value = '0';
      applyZoom();
    };
    widthWrap.appendChild(widthLabel);
    widthWrap.appendChild(widthSelect);
    bar.appendChild(widthWrap);

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕ Закрыть';
    closeBtn.style.cssText = 'background:#444;color:#fff;border:none;border-radius:4px;padding:6px 12px;cursor:pointer;font-size:13px;';
    closeBtn.onclick = closeScrollView;

    const panelToggleBtn = document.createElement('button');
    panelToggleBtn.type = 'button';
    panelToggleBtn.textContent = '◫ Панель';
    panelToggleBtn.title = 'Показать/скрыть панель управления';
    panelToggleBtn.style.cssText = 'background:#444;color:#fff;border:none;border-radius:4px;padding:6px 12px;cursor:pointer;font-size:13px;';

    bar.appendChild(panelToggleBtn);
    bar.appendChild(closeBtn);
    overlay.appendChild(bar);

    // ── Контейнер изображений ────────────────────────────────────────────────
    const imgContainer = document.createElement('div');
    Object.assign(imgContainer.style, {
      width: DEFAULT_WIDTH,
      padding: TOP_OFFSET + 'px 0 40px',
      boxSizing: 'border-box',
    });

    const rowByPage = new Map();

    function createRow(item) {
      const wrapper = document.createElement('div');
      wrapper.dataset.page = String(item.page);
      Object.assign(wrapper.style, {
        width: '100%',
        marginBottom: '2px',
        position: 'relative',
        scrollMarginTop: TOP_OFFSET + 'px',
      });

      const isCurrent = item.page === current;
      const badge = document.createElement('span');
      badge.textContent = item.page + (isCurrent ? ' ◀' : '');
      Object.assign(badge.style, {
        position: 'absolute',
        top: '4px',
        left: '4px',
        background: isCurrent ? 'rgba(255,159,67,0.9)' : 'rgba(0,0,0,0.55)',
        color: isCurrent ? '#111' : '#ddd',
        fontSize: '11px',
        fontWeight: '600',
        padding: '1px 6px',
        borderRadius: '3px',
        zIndex: '2',
        userSelect: 'none',
      });
      wrapper.appendChild(badge);

      const el = document.createElement('img');
      el.alt = 'Страница ' + item.page;
      // Грузим всё окно сразу (eager), чтобы при быстрой прокрутке не было «дырок».
      el.loading = 'eager';
      el.decoding = 'async';
      el.draggable = false;
      // hitomi требует referer своего домена — там referrerPolicy не задаём.
      if (item.referrerPolicy) el.referrerPolicy = item.referrerPolicy;
      const elStyle = {
        width: '100%',
        height: 'auto',
        display: 'block',
        background: '#1a1a1a',
      };
      // Резервируем точную высоту строки по реальным размерам (если известны) —
      // иначе при загрузке высота меняется и скролл «прыгает».
      if (item.width && item.height) {
        elStyle.aspectRatio = `${item.width} / ${item.height}`;
      } else {
        elStyle.minHeight = '120px';
      }
      Object.assign(el.style, elStyle);

      // Загрузка с ретраями и плейсхолдером при окончательной неудаче.
      const MAX_RETRIES = 2;
      let url = item.url;
      let triedExts = [];
      let retries = 0;

      function showPlaceholder() {
        const ph = document.createElement('div');
        ph.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;width:100%;box-sizing:border-box;padding:16px;background:#1a1a1a;color:#bbb;font:14px/1.3 sans-serif;text-align:center;';
        if (item.width && item.height) ph.style.aspectRatio = `${item.width} / ${item.height}`;
        else ph.style.minHeight = '240px';
        const txt = document.createElement('div');
        txt.textContent = `Страница ${item.page} не загрузилась`;
        const retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.textContent = '↻ Повторить';
        retryBtn.style.cssText = 'background:#444;color:#fff;border:none;border-radius:6px;padding:8px 14px;cursor:pointer;font-size:13px;';
        retryBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
        retryBtn.onclick = () => {
          url = item.url;
          triedExts = [];
          retries = 0;
          ph.replaceWith(el);
          el.src = url;
        };
        ph.appendChild(txt);
        ph.appendChild(retryBtn);
        el.replaceWith(ph);
      }

      el.onerror = () => {
        // 1) imhentai: перебор расширений, если текущее не подошло.
        if (item.allowExtFallback) {
          const candidates = ['jpg', 'png', 'webp', 'gif'].filter((x) => !triedExts.includes(x));
          if (candidates.length) {
            triedExts.push(candidates[0]);
            url = item.url.replace(/\.[a-z0-9]+$/i, '.' + candidates[0]);
            el.src = url;
            return;
          }
        }
        // 2) повтор того же URL (сетевые сбои / троттлинг CDN при быстром скролле).
        if (retries < MAX_RETRIES) {
          retries += 1;
          el.removeAttribute('src');
          window.setTimeout(() => { if (el.isConnected) el.src = url; }, 350 * retries);
          return;
        }
        // 3) окончательная неудача — плейсхолдер с кнопкой повтора.
        showPlaceholder();
      };

      el.src = url;

      wrapper.appendChild(el);
      rowByPage.set(item.page, wrapper);
      return wrapper;
    }

    // Начальное окно [current-BEFORE .. current+AFTER]; дальше лента растёт при скролле.
    const initial = windowRange(current, total);
    let loadedStart = initial.start;
    let loadedEnd = initial.end;
    for (let n = loadedStart; n <= loadedEnd; n += 1) {
      const item = makeItem(n);
      if (item) imgContainer.appendChild(createRow(item));
    }

    let viewPage = current; // страница, которую сейчас видно (обновляется при скролле)
    function updateCounter() {
      counter.textContent = `Страница ${viewPage} / ${total}`;
    }
    updateCounter();

    overlay.appendChild(imgContainer);

    // ── Плавающая панель управления ────────────────────────────────────────────
    let zoom = DEFAULT_ZOOM;
    let speed = Number.isFinite(stateCache.speed) ? stateCache.speed : DEFAULT_SPEED;

    // Итоговая ширина = базовая ширина (Width) + прибавка Zoom (в %).
    // Для %-ширины: base% + zoom%. Для px-ширины: base + zoom% от base.
    // При выходе за ширину окна включается горизонтальная прокрутка.
    function applyZoom() {
      const widthValue = widthSelect.value || DEFAULT_WIDTH;
      let overflowsViewport = false;

      if (widthValue.endsWith('%')) {
        const basePercent = Number.parseFloat(widthValue) || 100;
        const effectivePercent = basePercent + zoom;
        imgContainer.style.width = effectivePercent + '%';
        imgContainer.style.maxWidth = 'none';
        overflowsViewport = effectivePercent > 100;
      } else {
        const basePx = Number.parseFloat(widthValue) || 900;
        const effectivePx = Math.round(basePx * (1 + zoom / 100));
        imgContainer.style.width = effectivePx + 'px';
        imgContainer.style.maxWidth = 'none';
        overflowsViewport = effectivePx > (overlay.clientWidth || window.innerWidth || 0);
      }

      if (overflowsViewport) {
        overlay.style.overflowX = 'auto';
        overlay.style.alignItems = 'flex-start';
      } else {
        overlay.style.overflowX = 'hidden';
        overlay.style.alignItems = 'center';
        overlay.scrollLeft = 0;
      }
    }

    const scrollPanel = document.createElement('div');
    scrollPanel.id = 'gsv-scroll-panel';
    Object.assign(scrollPanel.style, {
      position: 'fixed',
      right: '18px',
      bottom: '90px',
      zIndex: '2147483602',
      background: 'rgba(24,24,24,0.96)',
      border: '1px solid #444',
      borderRadius: '8px',
      boxShadow: '0 6px 18px rgba(0,0,0,0.5)',
      color: '#e5e5e5',
      userSelect: 'none',
      touchAction: 'none',
      width: 'max-content',
      maxWidth: 'calc(100vw - 24px)',
      overflow: 'hidden',
      font: '12px/1.2 sans-serif',
    });

    const panelHeader = document.createElement('div');
    Object.assign(panelHeader.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      padding: '5px 8px',
      background: 'rgba(50,50,50,0.95)',
      cursor: 'grab',
      fontWeight: '600',
    });
    const panelTitle = document.createElement('span');
    panelTitle.textContent = 'Свиток';
    const panelCollapseBtn = document.createElement('button');
    panelCollapseBtn.type = 'button';
    panelCollapseBtn.textContent = '−';
    panelCollapseBtn.title = 'Свернуть/развернуть';
    panelCollapseBtn.style.cssText = 'background:#444;color:#fff;border:none;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:14px;line-height:1;margin-left:auto;';
    panelHeader.appendChild(panelTitle);
    panelHeader.appendChild(panelCollapseBtn);

    const panelBody = document.createElement('div');
    panelBody.style.cssText = 'display:flex;gap:8px;padding:8px;align-items:stretch;';

    function makeSlider(labelText, min, max, step, value, color, onInput) {
      const col = document.createElement('div');
      col.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:4px;';
      const label = document.createElement('span');
      label.textContent = labelText;
      label.style.cssText = 'color:#aaa;font-size:11px;';
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(value);
      input.style.cssText = `width:18px;height:90px;-webkit-appearance:slider-vertical;writing-mode:bt-lr;accent-color:${color};`;
      input.addEventListener('input', () => onInput(Number.parseFloat(input.value)));
      input.addEventListener('pointerdown', (e) => e.stopPropagation());
      col.appendChild(label);
      col.appendChild(input);
      return col;
    }

    const zoomSlider = makeSlider('Zoom', 0, 100, 5, zoom, '#55d08a', (v) => {
      zoom = v;
      applyZoom();
    });
    const zoomInput = zoomSlider.querySelector('input');
    // Изменение зума с клавиатуры (+/-): двигаем в границах ползунка и синхронизируем UI.
    function nudgeZoom(delta) {
      zoom = Math.min(100, Math.max(0, zoom + delta));
      if (zoomInput) zoomInput.value = String(zoom);
      applyZoom();
    }
    const speedSlider = makeSlider('Speed', SPEED_MIN, SPEED_MAX, SPEED_STEP, speed, '#ff9f43', (v) => {
      speed = v;
      saveState({ speed });
    });
    const speedInput = speedSlider.querySelector('input');
    // Изменение скорости с клавиатуры (* / /): двигаем в границах ползунка и сохраняем.
    // Округляем до шага, чтобы не накапливалась погрешность float.
    function nudgeSpeed(delta) {
      speed = Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round((speed + delta) / SPEED_STEP) * SPEED_STEP));
      if (speedInput) speedInput.value = String(speed);
      saveState({ speed });
    }

    panelBody.appendChild(zoomSlider);
    panelBody.appendChild(speedSlider);

    // Кнопки ↑ / ▶⏸ / ↓
    const btnStack = document.createElement('div');
    btnStack.style.cssText = 'display:flex;flex-direction:column;gap:6px;justify-content:center;';

    function makePanelButton(text, title) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = text;
      btn.title = title || '';
      btn.style.cssText = 'background:#3f3f3f;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:18px;font-weight:600;width:38px;height:38px;display:flex;align-items:center;justify-content:center;line-height:1;';
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
      btn.addEventListener('pointerdown', (e) => e.stopPropagation());
      return btn;
    }

    // Зажатие ↑/↓ — непрерывная прокрутка со скоростью из ползунка.
    let holdTimer = null;
    let holdRaf = null;
    function stopHold() {
      if (holdTimer) { window.clearTimeout(holdTimer); holdTimer = null; }
      if (holdRaf) { cancelAnimationFrame(holdRaf); holdRaf = null; }
    }
    function startHold(direction) {
      stopHold();
      const tick = () => {
        overlay.scrollTop = Math.max(0, overlay.scrollTop + direction * SCROLL_SPEED_FACTOR * speed);
        holdRaf = requestAnimationFrame(tick);
      };
      holdTimer = window.setTimeout(() => { holdRaf = requestAnimationFrame(tick); }, 130);
    }
    function smoothScrollBy(delta) {
      overlay.scrollBy({ top: delta, behavior: 'smooth' });
    }
    function bindHold(btn, direction) {
      btn.addEventListener('click', () => smoothScrollBy(direction * Math.floor(overlay.clientHeight * 0.5)));
      btn.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        startHold(direction);
        e.preventDefault();
      });
      btn.addEventListener('pointerup', stopHold);
      btn.addEventListener('pointercancel', stopHold);
      btn.addEventListener('pointerleave', stopHold);
    }

    const upBtn = makePanelButton('↑', 'Прокрутка вверх (зажми для непрерывной)');
    const downBtn = makePanelButton('↓', 'Прокрутка вниз (зажми для непрерывной)');
    bindHold(upBtn, -1);
    bindHold(downBtn, 1);

    // Автопрокрутка ▶ / ⏸
    let autoRaf = null;
    const autoBtn = makePanelButton('▶', 'Автопрокрутка вниз');
    function stopAuto() {
      if (autoRaf) { cancelAnimationFrame(autoRaf); autoRaf = null; }
      autoBtn.textContent = '▶';
    }
    function startAuto() {
      stopAuto();
      autoBtn.textContent = '⏸';
      const tick = () => {
        const before = overlay.scrollTop;
        overlay.scrollTop = before + SCROLL_SPEED_FACTOR * speed;
        if (overlay.scrollTop <= before) { stopAuto(); return; } // дошли до конца
        autoRaf = requestAnimationFrame(tick);
      };
      autoRaf = requestAnimationFrame(tick);
    }
    autoBtn.addEventListener('click', () => {
      if (autoRaf) stopAuto(); else startAuto();
    });

    btnStack.appendChild(upBtn);
    btnStack.appendChild(autoBtn);
    btnStack.appendChild(downBtn);
    panelBody.appendChild(btnStack);

    // Свернуть/развернуть (с восстановлением из сохранённого состояния)
    let collapsed = !!stateCache.collapsed;
    function applyCollapsed() {
      panelBody.style.display = collapsed ? 'none' : 'flex';
      panelCollapseBtn.textContent = collapsed ? '+' : '−';
    }
    applyCollapsed();
    panelCollapseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      collapsed = !collapsed;
      applyCollapsed();
      saveState({ collapsed });
    });

    // Показать/скрыть всю панель (с восстановлением из сохранённого состояния)
    let panelVisible = stateCache.panelVisible !== false;
    function applyPanelVisible() {
      scrollPanel.style.display = panelVisible ? 'block' : 'none';
      panelToggleBtn.textContent = panelVisible ? '◫ Панель' : '◪ Панель';
    }
    applyPanelVisible();
    panelToggleBtn.onclick = () => {
      panelVisible = !panelVisible;
      applyPanelVisible();
      saveState({ panelVisible });
    };

    // Перетаскивание панели за заголовок
    let panelDrag = false;
    let panelPointerId = null;
    let startX = 0;
    let startY = 0;
    let panelLeft = 0;
    let panelTop = 0;
    panelHeader.addEventListener('pointerdown', (e) => {
      if (e.target === panelCollapseBtn) return;
      panelDrag = true;
      panelPointerId = e.pointerId;
      const rect = scrollPanel.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      panelLeft = rect.left;
      panelTop = rect.top;
      scrollPanel.style.left = panelLeft + 'px';
      scrollPanel.style.top = panelTop + 'px';
      scrollPanel.style.right = 'auto';
      scrollPanel.style.bottom = 'auto';
      panelHeader.style.cursor = 'grabbing';
      panelHeader.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    });
    panelHeader.addEventListener('pointermove', (e) => {
      if (!panelDrag || e.pointerId !== panelPointerId) return;
      const w = scrollPanel.offsetWidth;
      const h = scrollPanel.offsetHeight;
      const left = Math.min(Math.max(0, panelLeft + (e.clientX - startX)), window.innerWidth - w);
      const top = Math.min(Math.max(0, panelTop + (e.clientY - startY)), window.innerHeight - h);
      scrollPanel.style.left = left + 'px';
      scrollPanel.style.top = top + 'px';
      e.preventDefault();
    });
    function endPanelDrag(e) {
      if (!panelDrag || e.pointerId !== panelPointerId) return;
      panelDrag = false;
      panelPointerId = null;
      panelHeader.style.cursor = 'grab';
      panelHeader.releasePointerCapture?.(e.pointerId);
      const rect = scrollPanel.getBoundingClientRect();
      saveState({ panelLeft: rect.left, panelTop: rect.top });
    }
    panelHeader.addEventListener('pointerup', endPanelDrag);
    panelHeader.addEventListener('pointercancel', endPanelDrag);

    scrollPanel.appendChild(panelHeader);
    scrollPanel.appendChild(panelBody);
    overlay.appendChild(scrollPanel);

    // ── Перетаскивание ленты мышью/касанием ───────────────────────────────────
    let dragActive = false;
    let dragPointerId = null;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragScrollLeft = 0;
    let dragScrollTop = 0;

    function isControl(t) {
      return !!t?.closest('button, input, #gsv-scroll-panel');
    }
    overlay.addEventListener('pointerdown', (e) => {
      if (isControl(e.target)) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      dragActive = true;
      dragPointerId = e.pointerId;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      dragScrollLeft = overlay.scrollLeft;
      dragScrollTop = overlay.scrollTop;
      overlay.style.cursor = 'grabbing';
      if (e.pointerType !== 'touch') overlay.setPointerCapture?.(e.pointerId);
    });
    overlay.addEventListener('pointermove', (e) => {
      if (!dragActive || e.pointerId !== dragPointerId) return;
      if (overlay.scrollWidth > overlay.clientWidth + 1) {
        overlay.scrollLeft = dragScrollLeft - (e.clientX - dragStartX);
      }
      overlay.scrollTop = dragScrollTop - (e.clientY - dragStartY);
      e.preventDefault();
    });
    function endDrag(e) {
      if (!dragActive || e.pointerId !== dragPointerId) return;
      dragActive = false;
      dragPointerId = null;
      overlay.style.cursor = 'grab';
      if (e.pointerType !== 'touch') overlay.releasePointerCapture?.(e.pointerId);
    }
    overlay.addEventListener('pointerup', endDrag);
    overlay.addEventListener('pointercancel', endDrag);

    // ── Управление с клавиатуры ────────────────────────────────────────────────
    // Стрелки ↑/↓ — прокрутка: одиночный шаг + при удержании непрерывная прокрутка
    // со скоростью из ползунка Speed (тот же startHold/stopHold, что у кнопок панели).
    // ←/→ — горизонтальная прокрутка при зуме, PageUp/PageDown — полэкрана,
    // Home/End — в начало/конец, +/− — зум, * / / — скорость,
    // Space — пауза/старт автопрокрутки, Esc — закрыть.
    keydownHandler = (e) => {
      if (e.key === 'Escape') { stopHold(); stopAuto(); closeScrollView(); return; }

      // Не перехватываем клавиши, когда фокус на элементе управления
      // (ползунки/селектор двигаются стрелками штатно).
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) {
        return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey) return;

      const step = Math.max(60, Math.round(overlay.clientHeight * 0.16));
      const halfPage = Math.floor(overlay.clientHeight * 0.85);
      const hStep = Math.max(60, Math.round(overlay.clientWidth * 0.2));

      switch (e.key) {
        case 'ArrowDown':
        case 'ArrowUp': {
          const dir = e.key === 'ArrowDown' ? 1 : -1;
          // repeat игнорируем — непрерывность обеспечивает startHold со скоростью Speed.
          if (!e.repeat) {
            overlay.scrollTop = Math.max(0, overlay.scrollTop + dir * step); // одиночный шаг
            startHold(dir);
          }
          break;
        }
        case 'ArrowRight':
          overlay.scrollLeft += hStep;
          break;
        case 'ArrowLeft':
          overlay.scrollLeft -= hStep;
          break;
        case 'PageDown':
          smoothScrollBy(halfPage);
          break;
        case 'PageUp':
          smoothScrollBy(-halfPage);
          break;
        case 'Home':
          overlay.scrollTo({ top: 0, behavior: 'smooth' });
          break;
        case 'End':
          overlay.scrollTo({ top: overlay.scrollHeight, behavior: 'smooth' });
          break;
        case '+':
        case '=': // '=' — тот же клавиш, что '+', но без Shift
          nudgeZoom(5); // шаг = step ползунка Zoom
          break;
        case '-':
        case '_':
          nudgeZoom(-5);
          break;
        case '*':
          nudgeSpeed(SPEED_STEP); // быстрее
          break;
        case '/':
          nudgeSpeed(-SPEED_STEP); // медленнее
          break;
        case ' ':
        case 'Spacebar':
          if (autoRaf) stopAuto(); else startAuto();
          break;
        default:
          return; // клавиша не наша — не мешаем странице
      }
      e.preventDefault();
    };

    // Отпускание ↑/↓ останавливает непрерывную прокрутку (аналог pointerup у кнопок).
    keyupHandler = (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') stopHold();
    };

    document.body.appendChild(overlay);
    document.addEventListener('keydown', keydownHandler);
    document.addEventListener('keyup', keyupHandler);
    applyZoom();

    // Восстановление сохранённой позиции панели — только если она в видимой
    // области (окно могло уменьшиться / панель сохранена за краем экрана).
    if (Number.isFinite(stateCache.panelLeft) && Number.isFinite(stateCache.panelTop)) {
      const w = scrollPanel.offsetWidth;
      const h = scrollPanel.offsetHeight;
      const left = stateCache.panelLeft;
      const top = stateCache.panelTop;
      // Панель считается видимой, если её заголовок (высота ~30px) остаётся
      // в пределах окна и она не ушла за левый/правый/нижний край.
      const MIN_VISIBLE = 30;
      const inViewport =
        left >= 0 && top >= 0 &&
        left <= window.innerWidth - MIN_VISIBLE &&
        top <= window.innerHeight - MIN_VISIBLE &&
        left + w <= window.innerWidth &&
        top + h <= window.innerHeight;
      if (inViewport) {
        scrollPanel.style.left = left + 'px';
        scrollPanel.style.top = top + 'px';
        scrollPanel.style.right = 'auto';
        scrollPanel.style.bottom = 'auto';
      }
      // Иначе оставляем позицию по умолчанию (right/bottom из стилей панели).
    }

    // ── Бесконечная подгрузка при прокрутке ────────────────────────────────────
    const EXTEND_BATCH = 6;          // сколько страниц догружать за раз
    const EXTEND_THRESHOLD = 1200;   // px до края, при котором подгружаем
    let extending = false;

    function appendNext() {
      const end = Math.min(total, loadedEnd + EXTEND_BATCH);
      const frag = document.createDocumentFragment();
      for (let n = loadedEnd + 1; n <= end; n += 1) {
        const item = makeItem(n);
        if (item) frag.appendChild(createRow(item));
      }
      imgContainer.appendChild(frag);
      loadedEnd = end;
      updateCounter();
    }

    function prependPrev() {
      const start = Math.max(1, loadedStart - EXTEND_BATCH);
      const before = overlay.scrollHeight;
      const frag = document.createDocumentFragment();
      for (let n = start; n <= loadedStart - 1; n += 1) {
        const item = makeItem(n);
        if (item) frag.appendChild(createRow(item));
      }
      imgContainer.insertBefore(frag, imgContainer.firstChild);
      loadedStart = start;
      // Компенсируем сдвиг, чтобы вид остался на том же месте (без «прыжка»).
      overlay.scrollTop += overlay.scrollHeight - before;
      updateCounter();
    }

    const KEEP_MARGIN = 50; // держим не более 50 страниц по каждую сторону от видимой

    const SWITCH_FRACTION = 0.7; // номер меняем, когда новая страница заняла >70% видимой области

    // Доминирующая страница (макс. видимая высота) + доля экрана и видимость текущей.
    // Дёшево: ранний выход из цикла + дешёвые offsetTop/offsetHeight (без getBoundingClientRect).
    function dominantInfo() {
      const top = overlay.scrollTop + TOP_OFFSET; // под фиксированной панелью
      const bottom = overlay.scrollTop + overlay.clientHeight;
      const visibleArea = Math.max(1, bottom - top);
      const rows = imgContainer.children;
      let bestPage = loadedStart;
      let bestVisible = -1;
      let currentVisible = 0;
      for (let i = 0; i < rows.length; i += 1) {
        const r = rows[i];
        const rTop = r.offsetTop;
        const rBottom = rTop + r.offsetHeight;
        if (rBottom <= top) continue;   // строка выше вьюпорта
        if (rTop >= bottom) break;      // строка ниже вьюпорта — дальше не смотрим
        const visible = Math.min(rBottom, bottom) - Math.max(rTop, top);
        const pg = Number(r.dataset.page) || bestPage;
        if (visible > bestVisible) { bestVisible = visible; bestPage = pg; }
        if (pg === viewPage) currentVisible = visible;
      }
      return { page: bestPage, fraction: bestVisible / visibleArea, currentVisible };
    }

    // Выгружаем строки дальше KEEP_MARGIN страниц от видимой — чтобы DOM не рос бесконечно.
    function trimFar(anchor) {
      // Сверху (с компенсацией прокрутки — удаляем контент над вьюпортом).
      if (loadedStart < anchor - KEEP_MARGIN) {
        const before = overlay.scrollHeight;
        while (loadedStart < anchor - KEEP_MARGIN && imgContainer.children.length > 1) {
          rowByPage.delete(loadedStart);
          imgContainer.removeChild(imgContainer.firstChild);
          loadedStart += 1;
        }
        overlay.scrollTop -= before - overlay.scrollHeight;
      }
      // Снизу (компенсация не нужна — контент ниже вьюпорта).
      while (loadedEnd > anchor + KEEP_MARGIN && imgContainer.children.length > 1) {
        rowByPage.delete(loadedEnd);
        imgContainer.removeChild(imgContainer.lastChild);
        loadedEnd -= 1;
      }
    }

    function onScrollExtend() {
      if (extending) return;
      extending = true;
      try {
        if (overlay.scrollTop <= EXTEND_THRESHOLD && loadedStart > 1) {
          prependPrev();
        }
        if (overlay.scrollHeight - overlay.scrollTop - overlay.clientHeight <= EXTEND_THRESHOLD
            && loadedEnd < total) {
          appendNext();
        }
        const dom = dominantInfo();
        trimFar(dom.page);
        // Меняем номер, когда новая страница заняла >70% экрана, либо когда текущая
        // уже не видна совсем (fallback — иначе на коротких картинках номер бы «застрял»).
        if (dom.page !== viewPage && (dom.fraction >= SWITCH_FRACTION || dom.currentVisible <= 0)) {
          viewPage = dom.page;
          updateCounter();
        }
      } finally {
        extending = false;
      }
    }

    // Старт от текущей страницы; слушатель скролла вешаем после позиционирования,
    // чтобы стартовый scrollTop не вызвал лишнюю догрузку.
    const startRow = rowByPage.get(current);
    if (startRow) {
      requestAnimationFrame(() => {
        overlay.scrollTop = Math.max(0, startRow.offsetTop - TOP_OFFSET);
        requestAnimationFrame(() => overlay.addEventListener('scroll', onScrollExtend));
      });
    } else {
      overlay.addEventListener('scroll', onScrollExtend);
    }
  }

  // ─── Плавающая кнопка запуска ──────────────────────────────────────────────────

  function addFloatButton() {
    if (document.getElementById('gsv-float-btn')) return;
    if (!getAdapter()?.ready()) return; // не reader-страница / данные ещё не готовы

    const btn = document.createElement('button');
    btn.id = 'gsv-float-btn';
    btn.type = 'button';
    btn.title = 'Открыть свиток (±10 страниц вокруг текущей)';
    btn.textContent = '📜';
    Object.assign(btn.style, {
      position: 'fixed',
      bottom: '76px',
      right: '20px',
      zIndex: '2147483000',
      borderRadius: '50%',
      width: '52px',
      height: '52px',
      fontSize: '22px',
      lineHeight: '1',
      padding: '0',
      border: 'none',
      color: '#fff',
      background: '#d6336c',
      boxShadow: '0 3px 10px rgba(0,0,0,0.6)',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    });

    btn.onclick = () => {
      const context = getAdapter()?.getContext();
      if (!context || !context.total) {
        window.alert('[Gallery Scroll View] Не удалось определить картинки галереи на этой странице.');
        return;
      }
      openScrollView(context);
    };

    document.body.appendChild(btn);
  }

  // Данные могут догружаться (ленивая картинка у imhentai, galleryinfo у hitomi).
  let attempts = 0;
  (function init() {
    if (getAdapter()?.ready()) {
      addFloatButton();
      return;
    }
    if (attempts++ < 20) {
      window.setTimeout(init, 400);
    }
  })();
})();
