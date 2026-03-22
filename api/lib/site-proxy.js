'use strict';
/**
 * VMEDA site-proxy: ??????VMEDA?E?????E??E???????????E??????E??????E?E * api/index.js ??????E???E??
 */
const cheerio = require('cheerio');
const axios = require('axios');

const SITE_PROXY_ALLOWED_HOSTS = [
  'ivfree.asia', 'aivfree.com', 'jpdmv.com', 'pizjav.com', 'javmix.tv', 'japanhub.net', 'japanhub.com',
  'douga4.top', 'fc2video.org', 'fc2.com', 'jable.tv', 'x1hub.com', 'airav.io', 'airav.com',
  'luluvid.com', 'loadvid.com', 'vidnest.io', 'lulustream.com', 'luluvdoo.com',
  'streamtape.com', 'streamtape.co', 'doodstream.com', 'dood.re', 'dood.so', 'dood.watch',
  'mixdrop.com', 'mixdrop.co', 'filemoon.sx', 'filemoon.to', 'filemoon.work',
  'vudeo.co', 'streamlare.com', 'streamlare.to', 'streamtape.to', 'aparat.cam',
  'feurl.com', 'upstream.to', 'dropbox.com', 'drive.google.com',
  'phimvu.app'
];
/** 動画埋め込み用ホスト: 親ページ(ivfree/pizjav等)の iframe をこれら向けのときもプロキシ経由にする */
const EMBED_PLAYER_HOSTS = [
  'vidnest.io', 'luluvid.com', 'loadvid.com', 'lulustream.com', 'luluvdoo.com',
  'streamtape.com', 'streamtape.co', 'streamtape.to', 'doodstream.com', 'dood.re', 'dood.so', 'dood.watch',
  'mixdrop.com', 'mixdrop.co', 'filemoon.sx', 'filemoon.to', 'filemoon.work',
  'vudeo.co', 'streamlare.com', 'streamlare.to', 'aparat.cam', 'feurl.com', 'upstream.to',
  'phimvu.app'
];

function isAllowedSiteProxyUrl(url) {
  try {
    const u = new URL(url);
    const host = (u.hostname || '').toLowerCase();
    return SITE_PROXY_ALLOWED_HOSTS.some(h => host === h || host.endsWith('.' + h));
  } catch (e) { return false; }
}

function isEmbedPlayerHost(hostname) {
  const h = (hostname || '').toLowerCase();
  return EMBED_PLAYER_HOSTS.some(entry => h === entry || h.endsWith('.' + entry));
}

