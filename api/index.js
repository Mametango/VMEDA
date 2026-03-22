// Vercelサーバーレス環境でのエラーハンドリング
process.on('uncaughtException', (error) => {
  console.error('❌ 未処理の例外:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ 未処理のPromise拒否:', reason);
});

/**
 * VMEDA コンセプト:
 * あらゆるサイトを VMEDA のフィルター（プロキシ）を通すことで、
 * 広告・トラッカーなどを排除し、動画を快適に視聴できるようにする。
 * 以下のプロキシはすべてこのコンセプトに沿って広告除去・安全表示を行う。
 */

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { MongoClient } = require('mongodb');

// Cloudflare対策（403 "Just a moment..."）: r.jina.ai 経由でHTML/リンクを取得するフォールバック
const JINA_PROXY_BASE = 'https://r.jina.ai/http://';

function buildJinaProxyUrl(originalUrl) {
  if (!originalUrl) return '';
  return JINA_PROXY_BASE + String(originalUrl).replace(/^https?:\/\//, '');
}

// クエリ用URLの二重エンコード防止（1回デコードしてからencodeURIComponentで渡す）
function urlForProxyQuery(url) {
  if (!url || typeof url !== 'string') return url;
  try {
    return decodeURIComponent(url);
  } catch (e) {
    return url;
  }
}

function isCloudflareChallengeHtml(html) {
  if (!html) return false;
  const s = String(html);
  return (
    s.includes('Just a moment') ||
    s.includes('cf-chl') ||
    s.includes('/cdn-cgi/challenge-platform') ||
    s.includes('Attention Required') ||
    s.includes('Cloudflare')
  );
}

async function fetchMarkdownViaJina(originalUrl, timeoutMs = 20000) {
  const proxyUrl = buildJinaProxyUrl(originalUrl);
  if (!proxyUrl) throw new Error('Invalid URL for Jina proxy');
  const resp = await axios.get(proxyUrl, {
    timeout: timeoutMs,
    validateStatus: () => true
  });
  if (resp.status >= 400) {
    throw new Error(`Jina proxy HTTP ${resp.status}`);
  }
  return String(resp.data || '');
}

function extractVideosFromJinaMarkdown(markdown, options) {
  const {
    source,
    includeUrlSubstrings = [],
    excludeUrlSubstrings = [],
    max = 50
  } = options || {};

  const lines = String(markdown || '').split('\n');
  const videos = [];
  const seen = new Set();

  const cleanTitle = (t) =>
    String(t || '')
      .replace(/^#+\s*/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 200);

  for (let i = 0; i < lines.length && videos.length < max; i++) {
    const line = lines[i];
    const linkMatches = [...line.matchAll(/\]\((https?:\/\/[^\s)]+)\)/g)];
    if (linkMatches.length === 0) continue;

    for (const m of linkMatches) {
      const url = m[1];
      if (!url) continue;

      if (excludeUrlSubstrings.some((x) => url.includes(x))) continue;
      if (includeUrlSubstrings.length > 0 && !includeUrlSubstrings.some((x) => url.includes(x))) continue;

      const thumbMatch = line.match(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/);
      const thumbnail = thumbMatch ? thumbMatch[1] : '';

      let title = '';
      const altTitleMatch = line.match(/!\[[^\]:]*:\s*([^\]]+)\]/);
      if (altTitleMatch) {
        title = altTitleMatch[1];
      } else {
        const next = lines[i + 1] || '';
        const heading = next.match(/^#{2,6}\s+(.+)$/);
        if (heading) title = heading[1];
      }

      if (!title) {
        const textMatch = line.match(/\[([^\]]+)\]\(\s*https?:\/\/[^\s)]+\s*\)/);
        if (textMatch && !textMatch[1].startsWith('![')) title = textMatch[1];
      }

      const finalTitle = cleanTitle(title) || cleanTitle(url.split('/').filter(Boolean).pop());
      if (!finalTitle || finalTitle.length < 2) continue;

      const normalizedUrl = url.replace(/^http:\/\//, 'https://');
      if (seen.has(normalizedUrl)) continue;
      seen.add(normalizedUrl);

      videos.push({
        id: `${source || 'jina'}-${Date.now()}-${videos.length}`,
        title: finalTitle,
        thumbnail: thumbnail || '',
        duration: '',
        url: normalizedUrl,
        embedUrl: normalizedUrl,
        source: source || 'jina'
      });

      if (videos.length >= max) break;
    }
  }

  return videos;
}

function extractIvPrefixesFromTitles(videos, max = 10) {
  // IVFreeのタイトルからプレフィックス（IMOB / ICDV / MMR 等）を抽出し、頻度順に返す
  const counts = new Map();

  for (const v of videos || []) {
    const title = String(v?.title || '');
    const matches = [...title.matchAll(/(?:\[)?([A-Z]{2,6})-\d{2,6}(?:\])?/g)];
    for (const m of matches) {
      const prefix = String(m[1] || '').trim();
      if (!prefix) continue;
      counts.set(prefix, (counts.get(prefix) || 0) + 1);
    }
  }

  const ranked = [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .map(([prefix]) => prefix);

  // ユーザー要望: ICDV/MMR/IMOB などのプレフィックスで検索する
  const preferred = ['ICDV', 'MMR', 'IMOB'];
  const preferredFound = ranked.filter((p) => preferred.includes(p));
  const result = preferredFound.length > 0 ? preferredFound : ranked;

  return result.slice(0, max);
}

async function searchMat6tubeByIvTitleSeed(ivfreeVideos) {
  // Mat6tubeは個別コードではなく、ICDV/MMR/IMOB等の「プレフィックス」で検索する
  const candidates = extractIvPrefixesFromTitles(ivfreeVideos, 10);
  if (!candidates.length) {
    return { queryUsed: '', videos: await searchMat6tube('', false) };
  }

  // 候補を軽くシャッフルして偏りを減らす
  const shuffled = [...candidates];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const tryCount = Math.min(5, shuffled.length);
  for (let i = 0; i < tryCount; i++) {
    const kw = shuffled[i];
    try {
      const videos = await searchMat6tube(kw, false);
      if (Array.isArray(videos) && videos.length > 0) {
        return { queryUsed: kw, videos };
      }
    } catch (_) {}
  }

  return { queryUsed: '', videos: await searchMat6tube('', false) };
}

const app = express();
const PORT = process.env.PORT || 3000;

// MongoDB接続設定（アクセスログ用のみ）
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = 'vmeda';
const ACCESS_LOG_COLLECTION_NAME = 'access_logs';
const COLLECTION_NAME = 'searches';
const MAX_RECENT_SEARCHES = 20;

let mongoClient = null;
let mongoDb = null;

// MongoDBに接続
async function connectToMongoDB() {
  if (!MONGODB_URI) {
    console.log('⚠️ MongoDB URIが設定されていません。メモリ内に保存します。');
    return null;
  }

  if (mongoClient) {
    return mongoDb;
  }

  try {
    mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();
    mongoDb = mongoClient.db(DB_NAME);
    console.log('✅ MongoDB Atlasに接続しました');
    return mongoDb;
  } catch (error) {
    console.error('❌ MongoDB接続エラー:', error.message);
    return null;
  }
}


// 検索履歴をMongoDBから読み込む
async function loadRecentSearchesFromMongoDB() {
  try {
    const db = await connectToMongoDB();
    if (!db) {
      console.log('⚠️ MongoDBに接続できません。空の配列を返します。');
      return [];
    }

    const collection = db.collection(COLLECTION_NAME);
    const result = await collection.findOne({ _id: 'searches' });
    if (result && Array.isArray(result.searches)) {
      console.log(`📂 MongoDBから検索履歴を読み込み: ${result.searches.length}件`);
      return result.searches;
    }
    
    return [];
  } catch (error) {
    console.error('❌ MongoDBからの読み込みエラー:', error.message);
    return [];
  }
}

// 検索履歴をMongoDBに保存
async function saveRecentSearchesToMongoDB(searches) {
  const db = await connectToMongoDB();
  if (!db) {
    // MongoDBが利用できない場合はメモリ内に保存
    return;
  }

  try {
    const collection = db.collection(COLLECTION_NAME);
    const searchesToSave = searches.slice(0, MAX_RECENT_SEARCHES);
    
    // プライバシー保護のため、検索ワードのみを保存（個人情報は含めない）
    await collection.updateOne(
      { _id: 'searches' },
      { 
        $set: { 
          searches: searchesToSave
        } 
      },
      { upsert: true }
    );
    console.log(`💾 MongoDBに検索履歴を保存: ${searchesToSave.length}件`);
  } catch (error) {
    console.error('❌ MongoDBへの保存エラー:', error.message);
  }
}

// 検索履歴のキャッシュ（高速化のため）
let recentSearchesCache = null;
let recentSearchesCacheTime = 0;
const CACHE_DURATION = 5000; // 5秒間キャッシュ（MongoDBへの負荷を軽減）

// キャッシュ付きで検索履歴を取得
async function getRecentSearchesCached() {
  const now = Date.now();
  // キャッシュが有効な場合はキャッシュを返す
  if (recentSearchesCache && (now - recentSearchesCacheTime) < CACHE_DURATION) {
    console.log('📋 検索履歴をキャッシュから取得');
    return recentSearchesCache;
  }
  
  // キャッシュが無効な場合はMongoDBから取得
  const searches = await loadRecentSearchesFromMongoDB();
  recentSearchesCache = searches;
  recentSearchesCacheTime = now;
  console.log('📋 検索履歴をMongoDBから取得（キャッシュ更新）');
  return searches;
}

// 検索履歴が更新されたときにキャッシュを無効化
function invalidateRecentSearchesCache() {
  recentSearchesCache = null;
  recentSearchesCacheTime = 0;
  console.log('📋 検索履歴キャッシュを無効化');
}

// アクセスログをMongoDBに保存（一般的なサイトと同じようにIPアドレスを記録）
async function saveAccessLogToMongoDB(logData) {
  const db = await connectToMongoDB();
  if (!db) {
    // MongoDBが利用できない場合はログのみ
    console.log('⚠️ MongoDBに接続できません。アクセスログをスキップします。');
    return;
  }

  try {
    const collection = db.collection(ACCESS_LOG_COLLECTION_NAME);
    await collection.insertOne(logData);
    console.log(`📝 アクセスログを保存: IP: ${logData.ip}, Query: ${logData.query}`);
  } catch (error) {
    console.error('❌ アクセスログの保存エラー:', error.message);
  }
}


// Vercel環境ではプロキシの背後で動作するため、trust proxyを有効化
// ただし、express-rate-limitの警告を避けるため、具体的なプロキシ数を指定
if (process.env.VERCEL === '1' || process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1); // Vercelは1つのプロキシの背後
  console.log('✅ Trust proxy設定を有効化しました（Vercel環境、プロキシ数: 1）');
}

// セキュリティミドルウェア
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://pagead2.googlesyndication.com"],
      scriptSrcAttr: ["'unsafe-inline'"], // インラインイベントハンドラーを許可
      imgSrc: ["'self'", "data:", "https:", "http:"],
      frameSrc: ["'self'", "https:", "http:", "https://googleads.g.doubleclick.net"],
      connectSrc: ["'self'", "https:", "http:", "https://pagead2.googlesyndication.com"],
      fontSrc: ["'self'", "data:", "https:"],
    },
  },
  crossOriginEmbedderPolicy: false,
  // iOS Safari対応
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));

// CORS設定（本番環境では適切に設定）
const corsOptions = {
  origin: process.env.NODE_ENV === 'production' 
    ? process.env.ALLOWED_ORIGINS?.split(',') || '*'
    : '*',
  credentials: true,
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

// レート制限（DoS攻撃対策）
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15分
  max: 100, // 15分間に100リクエストまで
  message: 'Too many requests. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// 検索API専用のレート制限（より厳しく）
const searchLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1分
  max: 10, // 1分間に10リクエストまで
  message: 'Too many search requests. Please try again later.',
});
app.use('/api/search', searchLimiter);

// JSONペイロードサイズ制限
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// リクエストログ（デバッグ用・IPアドレスを含む）
app.use((req, res, next) => {
  const userAgent = req.get('user-agent') || '';
  const isMobile = /iPhone|iPad|iPod|Android/i.test(userAgent);
  // IPアドレスを取得（プロキシ経由の場合も考慮）
  const clientIp = req.ip || req.connection?.remoteAddress || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.headers['x-real-ip'] || 'unknown';
  console.log(`📱 ${req.method} ${req.path} - ${isMobile ? 'Mobile' : 'Desktop'} - IP: ${clientIp} - ${userAgent.substring(0, 50)}`);
  // リクエストオブジェクトにIPアドレスを保存（後で使用できるように）
  req.clientIp = clientIp;
  next();
});

// 静的ファイル配信（Vercel対応）
// Vercel環境では、静的ファイルは自動的に配信されるが、明示的に設定することも可能
let publicPath;
try {
  publicPath = process.env.VERCEL === '1' 
    ? path.join(process.cwd(), 'public')
    : path.join(__dirname, 'public');
} catch (error) {
  console.error('❌ 静的ファイルパス設定エラー:', error.message);
  try {
    publicPath = path.join(__dirname, 'public');
  } catch (fallbackError) {
    console.error('❌ フォールバックパス設定エラー:', fallbackError.message);
    publicPath = './public'; // 最後の手段
  }
}

// favicon.icoのリクエストを処理（404エラーを防ぐ）
app.get('/favicon.ico', (req, res) => {
  // SVG faviconを返す
  const faviconPath = path.join(publicPath, 'favicon.svg');
  if (fs.existsSync(faviconPath)) {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.sendFile(faviconPath);
  } else {
    // favicon.svgが存在しない場合は204 No Contentを返す
    res.status(204).end();
  }
});

try {
  app.use(express.static(publicPath, {
    // JS/HTMLは更新が頻繁なので強キャッシュしない（古い app.js?v=1.0.2 問題対策）
    maxAge: 0,
    etag: true,
    setHeaders: (res, filePath) => {
      // 静的ファイルのMIMEタイプを明示的に設定
      if (filePath.endsWith('.js')) {
        res.setHeader('Content-Type', 'application/javascript');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      } else if (filePath.endsWith('.css')) {
        res.setHeader('Content-Type', 'text/css');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      } else if (filePath.endsWith('.html')) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      } else if (filePath.endsWith('.svg')) {
        res.setHeader('Content-Type', 'image/svg+xml');
      }
    }
  }));
} catch (staticError) {
  console.error('❌ 静的ファイル配信設定エラー:', staticError.message);
  // エラーが発生しても続行（Vercelが自動的に配信する可能性があるため）
}

// 広告設定を提供するAPI（環境変数から）
app.get('/api/ad-config', (req, res) => {
  try {
    res.json({
      adClientId: process.env.AD_CLIENT_ID || '',
      adSlotHeader: process.env.AD_SLOT_HEADER || '',
      adSlotFooter: process.env.AD_SLOT_FOOTER || '',
      adSlotInContent: process.env.AD_SLOT_IN_CONTENT || ''
    });
  } catch (error) {
    console.error('❌ 広告設定取得エラー:', error.message);
    res.status(500).json({ error: 'Failed to retrieve ad settings' });
  }
});

// 静的ファイルの明示的なルーティング（Vercel用）
app.get('/app.js', (req, res) => {
  console.log('📄 app.js リクエスト受信');
  res.sendFile(path.join(__dirname, 'public', 'app.js'), {
    headers: { 
      'Content-Type': 'application/javascript',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    }
  });
});

app.get('/styles.css', (req, res) => {
  console.log('📄 styles.css リクエスト受信');
  res.sendFile(path.join(__dirname, 'public', 'styles.css'), {
    headers: { 
      'Content-Type': 'text/css',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    }
  });
});

// 共通ヘルパー関数
function extractTitle($, $elem) {
  // 複数のセレクタを試す
  const selectors = [
    'h3', 'h2', 'h1', 
    '.title', '[class*="title"]', 
    'a', '.video-title', '[class*="video-title"]',
    '[class*="name"]', '[class*="name"]',
    'span', 'div'
  ];
  
  for (const selector of selectors) {
    const text = $elem.find(selector).first().text().trim();
    if (text && text.length > 3) {
      return text;
    }
  }
  
  // セレクタで見つからない場合は、要素のテキスト全体から取得
  const fullText = $elem.text().trim();
  if (fullText && fullText.length > 3) {
    // 最初の100文字を取得
    return fullText.substring(0, 100);
  }
  
  // 属性から取得
  return $elem.attr('title') || $elem.attr('alt') || $elem.attr('data-title') || '';
}

function extractThumbnail($, $elem) {
  // 親要素を最初に取得（関数全体で使用するため）
  const $parent = $elem.parent();
  
  // 複数の属性とセレクタを試す（より広範囲に検索）
  const imgSelectors = [
    'img',
    '.thumbnail img',
    '[class*="thumbnail"] img',
    '[class*="thumb"] img',
    '.poster img',
    '[class*="poster"] img',
    '.cover img',
    '[class*="cover"] img',
    '.image img',
    '[class*="image"] img',
    '.pic img',
    '[class*="pic"] img',
    'picture img',
    'picture source',
    '.video-thumbnail img',
    '[class*="video-thumbnail"] img',
    '.video-poster img',
    '[class*="video-poster"] img'
  ];
  
  // 試す属性のリスト（より多くの属性をチェック）
  const thumbnailAttributes = [
    'src',
    'data-src',
    'data-lazy-src',
    'data-original',
    'data-url',
    'data-image',
    'data-thumb',
    'data-thumbnail',
    'data-poster',
    'data-cover',
    'data-img',
    'srcset',
    'data-srcset',
    'content',
    'href'
  ];
  
  for (const selector of imgSelectors) {
    const $img = $elem.find(selector).first();
    if ($img.length > 0) {
      // すべての属性を試す
      for (const attr of thumbnailAttributes) {
        let thumbnail = $img.attr(attr) || '';
        
        // srcsetの場合は最初のURLを取得
        if (attr === 'srcset' && thumbnail) {
          const srcsetMatch = thumbnail.match(/^([^\s,]+)/);
          if (srcsetMatch) {
            thumbnail = srcsetMatch[1];
          }
        }
        
        if (thumbnail && thumbnail.length > 0) {
          // サムネイルURLを正規化
          if (thumbnail.startsWith('//')) {
            return 'https:' + thumbnail;
          }
          if (thumbnail.startsWith('/') && !thumbnail.startsWith('http')) {
            // 相対パスの場合は、現在のサイトのドメインを推測
            const baseUrl = $elem.closest('a').attr('href') || '';
            if (baseUrl.includes('bilibili.com')) {
              return `https://www.bilibili.com${thumbnail}`;
            } else if (baseUrl.includes('douga4.top')) {
              return `https://av.douga4.top${thumbnail}`;
            } else if (baseUrl.includes('javmix.tv')) {
              return `https://javmix.tv${thumbnail}`;
            } else if (baseUrl.includes('ppp.porn')) {
              return `https://ppp.porn${thumbnail}`;
            }
            return thumbnail;
          }
          if (thumbnail.startsWith('http://')) {
            return thumbnail.replace('http://', 'https://');
          }
          if (thumbnail.startsWith('https://')) {
            return thumbnail;
          }
          // 属性から取得できた場合は返す
          if (thumbnail.length > 5) {
            return thumbnail;
          }
        }
      }
    }
  }
  
  // 要素自体が画像の場合
  if ($elem.is('img')) {
    for (const attr of thumbnailAttributes) {
      let thumbnail = $elem.attr(attr) || '';
      if (thumbnail && thumbnail.length > 5) {
        if (thumbnail.startsWith('//')) {
          return 'https:' + thumbnail;
        }
        if (thumbnail.startsWith('http://')) {
          return thumbnail.replace('http://', 'https://');
        }
        if (thumbnail.startsWith('https://')) {
          return thumbnail;
        }
        return thumbnail;
      }
    }
  }
  
  // 親要素や兄弟要素から画像を探す（$parentは既に宣言済み）
  if ($parent && $parent.length > 0) {
    const parentImg = $parent.find('img').first();
    if (parentImg.length > 0) {
      for (const attr of thumbnailAttributes) {
        let thumbnail = parentImg.attr(attr) || '';
        if (thumbnail && thumbnail.length > 5) {
          if (thumbnail.startsWith('//')) {
            return 'https:' + thumbnail;
          }
          if (thumbnail.startsWith('http://')) {
            return thumbnail.replace('http://', 'https://');
          }
          if (thumbnail.startsWith('https://')) {
            return thumbnail;
          }
          return thumbnail;
        }
      }
    }
  }
  
  // Google検索結果の場合
  const googleImg = $elem.closest('.g').find('img').first();
  if (googleImg.length > 0) {
    for (const attr of thumbnailAttributes) {
      let thumbnail = googleImg.attr(attr) || '';
      if (thumbnail && thumbnail.length > 5) {
        if (thumbnail.startsWith('//')) {
          return 'https:' + thumbnail;
        }
        if (thumbnail.startsWith('http://')) {
          return thumbnail.replace('http://', 'https://');
        }
        if (thumbnail.startsWith('https://')) {
          return thumbnail;
        }
        return thumbnail;
      }
    }
  }
  
  // 背景画像として設定されているサムネイルを探す
  const styleAttr = $elem.attr('style') || '';
  if (styleAttr) {
    const bgImageMatch = styleAttr.match(/url\(['"]?([^'")]+)['"]?\)/);
    if (bgImageMatch && bgImageMatch[1]) {
      let thumbnail = bgImageMatch[1].trim();
      if (thumbnail && thumbnail.length > 5) {
        if (thumbnail.startsWith('//')) {
          return 'https:' + thumbnail;
        }
        if (thumbnail.startsWith('http://')) {
          return thumbnail.replace('http://', 'https://');
        }
        if (thumbnail.startsWith('https://')) {
          return thumbnail;
        }
        if (thumbnail.startsWith('/')) {
          // 相対パスの場合は、現在のサイトのドメインを推測
          const baseUrl = $elem.closest('a').attr('href') || '';
          if (baseUrl.includes('bilibili.com')) {
            return `https://www.bilibili.com${thumbnail}`;
          } else if (baseUrl.includes('douga4.top')) {
            return `https://av.douga4.top${thumbnail}`;
          } else if (baseUrl.includes('javmix.tv')) {
            return `https://javmix.tv${thumbnail}`;
          } else if (baseUrl.includes('ppp.porn')) {
            return `https://ppp.porn${thumbnail}`;
          }
        }
        return thumbnail;
      }
    }
  }
  
  // 親要素の背景画像もチェック（$parentは既に宣言済みなので再宣言しない）
  if ($parent && $parent.length > 0) {
    const parentStyle = $parent.attr('style') || '';
    if (parentStyle) {
      const bgImageMatch = parentStyle.match(/url\(['"]?([^'")]+)['"]?\)/);
      if (bgImageMatch && bgImageMatch[1]) {
        let thumbnail = bgImageMatch[1].trim();
        if (thumbnail && thumbnail.length > 5) {
          if (thumbnail.startsWith('//')) {
            return 'https:' + thumbnail;
          }
          if (thumbnail.startsWith('http://')) {
            return thumbnail.replace('http://', 'https://');
          }
          if (thumbnail.startsWith('https://')) {
            return thumbnail;
          }
          return thumbnail;
        }
      }
    }
  }
  
  // data属性から背景画像を探す
  const dataBgImage = $elem.attr('data-bg') || $elem.attr('data-background') || $elem.attr('data-bg-image') || '';
  if (dataBgImage && dataBgImage.length > 5) {
    if (dataBgImage.startsWith('//')) {
      return 'https:' + dataBgImage;
    }
    if (dataBgImage.startsWith('http://')) {
      return dataBgImage.replace('http://', 'https://');
    }
    if (dataBgImage.startsWith('https://')) {
      return dataBgImage;
    }
    return dataBgImage;
  }
  
  return '';
}

