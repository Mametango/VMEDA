'use strict';
/**
 * VMEDA ivfree-proxy: IVFree動画ページ用プロキシ（広告除去・ポップアップ無効化）
 * api/index.js の負荷軽減のため分離
 */
const cheerio = require('cheerio');
const axios = require('axios');

function register(app) {
// VMEDAフィルター: IVFree動画ページ用プロキシ（広告除去・ポップアップ無効化）
app.get('/api/ivfree-proxy', async (req, res) => {
  // OPTIONSリクエスト（CORS preflight）を処理
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Max-Age', '86400'); // 24時間
    return res.status(200).end();
  }
  
  try {
    const videoUrl = String(req.query.url || '').trim();
    if (!videoUrl) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    // IVFreeの動画ページまたは外部動画サイトのURLを許可
    const isIVFreeUrl = videoUrl.includes('ivfree.asia') || videoUrl.includes('aivfree.com');
    const isAbsoluteHttpUrl = /^https?:\/\//i.test(videoUrl);
    const isExternalVideoUrl = videoUrl.includes('cdn.loadvid.com') || 
                                videoUrl.includes('loadvid.com') ||
                                videoUrl.includes('vidnest.io') ||
                                videoUrl.includes('lulustream.com') ||
                                videoUrl.includes('luluvid.com') ||
                                videoUrl.includes('luluvdoo.com') ||
                                videoUrl.includes('embed') ||
                                videoUrl.includes('video') ||
                                videoUrl.includes('player') ||
                                videoUrl.includes('stream') ||
                                videoUrl.includes('play');
    
    if (!isAbsoluteHttpUrl && !isIVFreeUrl && !isExternalVideoUrl) {
      return res.status(400).json({ error: 'IVFree or video site URL is required' });
    }
    
    // 外部動画サイトのURLもプロキシ経由で処理（広告ブロッカー検出を回避）
    if (isExternalVideoUrl && !isIVFreeUrl) {
      // 外部動画サイトの場合は、プロキシ経由で取得して広告ブロッカー検出を回避
      console.log('📺 外部動画サイトをプロキシ経由で取得:', videoUrl);
      
      const response = await axios.get(videoUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://ivfree.asia/',
          'Accept-Encoding': 'gzip, deflate, br'
        },
        timeout: 30000,
        maxRedirects: 5
      });
      
      const $ = cheerio.load(response.data);
      const baseUrl = new URL(videoUrl);
      
      // ポップアップ広告を生成するスクリプトを除去（ただし、動画プレイヤーに必要なスクリプトは保持）
      $('script').each((index, elem) => {
        const scriptContent = $(elem).html() || '';
        const scriptSrc = $(elem).attr('src') || '';
        
        // 動画プレイヤー関連のスクリプトは保護（削除しない）
        const isPlayerScript = scriptSrc.includes('jwplayer') || 
                              scriptSrc.includes('video.js') || 
                              scriptSrc.includes('player') ||
                              scriptSrc.includes('vidnest') ||
                              scriptSrc.includes('loadvid') ||
                              scriptSrc.includes('luluvid') ||
                              scriptSrc.includes('luluvdoo') ||
                              scriptContent.includes('jwplayer') ||
                              scriptContent.includes('video.js') ||
                              scriptContent.includes('JWPlayer') ||
                              scriptContent.includes('VideoJS');
        
        if (isPlayerScript) {
          return; // 動画プレイヤーのスクリプトは削除しない
        }
        
        // ロボット検証（CAPTCHA/reCAPTCHA）のスクリプトを除去
        if (
          scriptSrc.includes('recaptcha') ||
          scriptSrc.includes('captcha') ||
          scriptSrc.includes('google.com/recaptcha') ||
          scriptSrc.includes('gstatic.com/recaptcha') ||
          scriptContent.includes('recaptcha') ||
          scriptContent.includes('grecaptcha') ||
          scriptContent.includes('captcha') ||
          scriptSrc.includes('cloudflare') ||
          scriptContent.includes('cloudflare') ||
          scriptContent.includes('challenge-platform') ||
          scriptContent.includes('cf-browser-verification')
        ) {
          $(elem).remove();
          return;
        }
        
        if (
          (scriptContent.includes('window.open') && !scriptContent.includes('video') && !scriptContent.includes('player')) ||
          scriptContent.includes('popup') ||
          scriptContent.includes('popunder') ||
          scriptContent.includes('pop-up') ||
          scriptContent.includes('pop_up') ||
          (scriptSrc.includes('advertisement') || scriptSrc.includes('advert') || scriptSrc.includes('adsbygoogle') || scriptSrc.includes('googlesyndication') || scriptSrc.includes('doubleclick')) ||
          scriptSrc.includes('popup') ||
          scriptSrc.includes('popunder')
        ) {
          $(elem).remove();
          return;
        }
        // 動画広告・トラッカー用スクリプトを除去（広告ネットワークのドメイン）
        const isAdScript = scriptSrc.includes('googlesyndication') || scriptSrc.includes('doubleclick') || scriptSrc.includes('googleadservices') ||
          scriptSrc.includes('adnxs') || scriptSrc.includes('openx') || scriptSrc.includes('exoclick') || scriptSrc.includes('criteo') ||
          scriptSrc.includes('outbrain') || scriptSrc.includes('taboola') || scriptSrc.includes('mgid') || scriptSrc.includes('revcontent') ||
          scriptSrc.includes('adform') || scriptSrc.includes('adzerk') || scriptSrc.includes('pagead') || scriptSrc.includes('/ads/') ||
          scriptSrc.includes('afrdtech.com') || scriptSrc.includes('outdidfillet.com') || scriptSrc.includes('tapioni.com') || scriptSrc.includes('cloudflareinsights.com');
        if (isAdScript) $(elem).remove();
      });
      
      // ポップアップ広告を生成するaタグやボタンを除去
      $('a[onclick], button[onclick], div[onclick]').each((index, elem) => {
        const onclick = $(elem).attr('onclick') || '';
        if (onclick.includes('window.open') || onclick.includes('popup') || onclick.includes('popunder')) {
          $(elem).remove();
        }
      });
      
      // target="_blank"のaタグで広告関連のURLを除去
      $('a[target="_blank"]').each((index, elem) => {
        const href = $(elem).attr('href') || '';
        if (href.includes('ad') || href.includes('popup') || href.includes('popunder')) {
          $(elem).remove();
        }
      });
      
      // ロボット検証（CAPTCHA/reCAPTCHA）のiframeを除去
      $('iframe').each((index, elem) => {
        const src = $(elem).attr('src') || '';
        const id = $(elem).attr('id') || '';
        const classAttr = $(elem).attr('class') || '';
        if (
          src.includes('recaptcha') ||
          src.includes('captcha') ||
          src.includes('google.com/recaptcha') ||
          src.includes('gstatic.com/recaptcha') ||
          id.includes('recaptcha') ||
          id.includes('captcha') ||
          classAttr.includes('recaptcha') ||
          classAttr.includes('captcha')
        ) {
          $(elem).remove();
          return;
        }
        // 動画広告・トラッカーiframeを除去（プレイヤーは保護）
        const isPlayerIframe = src.includes('vidnest') || src.includes('jwplayer') || src.includes('player') ||
          src.includes('loadvid') || src.includes('luluvid') || src.includes('luluvdoo') || src.includes('lulustream') ||
          src.includes('video.js') || src.includes('embed');
        const isAdIframe = !isPlayerIframe && (
          src.includes('googlesyndication') || src.includes('doubleclick') || src.includes('googleadservices') ||
          src.includes('adnxs') || src.includes('openx') || src.includes('exoclick') || src.includes('criteo') ||
          src.includes('outbrain') || src.includes('taboola') || src.includes('mgid') || src.includes('revcontent') ||
          src.includes('adsbygoogle') || src.includes('advertisement') || src.includes('adform') ||
          src.includes('adzerk') || src.includes('advertising') || src.includes('/ads/') || src.includes('pagead')
        );
        if (isAdIframe) $(elem).remove();
      });
      
      // ロボット検証（CAPTCHA/reCAPTCHA）のdiv要素を除去（ただし、動画プレイヤーの要素は保護）
      $('div[id*="recaptcha"], div[id*="captcha"], div[class*="recaptcha"], div[class*="captcha"]').each((index, elem) => {
        const $elem = $(elem);
        // 動画プレイヤーの要素は保護
        const isPlayerElement = $elem.closest('[class*="player"], [id*="player"], [class*="video"], [id*="video"], [class*="jwplayer"], [id*="jwplayer"]').length > 0 ||
                               $elem.find('[class*="player"], [id*="player"], [class*="video"], [id*="video"], [class*="jwplayer"], [id*="jwplayer"]').length > 0;
        if (!isPlayerElement) {
          $elem.remove();
        }
      });
      // reCAPTCHAのdata-sitekey属性を持つdivを除去（ただし、動画プレイヤーの要素は保護）
      $('div[data-sitekey]').each((index, elem) => {
        const $elem = $(elem);
        const sitekey = $elem.attr('data-sitekey') || '';
        // 動画プレイヤーの要素は保護
        const isPlayerElement = $elem.closest('[class*="player"], [id*="player"], [class*="video"], [id*="video"], [class*="jwplayer"], [id*="jwplayer"]').length > 0 ||
                               $elem.find('[class*="player"], [id*="player"], [class*="video"], [id*="video"], [class*="jwplayer"], [id*="jwplayer"]').length > 0;
        // reCAPTCHAのsitekeyは通常6文字以上の文字列
        if (!isPlayerElement && sitekey.length >= 6 && !sitekey.includes('video') && !sitekey.includes('player')) {
          $elem.remove();
        }
      });
      // reCAPTCHAのdata-callback属性を持つdivを除去（ただし、動画プレイヤーの要素は保護）
      $('div[data-callback]').each((index, elem) => {
        const $elem = $(elem);
        const callback = $elem.attr('data-callback') || '';
        // 動画プレイヤーの要素は保護
        const isPlayerElement = $elem.closest('[class*="player"], [id*="player"], [class*="video"], [id*="video"], [class*="jwplayer"], [id*="jwplayer"]').length > 0 ||
                               $elem.find('[class*="player"], [id*="player"], [class*="video"], [id*="video"], [class*="jwplayer"], [id*="jwplayer"]').length > 0;
        // reCAPTCHAのcallbackは通常recaptchaを含む
        if (!isPlayerElement && (callback.includes('recaptcha') || callback.includes('captcha'))) {
          $elem.remove();
        }
      });
      
      // 動画広告要素を完全に除去（Google AdSense、バナー、オーバーレイ等）
      $('ins.adsbygoogle, [data-ad-slot], [data-ad-format], [id*="google_ads"], [class*="adsbygoogle"], [id*="div-gpt-ad"], [data-google-query-id]').remove();
      $('iframe[src*="doubleclick"], iframe[src*="googlesyndication"], iframe[src*="googleadservices"], iframe[src*="pagead"]').remove();
      $('[id*="-ad-"], [id*="_ad_"], [id*="ad-"], [class*="ad-container"], [class*="ad-banner"], [class*="banner-ad"], [class*="ad-slot"], aside[id*="ad"], aside[class*="ad-"]').each((index, elem) => {
        const $elem = $(elem);
        const isPlayer = $elem.closest('[class*="player"], [id*="player"], [class*="video"], [id*="video"], [class*="jwplayer"]').length > 0;
        if ($elem.find('video, iframe[src*="video"], iframe[src*="player"], [class*="player"], [id*="player"]').length) return;
        if (!isPlayer) $elem.remove();
      });
      $('div[id*="div-gpt-ad"], div[class*="ad-placement"], iframe[src*="doubleclick"], iframe[src*="googlesyndication"]').remove();
      
      // jQueryを追加（jQueryが定義されていない場合に備えて）
      if ($('script[src*="jquery"]').length === 0) {
        $('head').prepend(`<script src="https://code.jquery.com/jquery-3.6.0.min.js"></script>`);
      }
      
      // 広告ブロッカー検出を回避するスクリプトを追加
      // ポップアップ広告を無効化するスクリプトも追加
      $('head').prepend(`
        <script>
          // jQueryが読み込まれるまで待つ
          (function waitForJQuery() {
            if (typeof jQuery === 'undefined') {
              // jQueryがまだ読み込まれていない場合、少し待つ
              setTimeout(waitForJQuery, 50);
              return;
            }
            
            // jQueryが読み込まれたら、$とjQueryをグローバルに設定
            if (typeof window.$ === 'undefined') {
              window.$ = jQuery;
            }
            if (typeof window.jQuery === 'undefined') {
              window.jQuery = jQuery;
            }
          })();
          
          // FastSearchなどの未定義関数を無効化（エラーを回避）
          if (typeof window.FastSearch === 'undefined') {
            window.FastSearch = function() {};
          }
          
          // 広告ブロッカー検出を回避
          // ポップアップ広告を無効化
          (function() {
            // window.openを完全に無効化（より早期に実行）
            const originalOpen = window.open;
            Object.defineProperty(window, 'open', {
              value: function() {
                console.log('🚫 ポップアップがブロックされました');
                return null;
              },
              writable: false,
              configurable: false
            });
            
            // showModalDialogも無効化
            if (window.showModalDialog) {
              window.showModalDialog = function() {
                console.log('🚫 モーダルダイアログがブロックされました');
                return null;
              };
            }
            
            // ポップアップ広告を生成するイベントリスナーを無効化
            const originalAddEventListener = EventTarget.prototype.addEventListener;
            EventTarget.prototype.addEventListener = function(type, listener, options) {
              if (listener && typeof listener === 'function') {
                const listenerStr = listener.toString();
                if (listenerStr.includes('window.open') || listenerStr.includes('popup') || listenerStr.includes('popunder')) {
                  console.log('🚫 ポップアップ広告イベントリスナーがブロックされました');
                  return;
                }
              }
              return originalAddEventListener.call(this, type, listener, options);
            };
            
            // ポップアップ広告を生成するsetTimeout/setIntervalを監視
            const originalSetTimeout = window.setTimeout;
            window.setTimeout = function(func, delay) {
              if (func && typeof func === 'function') {
                const funcStr = func.toString();
                if (funcStr.includes('window.open') || funcStr.includes('popup') || funcStr.includes('popunder')) {
                  console.log('🚫 ポップアップ広告のsetTimeoutがブロックされました');
                  return 0;
                }
              }
              return originalSetTimeout.call(window, func, delay);
            };
            
            const originalSetInterval = window.setInterval;
            window.setInterval = function(func, delay) {
              if (func && typeof func === 'function') {
                const funcStr = func.toString();
                if (funcStr.includes('window.open') || funcStr.includes('popup') || funcStr.includes('popunder')) {
                  console.log('🚫 ポップアップ広告のsetIntervalがブロックされました');
                  return 0;
                }
              }
              return originalSetInterval.call(window, func, delay);
            };
            
            // MutationObserverを使って、ポップアップ広告とロボット検証を動的に除去
            function removePopupAds() {
              // ポップアップ広告を生成する要素を除去
              const popupSelectors = [
                'a[onclick*="window.open"]',
                'a[onclick*="popup"]',
                'a[onclick*="popunder"]',
                'button[onclick*="window.open"]',
                'button[onclick*="popup"]',
                'div[onclick*="window.open"]',
                'div[onclick*="popup"]',
                'iframe[src*="ad"]',
                'iframe[src*="popup"]',
                '[class*="popup"]',
                '[class*="pop-up"]',
                '[id*="popup"]',
                '[id*="pop-up"]'
              ];
              
              popupSelectors.forEach(selector => {
                try {
                  document.querySelectorAll(selector).forEach(elem => {
                    const onclick = elem.getAttribute('onclick') || '';
                    const href = elem.getAttribute('href') || '';
                    const src = elem.getAttribute('src') || '';
                    if (onclick.includes('window.open') || onclick.includes('popup') || onclick.includes('popunder') ||
                        href.includes('popup') || href.includes('popunder') || src.includes('popup') || src.includes('popunder')) {
                      elem.remove();
                    }
                  });
                } catch(e) {}
              });
              
              // ロボット検証（CAPTCHA/reCAPTCHA）の要素を除去（ただし、動画プレイヤーの要素は保護）
              const captchaSelectors = [
                'iframe[src*="recaptcha"]',
                'iframe[src*="captcha"]',
                'iframe[src*="google.com/recaptcha"]',
                'iframe[src*="gstatic.com/recaptcha"]',
                'div[id*="recaptcha"]',
                'div[id*="captcha"]',
                'div[class*="recaptcha"]',
                'div[class*="captcha"]',
                '[id*="cf-browser-verification"]',
                '[class*="cf-browser-verification"]',
                '[id*="challenge-platform"]',
                '[class*="challenge-platform"]'
              ];
              
              captchaSelectors.forEach(selector => {
                try {
                  document.querySelectorAll(selector).forEach(elem => {
                    // 動画プレイヤーの要素は保護
                    const isPlayerElement = elem.closest('[class*="player"], [id*="player"], [class*="video"], [id*="video"], [class*="jwplayer"], [id*="jwplayer"]') ||
                                           elem.querySelector('[class*="player"], [id*="player"], [class*="video"], [id*="video"], [class*="jwplayer"], [id*="jwplayer"]');
                    if (!isPlayerElement) {
                      elem.remove();
                    }
                  });
                } catch(e) {}
              });
              
              // reCAPTCHAのdata-sitekey属性を持つdivを除去（ただし、動画プレイヤーの要素は保護）
              try {
                document.querySelectorAll('div[data-sitekey]').forEach(elem => {
                  const sitekey = elem.getAttribute('data-sitekey') || '';
                  // 動画プレイヤーの要素は保護
                  const isPlayerElement = elem.closest('[class*="player"], [id*="player"], [class*="video"], [id*="video"], [class*="jwplayer"], [id*="jwplayer"]') ||
                                         elem.querySelector('[class*="player"], [id*="player"], [class*="video"], [id*="video"], [class*="jwplayer"], [id*="jwplayer"]');
                  // reCAPTCHAのsitekeyは通常6文字以上の文字列
                  if (!isPlayerElement && sitekey.length >= 6 && !sitekey.includes('video') && !sitekey.includes('player')) {
                    elem.remove();
                  }
                });
              } catch(e) {}
              
              // reCAPTCHAのdata-callback属性を持つdivを除去（ただし、動画プレイヤーの要素は保護）
              try {
                document.querySelectorAll('div[data-callback]').forEach(elem => {
                  const callback = elem.getAttribute('data-callback') || '';
                  // 動画プレイヤーの要素は保護
                  const isPlayerElement = elem.closest('[class*="player"], [id*="player"], [class*="video"], [id*="video"], [class*="jwplayer"], [id*="jwplayer"]') ||
                                         elem.querySelector('[class*="player"], [id*="player"], [class*="video"], [id*="video"], [class*="jwplayer"], [id*="jwplayer"]');
                  // reCAPTCHAのcallbackは通常recaptchaを含む
                  if (!isPlayerElement && (callback.includes('recaptcha') || callback.includes('captcha'))) {
                    elem.remove();
                  }
                });
              } catch(e) {}
              
              // AdBlock検出メッセージ（AdBlock detected / disable AdBlock / change your browser to continue）を除去
              try {
                const adBlockPhrases = ['AdBlock detected', 'change your browser to continue', 'Please disable AdBlock', 'disable AdBlock / uBlock', 'disable AdGuard', 'turn off adblockers', 'click ADS to continue', 'VPN Recommended', 'Tap to Install and Continue Watching', 'Skip Ad'];
                document.querySelectorAll('*').forEach(function(elem) {
                  const t = (elem.textContent || elem.innerText || '').trim();
                  if (!t) return;
                  const hasMsg = adBlockPhrases.some(function(p) { return t.indexOf(p) !== -1; });
                  if (!hasMsg) return;
                  var hasChildWithMsg = false;
                  for (var i = 0; i < elem.children.length; i++) {
                    const ct = (elem.children[i].textContent || elem.children[i].innerText || '').trim();
                    if (adBlockPhrases.some(function(p) { return ct.indexOf(p) !== -1; })) { hasChildWithMsg = true; break; }
                  }
                  if (!hasChildWithMsg) elem.remove();
                });
              } catch(e) {}
            }
            
            // ページ読み込み時に実行
            if (document.readyState === 'loading') {
              document.addEventListener('DOMContentLoaded', removePopupAds);
            } else {
              removePopupAds();
            }
            
            // MutationObserverで動的に除去
            const observer = new MutationObserver(function(mutations) {
              removePopupAds();
            });
            
            const observeTarget = document.body || document.documentElement;
            if (observeTarget && observeTarget.nodeType === 1) {
              try {
                observer.observe(observeTarget, {
                  childList: true,
                  subtree: true
                });
              } catch (e) {}
            }
            
            // 定期的に除去（念のため）
            setInterval(removePopupAds, 500);
            // AdBlock検出を無効化（より強化）
            if (typeof window.getComputedStyle === 'undefined') {
              window.getComputedStyle = function() { return {}; };
            }
            // uBlock検出を無効化
            if (typeof window.adsbygoogle === 'undefined') {
              window.adsbygoogle = [];
            }
            // AdGuard検出を無効化
            if (typeof window.adblock === 'undefined') {
              window.adblock = false;
            }
            // より多くの広告ブロッカー検出を無効化
            Object.defineProperty(window, 'adsbygoogle', {
              value: [],
              writable: false,
              configurable: false
            });
            Object.defineProperty(window, 'adblock', {
              value: false,
              writable: false,
              configurable: false
            });
            Object.defineProperty(window, 'uBlock', {
              value: false,
              writable: false,
              configurable: false
            });
            Object.defineProperty(window, 'AdBlock', {
              value: false,
              writable: false,
              configurable: false
            });
            Object.defineProperty(window, 'AdGuard', {
              value: false,
              writable: false,
              configurable: false
            });
            // 広告ブロッカー検出関数を無効化
            if (typeof window.getComputedStyle === 'function') {
              const originalGetComputedStyle = window.getComputedStyle;
              window.getComputedStyle = function(element, pseudoElement) {
                try {
                  return originalGetComputedStyle.call(window, element, pseudoElement);
                } catch(e) {
                  return {
                    display: 'block',
                    visibility: 'visible',
                    opacity: '1',
                    height: 'auto',
                    width: 'auto'
                  };
                }
              };
            }
            // サンドボックス検出を無効化
            Object.defineProperty(window, 'frameElement', {
              get: function() { return null; },
              configurable: true
            });
            // document.domainの検出を無効化（サンドボックス検出を回避）
            try {
              Object.defineProperty(document, 'domain', {
                get: function() { return window.location.hostname; },
                set: function(value) {},
                configurable: true
              });
            } catch(e) {}
            // サンドボックス属性の検出を無効化
            if (typeof document.createElement === 'function') {
              const originalCreateElement = document.createElement;
              document.createElement = function(tagName) {
                const element = originalCreateElement.call(document, tagName);
                if (tagName.toLowerCase() === 'iframe') {
                  Object.defineProperty(element, 'sandbox', {
                    get: function() { return null; },
                    set: function() {},
                    configurable: true
                  });
                }
                return element;
              };
            }
            // サンドボックス検出スクリプトを無効化
            const originalEval = window.eval;
            window.eval = function(code) {
              if (typeof code === 'string' && (
                code.includes('sandbox') ||
                code.includes('Sandbox detected') ||
                code.includes('document.domain')
              )) {
                return;
              }
              return originalEval.call(window, code);
            };
            // 広告ブロッカー検出の一般的な関数を無効化
            const originalQuerySelector = document.querySelector;
            document.querySelector = function(selector) {
              if (selector && (selector.includes('adsbygoogle') || selector.includes('advertisement'))) {
                return null;
              }
              return originalQuerySelector.call(document, selector);
            };
            // grecaptcha関数を無効化
            if (typeof window.grecaptcha !== 'undefined') {
              window.grecaptcha = {
                ready: function(callback) { if (callback) callback(); },
                execute: function() { return Promise.resolve(''); },
                render: function() { return ''; },
                reset: function() {},
                getResponse: function() { return ''; }
              };
            }
            Object.defineProperty(window, 'grecaptcha', {
              value: {
                ready: function(callback) { if (callback) callback(); },
                execute: function() { return Promise.resolve(''); },
                render: function() { return ''; },
                reset: function() {},
                getResponse: function() { return ''; }
              },
              writable: false,
              configurable: false
            });
            
            // サンドボックス検出メッセージとロボット検証メッセージを除去
            function initObserver() {
              if (document.body) {
                const observer = new MutationObserver(function(mutations) {
                  mutations.forEach(function(mutation) {
                    mutation.addedNodes.forEach(function(node) {
                      if (node && node.nodeType === 1) {
                        const text = node.textContent || node.innerText || '';
                        if (text.includes('Streaming Blocked') || 
                            text.includes('sandboxed environment') ||
                            text.includes('AdBlock is enabled') ||
                            text.includes('Sandbox detected') ||
                            text.includes('document.domain restriction') ||
                            text.includes('あなたはロボットですか') ||
                            text.includes('あなたはロボット') ||
                            text.includes("I'm not a robot") ||
                            text.includes('I am not a robot') ||
                            text.includes('ロボットではありません') ||
                            text.includes('Verify you are human') ||
                            text.includes("Verify you're human") ||
                            text.includes('Please verify you are human') ||
                            text.includes("Please verify you're human") ||
                            text.includes('Human verification') ||
                            text.includes('Security check') ||
                            text.includes('Security verification') ||
                            text.includes('Cloudflare') ||
                            text.includes('Checking your browser') ||
                            text.includes('Just a moment') ||
                            text.includes('Please wait') ||
                            text.includes('Verifying') ||
                            text.includes('Verification') ||
                            text.includes('CAPTCHA') ||
                            text.includes('reCAPTCHA') ||
                            text.includes('Please change your browser') ||
                            text.includes('change your browser to continue') ||
                            text.includes('AdBlock detected') ||
                            text.includes('disable AdBlock') ||
                            text.includes('disable UBlock') ||
                            text.includes('disable AdGuard') ||
                            text.includes('to watch this video') ||
                            text.includes('AdBlock / UBlock') ||
                            text.includes('AdBlock / AdGuard') ||
                            text.includes('turn off adblockers') ||
                            text.includes('click ADS to continue')) {
                          node.remove();
                        }
                        // ロボット検証の要素も除去
                        const id = node.id || '';
                        const className = node.className || '';
                        if (id.includes('recaptcha') || id.includes('captcha') || 
                            className.includes('recaptcha') || className.includes('captcha') ||
                            id.includes('cf-browser-verification') || className.includes('cf-browser-verification') ||
                            id.includes('challenge-platform') || className.includes('challenge-platform')) {
                          node.remove();
                        }
                      }
                    });
                  });
                });
                const bodyNode = document.body;
                if (bodyNode && bodyNode.nodeType === 1) {
                  try {
                    observer.observe(bodyNode, {
                      childList: true,
                      subtree: true
                    });
                  } catch (e) {}
                }
              } else {
                // document.bodyがまだ存在しない場合は、DOMContentLoadedイベントを待つ
                if (document.readyState === 'loading') {
                  document.addEventListener('DOMContentLoaded', initObserver);
                } else {
                  setTimeout(initObserver, 100);
                }
              }
            }
            initObserver();
          })();
        </script>
      `);
      
      // 広告ブロッカー検出メッセージを除去（オーバーレイのみ。本文は残す）
      // ロボット検証（CAPTCHA/reCAPTCHA）のメッセージも除去
      $('body').find('*').each((index, elem) => {
        const $elem = $(elem);
        const text = ($elem.text() || '').trim();
        if (!text || text.length > 600) return;
        if (!(
          text.includes('Please change your browser') ||
          text.includes('change your browser to continue') ||
          text.includes('AdBlock detected') ||
          text.includes('disable AdBlock') ||
          text.includes('disable UBlock') ||
          text.includes('disable AdGuard') ||
          text.includes('AdBlock') ||
          text.includes('UBlock') ||
          text.includes('AdGuard') ||
          text.includes('Streaming Blocked') ||
          text.includes('sandboxed environment') ||
          text.includes('sandboxed') ||
          text.includes('AdBlock is enabled') ||
          text.includes('page is running in a sandboxed') ||
          text.includes('あなたはロボットですか') ||
          text.includes('あなたはロボット') ||
          text.includes("I'm not a robot") ||
          text.includes('I am not a robot') ||
          text.includes('ロボットではありません') ||
          text.includes('Verify you are human') ||
          text.includes("Verify you're human") ||
          text.includes('Please verify you are human') ||
          text.includes("Please verify you're human") ||
          text.includes('Human verification') ||
          text.includes('Security check') ||
          text.includes('Security verification') ||
          text.includes('Cloudflare') ||
          text.includes('Checking your browser') ||
          text.includes('Just a moment') ||
          text.includes('Please wait') ||
          text.includes('Verifying') ||
          text.includes('Verification') ||
          text.includes('CAPTCHA') ||
          text.includes('reCAPTCHA') ||
          text.includes('to watch this video') ||
          text.includes('AdBlock / UBlock') ||
          text.includes('AdBlock / AdGuard') ||
          text.includes('change your browser or disable') ||
          text.includes('turn off adblockers') ||
          text.includes('click ADS to continue') ||
          text.includes('VID.nestio') ||
          (text.includes('vidnest') && /robot|verify|認証|確認|captcha|recaptcha/.test(text))
        )) return;
        if ($elem.find('iframe[src*="vidnest"], video').length > 0) return;
        if ($elem.find('a[href*="vidnest"], a[href*="embed"]').length > 0) return;
        if ($elem.closest('[class*="player"], [id*="player"], [class*="video"]').length) return;
        $elem.remove();
      });
      
      // 相対URLを絶対URLに変換
      const toAbsoluteUrl = (url) => {
        if (!url) return url;
        if (url.startsWith('http://') || url.startsWith('https://')) return url;
        if (url.startsWith('//')) return `https:${url}`;
        if (url.startsWith('/')) return `${baseUrl.protocol}//${baseUrl.host}${url}`;
        return `${baseUrl.protocol}//${baseUrl.host}/${url}`;
      };
      
      $('a[href]').each((index, elem) => {
        const href = $(elem).attr('href');
        if (href && !href.startsWith('http') && !href.startsWith('//') && !href.startsWith('#')) {
          $(elem).attr('href', toAbsoluteUrl(href));
        }
      });
      
      $('img[src]').each((index, elem) => {
        const src = $(elem).attr('src');
        if (src && !src.startsWith('http') && !src.startsWith('//') && !src.startsWith('data:')) {
          $(elem).attr('src', toAbsoluteUrl(src));
        }
      });
      
      $('link[href]').each((index, elem) => {
        const href = $(elem).attr('href');
        if (href && !href.startsWith('http') && !href.startsWith('//')) {
          $(elem).attr('href', toAbsoluteUrl(href));
        }
      });
      
      $('script[src]').each((index, elem) => {
        const src = $(elem).attr('src');
        if (src && !src.startsWith('http') && !src.startsWith('//')) {
          $(elem).attr('src', toAbsoluteUrl(src));
        }
      });
      
      // baseタグを追加
      if ($('head base').length === 0) {
        $('head').prepend(`<base href="${baseUrl.protocol}//${baseUrl.host}${baseUrl.pathname}">`);
      }
      try {
        const $head = $('head').length ? $('head') : $('html');
        $('meta[name="viewport"]').remove();
        $head.prepend('<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5, user-scalable=yes, viewport-fit=cover">');
        $head.prepend(`
      <style id="vmeda-mobile">
        html,body{ max-width:100vw !important; overflow-x:hidden !important; -webkit-text-size-adjust:100%; }
        video{ max-width:100% !important; width:100% !important; height:auto !important; min-height:200px !important; object-fit:contain !important; }
        iframe[src*="video"],iframe[src*="embed"],iframe[src*="player"],iframe[src*="stream"], [class*="player"] iframe, [id*="player"] iframe, [class*="video"] iframe { max-width:100% !important; width:100% !important; aspect-ratio:16/9; height:auto !important; min-height:200px !important; }
        [class*="player"]:not(iframe),[id*="player"]:not(iframe),[class*="video-container"],[id*="video-container"]{ max-width:100% !important; width:100% !important; box-sizing:border-box !important; }
        #video-player-container,.video-player-container,#player-container,.player-container{ max-width:100vw !important; width:100% !important; }
      </style>
      `);
      } catch (e) {
        console.warn('ivfree-proxy: viewport/mobile inject failed (external)', e.message);
      }
      
      // luluvid.com / lulustream.com のAdBlock検出スクリプトを除去
      if (videoUrl.includes('luluvid.com') || videoUrl.includes('luluvdoo.com') || videoUrl.includes('lulustream.com')) {
        // sandboxed.htmlへのリダイレクトを生成するスクリプトを除去
        $('script').each((index, elem) => {
          const scriptContent = $(elem).html() || '';
          const scriptSrc = $(elem).attr('src') || '';
          if (
            scriptContent.includes('sandboxed.html') ||
            scriptContent.includes('location.replace') && scriptContent.includes('sandboxed') ||
            scriptContent.includes('location.assign') && scriptContent.includes('sandboxed') ||
            scriptContent.includes('window.location') && scriptContent.includes('sandboxed') ||
            scriptSrc.includes('sandboxed') ||
            scriptSrc.includes('cdn-cgi/rum')
          ) {
            $(elem).remove();
          }
        });
        
        // sandboxed.htmlへのリンクを除去
        $('a[href*="sandboxed.html"]').remove();
        
        // AdBlock検出のメッセージを除去
        $('body').find('*').each((index, elem) => {
          const $elem = $(elem);
          const text = $elem.text();
          if (text && (
            text.includes('AdBlock') ||
            text.includes('adblock') ||
            text.includes('ad-block') ||
            text.includes('Please disable AdBlock') ||
            text.includes('AdBlock detected') ||
            text.includes('change your browser to continue') ||
            text.includes('disable AdBlock / uBlock') ||
            text.includes('disable AdGuard')
          )) {
            $elem.remove();
          }
        });
      }
      
      // IVFree内部ページ用のCSPを設定（緩和版）
      // すべてのCSPメタタグを削除（既存のCSPを確実に削除）
      $('head meta[http-equiv="Content-Security-Policy"]').remove();
      $('head meta[http-equiv="content-security-policy"]').remove();
      $('head meta[http-equiv="CSP"]').remove();
      $('head meta[http-equiv="csp"]').remove();
      
      // CSPを完全に緩和（IVFreeのリソースをすべて許可）
      // metaタグのCSPはframe-ancestorsを無視するため、レスポンスヘッダーでも設定
      const cspContent = `default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src * 'unsafe-inline' 'unsafe-eval' https://code.jquery.com https://static.adxadserv.com https://www.googletagmanager.com https://www.google-analytics.com https://ivfree.asia https://fonts.googleapis.com; style-src * 'unsafe-inline' https://fonts.googleapis.com https://ivfree.asia; img-src * data: blob: https://ivfree.asia; media-src * blob:; frame-src *; object-src *; base-uri *; form-action *; connect-src *; font-src * data: https://fonts.gstatic.com;`;
      
      // 新しいCSPを追加（metaタグ）
      $('head').prepend(`<meta http-equiv="Content-Security-Policy" content="${cspContent}">`);
      
      // sandbox属性を削除するスクリプトを追加（外部動画サイトの場合）
      // luluvid.comのAdBlock検出を回避するスクリプトも追加
      $('head').prepend(`
        <script>
          (function() {
            // FastSearchなどの未定義関数を無効化（エラーを回避）
            if (typeof window.FastSearch === 'undefined') {
              window.FastSearch = function() {};
            }
            
            // iframeのsandbox属性を削除（親ウィンドウから制御）
            try {
              if (window.frameElement && window.frameElement.hasAttribute('sandbox')) {
                window.frameElement.removeAttribute('sandbox');
              }
            } catch(e) {}
            
            // localStorage/sessionStorageにアクセスできるようにする
            // sandbox属性が設定されている場合でも、アクセスを試みる
            try {
              if (typeof localStorage !== 'undefined') {
                localStorage.setItem('_test', '1');
                localStorage.removeItem('_test');
              }
            } catch(e) {
              console.log('localStorageアクセスエラー:', e);
            }
            
            try {
              if (typeof sessionStorage !== 'undefined') {
                sessionStorage.setItem('_test', '1');
                sessionStorage.removeItem('_test');
              }
            } catch(e) {
              console.log('sessionStorageアクセスエラー:', e);
            }
            
            // luluvid.com / lulustream.com のAdBlock検出を回避
            if (window.location.hostname.includes('luluvid.com') || window.location.hostname.includes('luluvdoo.com') || window.location.hostname.includes('lulustream.com')) {
              // sandboxed.htmlへのリダイレクトを防止
              const originalLocationReplace = window.location.replace;
              window.location.replace = function(url) {
                if (url && url.includes('sandboxed.html')) {
                  console.log('🚫 sandboxed.htmlへのリダイレクトをブロックしました');
                  return;
                }
                return originalLocationReplace.call(window.location, url);
              };
              
              const originalLocationAssign = window.location.assign;
              window.location.assign = function(url) {
                if (url && url.includes('sandboxed.html')) {
                  console.log('🚫 sandboxed.htmlへのリダイレクトをブロックしました');
                  return;
                }
                return originalLocationAssign.call(window.location, url);
              };
              
              // AdBlock検出のAPI呼び出しをブロック
              const originalFetch = window.fetch;
              window.fetch = function(url, options) {
                if (typeof url === 'string' && (url.includes('cdn-cgi/rum') || url.includes('adblock') || url.includes('ad-block'))) {
                  console.log('🚫 AdBlock検出API呼び出しをブロックしました:', url);
                  return Promise.reject(new Error('Blocked'));
                }
                return originalFetch.call(window, url, options);
              };
              
              const originalXMLHttpRequest = window.XMLHttpRequest;
              window.XMLHttpRequest = function() {
                const xhr = new originalXMLHttpRequest();
                const originalOpen = xhr.open;
                xhr.open = function(method, url) {
                  if (typeof url === 'string' && (url.includes('cdn-cgi/rum') || url.includes('adblock') || url.includes('ad-block'))) {
                    console.log('🚫 AdBlock検出XMLHttpRequestをブロックしました:', url);
                    return;
                  }
                  return originalOpen.call(xhr, method, url);
                };
                return xhr;
              };
              
              // AdBlock検出スクリプトを無効化
              if (typeof window.adblock !== 'undefined') {
                window.adblock = false;
              }
              Object.defineProperty(window, 'adblock', {
                value: false,
                writable: false,
                configurable: false
              });
              
              // sandboxed.htmlへのリダイレクトを監視して防止
              const observer = new MutationObserver(function(mutations) {
                if (window.location.href.includes('sandboxed.html')) {
                  console.log('🚫 sandboxed.htmlへのリダイレクトを検出、元のURLに戻します');
                  const hash = window.location.hash;
                  if (hash) {
                    try {
                      const decodedUrl = decodeURIComponent(hash.substring(1));
                      if (decodedUrl.startsWith('http')) {
                        window.location.replace(decodedUrl);
                      }
                    } catch(e) {
                      console.log('URLデコードエラー:', e);
                    }
                  }
                }
              });
              
              const obsTarget = document.body || document.documentElement;
              if (obsTarget && obsTarget.nodeType === 1) {
                try {
                  observer.observe(obsTarget, {
                    childList: true,
                    subtree: true
                  });
                } catch (e) {}
              }
              
              // 定期的にsandboxed.htmlへのリダイレクトをチェック
              setInterval(function() {
                if (window.location.href.includes('sandboxed.html')) {
                  const hash = window.location.hash;
                  if (hash) {
                    try {
                      const decodedUrl = decodeURIComponent(hash.substring(1));
                      if (decodedUrl.startsWith('http')) {
                        window.location.replace(decodedUrl);
                      }
                    } catch(e) {
                      console.log('URLデコードエラー:', e);
                    }
                  }
                }
              }, 100);
            }
          })();
        </script>
      `);
      
      // 再生クリック時のポップアップ防止: 他スクリプトより先に実行するため最後に prepend
      $('head').prepend(`<script>
        window.open=function(){return null;};
        if(window.showModalDialog) window.showModalDialog=function(){return null;};
        document.addEventListener('click',function(e){
          var a=e.target&&(e.target.closest?e.target.closest('a'):null);
          if(!a||a.target!=='_blank'||!a.href) return;
          var h=(a.href||'').toLowerCase();
          if(/popup|popunder|tapioni|outdidfillet|afrdtech|doubleclick|googlesyndication|googleadservices|\\/ads?\\b|click\\.|redirect/.test(h)){ e.preventDefault(); e.stopPropagation(); }
        },true);
      </script>`);
      
      let html = $.html();
      
      // CORSヘッダーを設定
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // レスポンスヘッダーでもCSPを設定（frame-ancestorsを含む）
      res.setHeader('Content-Security-Policy', `${cspContent} frame-ancestors *;`);
      
      console.log('✅ 外部動画サイトをプロキシ経由で返送');
      res.send(html);
      return;
    }
    
    console.log('📺 IVFreeプロキシリクエスト:', videoUrl);
    
    // デスクトップのUser-Agentでリクエスト
    const response = await axios.get(videoUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://ivfree.asia/',
        'Accept-Encoding': 'gzip, deflate, br'
      },
      timeout: 30000,
      maxRedirects: 5
    });
    
    const $ = cheerio.load(response.data);
    const baseUrl = new URL(videoUrl);
    
    // 相対URLを絶対URLに変換する関数（HTTPをHTTPSに変換）
    const toAbsoluteUrl = (url) => {
      if (!url) return url;
      if (url.startsWith('http://')) {
        // HTTPをHTTPSに変換（Mixed Contentエラーを回避）
        return url.replace('http://', 'https://');
      }
      if (url.startsWith('https://')) return url;
      if (url.startsWith('//')) return `https:${url}`;
      if (url.startsWith('/')) return `https://${baseUrl.host}${url}`;
      return `https://${baseUrl.host}/${url}`;
    };
    
    // 相対URLを絶対URLに変換（HTTPをHTTPSに変換）
    $('a[href]').each((index, elem) => {
      const href = $(elem).attr('href');
      if (href) {
        if (href.startsWith('http://')) {
          // HTTPをHTTPSに変換（Mixed Contentエラーを回避）
          $(elem).attr('href', href.replace('http://', 'https://'));
        } else if (!href.startsWith('http') && !href.startsWith('//') && !href.startsWith('#')) {
          $(elem).attr('href', toAbsoluteUrl(href));
        }
      }
    });
    
    $('img[src]').each((index, elem) => {
      const src = $(elem).attr('src');
      if (src) {
        if (src.startsWith('http://')) {
          // HTTPをHTTPSに変換（Mixed Contentエラーを回避）
          $(elem).attr('src', src.replace('http://', 'https://'));
        } else if (!src.startsWith('http') && !src.startsWith('//') && !src.startsWith('data:')) {
          $(elem).attr('src', toAbsoluteUrl(src));
        }
      }
    });
    
    $('link[href]').each((index, elem) => {
      const href = $(elem).attr('href');
      if (href) {
        if (href.startsWith('http://')) {
          // HTTPをHTTPSに変換（Mixed Contentエラーを回避）
          $(elem).attr('href', href.replace('http://', 'https://'));
        } else if (!href.startsWith('http') && !href.startsWith('//')) {
          $(elem).attr('href', toAbsoluteUrl(href));
        }
      }
    });
    
    $('script[src]').each((index, elem) => {
      const src = $(elem).attr('src');
      if (src) {
        if (src.startsWith('http://')) {
          // HTTPをHTTPSに変換（Mixed Contentエラーを回避）
          $(elem).attr('src', src.replace('http://', 'https://'));
        } else if (!src.startsWith('http') && !src.startsWith('//')) {
          $(elem).attr('src', toAbsoluteUrl(src));
        }
      }
    });
    
    // iframe[src]も変換＋動画埋め込みはプロキシ経由にしてAdBlock除去を効かせる
    $('iframe[src]').each((index, elem) => {
      let src = $(elem).attr('src');
      if (!src) return;
      if (src.startsWith('http://')) src = src.replace('http://', 'https://');
      else if (!src.startsWith('http') && !src.startsWith('//')) src = toAbsoluteUrl(src);
      const isEmbed = src.includes('vidnest') || src.includes('loadvid') || src.includes('lulustream') || src.includes('luluvid') || src.includes('luluvdoo') || (src.includes('ivfree.asia') && (src.includes('embed') || src.includes('/video/') || src.includes('/player/')));
      if (isEmbed && src.startsWith('http')) {
        $(elem).attr('src', '/api/ivfree-proxy?url=' + encodeURIComponent(src));
      } else {
        $(elem).attr('src', src);
      }
    });
    
    // ポップアップ広告を生成するJavaScriptを除去（ただし、動画プレイヤーに必要なスクリプトは保持）
    // ロボット検証（CAPTCHA/reCAPTCHA）のスクリプトも除去
    $('script').each((index, elem) => {
      const scriptContent = $(elem).html() || '';
      const scriptSrc = $(elem).attr('src') || '';
      
      // 動画プレイヤー関連のスクリプトは保護（削除しない）
      const isPlayerScript = scriptSrc.includes('jwplayer') || 
                            scriptSrc.includes('video.js') || 
                            scriptSrc.includes('player') ||
                            scriptSrc.includes('vidnest') ||
                            scriptSrc.includes('lulustream') ||
                            scriptSrc.includes('loadvid') ||
                            scriptSrc.includes('luluvid') ||
                            scriptSrc.includes('luluvdoo') ||
                            scriptContent.includes('jwplayer') ||
                            scriptContent.includes('video.js') ||
                            scriptContent.includes('JWPlayer') ||
                            scriptContent.includes('VideoJS');
      
      if (isPlayerScript) {
        return; // 動画プレイヤーのスクリプトは削除しない
      }
      
      // AdBlock検出用の外部スクリプト（URLに adblock / antibot 等を含む）を除去
      if (scriptSrc && (scriptSrc.includes('adblock') || scriptSrc.includes('ad-block') || scriptSrc.includes('antibot'))) {
        $(elem).remove();
        return;
      }
      // IVFreeで使われる広告・検出スクリプトを除去（dongojyousan, adp.js, adplacement 等）
      if (
        (scriptSrc && (scriptSrc.includes('dongojyousan') || scriptSrc.includes('adp.js') || scriptSrc.includes('adplacement') || scriptSrc.includes('cloudflareinsights'))) ||
        (scriptContent && (scriptContent.includes('dongojyousan') || scriptContent.includes('adplacement') || scriptContent.includes('outdidfillet') || scriptContent.includes('afrdtech') || scriptContent.includes('tapioni')))
      ) {
        $(elem).remove();
        return;
      }
      
      // ロボット検証（CAPTCHA/reCAPTCHA）のスクリプトを除去
      if (
        scriptSrc.includes('recaptcha') ||
        scriptSrc.includes('captcha') ||
        scriptSrc.includes('google.com/recaptcha') ||
        scriptSrc.includes('gstatic.com/recaptcha') ||
        scriptContent.includes('recaptcha') ||
        scriptContent.includes('grecaptcha') ||
        scriptContent.includes('captcha') ||
        scriptSrc.includes('cloudflare') ||
        scriptContent.includes('cloudflare') ||
        scriptContent.includes('challenge-platform') ||
        scriptContent.includes('cf-browser-verification')
      ) {
        $(elem).remove();
        return;
      }
      
      // ポップアップ広告関連のスクリプトを除去（より厳格に、ただし動画プレイヤーは保護）
      if (
        (scriptContent.includes('window.open') && !scriptContent.includes('video') && !scriptContent.includes('player')) ||
        (scriptContent.includes('popup') && !scriptContent.includes('video') && !scriptContent.includes('player')) ||
        (scriptContent.includes('popunder')) ||
        (scriptContent.includes('pop-up')) ||
        (scriptContent.includes('pop_up')) ||
        (scriptContent.includes('adsbygoogle')) ||
        (scriptContent.includes('googlesyndication')) ||
        (scriptContent.includes('doubleclick')) ||
        (scriptContent.includes('advertising') && !scriptContent.includes('video')) ||
        (scriptContent.includes('advertisement') && !scriptContent.includes('video') && !scriptContent.includes('player')) ||
        (scriptContent.includes('advert') && !scriptContent.includes('video') && !scriptContent.includes('player')) ||
        (scriptSrc.includes('advertisement') || scriptSrc.includes('advert') || scriptSrc.includes('adsbygoogle') || scriptSrc.includes('googlesyndication') || scriptSrc.includes('doubleclick')) ||
        scriptSrc.includes('popup') ||
        scriptSrc.includes('popunder')
      ) {
        $(elem).remove();
        return;
      }
      // AdBlock検出・表示を行うスクリプトを除去（IVFree等で「AdBlock detected」を表示するスクリプト）
      if (
        scriptContent.includes('AdBlock detected') ||
        scriptContent.includes('disable AdBlock') ||
        scriptContent.includes('change your browser to continue') ||
        scriptContent.includes('turn off adblock') ||
        scriptContent.includes('click ADS to continue') ||
        (scriptContent.includes('adblock') && (scriptContent.includes('detect') || scriptContent.includes('disable') || scriptContent.includes('message'))) ||
        (scriptContent.includes('AdBlock') && scriptContent.includes('uBlock'))
      ) {
        $(elem).remove();
        return;
      }
      // 動画広告・トラッカー用スクリプトを除去（広告ネットワークのドメイン）
      const isAdScript = scriptSrc.includes('asg_embed') || scriptSrc.includes('googlesyndication') || scriptSrc.includes('doubleclick') || scriptSrc.includes('googleadservices') ||
        scriptSrc.includes('adnxs') || scriptSrc.includes('openx') || scriptSrc.includes('exoclick') || scriptSrc.includes('criteo') ||
        scriptSrc.includes('outbrain') || scriptSrc.includes('taboola') || scriptSrc.includes('mgid') || scriptSrc.includes('revcontent') ||
        scriptSrc.includes('adform') || scriptSrc.includes('adzerk') || scriptSrc.includes('pagead') || scriptSrc.includes('/ads/') ||
        scriptSrc.includes('afrdtech.com') || scriptSrc.includes('outdidfillet.com') || scriptSrc.includes('tapioni.com') || scriptSrc.includes('cloudflareinsights.com');
      if (isAdScript) $(elem).remove();
    });
    
    // ポップアップ広告を生成するaタグのonclick属性を除去
    $('a[onclick]').each((index, elem) => {
      const onclick = $(elem).attr('onclick') || '';
      if (onclick.includes('window.open') || onclick.includes('popup') || onclick.includes('popunder')) {
        $(elem).removeAttr('onclick');
        // ポップアップ広告を生成するaタグ自体を削除
        if ($(elem).attr('href') && ($(elem).attr('href').includes('ad') || $(elem).attr('href').includes('popup'))) {
          $(elem).remove();
        }
      }
    });
    
    // ポップアップ広告を生成するボタンやdivを除去
    $('button[onclick], div[onclick], span[onclick]').each((index, elem) => {
      const onclick = $(elem).attr('onclick') || '';
      if (onclick.includes('window.open') || onclick.includes('popup') || onclick.includes('popunder')) {
        $(elem).remove();
      }
    });
    
    // target="_blank"のaタグで広告関連のURLを除去
    $('a[target="_blank"]').each((index, elem) => {
      const href = $(elem).attr('href') || '';
      if (href.includes('ad') || href.includes('popup') || href.includes('popunder') || href.includes('advertisement')) {
        $(elem).remove();
      }
    });
    
    // 広告関連のiframeを除去（動画プレイヤーは保護）
    $('iframe').each((index, elem) => {
      const src = $(elem).attr('src') || '';
      const id = $(elem).attr('id') || '';
      const classAttr = $(elem).attr('class') || '';
      if (
        src.includes('recaptcha') || src.includes('captcha') ||
        src.includes('google.com/recaptcha') || src.includes('gstatic.com/recaptcha') ||
        id.includes('recaptcha') || id.includes('captcha') ||
        classAttr.includes('recaptcha') || classAttr.includes('captcha')
      ) {
        $(elem).remove();
        return;
      }
      const isPlayerIframe = src.includes('vidnest') || src.includes('jwplayer') || src.includes('player') ||
        src.includes('loadvid') || src.includes('luluvid') || src.includes('luluvdoo') || src.includes('lulustream') ||
        src.includes('video.js') || src.includes('embed');
      const isAdIframe = !isPlayerIframe && (
        src.includes('adsbygoogle') || src.includes('googlesyndication') || src.includes('doubleclick') ||
        src.includes('googleadservices') || src.includes('adnxs') || src.includes('openx') || src.includes('exoclick') ||
        src.includes('criteo') || src.includes('outbrain') || src.includes('taboola') || src.includes('mgid') ||
        src.includes('revcontent') || src.includes('advertisement') || src.includes('adform') || src.includes('pagead') || src.includes('/ads/')
      );
      if (isAdIframe) $(elem).remove();
    });
    
    // ロボット検証（CAPTCHA/reCAPTCHA）のdiv要素を除去（ただし、動画プレイヤーの要素は保護）
    $('div[id*="recaptcha"], div[id*="captcha"], div[class*="recaptcha"], div[class*="captcha"]').each((index, elem) => {
      const $elem = $(elem);
      // 動画プレイヤーの要素は保護
      const isPlayerElement = $elem.closest('[class*="player"], [id*="player"], [class*="video"], [id*="video"], [class*="jwplayer"], [id*="jwplayer"]').length > 0 ||
                             $elem.find('[class*="player"], [id*="player"], [class*="video"], [id*="video"], [class*="jwplayer"], [id*="jwplayer"]').length > 0;
      if (!isPlayerElement) {
        $elem.remove();
      }
    });
    // reCAPTCHAのdata-sitekey属性を持つdivを除去（ただし、動画プレイヤーの要素は保護）
    $('div[data-sitekey]').each((index, elem) => {
      const $elem = $(elem);
      const sitekey = $elem.attr('data-sitekey') || '';
      // 動画プレイヤーの要素は保護
      const isPlayerElement = $elem.closest('[class*="player"], [id*="player"], [class*="video"], [id*="video"], [class*="jwplayer"], [id*="jwplayer"]').length > 0 ||
                             $elem.find('[class*="player"], [id*="player"], [class*="video"], [id*="video"], [class*="jwplayer"], [id*="jwplayer"]').length > 0;
      // reCAPTCHAのsitekeyは通常6文字以上の文字列
      if (!isPlayerElement && sitekey.length >= 6 && !sitekey.includes('video') && !sitekey.includes('player')) {
        $elem.remove();
      }
    });
    // reCAPTCHAのdata-callback属性を持つdivを除去（ただし、動画プレイヤーの要素は保護）
    $('div[data-callback]').each((index, elem) => {
      const $elem = $(elem);
      const callback = $elem.attr('data-callback') || '';
      // 動画プレイヤーの要素は保護
      const isPlayerElement = $elem.closest('[class*="player"], [id*="player"], [class*="video"], [id*="video"], [class*="jwplayer"], [id*="jwplayer"]').length > 0 ||
                             $elem.find('[class*="player"], [id*="player"], [class*="video"], [id*="video"], [class*="jwplayer"], [id*="jwplayer"]').length > 0;
      // reCAPTCHAのcallbackは通常recaptchaを含む
      if (!isPlayerElement && (callback.includes('recaptcha') || callback.includes('captcha'))) {
        $elem.remove();
      }
    });
    
    // IVFree用: AdBlock検出メッセージを含む要素をサーバー側で除去（「AdBlock detected」「change your browser to continue」等）+ VIDNEST/ロボット検証
    const adBlockPhrases = ['AdBlock detected', 'Please disable AdBlock / uBlock / AdGuard or change your browser to continue', 'disable AdBlock / uBlock / AdGuard', 'change your browser to continue', 'change your browser to continu', 'Please disable AdBlock', 'disable AdBlock', 'disable UBlock', 'disable uBlock', 'disable AdGuard', 'AdBlock / UBlock', 'AdBlock / uBlock', 'AdBlock / AdGuard', 'turn off adblock', 'turn off adblockers', 'click ADS to continue', 'click to continue', 'Please turn off adblockers', 'Please turn off adblockers in order and click ADS to continue watching', '順番に広告ブロッカーをオフにし', 'ADSをクリックして視聴を続けてください', 'VPN Recommended', 'Tap to Install and Continue Watching', 'Skip Ad', 'disable your ad blocker', 'whitelist this site', 'Please disable', 'disable ads', 'Streaming Blocked', 'AdBlock is enabled', 'to watch this video', 'あなたはロボットですか', 'あなたはロボット', 'ロボットではありません', 'ロボットですか', 'VIDNEST.IO', 'vidnest.io'];
    $('body').find('*').each((index, elem) => {
      const $elem = $(elem);
      const text = ($elem.text() || '').trim();
      if (!text) return;
      const hasMsg = adBlockPhrases.some(function(p) { return text.indexOf(p) !== -1; });
      if (!hasMsg) return;
      let childHasMsg = false;
      $elem.children().each((i, ch) => {
        const ct = ($(ch).text() || '').trim();
        if (adBlockPhrases.some(function(p) { return ct.indexOf(p) !== -1; })) childHasMsg = true;
      });
      if (!childHasMsg) $elem.remove();
    });
    
    // IVFree用: AdBlockオーバーレイを id/class で除去（メッセージがJSで動的挿入される場合に対応）
    $('[id*="adblock"], [id*="ad-block"], [id*="antibot"], [id*="blocked"], [id*="disable-ads"], [id*="disable_ads"], [class*="adblock"], [class*="ad-block"], [class*="antibot"], [class*="blocked"], [class*="disable-ads"], [class*="adblock-message"], [class*="adblock-overlay"]').each((index, elem) => {
      const $elem = $(elem);
      const isPlayer = $elem.closest('[class*="player"], [id*="player"], [class*="video"], [id*="video"], [class*="jwplayer"]').length > 0;
      if (!isPlayer) $elem.remove();
    });
    // IVFree用: VIDNEST/ロボット検証オーバーレイを id/class で除去
    $('[id*="robot"]:not([id*="player"]), [class*="robot"], [id*="verify"], [class*="verify"], [id*="captcha"]:not([id*="player"]), [class*="captcha"], [id*="vidnest"]:not([id*="player"]), [class*="vidnest"]').each((index, elem) => {
      const $elem = $(elem);
      if ($elem.closest('[class*="player"], [id*="player"], [id*="video"], [id*="jwplayer"]').length > 0) return;
      if ($elem.find('iframe[src*="vidnest"], iframe[src*="video"], video').length > 0) return;
      const t = ($elem.text() || '').toLowerCase();
      if (t && t.length < 2500 && (t.indexOf('ロボット') !== -1 || t.indexOf('vidnest') !== -1 || t.indexOf('verify') !== -1 || t.indexOf('robot') !== -1)) $elem.remove();
    });
    // IVFree用: position:fixed の広告オーバーレイ（z-index が高く「ADS」「continue」等のテキストを含む）を除去
    $('div[style*="position:fixed"], div[style*="position: fixed"], div[style*="position:fixed"], div[style*="position: fixed"]').each((index, elem) => {
      const $elem = $(elem);
      if ($elem.closest('[class*="player"], [id*="player"], [class*="video"], [id*="video"], [class*="jwplayer"]').length > 0) return;
      const z = parseInt($elem.css('z-index'), 10) || 0;
      const text = ($elem.text() || '').toLowerCase();
      const isAdOverlay = z > 500 && (
        /ads?|continue|click|disable|adblock|ublock|adguard|change your browser|whitelist|ロボット|vidnest|robot|verify/i.test(text) ||
        text.includes('ad-block') || text.includes('disable ad')
      );
      if (isAdOverlay) $elem.remove();
    });
    
    // 動画広告要素を完全に除去（IVFreeページ内）
    $('ins.adsbygoogle, [data-ad-slot], [data-ad-format], [id*="google_ads"], [class*="adsbygoogle"], [id*="div-gpt-ad"], [data-google-query-id]').remove();
    $('iframe[src*="doubleclick"], iframe[src*="googlesyndication"], iframe[src*="googleadservices"], iframe[src*="pagead"]').remove();
    $('[id*="-ad-"], [id*="_ad_"], [id*="ad-"], [class*="ad-container"], [class*="ad-banner"], [class*="banner-ad"], [class*="ad-slot"], aside[id*="ad"], aside[class*="ad-"]').each((index, elem) => {
      const $elem = $(elem);
      if ($elem.find('video, iframe[src*="video"], iframe[src*="player"], [class*="player"], [id*="player"]').length) return;
      const isPlayer = $elem.closest('[class*="player"], [id*="player"], [class*="video"], [id*="video"], [class*="jwplayer"]').length > 0;
      if (!isPlayer) $elem.remove();
    });
    $('div[id*="div-gpt-ad"], div[class*="ad-placement"], iframe[src*="doubleclick"], iframe[src*="googlesyndication"]').remove();
    
    // baseタグを追加して相対URLを正しく解決（HTTPをHTTPSに変換）
    if ($('head base').length === 0) {
      $('head').prepend(`<base href="https://${baseUrl.host}${baseUrl.pathname}">`);
    } else {
      // 既存のbaseタグのhrefもHTTPSに変換
      $('head base').each((index, elem) => {
        const href = $(elem).attr('href');
        if (href && href.startsWith('http://')) {
          $(elem).attr('href', href.replace('http://', 'https://'));
        }
      });
    }
    
    // Content Security Policyを緩和（IVFreeのリソースをすべて許可）
    // すべてのCSPメタタグを削除（既存のCSPを確実に削除）
    $('head meta[http-equiv="Content-Security-Policy"]').remove();
    $('head meta[http-equiv="content-security-policy"]').remove();
    $('head meta[http-equiv="CSP"]').remove();
    $('head meta[http-equiv="csp"]').remove();
    
    // CSPを完全に緩和（IVFreeのリソースをすべて許可）
    const ivfreeCspContent = `default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src * 'unsafe-inline' 'unsafe-eval' https://code.jquery.com https://static.adxadserv.com https://www.googletagmanager.com https://www.google-analytics.com https://ivfree.asia https://fonts.googleapis.com; style-src * 'unsafe-inline' https://fonts.googleapis.com https://ivfree.asia; img-src * data: blob: https://ivfree.asia; media-src * blob:; frame-src *; object-src *; base-uri *; form-action *; connect-src *; font-src * data: https://fonts.gstatic.com;`;
    
    // 新しいCSPを追加（metaタグ）
    $('head').prepend(`<meta http-equiv="Content-Security-Policy" content="${ivfreeCspContent}">`);
    try {
      const $head = $('head').length ? $('head') : $('html');
      $('meta[name="viewport"]').remove();
      $head.prepend('<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5, user-scalable=yes, viewport-fit=cover">');
      $head.prepend(`
    <style id="vmeda-mobile">
      html,body{ max-width:100vw !important; overflow-x:hidden !important; -webkit-text-size-adjust:100%; }
      video{ max-width:100% !important; width:100% !important; height:auto !important; min-height:200px !important; object-fit:contain !important; }
      iframe[src*="video"],iframe[src*="embed"],iframe[src*="player"],iframe[src*="stream"], [class*="player"] iframe, [id*="player"] iframe, [class*="video"] iframe { max-width:100% !important; width:100% !important; aspect-ratio:16/9; height:auto !important; min-height:200px !important; }
      [class*="player"]:not(iframe),[id*="player"]:not(iframe),[class*="video-container"],[id*="video-container"]{ max-width:100% !important; width:100% !important; box-sizing:border-box !important; }
      #video-player-container,.video-player-container,#player-container,.player-container{ max-width:100vw !important; width:100% !important; }
    </style>
    `);
    } catch (e) {
      console.warn('ivfree-proxy: viewport/mobile inject failed (ivfree)', e.message);
    }
    
    // jQueryを追加（jQueryが定義されていない場合に備えて）
    // IVFreeのjQueryが読み込めない場合に備えて、CDNからも読み込む（フォールバック）
    if ($('script[src*="jquery"]').length === 0) {
      $('head').prepend(`<script src="https://code.jquery.com/jquery-3.6.0.min.js"></script>`);
    } else {
      // IVFreeのjQueryが読み込めない場合に備えて、CDNからも読み込む（フォールバック）
      $('head').prepend(`<script src="https://code.jquery.com/jquery-3.6.0.min.js"></script>`);
    }
    
    // IVFree用: 最優先でAdBlock検出を無効化＋おとり要素のgetComputedStyle偽装
    $('head').prepend(`
      <style id="vmeda-adblock-spoof">
        ins.adsbygoogle,[id*="google_ads"],[id*="adsbygoogle"],[class*="adsbygoogle"],[id*="div-gpt-ad"],[class*="div-gpt-ad"],[class*="ad-container"],[data-ad-slot],[data-ad-format],[data-google-query-id],[class*="ad-slot"],[id*="ad-slot"],aside[id*="ad"],aside[class*="ad-"],.ad-banner,.banner-ad,[class*="ad-banner"],[class*="advertisement"]{ display:none !important; visibility:hidden !important; opacity:0 !important; height:0 !important; width:0 !important; overflow:hidden !important; position:absolute !important; left:-9999px !important; pointer-events:none !important; }
        [id*="recaptcha"],[id*="captcha"],[class*="recaptcha"],[class*="captcha"],[class*="g-recaptcha"],[class*="robot-verification"],[class*="human-verify"]{ display:none !important; visibility:hidden !important; opacity:0 !important; height:0 !important; overflow:hidden !important; position:absolute !important; left:-9999px !important; pointer-events:none !important; }
      </style>
      <script>
        (function(){
          var f=function(){ return false; }, e=function(){ return []; };
          try{
            if(typeof window.adblock==='undefined') window.adblock=false;
            if(typeof window.AdBlock==='undefined') window.AdBlock=false;
            if(typeof window.uBlock==='undefined') window.uBlock=false;
            if(typeof window.AdGuard==='undefined') window.AdGuard=false;
            if(typeof window.adsbygoogle==='undefined') window.adsbygoogle=[];
            Object.defineProperty(window,'adblock',{ get:f, set:function(){}, configurable:true });
            Object.defineProperty(window,'AdBlock',{ get:f, set:function(){}, configurable:true });
            Object.defineProperty(window,'uBlock',{ get:f, set:function(){}, configurable:true });
            Object.defineProperty(window,'AdGuard',{ get:f, set:function(){}, configurable:true });
            Object.defineProperty(window,'adsbygoogle',{ get:e, set:function(){}, configurable:true });
            if(typeof window.grecaptcha==='undefined') window.grecaptcha={ execute:function(){ return Promise.resolve(''); }, render:function(){ return ''; }, getResponse:function(){ return ''; }, ready:function(cb){ if(cb) cb(); } };
          }catch(err){}
          try{
            window.open=function(){ return null; };
            if(window.showModalDialog) window.showModalDialog=function(){ return null; };
          }catch(err){}
          try{
            var gcs=window.getComputedStyle;
            if(typeof gcs==='function'){
              window.getComputedStyle=function(el,pseudo){
                var s=el&&el.nodeType===1?gcs.call(window,el,pseudo):(el?{}:null);
                if(!s||!el.id&&!el.className) return s;
                var id=(el.id||'').toLowerCase(), cls=(typeof el.className==='string'?el.className:'').toLowerCase(), comb=id+cls;
                if(/google_ads|adsbygoogle|div-gpt-ad|ad-container|ad-slot|ad-format|data-ad/.test(comb)){
                  return { getPropertyValue:function(k){ var v=(k==='display')?'block':(k==='visibility')?'visible':(k==='height'||k==='width')?'1px':(k==='opacity')?'1':(s.getPropertyValue?s.getPropertyValue(k):''); return v||''; }, display:'block', visibility:'visible', height:'1px', width:'1px', opacity:'1' };
                }
                return s;
              };
            }
          }catch(err){}
        })();
      </script>
    `);
    // IVFree用: AdBlockオーバーレイを最優先で除去（早期・高頻度実行）+ 広告層デバッグ
    $('head').prepend(`
      <script>
        (function() {
          var adblockPhrases = ['AdBlock detected', 'Please disable AdBlock / uBlock / AdGuard or change your browser to continue', 'disable AdBlock / uBlock', 'disable AdBlock / uBlock / AdGuard', 'change your browser to continu', 'disable AdBlock', 'disable AdGuard', 'disable UBlock', 'uBlock', 'AdBlock /', 'click ADS to continue', 'click to continue', 'Please turn off adblockers', 'Please turn off adblockers in order and click ADS to continue watching', '順番に広告ブロッカーをオフにし', 'ADSをクリックして視聴を続けてください', 'VPN Recommended', 'Tap to Install and Continue Watching', 'Skip Ad', 'disable your ad blocker', 'whitelist', 'Streaming Blocked', 'to watch this video', 'turn off adblock', 'Please disable', 'disable ads', 'AdBlock is enabled', 'あなたはロボットですか', 'あなたはロボット', 'ロボットではありません', 'ロボットですか', "I'm not a robot", 'I am not a robot', 'Are you a robot', 'Verify you are human', 'Please verify you are human', 'Human verification', 'Security check', 'Security verification', '認証', '確認してください', 'VID.nestio', 'vidnest', 'Video Nest', 'nestio', 'VIDNEST.IO', 'vidnest.io'];
          var debugLogCount = 0;
          var DEBUG_MAX = 8;
          function logAdLayer(el, reason, textSnippet) {
            if (debugLogCount >= DEBUG_MAX) return;
            debugLogCount++;
            var tag = el.tagName || '';
            var id = el.id || '';
            var cls = (el.className && typeof el.className === 'string' ? el.className : '') || '';
            var snip = (textSnippet || '').substring(0, 80);
            console.log('[VMEDA ad layer] ' + reason + ' | ' + tag + (id ? '#' + id : '') + (cls ? '.' + cls.split(/\\s+/).slice(0,2).join('.') : '') + ' | ' + snip);
          }
          function removeAdblockOverlay() {
            try {
              document.querySelectorAll('[id*="adblock"], [id*="ad-block"], [id*="antibot"], [id*="blocked"], [class*="adblock"], [class*="ad-block"], [class*="antibot"], [class*="blocked"], [class*="adblock-message"], [class*="adblock-overlay"]').forEach(function(el) {
                if (el.closest('[class*="player"], [id*="player"], [class*="video"]')) return;
                logAdLayer(el, 'by selector', (el.textContent || el.innerText || '').trim());
                el.remove();
              });
              document.querySelectorAll('*').forEach(function(el) {
                var t = (el.textContent || el.innerText || '').trim();
                if (!t) return;
                var has = adblockPhrases.some(function(p) { return t.indexOf(p) !== -1; });
                if (!has) return;
                if (t.length > 900) return;
                var childHas = false;
                for (var i = 0; i < el.children.length; i++) {
                  var ct = (el.children[i].textContent || el.children[i].innerText || '').trim();
                  if (adblockPhrases.some(function(p) { return ct.indexOf(p) !== -1; })) { childHas = true; break; }
                }
                if (!childHas) {
                  logAdLayer(el, 'by text', t);
                  el.remove();
                }
              });
              var fixed = document.querySelectorAll('div[style*="position:fixed"], div[style*="position: fixed"]');
              fixed.forEach(function(el) {
                if (el.closest('[class*="player"], [id*="player"], [class*="video"]')) return;
                var z = parseInt(window.getComputedStyle(el).zIndex, 10) || 0;
                var txt = (el.textContent || el.innerText || '').toLowerCase();
                if ((z > 100 || z < 0) && /ads?|continue|click|disable|adblock|ublock|adguard|change your browser|whitelist|vidnest|nestio|robot|verify|recaptcha|captcha|ロボット|vidnest\.io/.test(txt)) el.remove();
              });
              document.querySelectorAll('[id*="robot"]:not([id*="player"]),[class*="robot"],[id*="verify"],[class*="verify"],[id*="captcha"]:not([id*="player"]),[class*="captcha"],[id*="vidnest"]:not([id*="player"]),[class*="vidnest"]').forEach(function(el) {
                if (el.closest('[class*="player"], [id*="player"], [class*="video"]')) return;
                if (el.querySelector && el.querySelector('iframe[src*="vidnest"], iframe[src*="video"], video')) return;
                var t = (el.textContent || el.innerText || '').trim().toLowerCase();
                if (t.length > 0 && t.length < 2500 && (t.indexOf('ロボット') !== -1 || t.indexOf('vidnest') !== -1 || t.indexOf('verify') !== -1 || t.indexOf('robot') !== -1)) el.remove();
              });
            } catch (e) {}
          }
          removeAdblockOverlay();
          var earlyCount = 0;
          var earlyId = setInterval(function() { removeAdblockOverlay(); earlyCount++; if (earlyCount >= 25) clearInterval(earlyId); }, 100);
          setInterval(removeAdblockOverlay, 150);
          var mo2 = new MutationObserver(function() { removeAdblockOverlay(); });
          function obs() { var b = document.body || document.documentElement; if (b && b.nodeType === 1) { try { mo2.observe(b, { childList: true, subtree: true }); } catch(e) {} } }
          if (document.body) obs(); else document.addEventListener('DOMContentLoaded', obs);
          // 動的に追加された広告層を検知してログ（判定用）
          try {
            var mo = new MutationObserver(function(mutations) {
              mutations.forEach(function(mut) {
                mut.addedNodes.forEach(function(node) {
                  if (!node || node.nodeType !== 1) return;
                  var t = (node.textContent || node.innerText || '').trim();
                  if (!t) return;
                  var has = adblockPhrases.some(function(p) { return t.indexOf(p) !== -1; });
                  if (has && debugLogCount < DEBUG_MAX) {
                    debugLogCount++;
                    var tag = node.tagName || '', id = node.id || '', cls = (node.className && typeof node.className === 'string' ? node.className : '') || '';
                    console.log('[VMEDA ad layer - added] ' + tag + (id ? '#' + id : '') + (cls ? '.' + String(cls).split(/\\s+/).slice(0,2).join('.') : '') + ' | ' + t.substring(0, 80));
                  }
                });
              });
            });
            var body = document.body || document.documentElement;
            if (body) mo.observe(body, { childList: true, subtree: true });
          } catch (e) {}
        })();
      </script>
    `);
    
    // window.openを無効化するスクリプトを追加（より強力に）
    $('head').prepend(`
      <script>
        (function() {
          // window.openを完全に無効化（より早期に実行）
          const originalOpen = window.open;
          Object.defineProperty(window, 'open', {
            value: function() {
              console.log('🚫 ポップアップがブロックされました');
              return null;
            },
            writable: false,
            configurable: false
          });
          
          // showModalDialogも無効化
          if (window.showModalDialog) {
            window.showModalDialog = function() {
              console.log('🚫 モーダルダイアログがブロックされました');
              return null;
            };
          }
          
          // grecaptcha関数を無効化
          if (typeof window.grecaptcha !== 'undefined') {
            window.grecaptcha = {
              ready: function(callback) { if (callback) callback(); },
              execute: function() { return Promise.resolve(''); },
              render: function() { return ''; },
              reset: function() {},
              getResponse: function() { return ''; }
            };
          }
          Object.defineProperty(window, 'grecaptcha', {
            value: {
              ready: function(callback) { if (callback) callback(); },
              execute: function() { return Promise.resolve(''); },
              render: function() { return ''; },
              reset: function() {},
              getResponse: function() { return ''; }
            },
            writable: false,
            configurable: false
          });
          
          // ポップアップ広告を生成するイベントリスナーを無効化
          const originalAddEventListener = EventTarget.prototype.addEventListener;
          EventTarget.prototype.addEventListener = function(type, listener, options) {
            if (listener && typeof listener === 'function') {
              const listenerStr = listener.toString();
              if (listenerStr.includes('window.open') || listenerStr.includes('popup') || listenerStr.includes('popunder')) {
                console.log('🚫 ポップアップ広告イベントリスナーがブロックされました');
                return;
              }
            }
            return originalAddEventListener.call(this, type, listener, options);
          };
          
          // ポップアップ広告を生成するsetTimeout/setIntervalを監視
          const originalSetTimeout = window.setTimeout;
          window.setTimeout = function(func, delay) {
            if (func && typeof func === 'function') {
              const funcStr = func.toString();
              if (funcStr.includes('window.open') || funcStr.includes('popup') || funcStr.includes('popunder')) {
                console.log('🚫 ポップアップ広告のsetTimeoutがブロックされました');
                return 0;
              }
            }
            return originalSetTimeout.call(window, func, delay);
          };
          
          const originalSetInterval = window.setInterval;
          window.setInterval = function(func, delay) {
            if (func && typeof func === 'function') {
              const funcStr = func.toString();
              if (funcStr.includes('window.open') || funcStr.includes('popup') || funcStr.includes('popunder')) {
                console.log('🚫 ポップアップ広告のsetIntervalがブロックされました');
                return 0;
              }
            }
            return originalSetInterval.call(window, func, delay);
          };
          
          // MutationObserverを使って、ポップアップ広告を動的に除去
          function removePopupAds() {
            // ポップアップ広告を生成する要素を除去
            const popupSelectors = [
              'a[onclick*="window.open"]',
              'a[onclick*="popup"]',
              'a[onclick*="popunder"]',
              'button[onclick*="window.open"]',
              'button[onclick*="popup"]',
              'div[onclick*="window.open"]',
              'div[onclick*="popup"]',
              'iframe[src*="ad"]',
              'iframe[src*="popup"]',
              '[class*="popup"]',
              '[class*="pop-up"]',
              '[id*="popup"]',
              '[id*="pop-up"]'
            ];
            
            popupSelectors.forEach(selector => {
              try {
                document.querySelectorAll(selector).forEach(elem => {
                  const onclick = elem.getAttribute('onclick') || '';
                  const href = elem.getAttribute('href') || '';
                  const src = elem.getAttribute('src') || '';
                  if (onclick.includes('window.open') || onclick.includes('popup') || onclick.includes('popunder') ||
                      href.includes('popup') || href.includes('popunder') || src.includes('popup') || src.includes('popunder')) {
                    elem.remove();
                  }
                });
              } catch(e) {}
            });
            
              // ロボット検証（CAPTCHA/reCAPTCHA）の要素を除去（ただし、動画プレイヤーの要素は保護）
              const captchaSelectors = [
                'iframe[src*="recaptcha"]',
                'iframe[src*="captcha"]',
                'iframe[src*="google.com/recaptcha"]',
                'iframe[src*="gstatic.com/recaptcha"]',
                'div[id*="recaptcha"]',
                'div[id*="captcha"]',
                'div[class*="recaptcha"]',
                'div[class*="captcha"]',
                '[id*="cf-browser-verification"]',
                '[class*="cf-browser-verification"]',
                '[id*="challenge-platform"]',
                '[class*="challenge-platform"]'
              ];
              
              captchaSelectors.forEach(selector => {
                try {
                  document.querySelectorAll(selector).forEach(elem => {
                    // 動画プレイヤーの要素は保護
                    const isPlayerElement = elem.closest('[class*="player"], [id*="player"], [class*="video"], [id*="video"], [class*="jwplayer"], [id*="jwplayer"]') ||
                                           elem.querySelector('[class*="player"], [id*="player"], [class*="video"], [id*="video"], [class*="jwplayer"], [id*="jwplayer"]');
                    if (!isPlayerElement) {
                      elem.remove();
                    }
                  });
                } catch(e) {}
              });
              
              // reCAPTCHAのdata-sitekey属性を持つdivを除去（ただし、動画プレイヤーの要素は保護）
              try {
                document.querySelectorAll('div[data-sitekey]').forEach(elem => {
                  const sitekey = elem.getAttribute('data-sitekey') || '';
                  // 動画プレイヤーの要素は保護
                  const isPlayerElement = elem.closest('[class*="player"], [id*="player"], [class*="video"], [id*="video"], [class*="jwplayer"], [id*="jwplayer"]') ||
                                         elem.querySelector('[class*="player"], [id*="player"], [class*="video"], [id*="video"], [class*="jwplayer"], [id*="jwplayer"]');
                  // reCAPTCHAのsitekeyは通常6文字以上の文字列
                  if (!isPlayerElement && sitekey.length >= 6 && !sitekey.includes('video') && !sitekey.includes('player')) {
                    elem.remove();
                  }
                });
              } catch(e) {}
              
              // reCAPTCHAのdata-callback属性を持つdivを除去（ただし、動画プレイヤーの要素は保護）
              try {
                document.querySelectorAll('div[data-callback]').forEach(elem => {
                  const callback = elem.getAttribute('data-callback') || '';
                  // 動画プレイヤーの要素は保護
                  const isPlayerElement = elem.closest('[class*="player"], [id*="player"], [class*="video"], [id*="video"], [class*="jwplayer"], [id*="jwplayer"]') ||
                                         elem.querySelector('[class*="player"], [id*="player"], [class*="video"], [id*="video"], [class*="jwplayer"], [id*="jwplayer"]');
                  // reCAPTCHAのcallbackは通常recaptchaを含む
                  if (!isPlayerElement && (callback.includes('recaptcha') || callback.includes('captcha'))) {
                    elem.remove();
                  }
                });
              } catch(e) {}
              
              // AdBlock検出メッセージを除去
              try {
                const adBlockPhrases = ['AdBlock detected', 'Please disable AdBlock / uBlock / AdGuard or change your browser to continue', 'disable AdBlock / uBlock', 'change your browser to continue', 'Please disable AdBlock', 'disable AdGuard', 'turn off adblockers', 'Please turn off adblockers in order and click ADS to continue watching', 'click ADS to continue', 'VPN Recommended', 'Tap to Install and Continue Watching', 'Skip Ad'];
                document.querySelectorAll('*').forEach(function(elem) {
                  const t = (elem.textContent || elem.innerText || '').trim();
                  if (!t) return;
                  const hasMsg = adBlockPhrases.some(function(p) { return t.indexOf(p) !== -1; });
                  if (!hasMsg) return;
                  var hasChildWithMsg = false;
                  for (var i = 0; i < elem.children.length; i++) {
                    const ct = (elem.children[i].textContent || elem.children[i].innerText || '').trim();
                    if (adBlockPhrases.some(function(p) { return ct.indexOf(p) !== -1; })) { hasChildWithMsg = true; break; }
                  }
                  if (!hasChildWithMsg) elem.remove();
                });
              } catch(e) {}
            
            // ロボット検証のメッセージを含む要素を除去
            try {
              document.querySelectorAll('*').forEach(elem => {
                const text = elem.textContent || elem.innerText || '';
                const lower = text.toLowerCase();
                if (text.includes('あなたはロボットですか') || text.includes('あなたはロボット') || text.includes('ロボットですか') ||
                    text.includes('ロボットではありません') || text.includes("I'm not a robot") || text.includes('I am not a robot') ||
                    text.includes('Verify you are human') || text.includes("Verify you're human") || text.includes('Please verify you are human') ||
                    text.includes("Please verify you're human") || text.includes('Human verification') ||
                    text.includes('Security check') || text.includes('Security verification') ||
                    text.includes('Cloudflare') || text.includes('Checking your browser') ||
                    text.includes('Just a moment') || text.includes('Please wait') ||
                    text.includes('Verifying') || text.includes('Verification') ||
                    text.includes('CAPTCHA') || text.includes('reCAPTCHA') ||
                    text.includes('VIDNEST.IO') || lower.includes('vidnest.io') ||
                    (lower.includes('vidnest') && (text.includes('ロボット') || lower.includes('robot') || lower.includes('verify')))) {
                  elem.remove();
                }
              });
            } catch(e) {}
          }
          
          // ページ読み込み時に実行
          if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', removePopupAds);
          } else {
            removePopupAds();
          }
          
          // MutationObserverで動的に除去
          const observer = new MutationObserver(function(mutations) {
            removePopupAds();
          });
          
          const obsTarget = document.body || document.documentElement;
          if (obsTarget && obsTarget.nodeType === 1) {
            try {
              observer.observe(obsTarget, {
                childList: true,
                subtree: true
              });
            } catch (e) {}
          }
          
          // 定期的に除去（念のため）
          setInterval(removePopupAds, 500);
        })();
      </script>
    `);
    
    // 再生クリック時のポップアップ防止: 他スクリプトより先に実行するため最後に prepend
    $('head').prepend('<script>window.open=function(){return null;};if(window.showModalDialog)window.showModalDialog=function(){return null;};</script>');
    
    let html = $.html();
    
    // CORSヘッダーを設定
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // CSPをさらに緩和（レスポンスヘッダーでも設定）
    const cspContent = `default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src * 'unsafe-inline' 'unsafe-eval' https://code.jquery.com https://static.adxadserv.com https://www.googletagmanager.com https://www.google-analytics.com; style-src * 'unsafe-inline'; img-src * data: blob:; media-src * blob:; frame-src *; object-src *; base-uri *; form-action *; connect-src *; font-src * data:;`;
    res.setHeader('Content-Security-Policy', `${cspContent} frame-ancestors *;`);
    
    // 残る http://ivfree.asia を https に統一（Mixed Content でスクリプトがブロックされ動画が再生できないのを防ぐ）
    html = html.replace(/http:\/\/ivfree\.asia/gi, 'https://ivfree.asia');
    
    console.log('✅ IVFreeプロキシレスポンス送信');
    res.send(html);
  } catch (error) {
    console.error('❌ IVFreeプロキシエラー:', error.message);
    if (error.stack) {
      console.error('❌ スタックトレース:', error.stack.substring(0, 500));
    }
    res.status(500).send(`<html><head><meta charset="utf-8"></head><body><h1>エラー</h1><p>ページの読み込みに失敗しました: ${error.message}</p><p><a href="${req.query.url}" target="_blank">元のページを開く</a></p></body></html>`);
  }
});
}

module.exports = { register };
