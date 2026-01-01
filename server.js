const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;

// このサイトを通して検索したワードを保存（MongoDB Atlasに永続化、最新30個を保持）
// 重複を避けるため、同じ検索ワードは最新のもののみ残す
// 30個を超えると古いものから自動的に削除される
// 自分の検索も含めて、すべての検索ワードを履歴として残す
const MAX_RECENT_SEARCHES = 30; // 最新30個だけ保持

// MongoDB接続設定
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = 'vmeda';
const COLLECTION_NAME = 'recent_searches';

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
  const db = await connectToMongoDB();
  if (!db) {
    return [];
  }

  try {
    const collection = db.collection(COLLECTION_NAME);
    const result = await collection.findOne({ _id: 'searches' });
    if (result && Array.isArray(result.searches)) {
      console.log(`📂 MongoDBから検索履歴を読み込み: ${result.searches.length}件`);
      return result.searches;
    }
  } catch (error) {
    console.error('❌ MongoDBからの読み込みエラー:', error.message);
  }
  return [];
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
  recentSearches = await loadRecentSearchesFromMongoDB();
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
  message: 'リクエストが多すぎます。しばらく待ってから再度お試しください。',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// 検索API専用のレート制限（より厳しく）
const searchLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1分
  max: 10, // 1分間に10リクエストまで
  message: '検索リクエストが多すぎます。しばらく待ってから再度お試しください。',
});
app.use('/api/search', searchLimiter);

// JSONペイロードサイズ制限
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// リクエストログ（デバッグ用）
app.use((req, res, next) => {
  const userAgent = req.get('user-agent') || '';
  const isMobile = /iPhone|iPad|iPod|Android/i.test(userAgent);
  console.log(`📱 ${req.method} ${req.path} - ${isMobile ? 'Mobile' : 'Desktop'} - ${userAgent.substring(0, 50)}`);
  next();
});

// 静的ファイル配信（Vercel対応）
app.use(express.static(path.join(__dirname, 'public'), {
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
    }
  }
}));

// 広告設定を提供するAPI（環境変数から）
app.get('/api/ad-config', (req, res) => {
  res.json({
    adClientId: process.env.AD_CLIENT_ID || '',
    adSlotHeader: process.env.AD_SLOT_HEADER || '',
    adSlotFooter: process.env.AD_SLOT_FOOTER || '',
    adSlotInContent: process.env.AD_SLOT_IN_CONTENT || ''
  });
});

