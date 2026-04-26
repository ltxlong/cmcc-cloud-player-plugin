// ==UserScript==
// @name         中国移动云盘外置最高画质视频播放器
// @namespace    cmcc-cloud-4k-player-plugin
// @version      1.0.0
// @description  捕获中国移动云盘 HLS master playlist，外置播放最高画质，支持 ArtPlayer / HTML5 / DPlayer 下拉选择、最小化隐藏与恢复
// @match        *://*.139.com/*
// @match        *://*.mcloud.139.com/*
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @require      https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js
// @require      https://cdn.jsdelivr.net/npm/artplayer@5.2.2/dist/artplayer.js
// @require      https://cdn.jsdelivr.net/npm/dplayer@1.27.1/dist/DPlayer.min.js
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const PLAYER_HTML5 = 'html5';
  const PLAYER_ART = 'artplayer';
  const PLAYER_DPLAYER = 'dplayer';
  const PLAYER_OPTIONS = [PLAYER_HTML5, PLAYER_ART, PLAYER_DPLAYER];
  const STORAGE_KEY = 'cmcc4k_player_type';

  const DPLAYER_CSS_ID = '__cmcc4k_dplayer_css__';
  const DPLAYER_CSS_URL = 'https://cdn.jsdelivr.net/npm/dplayer@1.27.1/dist/DPlayer.min.css';

  const state = {
    masterUrl: '',
    masterText: '',
    variants: [],

    buttonWrap: null,
    playButton: null,
    restoreButton: null,
    switchBox: null,
    switchButton: null,
    playerMenu: null,

    overlay: null,
    overlayContent: null,
    overlayTitleEl: null,

    currentPlayUrl: '',
    currentResolution: '',
    currentVideoName: '',

    playerType: normalizePlayerType(safeGMGet(STORAGE_KEY, PLAYER_HTML5)),
    renderedPlayerType: '',

    hls: null,
    art: null,
    dp: null,
    video: null,

    isMinimized: false,
  };

  function log(...args) {
    console.log('[CMCC-4K]', ...args);
  }

  function safeGMGet(key, defVal) {
    try {
      return typeof GM_getValue === 'function' ? GM_getValue(key, defVal) : defVal;
    } catch (e) {
      return defVal;
    }
  }

  function safeGMSet(key, value) {
    try {
      if (typeof GM_setValue === 'function') GM_setValue(key, value);
    } catch (e) {}
  }

  function normalizePlayerType(type) {
    if (type === PLAYER_ART) return PLAYER_ART;
    if (type === PLAYER_DPLAYER) return PLAYER_DPLAYER;
    return PLAYER_HTML5;
  }

  function playerName(type = state.playerType) {
    if (type === PLAYER_ART) return 'ArtPlayer';
    if (type === PLAYER_DPLAYER) return 'DPlayer';
    return 'HTML5';
  }

  function normalizeText(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  function toAbsoluteUrl(url, base) {
    try {
      return new URL(url, base || location.href).href;
    } catch (e) {
      return url || '';
    }
  }

  function toast(msg) {
    let el = document.getElementById('__cmcc4k_toast__');
    if (!el) {
      el = document.createElement('div');
      el.id = '__cmcc4k_toast__';
      document.documentElement.appendChild(el);
    }
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(el._timer);
    el._timer = setTimeout(() => {
      el.style.display = 'none';
    }, 2500);
  }

  function appendToBodyWhenReady(node) {
    const mount = () => {
      if (document.body) {
        if (!node.isConnected) document.body.appendChild(node);
      } else {
        setTimeout(mount, 200);
      }
    };
    mount();
  }

  function ensureDPlayerCss() {
    if (document.getElementById(DPLAYER_CSS_ID)) return;

    const inject = () => {
      const head = document.head || document.documentElement;
      if (!head) {
        setTimeout(inject, 200);
        return;
      }
      if (document.getElementById(DPLAYER_CSS_ID)) return;

      const link = document.createElement('link');
      link.id = DPLAYER_CSS_ID;
      link.rel = 'stylesheet';
      link.href = DPLAYER_CSS_URL;
      head.appendChild(link);
    };

    inject();
  }

  function formatVariantShort(v) {
    if (!v) return '-';
    if (v.height) return `${v.height}p`;
    return v.label || '-';
  }

  function getBestVariant() {
    return state.variants.length ? state.variants[0] : null;
  }

  function getPageVideoTitle() {
    const el = document.querySelector('div.vp-name');
    if (!el) return '';

    const directText = Array.from(el.childNodes)
      .filter(node => node.nodeType === Node.TEXT_NODE)
      .map(node => node.textContent || '')
      .join(' ');

    const directTitle = normalizeText(directText);
    if (directTitle) return directTitle;

    const clone = el.cloneNode(true);
    clone.querySelectorAll('span').forEach(span => span.remove());
    return normalizeText(clone.textContent || '');
  }

  function refreshCurrentVideoName(allowEmpty = false) {
    const title = getPageVideoTitle();
    if (title) {
      state.currentVideoName = title;
    } else if (allowEmpty) {
      state.currentVideoName = '';
    }
  }

  function buildOverlayTitleText() {
    const parts = [];
    if (state.currentResolution) parts.push(state.currentResolution);
    if (state.currentVideoName) parts.push(state.currentVideoName);
    return parts.join(' | ') || '播放器';
  }

  function setVideoVolumeToMax(video) {
    try {
      if (!video) return;
      video.muted = false;
      video.volume = 1;
    } catch (e) {}
  }

  function setArtVolumeToMax(art) {
    try {
      if (!art) return;
      art.volume = 1;
    } catch (e) {}
    try {
      setVideoVolumeToMax(art.video);
    } catch (e) {}
  }

  function setDPlayerVolumeToMax(dp) {
    try {
      if (!dp) return;
      if (typeof dp.volume === 'function') {
        dp.volume(1, true, true);
      }
    } catch (e) {}
    try {
      setVideoVolumeToMax(dp.video);
    } catch (e) {}
  }

  GM_addStyle(`
    #__cmcc4k_btns__ {
      position: fixed;
      right: 20px;
      bottom: 20px;
      z-index: 999999;
      display: flex;
      flex-direction: column;
      gap: 10px;
      align-items: flex-end;
    }

    .__cmcc4k_btn__ {
      border: 0;
      background: #1677ff;
      color: #fff;
      padding: 10px 14px;
      border-radius: 8px;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(0,0,0,.25);
      font-size: 14px;
      line-height: 1.2;
      white-space: nowrap;
      width: 240px;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      justify-content: center;
      text-align: center;
    }

    .__cmcc4k_btn__.secondary {
      background: #444;
    }

    .__cmcc4k_btn__.restore {
      background: #52c41a;
    }

    .__cmcc4k_btn__:hover {
      filter: brightness(1.05);
    }

    .__cmcc4k_switch_box__ {
      position: relative;
      width: 240px;
    }

    .__cmcc4k_switch_box__ > .__cmcc4k_btn__ {
      width: 100%;
    }

    .__cmcc4k_menu__ {
      position: absolute;
      right: 0;
      bottom: calc(100% + 8px);
      width: 100%;
      display: none;
      flex-direction: column;
      background: rgba(25,25,25,.98);
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 8px 20px rgba(0,0,0,.35);
      backdrop-filter: blur(4px);
    }

    .__cmcc4k_menu__[data-open="1"] {
      display: flex;
    }

    .__cmcc4k_menu_item__ {
      border: 0;
      background: transparent;
      color: #fff;
      padding: 10px 14px;
      font-size: 14px;
      cursor: pointer;
      width: 100%;
      text-align: center;
      box-sizing: border-box;
    }

    .__cmcc4k_menu_item__ + .__cmcc4k_menu_item__ {
      border-top: 1px solid rgba(255,255,255,.08);
    }

    .__cmcc4k_menu_item__:hover {
      background: rgba(255,255,255,.08);
    }

    .__cmcc4k_menu_item__.current {
      background: #52c41a;
      font-weight: 600;
    }

    .__cmcc4k_menu_item__.current:hover {
      background: #52c41a;
    }

    #__cmcc4k_toast__ {
      position: fixed;
      left: 50%;
      bottom: 90px;
      transform: translateX(-50%);
      z-index: 10000000;
      background: rgba(0,0,0,.82);
      color: #fff;
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 13px;
      display: none;
      max-width: 80vw;
      word-break: break-all;
    }
  `);

  function parseMasterPlaylist(masterText, masterUrl) {
    const lines = masterText
      .replace(/\r/g, '')
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean);

    const variants = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (/^#EXT-X-STREAM-INF/i.test(line)) {
        const info = line;
        let uri = '';

        for (let j = i + 1; j < lines.length; j++) {
          if (!lines[j].startsWith('#')) {
            uri = lines[j].trim();
            i = j;
            break;
          }
        }

        if (!uri) continue;

        const resMatch = info.match(/RESOLUTION\s*=\s*(\d+)\s*x\s*(\d+)/i);
        const bwMatch = info.match(/BANDWIDTH\s*=\s*(\d+)/i);

        const width = resMatch ? Number(resMatch[1]) : 0;
        const height = resMatch ? Number(resMatch[2]) : 0;
        const bandwidth = bwMatch ? Number(bwMatch[1]) : 0;

        variants.push({
          info,
          rawUri: uri,
          url: toAbsoluteUrl(uri, masterUrl),
          width,
          height,
          bandwidth,
          label: height ? `${width}x${height}` : `${bandwidth}`,
        });
      }
    }

    variants.sort((a, b) => {
      if (b.height !== a.height) return b.height - a.height;
      if (b.width !== a.width) return b.width - a.width;
      return b.bandwidth - a.bandwidth;
    });

    return variants;
  }

  function saveMaster(url, text) {
    if (!text || !/#EXT-X-STREAM-INF/i.test(text)) return;
    if (state.masterUrl === url && state.masterText === text) return;

    const variants = parseMasterPlaylist(text, url);
    if (!variants.length) return;

    state.masterUrl = url;
    state.masterText = text;
    state.variants = variants;

    log('捕获到 master playlist:', url, variants);
    ensureButtons();
    updateButtons();
  }

  function hookFetch() {
    const rawFetch = window.fetch;
    if (!rawFetch) return;

    window.fetch = async function (...args) {
      const resp = await rawFetch.apply(this, args);

      try {
        const reqUrl =
          typeof args[0] === 'string'
            ? args[0]
            : (args[0] && args[0].url) || resp.url || '';

        if (/\.m3u8(\?|$)|playlist\.m3u8/i.test(reqUrl)) {
          const text = await resp.clone().text();
          saveMaster(toAbsoluteUrl(reqUrl, location.href), text);
        }
      } catch (e) {
        log('fetch hook error:', e);
      }

      return resp;
    };
  }

  function hookXHR() {
    const rawOpen = XMLHttpRequest.prototype.open;
    const rawSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url) {
      this.__cmcc4k_url__ = url;
      return rawOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function () {
      this.addEventListener('load', function () {
        try {
          const url = this.responseURL || this.__cmcc4k_url__ || '';
          const ct = this.getResponseHeader('content-type') || '';

          if (/\.m3u8(\?|$)|playlist\.m3u8/i.test(url) || /mpegurl/i.test(ct)) {
            if (typeof this.responseText === 'string') {
              saveMaster(toAbsoluteUrl(url, location.href), this.responseText);
            }
          }
        } catch (e) {
          log('xhr hook error:', e);
        }
      });

      return rawSend.apply(this, arguments);
    };
  }

  function isPlayerMenuOpen() {
    return !!(state.playerMenu && state.playerMenu.dataset.open === '1');
  }

  function setPlayerMenuVisible(visible) {
    if (!state.playerMenu) return;
    state.playerMenu.dataset.open = visible ? '1' : '0';
  }

  function closePlayerMenu() {
    setPlayerMenuVisible(false);
  }

  function togglePlayerMenu(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    setPlayerMenuVisible(!isPlayerMenuOpen());
  }

  function createPlayerMenuItem(type) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = '__cmcc4k_menu_item__';
    btn.dataset.playerType = type;
    btn.textContent = playerName(type);
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      setPlayerType(type);
    };
    return btn;
  }

  function ensureButtons() {
    if (state.buttonWrap && state.buttonWrap.isConnected) {
      updateButtons();
      return;
    }

    state.buttonWrap = null;
    state.playButton = null;
    state.restoreButton = null;
    state.switchBox = null;
    state.switchButton = null;
    state.playerMenu = null;

    const wrap = document.createElement('div');
    wrap.id = '__cmcc4k_btns__';

    const playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = '__cmcc4k_btn__';
    playBtn.textContent = '播放最高画质';
    playBtn.onclick = openBest;

    const restoreBtn = document.createElement('button');
    restoreBtn.type = 'button';
    restoreBtn.className = '__cmcc4k_btn__ restore';
    restoreBtn.textContent = '恢复显示播放器弹窗';
    restoreBtn.style.display = 'none';
    restoreBtn.onclick = restoreOverlay;

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = '__cmcc4k_btn__ secondary';
    copyBtn.textContent = '复制最高画质地址';
    copyBtn.onclick = () => {
      const best = getBestVariant();
      if (!best) {
        toast('还没捕获到 m3u8，请刷新页面后重新播放一次');
        return;
      }
      GM_setClipboard(best.url);
      toast('已复制最高画质地址');
    };

    const switchBox = document.createElement('div');
    switchBox.className = '__cmcc4k_switch_box__';

    const switchBtn = document.createElement('button');
    switchBtn.type = 'button';
    switchBtn.className = '__cmcc4k_btn__ secondary';
    switchBtn.textContent = `选择播放器：${playerName()}`;
    switchBtn.onclick = togglePlayerMenu;

    const menu = document.createElement('div');
    menu.className = '__cmcc4k_menu__';
    menu.dataset.open = '0';

    PLAYER_OPTIONS.forEach(type => {
      menu.appendChild(createPlayerMenuItem(type));
    });

    switchBox.appendChild(switchBtn);
    switchBox.appendChild(menu);

    wrap.appendChild(playBtn);
    wrap.appendChild(restoreBtn);
    wrap.appendChild(copyBtn);
    wrap.appendChild(switchBox);

    state.buttonWrap = wrap;
    state.playButton = playBtn;
    state.restoreButton = restoreBtn;
    state.switchBox = switchBox;
    state.switchButton = switchBtn;
    state.playerMenu = menu;

    appendToBodyWhenReady(wrap);
    updateButtons();
  }

  function updateRestoreButton() {
    if (!state.restoreButton) return;
    const shouldShow = !!(state.overlay && state.isMinimized && state.currentPlayUrl);
    state.restoreButton.style.display = shouldShow ? 'flex' : 'none';
  }

  function updateButtons() {
    const best = getBestVariant();

    if (state.playButton) {
      state.playButton.textContent = best
        ? `播放最高画质（${formatVariantShort(best)}）`
        : '播放最高画质';
    }

    if (state.switchButton) {
      state.switchButton.textContent = `选择播放器：${playerName()}`;
    }

    if (state.playerMenu) {
      const items = state.playerMenu.querySelectorAll('.__cmcc4k_menu_item__');
      items.forEach(item => {
        const type = item.dataset.playerType || '';
        item.classList.toggle('current', type === state.playerType);
        item.textContent = playerName(type);
      });
    }

    updateRestoreButton();
    updateOverlayTitle();
  }

  function setPlayerType(type) {
    const nextType = normalizePlayerType(type);
    closePlayerMenu();

    if (state.playerType === nextType) {
      updateButtons();
      toast(`当前播放器：${playerName()}`);
      return;
    }

    state.playerType = nextType;
    safeGMSet(STORAGE_KEY, state.playerType);
    updateButtons();

    if (state.overlay && state.currentPlayUrl && !state.isMinimized) {
      renderCurrentPlayer();
      toast(`已切换为 ${playerName()}，当前播放器已重建`);
      return;
    }

    toast(`当前播放器：${playerName()}`);
  }

  function ensureOverlayShell() {
    if (state.overlay) return;

    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed;
      inset: 0;
      background: #000;
      z-index: 9999999;
      display: none;
      flex-direction: column;
    `;

    const topbar = document.createElement('div');
    topbar.style.cssText = `
      height: 50px;
      flex: 0 0 50px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 14px;
      color: #fff;
      background: rgba(0,0,0,.65);
      font-size: 14px;
      gap: 12px;
    `;

    const titleEl = document.createElement('div');
    titleEl.style.cssText = `
      flex: 1 1 auto;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: 1.2;
    `;
    titleEl.textContent = '播放器';

    const actions = document.createElement('div');
    actions.style.cssText = `
      display: flex;
      gap: 10px;
      align-items: center;
      flex: 0 0 auto;
    `;

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.textContent = '复制播放地址';
    copyBtn.style.cssText = `
      border:0;background:#333;color:#fff;padding:6px 10px;border-radius:6px;cursor:pointer;
    `;
    copyBtn.onclick = () => {
      if (!state.currentPlayUrl) {
        toast('当前没有可复制的播放地址');
        return;
      }
      GM_setClipboard(state.currentPlayUrl);
      toast('已复制当前播放地址');
    };

    const miniBtn = document.createElement('button');
    miniBtn.type = 'button';
    miniBtn.textContent = '最小化';
    miniBtn.style.cssText = `
      border:0;background:#faad14;color:#fff;padding:6px 10px;border-radius:6px;cursor:pointer;
    `;
    miniBtn.onclick = minimizeOverlay;

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '关闭';
    closeBtn.style.cssText = `
      border:0;background:#ff4d4f;color:#fff;padding:6px 10px;border-radius:6px;cursor:pointer;
    `;
    closeBtn.onclick = removeOverlay;

    actions.appendChild(copyBtn);
    actions.appendChild(miniBtn);
    actions.appendChild(closeBtn);

    topbar.appendChild(titleEl);
    topbar.appendChild(actions);

    const content = document.createElement('div');
    content.style.cssText = `
      flex: 1 1 auto;
      min-height: 0;
      background: #000;
      position: relative;
    `;

    overlay.appendChild(topbar);
    overlay.appendChild(content);
    document.documentElement.appendChild(overlay);

    state.overlay = overlay;
    state.overlayContent = content;
    state.overlayTitleEl = titleEl;
    state.isMinimized = false;
  }

  function updateOverlayTitle() {
    refreshCurrentVideoName(false);
    if (!state.overlayTitleEl) return;
    state.overlayTitleEl.textContent = buildOverlayTitleText();
  }

  function pausePagePlayerIfPlaying() {
    try {
      const buttons = document.querySelectorAll(
        'div.vjs-control-bar button.vjs-play-control.vjs-control.vjs-button'
      );

      for (const btn of buttons) {
        if (btn.classList.contains('vjs-playing')) {
          btn.click();
          log('已触发页面原播放器暂停');
          return true;
        }
      }
    } catch (e) {
      log('pausePagePlayerIfPlaying error:', e);
    }

    return false;
  }

  function pauseCurrentPlayback() {
    try {
      if (state.art && typeof state.art.pause === 'function') {
        state.art.pause();
        return;
      }
    } catch (e) {}

    try {
      if (state.dp && typeof state.dp.pause === 'function') {
        state.dp.pause();
        return;
      }
    } catch (e) {}

    try {
      if (state.video) state.video.pause();
    } catch (e) {}
  }

  function showOverlay() {
    if (!state.overlay) return;
    closePlayerMenu();
    pausePagePlayerIfPlaying();
    state.overlay.style.display = 'flex';
    state.isMinimized = false;
    updateButtons();
    updateOverlayTitle();
  }

  function restoreOverlay() {
    if (!state.overlay) return;

    if (state.currentPlayUrl && state.renderedPlayerType && state.renderedPlayerType !== state.playerType) {
      renderCurrentPlayer();
    }

    showOverlay();
    toast('播放器弹窗已恢复显示');
  }

  function minimizeOverlay() {
    if (!state.overlay) return;

    pauseCurrentPlayback();
    state.overlay.style.display = 'none';
    state.isMinimized = true;
    updateButtons();

    toast('播放器已最小化并暂停');
  }

  function destroyHlsInstance(hls) {
    if (!hls) return;
    try {
      hls.destroy();
    } catch (e) {}
  }

  function clearPlayerInstances() {
    const artHls = state.art && state.art.__cmccHls__ ? state.art.__cmccHls__ : null;
    const dpHls = state.dp && state.dp.__cmccHls__ ? state.dp.__cmccHls__ : null;

    try {
      if (state.video) state.video.pause();
    } catch (e) {}

    if (artHls) destroyHlsInstance(artHls);
    if (dpHls && dpHls !== artHls) destroyHlsInstance(dpHls);
    if (state.hls && state.hls !== artHls && state.hls !== dpHls) destroyHlsInstance(state.hls);

    state.hls = null;

    if (state.art) {
      try {
        state.art.destroy();
      } catch (e) {}
      state.art = null;
    }

    if (state.dp) {
      try {
        state.dp.destroy();
      } catch (e) {}
      state.dp = null;
    }

    if (state.video) {
      try {
        state.video.removeAttribute('src');
        state.video.load();
      } catch (e) {}
      state.video = null;
    }

    if (state.overlayContent) {
      state.overlayContent.innerHTML = '';
    }

    state.renderedPlayerType = '';
  }

  function removeOverlay() {
    clearPlayerInstances();
    closePlayerMenu();

    if (state.overlay) {
      try {
        state.overlay.remove();
      } catch (e) {}
    }

    state.overlay = null;
    state.overlayContent = null;
    state.overlayTitleEl = null;
    state.currentPlayUrl = '';
    state.currentResolution = '';
    state.currentVideoName = '';
    state.isMinimized = false;

    updateButtons();
  }

  function createOverlayPlayer(playUrl, resolutionLabel) {
    ensureOverlayShell();

    state.currentPlayUrl = playUrl;
    state.currentResolution = resolutionLabel || '';
    refreshCurrentVideoName(true);

    renderCurrentPlayer();
    showOverlay();
  }

  function renderCurrentPlayer() {
    if (!state.overlayContent || !state.currentPlayUrl) return;

    clearPlayerInstances();

    if (state.playerType === PLAYER_ART) {
      renderArtPlayer(state.overlayContent, state.currentPlayUrl);
    } else if (state.playerType === PLAYER_DPLAYER) {
      renderDPlayer(state.overlayContent, state.currentPlayUrl);
    } else {
      renderHTML5Player(state.overlayContent, state.currentPlayUrl);
    }

    state.renderedPlayerType = state.playerType;
    updateOverlayTitle();
  }

  function renderHTML5Player(container, playUrl) {
    const video = document.createElement('video');
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.volume = 1;
    video.style.cssText = `
      width: 100%;
      height: 100%;
      background: #000;
      display: block;
    `;

    container.appendChild(video);
    state.video = video;
    setVideoVolumeToMax(video);

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = playUrl;
      video.play().catch(() => {});
      return;
    }

    if (window.Hls && Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        capLevelToPlayerSize: false,
      });

      state.hls = hls;
      hls.loadSource(playUrl);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setVideoVolumeToMax(video);
        video.play().catch(() => {});
      });

      hls.on(Hls.Events.ERROR, (event, data) => {
        console.warn('[CMCC-4K] HTML5 HLS error:', data);
      });

      return;
    }

    toast('当前浏览器不支持 HLS 播放');
  }

  function renderArtPlayer(container, playUrl) {
    if (!window.Artplayer) {
      toast('ArtPlayer 未加载，已回退到 HTML5');
      state.playerType = PLAYER_HTML5;
      safeGMSet(STORAGE_KEY, state.playerType);
      updateButtons();
      renderHTML5Player(container, playUrl);
      return;
    }

    const host = document.createElement('div');
    host.style.cssText = `
      width: 100%;
      height: 100%;
      background: #000;
    `;
    container.appendChild(host);

    const art = new window.Artplayer({
      container: host,
      url: playUrl,
      type: 'm3u8',
      autoplay: true,
      autoMini: false,
      fullscreen: true,
      fullscreenWeb: true,
      pip: true,
      setting: true,
      playbackRate: true,
      aspectRatio: true,
      hotkey: true,
      mutex: true,
      theme: '#1677ff',
      volume: 1,
      moreVideoAttr: {
        playsinline: true,
        'webkit-playsinline': 'true',
        'x5-playsinline': 'true',
        crossorigin: 'anonymous',
      },
      customType: {
        m3u8(video, url, artInstance) {
          setVideoVolumeToMax(video);

          if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = url;
            return;
          }

          if (window.Hls && Hls.isSupported()) {
            const hls = new Hls({
              enableWorker: true,
              lowLatencyMode: false,
              capLevelToPlayerSize: false,
            });

            artInstance.__cmccHls__ = hls;
            state.hls = hls;

            hls.loadSource(url);
            hls.attachMedia(video);

            hls.on(Hls.Events.MANIFEST_PARSED, () => {
              setVideoVolumeToMax(video);
            });

            hls.on(Hls.Events.ERROR, (event, data) => {
              console.warn('[CMCC-4K] ArtPlayer HLS error:', data);
            });
            return;
          }

          toast('当前浏览器不支持 HLS 播放');
        },
      },
    });

    state.art = art;
    state.video = art.video || host.querySelector('video') || null;
    setArtVolumeToMax(art);
    setTimeout(() => setArtVolumeToMax(art), 200);
  }

  function renderDPlayer(container, playUrl) {
    ensureDPlayerCss();

    if (!window.DPlayer) {
      toast('DPlayer 未加载，已回退到 HTML5');
      state.playerType = PLAYER_HTML5;
      safeGMSet(STORAGE_KEY, state.playerType);
      updateButtons();
      renderHTML5Player(container, playUrl);
      return;
    }

    const host = document.createElement('div');
    host.style.cssText = `
      width: 100%;
      height: 100%;
      background: #000;
    `;
    container.appendChild(host);

    const dp = new window.DPlayer({
      container: host,
      autoplay: true,
      hotkey: true,
      screenshot: false,
      airplay: true,
      theme: '#1677ff',
      preload: 'auto',
      volume: 1,
      mutex: true,
      playbackSpeed: [0.5, 0.75, 1, 1.25, 1.5, 2],
      video: {
        url: playUrl,
        type: 'customHls',
        customType: {
          customHls(video, player) {
            setVideoVolumeToMax(video);

            const sourceUrl =
              video.src ||
              (player && player.options && player.options.video && player.options.video.url) ||
              playUrl;

            if (video.canPlayType('application/vnd.apple.mpegurl')) {
              video.src = sourceUrl;
              return;
            }

            if (window.Hls && Hls.isSupported()) {
              const hls = new Hls({
                enableWorker: true,
                lowLatencyMode: false,
                capLevelToPlayerSize: false,
              });

              player.__cmccHls__ = hls;
              state.hls = hls;

              hls.loadSource(sourceUrl);
              hls.attachMedia(video);

              hls.on(Hls.Events.MANIFEST_PARSED, () => {
                setVideoVolumeToMax(video);
                video.play().catch(() => {});
              });

              hls.on(Hls.Events.ERROR, (event, data) => {
                console.warn('[CMCC-4K] DPlayer HLS error:', data);
              });
              return;
            }

            toast('当前浏览器不支持 HLS 播放');
          },
        },
      },
    });

    state.dp = dp;
    state.video = dp.video || host.querySelector('video') || null;
    setDPlayerVolumeToMax(dp);
    setTimeout(() => setDPlayerVolumeToMax(dp), 200);
  }

  function openBest() {
    const best = getBestVariant();
    if (!best) {
      toast('还没捕获到 m3u8，请刷新页面后重新播放一次');
      return;
    }

    const nextUrl = best.url;
    const nextResolution = formatVariantShort(best);

    if (state.overlay && state.isMinimized) {
      if (state.currentPlayUrl === nextUrl) {
        state.currentResolution = nextResolution;
        refreshCurrentVideoName(true);
        restoreOverlay();
        return;
      }

      createOverlayPlayer(nextUrl, nextResolution);
      toast('检测到新的播放源，已切换');
      return;
    }

    if (state.overlay) {
      if (state.currentPlayUrl === nextUrl) {
        state.currentResolution = nextResolution;
        refreshCurrentVideoName(true);
        updateOverlayTitle();
        showOverlay();
        toast('当前已在播放最高画质');
        return;
      }

      createOverlayPlayer(nextUrl, nextResolution);
      toast('已切换到新的播放源');
      return;
    }

    createOverlayPlayer(nextUrl, nextResolution);
  }

  function observePageTitle() {
    const start = () => {
      if (!document.body) {
        setTimeout(start, 300);
        return;
      }

      const observer = new MutationObserver(() => {
        const latest = getPageVideoTitle();
        if (latest && latest !== state.currentVideoName) {
          state.currentVideoName = latest;
          updateOverlayTitle();
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });

      const latest = getPageVideoTitle();
      if (latest) {
        state.currentVideoName = latest;
        updateOverlayTitle();
      }
    };

    start();
  }

  hookFetch();
  hookXHR();
  ensureButtons();
  ensureDPlayerCss();
  observePageTitle();

  document.addEventListener('click', (e) => {
    if (!isPlayerMenuOpen()) return;
    if (!state.switchBox) return;
    if (state.switchBox.contains(e.target)) return;
    closePlayerMenu();
  }, true);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (isPlayerMenuOpen()) {
        closePlayerMenu();
        return;
      }

      if (state.overlay && !state.isMinimized) {
        removeOverlay();
      }
    }
  });

  window.__CMCC4K__ = {
    state,
    openBest,
    removeOverlay,
    minimizeOverlay,
    restoreOverlay,
    showOverlay,
    togglePlayerMenu,
    closePlayerMenu,
    setPlayerType,
    getBestVariant,
  };
})();
