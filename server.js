// 未処理例外時もプロセスを即終了させずログだけ出す（Cursor/開発時のクラッシュ軽減）
process.on('uncaughtException', (error) => {
  console.error('❌ 未処理の例外:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ 未処理のPromise拒否:', reason);
});

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

    // Markdownリンク抽出: ](URL)
    const linkMatches = [...line.matchAll(/\]\((https?:\/\/[^\s)]+)\)/g)];
    if (linkMatches.length === 0) continue;

    for (const m of linkMatches) {
      const url = m[1];
      if (!url) continue;

      if (excludeUrlSubstrings.some((x) => url.includes(x))) continue;
      if (includeUrlSubstrings.length > 0 && !includeUrlSubstrings.some((x) => url.includes(x))) continue;

      // 画像サムネ抽出（同一行に ![](thumb) がある場合）
      const thumbMatch = line.match(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/);
      const thumbnail = thumbMatch ? thumbMatch[1] : '';

      // タイトル抽出優先度:
      // 1) 画像のalt (Image 1: TITLE) 形式
      // 2) 直後の見出し(##### TITLE)
      // 3) 同一行のリンクテキスト（画像ではない場合）
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
        // [text](url) の text を拾う（画像リンクは除外）
        const textMatch = line.match(/\[([^\]]+)\]\(\s*https?:\/\/[^\s)]+\s*\)/);
        if (textMatch && !textMatch[1].startsWith('![')) {
          title = textMatch[1];
        }
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

  // 先頭から数個だけ試して、ヒットしたものを採用（処理時間を抑える）
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

  // 最後のフォールバック
  return { queryUsed: '', videos: await searchMat6tube('', false) };
}

const app = express();
const PORT = process.env.PORT || 3000;

// このサイトを通して検索したワードを保存（MongoDB Atlasに永続化、最新20個を保持）
// 重複を避けるため、同じ検索ワードは最新のもののみ残す
// 20個を超えると古いものから自動的に削除される
// 自分の検索も含めて、すべての検索ワードを履歴として残す
const MAX_RECENT_SEARCHES = 20; // 最新20個だけ保持

// MongoDB接続設定
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = 'vmeda';
const COLLECTION_NAME = 'recent_searches';
const ACCESS_LOG_COLLECTION_NAME = 'access_logs';

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

// ファイルシステムのフォールバック関数（Vercel KVが利用できない場合）
const SEARCHES_FILE = path.join(__dirname, 'data', 'recent-searches.json');

function loadRecentSearchesFromFile() {
  try {
    if (fs.existsSync(SEARCHES_FILE)) {
      const data = fs.readFileSync(SEARCHES_FILE, 'utf8');
      const searches = JSON.parse(data);
      console.log(`📂 検索履歴をファイルから読み込み: ${searches.length}件`);
      return Array.isArray(searches) ? searches : [];
    }
  } catch (error) {
    console.error('❌ 検索履歴の読み込みエラー:', error);
  }
  return [];
}

function saveRecentSearchesToFile(searches) {
  try {
    const dataDir = path.dirname(SEARCHES_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const searchesToSave = searches.slice(0, MAX_RECENT_SEARCHES);
    fs.writeFileSync(SEARCHES_FILE, JSON.stringify(searchesToSave, null, 2), 'utf8');
    console.log(`💾 検索履歴をファイルに保存: ${searchesToSave.length}件`);
  } catch (error) {
    console.error('❌ 検索履歴の保存エラー:', error);
  }
}

// サーバー起動時に検索履歴を読み込む（MongoDB優先）
let recentSearches = [];
(async () => {
  try {
    recentSearches = await loadRecentSearchesFromMongoDB();
  } catch (error) {
    console.error('❌ 初期化時の検索履歴読み込みエラー:', error.message);
    recentSearches = [];
  }
})();

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
    maxAge: '1d', // キャッシュ1日
    etag: true,
    setHeaders: (res, filePath) => {
      // 静的ファイルのMIMEタイプを明示的に設定
      if (filePath.endsWith('.js')) {
        res.setHeader('Content-Type', 'application/javascript');
      } else if (filePath.endsWith('.css')) {
        res.setHeader('Content-Type', 'text/css');
      } else if (filePath.endsWith('.html')) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
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
      'Cache-Control': 'no-cache, no-store, must-revalidate' // キャッシュを無効化
    }
  });
});