// 静的ファイルの明示的なルーティング（Vercel用）
app.get('/app.js', (req, res) => {
  console.log('📄 app.js リクエスト受信');
  res.sendFile(path.join(__dirname, 'public', 'app.js'), {
    headers: { 
      'Content-Type': 'application/javascript',
      'Cache-Control': 'public, max-age=86400'
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
  // 複数の属性とセレクタを試す
  const imgSelectors = [
    'img',
    '.thumbnail img',
    '[class*="thumbnail"] img',
    '[class*="thumb"] img',
    '.poster img',
    '[class*="poster"] img'
  ];
  
  for (const selector of imgSelectors) {
    const $img = $elem.find(selector).first();
    if ($img.length > 0) {
      const thumbnail = $img.attr('src') ||
                       $img.attr('data-src') ||
                       $img.attr('data-lazy-src') ||
                       $img.attr('data-original') ||
                       $img.attr('data-url') ||
                       $img.attr('data-image') ||
                       '';
      
      if (thumbnail) {
        // サムネイルURLを正規化
        if (thumbnail.startsWith('//')) {
          return 'https:' + thumbnail;
        }
        if (thumbnail.startsWith('/') && !thumbnail.startsWith('http')) {
          return thumbnail;
        }
        if (thumbnail.startsWith('http://')) {
          return thumbnail.replace('http://', 'https://');
        }
        if (thumbnail.startsWith('https://')) {
          return thumbnail;
        }
      }
    }
  }
  
  // Google検索結果の場合
  const googleImg = $elem.closest('.g').find('img').first();
  if (googleImg.length > 0) {
    const thumbnail = googleImg.attr('src') || googleImg.attr('data-src') || '';
    if (thumbnail) {
      if (thumbnail.startsWith('//')) {
        return 'https:' + thumbnail;
      }
      return thumbnail;
    }
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

// 入力検証関数
function validateQuery(query) {
  if (!query || typeof query !== 'string') {
    return { valid: false, error: '検索クエリが必要です' };
  }
  
  const trimmed = query.trim();
  
  // 長さチェック
  if (trimmed.length === 0) {
    return { valid: false, error: '検索クエリが空です' };
  }
  
  if (trimmed.length > 200) {
    return { valid: false, error: '検索クエリが長すぎます（最大200文字）' };
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
    const { query } = req.body;
    
    // 入力検証
    const validation = validateQuery(query);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }
    
    const sanitizedQuery = validation.query;
    console.log(`🔍 検索開始: "${sanitizedQuery}"`);
    
    // サーバーレス環境では、毎回MongoDBから最新の検索履歴を読み込む（キャッシュを無効化して最新を取得）
    invalidateRecentSearchesCache();
    let currentSearches = await loadRecentSearchesFromMongoDB();
    
    // このサイトを通して検索したワードを保存（最新30個を保持）
    // プライバシー保護のため、検索ワードのみを保存（IPアドレスやその他の個人情報は収集しない）
    const searchEntry = {
      query: sanitizedQuery
    };
    
    // 同じ検索ワードが既にある場合は削除（重複を避ける）
    const existingIndex = currentSearches.findIndex(entry => entry.query === sanitizedQuery);
    if (existingIndex !== -1) {
      currentSearches.splice(existingIndex, 1);
    }
    
    // 最新の検索ワードを先頭に追加
    currentSearches.unshift(searchEntry);
    
    // 最新30個だけを保持（古いものは自動的に削除）
    if (currentSearches.length > MAX_RECENT_SEARCHES) {
      currentSearches.splice(MAX_RECENT_SEARCHES); // 30個目以降を削除
    }
    
    // MongoDBに保存（永続化）
    await saveRecentSearchesToMongoDB(currentSearches);
    
    // キャッシュを更新（次回の取得を高速化）
    recentSearchesCache = currentSearches;
    recentSearchesCacheTime = Date.now();
    
    console.log(`💾 検索履歴に保存: "${sanitizedQuery}" (合計: ${currentSearches.length}件)`);
    
    // 定義されている検索関数のみを使用
    const allSearches = [
      searchBilibili(sanitizedQuery),
      searchIQiyi(sanitizedQuery),
      searchTencentVideo(sanitizedQuery),
      searchXiguaVideo(sanitizedQuery),
      searchJPdmv(sanitizedQuery),
      searchDouga4(sanitizedQuery),
      searchSpankbang(sanitizedQuery),
      searchX1hub(sanitizedQuery),
      searchPorntube(sanitizedQuery),
      searchJavGuru(sanitizedQuery),
      searchFC2(sanitizedQuery),
      searchAkibaAbv(sanitizedQuery),
      search91Porn(sanitizedQuery),
      searchThisAV(sanitizedQuery),
      searchMadou(sanitizedQuery)
    ];
    
    // すべての検索を並行実行
    console.log(`🚀 ${allSearches.length}個の検索関数を並行実行開始...`);
    const allResults = await Promise.allSettled(allSearches);
    console.log(`✅ すべての検索関数の実行が完了しました（${allResults.length}件）`);
    
    // 結果を統合
    const videos = [];
    const allSiteNames = ['Bilibili', 'iQiyi', 'Tencent Video', 'Xigua Video', 'JPdmv', 'Douga4', 'Spankbang', 'X1hub', 'Porntube', 'JavGuru', 'FC2', 'AkibaAbv', '91Porn', 'ThisAV', 'Madou'];
    
    // 結果を追加（中国サイトの結果が先に来る）
    let totalFromSites = 0;
    let successCount = 0;
    let errorCount = 0;
    let zeroCount = 0;
    
    console.log(`📊 各サイトの検索結果を確認中...`);
    allResults.forEach((result, index) => {
      const siteName = allSiteNames[index] || `Unknown[${index}]`;
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
        }
      }
    });
    
    console.log(`📊 検索結果サマリー: 成功${successCount}サイト、エラー${errorCount}サイト、0件${zeroCount}サイト`);
    
    console.log(`📊 検索結果サマリー: 全${videos.length}件の動画を取得（${allSiteNames.length}サイトから検索、合計${totalFromSites}件）`);
    
    // 重複を除去（URLベース）& YouTubeを除外
    const uniqueVideos = [];
    const seenUrls = new Set();
    videos.forEach(video => {
      // YouTubeを除外
      if (video.url && (video.url.includes('youtube.com') || video.url.includes('youtu.be'))) {
        return;
      }
      if (video.source === 'youtube') {
        return;
      }
      
      if (!seenUrls.has(video.url)) {
        seenUrls.add(video.url);
        uniqueVideos.push(video);
      }
    });
    
    console.log(`✅ 検索完了: ${uniqueVideos.length}件の結果を取得（重複除去後）`);
    console.log(`📊 詳細: 統合前${videos.length}件 → 重複除去後${uniqueVideos.length}件`);
    console.log(`📊 カウント確認: 成功${successCount}、エラー${errorCount}、0件${zeroCount}`);
    
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
    if (uniqueVideos.length === 0) {
      console.warn('⚠️ 検索結果が0件のため、テストデータを返します');
      uniqueVideos.push({
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
    const responseData = { results: uniqueVideos, debug: debugInfo };
    console.log(`📤 レスポンス送信: results=${uniqueVideos.length}件, debug=${debugInfo ? 'あり' : 'なし'}`);
    res.json(responseData);
  } catch (error) {
    console.error('❌ 検索エラー:', error.message);
    console.error('❌ スタックトレース:', error.stack);
    // エラーの詳細情報をクライアントに送信しない（セキュリティ対策）
    // ただし、開発環境では詳細を返す
    if (process.env.NODE_ENV !== 'production') {
      console.error('❌ エラー詳細:', error);
    }
    res.status(500).json({ error: '検索に失敗しました。しばらく待ってから再度お試しください。' });
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
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
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
async function searchJPdmv(query) {
  try {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://jpdmv.com/search/${encodedQuery}`;
    
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
      
      const fullUrl = href.startsWith('http') ? href : `https://jpdmv.com${href}`;
      const title = extractTitle($, $item);
      const thumbnail = extractThumbnail($, $item);
      const duration = extractDurationFromHtml($, $item);
      
      if (title && title.length > 3) {
        videos.push({
          id: `jpdmv-${Date.now()}-${index}`,
          title: title.substring(0, 200),
          thumbnail: thumbnail || '',
          duration: duration || '',
          url: fullUrl,
          embedUrl: fullUrl,
          source: 'jpdmv'
        });
      }
    });
    
    console.log(`✅ JPdmv: ${videos.length}件の動画を取得`);
    return videos;
  } catch (error) {
    console.error('JPdmv検索エラー:', error.message);
    return [];
  }
}

// Douga4検索
async function searchDouga4(query) {
  try {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://av.douga4.top/kw/${encodedQuery}`;
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'ja,en-US;q=0.9'
      },
      timeout: 30000
    });
    
    const $ = cheerio.load(response.data);
    const videos = [];
    
    $('.item, .video-item, a[href*="/video/"]').each((index, elem) => {
      
      const $item = $(elem);
      const href = $item.attr('href') || $item.find('a').attr('href') || '';
      if (!href || !href.includes('/video/')) return;
      
      const fullUrl = href.startsWith('http') ? href : `https://av.douga4.top${href}`;
      const title = extractTitle($, $item);
      const thumbnail = extractThumbnail($, $item);
      const duration = extractDurationFromHtml($, $item);
      
      if (title && title.length > 3) {
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
    
    console.log(`✅ Douga4: ${videos.length}件の動画を取得`);
    return videos;
  } catch (error) {
    console.error('Douga4検索エラー:', error.message);
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
        'Accept-Language': 'ja,en-US;q=0.9',
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
async function searchX1hub(query) {
  try {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://x1hub.com/search/${encodedQuery}`;
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'ja,en-US;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': 'https://x1hub.com/'
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
        
        const fullUrl = href.startsWith('http') ? href : `https://x1hub.com${href}`;
        const title = extractTitle($, $item);
        const thumbnail = extractThumbnail($, $item);
        const duration = extractDurationFromHtml($, $item);
        
        if (title && title.length > 3) {
          // 重複チェック
          const isDuplicate = videos.some(v => v.url === fullUrl);
          if (!isDuplicate) {
            videos.push({
              id: `x1hub-${Date.now()}-${index}`,
              title: title.substring(0, 200),
              thumbnail: thumbnail || '',
              duration: duration || '',
              url: fullUrl,
              embedUrl: fullUrl,
              source: 'x1hub'
            });
          }
        }
      });
    });
    
    console.log(`✅ X1hub: ${videos.length}件の動画を取得`);
    return videos;
  } catch (error) {
    console.error('X1hub検索エラー:', error.message);
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
        'Accept-Language': 'ja,en-US;q=0.9',
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
        'Accept-Language': 'ja,en-US;q=0.9',
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
async function searchJapanhub(query) {
  try {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://japanhub.net/search/${encodedQuery}`;
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'ja,en-US;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': 'https://japanhub.net/'
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
        
        const fullUrl = href.startsWith('http') ? href : `https://japanhub.net${href}`;
        const title = extractTitle($, $item);
        const thumbnail = extractThumbnail($, $item);
        const duration = extractDurationFromHtml($, $item);
        
        if (title && title.length > 3) {
          // 重複チェック
          const isDuplicate = videos.some(v => v.url === fullUrl);
          if (!isDuplicate) {
            videos.push({
              id: `japanhub-${Date.now()}-${index}`,
              title: title.substring(0, 200),
              thumbnail: thumbnail || '',
              duration: duration || '',
              url: fullUrl,
              embedUrl: fullUrl,
              source: 'japanhub'
            });
          }
        }
      });
    });
    
    console.log(`✅ Japanhub: ${videos.length}件の動画を取得`);
    return videos;
  } catch (error) {
    console.error('Japanhub検索エラー:', error.message);
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
        'Accept-Language': 'ja,en-US;q=0.9',
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
        'Accept-Language': 'ja,en-US;q=0.9',
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
async function searchBilibili(query) {
  try {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://search.bilibili.com/all?keyword=${encodedQuery}`;
    
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
        'Accept-Language': 'ja,en-US;q=0.9',
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

// 検索履歴を取得するAPI（このサイトを通して検索したワードを最新30個返す）
app.get('/api/recent-searches', async (req, res) => {
  try {
    // キャッシュ付きで検索履歴を取得（高速化）
    const allSearches = await getRecentSearchesCached();
    
    // このサイトを通して検索したワードを最新30個返す
    // 自分の検索も他の人の検索も含めて、すべての検索ワードを履歴として表示
    // 検索ワードのみを返す（時間情報は不要）
    const searches = allSearches
      .slice(0, MAX_RECENT_SEARCHES) // 最新30件
      .map(entry => ({
        query: entry.query
      }));
    
    console.log(`📋 検索履歴取得: ${searches.length}件 (全検索: ${allSearches.length}件)`);
    if (searches.length > 0) {
      console.log(`📋 検索履歴サンプル: ${searches.slice(0, 3).map(s => s.query).join(', ')}`);
    }
    
    // キャッシュヘッダーを追加（クライアント側のキャッシュを有効化）
    res.set({
      'Cache-Control': 'public, max-age=5', // 5秒間キャッシュ
      'ETag': `"${searches.length}-${Date.now()}"` // ETagでキャッシュ検証
    });
    
    res.json({ searches: searches });
  } catch (error) {
    console.error('❌ 検索履歴取得エラー:', error);
    res.status(500).json({ error: '検索履歴の取得に失敗しました' });
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
      return res.status(400).json({ error: 'douga4のURLが必要です' });
    }
    
    console.log('📺 douga4動画URL取得リクエスト:', videoUrl);
    
    // デスクトップのUser-Agentでリクエスト
    const response = await axios.get(videoUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'ja,en-US;q=0.9',
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
    
    console.log('✅ douga4動画URL取得:', embedUrl);
    res.json({ embedUrl: embedUrl, originalUrl: videoUrl });
  } catch (error) {
    console.error('❌ douga4動画URL取得エラー:', error.message);
    res.status(500).json({ error: '動画URLの取得に失敗しました', embedUrl: req.query.url });
  }
});

// 動画プロキシエンドポイント（iPhoneでデスクトップに偽装）
app.get('/api/proxy-video', async (req, res) => {
  try {
    const videoUrl = req.query.url;
    if (!videoUrl) {
      return res.status(400).json({ error: 'URLパラメータが必要です' });
    }
    
    console.log('📺 動画プロキシリクエスト:', videoUrl);
    
    // デスクトップのUser-Agentでリクエスト
    const response = await axios.get(videoUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'ja,en-US;q=0.9',
        'Referer': videoUrl,
        'Accept-Encoding': 'gzip, deflate, br'
      },
      timeout: 30000,
      maxRedirects: 5,
      responseType: 'arraybuffer'
    });
    
    // レスポンスヘッダーを転送
    res.set({
      'Content-Type': response.headers['content-type'] || 'text/html',
      'Cache-Control': 'public, max-age=3600'
    });
    
    res.send(response.data);
  } catch (error) {
    console.error('❌ 動画プロキシエラー:', error.message);
    res.status(500).json({ error: '動画の取得に失敗しました' });
  }
});

// ルートパス - index.htmlを返す
app.get('/', (req, res) => {
  console.log('🏠 ルートパス リクエスト受信');
  const userAgent = req.get('user-agent') || '';
  const isMobile = /iPhone|iPad|iPod|Android/i.test(userAgent);
  console.log(`📱 デバイス: ${isMobile ? 'Mobile' : 'Desktop'} - ${userAgent.substring(0, 80)}`);
  
  res.sendFile(path.join(__dirname, 'public', 'index.html'), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache'
    }
  }, (err) => {
    if (err) {
      console.error('❌ index.html送信エラー:', err);
      res.status(500).send('Internal Server Error');
    } else {
      console.log('✅ index.html送信成功');
    }
  });
});

// Favicon
app.get('/favicon.ico', (req, res) => {
  res.status(204).end();
});

// サーバー起動（Vercel以外の環境用）
if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`🚀 サーバー起動: http://localhost:${PORT}`);
  });
}

// Vercel用にエクスポート
module.exports = app;
