'use strict';
/**
 * VMEDA pizjav-proxy: Pizjav動画ページ用プロキシ（広告除去）
 * api/index.js の負荷軽減のため分離
 */
const cheerio = require('cheerio');
const axios = require('axios');

function register(app) {
  app.get('/api/pizjav-proxy', async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Max-Age', '86400');
      return res.status(200).end();
    }

    try {
      const videoUrl = req.query.url;
      if (!videoUrl) {
        return res.status(400).json({ error: 'URL is required' });
      }

      const isPizjavUrl = videoUrl.includes('pizjav.com');
      if (!isPizjavUrl) {
        return res.status(400).json({ error: 'Pizjav URL is required' });
      }

      console.log('📺 Pizjav動画ページをプロキシ経由で取得:', videoUrl);

      const response = await axios.get(videoUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://v.pizjav.com/',
          'Accept-Encoding': 'gzip, deflate, br'
        },
        timeout: 30000,
        maxRedirects: 5
      });

      const $ = cheerio.load(response.data);
      const baseUrl = new URL(videoUrl);
      const origin = `${baseUrl.protocol}//${baseUrl.host}`;
      if ($('head base').length === 0) {
        $('head').prepend(`<base href="${origin}/">`);
      }

      // モバイル向け viewport とレイアウトを注入（IVFree と同等の見え方に調整）
      try {
        const $head = $('head').length ? $('head') : $('html');
        $('meta[name="viewport"]').remove();
        $head.prepend('<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5, user-scalable=yes, viewport-fit=cover">');
        $head.prepend(`
      <style id="vmeda-mobile">
        html,body{ max-width:100vw !important; overflow-x:hidden !important; -webkit-text-size-adjust:100%; }
        video{ max-width:100% !important; width:100% !important; height:auto !important; min-height:200px !important; object-fit:contain !important; }
        iframe[src*="video"],iframe[src*="embed"],iframe[src*="player"],iframe[src*="stream"],iframe[src*="phimvu"], [class*="player"] iframe, [id*="player"] iframe, [class*="video"] iframe, [class*="videoWrapper"] iframe { max-width:100% !important; width:100% !important; aspect-ratio:16/9; height:auto !important; min-height:200px !important; }
        [class*="player"]:not(iframe),[id*="player"]:not(iframe),[class*="video-container"],[id*="video-container"],[class*="videoWrapper"]{ max-width:100% !important; width:100% !important; box-sizing:border-box !important; }
        #video-player-container,.video-player-container,#player-container,.player-container{ max-width:100vw !important; width:100% !important; }
      </style>
      `);
        $head.prepend(`
      <style id="vmeda-mobile-scale">
        @media screen and (max-width:1024px){ html{ overflow-x:hidden !important; overflow-y:auto !important; -webkit-overflow-scrolling:touch !important; } body{ width:960px !important; min-width:960px !important; transform:scale(0.5) !important; transform-origin:0 0 !important; -webkit-transform:scale(0.5) !important; -webkit-transform-origin:0 0 !important; } @media(max-width:430px){ body{ transform:scale(0.45) !important; -webkit-transform:scale(0.45) !important; } } @media(max-width:414px){ body{ transform:scale(0.43) !important; -webkit-transform:scale(0.43) !important; } } @media(max-width:375px){ body{ transform:scale(0.39) !important; -webkit-transform:scale(0.39) !important; } } @media(max-width:360px){ body{ transform:scale(0.375) !important; -webkit-transform:scale(0.375) !important; } } @media(max-width:320px){ body{ transform:scale(0.33) !important; -webkit-transform:scale(0.33) !important; } } [class*="videoWrapper"],[class*="video-wrapper"]{ max-height:50vh !important; } }
      </style>
      `);
      } catch (e) {
        console.warn('pizjav-proxy: viewport/mobile inject failed', e.message);
      }

      $('head').prepend(`
      <script>
        (function(){
          var noop = function(){ return null; };
          try {
            if (window.open) window.open = noop;
            Object.defineProperty(window, 'open', { value: noop, writable: false, configurable: false });
          } catch(e) {}
          window.open = noop;
        })();
      </script>
    `);

      $('script').each((index, elem) => {
        const scriptContent = $(elem).html() || '';
        const scriptSrc = $(elem).attr('src') || '';
        const isPlayerScript = scriptSrc.includes('jwplayer') ||
          scriptSrc.includes('video.js') ||
          scriptSrc.includes('player') ||
          scriptSrc.includes('video') ||
          scriptContent.includes('jwplayer') ||
          scriptContent.includes('video.js') ||
          scriptContent.includes('JWPlayer') ||
          scriptContent.includes('VideoJS');
        if (isPlayerScript) return;
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
        }
      });

      $('a[onclick], button[onclick], div[onclick], span[onclick], [onclick]').each((index, elem) => {
        const onclick = ($(elem).attr('onclick') || '').toLowerCase();
        if (onclick.includes('window.open') || onclick.includes('popup') || onclick.includes('popunder')) {
          $(elem).removeAttr('onclick');
        }
      });

      $('a[target="_blank"]').each((index, elem) => {
        const href = ($(elem).attr('href') || '').toLowerCase();
        const isAdLike = /ad[s]?\.|popup|popunder|click\.|redirect|banner|promo|affiliate|tracking|doubleclick|googlesyndication/i.test(href) ||
          href.includes('popup') || href.includes('popunder');
        if (isAdLike || href.startsWith('javascript:')) {
          $(elem).removeAttr('href').removeAttr('target').attr('href', 'javascript:void(0)');
        }
      });

      $('div[style*="position:fixed"], div[style*="position: fixed"]').each((index, elem) => {
        const $elem = $(elem);
        const z = parseInt($elem.css('z-index'), 10) || 0;
        const text = ($elem.text() || '').toLowerCase();
        const hasAdLinks = $elem.find('a[href*="ad"]').length > 0 || $elem.find('a[href*="popup"]').length > 0;
        if (z > 999 && (hasAdLinks || /adblock|disable ad|click ads|close ad|ad\s*close/i.test(text))) {
          $elem.remove();
        }
      });

      $('iframe').each((index, elem) => {
        const src = $(elem).attr('src') || '';
        const id = $(elem).attr('id') || '';
        const classAttr = $(elem).attr('class') || '';
        if (
          (src.includes('recaptcha') || src.includes('captcha') || src.includes('google.com/recaptcha') || src.includes('gstatic.com/recaptcha') ||
            id.includes('recaptcha') || id.includes('captcha') ||
            classAttr.includes('recaptcha') || classAttr.includes('captcha')) &&
          !src.includes('video') && !src.includes('player')
        ) {
          $(elem).remove();
        }
      });

      if ($('script[src*="jquery"]').length === 0) {
        $('head').prepend(`<script src="https://code.jquery.com/jquery-3.6.0.min.js"></script>`);
      }

      $('head').prepend(`
        <script>
          if (typeof window.cookieIndex === 'undefined') { window.cookieIndex = 0; }
          if (typeof cookieIndex === 'undefined') { var cookieIndex = 0; }
          (function waitForJQuery() {
            if (typeof jQuery === 'undefined') {
              setTimeout(waitForJQuery, 50);
              return;
            }
            if (typeof window.$ === 'undefined') {
              window.$ = jQuery;
            }
            if (typeof window.jQuery === 'undefined') {
              window.jQuery = jQuery;
            }
          })();
          if (typeof window.FastSearch === 'undefined') {
            window.FastSearch = function() {};
          }
          (function() {
            const originalOpen = window.open;
            Object.defineProperty(window, 'open', {
              value: function() {
                console.log('🚫 ポップアップがブロックされました');
                return null;
              },
              writable: false,
              configurable: false
            });
            if (window.showModalDialog) {
              window.showModalDialog = function() {
                return null;
              };
            }
            if (typeof grecaptcha !== 'undefined') {
              grecaptcha.execute = function() { return Promise.resolve(''); };
              grecaptcha.render = function() { return ''; };
              grecaptcha.reset = function() {};
              grecaptcha.getResponse = function() { return ''; };
            }
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
            const observer = new MutationObserver(function(mutations) {
              mutations.forEach(function(mutation) {
                mutation.addedNodes.forEach(function(node) {
                  if (node.nodeType === 1) {
                    if (node.classList && (
                      node.classList.contains('popup') ||
                      node.classList.contains('pop-up') ||
                      node.classList.contains('popunder') ||
                      node.id && (node.id.includes('popup') || node.id.includes('pop-up') || node.id.includes('popunder'))
                    )) {
                      node.remove();
                    }
                    const text = node.textContent || node.innerText || '';
                    if (text && (
                      text.includes('Please change your browser') ||
                      text.includes('change your browser to continue') ||
                      text.includes('AdBlock detected') ||
                      text.includes('disable AdBlock') ||
                      text.includes('disable UBlock') ||
                      text.includes('disable AdGuard') ||
                      text.includes('to watch this video') ||
                      text.includes('AdBlock / UBlock') ||
                      text.includes('AdBlock / AdGuard') ||
                      text.includes('change your browser or disable') ||
                      text.includes('turn off adblockers') ||
                      text.includes('click ADS to continue') ||
                      text.includes('VPN Recommended') ||
                      text.includes('Tap to Install and Continue Watching') ||
                      text.includes('Skip Ad')
                    )) {
                      node.remove();
                    }
                    const popups = node.querySelectorAll && node.querySelectorAll('.popup, .pop-up, .popunder, [id*="popup"], [id*="pop-up"], [id*="popunder"]');
                    if (popups) {
                      popups.forEach(function(popup) {
                        popup.remove();
                      });
                    }
                    const adBlockMessages = node.querySelectorAll && node.querySelectorAll('*');
                    if (adBlockMessages) {
                      adBlockMessages.forEach(function(elem) {
                        const elemText = elem.textContent || elem.innerText || '';
                        if (elemText && (
                          elemText.includes('Please change your browser') ||
                          elemText.includes('change your browser to continue') ||
                          elemText.includes('AdBlock detected') ||
                          elemText.includes('disable AdBlock') ||
                          elemText.includes('disable UBlock') ||
                          elemText.includes('disable AdGuard') ||
                          elemText.includes('to watch this video') ||
                          elemText.includes('AdBlock / UBlock') ||
                          elemText.includes('AdBlock / AdGuard') ||
                          elemText.includes('turn off adblockers') ||
                          elemText.includes('click ADS to continue') ||
                          elemText.includes('VPN Recommended') ||
                          elemText.includes('Tap to Install and Continue Watching') ||
                          elemText.includes('Skip Ad')
                        )) {
                          elem.remove();
                        }
                      });
                    }
                  }
                });
              });
            });
            function initObserver() {
              const bodyNode = document.body;
              if (bodyNode && bodyNode.nodeType === 1) {
                try {
                  observer.observe(bodyNode, {
                    childList: true,
                    subtree: true
                  });
                } catch (e) {}
              } else {
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
        <script>
        (function(){
          function removeBottomCloseableAds(){
            try{
              var vpH=window.innerHeight||document.documentElement.clientHeight||0;
              if(vpH<=0) return;
              var closePhrases=['×','✕','X','閉じる','close','広告を閉じる','skip ad','skip'];
              var adPhrases=['広告','sponsored','ads','advertisement','ad ','VPN Recommended','Tap to Install and Continue Watching','Skip Ad'];
              document.querySelectorAll('div,section,aside').forEach(function(el){
                if(!el||el.nodeType!==1) return;
                if(el.closest&&el.closest('[class*="player"],[id*="player"],[class*="video"],[id*="video"]')) return;
                var id=(el.id||'').toLowerCase();
                var cls=(typeof el.className==='string'?el.className:'').toLowerCase();
                if(id.indexOf('vmeda')!==-1||cls.indexOf('vmeda')!==-1) return;
                var rect;
                try{ rect=el.getBoundingClientRect(); }catch(e){ return; }
                if(!rect||rect.height<30||rect.width<150) return;
                if(rect.top<vpH*0.5) return;
                var t=(el.innerText||el.textContent||'').trim();
                var hasClose=false;
                [].slice.call(el.querySelectorAll('[aria-label],[class],[id],button,a,span')).forEach(function(child){
                  var ct=(child.innerText||child.textContent||'').trim();
                  var al=(child.getAttribute&&child.getAttribute('aria-label'))||'';
                  var ccls=(child.className&&typeof child.className==='string'?child.className:'')||'';
                  if(ct.length<=5&&(closePhrases.some(function(p){ return ct===p||ct.indexOf(p)!==-1; })||/close|閉じる/i.test(al+ccls))) hasClose=true;
                });
                if(t.length<=10&&closePhrases.some(function(p){ return t===p||t.indexOf(p)!==-1; })) hasClose=true;
                var isAdLike=adPhrases.some(function(p){ return t.toLowerCase().indexOf(p)!==-1; });
                if(hasClose||(isAdLike&&rect.height<=vpH*0.4)) el.remove();
              });
            }catch(e){}
          }
          function run(){ removeBottomCloseableAds(); }
          if(document.body) run();
          else document.addEventListener('DOMContentLoaded',run);
          var mo=new MutationObserver(function(){ removeBottomCloseableAds(); });
          if(document.body) try{ mo.observe(document.body,{ childList:true, subtree:true }); }catch(e){}
          setInterval(removeBottomCloseableAds,500);
        })();
        </script>
      `);

      // ※ pizjav ではクライアント側 MutationObserver で AdBlock/ロボット確認メッセージを除去する。
      //   サーバー側で本文ブロックを誤って消してしまうケースがあったため、ここでの一括削除は無効化。

      $('a[href], img[src], script[src], link[href], iframe[src]').each((index, elem) => {
        const $elem = $(elem);
        ['href', 'src'].forEach(attr => {
          const url = $elem.attr(attr);
          if (url && !url.startsWith('http') && !url.startsWith('//') && !url.startsWith('data:') && !url.startsWith('javascript:')) {
            if (url.startsWith('/')) {
              $elem.attr(attr, `${baseUrl.protocol}//${baseUrl.host}${url}`);
            } else {
              $elem.attr(attr, `${baseUrl.protocol}//${baseUrl.host}/${url}`);
            }
          }
        });
      });

      const cspContent = `default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src * 'unsafe-inline' 'unsafe-eval' https://code.jquery.com https://static.adxadserv.com https://www.googletagmanager.com https://www.google-analytics.com; style-src * 'unsafe-inline'; img-src * data: blob:; media-src * blob:; frame-src *; object-src *; base-uri *; form-action *; connect-src *; font-src * data:;`;
      res.setHeader('Content-Security-Policy', `${cspContent} frame-ancestors *;`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');

      let pizjavHtml = $.html();
      pizjavHtml = pizjavHtml.replace(/http:\/\/v\.pizjav\.com/gi, 'https://v.pizjav.com');
      pizjavHtml = pizjavHtml.replace(/http:\/\/pizjav\.com/gi, 'https://pizjav.com');
      console.log('✅ Pizjavプロキシレスポンス送信');
      res.send(pizjavHtml);
    } catch (error) {
      console.error('❌ Pizjavプロキシエラー:', error.message);
      res.status(500).send(`
      <html>
        <head><title>Error</title></head>
        <body>
          <h1>Failed to load video</h1>
          <p>Error: ${error.message}</p>
        </body>
      </html>
    `);
    }
  });
}

module.exports = { register };