function extractDurationFromHtml($, $elem) {
  const durationText = $elem.find('.duration').text().trim() ||
                      $elem.find('[class*="duration"]').text().trim() ||
                      $elem.find('[class*="time"]').text().trim() ||
                      $elem.closest('.g').find('.duration').text().trim() || '';
  return durationText;
}

// URLを正規化して重複チェック用のキーを生成
function normalizeUrlForDedup(url) {
  if (!url) return '';
  
  try {
    // httpをhttpsに統一
    let normalized = url.replace(/^http:\/\//, 'https://');
    
    // 末尾のスラッシュを削除
    normalized = normalized.replace(/\/+$/, '');
    
    // URLオブジェクトに変換してパスとクエリを正規化
    const urlObj = new URL(normalized);
    
    // クエリパラメータをソート（順序の違いを無視）
    const params = new URLSearchParams(urlObj.search);
    const sortedParams = Array.from(params.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    urlObj.search = new URLSearchParams(sortedParams).toString();
    
    // フラグメント（#以降）を削除
    urlObj.hash = '';
    
    // 正規化されたURLを返す
    return urlObj.toString().replace(/\/+$/, '');
  } catch (e) {
    // URL解析に失敗した場合は元のURLを返す
    return url.replace(/^http:\/\//, 'https://').replace(/\/+$/, '');
  }
}

// タイトルを正規化して比較用のキーを生成
function normalizeTitleForDedup(title) {
  if (!title) return '';
  
  // 小文字に変換、空白を削除、特殊文字を正規化
  return title.toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 100); // 最初の100文字のみ
}

// 動画が重複しているかチェック（URLとタイトルの両方を考慮）
function isVideoDuplicate(video, existingVideos) {
  try {
    if (!video || !video.url) return false;
    if (!existingVideos || !Array.isArray(existingVideos) || existingVideos.length === 0) return false;
    
    const normalizedUrl = normalizeUrlForDedup(video.url);
    const normalizedTitle = normalizeTitleForDedup(video.title);
    
    return existingVideos.some(existing => {
      try {
        if (!existing || !existing.url) return false;
        
        const existingNormalizedUrl = normalizeUrlForDedup(existing.url);
        const existingNormalizedTitle = normalizeTitleForDedup(existing.title);
        
        // URLが完全に一致する場合は重複
        if (normalizedUrl && existingNormalizedUrl && normalizedUrl === existingNormalizedUrl) {
          return true;
        }
        
        // URLのベース部分（ドメイン+パス）が一致し、タイトルも似ている場合は重複
        if (normalizedUrl && existingNormalizedUrl) {
          const url1Base = normalizedUrl.split('?')[0].split('#')[0];
          const url2Base = existingNormalizedUrl.split('?')[0].split('#')[0];
          
          if (url1Base === url2Base && normalizedTitle && existingNormalizedTitle) {
            // タイトルの類似度をチェック（80%以上一致）
            const similarity = calculateTitleSimilarity(normalizedTitle, existingNormalizedTitle);
            if (similarity > 0.8) {
              return true;
            }
          }
        }
        
        // タイトルが非常に似ている場合（90%以上一致）も重複とみなす
        if (normalizedTitle && existingNormalizedTitle) {
          const similarity = calculateTitleSimilarity(normalizedTitle, existingNormalizedTitle);
          if (similarity > 0.9) {
            return true;
          }
        }
        
        return false;
      } catch (e) {
        console.error('❌ 重複チェック中にエラー:', e.message);
        return false; // エラーが発生した場合は重複ではないとみなす
      }
    });
  } catch (e) {
    console.error('❌ 重複チェック関数でエラー:', e.message);
    return false; // エラーが発生した場合は重複ではないとみなす
  }
}

// タイトルの類似度を計算（簡易版レーベンシュタイン距離ベース）
function calculateTitleSimilarity(title1, title2) {
  if (!title1 || !title2) return 0;
  if (title1 === title2) return 1;
  
  // 完全一致
  if (title1 === title2) return 1;
  
  // 一方が他方に含まれている場合
  if (title1.includes(title2) || title2.includes(title1)) {
    const longer = title1.length > title2.length ? title1 : title2;
    const shorter = title1.length > title2.length ? title2 : title1;
    return shorter.length / longer.length;
  }
  
  // 共通部分を計算
  const words1 = title1.split(/\s+/).filter(w => w.length > 0);
  const words2 = title2.split(/\s+/).filter(w => w.length > 0);
  
  if (words1.length === 0 || words2.length === 0) return 0;
  
  const commonWords = words1.filter(w => words2.includes(w));
  const totalWords = Math.max(words1.length, words2.length);
  
  return commonWords.length / totalWords;
}

// 検索クエリとタイトルの関連性をチェック
function isTitleRelevant(title, query, strictMode = true) {
  if (!title || !query) return false; // タイトルやクエリがない場合は関連なし
  
  const titleLower = title.toLowerCase();
  const queryLower = query.toLowerCase().trim();
  
  // クエリが空の場合は関連なし
  if (queryLower.length === 0) return false;
  
  // クエリを単語に分割（日本語と英語に対応）
  const queryWords = queryLower.split(/\s+/).filter(word => word.length > 0);
  
  if (strictMode) {
    // 厳格なマッチング: クエリが1単語の場合は、その単語がタイトルに含まれているかチェック
    if (queryWords.length === 1) {
      return titleLower.includes(queryWords[0]);
    }
    
    // クエリが複数単語の場合は、50%以上の単語がタイトルに含まれているかチェック（より厳格）
    const matchingWords = queryWords.filter(word => titleLower.includes(word)).length;
    const minRequiredWords = Math.ceil(queryWords.length / 2); // 50%以上
    return matchingWords >= minRequiredWords;
  } else {
    // 緩和したマッチング: クエリが1単語の場合は、その単語がタイトルに含まれているかチェック
    if (queryWords.length === 1) {
      return titleLower.includes(queryWords[0]);
    }
    
    // クエリが複数単語の場合は、10%以上の単語がタイトルに含まれているかチェック（さらに緩和）
    const matchingWords = queryWords.filter(word => titleLower.includes(word)).length;
    const minRequiredWords = Math.max(1, Math.ceil(queryWords.length / 10)); // 10%以上（最低1単語）
    
    // さらに緩和: クエリの文字がタイトルに含まれているかもチェック
    const queryChars = queryLower.split('').filter(c => c.trim().length > 0 && c !== ' ');
    const matchingChars = queryChars.filter(char => titleLower.includes(char)).length;
    const minRequiredChars = Math.max(1, Math.ceil(queryChars.length / 5)); // 20%以上の文字が一致
    
    return matchingWords >= minRequiredWords || matchingChars >= minRequiredChars;
    return matchingWords >= minRequiredWords;
  }
}

// 入力検証関数
function validateQuery(query) {
  if (!query || typeof query !== 'string') {
    return { valid: false, error: 'Search query is required' };
  }
  
  const trimmed = query.trim();
  
  // 長さチェック
  if (trimmed.length === 0) {
    return { valid: false, error: 'Search query is empty' };
  }
  
  if (trimmed.length > 200) {
    return { valid: false, error: 'Search query is too long (max 200 characters)' };
  }
  
  // 危険な文字列をチェック（SQLインジェクション、XSS対策）
  const dangerousPatterns = [
    /<script/i,
    /javascript:/i,
    /on\w+\s*=/i,
    /eval\(/i,
    /expression\(/i,
    /vbscript:/i,
    /data:text\/html/i,
  ];
  
  for (const pattern of dangerousPatterns) {
    if (pattern.test(trimmed)) {
      return { valid: false, error: '無効な検索クエリです' };
    }
  }
  
  return { valid: true, query: trimmed };
}

// 検索API
app.post('/api/search', async (req, res) => {
  try {
    console.log('=== /api/search リクエスト受信 ===');
    
    // リクエストボディの検証
    if (!req.body || typeof req.body !== 'object') {
      console.error('❌ リクエストボディが無効です');
      return res.status(400).json({ error: 'Invalid request body' });
    }
    
    const { query } = req.body;
    
    // 入力検証
    const validation = validateQuery(query);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }
    
    const sanitizedQuery = validation.query;
    console.log(`🔍 検索開始: "${sanitizedQuery}"`);
    
    // 定義されている検索関数のみを使用（0件のサイトは削除）
    const allSearches = [];
    
    // 関数が定義されているか確認
    console.log(`🔍 検索関数の定義確認:`);
    const ivfreeType = typeof searchIVFree;
    const jpdmvType = typeof searchJPdmv;
    const bilibiliType = typeof searchBilibili;
    const douga4Type = typeof searchDouga4;
    const javmixType = typeof searchJavmix;
    const mat6tubeType = typeof searchMat6tube;
    const fc2videoType = typeof searchFC2Video;
    
    console.log(`  - searchIVFree: ${ivfreeType} ${ivfreeType === 'function' ? '✅ 定義済み' : '❌ 未定義'}`);
    console.log(`  - searchJPdmv: ${jpdmvType} ${jpdmvType === 'function' ? '✅ 定義済み' : '❌ 未定義'}`);
    console.log(`  - searchBilibili: ${bilibiliType} ${bilibiliType === 'function' ? '✅ 定義済み' : '❌ 未定義'}`);
    console.log(`  - searchDouga4: ${douga4Type} ${douga4Type === 'function' ? '✅ 定義済み' : '❌ 未定義'}`);
    console.log(`  - searchJavmix: ${javmixType} ${javmixType === 'function' ? '✅ 定義済み' : '❌ 未定義'}`);
    console.log(`  - searchMat6tube: ${mat6tubeType} ${mat6tubeType === 'function' ? '✅ 定義済み' : '❌ 未定義'}`);
    console.log(`  - searchFC2Video: ${fc2videoType} ${fc2videoType === 'function' ? '✅ 定義済み' : '❌ 未定義'}`);
    
    // 関数が未定義の場合の詳細情報
    if (ivfreeType !== 'function') {
      console.error(`❌ searchIVFreeが未定義です。型: ${ivfreeType}, 値: ${searchIVFree}`);
    }
    if (jpdmvType !== 'function') {
      console.error(`❌ searchJPdmvが未定義です。型: ${jpdmvType}, 値: ${searchJPdmv}`);
    }
    if (mat6tubeType !== 'function') {
      console.error(`❌ searchMat6tubeが未定義です。型: ${mat6tubeType}, 値: ${searchMat6tube}`);
    }
    if (fc2videoType !== 'function') {
      console.error(`❌ searchFC2Videoが未定義です。型: ${fc2videoType}, 値: ${searchFC2Video}`);
    }
    
    const searchFunctions = [
      { fn: searchIVFree, name: 'IVFree' }, // 必須：IVFreeは検索結果に含める
      { fn: searchJPdmv, name: 'JPdmv' }, // 優先順位: 高
      { fn: searchBilibili, name: 'Bilibili' },
      { fn: searchDouga4, name: 'Douga4' },
      { fn: searchJavmix, name: 'Javmix.TV' },
      { fn: searchMat6tube, name: 'Mat6tube' },
      { fn: searchFC2Video, name: 'FC2Video.org' }, // 常に追加
      { fn: searchPizjav, name: 'Pizjav' }, // IV検索用
      { fn: searchJapanhub, name: 'Japanhub' } // JAV検索用
    ];
    
    console.log(`📋 検索関数リスト: ${searchFunctions.map(sf => sf.name).join(', ')} (全${searchFunctions.length}件)`);
    
    // 各検索関数を安全に呼び出す（まずはstrictMode=falseで緩和したマッチングを試す）
    searchFunctions.forEach(({ fn, name }, index) => {
      try {
        if (typeof fn === 'function') {
          console.log(`🚀 [${index + 1}/${searchFunctions.length}] ${name}検索関数を呼び出し:`, fn.name);
          // strictMode=falseで呼び出す（緩和したマッチングでより多くの結果を取得）
          allSearches.push(fn(sanitizedQuery, false));
        } else {
          console.warn(`⚠️ [${index + 1}/${searchFunctions.length}] ${name}関数が定義されていません (typeof: ${typeof fn})`);
          // 関数が定義されていない場合も空の配列を返すPromiseを追加
          allSearches.push(Promise.resolve([]));
        }
      } catch (err) {
        console.error(`❌ [${index + 1}/${searchFunctions.length}] ${name}関数の呼び出しエラー:`, err.message);
        console.error(`❌ ${name}スタックトレース:`, err.stack);
        // エラーが発生しても空の配列を返すPromiseを追加
        allSearches.push(Promise.resolve([]));
      }
    });
    
    console.log(`📋 検索関数呼び出し完了: ${allSearches.length}個のPromiseを作成`);
    
    // すべての検索を並行実行
    console.log(`🚀 ${allSearches.length}個の検索関数を並行実行開始...`);
    const searchStartTime = Date.now();
    const allResults = await Promise.allSettled(allSearches);
    const searchEndTime = Date.now();
    const searchDuration = searchEndTime - searchStartTime;
    console.log(`✅ すべての検索関数の実行が完了しました（${allResults.length}件、実行時間: ${searchDuration}ms）`);
    
    // 結果を統合
    const videos = [];
    const allSiteNames = searchFunctions.map(sf => sf.name);
    
    // 各検索関数の実行結果を確認
    console.log(`📊 各検索関数の実行結果を確認中...`);
    allResults.forEach((result, index) => {
      const siteName = allSiteNames[index] || `Unknown[${index}]`;
      if (result.status === 'fulfilled') {
        const resultValue = result.value;
        const isArray = Array.isArray(resultValue);
        const count = isArray ? resultValue.length : '非配列';
        console.log(`✅ ${siteName}: Promise fulfilled, 結果: ${count}件`);
        if (!isArray) {
          console.error(`❌ ${siteName}: 結果が配列ではありません:`, typeof resultValue, resultValue);
        }
      } else {
        console.error(`❌ ${siteName}: Promise rejected, エラー:`, result.reason?.message || result.reason);
        if (result.reason?.stack) {
          console.error(`❌ ${siteName} スタックトレース:`, result.reason.stack.substring(0, 300));
        }
      }
    });
    
    // 結果を追加（中国サイトの結果が先に来る）
    let totalFromSites = 0;
    let successCount = 0;
    let errorCount = 0;
    let zeroCount = 0;
    
    console.log(`📊 各サイトの検索結果を確認中... (全${allResults.length}件、サイト数: ${allSiteNames.length})`);
    allResults.forEach((result, index) => {
      const siteName = allSiteNames[index] || `Unknown[${index}]`;
      console.log(`🔍 ${siteName}の結果を確認中... (status: ${result.status})`);
      
      if (result.status === 'fulfilled' && Array.isArray(result.value)) {
        if (result.value.length > 0) {
          console.log(`✅ ${siteName}: ${result.value.length}件の動画を取得`);
          videos.push(...result.value);
          totalFromSites += result.value.length;
          successCount++;
        } else {
          console.log(`ℹ️ ${siteName}: 検索結果なし（0件）`);
          zeroCount++;
        }
      } else {
        // 404エラーは警告レベル、その他はエラーレベル
        const error = result.reason;
        errorCount++;
        if (error?.response?.status === 404) {
          console.warn(`⚠️ ${siteName}検索: ページが見つかりません（404）`);
        } else {
          console.error(`❌ ${siteName}検索エラー:`, error?.message || error?.stack || error);
          if (error?.code) {
            console.error(`❌ ${siteName}エラーコード:`, error.code);
          }
        }
      }
    });
    
    console.log(`📊 検索結果サマリー: 成功${successCount}サイト、エラー${errorCount}サイト、0件${zeroCount}サイト`);
    
    console.log(`📊 検索結果サマリー: 全${videos.length}件の動画を取得（${allSiteNames.length}サイトから検索、合計${totalFromSites}件）`);
    
    // 重複を除去（URL正規化 + タイトル類似度）& YouTubeを除外
    const uniqueVideos = [];
    try {
      videos.forEach(video => {
        try {
          // 動画オブジェクトの検証
          if (!video || typeof video !== 'object') {
            console.warn('⚠️ 無効な動画オブジェクトをスキップ:', video);
            return;
          }
          
          // YouTubeを除外
          if (video.url && (video.url.includes('youtube.com') || video.url.includes('youtu.be'))) {
            return;
          }
          if (video.source === 'youtube') {
            return;
          }
          
          // MongoDB URIを除外（タイトルやURLにMongoDB URIが含まれている場合）
          const hasMongoUri = (video.title && (
            video.title.includes('mongodb://') ||
            video.title.includes('mongodb+srv://') ||
            video.title.includes('MONGODB_URI') ||
            video.title.toLowerCase().includes('mongodb uri')
          )) || (video.url && (
            video.url.includes('mongodb://') ||
            video.url.includes('mongodb+srv://')
          ));
          
          if (hasMongoUri) {
            console.log(`⚠️ MongoDB URIを含む検索結果を除外: ${video.title || video.url}`);
            return;
          }
          
          // 重複チェック（URL正規化 + タイトル類似度）
          if (!isVideoDuplicate(video, uniqueVideos)) {
            uniqueVideos.push(video);
          }
        } catch (e) {
          console.error('❌ 動画処理中にエラー:', e.message, video);
          // エラーが発生した動画はスキップして続行
        }
      });
    } catch (e) {
      console.error('❌ 重複除去処理でエラー:', e.message);
      // エラーが発生した場合は、重複除去なしで全件返す
      uniqueVideos.push(...videos.filter(v => v && v.url && !v.url.includes('youtube.com') && !v.url.includes('youtu.be')));
    }
    
    console.log(`✅ 検索完了: ${uniqueVideos.length}件の結果を取得（重複除去後）`);
    console.log(`📊 詳細: 統合前${videos.length}件 → 重複除去後${uniqueVideos.length}件`);
    console.log(`📊 カウント確認: 成功${successCount}、エラー${errorCount}、0件${zeroCount}`);
    
    // 厳格なマッチング結果のURLを記録（重複チェック用）
    const strictMatchUrls = new Set(uniqueVideos.map(v => v.url));
    
    // 緩和したマッチング条件で関連動画を取得
    console.log(`🔍 緩和したマッチング条件で関連動画を取得開始...`);
    const relatedSearches = [];
    searchFunctions.forEach(({ fn, name }) => {
      try {
        if (typeof fn === 'function') {
          // 緩和したマッチング条件で検索（strictMode = false）
          relatedSearches.push(fn(sanitizedQuery, false));
        }
      } catch (err) {
        // エラーは無視
      }
    });
    
    const relatedResults = await Promise.allSettled(relatedSearches);
    const relatedVideos = [];
    
    relatedResults.forEach((result) => {
      if (result.status === 'fulfilled' && Array.isArray(result.value)) {
        // 厳格なマッチング結果に含まれていない動画のみを追加
        result.value.forEach(video => {
          if (video && video.url && !strictMatchUrls.has(video.url)) {
            // MongoDB URIを除外
            const hasMongoUri = (video.title && (
              video.title.includes('mongodb://') ||
              video.title.includes('mongodb+srv://') ||
              video.title.includes('MONGODB_URI') ||
              video.title.toLowerCase().includes('mongodb uri')
            )) || (video.url && (
              video.url.includes('mongodb://') ||
              video.url.includes('mongodb+srv://')
            ));
            
            if (!hasMongoUri) {
              relatedVideos.push(video);
            }
          }
        });
      }
    });
    
    // 関連動画を重複除去
    const uniqueRelatedVideos = [];
    const relatedUrls = new Set();
    relatedVideos.forEach(video => {
      if (video && video.url && !relatedUrls.has(video.url)) {
        relatedUrls.add(video.url);
        uniqueRelatedVideos.push(video);
      }
    });
    
    // 厳格なマッチング結果の後ろに、緩和したマッチング結果を追加（最大20件）
    const finalVideos = [...uniqueVideos, ...uniqueRelatedVideos.slice(0, 20)];
    
    console.log(`📊 関連動画: ${uniqueRelatedVideos.length}件見つかり、${Math.min(uniqueRelatedVideos.length, 20)}件を追加`);
    console.log(`✅ 最終結果: ${finalVideos.length}件（厳格: ${uniqueVideos.length}件、関連: ${Math.min(uniqueRelatedVideos.length, 20)}件）`);
    
    // サイトごとの件数をカウント
    const siteCounts = {};
    finalVideos.forEach(video => {
      const source = video.source || 'unknown';
      siteCounts[source] = (siteCounts[source] || 0) + 1;
    });
    
    console.log(`📊 サイト別件数:`, siteCounts);
    
    // 検索結果をランダムに並び替え（Fisher-Yatesシャッフルアルゴリズム）
    let sortedVideos = [];
    try {
      // 配列のコピーを作成してからランダムにシャッフル
      sortedVideos = [...finalVideos];
      for (let i = sortedVideos.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [sortedVideos[i], sortedVideos[j]] = [sortedVideos[j], sortedVideos[i]];
      }
      
      console.log(`📊 検索結果をランダムに並び替え完了: ${sortedVideos.length}件`);
      console.log(`📊 サイト別件数:`, siteCounts);
    } catch (shuffleError) {
      console.error('❌ シャッフル処理でエラーが発生しました:', shuffleError.message);
      console.error('❌ スタックトレース:', shuffleError.stack);
      // エラーが発生した場合は、元の配列をそのまま使用
      sortedVideos = finalVideos;
      console.log(`⚠️ シャッフルをスキップして、元の配列を使用: ${sortedVideos.length}件`);
    }
    
    // デバッグ情報をクライアントにも返す（開発用）
    const debugInfo = {
      totalBeforeDedup: videos.length,
      totalAfterDedup: uniqueVideos.length,
      successSites: successCount,
      errorSites: errorCount,
      zeroResultSites: zeroCount,
      siteResults: allResults.map((result, index) => {
        const siteName = allSiteNames[index] || `Unknown[${index}]`;
        if (result.status === 'fulfilled' && Array.isArray(result.value)) {
          return { site: siteName, count: result.value.length, status: 'success' };
        } else {
          const error = result.reason;
          // エラー情報を安全にシリアライズ可能な形式に変換
          let errorMessage = 'Unknown error';
          if (error) {
            if (typeof error === 'string') {
              errorMessage = error;
            } else if (error.message) {
              errorMessage = error.message;
            } else if (error.response?.status) {
              errorMessage = `HTTP ${error.response.status}`;
            } else if (error.code) {
              errorMessage = `Error code: ${error.code}`;
            }
          }
          return { 
            site: siteName, 
            count: 0, 
            status: 'error', 
            error: errorMessage
          };
        }
      })
    };
    
    try {
      const debugInfoStr = JSON.stringify(debugInfo);
      console.log(`🔍 デバッグ情報作成完了: ${debugInfoStr.substring(0, 200)}...`);
    } catch (jsonError) {
      console.error('❌ デバッグ情報のシリアライズエラー:', jsonError.message);
      // シリアライズできない場合は、簡易版を作成
      debugInfo.siteResults = debugInfo.siteResults.map(site => ({
        site: site.site,
        count: site.count,
        status: site.status,
        error: typeof site.error === 'string' ? site.error : 'Serialization error'
      }));
    }
    
    // テスト用: 結果が0件の場合はテストデータを返す
    if (sortedVideos.length === 0) {
      console.warn('⚠️ 検索結果が0件のため、テストデータを返します');
      sortedVideos.push({
        id: 'test-1',
        title: `テスト動画: ${sanitizedQuery}`,
        thumbnail: '',
        duration: '10:00',
        url: 'https://example.com/test',
        embedUrl: 'https://example.com/test',
        source: 'test'
      });
    }
    
    // 制限なしで全件返す（デバッグ情報も含む）
    const responseData = { results: sortedVideos, debug: debugInfo };
    console.log(`📤 レスポンス送信: results=${sortedVideos.length}件, debug=${debugInfo ? 'あり' : 'なし'}`);
    res.json(responseData);
  } catch (error) {
    console.error('❌ 検索エラー:', error.message);
    console.error('❌ スタックトレース:', error.stack);
    console.error('❌ エラー詳細:', {
      name: error.name,
      message: error.message,
      stack: error.stack ? error.stack.substring(0, 500) : 'No stack trace'
    });
    // エラーの詳細情報をクライアントに送信しない（セキュリティ対策）
    // ただし、開発環境では詳細を返す
    if (process.env.NODE_ENV !== 'production') {
      console.error('❌ エラー詳細:', error);
    }
    res.status(500).json({ error: 'Search failed. Please try again later.' });
  }
});

// (IV/JAVランダム機能は削除済み)

// JPdmv検索
async function searchJPdmv(query, strictMode = true) {
  try {
    // クエリがnull/undefinedの場合は空文字列に変換
    query = query || '';
    console.log(`🔍 JPdmv検索開始: "${query}" (strictMode: ${strictMode})`);
    const startTime = Date.now();
    const encodedQuery = encodeURIComponent(query);
    // 複数のURLパターンを試す（空のクエリの場合はトップページや最新動画ページから取得）
    const urls = query && query.trim() ? [
      `https://jpdmv.com/search/${encodedQuery}`,
      `https://jpdmv.com/search?q=${encodedQuery}`,
      `https://jpdmv.com/?q=${encodedQuery}`,
      `https://jpdmv.com/?search=${encodedQuery}`
    ] : [
      `https://jpdmv.com/`, // トップページから最新動画を取得
      `https://jpdmv.com/latest`, // 最新動画ページ
      `https://jpdmv.com/videos`, // 動画一覧ページ
      `https://jpdmv.com/recent` // 最近の動画ページ
    ];
    
    let videos = [];
    let triedUrls = 0;
    let foundElements = 0;
    let matchedElements = 0;
    let selectorCount = 0;
    
    for (const url of urls) {
      triedUrls++;
      try {
        console.log(`🔍 JPdmv: URL試行 ${triedUrls}/${urls.length}: ${url}`);
        const response = await axios.get(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Referer': 'https://jpdmv.com/',
            'Accept-Encoding': 'gzip, deflate, br'
          },
          timeout: 30000,
          validateStatus: () => true
        });
        
        console.log(`🔍 JPdmv: HTTPステータス: ${response.status}, HTMLサイズ: ${response.data.length} bytes`);

        // Cloudflareブロック時は r.jina.ai 経由で取得してリンクから復元
        if (response.status === 403 && isCloudflareChallengeHtml(response.data)) {
          console.warn('⚠️ JPdmv: Cloudflare(403) を検出。r.jina.ai にフォールバックします。');
          const md = await fetchMarkdownViaJina(url);
          const jinaVideos = extractVideosFromJinaMarkdown(md, {
            source: 'jpdmv',
            // JPdmvは /video/ ではなく記事スラッグが多いので、ドメイン内リンクを広めに許可
            includeUrlSubstrings: ['jpdmv.com/'],
            excludeUrlSubstrings: ['/wp-content/', '/wp-json/', '/wp-admin', '/category', '/tag', '/page/', '/search', '#', '/privacy', '/terms'],
            max: 50
          });
          if (jinaVideos.length > 0) {
            console.log(`✅ JPdmv(Jina): ${jinaVideos.length}件の動画を取得`);
            return jinaVideos.map(v => ({
              ...v,
              embedUrl: (v.url && String(v.url).includes('jpdmv.com')) ? v.url : `/api/jpdmv-proxy?url=${encodeURIComponent(urlForProxyQuery(v.url))}`
            }));
          }
          continue;
        }
        if (response.status >= 400) {
          console.warn(`⚠️ JPdmv: HTTP ${response.status}`);
          continue;
        }
        
        const $ = cheerio.load(response.data);
        console.log(`🔍 JPdmv: HTML取得完了、パース開始 (HTMLサイズ: ${response.data.length} bytes)`);
        
        // 複数のセレクタを試す（より広範囲に）
        const selectors = [
          'a[href*="/video/"]',
          'a[href*="/watch/"]',
          'a[href*="/v/"]',
          'a[href*="/play/"]',
          'a[href*="/movie/"]',
          'a[href*="/embed/"]',
          '.video-item',
          '.item',
          '[class*="video"]',
          '[class*="item"]',
          '.result-item',
          '.search-result-item',
          'article',
          '[class*="card"]',
          'div[class*="video"]',
          'div[class*="item"]',
          'li a',
          'div a'
        ];
        
        const seenUrls = new Set();
        let urlSelectorCount = 0;
        
        selectors.forEach(selector => {
          const elements = $(selector);
          urlSelectorCount += elements.length;
          
          elements.each((index, elem) => {
            if (videos.length >= 50) return false;
            
            foundElements++;
            
            const $item = $(elem);
            let href = $item.attr('href') || $item.find('a').attr('href') || '';
            
            // hrefが見つからない場合は親要素を探す
            if (!href) {
              const $parent = $item.parent();
              href = $parent.attr('href') || $parent.find('a').attr('href') || '';
            }
            
            // JPdmvの動画URLパターンを確認（より柔軟に）
            // jpdmv.comのドメイン内のリンクで、動画らしいURLパターンを含むもの
            if (!href) return;
            const isJpdmvUrl = href.includes('jpdmv.com') || href.startsWith('/');
            // JPdmvは /video/ 系が無い場合がある（記事スラッグ形式）。画像付きの投稿リンクも拾う。
            const hasVideoPattern =
              href.includes('/video/') ||
              href.includes('/watch/') ||
              href.includes('/v/') ||
              href.includes('/play/') ||
              href.includes('/movie/') ||
              href.includes('/embed/') ||
              /\/[a-z]{2,}-\d{3,}/i.test(href) || // TSDS-42814 等
              /\/\d{4,}/.test(href);
            const isExcluded =
              href.includes('/wp-content/') ||
              href.includes('/wp-json/') ||
              href.includes('/wp-admin') ||
              href.includes('/category') ||
              href.includes('/tag') ||
              href.includes('/page/') ||
              href.includes('/search') ||
              href.includes('#');

            if (!isJpdmvUrl || isExcluded || !hasVideoPattern) {
              return;
            }
            
            matchedElements++;
            
            // 相対URLを絶対URLに変換
            let fullUrl = href;
            if (href.startsWith('//')) {
              fullUrl = 'https:' + href;
            } else if (href.startsWith('/')) {
              fullUrl = `https://jpdmv.com${href}`;
            } else if (!href.startsWith('http')) {
              fullUrl = `https://jpdmv.com/${href}`;
            }
            
            // 重複チェック
            if (seenUrls.has(fullUrl)) return;
            seenUrls.add(fullUrl);
            
            const title = extractTitle($, $item);
            const thumbnail = extractThumbnail($, $item);
            const duration = extractDurationFromHtml($, $item);
            
            // タイトルが空の場合、URLからタイトルを抽出
            let finalTitle = title;
            if (!finalTitle || finalTitle.length < 3) {
              // URLからタイトルを抽出を試みる
              const urlMatch = fullUrl.match(/\/([^\/]+)$/);
              if (urlMatch) {
                finalTitle = decodeURIComponent(urlMatch[1]).replace(/[-_]/g, ' ').trim();
              }
              // それでもタイトルがない場合、リンクテキストを使用
              if (!finalTitle || finalTitle.length < 3) {
                finalTitle = $item.text().trim() || $item.find('a').text().trim() || '';
              }
            }
            
            // タイトルがあれば追加（より積極的に）
            if (finalTitle && finalTitle.length > 2) { // 2文字以上に緩和
              // 検索クエリとタイトルの関連性をチェック
              // strictMode=falseの場合は、関連性チェックを大幅に緩和またはスキップ
              if (strictMode) {
                // 厳格モードの場合のみ関連性チェック
                if (!isTitleRelevant(finalTitle, query, strictMode)) {
                  return; // 関連性がない場合はスキップ
                }
              } else {
                // 緩和モードの場合、タイトルがあれば基本的に追加（関連性チェックをスキップ）
                // タイトルが1文字以下の場合のみスキップ
                if (finalTitle.length < 2) {
                  return;
                }
              }
              
              videos.push({
                id: `jpdmv-${Date.now()}-${index}`,
                title: finalTitle.substring(0, 200),
                thumbnail: thumbnail || '',
                duration: duration || '',
                url: fullUrl,
                embedUrl: fullUrl,
                source: 'jpdmv'
              });
            } else if (fullUrl && fullUrl.includes('jpdmv.com')) {
              // タイトルがなくても、URLが有効な場合は追加（フォールバック）
              const fallbackTitle = fullUrl.match(/\/([^\/]+)$/)?.[1] || '動画';
              videos.push({
                id: `jpdmv-${Date.now()}-${index}`,
                title: decodeURIComponent(fallbackTitle).replace(/[-_]/g, ' ').substring(0, 200),
                thumbnail: thumbnail || '',
                duration: duration || '',
                url: fullUrl,
                embedUrl: fullUrl,
                source: 'jpdmv'
              });
            }
          });
        });
        
        selectorCount += urlSelectorCount;
        console.log(`🔍 JPdmv: このURLで見つかった要素: ${urlSelectorCount}件, 処理した要素: ${foundElements}件, マッチした要素: ${matchedElements}件`);
        
        // 結果が見つかったらループを抜ける
        if (videos.length > 0) {
          console.log(`✅ JPdmv: ${videos.length}件の動画を取得（URL: ${url}）`);
          break;
        } else {
          console.log(`ℹ️ JPdmv: このURLでは結果が見つかりませんでした（URL: ${url}）`);
        }
      } catch (urlError) {
        if (urlError.response && urlError.response.status === 403 && isCloudflareChallengeHtml(urlError.response.data)) {
          try {
            console.warn('⚠️ JPdmv: Cloudflare(403) を検出（例外）。r.jina.ai にフォールバックします。');
            const md = await fetchMarkdownViaJina(url);
            const jinaVideos = extractVideosFromJinaMarkdown(md, {
              source: 'jpdmv',
              includeUrlSubstrings: ['jpdmv.com/'],
              excludeUrlSubstrings: ['/wp-content/', '/wp-json/', '/wp-admin', '/category', '/tag', '/page/', '/search', '#', '/privacy', '/terms'],
              max: 50
            });
            if (jinaVideos.length > 0) return jinaVideos;
          } catch (_) {}
        }
        // 404や403エラーは予想される動作なので、警告を抑制（最初のURLのみ情報を出力）
        if (triedUrls === 1 && urlError.response && (urlError.response.status === 404 || urlError.response.status === 403)) {
          console.log(`ℹ️ JPdmv: 検索エンドポイントが見つかりません（${urlError.response.status}）。他のURLパターンを試行します。`);
        }
        continue;
      }
    }
    
    const endTime = Date.now();
    const duration = endTime - startTime;
    console.log(`✅ JPdmv: ${videos.length}件の動画を取得（実行時間: ${duration}ms, 試行URL数: ${triedUrls}/${urls.length}）`);
    console.log(`🔍 JPdmv デバッグ: セレクタで見つかった要素: ${selectorCount}件, 処理した要素: ${foundElements}件, マッチした要素: ${matchedElements}件`);
    
    // デバッグ情報: 最初の3件のタイトルを表示
    if (videos.length > 0) {
      console.log(`🔍 JPdmv デバッグ: 取得した動画のサンプル:`);
      videos.slice(0, 3).forEach((video, idx) => {
        console.log(`  ${idx + 1}. ${video.title.substring(0, 50)}... (URL: ${video.url.substring(0, 60)}...)`);
      });
    } else {
      console.log(`⚠️ JPdmv: 動画が見つかりませんでした（検索クエリ: "${query}"）`);
    }
    
    return videos;
  } catch (error) {
    console.error('❌ JPdmv検索エラー:', error.message);
    if (error.response && error.response.status === 404) {
      console.warn('⚠️ JPdmv検索: ページが見つかりません（404）');
    } else if (error.code) {
      console.error(`❌ JPdmv エラーコード: ${error.code}`);
    }
    if (error.stack) {
      console.error('❌ JPdmv スタックトレース:', error.stack.substring(0, 500));
    }
    return [];
  }
}

// Douga4検索
async function searchDouga4(query, strictMode = true) {
  try {
    query = query || '';
    console.log(`🔍 Douga4検索開始: "${query}" (strictMode: ${strictMode})`);
    const encodedQuery = encodeURIComponent(query);
    // 空のクエリの場合は複数URLパターンを試す
    const urls = query && query.trim() ? [
      `https://av.douga4.top/kw/${encodedQuery}`,
      `https://av.douga4.top/search/${encodedQuery}`,
      `https://av.douga4.top/?q=${encodedQuery}`
    ] : [
      `https://av.douga4.top/`, // トップページから最新動画を取得
      `https://av.douga4.top/latest`, // 最新動画ページ
      `https://av.douga4.top/videos` // 動画一覧ページ
    ];
    
    let videos = [];
    const seenUrls = new Set();
    
    for (const url of urls) {
      try {
        const response = await axios.get(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'ja,en-US;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Referer': 'https://av.douga4.top/',
            'Accept-Encoding': 'gzip, deflate, br'
          },
          timeout: 30000,
          validateStatus: () => true
        });

        if (response.status === 403 && isCloudflareChallengeHtml(response.data)) {
          console.warn('⚠️ Douga4: Cloudflare(403) を検出。r.jina.ai にフォールバックします。');
          const md = await fetchMarkdownViaJina(url);
          const jinaVideos = extractVideosFromJinaMarkdown(md, {
            source: 'douga4',
            includeUrlSubstrings: ['douga4.top/video/', 'douga4.top/'],
            excludeUrlSubstrings: ['/search', '/categories', '/category', '/tags', '#'],
            max: 50
          });
          if (jinaVideos.length > 0) {
            console.log(`✅ Douga4(Jina): ${jinaVideos.length}件の動画を取得`);
            return jinaVideos;
          }
          continue;
        }
        if (response.status >= 400) {
          console.warn(`⚠️ Douga4: HTTP ${response.status}`);
          continue;
        }
        
        const $ = cheerio.load(response.data);
        
        const selectors = [
          '.item',
          '.video-item',
          'a[href*="/video/"]',
          'a[href*="/watch/"]',
          '[class*="video"]',
          '[class*="item"]'
        ];
        
        selectors.forEach(selector => {
          $(selector).each((index, elem) => {
            if (videos.length >= 50) return false;
            
            const $item = $(elem);
            let href = $item.attr('href') || $item.find('a').attr('href') || '';
            
            if (!href) {
              const $parent = $item.parent();
              href = $parent.attr('href') || $parent.find('a').attr('href') || '';
            }
            
            if (!href || !href.includes('/video/')) return;
            
            const fullUrl = href.startsWith('http') ? href : `https://av.douga4.top${href}`;
            if (seenUrls.has(fullUrl)) return;
            seenUrls.add(fullUrl);
            
            const title = extractTitle($, $item);
            const thumbnail = extractThumbnail($, $item);
            const duration = extractDurationFromHtml($, $item);
            
            if (title && title.length > 2) {
              // 空のクエリの場合は関連性チェックをスキップ
              if (query && query.trim() && strictMode) {
                if (!isTitleRelevant(title, query, strictMode)) {
                  return;
                }
              }
              
              videos.push({
                id: `douga4-${Date.now()}-${index}`,
                title: title.substring(0, 200),
                thumbnail: thumbnail || '',
                duration: duration || '',
                url: fullUrl,
                embedUrl: fullUrl,
                source: 'douga4'
              });
            }
          });
        });
        
        if (videos.length > 0) {
          console.log(`✅ Douga4: ${videos.length}件の動画を取得（URL: ${url}）`);
          break;
        }
      } catch (urlError) {
        if (urlError.response && urlError.response.status === 403 && isCloudflareChallengeHtml(urlError.response.data)) {
          try {
            console.warn('⚠️ Douga4: Cloudflare(403) を検出（例外）。r.jina.ai にフォールバックします。');
            const md = await fetchMarkdownViaJina(url);
            const jinaVideos = extractVideosFromJinaMarkdown(md, {
              source: 'douga4',
              includeUrlSubstrings: ['douga4.top/video/', 'douga4.top/'],
              excludeUrlSubstrings: ['/search', '/categories', '/category', '/tags', '#'],
              max: 50
            });
            if (jinaVideos.length > 0) return jinaVideos;
          } catch (_) {}
        }
        console.warn(`⚠️ Douga4 URL試行エラー (${url}):`, urlError.message);
        continue;
      }
    }
    
    console.log(`✅ Douga4: ${videos.length}件の動画を取得`);
    return videos;
  } catch (error) {
    console.error('❌ Douga4検索エラー:', error.message);
    return [];
  }
}

