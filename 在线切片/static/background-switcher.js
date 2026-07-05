// ── 移动端滚动锁：同步注入样式，确保首帧前生效 ──
;(function(){
  if(typeof history!=='undefined'&&history.scrollRestoration)history.scrollRestoration='manual';
  try{if('virtualKeyboard' in navigator){navigator.virtualKeyboard.overlaysContent=true;}}catch(e){}
  try{document.documentElement.style.setProperty('--bg-full-vh',window.innerHeight+'px');}catch(e){}
  var s=document.createElement('style');
  s.id='bg-sw-scroll-lock';
  s.textContent=
    'html:not(.bg-switcher-page-revealed){overflow:hidden!important}'+
    'html:not(.bg-switcher-page-revealed) body{overflow:hidden!important;width:100%!important;overscroll-behavior:none}'+
    'html:not(.bg-switcher-page-revealed):not(.bg-switcher-auth-active) body{position:fixed!important}';
  (document.head||document.documentElement).appendChild(s);
  try{window.scrollTo(0,0)}catch(e){}
})();

const BackgroundSwitcher = (function () {
  const DEFAULTS = {
    silent: true,
    transitionDuration: 1000,
    zIndex: -999999,
    loaderText: '背景加载中',
    decodingText: '正在解析图片',
    applyingText: '正在显示页面',
    errorText: '加载失败，请稍后重试',
    loaderFadeDuration: 350
  };

  const HIDDEN_CSS_ID = 'bg-switcher-hidden-style';
  const LOADER_ID = 'bg-switcher-full-mask';
  const COLOR_HEX_REGEX = /^#[0-9a-fA-F]{6}$/;

  let _config = {};
  let _isTransitioning = false;
  let _currentBlobUrl = null;
  let _lastImageName = '';
  let _pageHiddenBySwitcher = false;
  let _pendingColors = null;
  let _autoRefreshTimer = null;
  let _autoRefreshInterval = 0;
  let _autoRefreshUrl = '';
  let _readyCallback = null;
  let _currentController = null;
  let _retryCount = 0;
  let _maxRetries = 3;
  let _retryDelays = [1000, 3000, 10000];

  function whenBodyReady(callback) {
    if (typeof document === 'undefined') return;

    if (document.body) {
      callback();
      return;
    }

    document.addEventListener('DOMContentLoaded', callback, { once: true });
  }

  function waitForBody() {
    return new Promise((resolve) => {
      whenBodyReady(resolve);
    });
  }

  function clampProgress(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(100, Math.round(value)));
  }

  function buildRequestUrl(url) {
    const sep = url.includes('?') ? '&' : '?';
    let result = `${url}${sep}_t=${Date.now()}`;
    if (_lastImageName) {
      result += `&exclude=${encodeURIComponent(_lastImageName)}`;
    }
    return result;
  }

  function ensureHiddenCss() {
    if (typeof document === 'undefined' || document.getElementById(HIDDEN_CSS_ID)) return;

    const mountPoint = document.head || document.documentElement;
    if (!mountPoint) return;

    const style = document.createElement('style');
    style.id = HIDDEN_CSS_ID;
    style.textContent = `
      html, body {
        margin: 0;
        padding: 0;
      }

      .bg-switcher-layer-active {
        width: 100vw !important;
        right: auto !important;
        bottom: auto !important;
        height: var(--bg-full-vh, 100vh) !important;        will-change: transform;      }

      @supports (height: 100lvh) {
        .bg-switcher-layer-active {
          height: 100lvh !important;
        }
      }

      html.bg-switcher-page-hidden > body > *:not(#${LOADER_ID}):not(.bg-switcher-layer-active):not(#__ag_overlay):not(#__ag_style):not(#siteIntroOverlay):not(#modalOverlay):not(#uploadModalOverlay):not(#clipListModalOverlay):not(#historyModalOverlay):not(#clipPreviewOverlay):not(#fileTreeModalOverlay):not(#progressModalOverlay):not(#allPreviewOverlay):not(#timelineTooltip) {
        visibility: hidden !important;
      }

      @keyframes bg-switcher-content-reveal {
        from { opacity: 0; }
        to   { opacity: 1; }
      }

      html.bg-switcher-page-revealed > body > *:not(#${LOADER_ID}):not(.bg-switcher-layer-active):not(#__ag_overlay):not(#__ag_style):not(script):not(#siteIntroOverlay):not(#modalOverlay):not(#uploadModalOverlay):not(#clipListModalOverlay):not(#historyModalOverlay):not(#clipPreviewOverlay):not(#fileTreeModalOverlay):not(#progressModalOverlay):not(#allPreviewOverlay):not(#timelineTooltip) {
        animation: bg-switcher-content-reveal 0.8s ease both;
      }
    `;
    mountPoint.appendChild(style);
  }

  ensureHiddenCss();

  function setPageVisibility(hidden) {
    if (typeof document === 'undefined') return;

    ensureHiddenCss();

    const root = document.documentElement;
    if (!root) return;

    if (hidden && !_pageHiddenBySwitcher) {
      root.classList.add('bg-switcher-page-hidden');
      _pageHiddenBySwitcher = true;
      return;
    }

    if (!hidden && _pageHiddenBySwitcher) {
      root.classList.remove('bg-switcher-page-hidden');
      root.classList.add('bg-switcher-page-revealed');
      _pageHiddenBySwitcher = false;
    }
  }

  function ensureLoader() {
    if (typeof document === 'undefined' || !document.body) return null;

    let loader = document.getElementById(LOADER_ID);
    if (loader) return loader;

    loader = document.createElement('div');
    loader.id = LOADER_ID;
    loader.setAttribute('role', 'status');
    loader.setAttribute('aria-live', 'polite');

    Object.assign(loader.style, {
      position: 'fixed',
      inset: '0',
      background: '#0c0c14',
      color: '#ffffff',
      display: 'none',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: '2147483647',
      opacity: '0',
      transition: `opacity ${DEFAULTS.loaderFadeDuration}ms ease`,
      fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif'
    });

    loader.innerHTML = `
      <div style="position:relative;width:120px;height:120px;">
        <svg viewBox="0 0 100 100" style="width:100%;height:100%;transform:rotate(-90deg);">
          <circle cx="50" cy="50" r="44" fill="none" stroke="rgba(255,255,255,.05)" stroke-width="1.5"/>
          <circle id="bg-sw-ring" cx="50" cy="50" r="44" fill="none"
            stroke="rgba(255,255,255,.25)" stroke-width="1.5" stroke-linecap="round"
            stroke-dasharray="276.46" stroke-dashoffset="276.46"
            style="transition:stroke-dashoffset .3s ease,stroke 1.5s ease;"/>
        </svg>
        <div id="bg-switcher-loader-percent" style="
          position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
          font-size:1.5rem;font-weight:200;letter-spacing:2px;opacity:.85;
        ">0%</div>
      </div>
      <div style="margin-top:20px;font-size:.75rem;font-weight:300;letter-spacing:1px;opacity:.35;text-transform:uppercase;">Loading</div>
    `;

    document.documentElement.appendChild(loader);
    return loader;
  }

  function updateLoader(text, progress) {
    const loader = ensureLoader();
    if (!loader) {
      whenBodyReady(() => updateLoader(text, progress));
      return;
    }

    const ring = document.getElementById('bg-sw-ring');
    const percentEl = document.getElementById('bg-switcher-loader-percent');
    const safeProgress = clampProgress(progress);

    if (ring) {
      ring.setAttribute('stroke-dashoffset', String(276.46 * (1 - safeProgress / 100)));
    }

    if (percentEl) {
      percentEl.textContent = `${safeProgress}%`;
    }
  }

  function showLoader(text, progress) {
    const loader = ensureLoader();
    if (!loader) {
      whenBodyReady(() => showLoader(text, progress));
      return;
    }

    updateLoader(text, progress);
    loader.style.display = 'flex';
    loader.offsetWidth;
    loader.style.opacity = '1';
  }

  function hideLoader(onHidden) {
    const loader = document.getElementById(LOADER_ID);
    if (!loader) {
      if (typeof onHidden === 'function') onHidden();
      return;
    }

    loader.style.opacity = '0';

    window.setTimeout(() => {
      loader.style.display = 'none';
      if (typeof onHidden === 'function') onHidden();
    }, _config.loaderFadeDuration || DEFAULTS.loaderFadeDuration);
  }

  function validateColorHex(value) {
    if (typeof value !== 'string') return null;
    return COLOR_HEX_REGEX.test(value) ? value : null;
  }

  function applyLoaderTheme(themeColor) {
    const loader = document.getElementById(LOADER_ID);
    if (!loader) return;

    const validColor = validateColorHex(themeColor);
    if (!validColor) return;

    loader.style.transition = `opacity ${DEFAULTS.loaderFadeDuration}ms ease, background-color 2s ease`;
    loader.style.backgroundColor = `color-mix(in srgb, ${themeColor} 12%, #0c0c14)`;

    const ring = document.getElementById('bg-sw-ring');
    if (ring) {
      ring.style.stroke = `color-mix(in srgb, ${themeColor} 70%, #fff)`;
    }
  }

  function showLoaderRetry(errorText, retryUrl) {
    const loader = ensureLoader();
    if (!loader) return;

    loader.innerHTML =
      '<div style="display:flex;flex-direction:column;align-items:center;gap:20px;width:min(300px,75vw);text-align:center;">' +
        '<svg viewBox="0 0 24 24" width="52" height="52" fill="none" stroke="rgba(167,139,250,.6)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
          '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>' +
        '</svg>' +
        '<div style="font-size:.95rem;font-weight:300;color:rgba(255,255,255,.7);line-height:1.5;">' + escapeHtml(errorText) + '</div>' +
        '<button id="bg-switcher-retry-btn" style="' +
          'padding:.65rem 2.2rem;border:1px solid rgba(167,139,250,.3);border-radius:10px;' +
          'background:rgba(167,139,250,.08);color:rgba(255,255,255,.85);font-size:.9rem;font-weight:400;' +
          'letter-spacing:.5px;cursor:pointer;transition:all .25s ease;backdrop-filter:blur(4px);' +
        '">' + '\u91CD\u65B0\u52A0\u8F7D' + '</button>' +
      '</div>';

    loader.style.display = 'flex';
    loader.style.opacity = '1';

    var btn = document.getElementById('bg-switcher-retry-btn');
    if (btn) {
      btn.addEventListener('mouseenter', function () {
        btn.style.background = 'rgba(167,139,250,.18)';
        btn.style.borderColor = 'rgba(167,139,250,.5)';
      });
      btn.addEventListener('mouseleave', function () {
        btn.style.background = 'rgba(167,139,250,.08)';
        btn.style.borderColor = 'rgba(167,139,250,.3)';
      });
      btn.addEventListener('click', function () {
        var l = document.getElementById(LOADER_ID);
        if (l) l.remove();
        _retryCount = 0;
        BackgroundSwitcher.init(retryUrl, { silent: false });
      });
    }
  }

  function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function waitForImageReady(image) {
    return new Promise((resolve, reject) => {
      if (image.complete && image.naturalWidth > 0) {
        resolve();
        return;
      }

      const onLoad = () => {
        cleanup();
        resolve();
      };

      const onError = () => {
        cleanup();
        reject(new Error('Image decode failed'));
      };

      const cleanup = () => {
        image.removeEventListener('load', onLoad);
        image.removeEventListener('error', onError);
      };

      image.addEventListener('load', onLoad, { once: true });
      image.addEventListener('error', onError, { once: true });
    });
  }

  async function decodeImage(image) {
    if (typeof image.decode === 'function') {
      try {
        await image.decode();
        return;
      } catch (error) {
        // Fall back to onload for browsers that reject decode on cached images.
      }
    }

    await waitForImageReady(image);
  }

  function extractColorHeaders(headers) {
    const map = {
      'X-Theme-Color-Hex': '--bg-image-theme-color',
      'X-Text-Color-Hex': '--bg-image-text-color'
    };
    const colors = {};
    for (const [header, cssVar] of Object.entries(map)) {
      const value = headers.get(header);
      const validated = validateColorHex(value);
      if (validated) colors[cssVar] = validated;
    }
    return colors;
  }

  function applyColors(colors) {
    const root = document.documentElement;
    if (!root) return;
    for (const [cssVar, value] of Object.entries(colors)) {
      if (validateColorHex(value)) {
        root.style.setProperty(cssVar, value);
      }
    }
  }

  async function fetchImageAsBlob(url, signal, onProgress, onHeaders) {
    const response = await fetch(buildRequestUrl(url), { signal });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    _lastImageName = response.headers.get('X-Image-Id') || '';

    _pendingColors = extractColorHeaders(response.headers);

    if (typeof onHeaders === 'function') onHeaders(_pendingColors);

    const total = Number.parseInt(response.headers.get('Content-Length') || '0', 10);
    const hasStream = response.body && typeof response.body.getReader === 'function';

    if (!hasStream) {
      const blob = await response.blob();
      if (typeof onProgress === 'function') onProgress(90);
      return blob;
    }

    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    let fallbackChunks = 0;

    if (typeof onProgress === 'function') onProgress(0);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (!value) continue;

      chunks.push(value);
      received += value.byteLength;
      fallbackChunks += 1;

      if (typeof onProgress === 'function') {
        if (total > 0) {
          onProgress((received / total) * 90);
        } else {
          onProgress(Math.min(90, 8 + fallbackChunks * 6));
        }
      }
    }

    if (typeof onProgress === 'function') onProgress(90);
    return new Blob(chunks);
  }

  return {
    async init(apiUrl, options = {}) {
      if (_isTransitioning) return;

      if (_currentController) {
        _currentController.abort();
      }
      _currentController = new AbortController();

      _config = Object.assign({}, DEFAULTS, options);
      _isTransitioning = true;

      if (_autoRefreshTimer) {
        clearTimeout(_autoRefreshTimer);
        _autoRefreshTimer = null;
      }

      const silent = !!_config.silent;
      let nextBlobUrl = null;

      if (!silent) {
        setPageVisibility(true);
        showLoader(_config.loaderText, 0);
      }

      try {
        await waitForBody();

        const blob = await fetchImageAsBlob(
          apiUrl,
          _currentController.signal,
          (progress) => {
            if (!silent) {
              const safeProgress = clampProgress(progress);
              showLoader(`${_config.loaderText} ${safeProgress}%`, safeProgress);
            }
          },
          (colors) => {
            if (!silent && colors['--bg-image-theme-color']) {
              applyLoaderTheme(colors['--bg-image-theme-color']);
            }
          }
        );

        nextBlobUrl = URL.createObjectURL(blob);

        if (!silent) showLoader(`${_config.decodingText} 95%`, 95);

        const tempImg = new Image();
        tempImg.src = nextBlobUrl;
        await decodeImage(tempImg);

        await waitForBody();

        const oldLayer = document.querySelector('.bg-switcher-layer-active');
        const newLayer = document.createElement('div');
        newLayer.className = 'bg-switcher-layer-active';

        Object.assign(newLayer.style, {
          position: 'fixed',
          inset: '0',
          zIndex: String(_config.zIndex),
          backgroundImage: `url('${nextBlobUrl}')`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundRepeat: 'no-repeat',
          opacity: '0',
          transition: document.hidden
            ? 'none'
            : `opacity ${_config.transitionDuration}ms ease`
        });

        document.documentElement.appendChild(newLayer);

        if (document.hidden) {
          newLayer.style.opacity = '1';
        } else {
          newLayer.getBoundingClientRect();
          newLayer.style.opacity = '1';
        }
        if (_pendingColors) {
          applyColors(_pendingColors);
          _pendingColors = null;
        }

        if (!silent) {
          showLoader(`${_config.applyingText} 100%`, 100);
          hideLoader(() => {
            if (_readyCallback) {
              _readyCallback();
              _readyCallback = null;
            } else {
              window.setTimeout(() => {
                setPageVisibility(false);
              }, 2000);
            }
          });
        }

        window.setTimeout(() => {
          if (oldLayer) {
            oldLayer.remove();
          }

          if (_currentBlobUrl) {
            URL.revokeObjectURL(_currentBlobUrl);
          }

          _currentBlobUrl = nextBlobUrl;
          nextBlobUrl = null;
          _isTransitioning = false;
          _retryCount = 0;
          _currentController = null;
          scheduleAutoRefresh();
        }, _config.transitionDuration + 50);
      } catch (error) {
        if (error.name === 'AbortError') {
          if (nextBlobUrl) URL.revokeObjectURL(nextBlobUrl);
          _isTransitioning = false;
          return;
        }

        console.error('BackgroundSwitcher load failed:', error);

        if (nextBlobUrl) {
          URL.revokeObjectURL(nextBlobUrl);
        }

        _isTransitioning = false;
        _currentController = null;

        if (!silent) {
          showLoaderRetry(_config.errorText, apiUrl);
        } else {
          scheduleAutoRefreshWithBackoff();
        }
      }
    },

    setAutoRefresh(url, intervalSec) {
      _autoRefreshUrl = url;
      _autoRefreshInterval = intervalSec > 0 ? intervalSec : 0;
    },

    onReady(fn) {
      _readyCallback = fn;
    },

    revealPage() {
      setPageVisibility(false);
    },

    destroy() {
      if (_currentController) {
        _currentController.abort();
        _currentController = null;
      }
      if (_autoRefreshTimer) {
        clearTimeout(_autoRefreshTimer);
        _autoRefreshTimer = null;
      }
    }
  };

  function scheduleAutoRefresh() {
    if (!(_autoRefreshInterval > 0) || !_autoRefreshUrl) return;
    _autoRefreshTimer = setTimeout(function () {
      _autoRefreshTimer = null;
      BackgroundSwitcher.init(_autoRefreshUrl).then(null, function () {});
    }, _autoRefreshInterval * 1000);
  }

  function scheduleAutoRefreshWithBackoff() {
    if (!(_autoRefreshInterval > 0) || !_autoRefreshUrl) return;

    if (_retryCount >= _maxRetries) {
      _retryCount = 0;
      return;
    }

    const delay = _retryDelays[_retryCount] || _retryDelays[_retryDelays.length - 1];
    _retryCount++;

    _autoRefreshTimer = setTimeout(function () {
      _autoRefreshTimer = null;
      BackgroundSwitcher.init(_autoRefreshUrl).then(null, function () {});
    }, delay);
  }
})();