app.get('/styles.css', (req, res) => {
  console.log('📄 styles.css リクエスト受信');
  res.sendFile(path.join(__dirname, 'public', 'styles.css'), {
    headers: { 
      'Content-Type': 'text/css',
      'Cache-Control': 'public, max-age=86400'
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
    
    // クエリが複数単語の場合は、30%以上の単語がタイトルに含まれているかチェック（緩和）
    const matchingWords = queryWords.filter(word => titleLower.includes(word)).length;
    const minRequiredWords = Math.ceil(queryWords.length / 3); // 30%以上
    return matchingWords >= minRequiredWords;
  }
}

const SEARCH_SITE_TIMEOUT_MS = 12000;
const RELATED_SEARCH_RESULT_THRESHOLD = 12;

function normalizeCodeLikeText(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[_\s]+/g, '-')
    .replace(/[^A-Z0-9-]/g, '');
}

function extractCodeTokens(value) {
  return normalizeCodeLikeText(value).match(/[A-Z]{2,10}-[A-Z0-9]{2,12}/g) || [];
}

function getCodeSearchProfile(query) {
  const normalized = normalizeCodeLikeText(query);
  const code = extractCodeTokens(normalized)[0] || '';
  const prefix = code.includes('-') ? code.split('-')[0] : '';
  return {
    normalized,
    code,
    prefix,
    isCodeSearch: Boolean(code)
  };
}

function getVideoCodeMatchScore(video, searchProfile) {
  if (!searchProfile?.isCodeSearch) {
    return 0;
  }

  const title = String(video?.title || '');
  const url = String(video?.url || '');
  const source = String(video?.source || '');
  const haystack = `${title} ${url} ${source}`;
  const tokens = extractCodeTokens(haystack);
  const normalizedHaystack = normalizeCodeLikeText(haystack);

  if (tokens.includes(searchProfile.code) || normalizedHaystack.includes(searchProfile.code)) {
    return 1000;
  }

  if (searchProfile.prefix && tokens.some((token) => token.startsWith(`${searchProfile.prefix}-`))) {
    return 200;
  }

  if (searchProfile.prefix && normalizedHaystack.includes(`${searchProfile.prefix}-`)) {
    return 120;
  }

  if (tokens.length > 0) {
    return -100;
  }

  return 0;
}

function withSearchTimeout(promise, siteName, timeoutMs = SEARCH_SITE_TIMEOUT_MS) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`${siteName} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    })
  ]);
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
    const searchProfile = getCodeSearchProfile(sanitizedQuery);
    console.log(`🔍 検索開始: "${sanitizedQuery}"`);
    
    // 検索履歴の保存は検索が成功した後に行う（検索処理の前に実行しない）
    
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
      { fn: searchIVFree, name: 'IVFree' }, // 優先順位: 最高
      { fn: searchJPdmv, name: 'JPdmv' }, // 優先順位: 高
      { fn: searchBilibili, name: 'Bilibili' },
      { fn: searchDouga4, name: 'Douga4' },
      { fn: searchJavmix, name: 'Javmix.TV' },
      { fn: searchMat6tube, name: 'Mat6tube' },
      { fn: searchFC2Video, name: 'FC2Video.org' } // 常に追加
    ];
    
    console.log(`📋 検索関数リスト: ${searchFunctions.map(sf => sf.name).join(', ')} (全${searchFunctions.length}件)`);
    
    // 各検索関数を安全に呼び出す（まずはstrictMode=falseで緩和したマッチングを試す）
    searchFunctions.forEach(({ fn, name }, index) => {
      try {
        if (typeof fn === 'function') {
          console.log(`🚀 [${index + 1}/${searchFunctions.length}] ${name}検索関数を呼び出し:`, fn.name);
          // strictMode=falseで呼び出す（緩和したマッチングでより多くの結果を取得）
          allSearches.push(withSearchTimeout(fn(sanitizedQuery, true), name));
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
    
    const relatedVideos = [];
    
    if (!searchProfile.isCodeSearch && uniqueVideos.length < RELATED_SEARCH_RESULT_THRESHOLD) {
      console.log(`🔍 緩和したマッチング条件で関連動画を取得開始... (${uniqueVideos.length}件しかないため)`);
      const relatedSearches = [];
      searchFunctions.forEach(({ fn, name }) => {
        try {
          if (typeof fn === 'function') {
            relatedSearches.push(withSearchTimeout(fn(sanitizedQuery, false), `${name} related`));
          }
        } catch (err) {
          // エラーは無視
        }
      });
      
      const relatedResults = await Promise.allSettled(relatedSearches);
      
      relatedResults.forEach((result) => {
        if (result.status === 'fulfilled' && Array.isArray(result.value)) {
          // 厳格なマッチング結果に含まれていない動画のみを追加
          result.value.forEach(video => {
            if (video && video.url && !strictMatchUrls.has(video.url)) {
              relatedVideos.push(video);
            }
          });
        }
      });
    } else {
      console.log(`ℹ️ 関連動画の拡張検索はスキップ: ${searchProfile.isCodeSearch ? '品番検索のため' : `1周目で十分な件数 (${uniqueVideos.length}件)`}`);
    }
    
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
    
    // サイトごとの件数が多い順に並び替え
    let sortedVideos = [];
    try {
      // 配列のコピーを作成してからソート（元の配列を変更しない）
      sortedVideos = [...finalVideos].sort((a, b) => {
        try {
          const codeMatchA = getVideoCodeMatchScore(a, searchProfile);
          const codeMatchB = getVideoCodeMatchScore(b, searchProfile);
          if (codeMatchB !== codeMatchA) {
            return codeMatchB - codeMatchA;
          }

          const sourceA = (a && a.source) ? a.source : 'unknown';
          const sourceB = (b && b.source) ? b.source : 'unknown';
          const countA = siteCounts[sourceA] || 0;
          const countB = siteCounts[sourceB] || 0;
          
          // 件数が多い順（降順）
          if (countB !== countA) {
            return countB - countA;
          }
          
          // 件数が同じ場合は、元の順序を維持（安定ソート）
          return 0;
        } catch (sortError) {
          console.error('❌ ソート処理エラー:', sortError.message);
          return 0; // エラーが発生した場合は順序を維持
        }
      });
      
      console.log(`📊 サイト別件数順に並び替え完了: ${sortedVideos.length}件`);
    } catch (sortError) {
      console.error('❌ ソート処理でエラーが発生しました:', sortError.message);
      console.error('❌ スタックトレース:', sortError.stack);
      // エラーが発生した場合は、元の配列をそのまま使用
      sortedVideos = finalVideos;
      console.log(`⚠️ ソートをスキップして、元の配列を使用: ${sortedVideos.length}件`);
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
    
    // 検索履歴を保存（検索が成功した後）
    try {
      const currentSearches = await getRecentSearchesCached();
      const searchEntry = { query: sanitizedQuery };
      
      // 同じ検索ワードが既にある場合は削除（重複を避ける）
      const existingIndex = currentSearches.findIndex(entry => entry.query === sanitizedQuery);
      if (existingIndex !== -1) {
        currentSearches.splice(existingIndex, 1);
      }
      
      // 最新の検索ワードを先頭に追加
      currentSearches.unshift(searchEntry);
      
      // 最新20個だけを保持（古いものは自動的に削除）
      if (currentSearches.length > MAX_RECENT_SEARCHES) {
        currentSearches.splice(MAX_RECENT_SEARCHES); // 20個目以降を削除
      }
      
      // MongoDBに保存（永続化）
      await saveRecentSearchesToMongoDB(currentSearches);
      
      // キャッシュを更新（次回の取得を高速化）
      recentSearchesCache = currentSearches;
      recentSearchesCacheTime = Date.now();
      
      console.log(`💾 検索履歴に保存: "${sanitizedQuery}" (合計: ${currentSearches.length}件)`);
    } catch (historyError) {
      console.error('❌ 検索履歴の保存エラー:', historyError.message);
      // 検索履歴の保存に失敗しても検索結果は返す
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

// Google検索
async function searchGoogle(query) {
  try {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://www.google.com/search?q=${encodedQuery}&tbm=vid`;
    
    console.log(`📺 Google検索: ${url}`);
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': 'https://www.google.com/',
        'DNT': '1',
        'Connection': 'keep-alive'
      },
      timeout: 30000,
      maxRedirects: 5,
      validateStatus: function (status) {
        return status >= 200 && status < 400;
      }
    });
    
    const $ = cheerio.load(response.data);
    const videos = [];
    const seenUrls = new Set();
    
    console.log(`📄 Google HTMLサイズ: ${response.data.length} bytes`);
    
    // 動画サイトのドメインパターン（YouTubeは除外）
    const videoSiteDomains = [
      'bilibili.com', 'jpdmv.com', 'douga4.top', '91porn.com',
      'dailymotion.com', 'vimeo.com', 'nicovideo.jp', 'fc2.com',
      'xvideos.com', 'pornhub.com', 'xhamster.com', 'spankbang.com',
      'x1hub.com', 'porntube.com', 'jav.guru',
      'akiba-abv.com', 'sohu.com', 'youku.com', 'iqiyi.com', 'qq.com', 'ixigua.com',
      'thisav.com', 'madou.club'
    ];
    
    // すべてのリンクを取得
    const allLinks = $('a[href]');
    console.log(`🔍 Google 全リンク数: ${allLinks.length}件`);
    
    allLinks.each((index, elem) => {
      
      const $link = $(elem);
      let href = $link.attr('href') || '';
      
      // GoogleのリダイレクトURLを処理
      if (href.startsWith('/url?q=')) {
        const match = href.match(/\/url\?q=([^&]+)/);
        if (match) href = decodeURIComponent(match[1]);
      } else if (href.startsWith('/url?url=')) {
        const match = href.match(/\/url\?url=([^&]+)/);
        if (match) href = decodeURIComponent(match[1]);
      } else if (href.startsWith('/url?')) {
        const urlMatch = href.match(/[?&](?:q|url)=([^&]+)/);
        if (urlMatch) href = decodeURIComponent(urlMatch[1]);
      }
      
      if (!href || !href.startsWith('http')) return;
      
      // YouTubeを除外
      if (href.includes('youtube.com') || href.includes('youtu.be')) {
        return;
      }
      
      const isVideoSite = videoSiteDomains.some(domain => href.includes(domain));
      if (!isVideoSite) return;
      if (seenUrls.has(href)) return;
      seenUrls.add(href);
      
      let title = extractTitle($, $link);
      if (!title || title.length < 3) {
        const urlMatch = href.match(/\/([^\/]+)$/);
        if (urlMatch) {
          title = decodeURIComponent(urlMatch[1]).replace(/[-_]/g, ' ').substring(0, 100);
        } else {
          title = href.split('/').pop() || '動画';
        }
      }
      
      const thumbnail = extractThumbnail($, $link);
      const duration = extractDurationFromHtml($, $link);
      
      if (title && title.length > 0) {
        let source = 'google';
        let embedUrl = href;
        
        // YouTubeは既に除外されているので、ここでは処理しない
        if (href.includes('bilibili.com')) {
          source = 'bilibili';
          const bvid = href.match(/BV[a-zA-Z0-9]+/);
          if (bvid) embedUrl = `//player.bilibili.com/player.html?bvid=${bvid[0]}`;
        } else if (href.includes('jpdmv.com')) source = 'jpdmv';
        else if (href.includes('douga4.top')) source = 'douga4';
        else if (href.includes('91porn.com')) source = '91porn';
        else if (href.includes('thisav.com')) source = 'thisav';
        else if (href.includes('madou.club')) source = 'madou';
        else if (href.includes('dailymotion.com')) {
          source = 'dailymotion';
          const videoId = href.match(/dailymotion\.com\/video\/([^&\n?#\/]+)/);
          if (videoId) embedUrl = `https://www.dailymotion.com/embed/video/${videoId[1]}`;
        } else if (href.includes('vimeo.com')) {
          source = 'vimeo';
          const videoId = href.match(/vimeo\.com\/(\d+)/);
          if (videoId) embedUrl = `https://player.vimeo.com/video/${videoId[1]}`;
        }
        
        videos.push({
          id: `${source}-${Date.now()}-${index}`,
          title: title.substring(0, 200),
          thumbnail: thumbnail || '',
          duration: duration || '',
          url: href,
          embedUrl: embedUrl,
          source: source
        });
      }
    });
    
    console.log(`✅ Google: ${videos.length}件の動画を取得`);
    return videos;
  } catch (error) {
    console.error('Google検索エラー:', error.message);
    return [];
  }
}

// JPdmv検索
async function searchJPdmv(query, strictMode = true) {
  try {
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
              embedUrl: `/api/jpdmv-proxy?url=${encodeURIComponent(v.url)}`
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
            if (finalTitle && finalTitle.length > 3) {
              // 検索クエリとタイトルの関連性をチェック
              // strictMode=falseの場合は、より緩和した条件でマッチング
              if (!isTitleRelevant(finalTitle, query, strictMode)) {
                // 緩和モードの場合、タイトルが長ければ追加（より柔軟に）
                if (strictMode || finalTitle.length < 10) {
                  return; // 関連性がない場合はスキップ
                }
              }
              
              videos.push({
                id: `jpdmv-${Date.now()}-${index}`,
                title: finalTitle.substring(0, 200),
                thumbnail: thumbnail || '',
                duration: duration || '',
                url: fullUrl,
                embedUrl: `/api/jpdmv-proxy?url=${encodeURIComponent(fullUrl)}`,
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
                embedUrl: `/api/jpdmv-proxy?url=${encodeURIComponent(fullUrl)}`,
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

// Spankbang検索
async function searchSpankbang(query) {
  try {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://spankbang.com/s/${encodedQuery}`;
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Referer': 'https://spankbang.com/',
        'Cookie': 'age_verified=1; sb_csrf_session=1'
      },
      timeout: 30000
    });
    
    const $ = cheerio.load(response.data);
    const videos = [];
    
    $('.video-item, .item, a[href*="/video/"]').each((index, elem) => {
      
      const $item = $(elem);
      const href = $item.attr('href') || $item.find('a').attr('href') || '';
      if (!href || !href.includes('/video/')) return;
      
      const fullUrl = href.startsWith('http') ? href : `https://spankbang.com${href}`;
      const title = extractTitle($, $item);
      const thumbnail = extractThumbnail($, $item);
      const duration = extractDurationFromHtml($, $item);
      
      if (title && title.length > 3) {
        videos.push({
          id: `spankbang-${Date.now()}-${index}`,
          title: title.substring(0, 200),
          thumbnail: thumbnail || '',
          duration: duration || '',
          url: fullUrl,
          embedUrl: fullUrl,
          source: 'spankbang'
        });
      }
    });
    
    console.log(`✅ Spankbang: ${videos.length}件の動画を取得`);
    return videos;
  } catch (error) {
    console.error('Spankbang検索エラー:', error.message);
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

// Porntube検索
async function searchPorntube(query) {
  try {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://porntube.com/search/${encodedQuery}`;
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': 'https://porntube.com/'
      },
      timeout: 30000
    });
    
    const $ = cheerio.load(response.data);
    const videos = [];
    
    // 複数のセレクタを試す
    const selectors = [
      '.video-item',
      '.item',
      'a[href*="/video/"]',
      'a[href*="/watch/"]',
      '[class*="video"]',
      '[class*="item"]'
    ];
    
    selectors.forEach(selector => {
      
      $(selector).each((index, elem) => {
        
        const $item = $(elem);
        let href = $item.attr('href') || $item.find('a').attr('href') || '';
        
        // hrefが見つからない場合は親要素を探す
        if (!href) {
          const $parent = $item.parent();
          href = $parent.attr('href') || $parent.find('a').attr('href') || '';
        }
        
        if (!href || (!href.includes('/video/') && !href.includes('/watch/'))) return;
        
        const fullUrl = href.startsWith('http') ? href : `https://porntube.com${href}`;
        const title = extractTitle($, $item);
        const thumbnail = extractThumbnail($, $item);
        const duration = extractDurationFromHtml($, $item);
        
        if (title && title.length > 3) {
          // 重複チェック
          const isDuplicate = videos.some(v => v.url === fullUrl);
          if (!isDuplicate) {
            videos.push({
              id: `porntube-${Date.now()}-${index}`,
              title: title.substring(0, 200),
              thumbnail: thumbnail || '',
              duration: duration || '',
              url: fullUrl,
              embedUrl: fullUrl,
              source: 'porntube'
            });
          }
        }
      });
    });
    
    console.log(`✅ Porntube: ${videos.length}件の動画を取得`);
    return videos;
  } catch (error) {
    console.error('Porntube検索エラー:', error.message);
    return [];
  }
}

// JavGuru検索
async function searchJavGuru(query) {
  try {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://jav.guru/search/${encodedQuery}`;
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': 'https://jav.guru/'
      },
      timeout: 30000
    });
    
    const $ = cheerio.load(response.data);
    const videos = [];
    
    // 複数のセレクタを試す
    const selectors = [
      '.video-item',
      '.item',
      'a[href*="/video/"]',
      'a[href*="/watch/"]',
      'a[href*="/v/"]',
      '[class*="video"]',
      '[class*="item"]'
    ];
    
    selectors.forEach(selector => {
      
      $(selector).each((index, elem) => {
        
        const $item = $(elem);
        let href = $item.attr('href') || $item.find('a').attr('href') || '';
        
        // hrefが見つからない場合は親要素を探す
        if (!href) {
          const $parent = $item.parent();
          href = $parent.attr('href') || $parent.find('a').attr('href') || '';
        }
        
        if (!href || (!href.includes('/video/') && !href.includes('/watch/') && !href.includes('/v/'))) return;
        
        const fullUrl = href.startsWith('http') ? href : `https://jav.guru${href}`;
        const title = extractTitle($, $item);
        const thumbnail = extractThumbnail($, $item);
        const duration = extractDurationFromHtml($, $item);
        
        if (title && title.length > 3) {
          // 重複チェック
          const isDuplicate = videos.some(v => v.url === fullUrl);
          if (!isDuplicate) {
            videos.push({
              id: `javguru-${Date.now()}-${index}`,
              title: title.substring(0, 200),
              thumbnail: thumbnail || '',
              duration: duration || '',
              url: fullUrl,
              embedUrl: fullUrl,
              source: 'javguru'
            });
          }
        }
      });
    });
    
    console.log(`✅ JavGuru: ${videos.length}件の動画を取得`);
    return videos;
  } catch (error) {
    console.error('JavGuru検索エラー:', error.message);
    return [];
  }
}