// X1hub検索
async function searchX1hub(query, strictMode = false) {
  try {
    query = query || '';
    console.log(`🔍 X1hub検索開始: "${query}" (strictMode: ${strictMode})`);
    const encodedQuery = encodeURIComponent(query);
    // 空のクエリの場合は複数URLパターンを試す
    const urls = query && query.trim() ? [
      `https://x1hub.com/search/${encodedQuery}`,
      `https://www.x1hub.com/search/${encodedQuery}`,
      `https://x1hub.com/?q=${encodedQuery}`
    ] : [
      `https://x1hub.com/`, // トップページから最新動画を取得
      `https://www.x1hub.com/`,
      `https://x1hub.com/contents/video`,
      `https://www.x1hub.com/contents/video`
    ];
    
    let videos = [];
    const seenUrls = new Set();
    
    for (const url of urls) {
      try {
        const response = await axios.get(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Referer': 'https://x1hub.com/',
            'Accept-Encoding': 'gzip, deflate, br'
          },
          timeout: 30000,
          validateStatus: () => true
        });

        // X1hubはトップページがJSレンダリングで0件になりやすいので、まず403/challengeを救済し、
        // さらにHTML抽出が0件なら r.jina.ai 経由のリンク抽出でフォールバックする
        if (response.status === 403 && isCloudflareChallengeHtml(response.data)) {
          console.warn('⚠️ X1hub: Cloudflare(403) を検出。r.jina.ai にフォールバックします。');
          const md = await fetchMarkdownViaJina(url);
          const jinaVideos = extractVideosFromJinaMarkdown(md, {
            source: 'x1hub',
            includeUrlSubstrings: ['x1hub.com/contents/video', 'www.x1hub.com/contents/video'],
            excludeUrlSubstrings: ['/search', '/categories', '/category', '/tags', '#'],
            max: 50
          });
          if (jinaVideos.length > 0) {
            console.log(`✅ X1hub(Jina): ${jinaVideos.length}件の動画を取得`);
            return jinaVideos;
          }
          continue;
        }
        if (response.status >= 400) {
          console.warn(`⚠️ X1hub: HTTP ${response.status}`);
          continue;
        }
        
        const $ = cheerio.load(response.data);
        
        // 複数のセレクタを試す
        const selectors = [
          '.video-item',
          '.item',
          'a[href*="/contents/video"]',
          'a[href*="/video/"]',
          'a[href*="/watch/"]',
          '[class*="video"]',
          '[class*="item"]',
          'article a',
          '.card a'
        ];
        
        selectors.forEach(selector => {
          $(selector).each((index, elem) => {
            if (videos.length >= 50) return false;
            
            const $item = $(elem);
            let href = $item.attr('href') || $item.find('a').attr('href') || '';
            
            // hrefが見つからない場合は親要素を探す
            if (!href) {
              const $parent = $item.parent();
              href = $parent.attr('href') || $parent.find('a').attr('href') || '';
            }
            
            if (!href) return;
            
            // x1hub.com/contents/video を含むリンクを優先
            const isVideoLink = href.includes('/contents/video') || href.includes('/video/') || href.includes('/watch/');
            if (!isVideoLink && query && query.trim()) {
              // 検索時は動画リンクのみ
              return;
            }
            
            const fullUrl = href.startsWith('http') ? href : `https://x1hub.com${href.startsWith('/') ? href : '/' + href}`;
            if (!fullUrl.includes('x1hub.com')) return;
            
            if (seenUrls.has(fullUrl)) return;
            seenUrls.add(fullUrl);
            
            const title = extractTitle($, $item) || $item.text().trim() || '';
            const thumbnail = extractThumbnail($, $item);
            const duration = extractDurationFromHtml($, $item);
            
            let finalTitle = title;
            if (!finalTitle || finalTitle.length < 3) {
              const urlMatch = fullUrl.match(/\/([^\/]+)$/);
              if (urlMatch) finalTitle = decodeURIComponent(urlMatch[1]).replace(/[-_]/g, ' ').trim();
            }

            if (finalTitle && finalTitle.length > 2) {
              videos.push({
                id: `x1hub-${Date.now()}-${index}`,
                title: finalTitle.substring(0, 200),
                thumbnail: thumbnail || '',
                duration: duration || '',
                url: fullUrl,
                embedUrl: fullUrl,
                source: 'x1hub'
              });
            }
          });
        });

        if (videos.length > 0) {
          console.log(`✅ X1hub: ${videos.length}件の動画を取得（URL: ${url}）`);
          break;
        }
        
        // HTMLから0件の場合は r.jina.ai にフォールバック
        if (videos.length === 0) {
          try {
            console.warn('⚠️ X1hub: HTMLから0件。r.jina.ai にフォールバックします。');
            const md = await fetchMarkdownViaJina(url);
            const jinaVideos = extractVideosFromJinaMarkdown(md, {
              source: 'x1hub',
              includeUrlSubstrings: ['x1hub.com/contents/video', 'www.x1hub.com/contents/video'],
              excludeUrlSubstrings: ['/search', '/categories', '/category', '/tags', '#'],
              max: 50
            });
            if (jinaVideos.length > 0) {
              console.log(`✅ X1hub(Jina): ${jinaVideos.length}件の動画を取得`);
              return jinaVideos;
            }
          } catch (_) {}
        }
      } catch (urlError) {
        if (urlError.response && urlError.response.status === 403 && isCloudflareChallengeHtml(urlError.response.data)) {
          try {
            console.warn('⚠️ X1hub: Cloudflare(403) を検出（例外）。r.jina.ai にフォールバックします。');
            const md = await fetchMarkdownViaJina(url);
            const jinaVideos = extractVideosFromJinaMarkdown(md, {
              source: 'x1hub',
              includeUrlSubstrings: ['x1hub.com/contents/video', 'www.x1hub.com/contents/video'],
              excludeUrlSubstrings: ['/search', '/categories', '/category', '/tags', '#'],
              max: 50
            });
            if (jinaVideos.length > 0) return jinaVideos;
          } catch (_) {}
        }
        console.warn(`⚠️ X1hub URL試行エラー (${url}):`, urlError.message);
        continue;
      }
    }
    
    console.log(`✅ X1hub: ${videos.length}件の動画を取得`);
    return videos;
  } catch (error) {
    console.error('❌ X1hub検索エラー:', error.message);
    if (error.response && error.response.status === 403 && isCloudflareChallengeHtml(error.response.data)) {
      try {
        console.warn('⚠️ X1hub: Cloudflare(403) を検出（例外）。r.jina.ai にフォールバックします。');
        const md = await fetchMarkdownViaJina('https://x1hub.com/');
        const jinaVideos = extractVideosFromJinaMarkdown(md, {
          source: 'x1hub',
          includeUrlSubstrings: ['x1hub.com/contents/video', 'www.x1hub.com/contents/video'],
          excludeUrlSubstrings: ['/search', '/categories', '/category', '/tags', '#'],
          max: 50
        });
        if (jinaVideos.length > 0) return jinaVideos;
      } catch (_) {}
    }
    return [];
  }
}