function register(app) {
  app.get('/api/site-proxy', async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Max-Age', '86400');
      return res.status(200).end();
    }
    try {
      const targetUrl = req.query.url;
      if (!targetUrl || !isAllowedSiteProxyUrl(targetUrl)) {
        try {
          const parsed = targetUrl ? new URL(decodeURIComponent(targetUrl)) : null;
          console.warn('site-proxy REJECTED url:', targetUrl || '(empty)', 'host:', parsed ? parsed.hostname : 'n/a');
        } catch (e) { console.warn('site-proxy REJECTED url:', targetUrl || '(empty)'); }
        return res.status(400).send('Invalid or disallowed URL');
      }
      let decodedUrl = decodeURIComponent(targetUrl);
      console.log('📄 site-proxy:', decodedUrl);
      let response;
      let uaToUse = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
      try {
        const reqUA = (req.get && req.get('user-agent')) || (req.headers && req.headers['user-agent']) || '';
        const safeUA = (typeof reqUA === 'string' ? reqUA : '').replace(/[\r\n\x00-\x1f]/g, '').trim().slice(0, 400) || '';
        const isEmbed = (() => { try { const h = new URL(decodedUrl).hostname; return EMBED_PLAYER_HOSTS.some(e => (h || '').toLowerCase() === e || (h || '').toLowerCase().endsWith('.' + e)); } catch (e) { return false; } })();
        if (isEmbed && safeUA.length > 20) uaToUse = safeUA;
      } catch (e) {}
      const fetchOpts = {
        headers: {
          'User-Agent': uaToUse,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': decodedUrl
        },
        timeout: 25000,
        maxRedirects: 5,
        validateStatus: s => s >= 200 && s < 400,
        responseType: 'arraybuffer'
      };
      try {
        response = await axios.get(decodedUrl, fetchOpts);
      } catch (fetchErr) {
        if (decodedUrl.startsWith('https://ivfree.asia')) {
          decodedUrl = decodedUrl.replace('https://', 'http://');
          console.log('?? site-proxy retry (http):', decodedUrl);
          response = await axios.get(decodedUrl, fetchOpts);
        } else if (decodedUrl.startsWith('http://ivfree.asia')) {
          decodedUrl = decodedUrl.replace('http://', 'https://');
          console.log('📄 site-proxy retry (https):', decodedUrl);
          response = await axios.get(decodedUrl, fetchOpts);
        } else if (decodedUrl.includes('pizjav.com')) {
          decodedUrl = decodedUrl.replace(/^http:/, 'https:').replace(/^https:/, 'http:');
          console.log('📄 site-proxy retry (pizjav):', decodedUrl);
          response = await axios.get(decodedUrl, fetchOpts);
        } else {
          throw fetchErr;
        }
      }
      const contentType = (response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const isHtml = contentType === 'text/html' || contentType === 'application/xhtml+xml';
      const host = req.get && req.get('host') ? req.get('host') : (req.headers && req.headers.host) || 'vmeda.vercel.app';
      const proxyPrefix = `https://${host}/api/site-proxy?url=`;
      if (!isHtml) {
        const decodedLower = (decodedUrl || '').toLowerCase();
        const isBlockedAdResource = /tapioni\.com|outdidfillet\.com|afrdtech\.com|cloudflareinsights\.com|asg_embed|beacon\.min\.js\/vcd|doubleclick|googlesyndication|googleadservices|dongojyousan/i.test(decodedLower);
        if (isBlockedAdResource) {
          res.setHeader('Content-Type', 'application/javascript');
          res.setHeader('Cache-Control', 'no-store');
          return res.status(200).send('/* VMEDA: ad/tracker blocked */');
        }
        res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');
        res.setHeader('Cache-Control', 'public, max-age=300');
        if (contentType === 'text/css') {
          const baseUrl = new URL(decodedUrl);
          const baseHost = baseUrl.hostname;
          let css = Buffer.from(response.data).toString('utf8');
          css = css.replace(/url\s*\(\s*['"]?([^)'"]+)['"]?\s*\)/g, (match, part) => {
            const trimmed = String(part).trim();
            if (!trimmed || trimmed.startsWith('data:')) return match;
            try {
              const abs = new URL(trimmed, decodedUrl).href;
              const absHost = new URL(abs).hostname;
              if (baseHost === absHost && isAllowedSiteProxyUrl(abs)) {
                return `url("${proxyPrefix + encodeURIComponent(abs)}")`;
              }
            } catch (e) {}
            return match;
          });
          return res.send(css);
        }
        return res.send(Buffer.from(response.data));
      }
      const htmlBody = Buffer.from(response.data).toString('utf8');
      let $;
      try {
        $ = cheerio.load(htmlBody);
      } catch (cheerioErr) {
        console.error('site-proxy cheerio.load failed:', cheerioErr.message);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Security-Policy', 'frame-ancestors *');
        return res.send(htmlBody);
      }
      const baseUrl = new URL(decodedUrl);
      const origin = baseUrl.origin + '/';
      const isIvfree = baseUrl.hostname === 'ivfree.asia';
      const isAivfree = baseUrl.hostname === 'aivfree.com';
      const isEmbedPage = /\/embed\/|\/e\/|embed-[a-z0-9]+\.html/i.test(decodedUrl);
      const isPizjav = (baseUrl.hostname || '').toLowerCase().endsWith('pizjav.com');
      const userAgent = (req.get && req.get('user-agent')) || (req.headers && req.headers['user-agent']) || '';
      const isMobileRequest = /iPhone|iPad|iPod|Android.*Mobile|webOS|Mobile|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);
      if ($('head base').length === 0) {
        $('head').prepend(`<base href="${origin}">`);
      }
      try {
        const $head = $('head').length ? $('head') : $('html');
        $('meta[name="viewport"]').remove();
        $head.prepend('<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5, user-scalable=yes, viewport-fit=cover">');
        $head.prepend(`
      <style id="vmeda-mobile">
        html,body{ max-width:100vw !important; overflow-x:hidden !important; -webkit-text-size-adjust:100%; }
        video{ max-width:100% !important; width:100% !important; height:auto !important; min-height:200px !important; object-fit:contain !important; }
        iframe[src*="video"],iframe[src*="embed"],iframe[src*="player"],iframe[src*="stream"],iframe[src*="vidnest"],iframe[src*="loadvid"],iframe[src*="luluvid"], [class*="player"] iframe, [id*="player"] iframe, [class*="video"] iframe, [id*="video"] iframe { max-width:100% !important; width:100% !important; aspect-ratio:16/9; height:auto !important; min-height:200px !important; }
        [class*="player"]:not(iframe),[id*="player"]:not(iframe),[class*="video-container"],[id*="video-container"],[class*="video-wrapper"],[id*="video-wrapper"]{ max-width:100% !important; width:100% !important; box-sizing:border-box !important; }
        #video-player-container,.video-player-container,#player-container,.player-container{ max-width:100vw !important; width:100% !important; }
        @media (max-width:768px){
          iframe[src*="embed"],iframe[src*="video"],iframe[src*="vidnest"],iframe[src*="player"],[class*="player"] iframe,[class*="video"] iframe{ max-width:100% !important; width:100% !important; height:56.25vw !important; min-height:220px !important; max-height:75vh !important; aspect-ratio:16/9; }
          [class*="video-container"],[class*="video-wrapper"],[class*="player"]:not(iframe),[id*="player"]:not(iframe){ max-width:100% !important; width:100% !important; }
        }
      </style>
      `);
      if (isIvfree || isAivfree || isPizjav) {
        try {
          const isEmbedOnly = isEmbedPage && (baseUrl.hostname || '').toLowerCase().match(/vidnest|loadvid|luluvid|lulustream|luluvdoo/i);
          if (!isEmbedOnly) {
          // Pizjav: User-Agentに依存せずメディアクエリのみでモバイル適用（iPhoneでPC表示になる問題対策）
          const useMediaQueryOnly = isPizjav;
          const mobileScaleCss = (useMediaQueryOnly || !isMobileRequest)
            ? `@media screen and (max-width:1024px){ html{ overflow-x:hidden !important; overflow-y:auto !important; -webkit-overflow-scrolling:touch !important; } body{ width:960px !important; min-width:960px !important; transform:scale(0.5) !important; transform-origin:0 0 !important; -webkit-transform:scale(0.5) !important; -webkit-transform-origin:0 0 !important; } @media(max-width:480px){ body{ transform:scale(0.5) !important; -webkit-transform:scale(0.5) !important; } } @media(max-width:430px){ body{ transform:scale(0.45) !important; -webkit-transform:scale(0.45) !important; } } @media(max-width:414px){ body{ transform:scale(0.43) !important; -webkit-transform:scale(0.43) !important; } } @media(max-width:375px){ body{ transform:scale(0.39) !important; -webkit-transform:scale(0.39) !important; } } @media(max-width:360px){ body{ transform:scale(0.375) !important; -webkit-transform:scale(0.375) !important; } } @media(max-width:320px){ body{ transform:scale(0.33) !important; -webkit-transform:scale(0.33) !important; } } [class*="videoWrapper"],[class*="video-wrapper"]{ max-height:none !important; overflow:visible !important; } iframe[src*="phimvu"],iframe[src*="embed"],[class*="videoWrapper"] iframe{ max-height:none !important; } }`
            : `html{ overflow-x:hidden !important; overflow-y:auto !important; -webkit-overflow-scrolling:touch !important; } body{ width:960px !important; min-width:960px !important; transform:scale(0.5) !important; transform-origin:0 0 !important; -webkit-transform:scale(0.5) !important; -webkit-transform-origin:0 0 !important; } @media(max-width:430px){ body{ transform:scale(0.45) !important; -webkit-transform:scale(0.45) !important; } } @media(max-width:375px){ body{ transform:scale(0.39) !important; -webkit-transform:scale(0.39) !important; } } [class*="videoWrapper"],[class*="video-wrapper"]{ max-height:none !important; overflow:visible !important; }`;
          const overlayHideCss = (useMediaQueryOnly || !isMobileRequest)
            ? `@media screen and (max-width:1024px){ body>div:not(#vmeda-debug-inline):not([id^="vmeda"])[style*="position:fixed"], body>div:not(#vmeda-debug-inline):not([id^="vmeda"])[style*="position: fixed"]{ display:none !important; visibility:hidden !important; opacity:0 !important; height:0 !important; overflow:hidden !important; pointer-events:none !important; } }`
            : `body>div:not(#vmeda-debug-inline):not([id^="vmeda"])[style*="position:fixed"], body>div:not(#vmeda-debug-inline):not([id^="vmeda"])[style*="position: fixed"]{ display:none !important; visibility:hidden !important; opacity:0 !important; height:0 !important; overflow:hidden !important; pointer-events:none !important; }`;
          $('head').prepend(`
      <style id="vmeda-mobile-scale">${mobileScaleCss}</style>
      <style id="vmeda-mobile-overlay-hide">${overlayHideCss}</style>
      `);
          }
        } catch (e) { console.warn('site-proxy: mobile scale inject failed', e.message); }
      }
      } catch (e) {
        console.warn('site-proxy: viewport/mobile inject failed', e.message);
      }
      if (isIvfree || isAivfree || isEmbedPage || isPizjav) {
        $('head').prepend(`
      <style id="vmeda-adblock-spoof">
        ins.adsbygoogle,[id*="google_ads"],[id*="adsbygoogle"],[class*="adsbygoogle"],[id*="div-gpt-ad"],[class*="div-gpt-ad"],[data-ad-slot],[data-ad-format],[data-google-query-id],[class*="ad-slot"],[id*="ad-slot"],aside[id*="ad"],aside[class*="ad-"],.ad-container,.ad-banner,.banner-ad,[class*="ad-container"],[class*="ad-banner"],[class*="advertisement"]{
          display:none !important; visibility:hidden !important; opacity:0 !important; height:0 !important; width:0 !important; overflow:hidden !important; position:absolute !important; left:-9999px !important; pointer-events:none !important;
        }
        [id*="adblock"]:not([id*="player"]):not([id*="video"]),[id*="ad-block"],[class*="adblock-overlay"],[class*="adblock-message"],[class*="ad-block-message"],[class*="antibot-overlay"],[class*="blocked-overlay"],[id*="blocked-overlay"],[class*="blocked"][class*="overlay"],[id*="blocked"]:not([id*="player"]){
          display:none !important; visibility:hidden !important; opacity:0 !important; pointer-events:none !important; height:0 !important; overflow:hidden !important;
        }
        [class*="player"] [class*="adblock"],[class*="player"] [class*="ad-block"],[class*="video"] [class*="adblock"],[class*="video"] [class*="ad-block"],[class*="player"] [class*="blocked-overlay"],[class*="video"] [class*="blocked-overlay"],[class*="player"] [class*="adblock-overlay"],[class*="player"] [class*="adblock-message"]{
          display:none !important; visibility:hidden !important; opacity:0 !important; pointer-events:none !important; height:0 !important; overflow:hidden !important;
        }
        [class*="access-denied"],[id*="access-denied"],[class*="accessDenied"],[id*="accessDenied"],[class*="bot-detected"],[id*="bot-detected"],[class*="botDetected"]{
          display:none !important; visibility:hidden !important; opacity:0 !important; pointer-events:none !important; height:0 !important; overflow:hidden !important;
        }
        [id*="recaptcha"],[id*="captcha"],[class*="recaptcha"],[class*="captcha"],[class*="g-recaptcha"],[class*="robot-verification"],[class*="human-verify"]{
          display:none !important; visibility:hidden !important; opacity:0 !important; height:0 !important; overflow:hidden !important; position:absolute !important; left:-9999px !important; pointer-events:none !important;
        }
        [class*="antispam"],[id*="antispam"],[class*="anti-spam"],[id*="anti-spam"]{
          display:none !important; visibility:hidden !important; opacity:0 !important; pointer-events:none !important; height:0 !important; overflow:hidden !important;
        }
        [class*="age-verify"],[id*="age-verify"],[class*="age-verification"],[class*="age-gate"],[class*="download-now"],[id*="download-now"],[class*="consent-gate"],[class*="consent-modal"],[class*="verification-modal"],[class*="age-gate"],[class*="download-banner"],[class*="download-cta"],[id*="ageGate"],[id*="age_gate"],[class*="modal"][class*="age"],[class*="popup"][class*="age"]{
          display:none !important; visibility:hidden !important; opacity:0 !important; pointer-events:none !important; height:0 !important; overflow:hidden !important;
        }
        [class*="player"] [class*="ad-"], [id*="player"] [class*="ad-"], [class*="video-container"] [class*="ad-"], [class*="video-wrapper"] [class*="ad-"], [class*="player"] .ad-container, [id*="player"] .ad-container, [class*="player"] [class*="ad-container"], [id*="player"] [class*="ad-container"], [class*="player"] [class*="ad-overlay"], [id*="player"] [class*="ad-overlay"], [class*="player"] [class*="commercial"], [class*="player"] [class*="vast"], [class*="player"] [class*="preroll"], [class*="player"] ins.adsbygoogle, [id*="player"] ins.adsbygoogle, [class*="player"] iframe[src*="doubleclick"], [class*="player"] iframe[src*="googlesyndication"], [id*="player"] iframe[src*="doubleclick"], [id*="player"] iframe[src*="googlesyndication"], [class*="player"] [id*="google_ads"], [id*="player"] [id*="google_ads"], [class*="player"] [class*="banner-ad"], [class*="player"] [class*="ad-banner"]{
          display:none !important; visibility:hidden !important; opacity:0 !important; height:0 !important; overflow:hidden !important; pointer-events:none !important;
        }
      </style>
      <script>
      (function(){
        var f=function(){ return false; }, e=function(){ return []; };
        try{
          Object.defineProperty(window,'adblock',{ get:f, configurable:true });
          Object.defineProperty(window,'AdBlock',{ get:f, configurable:true });
          Object.defineProperty(window,'uBlock',{ get:f, configurable:true });
          Object.defineProperty(window,'AdGuard',{ get:f, configurable:true });
          Object.defineProperty(window,'uBlockOrigin',{ get:f, configurable:true });
          Object.defineProperty(window,'blockadblock',{ get:f, configurable:true });
          Object.defineProperty(window,'uBlock0',{ get:f, configurable:true });
          Object.defineProperty(window,'adblockDetected',{ get:f, configurable:true });
          Object.defineProperty(window,'adBlockDetected',{ get:f, configurable:true });
          if(!window.adsbygoogle) window.adsbygoogle=[];
          Object.defineProperty(window,'adsbygoogle',{ get:e, set:function(){}, configurable:true });
          if(!window.grecaptcha) window.grecaptcha={ execute:function(){ return Promise.resolve(''); }, render:function(){ return ''; }, getResponse:function(){ return ''; }, ready:function(cb){ if(cb) cb(); } };
        }catch(err){ window.adblock=false; window.AdBlock=false; window.uBlock=false; window.AdGuard=false; window.adsbygoogle=[]; }
        try{
          var gcs=window.getComputedStyle;
          if(typeof gcs==='function'){
            window.getComputedStyle=function(el,pseudo){
              var s=el&&el.nodeType===1?gcs.call(window,el,pseudo):(el?{}:null);
              if(!s||!el.id&&!el.className) return s;
              var id=(el.id||'').toLowerCase(), cls=(typeof el.className==='string'?el.className:'').toLowerCase(), comb=id+cls;
              if(!/player|video|jwplayer/.test(comb)&&/google_ads|adsbygoogle|div-gpt-ad|ad-slot|ad-format|data-ad/.test(comb)){
                return { getPropertyValue:function(k){ var v=(k==='display')?'block':(k==='visibility')?'visible':(k==='height'||k==='width')?'1px':(k==='opacity')?'1':s.getPropertyValue ? s.getPropertyValue(k) : ''; return v||''; }, display:'block', visibility:'visible', height:'1px', width:'1px', opacity:'1' };
              }
              return s;
            };
          }
        }catch(err){}
      })();
      </script>
      <script>
      (function(){
        window.open=function(){ return null; };
        if(window.showModalDialog) window.showModalDialog=function(){ return null; };
      })();
      </script>
      `);
        $('head').prepend(`
      <script>
      (function(){
        var adDomains=['tapioni.com','outdidfillet.com','afrdtech.com','cloudflareinsights.com','googlesyndication.com','doubleclick.net','googleadservices.com'];
        function isAdScriptSrc(src){
          if(!src||typeof src!=='string') return false;
          var s=src.toLowerCase();
          if(s.indexOf('asg_embed')!==-1) return true;
          if(/vcd[a-f0-9]{25,}/i.test(src)) return true;
          for(var i=0;i<adDomains.length;i++) if(s.indexOf(adDomains[i])!==-1) return true;
          return false;
        }
        function stripAdScriptsFromHtml(html){
          if(typeof html!=='string') return html;
          var r=html.replace(/<script[^>]*\ssrc\s*=\s*[\"'][^\"']*asg_embed[^\"']*[\"'][^>]*>\\s*<\\/script>/gi,'')
            .replace(/<script[^>]*\ssrc\s*=\s*[\"'][^\"']*vcd[a-f0-9]{25,}[^\"']*[\"'][^>]*>\\s*<\\/script>/gi,'');
          adDomains.forEach(function(d){ r=r.replace(new RegExp('<script[^>]*\\ssrc\\s*=\\s*[\"\'][^\"\']*'+d.replace(/\./g,'\\.')+'[^\"\']*[\"\'][^>]*>\\s*<\\\\/script>','gi'),''); });
          return r;
        }
        function blockAdScript(node){
          if(!node||node.nodeType!==1) return node;
          if(node.tagName==='SCRIPT'&&node.src&&isAdScriptSrc(node.src)) return null;
          return node;
        }
        var ap=Node.prototype.appendChild;
        Node.prototype.appendChild=function(node){ if(blockAdScript(node)===null) return node; return ap.call(this,node); };
        var ins=Node.prototype.insertBefore;
        Node.prototype.insertBefore=function(node,ref){ if(blockAdScript(node)===null) return node; return ins.call(this,node,ref); };
        try{
          var ow=document.write;
          if(typeof ow==='function'){
            document.write=function(h){ return ow.call(document,stripAdScriptsFromHtml(h)); };
          }
          var owl=document.writeln;
          if(typeof owl==='function'){
            document.writeln=function(h){ return owl.call(document,stripAdScriptsFromHtml(h)); };
          }
        }catch(e){}
        try{
          var iah=Element.prototype.insertAdjacentHTML;
          if(typeof iah==='function'){
            Element.prototype.insertAdjacentHTML=function(pos,html){ return iah.call(this,pos,stripAdScriptsFromHtml(html)); };
          }
        }catch(e){}
      })();
      </script>
      `);
      }
      if (isIvfree || isAivfree || isEmbedPage || isPizjav) {
        try {
          const safeOrigin = origin.replace(/'/g, "\\'");
          const safePrefix = proxyPrefix.replace(/'/g, "\\'");
          const embedHostsJson = JSON.stringify(EMBED_PLAYER_HOSTS);
          $('head').prepend(`
      <script>
      (function(){
        var O='${safeOrigin}', P='${safePrefix}', embedHosts=${embedHostsJson};
        try{ var OH=(new URL(O)).hostname; }catch(e){ var OH=''; }
        function isEmbedHost(host){ if(!host) return false; var h=String(host).toLowerCase(); return embedHosts.some(function(e){ return h===e||h.indexOf('.'+e)===h.length-e.length-1; }); }
        function toProxy(u){
          if(!u||u.indexOf('data:')===0) return u;
          var addDebug=typeof location!=='undefined'&&location.search&&location.search.indexOf('vmeda_debug=1')!==-1;
          if(u.indexOf('http')===0||u.indexOf('//')===0){
            try{ var hu=(new URL(u,O)).hostname; if(isEmbedHost(hu)){ var prox=P+encodeURIComponent(u); if(addDebug) prox+='&vmeda_debug=1'; return prox; } }catch(e){}
            if(addDebug&&u.indexOf('site-proxy')!==-1&&u.indexOf('vmeda_debug=1')===-1) return u+(u.indexOf('?')===-1?'?':'&')+'vmeda_debug=1';
            return u;
          }
          try{
            var a=new URL(u,O).href;
            if(OH&&(new URL(a)).hostname===OH){
              var proxied=P+encodeURIComponent(a);
              if(addDebug) proxied+='&vmeda_debug=1';
              return proxied;
            }
          }catch(e){}
          return u;
        }
        if(window.fetch){ var f=window.fetch; window.fetch=function(u,o){ var url=typeof u==='string'?u:(u&&u.url); var prox=toProxy(url); if(prox===url) return f(u,o); var opts=o||{}; if(u&&typeof u==='object'&&u.url){ opts.method=u.method||opts.method; opts.body=u.body!==undefined?u.body:opts.body; opts.headers=u.headers||opts.headers; opts.mode=u.mode||opts.mode; opts.credentials=u.credentials!==undefined?u.credentials:opts.credentials; } return f(prox,opts); }; }
        (function(){
          var X=window.XMLHttpRequest;
          if(!X) return;
          var challengeFake=/cdn-cgi\\/challenge-platform\\//i;
          window.XMLHttpRequest=function(){
            var x=new X(), fakeChallenge=false, origOpen=x.open, origSend=x.send;
            x.open=function(m,url){
              var u=url||arguments[1];
              if(u&&challengeFake.test(u)){ fakeChallenge=true; arguments[1]='about:blank'; }
              else if(u) arguments[1]=toProxy(u);
              return origOpen.apply(this,arguments);
            };
            x.send=function(body){
              if(fakeChallenge){
                var self=this;
                setTimeout(function(){
                  try{
                    self.readyState=4; self.status=200; self.statusText='OK'; self.responseText=self.response='{}';
                    if(self.onreadystatechange) self.onreadystatechange();
                    if(self.onload) self.onload({ type:'load', target:self });
                  }catch(e){}
                },0);
                return;
              }
              return origSend.apply(this,arguments);
            };
            return x;
          };
        })();
        if(OH&&location.assign){ var a=location.assign.bind(location); location.assign=function(u){ a(toProxy(u)); }; }
        if(OH&&location.replace){ var r=location.replace.bind(location); location.replace=function(u){ r(toProxy(u)); }; }
        document.addEventListener('click',function(e){
          var a=e.target&&(e.target.closest?e.target.closest('a'):(function(n){while(n){if(n.tagName==='A')return n;n=n.parentElement;}return null;})(e.target));
          if(!a||!a.href) return;
          var u=toProxy(a.getAttribute('href')||a.href);
          if(u!==(a.getAttribute('href')||a.href)){ e.preventDefault(); location.assign(u); }
        },true);
        function rewriteIframeSrc(){
          document.querySelectorAll('iframe[src]').forEach(function(ifr){
            var s=ifr.getAttribute('src')||ifr.src||'';
            if(!s || s.indexOf('site-proxy')!==-1) return;
            var proxied=toProxy(s);
            if(proxied!==s){ ifr.src=proxied; ifr.setAttribute('src',proxied); }
          });
        }
        rewriteIframeSrc();
        var mo= new MutationObserver(function(){ rewriteIframeSrc(); });
        try{ mo.observe(document.documentElement,{ childList:true, subtree:true, attributes:true, attributeFilter:['src'] }); }catch(e){}
        setInterval(rewriteIframeSrc,400);
      })();
      </script>
      <script>
      (function(){
        var adPhrases=[
          'AdBlock detected',
          'Please disable AdBlock',
          'disable AdBlock',
          'disable uBlock',
          'disable AdGuard',
          'AdBlock / uBlock',
          'AdBlock / AdGuard',
          'change your browser to continue',
          'click ADS to continue',
          'Please turn off adblockers',
          'Please turn off adblockers in order and click ADS to continue watching',
          '?E????E?????E????????E,
          'ADS????E??????E????????',
          'VPN Recommended',
          'Tap to Install and Continue Watching',
          'Skip Ad',
          '????E???????','????E????E,'???????????','???????',
          \"I'm not a robot\",'I am not a robot','Are you a robot',
          'Verify you are human','Please verify you are human',
          'Human verification','Security check','Security verification',
          '??','????????','VID.nestio','vidnest','Video Nest','nestio','VIDNEST.IO','vidnest.io',
          'Please disable AdBlock / uBlock / AdGuard or change your browser to continue',
          'AdBlock / uBlock / AdGuard or change your browser',
          'Access denied: bot detected','Access denied','bot detected','Video cannot be played',
          '???E,'18???E,'??????E??','?????????E,'Download Now','Download now',
          '??????','??E???????????','??E????????? ??'
        ];
        var adPhrasesLower = adPhrases.map(function(p){ return String(p).toLowerCase(); });
        function hasAdMsg(t){
          if(!t) return false;
          var s=String(t||'').toLowerCase();
          return adPhrasesLower.some(function(p){ return s.indexOf(p)!==-1; });
        }
        function isOverlayLike(el){
          if(!el||el===document.body||el===document.documentElement) return false;
          var c=String(el.className||''); var id=String(el.id||'');
          if(/overlay|adblock|modal|popup|antibot|blocked|age-verify|age-gate|download-now|access-denied|accessDenied|bot-detected|botDetected/i.test(c+id)) return true;
          try{
            var st=window.getComputedStyle(el);
            if(st.position==='fixed') return true;
            var z=parseInt(st.zIndex,10); if(z>80||z<-999) return true;
          }catch(e){}
          return false;
        }
        // ?E???E?????????????E?E?????E??????
        var debugMode = typeof location !== 'undefined' && location.search && location.search.indexOf('vmeda_debug=1') !== -1;
        var clientRemovedTotal = 0;
        var clientLastSnippets = [];
        var bottomOverlayRemovedTotal = 0;
        function removeAdblockMsg(){
          var removedThisRun = [];
          var skippedReasons = [];
          var toRemove = [];
          var clientCandidatesThisRun = 0;
          var bottomOverlayCandidatesThisRun = 0;
          var bottomOverlayRemovedThisRun = 0;
          var bottomOverlayRemovedSnippets = [];
          var bottomOverlaySkipped = [];
          var tl=function(s){ return String(s||'').toLowerCase(); };
          if (document.body && document.body.children) {
            for (var i = document.body.children.length - 1; i >= 0; i--) {
              var el = document.body.children[i];
              if (!el || (el.id&&el.id.indexOf('vmeda')!==-1)) continue;
              var t = (el.innerText||el.textContent||'').trim();
              if (t.length > 6000) continue;
              var pos = '';
              try { pos = window.getComputedStyle(el).position; } catch(e){}
              if (pos === 'fixed' && (t.indexOf('??E)!==-1||t.indexOf('18?')!==-1||t.indexOf('??')!==-1||tl(t).indexOf('download now')!==-1)) {
                try { el.remove(); clientRemovedTotal++; } catch(e){}
              }
              if ((pos === 'fixed' || t.length < 2500) && (tl(t).indexOf('adblock detected')!==-1||tl(t).indexOf('please disable adblock')!==-1||tl(t).indexOf('change your browser to continue')!==-1||tl(t).indexOf('disable ublock')!==-1||tl(t).indexOf('disable adguard')!==-1||tl(t).indexOf('access denied')!==-1||tl(t).indexOf('bot detected')!==-1||tl(t).indexOf('video cannot be played')!==-1)) {
                try { el.remove(); clientRemovedTotal++; } catch(e){}
              }
            }
          }
          document.querySelectorAll('div, section, aside, button, a, [role="dialog"], [role="alertdialog"], [role="button"]').forEach(function(el){
            if (el.closest && el.closest('[class*="player"],[id*="player"],[class*="video"]')) return;
            if ((el.id||'').indexOf('vmeda') !== -1 || (String(el.className||'').indexOf('vmeda') !== -1)) return;
            var t = (el.innerText || el.textContent || '').trim();
            if (!t || t.length > 4500) return;
            if (t.indexOf('??E) !== -1 && (t.indexOf('18?') !== -1 || t.indexOf('??') !== -1 || t.indexOf('??????') !== -1)) {
              el.remove();
              clientRemovedTotal++;
            }
            if (tl(t).indexOf('download now') !== -1 && t.length < 500) {
              el.remove();
              clientRemovedTotal++;
            }
            if (t.indexOf('??????') !== -1 || t.indexOf('??E????E) !== -1 || t.indexOf('???????????') !== -1) {
              el.remove();
              clientRemovedTotal++;
            }
          });
          var antispamCandidates = [];
          document.querySelectorAll('*').forEach(function(el){
            if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return;
            if (el.closest && el.closest('[class*="player"],[id*="player"],[class*="video"]')) return;
            if ((el.id||'').indexOf('vmeda') !== -1 || (String(el.className||'').indexOf('vmeda') !== -1)) return;
            var t = (el.innerText || el.textContent || '').trim();
            if (!t || t.length > 5000) return;
            if (t.indexOf('??????') !== -1 || t.indexOf('??E????E) !== -1) {
              antispamCandidates.push({ el: el, len: t.length });
            }
          });
          antispamCandidates.sort(function(a,b){ return b.len - a.len; });
          antispamCandidates.forEach(function(o){ try { o.el.remove(); clientRemovedTotal++; } catch(e){} });
          document.querySelectorAll('[class*="player"] [class*="ad-"]:not([class*="add-"]), [id*="player"] [class*="ad-"]:not([class*="add-"]), [class*="player"] [class*="ad-overlay"], [id*="player"] [class*="ad-overlay"], [class*="player"] [class*="commercial"], [class*="player"] [class*="vast"]').forEach(function(el){
            if (el.tagName === 'VIDEO' || el.tagName === 'IFRAME') return;
            try { el.remove(); clientRemovedTotal++; } catch(e){}
          });
          document.querySelectorAll('[class*="player"] *, [id*="player"] *').forEach(function(el){
            if (el.tagName === 'VIDEO' || el.tagName === 'IFRAME' || el.tagName === 'SOURCE') return;
            var t = (el.innerText || el.textContent || '').trim();
            if (t.length > 150 || t.length < 2) return;
            if (/skip\s*ad|?E??????E?E|?E??.*???E?E|sponsored|ad\s*\(\s*\d+\s*\)/i.test(t)) {
              try { el.remove(); clientRemovedTotal++; } catch(e){}
            }
          });
          document.querySelectorAll('[id*="adblock"]:not([id*="player"]):not([id*="video"]),[id*="ad-block"],[class*="adblock-overlay"],[class*="adblock-message"],[class*="ad-block"],[class*="blocked"]').forEach(function(el){
            var isAdblockOverlayType=/adblock|blocked|ad-block/.test(String(el.className||'')+String(el.id||''));
            if(!isAdblockOverlayType && el.closest && el.closest('[class*="player"],[id*="player"],[class*="video"]')) return;
            if((el.id||'').indexOf('vmeda')!==-1) return;
            var t=(el.innerText||el.textContent||'').trim();
            if(isAdblockOverlayType||(t.length>0&&t.length<3000&&(tl(t).indexOf('adblock')!==-1||tl(t).indexOf('disable adblock')!==-1||tl(t).indexOf('change your browser')!==-1||tl(t).indexOf('disable ublock')!==-1||tl(t).indexOf('disable adguard')!==-1||tl(t).indexOf('????E)!==-1||tl(t).indexOf('vidnest')!==-1||tl(t).indexOf('access denied')!==-1||tl(t).indexOf('bot detected')!==-1||tl(t).indexOf('video cannot be played')!==-1))){ el.remove(); clientRemovedTotal++; removedThisRun.push((t||'').substring(0,80)); }
          });
          document.querySelectorAll('[id*="robot"]:not([id*="player"]),[class*="robot"],[id*="verify"],[class*="verify"],[id*="captcha"]:not([id*="player"]),[class*="captcha"],[id*="vidnest"]:not([id*="player"]),[class*="vidnest"]').forEach(function(el){
            if(el.closest && el.closest('[class*=\"player\"], [id*=\"player\"], [class*=\"video\"]')) return;
            if(el.querySelector && el.querySelector('iframe[src*=\"vidnest\"], iframe[src*=\"video\"], video')) return;
            var t=(el.innerText||el.textContent||'').trim();
            if(t.length>0&&t.length<2500&&(tl(t).indexOf('????E)!==-1||tl(t).indexOf('vidnest')!==-1||tl(t).indexOf('verify')!==-1||tl(t).indexOf('robot')!==-1)){ el.remove(); clientRemovedTotal++; removedThisRun.push((t||'').substring(0,80)); }
          });
          document.querySelectorAll('*').forEach(function(el){
            if(el.tagName === 'SCRIPT') return;
            if(el.querySelector && el.querySelector('iframe[src], video')) return;
            var t=(el.innerText||el.textContent||'').trim();
            if(t.indexOf('adPhrases=')!==-1||t.indexOf('hasAdMsg')!==-1||t.indexOf('removeAdblockMsg')!==-1) return;
            if(!hasAdMsg(t)) return;
            var inPlayer=el.closest && el.closest('[class*="player"],[id*="player"],[class*="video"]');
            var overlay = isOverlayLike(el);
            var isAdblockDetectedMsg = (t.length < 2500 && (tl(t).indexOf('adblock detected') !== -1 || tl(t).indexOf('please disable adblock') !== -1 || tl(t).indexOf('disable ublock') !== -1 || tl(t).indexOf('disable adguard') !== -1 || tl(t).indexOf('access denied') !== -1 || tl(t).indexOf('bot detected') !== -1 || tl(t).indexOf('video cannot be played') !== -1));
            if(inPlayer && !isAdblockDetectedMsg && !overlay) return;
            clientCandidatesThisRun++;
            var childHas=false;
            for(var i=0;i<el.children.length;i++){
              var ct=(el.children[i].innerText||el.children[i].textContent||'').trim();
              if(hasAdMsg(ct)){ childHas=true; break; }
            }
            var removeIt = isAdblockDetectedMsg || !childHas || overlay;
            if(!removeIt && t.length < 3000 && (tl(t).indexOf('adblock detected') !== -1 || tl(t).indexOf('please disable adblock') !== -1)){
              try{
                var r = el.getBoundingClientRect();
                if(r.width >= 180 && r.height >= 80) removeIt = true;
              }catch(e){}
            }
            if(removeIt){
              toRemove.push({ el: el, snip: (t||'').substring(0, 80) });
            } else if(debugMode){
              var why = 'childHas=' + childHas + ', overlay=' + overlay;
              try{
                var st = window.getComputedStyle(el);
                why += ' pos=' + (st.position||'') + ' z=' + (st.zIndex||'');
              }catch(e){}
              skippedReasons.push((el.tagName||'') + '#' + (el.id||'') + '.' + (String(el.className||'').split(/\s+/)[0]||'') + ' ' + why);
            }
          });
          // ?????????????????E?E????????E????
          try{
            var vpH = window.innerHeight || document.documentElement.clientHeight || 0;
            if (vpH > 0) {
              document.querySelectorAll('div,section,aside').forEach(function(el){
                if (!el || el.nodeType !== 1) return;
                if (el.closest && el.closest('[class*=\"player\"], [id*=\"player\"], [class*=\"video\"]')) return;
                var id = (el.id || '').toLowerCase();
                var cls = (typeof el.className === 'string' ? el.className : '').toLowerCase();
                if (id.indexOf('vmeda') !== -1 || cls.indexOf('vmeda') !== -1) return;
                var rect;
                try { rect = el.getBoundingClientRect(); } catch(e) { return; }
                if (!rect || rect.height < 40 || rect.width < 200) return;
                // ???E60% ??????????E?????????E                if (rect.top < vpH * 0.4) return;
                bottomOverlayCandidatesThisRun++;
                // ????E?????E??????E                var closeEl = el.querySelector('[aria-label*=\"close\" i], [class*=\"close\" i], [id*=\"close\" i], button, a, span');
                var hasClose = false;
                if (closeEl) {
                  var ctext = (closeEl.textContent || closeEl.innerText || '').trim();
                  if (ctext === '?E || ctext === 'X' || ctext === '?E || /???|close|?E??????|skip ad|skip/i.test(ctext)) {
                    hasClose = true;
                  }
                }
                var t2 = (el.innerText || el.textContent || '').trim();
                var isAdText = /?E??|sponsored|ads?|advert/i.test(t2);
                var shouldRemove = hasClose || (isAdText && rect.height <= vpH * 0.5);
                if (!shouldRemove) {
                  if (debugMode) {
                    bottomOverlaySkipped.push((el.tagName||'') + '#' + (el.id||'') + '.' + (String(el.className||'').split(/\\s+/)[0]||''));
                  }
                  return;
                }
                bottomOverlayRemovedThisRun++;
                bottomOverlayRemovedTotal++;
                bottomOverlayRemovedSnippets.push((t2 || '').substring(0,80));
                el.remove();
              });
            }
          } catch(e){}
          toRemove.forEach(function(o){ o.el.remove(); clientRemovedTotal++; removedThisRun.push(o.snip); });
          if(debugMode){
            if(removedThisRun.length) console.log('[VMEDA client] ??:', removedThisRun.length, removedThisRun);
            if(skippedReasons.length) console.log('[VMEDA client] ???E?E(????E????):', skippedReasons);
            if(clientCandidatesThisRun > 0 || removedThisRun.length || skippedReasons.length){
              clientLastSnippets = clientLastSnippets.concat(removedThisRun).slice(-30);
              try{
                window.parent.postMessage({
                  type: 'vmeda-debug-client',
                  clientRemovedTotal: clientRemovedTotal,
                  clientCandidatesThisRun: clientCandidatesThisRun,
                  clientRemovedThisRun: removedThisRun.length,
                  clientSkippedCount: skippedReasons.length,
                  lastSnippets: clientLastSnippets,
                  clientSkipped: skippedReasons.slice(0, 10),
                  bottomOverlayCandidatesThisRun: bottomOverlayCandidatesThisRun,
                  bottomOverlayRemovedThisRun: bottomOverlayRemovedThisRun,
                  bottomOverlayRemovedTotal: bottomOverlayRemovedTotal,
                  bottomOverlayRemovedSnippets: bottomOverlayRemovedSnippets.slice(0, 10),
                  bottomOverlaySkipped: bottomOverlaySkipped.slice(0, 10)
                }, '*');
                var merged=window.__vmedaDebugInitial?Object.assign({},window.__vmedaDebugInitial):{};
                merged.clientRemovedTotal=clientRemovedTotal;
                merged.clientCandidatesThisRun=clientCandidatesThisRun;
                merged.clientRemovedThisRun=removedThisRun.length;
                merged.clientSkippedCount=skippedReasons.length;
                merged.bottomOverlayCandidatesThisRun=bottomOverlayCandidatesThisRun;
                merged.bottomOverlayRemovedThisRun=bottomOverlayRemovedThisRun;
                merged.bottomOverlayRemovedTotal=bottomOverlayRemovedTotal;
                if(window.__vmedaDebugUpdate)window.__vmedaDebugUpdate(merged);
              }catch(e){}
            }
          }
        }
        function removeAntispamFromNode(node){
          if (!node || node.nodeType !== 1) return;
          var t = (node.innerText || node.textContent || '').trim();
          if (t.indexOf('??????') !== -1 || t.indexOf('??E????E) !== -1) {
            try { node.remove(); clientRemovedTotal++; } catch(e){}
            return;
          }
          var list = node.querySelectorAll ? node.querySelectorAll('*') : [];
          for (var i = 0; i < list.length; i++) {
            var u = (list[i].innerText || list[i].textContent || '').trim();
            if (u.indexOf('??????') !== -1 || u.indexOf('??E????E) !== -1) {
              var root = list[i];
              while (root && root.parentNode && root.parentNode !== document.body) {
                var pt = (root.parentNode.innerText || root.parentNode.textContent || '').trim();
                if (pt.length < 5000 && (pt.indexOf('??????') !== -1 || pt.indexOf('??E????E) !== -1)) root = root.parentNode; else break;
              }
              try { root.remove(); clientRemovedTotal++; } catch(e){}
              return;
            }
          }
        }
        function run(){
          removeAdblockMsg();
          if(document.body){
            var mo=new MutationObserver(function(mutations){
              for (var i = 0; i < mutations.length; i++) {
                var list = mutations[i].addedNodes;
                for (var j = 0; j < list.length; j++) removeAntispamFromNode(list[j]);
              }
              removeAdblockMsg();
            });
            mo.observe(document.body,{ childList: true, subtree: true });
          }
        }
        if(document.body) run(); else document.addEventListener('DOMContentLoaded',run);
        var earlyCount=0;
        var earlyId=setInterval(function(){ removeAdblockMsg(); earlyCount++; if(earlyCount>=40) clearInterval(earlyId); },50);
        setInterval(removeAdblockMsg,200);
      })();
      </script>
      `);
        } catch (prependErr) {
          console.warn('site-proxy: ivfree/adblock script inject failed', prependErr.message);
        }
      }
      const vmedaDebug = req.query.vmeda_debug;
      let debugRemovedScripts = 0, debugRemovedAdblock = 0, debugRewritten = 0, debugAdblockCandidatesChecked = 0;
      const debugRemovedSnippets = [];
      const debugRemovedScriptSrcs = [];
      const debugAdAnalysis = [];
      const debugAdAnalysisByText = [];
      const debugVideoStructure = [];
      if (vmedaDebug) {
        const adLikeClassId = /\bad\b|ad-|ad_|-ad|_ad|ads|advert|adblock|overlay|banner|sponsor|commercial|vast|preroll|popup|modal|promo|adsbygoogle|doubleclick|div-gpt/i;
        const skipClassId = /player|video|jwplayer|content|main|footer|nav|menu|^header$/i;
        $('body').find('*').each((i, el) => {
          if (debugAdAnalysis.length >= 40) return false;
          const $el = $(el);
          const raw = $el.get && $el.get(0);
          const tag = (raw && (raw.name || raw.tagName || '').toString().toLowerCase()) || 'div';
          if (tag === 'script' || tag === 'style') return;
          const id = ($el.attr('id') || '').trim();
          const cls = ($el.attr('class') || '').trim();
          const comb = (id + ' ' + cls).toLowerCase();
          const clsLower = cls.toLowerCase();
          if (clsLower === 'header' || id.toLowerCase() === 'header') return;
          if (/add-comm|add_comm|add-bookmark/.test(comb)) return;
          if (!adLikeClassId.test(comb)) return;
          if (skipClassId.test(clsLower.replace(/\s+/g, ' ').trim()) && !/\bad\b|ad-|ad_|ads|advert|adblock|overlay|banner|sponsor|commercial|vast|preroll|adsbygoogle|doubleclick|div-gpt/.test(comb)) return;
          const text = ($el.text() || '').trim();
          const inPlayer = $el.closest('[class*="player"], [id*="player"], [class*="video-container"], [class*="video-wrapper"]').length > 0;
          debugAdAnalysis.push({
            tag,
            id: id ? id.substring(0, 60) : '',
            class: cls ? cls.substring(0, 80) : '',
            text: text ? text.substring(0, 80).replace(/\s+/g, ' ') : '',
            inPlayer
          });
        });
        const adTextPhrases = /\u6CE8\u610F|18\u6B73|\u8A31\u53EF\u3092\u30AF\u30EA\u30C3\u30AF|\u30A2\u30F3\u30C1\u30B9\u30D1\u30E0|Download Now|Skip Ad|Sponsored|AdBlock detected|disable AdBlock|change your browser/i;
        $('body').find('*').each((i, el) => {
          if (debugAdAnalysisByText.length >= 25) return false;
          const $el = $(el);
          if ($el.get(0) && ($el.get(0).name || '').toLowerCase() === 'script') return;
          const text = ($el.text() || '').trim();
          if (!text || text.length < 5 || text.length > 800) return;
          if (!adTextPhrases.test(text)) return;
          if ($el.closest('[class*="player"], [id*="player"]').length && !/ad|overlay|skip|\u5E83\u544A|sponsor/i.test(text)) return;
          const id = ($el.attr('id') || '').trim();
          const cls = ($el.attr('class') || '').trim();
          const raw = $el.get && $el.get(0);
          const tag = (raw && (raw.name || raw.tagName || '').toString().toLowerCase()) || 'div';
          debugAdAnalysisByText.push({
            tag,
            id: id ? id.substring(0, 50) : '',
            class: cls ? cls.substring(0, 60) : '',
            text: text.substring(0, 100).replace(/\s+/g, ' ')
          });
        });
        $('video').each((i, el) => {
          const $el = $(el);
          const src = $el.attr('src') || '';
          const $parent = $el.parent();
          debugVideoStructure.push({
            type: 'video',
            tag: 'video',
            src: src ? src.substring(0, 120) : '',
            id: ($el.attr('id') || '').substring(0, 60) || '',
            class: ($el.attr('class') || '').substring(0, 80) || '',
            parentId: ($parent.attr('id') || '').substring(0, 60) || '',
            parentClass: ($parent.attr('class') || '').substring(0, 80) || ''
          });
        });
        $('iframe[src]').each((i, el) => {
          if (debugVideoStructure.filter(x => x.type === 'iframe').length >= 15) return false;
          const $el = $(el);
          const src = ($el.attr('src') || '').trim();
          const $parent = $el.parent();
          const srcLower = src.toLowerCase();
          const looksLikePlayer = /video|embed|player|stream|vidnest|loadvid|luluvid|jwplayer/i.test(srcLower);
          debugVideoStructure.push({
            type: 'iframe',
            src: src ? src.substring(0, 100) : '',
            id: ($el.attr('id') || '').substring(0, 60) || '',
            class: ($el.attr('class') || '').substring(0, 80) || '',
            parentId: ($parent.attr('id') || '').substring(0, 60) || '',
            parentClass: ($parent.attr('class') || '').substring(0, 80) || '',
            looksLikePlayer
          });
        });
        $('body').find('[class*="player"], [id*="player"], [class*="video-container"], [class*="video-wrapper"]').each((i, el) => {
          if (debugVideoStructure.filter(x => x.type === 'container').length >= 20) return false;
          const $el = $(el);
          const id = ($el.attr('id') || '').trim();
          const cls = ($el.attr('class') || '').trim();
          const raw = $el.get && $el.get(0);
          const tag = (raw && (raw.name || raw.tagName || '').toString().toLowerCase()) || 'div';
          const hasVideo = $el.find('video').length;
          const hasIframe = $el.find('iframe[src]').length;
          if (!hasVideo && !hasIframe && !id && !cls) return;
          debugVideoStructure.push({
            type: 'container',
            tag,
            id: id ? id.substring(0, 60) : '',
            class: cls ? cls.substring(0, 80) : '',
            hasVideo: hasVideo > 0,
            hasIframe: hasIframe > 0,
            videoCount: hasVideo,
            iframeCount: hasIframe
          });
        });
      }
      const adDomainsInline = /tapioni\.com|outdidfillet\.com|afrdtech\.com|cloudflareinsights\.com|asg_embed|beacon\.min\.js\/vcd/i;
      const isPlayerContent = /jwplayer|video\.js|vidnest|loadvid|luluvid|luluvdoo|player\.setup|\.play\s*\(/i;
      $('script').each((i, el) => {
        const src = ($(el).attr('src') || '').toLowerCase();
        const content = ($(el).html() || '').toLowerCase();
        const combined = src + content;
        let isAdOrTracker;
        if (isIvfree || isAivfree || isEmbedPage) {
          isAdOrTracker = /asg_embed|dongojyousan|doubleclick|googlesyndication|adsbygoogle|cloudflareinsights|afrdtech|outdidfillet|tapioni/i.test(combined) ||
            /adp\.js|adplacement|asg_embed/i.test(src) ||
            /googlesyndication|doubleclick|googleadservices|pagead|adsbygoogle|afrdtech|outdidfillet|tapioni/i.test(src);
          if (!isAdOrTracker && !src && content && adDomainsInline.test(content) && !isPlayerContent.test(content)) isAdOrTracker = true;
          if (!isAdOrTracker && !src && content && /AdBlock detected|disable AdBlock|change your browser to continue|disable uBlock|disable AdGuard|click ADS to continue/i.test(content) && !isPlayerContent.test(content)) isAdOrTracker = true;
        } else {
          isAdOrTracker = /asg_embed|cloudflareinsights|dongojyousan|doubleclick|googlesyndication|adsbygoogle|analytics|recaptcha|captcha|vast|displayad|spots\/|fatalfear|beacon|afrdtech|outdidfillet|tapioni/i.test(combined) ||
            /adp\.js|adplacement|asg_embed/i.test(src) ||
            (/\/(ads?|advertising|advert)\//i.test(src) || /googlesyndication|doubleclick|googleadservices|pagead|adsbygoogle|afrdtech|outdidfillet|tapioni/i.test(src));
          if (!isAdOrTracker && !src && content && adDomainsInline.test(content) && !isPlayerContent.test(content)) isAdOrTracker = true;
          if (!isAdOrTracker && !src && content && /AdBlock detected|disable AdBlock|change your browser to continue|disable uBlock|disable AdGuard|click ADS to continue/i.test(content) && !isPlayerContent.test(content)) isAdOrTracker = true;
        }
        if (isAdOrTracker) {
          debugRemovedScripts++;
          if (vmedaDebug && debugRemovedScriptSrcs.length < 30) debugRemovedScriptSrcs.push((src || 'inline').substring(0, 120));
          $(el).remove();
        }
        if ((isAivfree || isIvfree) && !src && content && /adblock|AdBlock|uBlock|AdGuard|disable.*browser|change your browser|detected.*please.*disable/i.test(content) && !isPlayerContent.test(content)) {
          debugRemovedScripts++;
          if (vmedaDebug && debugRemovedScriptSrcs.length < 30) debugRemovedScriptSrcs.push('inline(adblock-msg)');
          $(el).remove();
        }
        if ((isAivfree || isIvfree) && !src && content.length < 5000 && /AdBlock detected|Please disable AdBlock|change your browser to continue/.test(content)) {
          debugRemovedScripts++;
          if (vmedaDebug && debugRemovedScriptSrcs.length < 30) debugRemovedScriptSrcs.push('inline(adblock-msg-exact)');
          $(el).remove();
        }
      });
      $('iframe[src*="doubleclick"], iframe[src*="googlesyndication"], iframe[src*="recaptcha"], iframe[src*="cloudflareinsights"], iframe[src*="cdn-cgi/challenge"], iframe[src*="googleadservices"], iframe[src*="pagead"], ins.adsbygoogle, [src*="dongojyousan"]').remove();
      $('ins.adsbygoogle, [id*="google_ads"], [id*="div-gpt-ad"], [data-google-query-id]').remove();
      $('[id*="ad-"], [id*="_ad_"], [class*="ad-container"], [class*="ad-banner"], [class*="banner-ad"], [class*="ad-slot"], [class*="adsbygoogle"], aside[id*="ad"], aside[class*="ad-"]').each((i, el) => {
        const $el = $(el);
        if ($el.find('video, iframe[src*="video"], iframe[src*="player"], iframe[src*="embed"], [class*="player"], [id*="player"]').length) return;
        $el.remove();
      });
      $('div[id*="recaptcha"], div[id*="captcha"], div[class*="recaptcha"], div[class*="captcha"], div[class*="g-recaptcha"]').each((i, el) => {
        const $el = $(el);
        if ($el.closest('[class*="player"], [id*="player"], [class*="video"]').length) return;
        $el.remove();
      });
      const adblockTextRe = /AdBlock detected|Please disable AdBlock|disable AdBlock|disable uBlock|disable AdGuard|AdBlock \/ uBlock|AdBlock \/ AdGuard|change your browser to continue|click ADS to continue|click to continue|Please turn off adblockers|\u9806\u756A\u306B\u5E83\u544A\u30D6\u30ED\u30C3\u30AB\u30FC\u3092\u30AA\u30D5\u306B\u3057|ADS\u3092\u30AF\u30EA\u30C3\u30AF\u3057\u3066\u899A\u8074\u3092\u7D9A\u3051\u3066\u304F\u3060\u3055\u3044|Streaming Blocked|whitelist|disable your ad blocker|AdBlock is enabled|VPN Recommended|Tap to Install and Continue Watching|Skip Ad|\u3042\u306A\u305F\u306F\u30ED\u30DC\u30C3\u30C8|\u30ED\u30DC\u30C3\u30C8\u3067\u3059\u304B|\u30ED\u30DC\u30C3\u30C8\u3067\u306F\u3042\u308A\u307E\u305B\u3093|I'm not a robot|I am not a robot|Are you a robot|Verify you are human|Please verify|Human verification|Security check|Security verification|VID\.nestio|vidnest|Video Nest|nestio|VIDNEST\.IO|vidnest\.io|Access denied|bot detected|Video cannot be played|\u6CE8\u610F\uFF01|18\u6B73\u4EE5\u4E0A|\u8A31\u53EF\u3092\u30AF\u30EA\u30C3\u30AF|\u30B5\u30A4\u30C8\u3092\u8868\u793A\u3057\u307E\u3059|Download Now|Download now/;
      const maxLen = (isAivfree || isIvfree) ? 2000 : 900;
      $('body').find('*').each((i, el) => {
        const $el = $(el);
        const text = ($el.text() || '').trim();
        if (!text || text.length > maxLen) return;
        if (vmedaDebug) debugAdblockCandidatesChecked++;
        if (!adblockTextRe.test(text)) return;
        if ($el.find('iframe[src], video').length > 0) return;
        if ($el.find('a[href*="vidnest"], a[href*="embed"]').length > 0) return;
        if ($el.closest('[class*="player"], [id*="player"], [class*="video"]').length) return;
        if ($el.attr('id') === 'vmeda-debug-inline' || /vmeda/i.test($el.attr('class') || '')) return;
        debugRemovedAdblock++;
        if (vmedaDebug && debugRemovedSnippets.length < 30) debugRemovedSnippets.push(text.substring(0, 120));
        $el.remove();
      });
      if (isAivfree || isIvfree) {
        const adblockMsg = /AdBlock detected|Please disable AdBlock|disable AdBlock|uBlock|AdGuard|change your browser to continue/i;
        $('body').children().each((i, el) => {
          const $el = $(el);
          const text = ($el.text() || '').trim();
          if (!text || text.length > 6000) return;
          if (!adblockMsg.test(text)) return;
          if ($el.attr('id') === 'vmeda-debug-inline' || /vmeda/i.test($el.attr('class') || '')) return;
          if ($el.find('video').length && $el.find('iframe[src]').length && text.length > 500) return;
          debugRemovedAdblock++;
          if (vmedaDebug && debugRemovedSnippets.length < 30) debugRemovedSnippets.push(text.substring(0, 120));
          $el.remove();
        });
        const toRemove = [];
        $('body').find('*').each((i, el) => {
          const $el = $(el);
          const text = ($el.text() || '').trim();
          if (!text || text.length < 20 || text.length > 8000) return;
          if (!adblockMsg.test(text)) return;
          if ($el.find('iframe[src], video').length > 0) return;
          if ($el.closest('[class*="player"], [id*="player"], [class*="video"]').length) return;
          if ($el.attr('id') === 'vmeda-debug-inline' || /vmeda/i.test($el.attr('class') || '')) return;
          toRemove.push({ $el, len: text.length });
        });
        toRemove.sort((a, b) => a.len - b.len);
        toRemove.forEach(({ $el }) => {
          if (!$el.parent().length) return;
          debugRemovedAdblock++;
          if (vmedaDebug && debugRemovedSnippets.length < 30) debugRemovedSnippets.push(($el.text() || '').trim().substring(0, 120));
          $el.remove();
        });
      }
      if (isIvfree || isAivfree) {
        $('div[style*="position:fixed"], div[style*="position: fixed"]').each((i, el) => {
          const $el = $(el);
          if ($el.closest('[class*="player"], [id*="player"], [class*="video"], [id*="jwplayer"]').length) return;
          const z = parseInt($el.css('z-index'), 10) || 0;
          const txt = ($el.text() || '').toLowerCase();
          if ((z > 100 || z < 0) && /ads?|continue|click|disable|adblock|ublock|adguard|change your browser|whitelist|vidnest|nestio|robot|verify|recaptcha|captcha|\u30ED\u30DC\u30C3\u30C8|\u30A2\u30F3\u30C1\u30B9\u30D1\u30E0|VIDNEST|\u6CE8\u610F|18\u6B73|\u8A31\u53EF\u3092\u30AF\u30EA\u30C3\u30AF|download now/.test(txt)) $el.remove();
        });
        $('[id*="adblock"]:not([id*="player"]):not([id*="video"]), [id*="ad-block"]:not([id*="player"]), [class*="adblock-overlay"], [class*="adblock-message"], [class*="antibot"], [class*="ads-blocker"], [id*="ads-blocker"], [class*="adblock"], [id*="adblock"]').each((i, el) => {
          const $el = $(el);
          const id = ($el.attr('id') || ''); const cls = ($el.attr('class') || '');
          if (/vmeda/i.test(id) || /vmeda/i.test(cls)) return;
          if ($el.closest('[class*="player"], [id*="player"], [class*="video"]').length) return;
          if ($el.find('video, iframe[src*="video"], [class*="player"]').length) return;
          debugRemovedAdblock++;
          if (vmedaDebug && debugRemovedSnippets.length < 30) debugRemovedSnippets.push(($el.text() || '').trim().substring(0, 120));
          $el.remove();
        });
        $('body').find('*').each((i, el) => {
          const $el = $(el);
          const t = ($el.text() || '').trim();
          if (t.length > 2000) return;
          if (!/AdBlock detected|Please disable AdBlock|disable AdBlock|disable uBlock|disable AdGuard|change your browser to continue|\u30ED\u30DC\u30C3\u30C8\u3067\u3059\u304B|VIDNEST\.IO|vidnest\.io|\u3042\u306A\u305F\u306F\u30ED\u30DC\u30C3\u30C8|\u6CE8\u610F\uFF01|18\u6B73\u4EE5\u4E0A|\u8A31\u53EF\u3092\u30AF\u30EA\u30C3\u30AF|Download Now|Download now/.test(t)) return;
          if ($el.find('iframe[src], video').length > 0) return;
          if ($el.closest('[class*="player"], [id*="player"], [class*="video"]').length) return;
          debugRemovedAdblock++;
          if (vmedaDebug && debugRemovedSnippets.length < 30) debugRemovedSnippets.push(t.substring(0, 120));
          $el.remove();
        });
      }
      $('a[href]').each((i, el) => {
        const href = $(el).attr('href');
        if (!href || href.startsWith('javascript:') || href.startsWith('#') || href.includes('site-proxy')) return;
        let abs;
        try { abs = new URL(href, decodedUrl).href; } catch (e) { return; }
        if (isAllowedSiteProxyUrl(abs) && !abs.includes('site-proxy')) {
          $(el).attr('href', proxyPrefix + encodeURIComponent(abs));
        }
      });
      $('form[action]').each((i, el) => {
        const action = $(el).attr('action');
        if (!action) return;
        try {
          const abs = new URL(action, decodedUrl).href;
          if (isAllowedSiteProxyUrl(abs)) {
            $(el).attr('action', proxyPrefix + encodeURIComponent(abs));
          }
        } catch (e) {}
      });
      const baseHost = baseUrl.hostname;
      $('a[href], img[src], script[src], link[href], iframe[src], object[data], embed[src]').each((i, el) => {
        const $el = $(el);
        const isIframe = $el.is('iframe');
        const attrs = $el.is('object') ? ['data'] : $el.is('embed') ? ['src'] : ['href', 'src'];
        attrs.forEach(attr => {
          const v = $el.attr(attr);
          if (!v || v.startsWith('data:') || v.startsWith('javascript:') || v.includes('site-proxy')) return;
          try {
            const abs = new URL(v, decodedUrl).href;
            if (isEmbedPage && $el.is('script') && attr === 'src' && /jwplayer\.js/i.test(abs)) return;
            const absHost = new URL(abs).hostname;
            const sameOrigin = baseHost === absHost;
            const embedTarget = isIframe && isEmbedPlayerHost(absHost);
            if (isAllowedSiteProxyUrl(abs) && (sameOrigin || embedTarget)) {
              debugRewritten++; $el.attr(attr, proxyPrefix + encodeURIComponent(abs));
            }
          } catch (e) {}
        });
      });
      if (vmedaDebug) {
        try {
          const debugInfo = {
            decodedUrl,
            scriptsRemoved: debugRemovedScripts,
            scriptRemovedSnippets: [...(debugRemovedScriptSrcs || [])],
            adblockCandidatesChecked: debugAdblockCandidatesChecked,
            adblockElementsRemoved: debugRemovedAdblock,
            adblockRemovedSnippets: [...(debugRemovedSnippets || [])],
            resourcesRewritten: debugRewritten,
            isIvfree,
            isAivfree,
            isEmbedPage,
            adAnalysis: debugAdAnalysis,
            adAnalysisByText: debugAdAnalysisByText,
            videoStructure: debugVideoStructure,
            analysisNote: '\u30B5\u30FC\u30D0\u30FC\u306F\u521D\u56DEHTML\u306E\u307F\u89E3\u6790\u3002\u5E83\u544A\u304CJS\u3067\u5F8C\u304B\u3089\u633F\u5165\u3055\u308C\u3066\u3044\u308B\u5834\u5408\u306F\u4E00\u89A7\u306B\u73FE\u308C\u305A\u3001\u30AF\u30E9\u30A4\u30A2\u30F3\u30C8\u5074\u3067\u9664\u53BB\u3092\u8A66\u884C\u3057\u307E\u3059\u3002'
          };
          const safeJson = JSON.stringify(debugInfo).replace(/</g, '\\u003c');
          const summaryLine1 = (decodedUrl || '').substring(0, 45) + ((decodedUrl || '').length > 45 ? '...' : '');
          const summaryLine2 = 'VMEDA: ??????? ' + debugRemovedScripts + ', ?????E???? ' + debugRemovedAdblock + ', ?????E?? ' + debugAdblockCandidatesChecked + ', URL????E' + debugRewritten;
          const summaryEscaped = (summaryLine1 + '\n' + summaryLine2).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
          const debugDiv = '<div id="vmeda-debug-inline" style="position:fixed;bottom:0;left:0;right:0;z-index:999999;background:rgba(0,0,0,0.94);color:#8f8;font-size:12px;padding:10px 12px;font-family:monospace;white-space:pre-wrap;word-break:break-all;border-top:2px solid #4a4;-webkit-user-select:text;user-select:text;">' + summaryEscaped + '</div>';
          $('body').append(debugDiv);
          const script1 = '<script>console.log("%c[VMEDA site-proxy]","color:#0a0;font-weight:bold",' + safeJson + ');try{window.parent.postMessage({type:"vmeda-debug",data:' + safeJson + '},"*");}catch(e){}</script>';
          const script2 = '<script>window.__vmedaDebugInitial=' + safeJson + ';window.__vmedaDebugUpdate=function(o){var d=document.getElementById("vmeda-debug-inline");if(d){var s=(o.decodedUrl||"").substring(0,45)+((o.decodedUrl||"").length>45?"...":"")+"\\n";s+="VMEDA: ??????? "+(o.scriptsRemoved!=null?o.scriptsRemoved:"?")+", ?????E???? "+(o.adblockElementsRemoved!=null?o.adblockElementsRemoved:"?")+", ??E"+(o.adblockCandidatesChecked!=null?o.adblockCandidatesChecked:"?");if(o.clientRemovedTotal!=null)s+=" | ???????? "+o.clientRemovedTotal;if(o.bottomOverlayRemovedTotal!=null)s+=", ????? "+o.bottomOverlayRemovedTotal;d.textContent=s;}}</script>';
          $('body').append(script1).append(script2);
        } catch (debugErr) {
          console.warn('site-proxy vmeda_debug inject failed:', debugErr.message);
        }
      }
      let html = $.html();
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy', 'frame-ancestors *');
      if (vmedaDebug) res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.send(html);
    } catch (err) {
      try {
        console.error('site-proxy error:', err && err.message);
        const showStack = !!(req && req.query && req.query.vmeda_debug);
        const rawMsg = (err && (err.message || err.stack || err)) || 'Unknown error';
        const msg = String(rawMsg).slice(0, 3000).replace(/</g, '&lt;').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
        const stack = showStack && err && err.stack ? String(err.stack).slice(0, 5000).replace(/</g, '&lt;').replace(/&/g, '&amp;').replace(/"/g, '&quot;') : '';
        const body = showStack && stack ? `<html><body><h1>Error</h1><p>${msg}</p><pre>${stack}</pre></body></html>` : `<html><body><h1>Error</h1><p>${msg}</p></body></html>`;
        res.status(500).setHeader('Content-Type', 'text/html; charset=utf-8').send(body);
      } catch (e) {
        res.status(500).setHeader('Content-Type', 'text/plain').send('Internal Server Error');
      }
    }
  });

  app.post('/api/site-proxy', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    try {
      const targetUrl = req.query.url;
      if (!targetUrl || !isAllowedSiteProxyUrl(targetUrl)) {
        return res.status(400).send('Invalid or disallowed URL');
      }
      const decodedUrl = decodeURIComponent(targetUrl);
      let rawBody;
      if (req.body !== undefined && req.body !== null) {
        rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
      } else {
        rawBody = await new Promise((resolve, reject) => {
          const chunks = [];
          req.on('data', c => chunks.push(c));
          req.on('end', () => resolve(Buffer.concat(chunks)));
          req.on('error', reject);
        });
      }
      const fwdHeaders = {
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': req.headers['accept'] || '*/*',
        'Referer': decodedUrl
      };
      if (req.headers['content-type']) fwdHeaders['Content-Type'] = req.headers['content-type'];
      const axRes = await axios.post(decodedUrl, rawBody, {
        headers: fwdHeaders,
        timeout: 15000,
        maxRedirects: 3,
        validateStatus: () => true,
        responseType: 'arraybuffer'
      });
      res.status(axRes.status);
      const ct = axRes.headers['content-type'];
      if (ct) res.setHeader('Content-Type', ct);
      res.send(Buffer.from(axRes.data));
    } catch (err) {
      console.warn('site-proxy POST error:', err && err.message);
      res.status(502).setHeader('Content-Type', 'text/plain').send('Proxy POST failed');
    }
  });
}

module.exports = { register, isAllowedSiteProxyUrl, SITE_PROXY_ALLOWED_HOSTS };
