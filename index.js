// ==UserScript==
// @name         中国移动云盘外置最高画质视频播放器
// @namespace    cmcc-cloud-4k-player-plugin
// @version      1.0.0
// @description  捕获中国移动云盘 HLS master playlist，外置播放最高画质，支持 ArtPlayer / HTML5 切换、最小化隐藏与恢复
// @match        *://*.139.com/*
// @match        *://*.mcloud.139.com/*
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @require      https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js
// @require      https://cdn.jsdelivr.net/npm/artplayer@5.2.2/dist/artplayer.js
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const PLAYER_HTML5 = 'html5';
  const PLAYER_ART = 'artplayer';
  const STORAGE_KEY = 'cmcc4k_player_type';

  const state = {
    masterUrl: '',
    masterText: '',
    variants: [],

    buttonWrap: null,
    playButton: null,
    restoreButton: null,
    switchButton: null,

    overlay: null,
    overlayContent: null,
    overlayTitleEl: null,

    currentPlayUrl: '',
    currentResolution: '',
    currentVideoName: '',

    playerType: normalizePlayerType(safeGMGet(STORAGE_KEY, PLAYER_ART)),
    renderedPlayerType: '',

    hls: null,
    art: null,
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
    return type === PLAYER_HTML5 ? PLAYER_HTML5 : PLAYER_ART;
  }

  function playerName(type = state.playerType) {
    return type === PLAYER_HTML5 ? 'HTML5' : 'ArtPlayer';
  }

  function normalizeText(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
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
        if (!node.isConnected) {
          document.body.appendChild(node);
        }
      } else {
        setTimeout(mount, 200);
      }
    };
    mount();
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
          url: new URL(uri, masterUrl).href,
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
          saveMaster(reqUrl, text);
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
              saveMaster(url, this.responseText);
            }
          }
        } catch (e) {
          log('xhr hook error:', e);
        }
      });

      return rawSend.apply(this, arguments);
    };
  }

  function ensureButtons() {
    if (state.buttonWrap && state.buttonWrap.isConnected) {
      updateButtons();
      return;
    }

    state.buttonWrap = null;
    state.playButton = null;
    state.restoreButton = null;
    state.switchButton = null;

    const wrap = document.createElement('div');
    wrap.id = '__cmcc4k_btns__';

    const playBtn = document.createElement('button');
    playBtn.className = '__cmcc4k_btn__';
    playBtn.textContent = '播放最高画质';
    playBtn.onclick = openBest;

    const restoreBtn = document.createElement('button');
    restoreBtn.className = '__cmcc4k_btn__ restore';
    restoreBtn.textContent = '恢复显示播放器弹窗';
    restoreBtn.style.display = 'none';
    restoreBtn.onclick = restoreOverlay;

    const copyBtn = document.createElement('button');
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

    const switchBtn = document.createElement('button');
    switchBtn.className = '__cmcc4k_btn__ secondary';
    switchBtn.textContent = `选择播放器：${playerName()}`;
    switchBtn.onclick = togglePlayerType;

    wrap.appendChild(playBtn);
    wrap.appendChild(restoreBtn);
    wrap.appendChild(copyBtn);
    wrap.appendChild(switchBtn);

    state.buttonWrap = wrap;
    state.playButton = playBtn;
    state.restoreButton = restoreBtn;
    state.switchButton = switchBtn;

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

    updateRestoreButton();
    updateOverlayTitle();
  }

  function setPlayerType(type) {
    state.playerType = normalizePlayerType(type);
    safeGMSet(STORAGE_KEY, state.playerType);
    updateButtons();

    if (state.overlay && state.currentPlayUrl && !state.isMinimized) {
      renderCurrentPlayer();
      toast(`已切换为 ${playerName()}，当前播放器已重建`);
      return;
    }

    toast(`当前播放器：${playerName()}`);
  }

  function togglePlayerType() {
    const next = state.playerType === PLAYER_ART ? PLAYER_HTML5 : PLAYER_ART;
    setPlayerType(next);
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
    miniBtn.textContent = '最小化';
    miniBtn.style.cssText = `
      border:0;background:#faad14;color:#fff;padding:6px 10px;border-radius:6px;cursor:pointer;
    `;
    miniBtn.onclick = minimizeOverlay;

    const closeBtn = document.createElement('button');
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
      if (state.video) {
        state.video.pause();
      }
    } catch (e) {}
  }

  function showOverlay() {
    if (!state.overlay) return;

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

    if (artHls) {
      destroyHlsInstance(artHls);
    }

    if (state.hls && state.hls !== artHls) {
      destroyHlsInstance(state.hls);
    }

    state.hls = null;

    if (state.art) {
      try {
        state.art.destroy();
      } catch (e) {}
      state.art = null;
    }

    if (state.video) {
      try {
        state.video.pause();
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

    if (state.playerType === PLAYER_HTML5) {
      renderHTML5Player(state.overlayContent, state.currentPlayUrl);
    } else {
      renderArtPlayer(state.overlayContent, state.currentPlayUrl);
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
    video.style.cssText = `
      width: 100%;
      height: 100%;
      background: #000;
      display: block;
    `;

    container.appendChild(video);
    state.video = video;

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
      moreVideoAttr: {
        playsinline: true,
        'webkit-playsinline': 'true',
        'x5-playsinline': 'true',
        crossorigin: 'anonymous',
      },
      customType: {
        m3u8(video, url, artInstance) {
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
    state.video = art.video || null;
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
  observePageTitle();

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.overlay && !state.isMinimized) {
      removeOverlay();
    }
  });

  window.__CMCC4K__ = {
    state,
    openBest,
    removeOverlay,
    minimizeOverlay,
    restoreOverlay,
    showOverlay,
    togglePlayerType,
    setPlayerType,
    getBestVariant,
  };
})();