// Bilibili検索（WEBスクレイピング）
// 注意: Bilibiliはスクレイピング対策を講じている可能性があります
async function searchBilibili(query, strictMode = true) {
  try {
    // クエリがnull/undefinedの場合は空文字列に変換
    query = query || '';
    const encodedQuery = encodeURIComponent(query);
    // 空のクエリの場合はトップページや最新動画ページから取得
    const url = query && query.trim() ? 
      `https://search.bilibili.com/all?keyword=${encodedQuery}` :
      `https://www.bilibili.com/`; // トップページから最新動画を取得
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': 'https://www.bilibili.com/',
        'Origin': 'https://www.bilibili.com',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      },
      timeout: 30000,
      maxRedirects: 5
    });
    
    const $ = cheerio.load(response.data);
    const videos = [];
    
    // 複数のセレクタを試す（BilibiliのHTML構造の変更に対応）
    const selectors = [
      '.video-item',
      '.bili-video-card',
      '.video-card',
      'a[href*="/video/"]',
      '.result-item',
      '[class*="video"]'
    ];
    
    for (const selector of selectors) {
      
      $(selector).each((index, elem) => {
        
        const $item = $(elem);
        const href = $item.attr('href') || $item.find('a').attr('href') || '';
        if (!href || !href.includes('/video/')) return;
        
        const fullUrl = href.startsWith('http') ? href : `https://www.bilibili.com${href}`;
        const title = extractTitle($, $item);
        let thumbnail = extractThumbnail($, $item);
        const duration = extractDurationFromHtml($, $item);
        
        // Bilibili専用のサムネイル抽出を試す
        if (!thumbnail) {
          // Bilibiliの検索結果ページのサムネイルセレクタ
          const bilibiliThumbSelectors = [
            '.bili-video-card__cover img',
            '.video-card__cover img',
            '.video-item__cover img',
            '.cover img',
            '[class*="cover"] img',
            '[class*="pic"] img',
            'img[src*="hdslb.com"]',
            'img[data-src*="hdslb.com"]',
            'img[data-lazy-src*="hdslb.com"]'
          ];
          
          for (const thumbSelector of bilibiliThumbSelectors) {
            const $thumb = $item.find(thumbSelector).first();
            if ($thumb.length > 0) {
              thumbnail = $thumb.attr('src') || 
                         $thumb.attr('data-src') || 
                         $thumb.attr('data-lazy-src') || 
                         $thumb.attr('data-original') || '';
              if (thumbnail) {
                // 相対URLを絶対URLに変換
                if (thumbnail.startsWith('//')) {
                  thumbnail = 'https:' + thumbnail;
                } else if (thumbnail.startsWith('/')) {
                  thumbnail = `https:${thumbnail}`;
                }
                break;
              }
            }
          }
        }
        
        // サムネイルが見つからない場合、BV番号からサムネイルURLを生成
        if (!thumbnail) {
          const bvid = fullUrl.match(/BV[a-zA-Z0-9]+/);
          if (bvid) {
            // BilibiliのサムネイルURL形式（複数のサーバーを試す）
            const thumbServers = ['i0', 'i1', 'i2'];
            thumbnail = `https://${thumbServers[Math.floor(Math.random() * thumbServers.length)]}.hdslb.com/bfs/archive/${bvid[0]}.jpg`;
          }
        }
        
        if (title && title.length > 2) { // 2文字以上に緩和
          // 空のクエリの場合は関連性チェックをスキップ
          if (query && query.trim().length > 0) {
            // 検索クエリとタイトルの関連性をチェック
            // strictMode=falseの場合は、関連性チェックを大幅に緩和またはスキップ
            if (strictMode) {
              // 厳格モードの場合のみ関連性チェック
              if (!isTitleRelevant(title, query, strictMode)) {
                return; // 関連性がない場合はスキップ
              }
            } else {
              // 緩和モードの場合、タイトルがあれば基本的に追加（関連性チェックをスキップ）
              // タイトルが1文字以下の場合のみスキップ
              if (title.length < 2) {
                return;
              }
            }
          }
          
          const bvid = fullUrl.match(/BV[a-zA-Z0-9]+/);
          const embedUrl = bvid ? `//player.bilibili.com/player.html?bvid=${bvid[0]}` : fullUrl;
          
          // 重複チェック
          const isDuplicate = videos.some(v => v.url === fullUrl);
          if (!isDuplicate) {
            videos.push({
              id: `bilibili-${Date.now()}-${index}`,
              title: title.substring(0, 200),
              thumbnail: thumbnail || '',
              duration: duration || '',
              url: fullUrl,
              embedUrl: embedUrl,
              source: 'bilibili'
            });
          }
        }
      });
    }
    
    console.log(`✅ Bilibili: ${videos.length}件の動画を取得`);
    return videos;
  } catch (error) {
    console.error('Bilibili検索エラー:', error.message);
    return [];
  }
}

// Javmix.TV検索
async function searchJavmix(query, strictMode = true) {
  try {
    // クエリがnull/undefinedの場合は空文字列に変換
    query = query || '';
    console.log(`🔍 Javmix.TV検索開始: "${query}" (strictMode: ${strictMode})`);
    const encodedQuery = encodeURIComponent(query);
    // 複数のURLパターンを試す（空のクエリの場合はトップページや最新動画ページから取得）
    const urls = query && query.trim() ? [
      `https://javmix.tv/search?q=${encodedQuery}`,
      `https://javmix.tv/search/${encodedQuery}`,
      `https://javmix.tv/?q=${encodedQuery}`
    ] : [
      `https://javmix.tv/`, // トップページから最新動画を取得
      `https://javmix.tv/latest`, // 最新動画ページ
      `https://javmix.tv/videos` // 動画一覧ページ
    ];
    
    let videos = [];
    
    for (const url of urls) {
      try {
        const response = await axios.get(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Referer': 'https://javmix.tv/',
            'Accept-Encoding': 'gzip, deflate, br'
          },
          timeout: 30000,
          validateStatus: () => true
        });

        if (response.status === 403 && isCloudflareChallengeHtml(response.data)) {
          console.warn('⚠️ Javmix.TV: Cloudflare(403) を検出。r.jina.ai にフォールバックします。');
          const md = await fetchMarkdownViaJina(url);
          const jinaVideos = extractVideosFromJinaMarkdown(md, {
            source: 'javmix',
            includeUrlSubstrings: ['javmix.tv/video/', 'javmix.tv/'],
            excludeUrlSubstrings: ['/categories', '/models', '/latest-updates', '/hot', '#'],
            max: 50
          });
          if (jinaVideos.length > 0) return jinaVideos;
          continue;
        }
        if (response.status >= 400) {
          console.warn(`⚠️ Javmix.TV: HTTP ${response.status}`);
          continue;
        }
        
        const $ = cheerio.load(response.data);
        console.log(`🔍 Javmix.TV: HTML取得完了、パース開始 (HTMLサイズ: ${response.data.length} bytes)`);
        
        // 複数のセレクタを試す（より広範囲に）
        const selectors = [
          'a[href*="/video/"]',
          'a[href*="/watch/"]',
          'a[href*="/v/"]',
          'a[href*="/play/"]',
          'a[href*="/movie/"]',
          'a[href*="/embed/"]',
          '.video-item',
          '.item',
          '[class*="video"]',
          '[class*="item"]',
          '.result-item',
          '.search-result-item',
          'article',
          '[class*="card"]',
          'div[class*="video"]',
          'div[class*="item"]',
          'li a',
          'div a'
        ];
        
        const seenUrls = new Set();
        let foundCount = 0;
        let matchedCount = 0;
        
        selectors.forEach(selector => {
          $(selector).each((index, elem) => {
            if (videos.length >= 50) return false;
            
            foundCount++;
            
            const $item = $(elem);
            let href = $item.attr('href') || $item.find('a').attr('href') || '';
            
            // hrefが見つからない場合は親要素を探す
            if (!href) {
              const $parent = $item.parent();
              href = $parent.attr('href') || $parent.find('a').attr('href') || '';
            }
            
            // Javmix.TVの動画URLパターンを確認（より柔軟に）
            // javmix.tvのドメイン内のリンクで、動画らしいURLパターンを含むもの
            if (!href) return;
            const isJavmixUrl = href.includes('javmix.tv') || href.startsWith('/');
            const hasVideoPattern = href.includes('/video/') || href.includes('/watch/') || href.includes('/v/') || href.includes('/play/') || href.includes('/movie/') || href.includes('/embed/');
            if (!isJavmixUrl || !hasVideoPattern) {
              return;
            }
            
            matchedCount++;
            
            // 相対URLを絶対URLに変換
            let fullUrl = href;
            if (href.startsWith('//')) {
              fullUrl = 'https:' + href;
            } else if (href.startsWith('/')) {
              fullUrl = `https://javmix.tv${href}`;
            } else if (!href.startsWith('http')) {
              fullUrl = `https://javmix.tv/${href}`;
            }
            
            // 重複チェック
            if (seenUrls.has(fullUrl)) return;
            seenUrls.add(fullUrl);
            
            const title = extractTitle($, $item);
            const thumbnail = extractThumbnail($, $item);
            const duration = extractDurationFromHtml($, $item);
            
            // タイトルが空の場合、URLからタイトルを抽出
            let finalTitle = title;
            if (!finalTitle || finalTitle.length < 3) {
              // URLからタイトルを抽出を試みる
              const urlMatch = fullUrl.match(/\/([^\/]+)$/);
              if (urlMatch) {
                finalTitle = decodeURIComponent(urlMatch[1]).replace(/[-_]/g, ' ').trim();
              }
              // それでもタイトルがない場合、リンクテキストを使用
              if (!finalTitle || finalTitle.length < 3) {
                finalTitle = $item.text().trim() || $item.find('a').text().trim() || '';
              }
            }
            
            // タイトルがあれば追加（より積極的に）
            if (finalTitle && finalTitle.length > 2) { // 2文字以上に緩和
              // 検索クエリとタイトルの関連性をチェック
              // strictMode=falseの場合は、関連性チェックを大幅に緩和またはスキップ
              if (strictMode) {
                // 厳格モードの場合のみ関連性チェック
                if (!isTitleRelevant(finalTitle, query, strictMode)) {
                  return; // 関連性がない場合はスキップ
                }
              } else {
                // 緩和モードの場合、タイトルがあれば基本的に追加（関連性チェックをスキップ）
                // タイトルが1文字以下の場合のみスキップ
                if (finalTitle.length < 2) {
                  return;
                }
              }
              
              videos.push({
                id: `javmix-${Date.now()}-${index}`,
                title: finalTitle.substring(0, 200),
                thumbnail: thumbnail || '',
                duration: duration || '',
                url: fullUrl,
                embedUrl: fullUrl,
                source: 'javmix'
              });
            } else if (fullUrl && fullUrl.includes('javmix.tv')) {
              // タイトルがなくても、URLが有効な場合は追加（フォールバック）
              const fallbackTitle = fullUrl.match(/\/([^\/]+)$/)?.[1] || '動画';
              videos.push({
                id: `javmix-${Date.now()}-${index}`,
                title: decodeURIComponent(fallbackTitle).replace(/[-_]/g, ' ').substring(0, 200),
                thumbnail: thumbnail || '',
                duration: duration || '',
                url: fullUrl,
                embedUrl: fullUrl,
                source: 'javmix'
              });
            }
          });
        });
        
        console.log(`🔍 Javmix.TV: 見つかった要素: ${foundCount}件、マッチした要素: ${matchedCount}件、動画: ${videos.length}件`);
        
        // 結果が見つかったらループを抜ける
        if (videos.length > 0) {
          console.log(`✅ Javmix.TV: ${videos.length}件の動画を取得（URL: ${url}）`);
          break;
        } else {
          console.log(`ℹ️ Javmix.TV: このURLでは結果が見つかりませんでした（URL: ${url}）`);
        }
      } catch (urlError) {
        // 404や403エラーは予想される動作なので、警告を抑制（最初のURLのみ情報を出力）
        const urlIndex = urls.indexOf(url) + 1;
        if (urlIndex === 1 && urlError.response && (urlError.response.status === 404 || urlError.response.status === 403)) {
          console.log(`ℹ️ Javmix.TV: 検索エンドポイントが見つかりません（${urlError.response.status}）。他のURLパターンを試行します。`);
        } else if (urlError.response) {
          console.warn(`⚠️ Javmix.TV URL試行エラー (${url}): Request failed with status code ${urlError.response.status}`);
        } else {
          console.warn(`⚠️ Javmix.TV URL試行エラー (${url}): ${urlError.message}`);
        }
        continue;
      }
    }
    
    console.log(`✅ Javmix.TV: ${videos.length}件の動画を取得`);
    return videos;
  } catch (error) {
    if (error.response && error.response.status === 404) {
      console.warn('⚠️ Javmix.TV検索: ページが見つかりません（404）');
    } else {
      console.error('❌ Javmix.TV検索エラー:', error.message);
    }
    return [];
  }
}