// Japanhub検索
async function searchJapanhub(query, strictMode = false) {
  try {
    query = query || '';
    console.log(`🔍 Japanhub検索開始: "${query}" (strictMode: ${strictMode})`);
    const startTime = Date.now();
    const queryLower = query.toLowerCase().trim();
    
    // 検索URLを構築（複数URLパターンを試す）
    const urls = [];
    if (query && query.trim().length > 0) {
      const encodedQuery = encodeURIComponent(query);
      urls.push(`https://japanhub.net/search?q=${encodedQuery}`);
      urls.push(`https://japanhub.net/search/${encodedQuery}`);
      urls.push(`https://japanhub.net/?s=${encodedQuery}`);
    } else {
      // 空のクエリの場合はトップページから取得
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
            if (videos.length >= 50) return false;
            
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
              const queryInTitle = titleLower.includes(queryLower);
              
              // 緩和したマッチング: 部分一致や文字単位の一致も許可
              const queryChars = queryLower.split('').filter(c => c.trim().length > 0 && c !== ' ');
              const matchingChars = queryChars.filter(char => titleLower.includes(char)).length;
              const oneCharMatch = queryChars.length > 0 && matchingChars > 0;
              
              const shouldMatch = queryInTitle || oneCharMatch;
              
              if (!shouldMatch) {
                return;
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
              return;
            }
            
            // japanhub.netのドメイン内のリンクのみを対象
            if (!fullUrl.includes('japanhub.net')) return;
            
            // 重複チェック
            if (seenUrls.has(fullUrl)) return;
            seenUrls.add(fullUrl);
            
            // サムネイルを取得
            let thumbnail = extractThumbnail($, $item);
            if (!thumbnail) {
              const $parent = $item.parent();
              thumbnail = extractThumbnail($, $parent);
            }
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
            console.warn('⚠️ Japanhub: Cloudflare(403) を検出（例外）。r.jina.ai にフォールバックします。');
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

// Tktube検索
async function searchTktube(query) {
  try {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://tktube.com/ja/search/${encodedQuery}`;
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': 'https://tktube.com/'
      },
      timeout: 30000
    });
    
    const $ = cheerio.load(response.data);
    const videos = [];
    
    // 複数のセレクタを試す
    const selectors = [
      '.video-item',
      '.item',
      'a[href*="/video/"]',
      'a[href*="/watch/"]',
      'a[href*="/v/"]',
      '[class*="video"]',
      '[class*="item"]'
    ];
    
    selectors.forEach(selector => {
      
      $(selector).each((index, elem) => {
        
        const $item = $(elem);
        let href = $item.attr('href') || $item.find('a').attr('href') || '';
        
        // hrefが見つからない場合は親要素を探す
        if (!href) {
          const $parent = $item.parent();
          href = $parent.attr('href') || $parent.find('a').attr('href') || '';
        }
        
        if (!href || (!href.includes('/video/') && !href.includes('/watch/') && !href.includes('/v/'))) return;
        
        const fullUrl = href.startsWith('http') ? href : `https://tktube.com${href}`;
        const title = extractTitle($, $item);
        const thumbnail = extractThumbnail($, $item);
        const duration = extractDurationFromHtml($, $item);
        
        if (title && title.length > 3) {
          // 重複チェック
          const isDuplicate = videos.some(v => v.url === fullUrl);
          if (!isDuplicate) {
            videos.push({
              id: `tktube-${Date.now()}-${index}`,
              title: title.substring(0, 200),
              thumbnail: thumbnail || '',
              duration: duration || '',
              url: fullUrl,
              embedUrl: fullUrl,
              source: 'tktube'
            });
          }
        }
      });
    });
    
    console.log(`✅ Tktube: ${videos.length}件の動画を取得`);
    return videos;
  } catch (error) {
    console.error('Tktube検索エラー:', error.message);
    return [];
  }
}

// FC2検索
async function searchFC2(query) {
  try {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://fc2.com/video/search.php?kw=${encodedQuery}`;
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': 'https://fc2.com/'
      },
      timeout: 30000
    });
    
    const $ = cheerio.load(response.data);
    const videos = [];
    
    // 複数のセレクタを試す
    const selectors = [
      '.video-item',
      '.item',
      'a[href*="/video/"]',
      'a[href*="/watch/"]',
      'a[href*="/v/"]',
      '[class*="video"]',
      '[class*="item"]'
    ];
    
    selectors.forEach(selector => {
      
      $(selector).each((index, elem) => {
        
        const $item = $(elem);
        let href = $item.attr('href') || $item.find('a').attr('href') || '';
        
        // hrefが見つからない場合は親要素を探す
        if (!href) {
          const $parent = $item.parent();
          href = $parent.attr('href') || $parent.find('a').attr('href') || '';
        }
        
        if (!href || (!href.includes('/video/') && !href.includes('/watch/') && !href.includes('/v/'))) return;
        
        const fullUrl = href.startsWith('http') ? href : `https://fc2.com${href}`;
        const title = extractTitle($, $item);
        const thumbnail = extractThumbnail($, $item);
        const duration = extractDurationFromHtml($, $item);
        
        if (title && title.length > 3) {
          // 重複チェック
          const isDuplicate = videos.some(v => v.url === fullUrl);
          if (!isDuplicate) {
            videos.push({
              id: `fc2-${Date.now()}-${index}`,
              title: title.substring(0, 200),
              thumbnail: thumbnail || '',
              duration: duration || '',
              url: fullUrl,
              embedUrl: fullUrl,
              source: 'fc2'
            });
          }
        }
      });
    });
    
    console.log(`✅ FC2: ${videos.length}件の動画を取得`);
    return videos;
  } catch (error) {
    // 404エラーは警告レベル、その他はエラーレベル
    if (error.response && error.response.status === 404) {
      console.warn('⚠️ FC2検索: ページが見つかりません（404）');
    } else {
      console.error('❌ FC2検索エラー:', error.message);
    }
    return [];
  }
}

// AkibaAbv検索
async function searchAkibaAbv(query) {
  try {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://akiba-abv.com/search/${encodedQuery}`;
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'ja,en-US;q=0.9'
      },
      timeout: 30000
    });
    
    const $ = cheerio.load(response.data);
    const videos = [];
    
    $('.video-item, .item, a[href*="/video/"]').each((index, elem) => {
      
      const $item = $(elem);
      const href = $item.attr('href') || $item.find('a').attr('href') || '';
      if (!href || !href.includes('/video/')) return;
      
      const fullUrl = href.startsWith('http') ? href : `https://akiba-abv.com${href}`;
      const title = extractTitle($, $item);
      const thumbnail = extractThumbnail($, $item);
      const duration = extractDurationFromHtml($, $item);
      
      if (title && title.length > 3) {
        videos.push({
          id: `akibaabv-${Date.now()}-${index}`,
          title: title.substring(0, 200),
          thumbnail: thumbnail || '',
          duration: duration || '',
          url: fullUrl,
          embedUrl: fullUrl,
          source: 'akibaabv'
        });
      }
    });
    
    console.log(`✅ AkibaAbv: ${videos.length}件の動画を取得`);
    return videos;
  } catch (error) {
    // 404エラーは警告レベル、その他はエラーレベル
    if (error.response && error.response.status === 404) {
      console.warn('⚠️ AkibaAbv検索: ページが見つかりません（404）');
    } else {
      console.error('❌ AkibaAbv検索エラー:', error.message);
    }
    return [];
  }
}

// Bilibili検索（WEBスクレイピング）
// 注意: Bilibiliはスクレイピング対策を講じている可能性があります
async function searchBilibili(query, strictMode = true) {
  try {
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
        const thumbnail = extractThumbnail($, $item);
        const duration = extractDurationFromHtml($, $item);
        
        if (title && title.length > 3) {
          // 検索クエリとタイトルの関連性をチェック
          if (!isTitleRelevant(title, query)) {
            return; // 関連性がない場合はスキップ
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

// Youku検索
async function searchYouku(query) {
  try {
    const encodedQuery = encodeURIComponent(query);
    // 複数のURLパターンを試す
    const urls = [
      `https://so.youku.com/search_video/q_${encodedQuery}`,
      `https://www.youku.com/search_video/q_${encodedQuery}`,
      `https://so.youku.com/search?q=${encodedQuery}&type=video`
    ];
    
    let videos = [];
    
    for (const url of urls) {
      try {
        const response = await axios.get(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Referer': 'https://www.youku.com/',
            'Accept-Encoding': 'gzip, deflate, br'
          },
          timeout: 30000
        });
        
        const $ = cheerio.load(response.data);
        
        // 複数のセレクタを試す
        const selectors = [
          '.yk-pack',
          '.yk-pack-item',
          '.item',
          '.video-item',
          'a[href*="/v_show/"]',
          'a[href*="/v_play/"]',
          '[class*="video"]',
          '[class*="item"]',
          '.result-item',
          '.search-result-item'
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
            
            // Youkuの動画URLパターンを確認
            if (!href || (!href.includes('/v_show/') && !href.includes('/v_play/'))) return;
            
            // 相対URLを絶対URLに変換
            let fullUrl = href;
            if (href.startsWith('//')) {
              fullUrl = 'https:' + href;
            } else if (href.startsWith('/')) {
              fullUrl = `https://v.youku.com${href}`;
            } else if (!href.startsWith('http')) {
              fullUrl = `https://v.youku.com/${href}`;
            }
            
            // 重複チェック
            if (seenUrls.has(fullUrl)) return;
            seenUrls.add(fullUrl);
            
            const title = extractTitle($, $item);
            const thumbnail = extractThumbnail($, $item);
            const duration = extractDurationFromHtml($, $item);
            
            if (title && title.length > 3) {
              videos.push({
                id: `youku-${Date.now()}-${index}`,
                title: title.substring(0, 200),
                thumbnail: thumbnail || '',
                duration: duration || '',
                url: fullUrl,
                embedUrl: fullUrl,
                source: 'youku'
              });
            }
          });
        });
        
        // 結果が見つかったらループを抜ける
        if (videos.length > 0) break;
      } catch (urlError) {
        console.warn(`⚠️ Youku URL試行エラー (${url}):`, urlError.message);
        continue;
      }
    }
    
    console.log(`✅ Youku: ${videos.length}件の動画を取得`);
    return videos;
  } catch (error) {
    if (error.response && error.response.status === 404) {
      console.warn('⚠️ Youku検索: ページが見つかりません（404）');
    } else {
      console.error('❌ Youku検索エラー:', error.message);
    }
    return [];
  }
}

// iQiyi検索
async function searchIQiyi(query) {
  try {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://so.iqiyi.com/so/q_${encodedQuery}`;
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7',
        'Referer': 'https://www.iqiyi.com/'
      },
      timeout: 30000
    });
    
    const $ = cheerio.load(response.data);
    const videos = [];
    
    $('.qy-search-result-item, .item, a[href*="/v_"]').each((index, elem) => {
      
      const $item = $(elem);
      const href = $item.attr('href') || $item.find('a').attr('href') || '';
      if (!href || !href.includes('/v_')) return;
      
      const fullUrl = href.startsWith('http') ? href : `https://www.iqiyi.com${href}`;
      const title = extractTitle($, $item);
      const thumbnail = extractThumbnail($, $item);
      const duration = extractDurationFromHtml($, $item);
      
      if (title && title.length > 3) {
        videos.push({
          id: `iqiyi-${Date.now()}-${index}`,
          title: title.substring(0, 200),
          thumbnail: thumbnail || '',
          duration: duration || '',
          url: fullUrl,
          embedUrl: fullUrl,
          source: 'iqiyi'
        });
      }
    });
    
    console.log(`✅ iQiyi: ${videos.length}件の動画を取得`);
    return videos;
  } catch (error) {
    console.error('iQiyi検索エラー:', error.message);
    return [];
  }
}

// Tencent Video検索
async function searchTencentVideo(query) {
  try {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://v.qq.com/x/search/?q=${encodedQuery}`;
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7',
        'Referer': 'https://v.qq.com/'
      },
      timeout: 30000
    });
    
    const $ = cheerio.load(response.data);
    const videos = [];
    
    $('.result_item, .item, a[href*="/x/cover/"]').each((index, elem) => {
      
      const $item = $(elem);
      const href = $item.attr('href') || $item.find('a').attr('href') || '';
      if (!href || !href.includes('/x/cover/')) return;
      
      const fullUrl = href.startsWith('http') ? href : `https://v.qq.com${href}`;
      const title = extractTitle($, $item);
      const thumbnail = extractThumbnail($, $item);
      const duration = extractDurationFromHtml($, $item);
      
      if (title && title.length > 3) {
        videos.push({
          id: `tencent-${Date.now()}-${index}`,
          title: title.substring(0, 200),
          thumbnail: thumbnail || '',
          duration: duration || '',
          url: fullUrl,
          embedUrl: fullUrl,
          source: 'tencent'
        });
      }
    });
    
    console.log(`✅ Tencent Video: ${videos.length}件の動画を取得`);
    return videos;
  } catch (error) {
    console.error('Tencent Video検索エラー:', error.message);
    return [];
  }
}

// Xigua Video検索
async function searchXiguaVideo(query) {
  try {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://www.ixigua.com/search/${encodedQuery}`;
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7',
        'Referer': 'https://www.ixigua.com/'
      },
      timeout: 30000
    });
    
    const $ = cheerio.load(response.data);
    const videos = [];
    
    $('.feed-card, .item, a[href*="/i"]').each((index, elem) => {
      
      const $item = $(elem);
      const href = $item.attr('href') || $item.find('a').attr('href') || '';
      if (!href || !href.includes('/i')) return;
      
      const fullUrl = href.startsWith('http') ? href : `https://www.ixigua.com${href}`;
      const title = extractTitle($, $item);
      const thumbnail = extractThumbnail($, $item);
      const duration = extractDurationFromHtml($, $item);
      
      if (title && title.length > 3) {
        videos.push({
          id: `xigua-${Date.now()}-${index}`,
          title: title.substring(0, 200),
          thumbnail: thumbnail || '',
          duration: duration || '',
          url: fullUrl,
          embedUrl: fullUrl,
          source: 'xigua'
        });
      }
    });
    
    console.log(`✅ Xigua Video: ${videos.length}件の動画を取得`);
    return videos;
  } catch (error) {
    console.error('Xigua Video検索エラー:', error.message);
    return [];
  }
}