/* ═══════════════════════════════════════════════════════════════════════════
 * AuthGuard — PHP 后端验证登录拦截器
 *
 * 当 <script> 标签包含 data-auth 时自动启用。
 * 密码存储在服务端（auth-api.php），前端不暴露任何密码信息。
 * 未登录时在背景图之上显示登录遮罩，支持 Bitwarden 等密码管理器自动填充。
 *
 * data 属性：
 *   data-auth    后端验证接口地址（如 auth-api.php），设置即启用登录
 *
 * 页面中可调用 AuthGuard.logout() 退出登录。
 * ═══════════════════════════════════════════════════════════════════════════ */
var AuthGuard = (function () {
  'use strict';

  var STORAGE_KEY = '__ag_token';
  var _authApi = '';
  var _onLoginSuccess = null;

  function dismissOverlay() {
    document.documentElement.classList.remove('bg-switcher-auth-active');
    var ol = document.getElementById('__ag_overlay');
    if (ol) {
      ol.style.opacity = '0';
      setTimeout(function () { ol.remove(); }, 350);
    }
    var st = document.getElementById('__ag_style');
    if (st) setTimeout(function () { st.remove(); }, 400);
  }

  function injectStyle() {
    if (document.getElementById('__ag_style')) return;
    var s = document.createElement('style');
    s.id = '__ag_style';
    s.textContent =
      '@keyframes __ag_fadeIn{from{opacity:0}to{opacity:1}}' +
      '@keyframes __ag_slideUp{from{opacity:0;transform:translateY(24px) scale(.96)}to{opacity:1;transform:translateY(0) scale(1)}}' +
      '@keyframes __ag_shake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-6px)}40%,80%{transform:translateX(6px)}}' +

      '#__ag_overlay{' +
        'position:fixed;inset:0;z-index:2147483646;' +
        'overflow:hidden;overscroll-behavior:none;' +
        'background:rgba(0,0,0,.3);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);' +
        'animation:__ag_fadeIn .5s ease;transition:opacity .35s ease;' +
        'visibility:visible;' +
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;' +
      '}' +

      '.__ag_viewport{' +
        'position:absolute;inset:0;box-sizing:border-box;' +
        'display:flex;align-items:center;justify-content:center;' +
        'pointer-events:none;' +
        'bottom:0;' +
        'height:100%;transition:padding .36s ease;' +
      '}' +

      '.__ag_viewport.__ag_keyboard_up{' +
        'align-items:center;padding:12px 0;' +
      '}' +

      '.__ag_card{' +
        'position:relative;width:320px;max-width:88vw;pointer-events:auto;' +
        'background:color-mix(in srgb,var(--bg-image-theme-color,#1e293b) 25%,rgba(255,255,255,.88));' +
        'border-radius:18px;overflow:hidden;visibility:visible;' +
        'max-height:calc(100% - 20px);' +
        'box-shadow:0 25px 50px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.5);' +
        'animation:__ag_slideUp .5s cubic-bezier(.16,1,.3,1);' +
        '--__ag-card-shift:0px;--__ag-card-scale:1;' +
        'transform:translate3d(0,var(--__ag-card-shift),0) scale(var(--__ag-card-scale));' +
        'transform-origin:center center;' +
        'will-change:transform;' +
        'transition:width .36s ease,max-width .36s ease,border-radius .36s ease,transform .56s cubic-bezier(.22,1,.36,1);' +
      '}' +

      '.__ag_card.__ag_card_compact{' +
        '--__ag-card-scale:.96;border-radius:16px;' +
        'transition:transform .56s cubic-bezier(.22,1,.36,1),border-radius .36s ease;' +
      '}' +

      '.__ag_card.__ag_card_compact .__ag_header{' +
        'max-height:92px;padding:1rem 1.5rem .85rem;' +
      '}' +
      '.__ag_card.__ag_card_compact .__ag_header svg{' +
        'width:0;height:0;margin:0;opacity:0;' +
      '}' +
      '.__ag_card.__ag_card_compact .__ag_header p{' +
        'max-height:0;margin:0;opacity:0;overflow:hidden;' +
      '}' +
      '.__ag_card.__ag_card_compact .__ag_body{' +
        'padding:1.05rem 1.5rem 1.2rem;' +
      '}' +

      '' +

      '.__ag_header{' +
        'background:linear-gradient(135deg,' +
          'color-mix(in srgb,var(--bg-image-theme-color,#667eea) 80%,#000) 0%,' +
          'var(--bg-image-theme-color,#667eea) 50%,' +
          'color-mix(in srgb,var(--bg-image-theme-color,#667eea) 70%,#fff) 100%);' +
        'padding:1.5rem 1.8rem 1.2rem;text-align:center;' +
        'max-height:200px;opacity:1;' +
        'transition:max-height .42s cubic-bezier(.16,1,.3,1),padding .42s cubic-bezier(.16,1,.3,1),opacity .28s ease;overflow:hidden;' +
      '}' +
      '.__ag_header svg{width:38px;height:38px;margin-bottom:.4rem;opacity:.9;transition:width .36s ease,height .36s ease,margin .36s ease,opacity .24s ease;}' +
      '.__ag_header h2{margin:0;font-size:1.2rem;color:var(--bg-image-text-color,#fff);font-weight:600;letter-spacing:.3px;}' +
      '.__ag_header p{margin:.2rem 0 0;font-size:.75rem;color:var(--bg-image-text-color,#fff);opacity:.7;max-height:2em;transition:max-height .32s ease,margin .32s ease,opacity .24s ease;}' +

      '.__ag_body{padding:1.3rem 1.8rem 1.5rem;transition:padding .42s cubic-bezier(.16,1,.3,1);}' +
      '.__ag_body label.field{display:block;font-size:.75rem;color:#475569;margin-bottom:.3rem;font-weight:600;letter-spacing:.3px;' +
        'max-height:2em;opacity:1;overflow:hidden;' +
        'transition:max-height .3s ease,opacity .2s ease,margin .3s ease;' +
      '}' +

      '.__ag_fields{display:flex;flex-direction:column;transition:gap .3s ease;}' +

      '.__ag_input_wrap{position:relative;margin-bottom:.75rem;transition:margin .3s ease;}' +
      '.__ag_input_wrap svg{position:absolute;left:.7rem;top:50%;transform:translateY(-50%);width:17px;height:17px;color:#94a3b8;pointer-events:none;}' +
      '.__ag_input_wrap input{' +
        'display:block;width:100%;box-sizing:border-box;' +
        'padding:.6rem .75rem .6rem 2.4rem;' +
        'border:1.5px solid #e2e8f0;border-radius:10px;font-size:.9rem;' +
        'background:#f8fafc;color:#1e293b;outline:none;' +
        '-webkit-tap-highlight-color:transparent;' +
        'transition:border-color .2s,background .2s,box-shadow .2s,padding .3s ease,font-size .3s ease;' +
      '}' +
      '.__ag_input_wrap input:focus{' +
        'border-color:var(--bg-image-theme-color,#667eea);background:#fff;' +
        'box-shadow:0 0 0 3px color-mix(in srgb,var(--bg-image-theme-color,#667eea) 18%,transparent);' +
      '}' +
      '@media (pointer:coarse) {' +
        '.__ag_input_wrap input:focus{' +
          'box-shadow:none;border-color:var(--bg-image-theme-color,#667eea);' +
        '}' +
      '}' +
      '.__ag_input_wrap input::placeholder{color:#94a3b8;}' +
'@media (pointer:coarse) {' +
        '.__ag_input_wrap input{' +
          'font-size:16px;-webkit-user-select:none;user-select:none;' +
          'touch-action:manipulation;' +
        '}' +
      '}' +

      '.__ag_remember{' +
        'display:flex;align-items:center;margin:.2rem 0 .9rem;cursor:pointer;' +
        'max-height:50px;opacity:1;overflow:hidden;' +
        'transition:max-height .3s ease,opacity .2s ease,margin .3s ease;' +
        '-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent' +
      '}' +
      '.__ag_remember *{-webkit-tap-highlight-color:transparent}' +
      '.__ag_remember,.__ag_remember *{outline:none}' +
      '.__ag_remember input{position:absolute;opacity:0;width:0;height:0;outline:none}' +
      '.__ag_remember .check{' +
        'display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;' +
        'width:18px;height:18px;border:2px solid #cbd5e1;border-radius:4px;' +
        'margin-right:.5rem;transition:all .15s ease;background:#fff;' +
      '}' +
      '.__ag_remember input:checked~.check{' +
        'background:var(--bg-image-theme-color,#667eea);border-color:var(--bg-image-theme-color,#667eea);' +
      '}' +
      '.__ag_remember .check svg{width:12px;height:12px;stroke:#fff;stroke-width:3;fill:none;opacity:0;transition:opacity .15s;}' +
      '.__ag_remember input:checked~.check svg{opacity:1;}' +
      '.__ag_remember .text{font-size:.85rem;color:#64748b;line-height:1;}' +

      '.__ag_body button[type="submit"]{' +
        'display:block;width:100%;padding:.65rem;border:none;border-radius:10px;' +
        'background:linear-gradient(135deg,' +
          'var(--bg-image-theme-color,#667eea) 0%,' +
          'color-mix(in srgb,var(--bg-image-theme-color,#667eea) 75%,#000) 100%);' +
        'color:var(--bg-image-text-color,#fff);font-size:.95rem;font-weight:600;letter-spacing:.3px;cursor:pointer;' +
        'transition:transform .15s,box-shadow .2s,opacity .2s,padding .3s ease,font-size .3s ease;' +
        'box-shadow:0 4px 14px color-mix(in srgb,var(--bg-image-theme-color,#667eea) 40%,transparent);' +
      '}' +
      '@keyframes __ag_spin{to{transform:rotate(360deg)}}' +
      '.__ag_body button[type="submit"].__ag_loading{' +
        'position:relative;color:transparent!important;text-indent:-9999px;' +
      '}' +
      '.__ag_body button[type="submit"].__ag_loading::after{' +
        'content:"";position:absolute;inset:0;margin:auto;width:20px;height:20px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;' +
        'animation:__ag_spin .8s linear infinite;' +
      '}' +
      '.__ag_body button[type="submit"]:hover{transform:translateY(-1px);box-shadow:0 6px 20px color-mix(in srgb,var(--bg-image-theme-color,#667eea) 50%,transparent);}' +
      '.__ag_body button[type="submit"]:active{transform:translateY(0);}' +
      '.__ag_body button[type="submit"]:focus{outline:none}' +
      '.__ag_body button[type="submit"]{-webkit-tap-highlight-color:transparent}' +
      '.__ag_body button[type="submit"]:disabled{opacity:.5;cursor:not-allowed;transform:none}' +

      '.__ag_error{text-align:center;font-size:.82rem;min-height:1.2em;margin-bottom:.5rem;color:#ef4444;font-weight:500;}' +
      '.__ag_shake{animation:__ag_shake .4s ease;}';

    document.head.appendChild(s);
  }

  function createOverlay() {
    if (document.getElementById('__ag_overlay')) return;
    injectStyle();

    var overlay = document.createElement('div');
    overlay.id = '__ag_overlay';
    document.documentElement.classList.add('bg-switcher-auth-active');
    overlay.innerHTML =
      '<div class="__ag_viewport" id="__ag_vp">' +
      '<div class="__ag_card" id="__ag_card">' +
        '<div class="__ag_header">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="var(--bg-image-text-color,#fff)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
            '<rect x="3" y="11" width="18" height="11" rx="2"/>' +
            '<path d="M7 11V7a5 5 0 0 1 10 0v4"/>' +
          '</svg>' +
          '<h2>欢迎回来</h2>' +
          '<p>请登录以继续访问</p>' +
        '</div>' +
        '<div class="__ag_body">' +
          '<div id="__ag_err" class="__ag_error"></div>' +
          '<form id="__ag_form" data-bwignore="true" onsubmit="return false">' +
            '<div class="__ag_fields">' +
              '<div class="__ag_field">' +
                '<label class="field" for="__ag_u">用户名</label>' +
                '<div class="__ag_input_wrap">' +
                  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>' +
                  '<input id="__ag_u" name="username" type="text" autocomplete="username" data-bwignore="true" placeholder="请输入用户名" />' +

                '</div>' +
              '</div>' +
              '<div class="__ag_field">' +
                '<label class="field" for="__ag_p">密码</label>' +
                '<div class="__ag_input_wrap">' +
                  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>' +
                  '<input id="__ag_p" name="password" type="password" autocomplete="current-password" data-bwignore="true" placeholder="请输入密码" />' +
                '</div>' +
              '</div>' +
            '</div>' +
            '<label class="__ag_remember">' +
              '<input type="checkbox" id="__ag_rm" />' +
              '<span class="check"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></span>' +
              '<span class="text">记住登录</span>' +
            '</label>' +
            '<button type="submit">登  录</button>' +
          '</form>' +
        '</div>' +
      '</div>' +
      '</div>';

    document.body.appendChild(overlay);

    overlay.addEventListener('touchmove', function (e) {
      e.preventDefault();
    }, { passive: false });

var form   = document.getElementById('__ag_form');
    var userEl = document.getElementById('__ag_u');
    var passEl = document.getElementById('__ag_p');
    var errEl  = document.getElementById('__ag_err');
    var btn    = form.querySelector('button[type="submit"]');

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var username = userEl.value.trim();
      var password = passEl.value;
      var remember = !!document.getElementById('__ag_rm').checked;
      var hasError = false;
      if (!username) {
        userEl.style.borderColor = '#ef4444';
        userEl.style.background = '#fef2f2';
        userEl.style.color = '#991b1b';
        hasError = true;
      }
      if (!password) {
        passEl.style.borderColor = '#ef4444';
        passEl.style.background = '#fef2f2';
        passEl.style.color = '#991b1b';
        hasError = true;
      }
      if (hasError) {
        return;
      }

      btn.disabled = true;
      btn.classList.add('__ag_loading');
      btn.textContent = '登录中…';

      fetch(_authApi + '?action=login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: password, remember: remember })
      })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.success) {
          if (d.token) {
            try { localStorage.setItem(STORAGE_KEY, d.token); } catch (_) {}
          }
          dismissOverlay();
          if (_onLoginSuccess) {
            var cb = _onLoginSuccess;
            _onLoginSuccess = null;
            setTimeout(cb, 2000);
          }
        } else {
          showError(d.error || '登录失败');
          btn.disabled = false;
          btn.classList.remove('__ag_loading');
          btn.textContent = '登  录';
        }
      })
      .catch(function () {
        showError('网络错误，请重试');
        btn.disabled = false;
        btn.classList.remove('__ag_loading');
        btn.textContent = '登  录';
      });
    });

    function showError(msg) {
      errEl.textContent = msg;
      card.classList.remove('__ag_shake');
      void card.offsetWidth;
      card.classList.add('__ag_shake');
    }

    var viewport = document.getElementById('__ag_vp');
    var card = document.getElementById('__ag_card');
    var _adjustTimer = null;
    var _keyboardAdjustTimers = [];
    var _layoutViewportHeight = window.innerHeight;
    var _currentCardShift = 0;

    function getVirtualKeyboardRect() {
      try {
        if ('virtualKeyboard' in navigator && navigator.virtualKeyboard.boundingRect) {
          return navigator.virtualKeyboard.boundingRect;
        }
      } catch (_) {}
      return null;
    }

    function getKeyboardHeight() {
      var keyboardRect = getVirtualKeyboardRect();
      if (keyboardRect && keyboardRect.height > 0) {
        return keyboardRect.height;
      }

      if (window.visualViewport) {
        return Math.max(0, _layoutViewportHeight - window.visualViewport.height - (window.visualViewport.offsetTop || 0));
      }

      return 0;
    }

    function getViewportMetrics() {
      var keyboardRect = getVirtualKeyboardRect();
      if (keyboardRect && keyboardRect.height > 0) {
        return {
          top: 0,
          height: Math.max(0, _layoutViewportHeight - keyboardRect.height)
        };
      }

      if (window.visualViewport) {
        return {
          top: window.visualViewport.offsetTop || 0,
          height: window.visualViewport.height || window.innerHeight
        };
      }

      var keyboardHeight = getKeyboardHeight();
      return {
        top: 0,
        height: Math.max(0, window.innerHeight - keyboardHeight)
      };
    }

    function scheduleKeyboardAdjust() {
      for (var i = 0; i < _keyboardAdjustTimers.length; i++) {
        clearTimeout(_keyboardAdjustTimers[i]);
      }
      _keyboardAdjustTimers = [];
      adjustForKeyboard();
      _keyboardAdjustTimers.push(setTimeout(adjustForKeyboard, 160));
      _keyboardAdjustTimers.push(setTimeout(adjustForKeyboard, 360));
    }

    function adjustForKeyboard() {
      if (_adjustTimer) {
        cancelAnimationFrame(_adjustTimer);
      }
      _adjustTimer = requestAnimationFrame(function () {
        if (!viewport || !card) return;
        var isInputFocused = document.activeElement === userEl || document.activeElement === passEl;
        var keyboardHeight = getKeyboardHeight();
        var metrics = getViewportMetrics();
        var keyboardVisible = isInputFocused && keyboardHeight > 80;

        var needsCompact = keyboardVisible && metrics.height < 480;
        viewport.classList.toggle('__ag_keyboard_up', keyboardVisible);
        card.classList.toggle('__ag_card_compact', needsCompact);

        if (keyboardVisible) {
          var focusedRect = document.activeElement.getBoundingClientRect();
          var cardRect = card.getBoundingClientRect();
          var safeTop = metrics.top + 14;
          var safeBottom = metrics.top + metrics.height - 20;
          var visibleCenter = metrics.top + metrics.height / 2;
          var cardCenter = cardRect.top - _currentCardShift + cardRect.height / 2;
          var shift = visibleCenter - cardCenter;
          var focusedBottom = focusedRect.bottom - _currentCardShift;
          var cardTop = cardRect.top - _currentCardShift;

          if (focusedBottom + shift > safeBottom) {
            shift -= focusedBottom + shift - safeBottom + 12;
          }

          shift = Math.max(shift, -Math.min(180, metrics.height * 0.36));
          shift = Math.min(shift, Math.min(36, metrics.height * 0.08));

          if (cardTop + shift < safeTop) {
            shift += safeTop - (cardTop + shift);
          }

          _currentCardShift = Math.round(shift);
          card.style.setProperty('--__ag-card-shift', _currentCardShift + 'px');
        } else {
          _currentCardShift = 0;
          card.style.setProperty('--__ag-card-shift', '0px');
        }

        _adjustTimer = null;
      });
    }

    function cleanupAdjust() {
      for (var i = 0; i < _keyboardAdjustTimers.length; i++) {
        clearTimeout(_keyboardAdjustTimers[i]);
      }
      _keyboardAdjustTimers = [];
      _layoutViewportHeight = window.innerHeight;
      _currentCardShift = 0;
      card.style.setProperty('--__ag-card-shift', '0px');
      viewport.classList.remove('__ag_keyboard_up');
      card.classList.remove('__ag_card_compact');
    }

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', adjustForKeyboard);
      window.visualViewport.addEventListener('scroll', adjustForKeyboard);
    }
    try {
      if ('virtualKeyboard' in navigator) {
        navigator.virtualKeyboard.addEventListener('geometrychange', adjustForKeyboard);
      }
    } catch (_) {
    }
    window.addEventListener('resize', adjustForKeyboard);

    var _blurTimer = null;
    var _lastKeyboardHeight = 0;

    userEl.addEventListener('focus', function () {
      clearTimeout(_blurTimer);
      userEl.style.borderColor = '';
      userEl.style.background = '';
      userEl.style.color = '';
      scheduleKeyboardAdjust();
    });
    passEl.addEventListener('focus', function () {
      clearTimeout(_blurTimer);
      passEl.style.borderColor = '';
      passEl.style.background = '';
      passEl.style.color = '';
      scheduleKeyboardAdjust();
    });
    userEl.addEventListener('blur', function () {
      _blurTimer = setTimeout(adjustForKeyboard, 100);
    });
    passEl.addEventListener('blur', function () {
      _blurTimer = setTimeout(adjustForKeyboard, 100);
    });

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', function () {
        var kh = getKeyboardHeight();
        if (_lastKeyboardHeight > 0 && kh === 0) {
          cleanupAdjust();
        } else if (kh !== _lastKeyboardHeight) {
          adjustForKeyboard();
        }
        _lastKeyboardHeight = kh;
      });
    }

    var _isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

    requestAnimationFrame(function () {
      if (!_isMobile) userEl.focus();
    });
  }

  return {
    show: function (authApi, onAuthenticated) {
      _authApi = authApi;
      _onLoginSuccess = onAuthenticated;
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createOverlay);
      } else {
        createOverlay();
      }
    },

    passThrough: function (authApi, onAuthenticated) {
      _authApi = authApi;
      if (onAuthenticated) setTimeout(onAuthenticated, 2000);
    },

    logout: function () {
      try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
      fetch(_authApi + '?action=logout')
        .finally(function () {
          try { location.reload(); } catch (_) { window.location.href = window.location.href; }
        });
    }
  };
})();