// Japanhub検索（japanhub.net）
// strictMode: true = 厳格なマッチング, false = 緩和したマッチング
async function searchJapanhub(query, strictMode = false) {
  try {
    // クエリがnull/undefinedの場合は空文字列に変換
    query = query || '';
    console.log(`🔍 Japanhub検索開始: "${query}" (strictMode: ${strictMode})`);
    const startTime = Date.now();
    const queryLower = query.toLowerCase().trim();
    
    // 検索URLを構築
    const urls = [];
    if (query && query.trim().length > 0) {
      const encodedQuery = encodeURIComponent(query);
      urls.push(`https://japanhub.net/search?q=${encodedQuery}`);
      urls.push(`https://japanhub.net/search/${encodedQuery}`);
      urls.push(`https://japanhub.net/?s=${encodedQuery}`);
    } else {
      // 空のクエリの場合はトップページから取得（複数URLパターンを試す）
      urls.push(`https://japanhub.net/`);
      urls.push(`https://japanhub.net/videos`);
      urls.push(`https://japanhub.net/latest`);
    }
    
    const videos = [];
    const seenUrls = new Set();
    
    for (const url of urls) {
      try {
        console.log(`🔍 Japanhub: URL取得開始: ${url}`);
        const response = await axios.get(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Referer': 'https://japanhub.net/',
            'Accept-Encoding': 'gzip, deflate, br'
          },
          timeout: 30000,
          validateStatus: () => true
        });
        
        console.log(`🔍 Japanhub: HTTPステータス: ${response.status}, HTMLサイズ: ${response.data.length} bytes`);

        // Cloudflareブロック時は r.jina.ai 経由で取得してリンクから復元
        if (response.status === 403 && isCloudflareChallengeHtml(response.data)) {
          console.warn('⚠️ Japanhub: Cloudflare(403) を検出。r.jina.ai にフォールバックします。');
          const md = await fetchMarkdownViaJina(url);
          const jinaVideos = extractVideosFromJinaMarkdown(md, {
            source: 'japanhub',
            includeUrlSubstrings: ['japanhub.net/video', 'japanhub.net/watch', 'japanhub.net/v/'],
            excludeUrlSubstrings: ['/signup', '/login', '/lost', '/confirm', '#'],
            max: 50
          });
          if (jinaVideos.length > 0) {
            console.log(`✅ Japanhub(Jina): ${jinaVideos.length}件の動画を取得`);
            return jinaVideos;
          }
          continue;
        }
        if (response.status >= 400) {
          console.warn(`⚠️ Japanhub: HTTP ${response.status}`);
          continue;
        }
        
        const $ = cheerio.load(response.data);
        console.log(`🔍 Japanhub: HTML取得完了、パース開始`);
        
        // 複数のセレクタを試す
        const selectors = [
          'article h2 a',
          'article h1 a',
          'h2 a',
          'h1 a',
          'article a',
          '.entry-title a',
          '.post-title a',
          '.video-item a',
          '.item a',
          'a[href*="/video/"]',
          'a[href*="/watch/"]',
          'a[href*="japanhub.net"]'
        ];
        
        let foundCount = 0;
        let matchedCount = 0;
        
        for (const selector of selectors) {
          $(selector).each((index, elem) => {
            const $item = $(elem);
            let titleText = $item.text().trim() || $item.attr('title') || '';
            let href = $item.attr('href') || '';
            
            // タイトルが空の場合はスキップ（2文字以上に緩和）
            if (!titleText || titleText.trim().length < 2) {
              return;
            }
            
            foundCount++;
            
            // 空のクエリの場合はすべての動画を取得
            if (!query || query.trim().length === 0) {
              matchedCount++;
            } else {
              // 検索クエリとタイトルの関連性をチェック
              const titleLower = titleText.toLowerCase();
              
              // クエリがIDパターンに含まれているか、タイトルに含まれているか
              const idMatch = titleText.match(/\[([A-Z]+[-\d]+)\]/);
              const queryInId = idMatch && idMatch[1].toLowerCase().includes(queryLower);
              const queryInTitle = titleLower.includes(queryLower);
              
              // 緩和したマッチング: 部分一致や文字単位の一致も許可（より積極的に）
              const queryChars = queryLower.split('').filter(c => c.trim().length > 0 && c !== ' ');
              const matchingChars = queryChars.filter(char => titleLower.includes(char)).length;
              const oneCharMatch = queryChars.length > 0 && matchingChars > 0;
              
              const shouldMatch = queryInId || queryInTitle || oneCharMatch;
              
              if (!shouldMatch) {
                return; // 検索語が含まれていない場合はスキップ
              }
              
              matchedCount++;
            }
            
            // 相対URLを絶対URLに変換
            let fullUrl = href;
            if (href) {
              if (href.startsWith('//')) {
                fullUrl = 'https:' + href;
              } else if (href.startsWith('/')) {
                fullUrl = `https://japanhub.net${href}`;
              } else if (href.startsWith('./')) {
                fullUrl = `https://japanhub.net/${href.substring(2)}`;
              } else if (!href.startsWith('http')) {
                fullUrl = `https://japanhub.net/${href}`;
              }
            } else {
              return; // リンクが見つからない場合はスキップ
            }
            
            // japanhub.netのドメイン内のリンクのみを対象
            if (!fullUrl.includes('japanhub.net')) return;
            
            // 重複チェック
            if (seenUrls.has(fullUrl)) return;
            seenUrls.add(fullUrl);
            
            // サムネイルを取得
            let thumbnail = extractThumbnail($, $item);
            
            // サムネイルが見つからない場合、親要素から探す
            if (!thumbnail) {
              const $parent = $item.parent();
              thumbnail = extractThumbnail($, $parent);
            }
            
            // さらに上の親要素から探す
            if (!thumbnail) {
              const $grandParent = $item.parent().parent();
              thumbnail = extractThumbnail($, $grandParent);
            }
            
            const duration = extractDurationFromHtml($, $item);
            
            videos.push({
              id: `japanhub-${Date.now()}-${index}`,
              title: titleText.substring(0, 200),
              thumbnail: thumbnail || '',
              duration: duration || '',
              url: fullUrl,
              embedUrl: fullUrl,
              source: 'japanhub'
            });
          });
        }
        
        // 結果が見つかったらループを抜ける
        if (videos.length > 0) {
          console.log(`✅ Japanhub: ${videos.length}件の動画を取得（URL: ${url}）`);
          break;
        }
      } catch (urlError) {
        if (urlError.response && urlError.response.status === 403 && isCloudflareChallengeHtml(urlError.response.data)) {
          try {
            console.warn('⚠️ Japanhub: Cloudflare(403) を検出。r.jina.ai にフォールバックします。');
            const md = await fetchMarkdownViaJina(url);
            const jinaVideos = extractVideosFromJinaMarkdown(md, {
              source: 'japanhub',
              includeUrlSubstrings: ['japanhub.net/video', 'japanhub.net/watch', 'japanhub.net/v/'],
              excludeUrlSubstrings: ['/signup', '/login', '/lost', '/confirm', '#'],
              max: 50
            });
            if (jinaVideos.length > 0) return jinaVideos;
          } catch (_) {}
        }
        console.warn(`⚠️ Japanhub URL試行エラー (${url}):`, urlError.message);
        continue;
      }
    }
    
    const endTime = Date.now();
    const duration = endTime - startTime;
    console.log(`🔍 Japanhub: 見つかった動画: ${matchedCount}件、最終結果: ${videos.length}件`);
    console.log(`✅ Japanhub: ${videos.length}件の動画を取得（実行時間: ${duration}ms）`);
    
    // デバッグ情報: 最初の5件のタイトルを表示
    if (videos.length > 0) {
      console.log(`🔍 Japanhub デバッグ: 取得した動画のサンプル:`);
      videos.slice(0, 5).forEach((video, idx) => {
        console.log(`  ${idx + 1}. ${video.title.substring(0, 50)}... (URL: ${video.url.substring(0, 60)}...)`);
      });
    } else {
      console.log(`⚠️ Japanhub: 動画が見つかりませんでした（検索クエリ: "${query}", strictMode: ${strictMode}）`);
    }
    
    return videos;
  } catch (error) {
    if (error.response && error.response.status === 404) {
      console.warn('⚠️ Japanhub検索: ページが見つかりません（404）');
    } else {
      console.error('❌ Japanhub検索エラー:', error.message);
    }
    return [];
  }
}

// Pizjav検索（v.pizjav.com）
// strictMode: true = 厳格なマッチング, false = 緩和したマッチング
async function searchPizjav(query, strictMode = false) {
  try {
    // クエリがnull/undefinedの場合は空文字列に変換
    query = query || '';
    console.log(`🔍 Pizjav検索開始: "${query}" (strictMode: ${strictMode})`);
    const startTime = Date.now();
    const queryLower = query.toLowerCase().trim();
    
    // トップページから全件取得してフィルタリング
    const url = `https://v.pizjav.com/`;
    
    console.log(`🔍 Pizjav: URL取得開始: ${url}`);
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Referer': 'https://v.pizjav.com/',
        'Accept-Encoding': 'gzip, deflate, br'
      },
      timeout: 30000,
      validateStatus: function (status) {
        return status >= 200 && status < 400;
      }
    });
    
    console.log(`🔍 Pizjav: HTTPステータス: ${response.status}, HTMLサイズ: ${response.data.length} bytes`);
    
    const $ = cheerio.load(response.data);
    const videos = [];
    const seenUrls = new Set();
    
    console.log(`🔍 Pizjav: HTML取得完了、パース開始`);
    
    // 複数のセレクタを試す
    const selectors = [
      'article h2 a',
      'article h1 a',
      'h2 a',
      'h1 a',
      'article a',
      '.entry-title a',
      '.post-title a',
      'a[href*="pizjav.com"]'
    ];
    
    let foundCount = 0;
    let matchedCount = 0;
    
    for (const selector of selectors) {
      $(selector).each((index, elem) => {
        const $item = $(elem);
        let titleText = $item.text().trim() || $item.attr('title') || '';
        let href = $item.attr('href') || '';
        
        // タイトルが空の場合はスキップ（2文字以上に緩和）
        if (!titleText || titleText.trim().length < 2) {
          return;
        }
        
        foundCount++;
        
        // 空のクエリの場合はすべての動画を取得
        if (!query || query.trim().length === 0) {
          matchedCount++;
        } else {
          // 検索クエリとタイトルの関連性をチェック
          const titleLower = titleText.toLowerCase();
          
          // クエリがIDパターンに含まれているか、タイトルに含まれているか
          const idMatch = titleText.match(/\[([A-Z]+[-\d]+)\]/);
          const queryInId = idMatch && idMatch[1].toLowerCase().includes(queryLower);
          const queryInTitle = titleLower.includes(queryLower);
          
          // 緩和したマッチング: 部分一致や文字単位の一致も許可（より積極的に）
          const queryChars = queryLower.split('').filter(c => c.trim().length > 0 && c !== ' ');
          const matchingChars = queryChars.filter(char => titleLower.includes(char)).length;
          const oneCharMatch = queryChars.length > 0 && matchingChars > 0;
          
          const shouldMatch = queryInId || queryInTitle || oneCharMatch;
          
          if (!shouldMatch) {
            return; // 検索語が含まれていない場合はスキップ
          }
          
          matchedCount++;
        }
        
        // 相対URLを絶対URLに変換
        let fullUrl = href;
        if (href) {
          if (href.startsWith('//')) {
            fullUrl = 'https:' + href;
          } else if (href.startsWith('/')) {
            fullUrl = `https://v.pizjav.com${href}`;
          } else if (href.startsWith('./')) {
            fullUrl = `https://v.pizjav.com/${href.substring(2)}`;
          } else if (!href.startsWith('http')) {
            fullUrl = `https://v.pizjav.com/${href}`;
          }
        } else {
          return; // リンクが見つからない場合はスキップ
        }
        
        // pizjav.comのドメイン内のリンクのみを対象
        if (!fullUrl.includes('pizjav.com')) return;
        
        // 重複チェック
        if (seenUrls.has(fullUrl)) return;
        seenUrls.add(fullUrl);
        
        // サムネイルを取得
        let thumbnail = extractThumbnail($, $item);
        
        // サムネイルが見つからない場合、親要素から探す
        if (!thumbnail) {
          const $parent = $item.parent();
          thumbnail = extractThumbnail($, $parent);
        }
        
        // さらに上の親要素から探す
        if (!thumbnail) {
          const $grandParent = $item.parent().parent();
          thumbnail = extractThumbnail($, $grandParent);
        }
        
        const duration = extractDurationFromHtml($, $item);
        
        videos.push({
          id: `pizjav-${Date.now()}-${index}`,
          title: titleText.substring(0, 200),
          thumbnail: thumbnail || '',
          duration: duration || '',
          url: fullUrl,
          embedUrl: fullUrl,
          source: 'pizjav'
        });
      });
    }
    
    const endTime = Date.now();
    const duration = endTime - startTime;
    console.log(`🔍 Pizjav: 見つかった動画: ${foundCount}件、マッチした動画: ${matchedCount}件、最終結果: ${videos.length}件`);
    console.log(`✅ Pizjav: ${videos.length}件の動画を取得（実行時間: ${duration}ms）`);
    
    // デバッグ情報: 最初の5件のタイトルを表示
    if (videos.length > 0) {
      console.log(`🔍 Pizjav デバッグ: 取得した動画のサンプル:`);
      videos.slice(0, 5).forEach((video, idx) => {
        console.log(`  ${idx + 1}. ${video.title.substring(0, 50)}... (URL: ${video.url.substring(0, 60)}...)`);
      });
    } else {
      console.log(`⚠️ Pizjav: 動画が見つかりませんでした（検索クエリ: "${query}", strictMode: ${strictMode}）`);
    }
    
    return videos;
  } catch (error) {
    if (error.response && error.response.status === 404) {
      console.warn('⚠️ Pizjav検索: ページが見つかりません（404）');
    } else {
      console.error('❌ Pizjav検索エラー:', error.message);
    }
    return [];
  }
}