// Sohu検索
async function searchSohu(query) {
  try {
    const encodedQuery = encodeURIComponent(query);
    // 複数の検索URLを試す
    const urls = [
      `https://so.tv.sohu.com/mts?wd=${encodedQuery}`,
      `https://tv.sohu.com/vsearch/${encodedQuery}`,
      `https://so.tv.sohu.com/search?wd=${encodedQuery}`
    ];
    
    let videos = [];
    
    for (const url of urls) {
      try {
        const response = await axios.get(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7',
            'Referer': 'https://tv.sohu.com/',
            'Accept-Encoding': 'gzip, deflate, br'
          },
          timeout: 30000,
          maxRedirects: 5
        });
        
        const $ = cheerio.load(response.data);
        console.log(`🔍 Sohu検索: ${url} - HTMLサイズ: ${response.data.length}文字`);
        
        // 複数のセレクタを試す
        const selectors = [
          '.result-item',
          '.item',
          '.video-item',
          '.video-card',
          '.search-result-item',
          'a[href*="/v/"]',
          'a[href*="sohu.com/v/"]',
          'a[href*="tv.sohu.com/v/"]',
          '[class*="video"]',
          '[class*="result"]'
        ];
        
        let foundCount = 0;
        for (const selector of selectors) {
          
          const beforeCount = videos.length;
          $(selector).each((index, elem) => {
            
            const $item = $(elem);
            let href = $item.attr('href') || $item.find('a').attr('href') || '';
            
            // hrefが見つからない場合、親要素を探す
            if (!href) {
              const $parent = $item.parent();
              href = $parent.attr('href') || $parent.find('a').attr('href') || '';
            }
            
            // 動画URLのパターンをチェック
            if (!href || (!href.includes('/v/') && !href.includes('sohu.com/v') && !href.includes('tv.sohu.com/v'))) {
              return;
            }
            
            // URLを正規化
            let fullUrl = href;
            if (!href.startsWith('http')) {
              if (href.startsWith('//')) {
                fullUrl = 'https:' + href;
              } else if (href.startsWith('/')) {
                fullUrl = `https://tv.sohu.com${href}`;
              } else {
                fullUrl = `https://tv.sohu.com/v/${href}`;
              }
            }
            
            const title = extractTitle($, $item);
            const thumbnail = extractThumbnail($, $item);
            const duration = extractDurationFromHtml($, $item);
            
            if (title && title.length > 3) {
              // 重複チェック
              const isDuplicate = videos.some(v => v.url === fullUrl);
              if (!isDuplicate) {
                videos.push({
                  id: `sohu-${Date.now()}-${videos.length}`,
                  title: title.substring(0, 200),
                  thumbnail: thumbnail || '',
                  duration: duration || '',
                  url: fullUrl,
                  embedUrl: fullUrl,
                  source: 'sohu'
                });
                foundCount++;
              }
            }
          });
          
          const selectorCount = videos.length - beforeCount;
          if (selectorCount > 0) {
            console.log(`🔍 Sohu検索: セレクタ "${selector}"で${selectorCount}件見つかりました`);
          }
        }
        
        console.log(`🔍 Sohu検索: 合計${foundCount}件の動画を取得しました`);
        
        // 結果が見つかったら次のURLを試さない
        if (videos.length > 0) {
          console.log(`✅ Sohu: ${videos.length}件の動画を取得 (URL: ${url})`);
          break;
        }
      } catch (urlError) {
        console.warn(`⚠️ Sohu検索URLエラー (${url}):`, urlError.message);
        continue;
      }
    }
    
    if (videos.length === 0) {
      console.warn('⚠️ Sohu: 動画が見つかりませんでした');
    }
    
    return videos;
  } catch (error) {
    console.error('❌ Sohu検索エラー:', error.message);
    return [];
  }
}

// MissAV検索
async function searchMissAV(query) {
  try {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://missav.com/search/${encodedQuery}`;
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Referer': 'https://missav.com/'
      },
      timeout: 30000
    });
    
    const $ = cheerio.load(response.data);
    const videos = [];
    
    // 複数のセレクタを試す
    const selectors = [
      '.item',
      '.video-item',
      'a[href*="/videos/"]',
      'a[href*="/video/"]',
      'a[href*="/watch/"]',
      'a[href*="/v/"]',
      '[class*="video"]',
      '[class*="item"]'
    ];
    
    selectors.forEach(selector => {
      
      $(selector).each((index, elem) => {
        
        const $item = $(elem);
        let href = $item.attr('href') || $item.find('a').attr('href') || '';
        
        // hrefが見つからない場合は親要素を探す
        if (!href) {
          const $parent = $item.parent();
          href = $parent.attr('href') || $parent.find('a').attr('href') || '';
        }
        
        if (!href || (!href.includes('/videos/') && !href.includes('/video/') && !href.includes('/watch/') && !href.includes('/v/'))) return;
        
        const fullUrl = href.startsWith('http') ? href : `https://missav.com${href}`;
        const title = extractTitle($, $item);
        const thumbnail = extractThumbnail($, $item);
        const duration = extractDurationFromHtml($, $item);
        
        if (title && title.length > 3) {
          // 重複チェック
          const isDuplicate = videos.some(v => v.url === fullUrl);
          if (!isDuplicate) {
            videos.push({
              id: `missav-${Date.now()}-${index}`,
              title: title.substring(0, 200),
              thumbnail: thumbnail || '',
              duration: duration || '',
              url: fullUrl,
              embedUrl: fullUrl,
              source: 'missav'
            });
          }
        }
      });
    });
    
    console.log(`✅ MissAV: ${videos.length}件の動画を取得`);
    return videos;
  } catch (error) {
    console.error('MissAV検索エラー:', error.message);
    return [];
  }
}

// 91Porn検索
async function search91Porn(query) {
  try {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://91porn.com/search/${encodedQuery}`;
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Referer': 'https://91porn.com/'
      },
      timeout: 30000
    });
    
    const $ = cheerio.load(response.data);
    const videos = [];
    
    // 複数のセレクタを試す
    const selectors = [
      '.item',
      '.video-item',
      'a[href*="/view/"]',
      'a[href*="/video/"]',
      'a[href*="/watch/"]',
      'a[href*="/v/"]',
      '[class*="video"]',
      '[class*="item"]'
    ];
    
    selectors.forEach(selector => {
      
      $(selector).each((index, elem) => {
        
        const $item = $(elem);
        let href = $item.attr('href') || $item.find('a').attr('href') || '';
        
        // hrefが見つからない場合は親要素を探す
        if (!href) {
          const $parent = $item.parent();
          href = $parent.attr('href') || $parent.find('a').attr('href') || '';
        }
        
        if (!href || (!href.includes('/view/') && !href.includes('/video/') && !href.includes('/watch/') && !href.includes('/v/'))) return;
        
        const fullUrl = href.startsWith('http') ? href : `https://91porn.com${href}`;
        const title = extractTitle($, $item);
        const thumbnail = extractThumbnail($, $item);
        const duration = extractDurationFromHtml($, $item);
        
        if (title && title.length > 3) {
          // 重複チェック
          const isDuplicate = videos.some(v => v.url === fullUrl);
          if (!isDuplicate) {
            videos.push({
              id: `91porn-${Date.now()}-${index}`,
              title: title.substring(0, 200),
              thumbnail: thumbnail || '',
              duration: duration || '',
              url: fullUrl,
              embedUrl: fullUrl,
              source: '91porn'
            });
          }
        }
      });
    });
    
    console.log(`✅ 91Porn: ${videos.length}件の動画を取得`);
    return videos;
  } catch (error) {
    console.error('91Porn検索エラー:', error.message);
    return [];
  }
}

// ThisAV検索（香港）
async function searchThisAV(query) {
  try {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://thisav.com/search/${encodedQuery}`;
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-TW,zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': 'https://thisav.com/'
      },
      timeout: 30000
    });
    
    const $ = cheerio.load(response.data);
    const videos = [];
    
    // 複数のセレクタを試す
    const selectors = [
      '.video-item',
      '.item',
      'a[href*="/video/"]',
      'a[href*="/watch/"]',
      'a[href*="/v/"]',
      '[class*="video"]',
      '[class*="item"]'
    ];
    
    selectors.forEach(selector => {
      
      $(selector).each((index, elem) => {
        
        const $item = $(elem);
        let href = $item.attr('href') || $item.find('a').attr('href') || '';
        
        // hrefが見つからない場合は親要素を探す
        if (!href) {
          const $parent = $item.parent();
          href = $parent.attr('href') || $parent.find('a').attr('href') || '';
        }
        
        if (!href || (!href.includes('/video/') && !href.includes('/watch/') && !href.includes('/v/'))) return;
        
        const fullUrl = href.startsWith('http') ? href : `https://thisav.com${href}`;
        const title = extractTitle($, $item);
        const thumbnail = extractThumbnail($, $item);
        const duration = extractDurationFromHtml($, $item);
        
        if (title && title.length > 3) {
          // 重複チェック
          const isDuplicate = videos.some(v => v.url === fullUrl);
          if (!isDuplicate) {
            videos.push({
              id: `thisav-${Date.now()}-${index}`,
              title: title.substring(0, 200),
              thumbnail: thumbnail || '',
              duration: duration || '',
              url: fullUrl,
              embedUrl: fullUrl,
              source: 'thisav'
            });
          }
        }
      });
    });
    
    console.log(`✅ ThisAV: ${videos.length}件の動画を取得`);
    return videos;
  } catch (error) {
    console.error('ThisAV検索エラー:', error.message);
    return [];
  }
}

// Madou (麻豆传媒) 検索（中国）
async function searchMadou(query) {
  try {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://madou.club/search/${encodedQuery}`;
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': 'https://madou.club/'
      },
      timeout: 30000
    });
    
    const $ = cheerio.load(response.data);
    const videos = [];
    
    // 複数のセレクタを試す
    const selectors = [
      '.video-item',
      '.item',
      'a[href*="/video/"]',
      'a[href*="/watch/"]',
      'a[href*="/v/"]',
      'a[href*="/play/"]',
      '[class*="video"]',
      '[class*="item"]'
    ];
    
    selectors.forEach(selector => {
      
      $(selector).each((index, elem) => {
        
        const $item = $(elem);
        let href = $item.attr('href') || $item.find('a').attr('href') || '';
        
        // hrefが見つからない場合は親要素を探す
        if (!href) {
          const $parent = $item.parent();
          href = $parent.attr('href') || $parent.find('a').attr('href') || '';
        }
        
        if (!href || (!href.includes('/video/') && !href.includes('/watch/') && !href.includes('/v/') && !href.includes('/play/'))) return;
        
        const fullUrl = href.startsWith('http') ? href : `https://madou.club${href}`;
        const title = extractTitle($, $item);
        const thumbnail = extractThumbnail($, $item);
        const duration = extractDurationFromHtml($, $item);
        
        if (title && title.length > 3) {
          // 重複チェック
          const isDuplicate = videos.some(v => v.url === fullUrl);
          if (!isDuplicate) {
            videos.push({
              id: `madou-${Date.now()}-${index}`,
              title: title.substring(0, 200),
              thumbnail: thumbnail || '',
              duration: duration || '',
              url: fullUrl,
              embedUrl: fullUrl,
              source: 'madou'
            });
          }
        }
      });
    });
    
    console.log(`✅ Madou: ${videos.length}件の動画を取得`);
    return videos;
  } catch (error) {
    console.error('Madou検索エラー:', error.message);
    return [];
  }
}

