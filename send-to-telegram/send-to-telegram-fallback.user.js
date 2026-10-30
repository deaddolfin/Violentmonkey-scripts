// ==UserScript==
// @name         Send to Telegram (fallback)
// @namespace    https://github.com/deaddolfin/Violentmonkey-scripts/tree/main/send-to-telegram
// @version      1.0.0
// @description  Отправляет в Telegram (через Bot API) картинку, выбранную кликом, ссылку страницы или выделенный текст. Картинка передаётся URL-ом, а если Telegram не смог её скачать — браузер скачивает файл сам и загружает в Telegram.
// @author       boikov.vv
// @homepageURL  https://github.com/deaddolfin/Violentmonkey-scripts/tree/main/send-to-telegram
// @supportURL   https://github.com/deaddolfin/Violentmonkey-scripts/issues
// @downloadURL  https://raw.githubusercontent.com/deaddolfin/Violentmonkey-scripts/main/send-to-telegram/send-to-telegram-fallback.user.js
// @updateURL    https://raw.githubusercontent.com/deaddolfin/Violentmonkey-scripts/main/send-to-telegram/send-to-telegram-fallback.user.js
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      api.telegram.org
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const LOG = '[SendToTelegram]';
  const API = 'https://api.telegram.org';
  // VPN рвёт канал после ~30 с тишины — таймаут с запасом, чтобы ошибку отдавал именно сервер
  const REQ_TIMEOUT = 60000;
  const CAPTION_MAX = 1024;
  const TEXT_MAX = 4096;
  // sendPhoto надёжно принимает только JPEG/PNG; остальное уходит файлом
  const PHOTO_EXT = /\.(jpe?g|png)(?:$|[?#])/i;

  // ---------------------------------------------------------------------------
  // Настройки
  // ---------------------------------------------------------------------------
  const getCfg = () => ({
    token: GM_getValue('token', ''),
    chatId: GM_getValue('chatId', ''),
    asDocument: GM_getValue('asDocument', false),
    withSource: GM_getValue('withSource', true),
  });

  const cfgReady = (cfg) => Boolean(cfg.token && cfg.chatId);

  const setupCfg = () => {
    const cfg = getCfg();
    const token = prompt(
      `Токен бота (от @BotFather). Пусто — оставить прежний.\nСейчас: ${cfg.token ? 'задан' : 'не задан'}`,
      '',
    );
    if (token) GM_setValue('token', token.trim());
    const chatId = prompt('Chat ID (число или @канал)', cfg.chatId);
    if (chatId !== null) GM_setValue('chatId', chatId.trim());
  };

  const toggleCfg = (key, onText, offText) => {
    const next = !getCfg()[key];
    GM_setValue(key, next);
    toast(next ? onText : offText);
  };

  // ---------------------------------------------------------------------------
  // Уведомления
  // ---------------------------------------------------------------------------
  let toastEl = null;
  let toastTimer = 0;

  function toast(text, kind = 'info', sticky = false) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'vm-tg-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.dataset.kind = kind;
    toastEl.style.display = 'block';
    clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(hideToast, kind === 'error' ? 8000 : 4000);
  }

  function hideToast() {
    if (toastEl) toastEl.style.display = 'none';
  }

  const injectStyle = () => {
    const style = document.createElement('style');
    style.textContent = `
      .vm-tg-toast { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; display: none;
        max-width: 360px; padding: 10px 14px; border-radius: 8px; font: 14px/1.4 sans-serif;
        color: #fff; background: #2aabee; box-shadow: 0 2px 10px rgba(0,0,0,.35); }
      .vm-tg-toast[data-kind="ok"] { background: #2e9e4f; }
      .vm-tg-toast[data-kind="error"] { background: #d64545; }
      .vm-tg-hl { position: fixed; z-index: 2147483646; pointer-events: none; display: none;
        border: 2px solid #2aabee; background: rgba(42,171,238,.18); }
      html.vm-tg-picking, html.vm-tg-picking * { cursor: crosshair !important; }
    `;
    document.head.appendChild(style);
  };

  // ---------------------------------------------------------------------------
  // Telegram Bot API
  // ---------------------------------------------------------------------------
  class TgError extends Error {
    constructor(message, code) {
      super(message);
      this.code = code; // undefined — до Telegram запрос не дошёл (сеть, таймаут)
    }
  }

  // Ошибки, при которых повторять другим способом бессмысленно
  const isFatal = (e) =>
    e.code === undefined ||
    [401, 403, 404, 429].includes(e.code) ||
    /chat not found|bot was blocked/i.test(e.message);

  // Токен сидит в URL запроса — в логи и сообщения об ошибках он не попадает
  const tgCall = (cfg, method, body) =>
    new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: `${API}/bot${cfg.token}/${method}`,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ chat_id: cfg.chatId, ...body }),
        timeout: REQ_TIMEOUT,
        onload: (r) => {
          let json;
          try {
            json = JSON.parse(r.responseText);
          } catch {
            return reject(new TgError(`Ответ не JSON, HTTP ${r.status}`, r.status));
          }
          if (json.ok) resolve(json.result);
          else reject(new TgError(json.description || `HTTP ${r.status}`, json.error_code));
        },
        onerror: () => reject(new TgError('Нет связи с api.telegram.org')),
        ontimeout: () => reject(new TgError('Таймаут запроса к api.telegram.org')),
      });
    });

  const makeCaption = (cfg) =>
    cfg.withSource ? `${document.title}\n${location.href}`.slice(0, CAPTION_MAX) : undefined;

  // ---------------------------------------------------------------------------
  // Отправка картинки
  // ---------------------------------------------------------------------------
  const isHttp = (url) => /^https?:/i.test(url);

  // Путь А: Telegram сам скачивает файл по URL (фото до 5 МБ, документ до 20 МБ)
  async function sendImageByUrl(cfg, url) {
    const caption = makeCaption(cfg);
    if (!cfg.asDocument && PHOTO_EXT.test(url)) {
      try {
        return await tgCall(cfg, 'sendPhoto', { photo: url, caption });
      } catch (e) {
        if (isFatal(e)) throw e;
        console.warn(LOG, 'sendPhoto не прошёл, пробую документом:', e.message);
      }
    }
    return tgCall(cfg, 'sendDocument', { document: url, caption });
  }

  // Путь Б: файл скачивает браузер (с куками и Referer страницы) и заливает в Telegram сам
  // (фото до 10 МБ, документ до 50 МБ)
  const UPLOAD_MAX = 50 * 1024 * 1024;
  const PHOTO_UPLOAD_MAX = 10 * 1024 * 1024;

  const downloadBlob = (url) =>
    new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers: { Referer: location.href },
        responseType: 'blob',
        timeout: REQ_TIMEOUT,
        onload: (r) =>
          r.status >= 200 && r.status < 300 ? resolve(r.response) : reject(new Error(`Скачивание: HTTP ${r.status}`)),
        onerror: () => reject(new Error('Скачивание: сайт недоступен')),
        ontimeout: () => reject(new Error('Скачивание: таймаут')),
      });
    });

  // blob: и data: существуют только в контексте страницы — наружу их не отдать, читаем fetch-ем
  async function fetchBlob(url) {
    if (!isHttp(url)) return (await fetch(url)).blob();
    return downloadBlob(url);
  }

  const fileNameOf = (url, blob) => {
    if (isHttp(url)) {
      const last = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
      if (/\.\w{2,5}$/.test(last)) return last;
    }
    return `image.${(blob.type.split('/')[1] || 'bin').replace('jpeg', 'jpg')}`;
  };

  const tgUpload = (cfg, method, field, blob, name, caption) =>
    new Promise((resolve, reject) => {
      const form = new FormData();
      form.append('chat_id', cfg.chatId);
      if (caption) form.append('caption', caption);
      form.append(field, blob, name);
      GM_xmlhttpRequest({
        method: 'POST',
        url: `${API}/bot${cfg.token}/${method}`,
        data: form,
        timeout: REQ_TIMEOUT,
        onload: (r) => {
          let json;
          try {
            json = JSON.parse(r.responseText);
          } catch {
            return reject(new TgError(`Ответ не JSON, HTTP ${r.status}`, r.status));
          }
          if (json.ok) resolve(json.result);
          else reject(new TgError(json.description || `HTTP ${r.status}`, json.error_code));
        },
        onerror: () => reject(new TgError('Нет связи с api.telegram.org')),
        ontimeout: () => reject(new TgError('Таймаут загрузки в api.telegram.org')),
      });
    });

  async function sendImageByUpload(cfg, url) {
    const blob = await fetchBlob(url);
    if (blob.size > UPLOAD_MAX) throw new Error('Файл больше 50 МБ — Telegram не примет');
    const name = fileNameOf(url, blob);
    const caption = makeCaption(cfg);
    const photoOk = !cfg.asDocument && /^image\/(jpeg|png)$/.test(blob.type) && blob.size <= PHOTO_UPLOAD_MAX;
    if (photoOk) {
      try {
        return await tgUpload(cfg, 'sendPhoto', 'photo', blob, name, caption);
      } catch (e) {
        if (isFatal(e)) throw e;
        console.warn(LOG, 'sendPhoto (загрузка) не прошёл, пробую документом:', e.message);
      }
    }
    return tgUpload(cfg, 'sendDocument', 'document', blob, name, caption);
  }

  async function sendImage(cfg, url) {
    if (isHttp(url)) {
      try {
        return await sendImageByUrl(cfg, url);
      } catch (e) {
        if (isFatal(e)) throw e;
        console.warn(LOG, 'Telegram не скачал картинку сам, загружаю через браузер:', e.message);
        toast('Telegram не смог скачать сам — загружаю через браузер…');
      }
    }
    return sendImageByUpload(cfg, url);
  }

  async function sendPickedImage(img) {
    const cfg = getCfg();
    if (!cfgReady(cfg)) {
      toast('Сначала заполните токен и Chat ID в меню скрипта', 'error');
      return;
    }
    const url = img.currentSrc || img.src;
    toast('Отправляю картинку…');
    try {
      await sendImage(cfg, url);
      toast('Картинка отправлена', 'ok');
    } catch (e) {
      console.error(LOG, e);
      toast(`Не отправлено: ${e.message}`, 'error');
    }
  }

  // ---------------------------------------------------------------------------
  // Режим выбора картинки
  // ---------------------------------------------------------------------------
  let picking = false;
  let hlEl = null;

  // Под курсором часто лежат оверлеи и ссылки — берём первую картинку из стека элементов
  const imgAt = (x, y) => document.elementsFromPoint(x, y).find((el) => el instanceof HTMLImageElement) || null;

  function onMove(ev) {
    const img = imgAt(ev.clientX, ev.clientY);
    if (!img) {
      hlEl.style.display = 'none';
      return;
    }
    const r = img.getBoundingClientRect();
    Object.assign(hlEl.style, {
      display: 'block',
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
  }

  function onClick(ev) {
    const img = imgAt(ev.clientX, ev.clientY);
    if (!img) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    stopPicking();
    sendPickedImage(img);
  }

  function onKey(ev) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      stopPicking();
    }
  }

  function startPicking() {
    if (picking) return;
    picking = true;
    if (!hlEl) {
      hlEl = document.createElement('div');
      hlEl.className = 'vm-tg-hl';
      document.body.appendChild(hlEl);
    }
    document.documentElement.classList.add('vm-tg-picking');
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    toast('Кликните по картинке. Esc — отмена', 'info', true);
  }

  function stopPicking() {
    if (!picking) return;
    picking = false;
    hlEl.style.display = 'none';
    document.documentElement.classList.remove('vm-tg-picking');
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    hideToast();
  }

  const togglePicking = () => (picking ? stopPicking() : startPicking());

  // ---------------------------------------------------------------------------
  // Ссылка страницы и выделенный текст
  // ---------------------------------------------------------------------------
  async function sendText(text, doneText) {
    const cfg = getCfg();
    if (!cfgReady(cfg)) {
      toast('Сначала заполните токен и Chat ID в меню скрипта', 'error');
      return;
    }
    toast('Отправляю…');
    try {
      await tgCall(cfg, 'sendMessage', { text: text.slice(0, TEXT_MAX) });
      toast(doneText, 'ok');
    } catch (e) {
      console.error(LOG, e);
      toast(`Не отправлено: ${e.message}`, 'error');
    }
  }

  const sendPageLink = () => sendText(`${document.title}\n${location.href}`, 'Ссылка отправлена');

  function sendSelection() {
    const sel = String(window.getSelection()).trim();
    if (!sel) {
      toast('Ничего не выделено', 'error');
      return;
    }
    sendText(`${sel}\n\n${location.href}`, 'Выделенное отправлено');
  }

  // ---------------------------------------------------------------------------
  // Запуск
  // ---------------------------------------------------------------------------
  injectStyle();

  GM_registerMenuCommand('Отправить картинку (режим выбора)', startPicking);
  GM_registerMenuCommand('Отправить ссылку страницы', sendPageLink);
  GM_registerMenuCommand('Отправить выделенный текст', sendSelection);
  GM_registerMenuCommand('Настройки: токен бота и Chat ID', setupCfg);
  GM_registerMenuCommand('Переключить: картинки файлом без сжатия', () =>
    toggleCfg('asDocument', 'Картинки уходят файлом (без сжатия)', 'Картинки уходят фото, где возможно'));
  GM_registerMenuCommand('Переключить: подпись со ссылкой на источник', () =>
    toggleCfg('withSource', 'Подпись с источником включена', 'Подпись с источником выключена'));

  // Alt+Shift+S — включить/выключить режим выбора
  window.addEventListener('keydown', (ev) => {
    if (ev.altKey && ev.shiftKey && ev.code === 'KeyS') {
      ev.preventDefault();
      togglePicking();
    }
  });
})();