// IVFree検索（ivfree.asia）
// strictMode: true = 厳格なマッチング, false = 緩和したマッチング
async function searchIVFree(query, strictMode = true) {
  try {
    // クエリがnull/undefinedの場合は空文字列に変換
    query = query || '';
    console.log(`🔍 IVFree検索開始: "${query}" (strictMode: ${strictMode})`);
    const startTime = Date.now();
    const queryLower = query.toLowerCase().trim();
    
    // トップページから全件取得してフィルタリング（検索機能があるか不明なため）
    const url = `http://ivfree.asia/`;
    
    console.log(`🔍 IVFree: URL取得開始: ${url}`);
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Referer': 'http://ivfree.asia/',
        'Accept-Encoding': 'gzip, deflate, br'
      },
      timeout: 30000,
      validateStatus: function (status) {
        return status >= 200 && status < 400;
      }
    });
    
    console.log(`🔍 IVFree: HTTPステータス: ${response.status}, HTMLサイズ: ${response.data.length} bytes`);
    
    const $ = cheerio.load(response.data);
    const videos = [];
    const seenUrls = new Set();
    
    console.log(`🔍 IVFree: HTML取得完了、パース開始`);
    
    // 複数のセレクタを試す（実際のHTML構造に合わせて調整）
    const selectors = [
      'h2 a',
      'h3 a',
      'h2',
      'h3',
      'article h2 a',
      'article h3 a',
      'a[href*="ivfree.asia"]',
      // より広範囲なセレクタを追加
      'a[href*="/imog/"]',
      'a[href*="/imbd/"]',
      'a[href*="/imdb/"]',
      'a[href*="/kuromiya/"]',
      'a[href*="/mmr/"]',
      'a[href*="/cpsky/"]',
      'a[href*="/icdv/"]',
      'a[href*="/tl/"]',
      'a[href*="/iv/"]',
      '.entry-title a',
      '.post-title a',
      '.title a',
      'article a',
      'li a',
      'div a',
      '.content a',
      '.main a',
      '.container a',
      '.wrapper a',
      // すべてのリンク（最後の手段）
      'a[href*="ivfree.asia"]'
    ];
    
    let foundCount = 0;
    let matchedCount = 0;
    
    for (const selector of selectors) {
      $(selector).each((index, elem) => {
        // 制限なしで全件取得
        
        const $item = $(elem);
        let titleText = '';
        let href = '';
        
        // aタグの場合は直接hrefを取得
        if ($item.is('a')) {
          href = $item.attr('href') || '';
          titleText = $item.text().trim() || $item.attr('title') || '';
        } else if ($item.is('h2') || $item.is('h3')) {
          // h2/h3タグの場合は、テキストとリンクを取得
          titleText = $item.text().trim();
          const $link = $item.find('a').first();
          if ($link.length > 0) {
            href = $link.attr('href') || '';
            if (!titleText) {
              titleText = $link.text().trim() || $link.attr('title') || '';
            }
          }
        }
        
        // タイトルが空または短い場合、URLからタイトルを生成
        // 5文字以下のタイトルは、URLから再生成を試みる（動画が見れない可能性が高いため）
        if (!titleText || titleText.trim().length <= 5) {
          // URLからタイトルを抽出を試みる
          if (href) {
            const urlMatch = href.match(/\/([^\/]+)$/);
            if (urlMatch) {
              const urlTitle = decodeURIComponent(urlMatch[1])
                .replace(/[-_]/g, ' ')
                .replace(/\.html?$/i, '')
                .trim();
              
              // URLから抽出したタイトルが6文字以上の場合、それを使用
              if (urlTitle && urlTitle.length > 5) {
                titleText = urlTitle;
              }
            }
          }
          
          // それでもタイトルが5文字以下の場合、IDパターンからタイトルを生成
          if (!titleText || titleText.trim().length <= 5) {
            const idMatch = href.match(/([A-Z]+-\d+)/);
            if (idMatch) {
              titleText = `[${idMatch[1]}]`;
            }
          }
          
          // タイトルが5文字以下の場合はスキップ（動画が見れない可能性が高いため）
          if (!titleText || titleText.trim().length <= 5) {
            console.log(`⚠️ IVFree: タイトルが短すぎるためスキップ: "${titleText}" (URL: ${href})`);
            return;
          }
        }
        
        // タイトルにIDパターン [XXX-XXX] が含まれているか確認
        // 以前は必須でしたが、より柔軟にするため、IDパターンがない場合も許可
        const hasIdPattern = titleText.match(/\[[A-Z]+-\d+\]/);
        
        foundCount++;
        
        // 空のクエリの場合はすべての動画を取得
        if (!query || query.trim().length === 0) {
          // 空のクエリの場合は、すべての動画を追加（strictModeに関係なく）
          matchedCount++;
        } else {
          // 検索クエリとタイトルの関連性をチェック
          // 検索語がタイトルに完全に含まれていることを必須とする（厳格なマッチング）
          const titleLower = titleText.toLowerCase();
          const queryLower = query.toLowerCase().trim();
          
          // クエリがIDパターンに含まれているか、タイトルに含まれているか
          const idMatch = titleText.match(/\[([A-Z]+)-\d+\]/);
          const queryInId = idMatch && idMatch[1].toLowerCase().includes(queryLower);
          const queryInTitle = titleLower.includes(queryLower);
          
          // 厳格なマッチングと緩和したマッチングを切り替え
          let shouldMatch = false;
          
          if (strictMode) {
            // 厳格なマッチング: 完全一致のみ
            if (hasIdPattern) {
              // IDパターンがある場合: IDパターンに完全一致、またはタイトルに完全一致のみ
              shouldMatch = queryInId || queryInTitle;
            } else {
              // IDパターンがない場合: タイトルに完全一致のみを許可（非常に厳格）
              shouldMatch = queryInTitle;
            }
          } else {
            // 緩和したマッチング: 部分一致や文字単位の一致も許可（より積極的に）
            const queryChars = queryLower.split('').filter(c => c.trim().length > 0 && c !== ' ');
            const allCharsInTitle = queryChars.length > 0 && queryChars.every(char => titleLower.includes(char));
            const matchingChars = queryChars.filter(char => titleLower.includes(char)).length;
            const halfCharsMatch = queryChars.length >= 2 && matchingChars >= Math.ceil(queryChars.length / 2);
            // さらに緩和: 1文字でも一致していれば追加（より積極的に）
            const oneCharMatch = queryChars.length > 0 && matchingChars > 0;
            
            if (hasIdPattern) {
              // IDパターンがある場合: IDパターンに完全一致、タイトルに完全一致、すべての文字がタイトルに含まれている、50%以上の文字が一致している、または1文字でも一致している
              shouldMatch = queryInId || queryInTitle || allCharsInTitle || halfCharsMatch || oneCharMatch;
            } else {
              // IDパターンがない場合: タイトルに完全一致、すべての文字がタイトルに含まれている、50%以上の文字が一致している、または1文字でも一致している
              shouldMatch = queryInTitle || allCharsInTitle || halfCharsMatch || oneCharMatch;
            }
          }
          
          if (!shouldMatch) {
            return; // 検索語が含まれていない場合はスキップ
          }
          
          matchedCount++;
        }
        
        // リンクが見つからない場合は、親要素から探す
        if (!href) {
          const $parent = $item.parent();
          if ($parent.is('a')) {
            href = $parent.attr('href') || '';
          } else {
            const $parentLink = $parent.find('a').first();
            if ($parentLink.length > 0) {
              href = $parentLink.attr('href') || '';
            }
          }
        }
        
        // さらに上の親要素から探す
        if (!href) {
          const $grandParent = $item.parent().parent();
          if ($grandParent.is('a')) {
            href = $grandParent.attr('href') || '';
          } else {
            const $grandParentLink = $grandParent.find('a').first();
            if ($grandParentLink.length > 0) {
              href = $grandParentLink.attr('href') || '';
            }
          }
        }
        
        // 相対URLを絶対URLに変換
        let fullUrl = href;
        if (href) {
          if (href.startsWith('//')) {
            fullUrl = 'http:' + href;
          } else if (href.startsWith('/')) {
            fullUrl = `http://ivfree.asia${href}`;
          } else if (href.startsWith('./')) {
            fullUrl = `http://ivfree.asia/${href.substring(2)}`;
          } else if (!href.startsWith('http')) {
            fullUrl = `http://ivfree.asia/${href}`;
          }
        } else {
          // リンクが見つからない場合は、IDパターンからURLを生成
          const idMatch = titleText.match(/\[([A-Z]+-\d+)\]/);
          if (idMatch) {
            // 複数のURLパターンを試す
            const id = idMatch[1];
            fullUrl = `http://ivfree.asia/video/${id}`;
          } else {
            return;
          }
        }
        
        // ivfree.asiaのドメイン内のリンクのみを対象
        if (!fullUrl.includes('ivfree.asia')) return;
        
        // タイトルが5文字以下の場合、URLからタイトルを再生成して確認
        if (titleText && titleText.trim().length <= 5 && fullUrl) {
          try {
            const urlObj = new URL(fullUrl);
            const urlPath = urlObj.pathname;
            const urlSegments = urlPath.split('/').filter(Boolean);
            if (urlSegments.length > 0) {
              const lastSegment = urlSegments[urlSegments.length - 1];
              const urlTitle = decodeURIComponent(lastSegment)
                .replace(/[-_]/g, ' ')
                .replace(/\.html?$/i, '')
                .trim();
              
              // URLから抽出したタイトルが6文字以上の場合、それを使用
              if (urlTitle && urlTitle.length > 5) {
                titleText = urlTitle;
                console.log(`🔍 IVFree: URLからタイトルを再生成: "${titleText}" (URL: ${fullUrl})`);
              } else {
                // それでも5文字以下の場合はスキップ（動画が見れない可能性が高いため）
                console.log(`⚠️ IVFree: タイトルが短すぎるためスキップ: "${titleText}" (URL: ${fullUrl})`);
                return;
              }
            }
          } catch (e) {
            // URL解析エラーの場合もスキップ
            console.log(`⚠️ IVFree: URL解析エラーのためスキップ: "${titleText}" (URL: ${fullUrl})`);
            return;
          }
        }
        
        // 重複チェック
        if (seenUrls.has(fullUrl)) return;
        seenUrls.add(fullUrl);
        
        // サムネイルを取得（複数の方法を試す）
        let thumbnail = extractThumbnail($, $item);
        
        // サムネイルが見つからない場合、親要素から探す
        if (!thumbnail) {
          const $parent = $item.parent();
          thumbnail = extractThumbnail($, $parent);
        }
        
        // さらに上の親要素から探す
        if (!thumbnail) {
          const $grandParent = $item.parent().parent();
          thumbnail = extractThumbnail($, $grandParent);
        }
        
        // サムネイルが見つからない場合、デフォルト画像を使用
        if (!thumbnail) {
          // IVFreeのデフォルトサムネイルパターンを試す
          const idMatch = titleText.match(/\[([A-Z]+-\d+)\]/);
          if (idMatch) {
            const id = idMatch[1].toLowerCase();
            thumbnail = `http://ivfree.asia/images/${id}.jpg`;
          }
        }
        
        const duration = extractDurationFromHtml($, $item);
        
        videos.push({
          id: `ivfree-${Date.now()}-${index}`,
          title: titleText.substring(0, 200),
          thumbnail: thumbnail || '',
          duration: duration || '',
          url: fullUrl,
          embedUrl: fullUrl, // 動画ページのURL（埋め込みURLは後で取得）
          source: 'ivfree'
        });
      });
      
      // より多くの結果を取得するため、すべてのセレクタを試す（breakを削除）
      // if (videos.length > 0) break; // コメントアウト: より多くの結果を取得するため
    }
    
    const endTime = Date.now();
    const duration = endTime - startTime;
    console.log(`🔍 IVFree: 見つかった動画: ${foundCount}件、マッチした動画: ${matchedCount}件、最終結果: ${videos.length}件`);
    console.log(`✅ IVFree: ${videos.length}件の動画を取得（実行時間: ${duration}ms）`);
    
    // デバッグ情報: 最初の5件のタイトルを表示
    if (videos.length > 0) {
      console.log(`🔍 IVFree デバッグ: 取得した動画のサンプル:`);
      videos.slice(0, 5).forEach((video, idx) => {
        console.log(`  ${idx + 1}. ${video.title.substring(0, 50)}... (URL: ${video.url.substring(0, 60)}...)`);
      });
    } else {
      console.log(`⚠️ IVFree: 動画が見つかりませんでした（検索クエリ: "${query}", strictMode: ${strictMode}）`);
      console.log(`🔍 IVFree デバッグ: 見つかった要素数: ${foundCount}件、マッチした要素数: ${matchedCount}件`);
      
      // より詳細なデバッグ: 最初の10件の要素を確認
      if (foundCount > 0 && foundCount !== matchedCount) {
        console.log(`🔍 IVFree デバッグ: マッチしなかった要素のサンプル（検索クエリ: "${query}"）:`);
        let sampleCount = 0;
        for (const selector of selectors) {
          $(selector).each((index, elem) => {
            if (sampleCount >= 10) return false;
            const $item = $(elem);
            let titleText = '';
            if ($item.is('a')) {
              titleText = $item.text().trim() || $item.attr('title') || '';
            } else if ($item.is('h2') || $item.is('h3')) {
              titleText = $item.text().trim();
            }
            if (titleText && titleText.length > 3) {
              const titleLower = titleText.toLowerCase();
              const queryLower = query.toLowerCase().trim();
              const queryInTitle = titleLower.includes(queryLower);
              const idMatch = titleText.match(/\[([A-Z]+)-\d+\]/);
              const queryInId = idMatch && idMatch[1].toLowerCase().includes(queryLower);
              
              if (!queryInTitle && !queryInId) {
                console.log(`  - "${titleText.substring(0, 60)}..." (マッチしなかった)`);
                sampleCount++;
              }
            }
          });
          if (sampleCount >= 10) break;
        }
      }
      
      // デバッグ: 最初の10件のタイトルを表示（マッチしなかったものも含む）
      if (foundCount > 0 && foundCount !== matchedCount) {
        console.log(`🔍 IVFree デバッグ: マッチしなかったタイトルのサンプル（検索クエリ: "${query}"）:`);
        console.log(`🔍 IVFree デバッグ: 検索クエリ（小文字）: "${queryLower}"`);
        let sampleCount = 0;
        for (const selector of selectors) {
          $(selector).each((index, elem) => {
            if (sampleCount >= 10) return false;
            const $item = $(elem);
            let titleText = '';
            if ($item.is('a')) {
              titleText = $item.text().trim() || $item.attr('title') || '';
            } else if ($item.is('h2') || $item.is('h3')) {
              titleText = $item.text().trim();
            }
            if (titleText && titleText.length > 3) {
              const titleLower = titleText.toLowerCase();
              const queryInTitle = titleLower.includes(queryLower);
              const idMatch = titleText.match(/\[([A-Z]+)-\d+\]/);
              const queryInId = idMatch && idMatch[1].toLowerCase().includes(queryLower);
              
              const hasIdPattern = titleText.match(/\[[A-Z]+-\d+\]/);
              let shouldMatch = false;
              if (hasIdPattern) {
                // IDパターンがある場合: IDパターンに完全一致、またはタイトルに完全一致のみ
                shouldMatch = queryInId || queryInTitle;
              } else {
                // IDパターンがない場合: タイトルに完全一致のみを許可（非常に厳格）
                shouldMatch = queryInTitle;
              }
              
              if (!shouldMatch) {
                console.log(`  - ${titleText.substring(0, 60)}... (マッチしなかった理由: 検索語が含まれていない, タイトル（小文字）: "${titleLower.substring(0, 40)}...", 検索語: "${queryLower}")`);
                sampleCount++;
              }
            }
          });
          if (sampleCount >= 10) break; // ループを中断（return falseではなくbreakを使用）
        }
      }
    }
    
    return videos;
  } catch (error) {
    console.error('❌ IVFree検索エラー:', error.message);
    if (error.response) {
      console.error(`❌ IVFree HTTPエラー: ${error.response.status} ${error.response.statusText}`);
    }
    if (error.code) {
      console.error(`❌ IVFree エラーコード: ${error.code}`);
    }
    if (error.stack) {
      console.error('❌ IVFree スタックトレース:', error.stack.substring(0, 500));
    }
    // エラーが発生しても空の配列を返す（他の検索に影響を与えない）
    return [];
  }
}

// Jable.TV検索
async function searchJable(query) {
  try {
    const encodedQuery = encodeURIComponent(query);
    // 複数のURLパターンを試す（空のクエリの場合はトップページや最新動画ページから取得）
    const urls = query && query.trim() ? [
      `https://jable.tv/search/${encodedQuery}`,
      `https://jable.tv/search?q=${encodedQuery}`,
      `https://jable.tv/?s=${encodedQuery}`,
      `https://jable.tv/videos/search/${encodedQuery}`
    ] : [
      `https://jable.tv/`, // トップページから最新動画を取得
      `https://jable.tv/videos`, // 動画一覧ページ
      `https://jable.tv/latest` // 最新動画ページ
    ];
    
    let videos = [];
    
    for (const url of urls) {
      try {
        const response = await axios.get(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'ja,en-US;q=0.9,zh-TW;q=0.8,zh-CN;q=0.7',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Referer': 'https://jable.tv/',
            'Accept-Encoding': 'gzip, deflate, br'
          },
          timeout: 30000,
          validateStatus: () => true
        });

        if (response.status === 403 && isCloudflareChallengeHtml(response.data)) {
          console.warn('⚠️ Jable: Cloudflare(403) を検出。r.jina.ai にフォールバックします。');
          const md = await fetchMarkdownViaJina(url);
          const jinaVideos = extractVideosFromJinaMarkdown(md, {
            source: 'jable',
            includeUrlSubstrings: ['jable.tv/videos/'],
            excludeUrlSubstrings: ['/categories', '/models', '/latest-updates', '/hot', '#'],
            max: 50
          });
          if (jinaVideos.length > 0) return jinaVideos;
          continue;
        }
        if (response.status >= 400) {
          console.warn(`⚠️ Jable: HTTP ${response.status}`);
          continue;
        }
        
        const $ = cheerio.load(response.data);
        
        // 複数のセレクタを試す
        const selectors = [
          '.video-item',
          '.item',
          'a[href*="/videos/"]',
          'a[href*="/video/"]',
          'a[href*="/watch/"]',
          'a[href*="/v/"]',
          '[class*="video"]',
          '[class*="item"]',
          '.result-item',
          '.search-result-item',
          'article',
          '[class*="card"]',
          '.post-item'
        ];
        
        const seenUrls = new Set();
        
        selectors.forEach(selector => {
          $(selector).each((index, elem) => {
            if (videos.length >= 50) return false;
            
            const $item = $(elem);
            let href = $item.attr('href') || $item.find('a').attr('href') || '';
            
            // hrefが見つからない場合は親要素を探す
            if (!href) {
              const $parent = $item.parent();
              href = $parent.attr('href') || $parent.find('a').attr('href') || '';
            }
            
            // Jable.TVの動画URLパターンを確認
            if (!href || (!href.includes('/videos/') && !href.includes('/video/') && !href.includes('/watch/') && !href.includes('/v/'))) return;
            
            // 相対URLを絶対URLに変換
            let fullUrl = href;
            if (href.startsWith('//')) {
              fullUrl = 'https:' + href;
            } else if (href.startsWith('/')) {
              fullUrl = `https://jable.tv${href}`;
            } else if (!href.startsWith('http')) {
              fullUrl = `https://jable.tv/${href}`;
            }
            
            // 重複チェック
            if (seenUrls.has(fullUrl)) return;
            seenUrls.add(fullUrl);
            
            const title = extractTitle($, $item);
            const thumbnail = extractThumbnail($, $item);
            const duration = extractDurationFromHtml($, $item);
            
            if (title && title.length > 3) {
              videos.push({
                id: `jable-${Date.now()}-${index}`,
                title: title.substring(0, 200),
                thumbnail: thumbnail || '',
                duration: duration || '',
                url: fullUrl,
                embedUrl: fullUrl,
                source: 'jable'
              });
            }
          });
        });
        
        // 結果が見つかったらループを抜ける
        if (videos.length > 0) break;
      } catch (urlError) {
        if (urlError.response && urlError.response.status === 403 && isCloudflareChallengeHtml(urlError.response.data)) {
          try {
            console.warn('⚠️ Jable: Cloudflare(403) を検出（例外）。r.jina.ai にフォールバックします。');
            const md = await fetchMarkdownViaJina(url);
            const jinaVideos = extractVideosFromJinaMarkdown(md, {
              source: 'jable',
              includeUrlSubstrings: ['jable.tv/videos/'],
              excludeUrlSubstrings: ['/categories', '/models', '/latest-updates', '/hot', '#'],
              max: 50
            });
            if (jinaVideos.length > 0) return jinaVideos;
          } catch (_) {}
        }
        console.warn(`⚠️ Jable.TV URL試行エラー (${url}):`, urlError.message);
        continue;
      }
    }
    
    console.log(`✅ Jable.TV: ${videos.length}件の動画を取得`);
    return videos;
  } catch (error) {
    if (error.response && error.response.status === 404) {
      console.warn('⚠️ Jable.TV検索: ページが見つかりません（404）');
    } else {
      console.error('❌ Jable.TV検索エラー:', error.message);
    }
    return [];
  }
}

// Airav検索（airav.io/cn）
async function searchAirav(query, strictMode = true) {
  try {
    console.log(`🔍 Airav検索開始: "${query}" (strictMode: ${strictMode})`);
    const encodedQuery = encodeURIComponent(query);
    
    // 複数のURLパターンを試す（空のクエリの場合はトップページや最新動画ページから取得）
    const urls = query && query.trim() ? [
      `https://airav.io/cn/search?q=${encodedQuery}`,
      `https://airav.io/cn/search/${encodedQuery}`,
      `https://airav.io/cn/videos/search?q=${encodedQuery}`,
      `https://airav.io/cn/?s=${encodedQuery}`
    ] : [
      `https://airav.io/cn/`, // トップページから最新動画を取得
      `https://airav.io/cn/videos`, // 動画一覧ページ
      `https://airav.io/cn/latest` // 最新動画ページ
    ];
    
    let videos = [];
    
    for (const url of urls) {
      try {
        const response = await axios.get(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Referer': 'https://airav.io/cn/',
            'Accept-Encoding': 'gzip, deflate, br'
          },
          timeout: 30000,
          maxRedirects: 5,
          validateStatus: () => true
        });

        if (response.status === 403 && isCloudflareChallengeHtml(response.data)) {
          console.warn('⚠️ Airav: Cloudflare(403) を検出。r.jina.ai にフォールバックします。');
          const md = await fetchMarkdownViaJina(url);
          const jinaVideos = extractVideosFromJinaMarkdown(md, {
            source: 'airav',
            includeUrlSubstrings: ['airav.io/cn/video'],
            excludeUrlSubstrings: ['/cn/search', '/cn/videos', '#'],
            max: 50
          });
          if (jinaVideos.length > 0) return jinaVideos;
          continue;
        }
        if (response.status >= 400) {
          console.warn(`⚠️ Airav: HTTP ${response.status}`);
          continue;
        }
        
        const $ = cheerio.load(response.data);
        
        // 複数のセレクタを試す
        const selectors = [
          '.video-item',
          '.item',
          'a[href*="/videos/"]',
          'a[href*="/video/"]',
          'a[href*="/watch/"]',
          'a[href*="/v/"]',
          '[class*="video"]',
          '[class*="item"]',
          '.result-item',
          '.search-result-item',
          'article',
          '[class*="card"]',
          '.post-item'
        ];
        
        const seenUrls = new Set();
        
        selectors.forEach(selector => {
          $(selector).each((index, elem) => {
            if (videos.length >= 50) return false;
            
            const $item = $(elem);
            let href = $item.attr('href') || $item.find('a').attr('href') || '';
            
            // hrefが見つからない場合は親要素を探す
            if (!href) {
              const $parent = $item.parent();
              href = $parent.attr('href') || $parent.find('a').attr('href') || '';
            }
            
            // Airavの動画URLパターンを確認
            if (!href || (!href.includes('/videos/') && !href.includes('/video/') && !href.includes('/watch/') && !href.includes('/v/'))) return;
            
            // 相対URLを絶対URLに変換
            let fullUrl = href;
            if (href.startsWith('//')) {
              fullUrl = 'https:' + href;
            } else if (href.startsWith('/')) {
              fullUrl = `https://airav.io${href}`;
            } else if (!href.startsWith('http')) {
              fullUrl = `https://airav.io/${href}`;
            }
            
            // 重複チェック
            if (seenUrls.has(fullUrl)) return;
            seenUrls.add(fullUrl);
            
            const title = extractTitle($, $item);
            const thumbnail = extractThumbnail($, $item);
            const duration = extractDurationFromHtml($, $item);
            
            if (title && title.length > 3) {
              videos.push({
                id: `airav-${Date.now()}-${index}`,
                title: title.substring(0, 200),
                thumbnail: thumbnail || '',
                duration: duration || '',
                url: fullUrl,
                embedUrl: fullUrl,
                source: 'airav'
              });
            }
          });
        });
        
        // 結果が見つかったらループを抜ける
        if (videos.length > 0) break;
      } catch (urlError) {
        if (urlError.response && urlError.response.status === 403 && isCloudflareChallengeHtml(urlError.response.data)) {
          try {
            console.warn('⚠️ Airav: Cloudflare(403) を検出（例外）。r.jina.ai にフォールバックします。');
            const md = await fetchMarkdownViaJina(url);
            const jinaVideos = extractVideosFromJinaMarkdown(md, {
              source: 'airav',
              includeUrlSubstrings: ['airav.io/cn/video'],
              excludeUrlSubstrings: ['/cn/search', '/cn/videos', '#'],
              max: 50
            });
            if (jinaVideos.length > 0) return jinaVideos;
          } catch (_) {}
        }
        console.warn(`⚠️ Airav URL試行エラー (${url}):`, urlError.message);
        continue;
      }
    }
    
    console.log(`✅ Airav: ${videos.length}件の動画を取得`);
    return videos;
  } catch (error) {
    if (error.response && error.response.status === 404) {
      console.warn('⚠️ Airav検索: ページが見つかりません（404）');
    } else {
      console.error('❌ Airav検索エラー:', error.message);
    }
    return [];
  }
}

// 検索履歴を取得するAPI（このサイトを通して検索したワードを最新20個返す）
app.get('/api/recent-searches', async (req, res) => {
  try {
    console.log('📋 /api/recent-searches リクエスト受信');
    // キャッシュ付きで検索履歴を取得（高速化）
    const allSearches = await getRecentSearchesCached();
    
    // このサイトを通して検索したワードを最新20個返す
    // 自分の検索も他の人の検索も含めて、すべての検索ワードを履歴として表示
    // 検索ワードのみを返す（時間情報は不要）
    const searches = (allSearches || [])
      .slice(0, MAX_RECENT_SEARCHES) // 最新20件
      .map(entry => ({
        query: entry && entry.query ? entry.query : ''
      }))
      .filter(entry => entry.query && entry.query.trim().length > 0);
    
    console.log(`📋 検索履歴取得: ${searches.length}件 (全検索: ${allSearches ? allSearches.length : 0}件)`);
    if (searches.length > 0) {
      console.log(`📋 検索履歴サンプル: ${searches.slice(0, 3).map(s => s.query).join(', ')}`);
    }
    
    // キャッシュヘッダーを追加（クライアント側のキャッシュを有効化、高速化のため）
    res.set({
      'Cache-Control': 'public, max-age=10', // 10秒間キャッシュ（高速化のため延長）
      'ETag': `"${searches.length}-${Date.now()}"`, // ETagでキャッシュ検証
      'X-Content-Type-Options': 'nosniff' // セキュリティヘッダー
    });
    
    res.json({ searches: searches });
  } catch (error) {
    console.error('❌ 検索履歴取得エラー:', error);
    console.error('❌ スタックトレース:', error.stack);
    console.error('❌ エラー詳細:', {
      name: error.name,
      message: error.message,
      stack: error.stack ? error.stack.substring(0, 500) : 'No stack trace'
    });
    // エラーが発生した場合は空の配列を返す（サイトが動作し続けるように）
    res.status(200).json({ searches: [] });
  }
});

// 時間差を計算する関数
function getTimeAgo(timestamp) {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (seconds < 60) {
    return `${seconds}秒前`;
  } else if (minutes < 60) {
    return `${minutes}分前`;
  } else if (hours < 24) {
    return `${hours}時間前`;
  } else {
    const days = Math.floor(hours / 24);
    return `${days}日前`;
  }
}