// Javmix.TV検索
async function searchJavmix(query, strictMode = true) {
  try {
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
            if (finalTitle && finalTitle.length > 3) {
              // 検索クエリとタイトルの関連性をチェック
              // strictMode=falseの場合は、より緩和した条件でマッチング
              if (!isTitleRelevant(finalTitle, query, strictMode)) {
                // 緩和モードの場合、タイトルが長ければ追加（より柔軟に）
                if (strictMode || finalTitle.length < 10) {
                  return; // 関連性がない場合はスキップ
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

// PPP.Porn検索
async function searchPPP(query, strictMode = true) {
  try {
    const encodedQuery = encodeURIComponent(query);
    // 複数のURLパターンを試す
    const urls = [
      `https://ppp.porn/pp1/search?q=${encodedQuery}`,
      `https://ppp.porn/pp1/search/${encodedQuery}`,
      `https://ppp.porn/pp1/?q=${encodedQuery}`,
      `https://ppp.porn/pp1/?search=${encodedQuery}`,
      `https://ppp.porn/search?q=${encodedQuery}`,
      `https://ppp.porn/search/${encodedQuery}`
    ];
    
    let videos = [];
    
    for (const url of urls) {
      try {
        const response = await axios.get(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'zh-TW,zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Referer': 'https://ppp.porn/',
            'Accept-Encoding': 'gzip, deflate, br'
          },
          timeout: 30000
        });
        
        const $ = cheerio.load(response.data);
        
        // 複数のセレクタを試す（より広範囲に）
        const selectors = [
          // 優先度の高いセレクタ
          'a[href*="/video/"]',
          'a[href*="/watch/"]',
          'a[href*="/v/"]',
          'a[href*="/pp1/"]',
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
          // 汎用的なセレクタ
          'article',
          'article a',
          'li a',
          'div a',
          '.content a',
          '.main a',
          '.container a',
          '.wrapper a',
          // すべてのリンク（最後の手段）
          'a[href*="ppp.porn"]'
        ];
        
        const seenUrls = new Set();
        let foundCount = 0;
        let matchedCount = 0;
        
        console.log(`🔍 PPP.Porn: HTML取得完了、パース開始 (HTMLサイズ: ${response.data.length} bytes)`);
        
        selectors.forEach(selector => {
          $(selector).each((index, elem) => {
            if (videos.length >= 200) return false;
            
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
            
            if (!href) return;
            
            // PPP.Pornの動画URLパターンを確認（より柔軟に）
            // ppp.pornドメイン内のリンクで、除外パターンがないものを確認
            const isPPPUrl = href.includes('ppp.porn') || href.startsWith('/');
            if (!isPPPUrl) return;
            
            // 除外パターン
            const excludePatterns = ['/category/', '/tag/', '/author/', '/page/', '/search', '/login', '/register', '/contact', '/about', '/privacy', '/terms', '/sitemap', '.jpg', '.png', '.gif', '.css', '.js', '#', 'mailto:', 'javascript:', '/feed', '/rss'];
            const hasExcludePattern = excludePatterns.some(pattern => href.includes(pattern));
            if (hasExcludePattern) return;
            
            // 動画らしいURLパターンを含むもの（より柔軟に）
            const hasVideoPattern = href.includes('/video/') || 
                                   href.includes('/watch/') || 
                                   href.includes('/v/') || 
                                   href.includes('/pp1/') ||
                                   href.includes('/play/') ||
                                   href.includes('/movie/') ||
                                   href.includes('/embed/') ||
                                   href.match(/\/\d+\//) || // 数字を含むパス（例: /12345/）
                                   href.match(/\/[a-z0-9-]+\/[a-z0-9-]+/); // 2段階以上のパス
            
            if (!hasVideoPattern) return;
            
            // 相対URLを絶対URLに変換
            let fullUrl = href;
            if (href.startsWith('//')) {
              fullUrl = 'https:' + href;
            } else if (href.startsWith('/')) {
              fullUrl = `https://ppp.porn${href}`;
            } else if (!href.startsWith('http')) {
              fullUrl = `https://ppp.porn/${href}`;
            }
            
            // 重複チェック
            if (seenUrls.has(fullUrl)) return;
            seenUrls.add(fullUrl);
            matchedCount++;
            
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
            if (finalTitle && finalTitle.length > 3) {
              // 検索クエリとタイトルの関連性をチェック
              // strictMode=falseの場合は、より柔軟にマッチング
              if (strictMode) {
                // 厳格モードの場合のみ関連性チェック
                if (!isTitleRelevant(finalTitle, query, strictMode)) {
                  return; // 関連性がない場合はスキップ
                }
              } else {
                // 緩和モードの場合、タイトルが長ければ追加（より柔軟に）
                // タイトルが10文字以上あれば、関連性チェックを緩和
                if (!isTitleRelevant(finalTitle, query, strictMode) && finalTitle.length < 10) {
                  return; // タイトルが短く、完全に無関係な場合はスキップ
                }
              }
              
              videos.push({
                id: `ppp-${Date.now()}-${index}`,
                title: finalTitle.substring(0, 200),
                thumbnail: thumbnail || '',
                duration: duration || '',
                url: fullUrl,
                embedUrl: fullUrl,
                source: 'ppp'
              });
            } else if (fullUrl && fullUrl.includes('ppp.porn')) {
              // タイトルがなくても、URLが有効な場合は追加（フォールバック）
              const fallbackTitle = fullUrl.match(/\/([^\/]+)$/)?.[1] || '動画';
              videos.push({
                id: `ppp-${Date.now()}-${index}`,
                title: decodeURIComponent(fallbackTitle).replace(/[-_]/g, ' ').substring(0, 200),
                thumbnail: thumbnail || '',
                duration: duration || '',
                url: fullUrl,
                embedUrl: fullUrl,
                source: 'ppp'
              });
            }
          });
        });
        
        // 結果が見つかったらループを抜ける
        if (videos.length > 0) break;
      } catch (urlError) {
        // 404や403エラーは予想される動作なので、警告を抑制（最初のURLのみ情報を出力）
        const urlIndex = urls.indexOf(url) + 1;
        if (urlIndex === 1 && urlError.response && (urlError.response.status === 404 || urlError.response.status === 403)) {
          console.log(`ℹ️ PPP.Porn: 検索エンドポイントが見つかりません（${urlError.response.status}）。他のURLパターンを試行します。`);
        }
        continue;
      }
    }
    
    console.log(`✅ PPP.Porn: ${videos.length}件の動画を取得`);
    return videos;
  } catch (error) {
    if (error.response && error.response.status === 404) {
      console.warn('⚠️ PPP.Porn検索: ページが見つかりません（404）');
    } else {
      console.error('❌ PPP.Porn検索エラー:', error.message);
    }
    return [];
  }
}

// IVFree検索（ivfree.asia）
// strictMode: true = 厳格なマッチング, false = 緩和したマッチング
async function searchIVFree(query, strictMode = true) {
  try {
    console.log(`🔍 IVFree検索開始: "${query}" (strictMode: ${strictMode})`);
    const startTime = Date.now();
    const queryLower = query.toLowerCase().trim();
    
    // トップページから全件取得してフィルタリング（検索機能があるか不明なため）
    const candidateUrls = ['https://ivfree.asia/', 'http://ivfree.asia/'];
    let url = candidateUrls[0];
    let response = null;
    
    console.log(`🔍 IVFree: URL取得開始: ${url}`);
    for (const candidateUrl of candidateUrls) {
      try {
        console.log(`IVFree fetch candidate: ${candidateUrl}`);
        response = await axios.get(candidateUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Referer': candidateUrl,
            'Accept-Encoding': 'gzip, deflate, br'
          },
          timeout: 30000,
          validateStatus: function (status) {
            return status >= 200 && status < 400;
          }
        });
        url = candidateUrl;
        break;
      } catch (error) {
        console.warn(`IVFree fetch failed: ${candidateUrl} / ${error.message}`);
      }
    }
    if (!response) {
      throw new Error('IVFree page fetch failed for both HTTPS and HTTP');
    }
    
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
      'a[href*="ivfree.asia"]'
    ];
    
    let foundCount = 0;
    let matchedCount = 0;
    
    for (const selector of selectors) {
      $(selector).each((index, elem) => {
        if (videos.length >= 50) return false;
        
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
        
        // タイトルが空の場合はスキップ
        if (!titleText || titleText.trim().length < 3) {
          return;
        }
        
        // タイトルにIDパターン [XXX-XXX] が含まれているか確認
        // 以前は必須でしたが、より柔軟にするため、IDパターンがない場合も許可
        const hasIdPattern = titleText.match(/\[[A-Z]+-\d+\]/);
        
        foundCount++;
        
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
          // 緩和したマッチング: 部分一致や文字単位の一致も許可
          const queryChars = queryLower.split('').filter(c => c.trim().length > 0 && c !== ' ');
          const allCharsInTitle = queryChars.length > 0 && queryChars.every(char => titleLower.includes(char));
          const matchingChars = queryChars.filter(char => titleLower.includes(char)).length;
          const halfCharsMatch = queryChars.length >= 2 && matchingChars >= Math.ceil(queryChars.length / 2);
          
          if (hasIdPattern) {
            // IDパターンがある場合: IDパターンに完全一致、タイトルに完全一致、すべての文字がタイトルに含まれている、または50%以上の文字が一致している
            shouldMatch = queryInId || queryInTitle || allCharsInTitle || halfCharsMatch;
          } else {
            // IDパターンがない場合: タイトルに完全一致、すべての文字がタイトルに含まれている、または50%以上の文字が一致している
            shouldMatch = queryInTitle || allCharsInTitle || halfCharsMatch;
          }
        }
        
        if (!shouldMatch) {
          return; // 検索語が含まれていない場合はスキップ
        }
        
        matchedCount++;
        
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
            fullUrl = `https://ivfree.asia${href}`;
          } else if (href.startsWith('./')) {
            fullUrl = `https://ivfree.asia/${href.substring(2)}`;
          } else if (!href.startsWith('http')) {
            fullUrl = `https://ivfree.asia/${href}`;
          }
        } else {
          // リンクが見つからない場合は、IDパターンからURLを生成
          const idMatch = titleText.match(/\[([A-Z]+-\d+)\]/);
          if (idMatch) {
            // 複数のURLパターンを試す
            const id = idMatch[1];
            fullUrl = `https://ivfree.asia/video/${id}`;
          } else {
            return;
          }
        }
        
        // ivfree.asiaのドメイン内のリンクのみを対象
        if (!fullUrl.includes('ivfree.asia')) return;
        
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
            thumbnail = `https://ivfree.asia/images/${id}.jpg`;
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
      
      // 結果が見つかったらループを抜ける
      if (videos.length > 0) break;
    }
    
    const endTime = Date.now();
    const duration = endTime - startTime;
    console.log(`🔍 IVFree: 見つかった動画: ${foundCount}件、マッチした動画: ${matchedCount}件、最終結果: ${videos.length}件`);
    console.log(`✅ IVFree: ${videos.length}件の動画を取得（実行時間: ${duration}ms）`);
    
    // デバッグ情報: 最初の3件のタイトルを表示
    if (videos.length > 0) {
      console.log(`🔍 IVFree デバッグ: 取得した動画のサンプル:`);
      videos.slice(0, 3).forEach((video, idx) => {
        console.log(`  ${idx + 1}. ${video.title.substring(0, 50)}... (URL: ${video.url.substring(0, 60)}...)`);
      });
    } else {
      console.log(`⚠️ IVFree: 動画が見つかりませんでした（検索クエリ: "${query}"）`);
      console.log(`🔍 IVFree デバッグ: 見つかった要素数: ${foundCount}件、マッチした要素数: ${matchedCount}件`);
      
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

        // Cloudflareブロック時は r.jina.ai 経由で取得してリンクから復元
        if (response.status === 403 && isCloudflareChallengeHtml(response.data)) {
          console.warn('⚠️ Jable: Cloudflare(403) を検出。r.jina.ai にフォールバックします。');
          const md = await fetchMarkdownViaJina(url);
          const jinaVideos = extractVideosFromJinaMarkdown(md, {
            source: 'jable',
            includeUrlSubstrings: ['jable.tv/videos/'],
            excludeUrlSubstrings: ['/categories', '/models', '/latest-updates', '/hot', '#'],
            max: 50
          });
          if (jinaVideos.length > 0) {
            console.log(`✅ Jable(Jina): ${jinaVideos.length}件の動画を取得`);
            return jinaVideos;
          }
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
        // axiosデフォルトで403は例外になる場合があるので、ここでもフォールバック
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

// Rou.Video検索
async function searchRou(query) {
  try {
    const encodedQuery = encodeURIComponent(query);
    // 複数のURLパターンを試す
    const urls = [
      `https://rou.video/search?q=${encodedQuery}`,
      `https://rou.video/search/${encodedQuery}`,
      `https://rou.video/videos/search?q=${encodedQuery}`,
      `https://rou.video/home?q=${encodedQuery}`
    ];
    
    let videos = [];
    
    for (const url of urls) {
      try {
        const response = await axios.get(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'zh-TW,zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Referer': 'https://rou.video/',
            'Accept-Encoding': 'gzip, deflate, br'
          },
          timeout: 30000
        });
        
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
            
            // Rou.Videoの動画URLパターンを確認
            if (!href || (!href.includes('/videos/') && !href.includes('/video/') && !href.includes('/watch/') && !href.includes('/v/'))) return;
            
            // 相対URLを絶対URLに変換
            let fullUrl = href;
            if (href.startsWith('//')) {
              fullUrl = 'https:' + href;
            } else if (href.startsWith('/')) {
              fullUrl = `https://rou.video${href}`;
            } else if (!href.startsWith('http')) {
              fullUrl = `https://rou.video/${href}`;
            }
            
            // 重複チェック
            if (seenUrls.has(fullUrl)) return;
            seenUrls.add(fullUrl);
            
            const title = extractTitle($, $item);
            const thumbnail = extractThumbnail($, $item);
            const duration = extractDurationFromHtml($, $item);
            
            if (title && title.length > 3) {
              videos.push({
                id: `rou-${Date.now()}-${index}`,
                title: title.substring(0, 200),
                thumbnail: thumbnail || '',
                duration: duration || '',
                url: fullUrl,
                embedUrl: fullUrl,
                source: 'rou'
              });
            }
          });
        });
        
        // 結果が見つかったらループを抜ける
        if (videos.length > 0) break;
      } catch (urlError) {
        console.warn(`⚠️ Rou.Video URL試行エラー (${url}):`, urlError.message);
        continue;
      }
    }
    
    console.log(`✅ Rou.Video: ${videos.length}件の動画を取得`);
    return videos;
  } catch (error) {
    if (error.response && error.response.status === 404) {
      console.warn('⚠️ Rou.Video検索: ページが見つかりません（404）');
    } else {
      console.error('❌ Rou.Video検索エラー:', error.message);
    }
    return [];
  }
}