/* ═══════════════════════════════════════════════════════════════════════════
 * 自动初始化
 * ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  var script = document.currentScript;
  if (!script) return;

  var apiUrl  = script.getAttribute('data-api') || script.getAttribute('data-apiUrl') || '';
  var authUrl = script.getAttribute('data-auth') || '';

  if (authUrl) {
    var savedToken = '';
    try { savedToken = localStorage.getItem('__ag_token') || ''; } catch (_) {}

    var checkHeaders = {};
    if (savedToken) checkHeaders['X-Auth-Token'] = savedToken;

    var authChecked = fetch(authUrl + '?action=check', { headers: checkHeaders })
      .then(function (r) { return r.json(); })
      .then(function (d) { return !!d.authenticated; })
      .catch(function () { return false; });

    BackgroundSwitcher.onReady(function () {
      authChecked.then(function (ok) {
        if (ok) {
          AuthGuard.passThrough(authUrl, function () {
            BackgroundSwitcher.revealPage();
          });
        } else {
          try { localStorage.removeItem('__ag_token'); } catch (_) {}
          AuthGuard.show(authUrl, function () {
            BackgroundSwitcher.revealPage();
          });
        }
      });
    });
  }

  if (apiUrl) {
    BackgroundSwitcher.init(apiUrl, { silent: false });

    var interval = parseInt(script.getAttribute('data-interval'), 10);
    if (interval > 0) {
      BackgroundSwitcher.setAutoRefresh(apiUrl, interval);
    }
  }
})();