// douga4動画ページから実際の動画URLを取得するエンドポイント
app.get('/api/douga4-video', async (req, res) => {
  try {
    const videoUrl = req.query.url;
    if (!videoUrl || !videoUrl.includes('douga4.top')) {
      return res.status(400).json({ error: 'douga4 URL is required' });
    }
    
    
    // デスクトップのUser-Agentでリクエスト
    const response = await axios.get(videoUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://av.douga4.top/',
        'Accept-Encoding': 'gzip, deflate, br'
      },
      timeout: 30000,
      maxRedirects: 5
    });
    
    const $ = cheerio.load(response.data);
    
    // 動画プレイヤーのiframeやvideo要素を探す
    let embedUrl = videoUrl; // デフォルトは元のURL
    
    // iframe要素を探す
    const iframe = $('iframe[src]').first();
    if (iframe.length > 0) {
      const iframeSrc = iframe.attr('src');
      if (iframeSrc) {
        embedUrl = iframeSrc.startsWith('http') ? iframeSrc : `https://av.douga4.top${iframeSrc}`;
      }
    }
    
    // video要素を探す
    const video = $('video source[src]').first();
    if (video.length > 0) {
      const videoSrc = video.attr('src');
      if (videoSrc) {
        embedUrl = videoSrc.startsWith('http') ? videoSrc : `https://av.douga4.top${videoSrc}`;
      }
    }
    
    // JavaScriptから動画URLを抽出（data属性など）
    const scriptTags = $('script').toArray();
    for (const script of scriptTags) {
      const scriptContent = $(script).html() || '';
      // 動画URLのパターンを探す
      const videoUrlMatch = scriptContent.match(/['"](https?:\/\/[^'"]*\.(mp4|m3u8|flv|webm)[^'"]*)['"]/i);
      if (videoUrlMatch) {
        embedUrl = videoUrlMatch[1];
        break;
      }
    }
    
    res.json({ embedUrl: embedUrl, originalUrl: videoUrl });
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve video URL', embedUrl: req.query.url });
  }
});

// JPdmv動画ページから実際の埋め込みURLを取得するエンドポイント
app.get('/api/jpdmv-video', async (req, res) => {
  try {
    const videoUrl = req.query.url;
    if (!videoUrl || !String(videoUrl).includes('jpdmv.com')) {
      return res.status(400).json({ error: 'JPdmv URL is required' });
    }

    console.log('📺 JPdmv動画URL取得リクエスト:', videoUrl);
    
    const extractEmbedFromMarkdown = (markdown) => {
      const md = String(markdown || '');
      const urls = md.match(/https?:\/\/[^\s)]+/g) || [];
      const preferred = [
        'ytms.one/e/',
        '/embed/',
        '/player/',
        '/e/'
      ];
      for (const key of preferred) {
        const hit = urls.find((u) => u.includes(key));
        if (hit) return hit.replace(/[)\]]+$/, '');
      }
      return '';
    };

    const response = await axios.get(videoUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://jpdmv.com/',
        'Accept-Encoding': 'gzip, deflate, br'
      },
      timeout: 30000,
      maxRedirects: 5,
      validateStatus: () => true
    });

    if (response.status === 403 && isCloudflareChallengeHtml(response.data)) {
      console.warn('⚠️ JPdmv動画URL取得: Cloudflare(403) を検出。r.jina.ai でフォールバックします。');
      try {
        const md = await fetchMarkdownViaJina(videoUrl);
        const embedFromMd = extractEmbedFromMarkdown(md);
        if (embedFromMd) {
          console.log('✅ JPdmv動画URL取得(Jina):', embedFromMd);
          return res.json({ embedUrl: embedFromMd, originalUrl: videoUrl });
        }
      } catch (e) {
        console.warn('⚠️ JPdmv動画URL取得(Jina) エラー:', e.message);
      }
      return res.json({ embedUrl: videoUrl, originalUrl: videoUrl });
    }
    if (response.status >= 400) {
      console.warn(`⚠️ JPdmv動画URL取得: HTTP ${response.status}`);
      try {
        const md = await fetchMarkdownViaJina(videoUrl);
        const embedFromMd = extractEmbedFromMarkdown(md);
        if (embedFromMd) {
          console.log('✅ JPdmv動画URL取得(Jina):', embedFromMd);
          return res.json({ embedUrl: embedFromMd, originalUrl: videoUrl });
        }
      } catch (_) {}
      return res.json({ embedUrl: videoUrl, originalUrl: videoUrl });
    }

    const $ = cheerio.load(response.data);

    let embedUrl = '';
    const iframeCandidates = $('iframe[src]').toArray();
    for (const el of iframeCandidates) {
      const src = $(el).attr('src') || '';
      if (!src) continue;
      const full = src.startsWith('http') ? src : new URL(src, videoUrl).toString();

      const lower = full.toLowerCase();
      const looksLikePlayer =
        lower.includes('embed') ||
        lower.includes('player') ||
        lower.includes('video') ||
        lower.includes('stream');
      const looksLikeAd =
        lower.includes('doubleclick') ||
        lower.includes('googlesyndication') ||
        lower.includes('ads') ||
        lower.includes('analytics');
      if (looksLikeAd) continue;
      if (looksLikePlayer) {
        embedUrl = full;
        break;
      }
      if (!embedUrl) embedUrl = full;
    }

    if (!embedUrl) {
      const videoSrc = $('video source[src]').first().attr('src');
      if (videoSrc) {
        embedUrl = videoSrc.startsWith('http') ? videoSrc : new URL(videoSrc, videoUrl).toString();
      }
    }

    if (!embedUrl) {
      const scriptTags = $('script').toArray();
      for (const script of scriptTags) {
        const scriptContent = $(script).html() || '';
        const mp4Match = scriptContent.match(/['"](https?:\/\/[^'"]*\.(mp4|m3u8)(\?[^'"]*)?)['"]/i);
        if (mp4Match) {
          embedUrl = mp4Match[1];
          break;
        }
        const iframeMatch = scriptContent.match(/<iframe[^>]+src=['"]([^'"]+)['"]/i);
        if (iframeMatch) {
          const src = iframeMatch[1];
          embedUrl = src.startsWith('http') ? src : new URL(src, videoUrl).toString();
          break;
        }
      }
    }

    if (!embedUrl) embedUrl = videoUrl;

    console.log('✅ JPdmv動画URL取得:', embedUrl);
    res.json({ embedUrl, originalUrl: videoUrl });
  } catch (error) {
    console.error('❌ JPdmv動画URL取得エラー:', error.message);
    res.status(500).json({ error: 'Failed to retrieve video URL', embedUrl: req.query.url });
  }
});

// VMEDAフィルター: IVFree動画URL取得（embed URL を広告除去パイプ経由で取得）
app.get('/api/ivfree-video', async (req, res) => {
  try {
    const videoUrl = req.query.url;
    if (!videoUrl || !videoUrl.includes('ivfree.asia')) {
      return res.status(400).json({ error: 'IVFree URL is required' });
    }
    
    console.log('📺 IVFree動画URL取得リクエスト:', videoUrl);
    
    // デスクトップのUser-Agentでリクエスト
    const response = await axios.get(videoUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'http://ivfree.asia/',
        'Accept-Encoding': 'gzip, deflate, br'
      },
      timeout: 30000,
      maxRedirects: 5
    });
    
    const $ = cheerio.load(response.data);
    
    // ポップアップ広告を生成するスクリプトを除去（ただし、動画プレイヤーに必要なスクリプトは保持）
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
      
      // ポップアップ広告関連のスクリプトを除去
      if (
        (scriptContent.includes('window.open') && !scriptContent.includes('video') && !scriptContent.includes('player')) ||
        (scriptContent.includes('popup') && !scriptContent.includes('video') && !scriptContent.includes('player')) ||
        scriptContent.includes('popunder') ||
        (scriptContent.includes('advertisement') && !scriptContent.includes('video') && !scriptContent.includes('player')) ||
        scriptContent.includes('adsbygoogle') ||
        scriptContent.includes('googlesyndication') ||
        scriptContent.includes('doubleclick') ||
        (scriptContent.includes('advertising') && !scriptContent.includes('video'))
      ) {
        $(elem).remove();
      }
    });
    
    // ポップアップ広告を生成するaタグを除去
    $('a[onclick*="window.open"], a[onclick*="popup"], a[target="_blank"][href*="ad"]').remove();
    
    // 動画プレイヤーのiframeやvideo要素を探す
    let embedUrl = videoUrl; // デフォルトは元のURL
    let thumbnail = '';
    
    // iframe要素を探す
    const iframe = $('iframe[src]').first();
    if (iframe.length > 0) {
      const iframeSrc = iframe.attr('src');
      if (iframeSrc) {
        embedUrl = iframeSrc.startsWith('http') ? iframeSrc : `http://ivfree.asia${iframeSrc}`;
      }
    }
    
    // video要素を探す
    const video = $('video source[src]').first();
    if (video.length > 0) {
      const videoSrc = video.attr('src');
      if (videoSrc) {
        embedUrl = videoSrc.startsWith('http') ? videoSrc : `http://ivfree.asia${videoSrc}`;
      }
    }
    
    // JavaScriptから動画URLを抽出（data属性など）
    const scriptTags = $('script').toArray();
    for (const script of scriptTags) {
      const scriptContent = $(script).html() || '';
      // 動画URLのパターンを探す
      const videoUrlMatch = scriptContent.match(/['"](https?:\/\/[^'"]*\.(mp4|m3u8|flv|webm)[^'"]*)['"]/i);
      if (videoUrlMatch) {
        embedUrl = videoUrlMatch[1];
        break;
      }
    }
    
    // サムネイルを取得
    thumbnail = extractThumbnail($, $('body'));
    if (!thumbnail) {
      // og:imageを探す
      thumbnail = $('meta[property="og:image"]').attr('content') || '';
    }
    
    console.log('✅ IVFree動画URL取得:', embedUrl);
    res.json({ embedUrl: embedUrl, originalUrl: videoUrl, thumbnail: thumbnail });
  } catch (error) {
    console.error('❌ IVFree動画URL取得エラー:', error.message);
    res.status(500).json({ error: 'Failed to retrieve video URL', embedUrl: req.query.url });
  }
});

// VMEDA ivfree-proxy（api/lib に分離）
const ivfreeProxy = require('./lib/ivfree-proxy');
ivfreeProxy.register(app);

// 動画プロキシエンドポイント（iPhoneでデスクトップに偽装）

// 動画プロキシエンドポイント（iPhoneでデスクトップに偽装）
app.get('/api/proxy-video', async (req, res) => {
  try {
    let videoUrl = req.query.url;
    if (!videoUrl) {
      return res.status(400).json({ error: 'URL parameter is required' });
    }
    // 二重エンコードを解消（1回デコードしてから使用）
    try {
      videoUrl = decodeURIComponent(String(videoUrl));
    } catch (e) { /* そのまま使用 */ }
    
    console.log('📺 動画プロキシリクエスト:', videoUrl);
    
    // デスクトップのUser-Agentでリクエスト
    const response = await axios.get(videoUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': videoUrl,
        'Accept-Encoding': 'identity'
      },
      timeout: 30000,
      maxRedirects: 5,
      responseType: 'arraybuffer'
    });

    const contentType = String(response.headers['content-type'] || '');
    const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml+xml');

    if (isHtml) {
      const origin = (() => {
        try {
          return new URL(String(videoUrl)).origin + '/';
        } catch {
          return '';
        }
      })();

      let html = Buffer.from(response.data || []).toString('utf8');
      if (origin && !/<base\s+/i.test(html)) {
        if (/<head[^>]*>/i.test(html)) {
          html = html.replace(/<head([^>]*)>/i, (m) => `${m}<base href="${origin}">`);
        } else if (/<html[^>]*>/i.test(html)) {
          html = html.replace(/<html([^>]*)>/i, (m) => `${m}<head><base href="${origin}"></head>`);
        } else {
          html = `<head><base href="${origin}"></head>\n` + html;
        }
      }

      res.set({
        'Content-Type': contentType || 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
        'X-Frame-Options': 'SAMEORIGIN',
        'X-Content-Type-Options': 'nosniff'
      });

      return res.send(html);
    }

    res.set({
      'Content-Type': contentType || 'application/octet-stream',
      'Cache-Control': 'public, max-age=3600',
      'X-Frame-Options': 'SAMEORIGIN',
      'X-Content-Type-Options': 'nosniff'
    });

    res.send(response.data);
  } catch (error) {
    console.error('❌ 動画プロキシエラー:', error.message);
    res.status(500).json({ error: 'Failed to retrieve video' });
  }
});

// JPdmv動画ページをiframeで表示するためのプロキシ
app.get('/api/jpdmv-proxy', async (req, res) => {
  try {
    let videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).json({ error: 'URL is required' });
    // 二重エンコードを解消（1回デコードしてから使用）
    try {
      videoUrl = decodeURIComponent(String(videoUrl));
    } catch (e) { /* そのまま使用 */ }

    const isJpdmvUrl = String(videoUrl).includes('jpdmv.com');
    if (!isJpdmvUrl) return res.status(400).json({ error: 'JPdmv URL is required' });

    console.log('📺 JPdmv動画ページをプロキシ経由で取得:', videoUrl);

    const response = await axios.get(videoUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://jpdmv.com/',
        'Accept-Encoding': 'gzip, deflate, br'
      },
      timeout: 30000,
      maxRedirects: 5,
      responseType: 'arraybuffer',
      validateStatus: () => true
    });

    if (response.status >= 400) {
      return res
        .status(502)
        .type('text/html')
        .send(`<html><head><meta charset="utf-8"></head><body><h1>JPdmv プロキシエラー</h1><p>HTTP ${response.status}</p><p><a href="${videoUrl}" target="_blank" rel="noreferrer">元のページを開く</a></p></body></html>`);
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', response.headers['content-type'] || 'text/html; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');

    res.send(response.data);
  } catch (error) {
    console.error('❌ JPdmvプロキシエラー:', error.message);
    res
      .status(500)
      .type('text/html')
      .send(`<html><head><meta charset="utf-8"></head><body><h1>JPdmv プロキシエラー</h1><p>${error.message}</p><p><a href="${req.query.url}" target="_blank" rel="noreferrer">元のページを開く</a></p></body></html>`);
  }
});

// ルートパス - index.htmlを返す（Vercel対応）
app.get('/', (req, res) => {
  try {
    console.log('🏠 ルートパス リクエスト受信');
    const userAgent = req.get('user-agent') || '';
    const isMobile = /iPhone|iPad|iPod|Android/i.test(userAgent);
    console.log(`📱 デバイス: ${isMobile ? 'Mobile' : 'Desktop'} - ${userAgent.substring(0, 80)}`);
    
    // Vercel環境では、静的ファイルは自動的に配信される
    // ただし、明示的にルートパスをハンドリングする必要がある場合がある
    // __dirnameが正しく動作しない場合に備えて、複数のパスを試す
    let indexPath;
    
    // パス解決の優先順位: process.cwd() > __dirname
    const possiblePaths = [
      path.join(process.cwd(), 'public', 'index.html'),
      path.join(__dirname, 'public', 'index.html'),
      path.join(process.cwd(), 'index.html'),
      path.join(__dirname, 'index.html')
    ];
    
    // 最初に見つかったパスを使用
    indexPath = possiblePaths.find(p => {
      try {
        return fs.existsSync && fs.existsSync(p);
      } catch {
        return false;
      }
    });
    
    if (!indexPath) {
      // パスが見つからない場合は、最初のパスを使用（エラーハンドリングで処理）
      indexPath = possiblePaths[0];
    }
    
    console.log('📄 index.htmlパス:', indexPath);
    
    // ファイルの送信を試みる
    res.sendFile(indexPath, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache'
      }
    }, (err) => {
      if (err) {
        console.error('❌ index.html送信エラー:', err.message);
        console.error('❌ 試したパス:', indexPath);
        // エラーが発生した場合は、HTMLコンテンツを直接返す
        if (!res.headersSent) {
          res.status(200).type('text/html').send(`
            <!DOCTYPE html>
            <html lang="ja">
            <head>
              <meta charset="UTF-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <title>VMEDA - 動画検索サイト</title>
              <link rel="stylesheet" href="/styles.css">
            </head>
            <body>
              <div class="container">
                <header class="header">
                  <h1 class="site-title">VMEDA</h1>
                </header>
                <section class="search-section">
                  <div class="search-container">
                    <input type="text" id="search-input" class="search-input" placeholder="動画を検索..." autocomplete="off">
                    <button id="search-button" class="search-button">検索</button>
                  </div>
                </section>
                <div id="results-container"></div>
                <div id="video-player-container"></div>
              </div>
              <script src="/app.js"></script>
            </body>
            </html>
          `);
        }
      } else {
        console.log('✅ index.html送信成功:', indexPath);
      }
    });
  } catch (error) {
    console.error('❌ ルートパス処理エラー:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }
});