// 検索履歴を取得するAPI（このサイトを通して検索したワードを最新20個返す）
app.get('/api/recent-searches', async (req, res) => {
  try {
    // キャッシュ付きで検索履歴を取得（高速化）
    const allSearches = await getRecentSearchesCached();
    
    // このサイトを通して検索したワードを最新20個返す
    // 自分の検索も他の人の検索も含めて、すべての検索ワードを履歴として表示
    // 検索ワードのみを返す（時間情報は不要）
    const searches = allSearches
      .slice(0, MAX_RECENT_SEARCHES) // 最新20件
      .map(entry => ({
        query: entry.query
      }));
    
    console.log(`📋 検索履歴取得: ${searches.length}件 (全検索: ${allSearches.length}件)`);
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
    res.status(500).json({ error: 'Failed to retrieve search history' });
  }
});

// ランダム動画取得API
app.get('/api/random', async (req, res) => {
  try {
    const { type } = req.query;
    
    if (!type || (type !== 'iv' && type !== 'jav')) {
      return res.status(400).json({ error: 'Invalid type. Use "iv" or "jav"' });
    }
    
    console.log(`🎲 ランダム動画取得開始: type=${type}`);
    
    let allVideos = [];
    
    if (type === 'iv') {
      // IV動画: IVFree、JPdmvからランダムに表示（Mat6tubeは削除済み）
      const ivfreePromise = searchIVFree('', false); // 空のクエリで全件取得
      const jpdmvPromise = searchJPdmv('', false); // JPdmvからも取得
      const ivfreeVideos = await ivfreePromise.catch(() => []);
      const jpdmvVideos = await jpdmvPromise.catch(() => []);

      const ivResults = [
        { name: 'searchIVFree', value: ivfreeVideos },
        { name: 'searchJPdmv', value: jpdmvVideos }
      ];

      // デバッグ: 各検索関数の結果を確認
      ivResults.forEach((r) => {
        const videos = Array.isArray(r.value) ? r.value : [];
        console.log(`✅ [デバッグ] ${r.name}: ${videos.length}件の動画を取得`);
        if (videos.length === 0) {
          console.warn(`⚠️ [デバッグ] ${r.name}: 動画が0件です（空の結果）`);
        } else {
          const sources = [...new Set(videos.slice(0, 3).map(v => v.source))];
          console.log(`📊 [デバッグ] ${r.name}: 最初の3件のソース: ${sources.join(', ')}`);
        }
        allVideos.push(...videos);
      });

      // 各検索関数からの取得数をサマリー表示
      console.log(`📊 [デバッグ] IVランダム: 各検索関数からの取得数サマリー:`);
      ivResults.forEach((r) => {
        const videos = Array.isArray(r.value) ? r.value : [];
        console.log(`  - ${r.name}: ${videos.length}件`);
      });

      console.log(`✅ IVFree、JPdmvから${allVideos.length}件の動画を取得`);
    } else if (type === 'jav') {
      // JAV動画: Javmix.TV、JPdmv、Japanhub、Douga4、FC2Video、Jable、X1hub、Airavから取得（Mat6tubeは削除済み）
      const javSearches = [
        searchJavmix('', false),
        searchJPdmv('', false),
        searchJapanhub('', false), // Japanhubからも取得
        searchDouga4('', false), // Douga4からも取得
        searchFC2Video('', false), // FC2Videoからも取得
        searchJable('', false), // Jableからも取得
        searchX1hub('', false), // X1hubからも取得
        searchAirav('', false) // Airavからも取得
      ];
      
      const javResults = await Promise.allSettled(javSearches);
      
      // デバッグ: 各検索関数の結果を確認
      const searchFunctionNames = ['searchJavmix', 'searchJPdmv', 'searchJapanhub', 'searchDouga4', 'searchFC2Video', 'searchJable', 'searchX1hub', 'searchAirav'];
      javResults.forEach((result, index) => {
        const functionName = searchFunctionNames[index];
        if (result.status === 'fulfilled' && Array.isArray(result.value)) {
          const videos = result.value;
          console.log(`✅ [デバッグ] ${functionName}: ${videos.length}件の動画を取得`);
          if (videos.length === 0) {
            console.warn(`⚠️ [デバッグ] ${functionName}: 動画が0件です（空の結果）`);
          } else {
            // 最初の3件のソースを確認
            const sources = [...new Set(videos.slice(0, 3).map(v => v.source))];
            console.log(`📊 [デバッグ] ${functionName}: 最初の3件のソース: ${sources.join(', ')}`);
          }
          const pppVideos = videos.filter(v => v && (v.source === 'ppp' || (v.url && v.url.includes('ppp.porn'))));
          if (pppVideos.length > 0) {
            console.log(`⚠️ [デバッグ] ${functionName}からPPPの動画が${pppVideos.length}件検出されました`);
            pppVideos.slice(0, 3).forEach(v => {
              console.log(`  - PPP動画: source=${v.source}, url=${v.url ? v.url.substring(0, 80) : 'N/A'}`);
            });
          }
          allVideos.push(...videos);
        } else if (result.status === 'rejected') {
          console.error(`❌ [デバッグ] ${functionName}でエラー:`, result.reason?.message || 'Unknown error');
          console.error(`❌ [デバッグ] ${functionName}エラー詳細:`, result.reason);
        } else {
          console.warn(`⚠️ [デバッグ] ${functionName}: 予期しない結果形式 (status: ${result.status})`);
        }
      });
      
      // 各検索関数からの取得数をサマリー表示
      console.log(`📊 [デバッグ] 各検索関数からの取得数サマリー:`);
      javResults.forEach((result, index) => {
        const functionName = searchFunctionNames[index];
        if (result.status === 'fulfilled' && Array.isArray(result.value)) {
          console.log(`  - ${functionName}: ${result.value.length}件`);
          if (result.value.length === 0) {
            console.warn(`    ⚠️ ${functionName}: 空のクエリでトップページから取得を試みましたが、0件でした`);
          }
        } else if (result.status === 'rejected') {
          console.error(`  - ${functionName}: エラー - ${result.reason?.message || 'Unknown error'}`);
          if (result.reason?.stack) {
            console.error(`    スタックトレース: ${result.reason.stack.substring(0, 200)}`);
          }
        } else {
          console.warn(`  - ${functionName}: 予期しない状態 (status: ${result.status})`);
        }
      });
      
      // 全体のサマリー
      const totalFromAllSearches = allVideos.length;
      console.log(`📊 [デバッグ] 全検索関数からの合計取得数: ${totalFromAllSearches}件`);
      
      // デバッグ: フィルタリング前のPPP動画数を確認
      const pppCountBefore = allVideos.filter(v => v && (v.source === 'ppp' || (v.url && v.url.includes('ppp.porn')))).length;
      console.log(`🔍 [デバッグ] フィルタリング前のPPP動画数: ${pppCountBefore}件`);
      if (pppCountBefore > 0) {
        const pppVideos = allVideos.filter(v => v && (v.source === 'ppp' || (v.url && v.url.includes('ppp.porn'))));
        console.log(`🔍 [デバッグ] PPP動画の詳細（最初の5件）:`);
        pppVideos.slice(0, 5).forEach((v, i) => {
          console.log(`  ${i + 1}. source="${v.source}", url="${v.url ? v.url.substring(0, 100) : 'N/A'}", title="${v.title ? v.title.substring(0, 50) : 'N/A'}"`);
        });
      }
    }
    
    // 重複除去とPPP除外（より厳格に）
    const uniqueVideos = [];
    const seenUrls = new Set();
    let pppFilteredCount = 0;
    allVideos.forEach(video => {
      if (!video || !video.url) return;
      
      // PPPの動画を除外（より厳格にチェック）
      const isPPP = video.source === 'ppp' || 
                    video.source === 'PPP' ||
                    (video.url && (
                      video.url.includes('ppp.porn') ||
                      video.url.includes('ppp-porn') ||
                      video.url.toLowerCase().includes('ppp.porn') ||
                      video.url.toLowerCase().includes('ppp-porn')
                    ));
      
      if (isPPP) {
        pppFilteredCount++;
        console.log(`🚫 [デバッグ] PPP動画を除外: source="${video.source}", url="${video.url.substring(0, 80)}"`);
        return; // PPPの動画はスキップ
      }
      
      if (!seenUrls.has(video.url)) {
        seenUrls.add(video.url);
        uniqueVideos.push(video);
      }
    });
    
    console.log(`🔍 [デバッグ] フィルタリングで除外したPPP動画数: ${pppFilteredCount}件`);
    console.log(`🔍 [デバッグ] フィルタリング後の動画数: ${uniqueVideos.length}件`);
    
    // デバッグ: 最終結果にPPPが含まれていないか確認（より厳格に）
    const pppInFinal = uniqueVideos.filter(v => {
      if (!v) return false;
      const isPPP = v.source === 'ppp' || 
                    v.source === 'PPP' ||
                    (v.url && (
                      v.url.includes('ppp.porn') ||
                      v.url.includes('ppp-porn') ||
                      v.url.toLowerCase().includes('ppp.porn') ||
                      v.url.toLowerCase().includes('ppp-porn')
                    ));
      return isPPP;
    });
    if (pppInFinal.length > 0) {
      console.error(`❌ [デバッグ] 警告: 最終結果にPPP動画が${pppInFinal.length}件含まれています！`);
      pppInFinal.slice(0, 10).forEach((v, i) => {
        console.error(`  ${i + 1}. source="${v.source}", url="${v.url ? v.url.substring(0, 100) : 'N/A'}", title="${v.title ? v.title.substring(0, 50) : 'N/A'}"`);
      });
      
      // PPP動画を最終結果から除外（念のため）
      const finalVideos = uniqueVideos.filter(v => {
        if (!v) return false;
        const isPPP = v.source === 'ppp' || 
                      v.source === 'PPP' ||
                      (v.url && (
                        v.url.includes('ppp.porn') ||
                        v.url.includes('ppp-porn') ||
                        v.url.toLowerCase().includes('ppp.porn') ||
                        v.url.toLowerCase().includes('ppp-porn')
                      ));
        return !isPPP;
      });
      console.log(`🚫 [デバッグ] 最終結果からPPP動画を${pppInFinal.length}件除外しました（${uniqueVideos.length}件 → ${finalVideos.length}件）`);
      uniqueVideos.length = 0;
      uniqueVideos.push(...finalVideos);
    }
    
    // デバッグ情報をレスポンスに含める（クライアント側でも確認可能）
    const debugInfo = {
      totalBeforeFilter: allVideos.length,
      pppFilteredCount: pppFilteredCount,
      totalAfterFilter: uniqueVideos.length,
      pppInFinal: pppInFinal.length,
      sourceBreakdown: type === 'iv' ? {
        ivfree: uniqueVideos.filter(v => v.source === 'ivfree').length,
        jpdmv: uniqueVideos.filter(v => v.source === 'jpdmv').length,
        other: uniqueVideos.filter(v => v && v.source && !['ivfree', 'jpdmv'].includes(v.source)).length
      } : type === 'jav' ? {
        javmix: uniqueVideos.filter(v => v.source === 'javmix').length,
        jpdmv: uniqueVideos.filter(v => v.source === 'jpdmv').length,
        japanhub: uniqueVideos.filter(v => v.source === 'japanhub').length,
        douga4: uniqueVideos.filter(v => v.source === 'douga4').length,
        fc2video: uniqueVideos.filter(v => v.source === 'fc2video').length,
        jable: uniqueVideos.filter(v => v.source === 'jable').length,
        x1hub: uniqueVideos.filter(v => v.source === 'x1hub').length,
        airav: uniqueVideos.filter(v => v.source === 'airav').length,
        ppp: uniqueVideos.filter(v => v && (v.source === 'ppp' || (v.url && v.url.includes('ppp.porn')))).length,
        other: uniqueVideos.filter(v => v && v.source && !['javmix', 'jpdmv', 'japanhub', 'douga4', 'fc2video', 'jable', 'x1hub', 'airav', 'ppp'].includes(v.source)).length
      } : {}
    };
    
    // Fisher-Yatesシャッフルアルゴリズムで完全にランダムに並び替え
    const shuffled = [...uniqueVideos];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const randomVideos = shuffled; // 制限なしで全件返す
    
    // デバッグ: シャッフル後のPPP動画チェック（より厳格に）
    const pppInShuffled = randomVideos.filter(v => {
      if (!v) return false;
      const isPPP = v.source === 'ppp' || 
                    v.source === 'PPP' ||
                    (v.url && (
                      v.url.includes('ppp.porn') ||
                      v.url.includes('ppp-porn') ||
                      v.url.toLowerCase().includes('ppp.porn') ||
                      v.url.toLowerCase().includes('ppp-porn')
                    ));
      return isPPP;
    });
    if (pppInShuffled.length > 0) {
      console.error(`❌ [デバッグ] 警告: シャッフル後の結果にPPP動画が${pppInShuffled.length}件含まれています！`);
      pppInShuffled.slice(0, 10).forEach((v, i) => {
        console.error(`  ${i + 1}. source="${v.source}", url="${v.url ? v.url.substring(0, 100) : 'N/A'}", title="${v.title ? v.title.substring(0, 50) : 'N/A'}"`);
      });
      
      // PPP動画をシャッフル後の結果から除外（念のため）
      const finalShuffled = randomVideos.filter(v => {
        if (!v) return false;
        const isPPP = v.source === 'ppp' || 
                      v.source === 'PPP' ||
                      (v.url && (
                        v.url.includes('ppp.porn') ||
                        v.url.includes('ppp-porn') ||
                        v.url.toLowerCase().includes('ppp.porn') ||
                        v.url.toLowerCase().includes('ppp-porn')
                      ));
        return !isPPP;
      });
      console.log(`🚫 [デバッグ] シャッフル後の結果からPPP動画を${pppInShuffled.length}件除外しました（${randomVideos.length}件 → ${finalShuffled.length}件）`);
      randomVideos.length = 0;
      randomVideos.push(...finalShuffled);
    }
    
    // デバッグ: 最初の5件のソースを確認
    const firstFiveSources = randomVideos.slice(0, 5).map(v => v.source).join(', ');
    console.log(`✅ ${type.toUpperCase()}ランダム動画取得完了: ${randomVideos.length}件 (全件ランダム順)`);
    if (type === 'iv') {
      const ivSourceCounts = {
        ivfree: uniqueVideos.filter(v => v.source === 'ivfree').length,
        jpdmv: uniqueVideos.filter(v => v.source === 'jpdmv').length,
        other: uniqueVideos.filter(v => v && v.source && !['ivfree', 'jpdmv'].includes(v.source)).length
      };
      console.log(`📊 ソース別内訳: IVFree=${ivSourceCounts.ivfree}件, JPdmv=${ivSourceCounts.jpdmv}件, その他=${ivSourceCounts.other}件`);
    } else {
      const sourceCounts = {
        javmix: uniqueVideos.filter(v => v.source === 'javmix').length,
        jpdmv: uniqueVideos.filter(v => v.source === 'jpdmv').length,
        japanhub: uniqueVideos.filter(v => v.source === 'japanhub').length,
        douga4: uniqueVideos.filter(v => v.source === 'douga4').length,
        fc2video: uniqueVideos.filter(v => v.source === 'fc2video').length,
        jable: uniqueVideos.filter(v => v.source === 'jable').length,
        x1hub: uniqueVideos.filter(v => v.source === 'x1hub').length,
        airav: uniqueVideos.filter(v => v.source === 'airav').length,
        ppp: uniqueVideos.filter(v => v && (v.source === 'ppp' || (v.url && v.url.includes('ppp.porn')))).length,
        other: uniqueVideos.filter(v => v && v.source && !['javmix', 'jpdmv', 'japanhub', 'douga4', 'fc2video', 'jable', 'x1hub', 'airav', 'ppp'].includes(v.source)).length
      };
      console.log(`📊 ソース別内訳: Javmix=${sourceCounts.javmix}件, JPdmv=${sourceCounts.jpdmv}件, Japanhub=${sourceCounts.japanhub}件, Douga4=${sourceCounts.douga4}件, FC2Video=${sourceCounts.fc2video}件, Jable=${sourceCounts.jable}件, X1hub=${sourceCounts.x1hub}件, Airav=${sourceCounts.airav}件, PPP=${sourceCounts.ppp}件, その他=${sourceCounts.other}件`);
      if (sourceCounts.ppp > 0) {
        console.error(`❌ [デバッグ] エラー: 最終結果にPPP動画が${sourceCounts.ppp}件含まれています！`);
      }
    }
    console.log(`🎲 ランダム順の最初の5件のソース: ${firstFiveSources}`);
    
    // デバッグ情報をレスポンスに含める
    res.json({ 
      results: randomVideos,
      debug: debugInfo
    });
  } catch (error) {
    console.error('❌ ランダム動画取得エラー:', error);
    console.error('❌ エラーメッセージ:', error.message);
    console.error('❌ スタックトレース:', error.stack ? error.stack.substring(0, 1000) : 'No stack trace');
    console.error('❌ エラー詳細:', {
      name: error.name,
      message: error.message,
      stack: error.stack ? error.stack.substring(0, 500) : 'No stack trace'
    });
    // エラーが発生した場合は空の配列を返す（サイトが動作し続けるように）
    res.status(200).json({ 
      results: [],
      error: 'Failed to fetch random videos. Please try again later.'
    });
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
      // Markdown内のURLをざっくり抽出
      const urls = md.match(/https?:\/\/[^\s)]+/g) || [];
      // 埋め込みホストの優先順位（必要に応じて追加）
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

    // Cloudflare等でHTMLが取れない場合はフォールバック
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
      // 失敗時も r.jina.ai を試す
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

    // まずはプレイヤーらしきiframeを優先して探す
    let embedUrl = '';
    const iframeCandidates = $('iframe[src]').toArray();
    for (const el of iframeCandidates) {
      const src = $(el).attr('src') || '';
      if (!src) continue;
      const full = src.startsWith('http') ? src : new URL(src, videoUrl).toString();

      // 広告/解析系は除外、プレイヤー系を優先
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
      // 最後の手段として最初の有効iframeを採用
      if (!embedUrl) embedUrl = full;
    }

    // video/sourceの直リンクがあればそれも採用
    if (!embedUrl) {
      const videoSrc = $('video source[src]').first().attr('src');
      if (videoSrc) {
        embedUrl = videoSrc.startsWith('http') ? videoSrc : new URL(videoSrc, videoUrl).toString();
      }
    }

    // script内からmp4/m3u8/embed URLを拾う
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

    // 取れなければ元URLにフォールバック
    if (!embedUrl) embedUrl = videoUrl;

    console.log('✅ JPdmv動画URL取得:', embedUrl);
    res.json({ embedUrl, originalUrl: videoUrl });
  } catch (error) {
    console.error('❌ JPdmv動画URL取得エラー:', error.message);
    res.status(500).json({ error: 'Failed to retrieve video URL', embedUrl: req.query.url });
  }
});