// Mat6tube検索（アプローチ変更：より積極的に動画を取得）
async function searchMat6tube(query, strictMode = true) {
  try {
    // クエリがnull/undefinedの場合は空文字列に変換
    query = query || '';
    console.log(`🔍 Mat6tube検索開始: "${query}" (strictMode: ${strictMode})`);
    
    // 空のクエリの場合は、トップページや最新動画ページから動画を取得
    const encodedQuery = query ? encodeURIComponent(query) : '';
    const urls = (!query || query.trim().length === 0) ? [
      // mat6tube はトップ/最新がJSレンダリングで空になりやすい。
      // /search?q=... がHTTP 404でも本文に動画リンクが含まれることがあるため、まずここを試す。
      'https://mat6tube.com/search?q=1',
      'https://mat6tube.com/search?q=a',
      'https://mat6tube.com/', // トップページ
      'https://mat6tube.com/recent', // /recentページ
      'https://mat6tube.com/video/', // /video/パス
      'https://mat6tube.com/latest' // 最新動画ページ（存在しない場合あり）
    ] : [
      `https://mat6tube.com/video/${encodedQuery}`, // 最優先：/video/パスで検索
      `https://mat6tube.com/video/${query}`, // エンコードなしも試す
      `https://mat6tube.com/video/`, // /video/パスで全動画を取得（クエリに関係なく）
      `https://mat6tube.com/recent` // /recentページは検索クエリなしで最新動画を取得
    ];
    
    let videos = [];
    const seenUrls = new Set(); // すべてのURLで共有する重複チェック用Set
    
    for (const url of urls) {
      try {
        console.log(`🔍 Mat6tube: URL試行: ${url}`);
        const response = await axios.get(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Referer': 'https://mat6tube.com/',
            'Accept-Encoding': 'gzip, deflate, br'
          },
          timeout: 30000,
          validateStatus: () => true
        });
        
        console.log(`🔍 Mat6tube: HTTPステータス: ${response.status}, HTMLサイズ: ${response.data.length} bytes`);
        const $ = cheerio.load(response.data);
        console.log(`🔍 Mat6tube: HTML取得完了、パース開始 (HTMLサイズ: ${response.data.length} bytes)`);
        
        // /video/パスで検索した場合の特別処理
        // /video/パスが含まれている場合は、すべての/video/リンクを取得
        const isVideoPathSearch = url.includes('/video/');
        
        // /video/パスで検索した場合、すべての/video/リンクを優先的に取得
        // /video/パスで検索した場合、すべての/video/リンクを直接取得（最優先処理）
        if (isVideoPathSearch) {
          console.log(`🔍 Mat6tube: /video/パス検索を検出、すべての/video/リンクを直接取得します`);
          const videoLinks = $('a[href*="/video/"]');
          console.log(`🔍 Mat6tube: /video/リンク数: ${videoLinks.length}`);
          
          videoLinks.each((index, elem) => {
            // 制限なしで全件取得
            
            const $link = $(elem);
            let href = $link.attr('href') || '';
            
            if (!href) return;
            
            // 相対URLを絶対URLに変換
            if (href.startsWith('//')) {
              href = 'https:' + href;
            } else if (href.startsWith('/')) {
              href = `https://mat6tube.com${href}`;
            } else if (!href.startsWith('http')) {
              href = `https://mat6tube.com/${href}`;
            }
            
            // /video/パスを含むリンクのみ
            if (!href.includes('/video/')) return;
            if (seenUrls.has(href)) return;
            
            // /video/パスで検索した場合、検索ページ自体（/video/fc2など）は除外
            // ただし、/video/xxx/yyy のような3段階以上のパスは動画ページとして扱う
            const videoPathMatch = href.match(/mat6tube\.com\/video\/([^\/]+)$/);
            if (videoPathMatch) {
              const pathSegment = decodeURIComponent(videoPathMatch[1]);
              // 検索クエリと一致する単一パス（/video/fc2など）は検索ページなので除外
              if (pathSegment.toLowerCase() === query.toLowerCase() || pathSegment.toLowerCase() === encodedQuery.toLowerCase()) {
                return;
              }
            }
            
            seenUrls.add(href);
            matchedCount++;
            
            const title = $link.text().trim() || $link.attr('title') || extractTitle($, $link) || '';
            const thumbnail = extractThumbnail($, $link);
            const duration = extractDurationFromHtml($, $link);
            
            // 空のクエリの場合は関連性チェックを完全にスキップ
            // /video/パスで検索した場合、タイトルがあれば基本的に追加（より積極的に）
            // タイトルが空でも、URLが有効な場合は追加
            if (title && title.length > 2) { // 2文字以上に緩和
              // 空のクエリの場合は関連性チェックをスキップ
              if (query && query.trim() && strictMode) {
                if (!isTitleRelevant(title, query, strictMode)) {
                  return; // 関連性がない場合はスキップ
                }
              }
              
              videos.push({
                id: `mat6tube-${Date.now()}-${index}`,
                title: title.substring(0, 200),
                thumbnail: thumbnail || '',
                duration: duration || '',
                url: href,
                embedUrl: href,
                source: 'mat6tube'
              });
            } else if (href && href.includes('/video/') && !href.match(/mat6tube\.com\/video\/[^\/]+$/)) {
              // タイトルがなくても、/video/パスで3段階以上のパス（動画ページ）の場合は追加
              const fallbackTitle = href.match(/\/video\/([^\/]+)/)?.[1] || '動画';
              videos.push({
                id: `mat6tube-${Date.now()}-${index}`,
                title: fallbackTitle.substring(0, 200),
                thumbnail: thumbnail || '',
                duration: duration || '',
                url: href,
                embedUrl: href,
                source: 'mat6tube'
              });
            }
          });
          
          console.log(`🔍 Mat6tube: /video/パス検索で${videos.length}件の動画を取得（URL: ${url}）`);
          // /video/パス検索の結果は既にvideosに追加されているので、
          // 通常のセレクタベースの検索も続行して、より多くの結果を取得
        }
        
        // Mat6tubeの実際のHTML構造に基づくセレクタ（/video/ページに対応）
        const selectors = [
          // /video/ページの動画リンク（最優先）
          'a[href*="/video/"]',
          'a[href^="/video/"]',
          // その他の動画リンクのパターン
          'a[href*="/watch/"]',
          'a[href*="/v/"]',
          'a[href*="/play/"]',
          'a[href*="/movie/"]',
          'a[href*="/embed/"]',
          'a[href*="/view/"]',
          'a[href*="/detail/"]',
          'a[href*="/p/"]',
          // クラスベースのセレクタ
          '.video-item',
          '.item',
          '.video-card',
          '.card',
          '.post',
          '.entry',
          '.article',
          '[class*="video"]',
          '[class*="item"]',
          '[class*="card"]',
          '[class*="post"]',
          '[class*="entry"]',
          // 検索結果用のセレクタ
          '.result-item',
          '.search-result-item',
          '.search-result',
          // 汎用的なセレクタ（より広範囲）
          'article',
          'article a',
          'li a',
          'div a',
          '.content a',
          '.main a',
          '.container a',
          '.wrapper a',
          // すべてのリンク（最後の手段）
          'a[href*="mat6tube.com"]'
        ];
        let foundCount = 0;
        let matchedCount = 0;
        
        // HTML構造のデバッグ（最初のURLのみ）
        if (urls.indexOf(url) === 0) {
          const sampleLinks = $('a[href*="mat6tube"]').slice(0, 5);
          console.log(`🔍 Mat6tube: サンプルリンク数: ${sampleLinks.length}`);
          sampleLinks.each((i, elem) => {
            const href = $(elem).attr('href');
            if (href) {
              console.log(`🔍 Mat6tube: サンプルリンク ${i + 1}: ${href.substring(0, 100)}`);
            }
          });
        }
        
        selectors.forEach(selector => {
          $(selector).each((index, elem) => {
            // 制限を削除して全件取得
            
            foundCount++;
            
            const $item = $(elem);
            let href = $item.attr('href') || $item.find('a').attr('href') || '';
            
            // hrefが見つからない場合は親要素を探す
            if (!href) {
              const $parent = $item.parent();
              href = $parent.attr('href') || $parent.find('a').attr('href') || '';
            }
            
            // さらに上の親要素から探す
            if (!href) {
              const $grandParent = $item.parent().parent();
              href = $grandParent.attr('href') || $grandParent.find('a').attr('href') || '';
            }
            
            // Mat6tubeの動画URLパターンを確認（より柔軟に）
            // mat6tube.comのドメイン内のリンクで、動画らしいURLパターンを含むもの
            if (!href) return;
            
            // より広範囲なURLパターンを許可（/video/パスを最優先）
            const isMat6tubeUrl = href.includes('mat6tube.com') || href.startsWith('/');
            const excludePatterns = ['/category/', '/tag/', '/author/', '/page/', '/search', '/login', '/register', '/contact', '/about', '/privacy', '/terms', '/sitemap', '.jpg', '.png', '.gif', '.css', '.js', '#', 'mailto:', 'javascript:', '/feed', '/rss'];
            const hasExcludePattern = excludePatterns.some(pattern => href.includes(pattern));
            
            // /video/パスを最優先で認識
            const hasVideoPattern = href.includes('/video/') || 
                                   href.includes('/watch/') || 
                                   href.includes('/v/') || 
                                   href.includes('/play/') || 
                                   href.includes('/movie/') || 
                                   href.includes('/embed/') ||
                                   href.includes('/view/') ||
                                   href.includes('/detail/') ||
                                   href.includes('/p/') ||
                                   (href.includes('mat6tube.com') && !hasExcludePattern && href.match(/\/[^\/]+\/[^\/]+/)); // パスが2段階以上ある
            
            if (!isMat6tubeUrl || !hasVideoPattern) {
              return;
            }
            
            matchedCount++;
            
            // 相対URLを絶対URLに変換
            let fullUrl = href;
            if (href.startsWith('//')) {
              fullUrl = 'https:' + href;
            } else if (href.startsWith('/')) {
              fullUrl = `https://mat6tube.com${href}`;
            } else if (!href.startsWith('http')) {
              fullUrl = `https://mat6tube.com/${href}`;
            }
            
            // 重複チェック
            if (seenUrls.has(fullUrl)) return;
            seenUrls.add(fullUrl);
            
            const title = extractTitle($, $item);
            const thumbnail = extractThumbnail($, $item);
            const duration = extractDurationFromHtml($, $item);
            
            if (title && title.length > 2) { // 2文字以上に緩和
              // 空のクエリの場合は関連性チェックを完全にスキップ
              if (query && query.trim()) {
                // /recentページの場合は、検索クエリとの関連性チェックをスキップ（最新動画を取得）
                const isRecentPage = url.includes('/recent') && !url.includes('?q=');
                
                // より積極的なアプローチ：strictMode=falseの場合は関連性チェックを大幅に緩和
                if (!isRecentPage && strictMode) {
                  // 厳格モードの場合のみ関連性チェック
                  if (!isTitleRelevant(title, query, strictMode)) {
                    return; // 関連性がない場合はスキップ
                  }
                }
              }
              // 空のクエリまたはstrictMode=falseの場合は、タイトルがあれば基本的に追加（より積極的に）
              
              videos.push({
                id: `mat6tube-${Date.now()}-${index}`,
                title: title.substring(0, 200),
                thumbnail: thumbnail || '',
                duration: duration || '',
                url: fullUrl,
                embedUrl: fullUrl,
                source: 'mat6tube'
              });
            }
          });
        });
        
        // アプローチ2: セレクタで見つからない場合、すべてのmat6tube.comリンクを直接確認
        // 常にすべてのリンクを確認（videos.length === 0の条件を削除）
        console.log(`🔍 Mat6tube: すべてのリンクを直接確認します`);
        const allLinks = $('a[href]');
        console.log(`🔍 Mat6tube: 見つかったリンク総数: ${allLinks.length}`);
        
        allLinks.each((index, elem) => {
          // 制限を削除して全件取得
          
          const $link = $(elem);
            let href = $link.attr('href') || '';
            
            if (!href) return;
            
            // 相対URLを絶対URLに変換
            if (href.startsWith('//')) {
              href = 'https:' + href;
            } else if (href.startsWith('/')) {
              href = `https://mat6tube.com${href}`;
            } else if (!href.startsWith('http')) {
              href = `https://mat6tube.com/${href}`;
            }
            
            // mat6tube.comのリンクで、除外パターンがないものを確認
            if (!href.includes('mat6tube.com')) return;
            
            const excludePatterns = ['/category/', '/tag/', '/author/', '/page/', '/search', '/login', '/register', '/contact', '/about', '/privacy', '/terms', '/sitemap', '.jpg', '.png', '.gif', '.css', '.js', '#', 'mailto:', 'javascript:', '/feed', '/rss'];
            const hasExcludePattern = excludePatterns.some(pattern => href.includes(pattern));
            
            if (hasExcludePattern) return;
            if (seenUrls.has(href)) return;
            
            // パスが2段階以上ある、または動画らしいパターンを含む
            const pathMatch = href.match(/mat6tube\.com\/([^\/]+\/[^\/]+)/);
            const hasVideoPattern = href.includes('/video/') || 
                                   href.includes('/watch/') || 
                                   href.includes('/v/') || 
                                   href.includes('/play/') || 
                                   href.includes('/movie/') ||
                                   pathMatch;
            
            if (!hasVideoPattern) return;
            
            seenUrls.add(href);
            matchedCount++;
            
            const title = $link.text().trim() || $link.attr('title') || extractTitle($, $link) || '';
            const thumbnail = extractThumbnail($, $link);
            const duration = extractDurationFromHtml($, $link);
            
            if (title && title.length > 2) { // 2文字以上に緩和
              // 空のクエリの場合は関連性チェックを完全にスキップ
              if (query && query.trim() && strictMode) {
                if (!isTitleRelevant(title, query, strictMode)) {
                  return; // 関連性がない場合はスキップ
                }
              }
              // 空のクエリまたはstrictMode=falseの場合は、タイトルがあれば基本的に追加
              
              videos.push({
                id: `mat6tube-${Date.now()}-${index}`,
                title: title.substring(0, 200),
                thumbnail: thumbnail || '',
                duration: duration || '',
                url: href,
                embedUrl: href,
                source: 'mat6tube'
              });
            }
          });
        
        console.log(`🔍 Mat6tube: 見つかった要素: ${foundCount}件、マッチした要素: ${matchedCount}件、動画: ${videos.length}件`);
        
        // 結果が見つかったらループを抜ける
        if (videos.length > 0) {
          console.log(`✅ Mat6tube: ${videos.length}件の動画を取得（URL: ${url}）`);
          break;
        } else {
          console.log(`ℹ️ Mat6tube: このURLでは結果が見つかりませんでした（URL: ${url}）`);
        }
      } catch (urlError) {
        // 404や403エラーは予想される動作なので、警告を抑制（/search/パスは404が予想される）
        const urlIndex = urls.indexOf(url) + 1;
        const isSearchPath = url.includes('/search/');
        if (urlError.response && (urlError.response.status === 404 || urlError.response.status === 403)) {
          // /search/パスの404は予想されるので、ログを出さない
          if (!isSearchPath && urlIndex === 1) {
            console.log(`ℹ️ Mat6tube: 検索エンドポイントが見つかりません（${urlError.response.status}）。他のURLパターンを試行します。`);
          }
          // /search/パスの404は無視（既に削除したが、念のため）
        } else if (urlError.response) {
          console.warn(`⚠️ Mat6tube URL試行エラー (${url}): Request failed with status code ${urlError.response.status}`);
        } else {
          console.warn(`⚠️ Mat6tube URL試行エラー (${url}): ${urlError.message}`);
        }
        continue;
      }
    }
    
    console.log(`✅ Mat6tube: ${videos.length}件の動画を取得`);
    return videos;
  } catch (error) {
    if (error.response && error.response.status === 404) {
      console.warn('⚠️ Mat6tube検索: ページが見つかりません（404）');
    } else {
      console.error('❌ Mat6tube検索エラー:', error.message);
    }
    return [];
  }
}

// FC2Video.org検索
async function searchFC2Video(query, strictMode = true) {
  try {
    console.log(`🔍 FC2Video.org検索開始: "${query}" (strictMode: ${strictMode})`);
    
    // 空のクエリの場合は、ホームページから動画を取得
    const encodedQuery = query ? encodeURIComponent(query) : '';
    const urls = (!query || query.trim().length === 0) ? [
      'https://fc2video.org/',
      'https://fc2video.org/videos',
      'https://fc2video.org/recent'
    ] : [
      `https://fc2video.org/search?q=${encodedQuery}`,
      `https://fc2video.org/?q=${encodedQuery}`,
      `https://fc2video.org/search/${encodedQuery}`
    ];
    
    let videos = [];
    
    for (const url of urls) {
      try {
        const response = await axios.get(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Referer': 'https://fc2video.org/',
            'Accept-Encoding': 'gzip, deflate, br'
          },
          timeout: 30000,
          validateStatus: () => true
        });
        
        console.log(`🔍 FC2Video.org: HTTPステータス: ${response.status}, HTMLサイズ: ${response.data.length} bytes`);

        if (response.status === 403 && isCloudflareChallengeHtml(response.data)) {
          console.warn('⚠️ FC2Video.org: Cloudflare(403) を検出。r.jina.ai にフォールバックします。');
          const md = await fetchMarkdownViaJina(url);
          const jinaVideos = extractVideosFromJinaMarkdown(md, {
            source: 'fc2video',
            includeUrlSubstrings: ['fc2video.org/'],
            excludeUrlSubstrings: ['/all/', '/riben', '/youma', '/wuma', '/tags', '/category', '#'],
            max: 50
          });
          if (jinaVideos.length > 0) return jinaVideos;
          continue;
        }
        if (response.status >= 400) {
          console.warn(`⚠️ FC2Video.org: HTTP ${response.status}`);
          continue;
        }
        const $ = cheerio.load(response.data);
        console.log(`🔍 FC2Video.org: HTML取得完了、パース開始 (HTMLサイズ: ${response.data.length} bytes)`);
        
        // 複数のセレクタを試す（より広範囲に）
        const selectors = [
          'a[href*="/video/"]',
          'a[href*="/watch/"]',
          'a[href*="/v/"]',
          'a[href*="/play/"]',
          'a[href*="/movie/"]',
          'a[href*="/embed/"]',
          '.video-item',
          '.item',
          '[class*="video"]',
          '[class*="item"]',
          '.result-item',
          '.search-result-item',
          'article',
          '[class*="card"]',
          'div[class*="video"]',
          'div[class*="item"]',
          'li a',
          'div a'
        ];
        
        const seenUrls = new Set();
        let foundCount = 0;
        let matchedCount = 0;
        
        selectors.forEach(selector => {
          $(selector).each((index, elem) => {
            // 制限なしで全件取得
            
            foundCount++;
            
            const $item = $(elem);
            let href = $item.attr('href') || $item.find('a').attr('href') || '';
            
            // hrefが見つからない場合は親要素を探す
            if (!href) {
              const $parent = $item.parent();
              href = $parent.attr('href') || $parent.find('a').attr('href') || '';
            }
            
            // FC2Video.orgの動画URLパターンを確認（より柔軟に）
            // fc2video.orgのドメイン内のリンクで、動画らしいURLパターンを含むもの
            if (!href) return;
            const isFC2VideoUrl = href.includes('fc2video.org') || href.startsWith('/');
            const hasVideoPattern =
              href.includes('/video/') ||
              href.includes('/watch/') ||
              href.includes('/v/') ||
              href.includes('/play/') ||
              href.includes('/movie/') ||
              href.includes('/embed/') ||
              href.includes('PPV-') ||
              href.includes('PPV') ||
              /\.html($|\?)/i.test(href) || // /1234.html 形式
              /\/\d{3,}($|\/|\?)/.test(href); // /2257 など
            if (!isFC2VideoUrl || !hasVideoPattern) {
              return;
            }
            
            matchedCount++;
            
            // 相対URLを絶対URLに変換
            let fullUrl = href;
            if (href.startsWith('//')) {
              fullUrl = 'https:' + href;
            } else if (href.startsWith('/')) {
              fullUrl = `https://fc2video.org${href}`;
            } else if (!href.startsWith('http')) {
              fullUrl = `https://fc2video.org/${href}`;
            }
            
            // 重複チェック
            if (seenUrls.has(fullUrl)) return;
            seenUrls.add(fullUrl);
            
            const title = extractTitle($, $item);
            const thumbnail = extractThumbnail($, $item);
            const duration = extractDurationFromHtml($, $item);
            
            // タイトルが空の場合、URLからタイトルを抽出
            let finalTitle = title;
            if (!finalTitle || finalTitle.length < 3) {
              // URLからタイトルを抽出を試みる
              const urlMatch = fullUrl.match(/\/([^\/]+)$/);
              if (urlMatch) {
                finalTitle = decodeURIComponent(urlMatch[1]).replace(/[-_]/g, ' ').trim();
              }
              // それでもタイトルがない場合、リンクテキストを使用
              if (!finalTitle || finalTitle.length < 3) {
                finalTitle = $item.text().trim() || $item.find('a').text().trim() || '';
              }
            }
            
            // タイトルがあれば追加（より積極的に）
            if (finalTitle && finalTitle.length > 2) { // 2文字以上に緩和
              // 空のクエリの場合は関連性チェックをスキップ
              if (!query || query.trim().length === 0) {
                // 空のクエリの場合は、すべての動画を追加
                videos.push({
                  id: `fc2video-${Date.now()}-${index}`,
                  title: finalTitle.substring(0, 200),
                  thumbnail: thumbnail || '',
                  duration: duration || '',
                  url: fullUrl,
                  embedUrl: fullUrl,
                  source: 'fc2video'
                });
              } else {
                // 検索クエリとタイトルの関連性をチェック
                // strictMode=falseの場合は、関連性チェックを大幅に緩和またはスキップ
                if (strictMode) {
                  // 厳格モードの場合のみ関連性チェック
                  if (!isTitleRelevant(finalTitle, query, strictMode)) {
                    return; // 関連性がない場合はスキップ
                  }
                } else {
                  // 緩和モードの場合、タイトルがあれば基本的に追加（関連性チェックをスキップ）
                  // タイトルが1文字以下の場合のみスキップ
                  if (finalTitle.length < 2) {
                    return;
                  }
                }
                
                videos.push({
                  id: `fc2video-${Date.now()}-${index}`,
                  title: finalTitle.substring(0, 200),
                  thumbnail: thumbnail || '',
                  duration: duration || '',
                  url: fullUrl,
                  embedUrl: fullUrl,
                  source: 'fc2video'
                });
              }
            } else if (fullUrl && fullUrl.includes('fc2video.org')) {
              // タイトルがなくても、URLが有効な場合は追加（フォールバック）
              const fallbackTitle = fullUrl.match(/\/([^\/]+)$/)?.[1] || '動画';
              videos.push({
                id: `fc2video-${Date.now()}-${index}`,
                title: decodeURIComponent(fallbackTitle).replace(/[-_]/g, ' ').substring(0, 200),
                thumbnail: thumbnail || '',
                duration: duration || '',
                url: fullUrl,
                embedUrl: fullUrl,
                source: 'fc2video'
              });
            }
          });
        });
        
        console.log(`🔍 FC2Video.org: 見つかった要素: ${foundCount}件、マッチした要素: ${matchedCount}件、動画: ${videos.length}件`);
        
        // 結果が見つかったらループを抜ける
        if (videos.length > 0) {
          console.log(`✅ FC2Video.org: ${videos.length}件の動画を取得（URL: ${url}）`);
          break;
        } else {
          console.log(`ℹ️ FC2Video.org: このURLでは結果が見つかりませんでした（URL: ${url}）`);
        }
      } catch (urlError) {
        if (urlError.response && urlError.response.status === 403 && isCloudflareChallengeHtml(urlError.response.data)) {
          try {
            console.warn('⚠️ FC2Video.org: Cloudflare(403) を検出（例外）。r.jina.ai にフォールバックします。');
            const md = await fetchMarkdownViaJina(url);
            const jinaVideos = extractVideosFromJinaMarkdown(md, {
              source: 'fc2video',
              includeUrlSubstrings: ['fc2video.org/'],
              excludeUrlSubstrings: ['/all/', '/riben', '/youma', '/wuma', '/tags', '/category', '#'],
              max: 50
            });
            if (jinaVideos.length > 0) return jinaVideos;
          } catch (_) {}
        }
        // 404や403エラーは予想される動作なので、警告を抑制（最初のURLのみ情報を出力）
        const urlIndex = urls.indexOf(url) + 1;
        if (urlIndex === 1 && urlError.response && (urlError.response.status === 404 || urlError.response.status === 403)) {
          console.log(`ℹ️ FC2Video.org: 検索エンドポイントが見つかりません（${urlError.response.status}）。他のURLパターンを試行します。`);
        } else if (urlError.response) {
          console.warn(`⚠️ FC2Video.org URL試行エラー (${url}): Request failed with status code ${urlError.response.status}`);
        } else {
          console.warn(`⚠️ FC2Video.org URL試行エラー (${url}): ${urlError.message}`);
        }
        continue;
      }
    }
    
    console.log(`✅ FC2Video.org: ${videos.length}件の動画を取得`);
    return videos;
  } catch (error) {
    if (error.response && error.response.status === 404) {
      console.warn('⚠️ FC2Video.org検索: ページが見つかりません（404）');
    } else {
      console.error('❌ FC2Video.org検索エラー:', error.message);
    }
    return [];
  }
}

// VMEDA site-proxy / pizjav-proxy（api/lib に分離して Cursor 負荷軽減）
const siteProxy = require('./lib/site-proxy');
const pizjavProxy = require('./lib/pizjav-proxy');
siteProxy.register(app);
pizjavProxy.register(app);

// Vercel用にエクスポート
module.exports = app;