// IVFree動画URL取得エンドポイント（広告除去版）
app.get('/api/ivfree-video', async (req, res) => {
  try {
    const videoUrl = String(req.query.url || '').trim();
    const isIVFamilyUrl = videoUrl.includes('ivfree.asia') || videoUrl.includes('aivfree.com');
    if (!videoUrl || !isIVFamilyUrl) {
      return res.status(400).json({ error: 'IVFree URL is required' });
    }
    
    console.log('📺 IVFree動画URL取得リクエスト:', videoUrl);
    
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
        embedUrl = iframeSrc.startsWith('http') ? iframeSrc : new URL(iframeSrc, videoUrl).toString();
      }
    }
    
    // video要素を探す
    const video = $('video source[src]').first();
    if (video.length > 0) {
      const videoSrc = video.attr('src');
      if (videoSrc) {
        embedUrl = videoSrc.startsWith('http') ? videoSrc : new URL(videoSrc, videoUrl).toString();
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

// IVFree動画ページプロキシエンドポイント（広告除去版）
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
        }
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
        }
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
      
      // 広告ブロッカー検出を回避するスクリプトを追加
      // ポップアップ広告を無効化するスクリプトも追加
      $('head').prepend(`
        <script>
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
            
            if (document.body || document.documentElement) {
              observer.observe(document.body || document.documentElement, {
                childList: true,
                subtree: true
              });
            }
            
            // 定期的に除去（念のため）
            setInterval(removePopupAds, 500);
            // AdBlock検出を無効化
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
                            text.includes('I\'m not a robot') ||
                            text.includes('I am not a robot') ||
                            text.includes('ロボットではありません') ||
                            text.includes('Verify you are human') ||
                            text.includes('Verify you\'re human') ||
                            text.includes('Please verify you are human') ||
                            text.includes('Please verify you\'re human') ||
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
                            text.includes('reCAPTCHA')) {
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
                observer.observe(document.body, {
                  childList: true,
                  subtree: true
                });
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
      
      // 広告ブロッカー検出メッセージを除去
      // ロボット検証（CAPTCHA/reCAPTCHA）のメッセージも除去
      $('body').find('*').each((index, elem) => {
        const $elem = $(elem);
        const text = $elem.text();
        if (text && (
          text.includes('Please change your browser') ||
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
          text.includes('I\'m not a robot') ||
          text.includes('I am not a robot') ||
          text.includes('ロボットではありません') ||
          text.includes('Verify you are human') ||
          text.includes('Verify you\'re human') ||
          text.includes('Please verify you are human') ||
          text.includes('Please verify you\'re human') ||
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
          text.includes('reCAPTCHA')
        )) {
          $elem.remove();
        }
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
      
      // luluvid.comのAdBlock検出スクリプトを除去
      if (videoUrl.includes('luluvid.com') || videoUrl.includes('luluvdoo.com')) {
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
            text.includes('AdBlock detected')
          )) {
            $elem.remove();
          }
        });
      }
      
      // 外部動画サイト用のCSPを設定（緩和版）
      // すべてのCSPメタタグを削除（既存のCSPを確実に削除）
      $('head meta[http-equiv="Content-Security-Policy"]').remove();
      $('head meta[http-equiv="content-security-policy"]').remove();
      $('head meta[http-equiv="CSP"]').remove();
      $('head meta[http-equiv="csp"]').remove();
      
      // CSPを完全に無効化（外部動画サイトのリソースをすべて許可）
      // metaタグのCSPはframe-ancestorsを無視するため、レスポンスヘッダーでも設定
      const cspContent = `default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src * 'unsafe-inline' 'unsafe-eval'; style-src * 'unsafe-inline'; img-src * data: blob:; media-src * blob:; frame-src *; object-src 'none'; base-uri *; form-action *;`;
      
      // 新しいCSPを追加（metaタグ）
      $('head').prepend(`<meta http-equiv="Content-Security-Policy" content="${cspContent}">`);
      
      // sandbox属性を削除するスクリプトを追加（外部動画サイトの場合）
      // luluvid.comのAdBlock検出を回避するスクリプトも追加
      $('head').prepend(`
        <script>
          (function() {
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
            
            // luluvid.comのAdBlock検出を回避
            if (window.location.hostname.includes('luluvid.com') || window.location.hostname.includes('luluvdoo.com')) {
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
              
              observer.observe(document.body || document.documentElement, {
                childList: true,
                subtree: true
              });
              
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
      res.setHeader('Content-Security-Policy', `${cspContent} frame-ancestors 'self';`);
      
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
    
    // 相対URLを絶対URLに変換する関数
    const toAbsoluteUrl = (url) => {
      if (!url) return url;
      if (url.startsWith('http://') || url.startsWith('https://')) return url;
      if (url.startsWith('//')) return `http:${url}`;
      if (url.startsWith('/')) return `${baseUrl.protocol}//${baseUrl.host}${url}`;
      return `${baseUrl.protocol}//${baseUrl.host}/${url}`;
    };
    
    // 相対URLを絶対URLに変換
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
      }
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
    
    // 広告関連のiframeを除去
    // ロボット検証（CAPTCHA/reCAPTCHA）のiframeも除去
    $('iframe').each((index, elem) => {
      const src = $(elem).attr('src') || '';
      const id = $(elem).attr('id') || '';
      const classAttr = $(elem).attr('class') || '';
      if (
        src.includes('adsbygoogle') || 
        src.includes('googlesyndication') || 
        src.includes('doubleclick') ||
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
      }
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
    
    // baseタグを追加して相対URLを正しく解決
    if ($('head base').length === 0) {
      $('head').prepend(`<base href="${baseUrl.protocol}//${baseUrl.host}${baseUrl.pathname}">`);
    }
    
    // Content Security Policyを追加してポップアップを制限（ただし、動画再生に必要なリソースは許可）
    // base-uriも許可（baseタグを使用するため）
    if ($('head meta[http-equiv="Content-Security-Policy"]').length === 0) {
      $('head').prepend('<meta http-equiv="Content-Security-Policy" content="default-src \'self\' https://ivfree.asia; script-src \'self\' https://ivfree.asia \'unsafe-inline\' \'unsafe-eval\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' https://ivfree.asia data:; media-src \'self\' https://ivfree.asia *; frame-src \'self\' https://ivfree.asia *; object-src \'none\'; base-uri \'self\' https://ivfree.asia; form-action \'self\'; frame-ancestors \'self\'; upgrade-insecure-requests;">');
    }
    
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
            
            // ロボット検証のメッセージを含む要素を除去
            try {
              document.querySelectorAll('*').forEach(elem => {
                const text = elem.textContent || elem.innerText || '';
                if (text.includes('I\'m not a robot') || text.includes('I am not a robot') ||
                    text.includes('ロボットではありません') || text.includes('Verify you are human') ||
                    text.includes('Verify you\'re human') || text.includes('Please verify you are human') ||
                    text.includes('Please verify you\'re human') || text.includes('Human verification') ||
                    text.includes('Security check') || text.includes('Security verification') ||
                    text.includes('Cloudflare') || text.includes('Checking your browser') ||
                    text.includes('Just a moment') || text.includes('Please wait') ||
                    text.includes('Verifying') || text.includes('Verification') ||
                    text.includes('CAPTCHA') || text.includes('reCAPTCHA')) {
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
          
          observer.observe(document.body || document.documentElement, {
            childList: true,
            subtree: true
          });
          
          // 定期的に除去（念のため）
          setInterval(removePopupAds, 500);
        })();
      </script>
    `);
    
    let html = $.html();
    
    // CORSヘッダーを設定
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    
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

// 動画プロキシエンドポイント（iPhoneでデスクトップに偽装）
app.get('/api/proxy-video', async (req, res) => {
  try {
    const videoUrl = req.query.url;
    if (!videoUrl) {
      return res.status(400).json({ error: 'URL parameter is required' });
    }
    
    console.log('📺 動画プロキシリクエスト:', videoUrl);
    
    // デスクトップのUser-Agentでリクエスト
    const response = await axios.get(videoUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': videoUrl,
        // 圧縮レスポンスだとHTML加工が難しくなるため、非圧縮を優先
        'Accept-Encoding': 'identity'
      },
      timeout: 30000,
      maxRedirects: 5,
      responseType: 'arraybuffer'
    });

    const contentType = String(response.headers['content-type'] || '');
    const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml+xml');

    // HTMLは相対パス崩れを避けるため <base> を注入
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

    // 非HTMLはそのまま返す
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
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).json({ error: 'URL is required' });

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
    // 同一オリジン内iframeでの表示を許可
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

// VMEDA site-proxy / pizjav-proxy（api/lib のプロキシをローカル実行用に登録）
try {
  const siteProxy = require('./api/lib/site-proxy');
  const pizjavProxy = require('./api/lib/pizjav-proxy');
  siteProxy.register(app);
  pizjavProxy.register(app);
  console.log('✅ site-proxy / pizjav-proxy 登録完了');
} catch (e) {
  console.warn('⚠️ site-proxy / pizjav-proxy の読み込みに失敗:', e.message);
}

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
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
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
              <script src="/app.js?v=1.0.4"></script>
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

        // Cloudflareブロック時は r.jina.ai 経由で取得してリンクから復元
        if (response.status === 403 && isCloudflareChallengeHtml(response.data)) {
          console.warn('⚠️ Airav: Cloudflare(403) を検出。r.jina.ai にフォールバックします。');
          const md = await fetchMarkdownViaJina(url);
          const jinaVideos = extractVideosFromJinaMarkdown(md, {
            source: 'airav',
            includeUrlSubstrings: ['airav.io/cn/video'],
            excludeUrlSubstrings: ['/cn/search', '/cn/videos', '#'],
            max: 50
          });
          if (jinaVideos.length > 0) {
            console.log(`✅ Airav(Jina): ${jinaVideos.length}件の動画を取得`);
            return jinaVideos;
          }
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

// Mat6tube検索（アプローチ変更：より積極的に動画を取得）
async function searchMat6tube(query, strictMode = true) {
  try {
    console.log(`🔍 Mat6tube検索開始: "${query}" (strictMode: ${strictMode})`);
    const encodedQuery = encodeURIComponent(query);
    // 複数のURLパターンを試す（空のクエリの場合はトップページや最新動画ページから取得）
    const urls = query && query.trim() ? [
      `https://mat6tube.com/video/${encodedQuery}`, // 最優先：/video/パスで検索
      `https://mat6tube.com/video/${query}`, // エンコードなしも試す
      `https://mat6tube.com/search?q=${encodedQuery}`,
      `https://mat6tube.com/search/${encodedQuery}`,
      `https://mat6tube.com/?q=${encodedQuery}`,
      `https://mat6tube.com/?s=${encodedQuery}`,
      `https://mat6tube.com/?search=${encodedQuery}`,
      `https://mat6tube.com/search.php?q=${encodedQuery}`,
      `https://mat6tube.com/index.php?q=${encodedQuery}`
    ] : [
      // mat6tube はトップ/最新がJSレンダリングで空になりやすい。
      // /search?q=... がHTTP 404でも本文に動画リンクが含まれることがあるため、まずここを試す。
      `https://mat6tube.com/search?q=1`,
      `https://mat6tube.com/search?q=a`,
      `https://mat6tube.com/`, // トップページ
      `https://mat6tube.com/recent`, // 最新っぽいページ
      `https://mat6tube.com/video/`, // /video/パス
      `https://mat6tube.com/latest` // 最新動画ページ（存在しない場合あり）
    ];
    
    let videos = [];
    
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
        
        // すべての処理で共有する重複チェック・カウンタ
        const seenUrls = new Set();
        let foundCount = 0;
        let matchedCount = 0;

        // /video/パスで検索した場合の特別処理
        // /video/パスが含まれている場合は、すべての/video/リンクを取得
        const isVideoPathSearch = url.includes('/video/');
        
        // より積極的なアプローチ：すべてのリンクを確認
        // まず、mat6tube.comドメイン内のすべてのリンクを取得
        const allLinks = $('a[href]');
        console.log(`🔍 Mat6tube: 見つかったリンク総数: ${allLinks.length}`);
        
        // /video/パスで検索した場合、すべての/video/リンクを優先的に取得
        // /video/パスで検索した場合、すべての/video/リンクを直接取得（最優先処理）
        if (isVideoPathSearch) {
          console.log(`🔍 Mat6tube: /video/パス検索を検出、すべての/video/リンクを直接取得します`);
          const videoLinks = $('a[href*="/video/"]');
          console.log(`🔍 Mat6tube: /video/リンク数: ${videoLinks.length}`);
          
          videoLinks.each((index, elem) => {
            if (videos.length >= 200) return false;
            
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
            if (title && title.length > 3) {
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
            if (videos.length >= 200) return false;
            
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
            
            if (title && title.length > 3) {
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
        if (videos.length === 0) {
          console.log(`🔍 Mat6tube: セレクタで見つからなかったため、すべてのリンクを直接確認します`);
          const allLinks = $('a[href]');
          console.log(`🔍 Mat6tube: 見つかったリンク総数: ${allLinks.length}`);
          
          allLinks.each((index, elem) => {
            if (videos.length >= 200) return false;
            
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
            
            if (title && title.length > 3) {
              // strictMode=falseの場合は、タイトルがあれば基本的に追加
              if (!strictMode || isTitleRelevant(title, query, strictMode)) {
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
            }
          });
        }
        
        console.log(`🔍 Mat6tube: 見つかった要素: ${foundCount}件、マッチした要素: ${matchedCount}件、動画: ${videos.length}件`);
        
        // 結果が見つかったらループを抜ける
        if (videos.length > 0) {
          console.log(`✅ Mat6tube: ${videos.length}件の動画を取得（URL: ${url}）`);
          break;
        } else {
          console.log(`ℹ️ Mat6tube: このURLでは結果が見つかりませんでした（URL: ${url}）`);
        }
      } catch (urlError) {
        // 404や403エラーは予想される動作なので、警告を抑制（最初のURLのみ情報を出力）
        const urlIndex = urls.indexOf(url) + 1;
        if (urlIndex === 1 && urlError.response && (urlError.response.status === 404 || urlError.response.status === 403)) {
          console.log(`ℹ️ Mat6tube: 検索エンドポイントが見つかりません（${urlError.response.status}）。他のURLパターンを試行します。`);
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
    const encodedQuery = encodeURIComponent(query);
    // 複数のURLパターンを試す（空のクエリの場合はトップページや最新動画ページから取得）
    const urls = query && query.trim() ? [
      `https://fc2video.org/search?q=${encodedQuery}`,
      `https://fc2video.org/?q=${encodedQuery}`,
      `https://fc2video.org/search/${encodedQuery}`
    ] : [
      `https://fc2video.org/`, // トップページから最新動画を取得
      `https://fc2video.org/latest`, // 最新動画ページ
      `https://fc2video.org/videos` // 動画一覧ページ
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
            if (videos.length >= 200) return false;
            
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
            if (finalTitle && finalTitle.length > 2) {
              // 検索クエリとタイトルの関連性をチェック
              // strictMode=falseの場合は、より緩和した条件でマッチング
              if (!isTitleRelevant(finalTitle, query, strictMode)) {
                // 緩和モードの場合、タイトルが長ければ追加（より柔軟に）
                // タイトルが10文字以上あれば、関連性チェックを緩和
                if (strictMode || finalTitle.length < 10) {
                  return; // 関連性がない場合はスキップ
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

// 直接実行時はHTTPサーバーを起動（node server.js で Cursor/ターミナルが即終了しないようにする）
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log('VMEDA server: http://localhost:' + PORT);
  }).on('error', (err) => {
    console.error('Listen error:', err.message);
    process.exitCode = 1;
  });
}

module.exports = app;
