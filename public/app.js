// グローバルエラーハンドラー（外部リソースの読み込みエラーを抑制）
window.addEventListener('error', (event) => {
  // 外部サイトのリソース読み込みエラーを抑制
  if (event.target && (
    event.target.tagName === 'IMG' ||
    event.target.tagName === 'LINK' ||
    event.target.tagName === 'SCRIPT' ||
    event.target.tagName === 'IFRAME'
  )) {
    // SSL証明書エラー、DNS解決エラー、CORSエラーなどを抑制
    if (
      event.message.includes('ERR_CERT') ||
      event.message.includes('ERR_NAME_NOT_RESOLVED') ||
      event.message.includes('ERR_BLOCKED_BY_RESPONSE') ||
      event.message.includes('ERR_SSL_PROTOCOL') ||
      event.message.includes('ERR_HTTP2_PROTOCOL') ||
      event.message.includes('NotSameOrigin') ||
      event.message.includes('403') ||
      event.message.includes('400')
    ) {
      event.preventDefault();
      event.stopPropagation();
      return false;
    }
  }
  
  // iframeの警告メッセージを抑制（playsinline、allowfullscreenなど）
  if (event.message && (
    event.message.includes('Unrecognized feature') ||
    event.message.includes('Allow attribute will take precedence') ||
    event.message.includes('playsinline') ||
    event.message.includes('allowfullscreen')
  )) {
    event.preventDefault();
    event.stopPropagation();
    return false;
  }
}, true);

// 未処理のPromise拒否を抑制
window.addEventListener('unhandledrejection', (event) => {
  // 外部サイトのエラーを抑制
  if (event.reason && (
    event.reason.message && (
      event.reason.message.includes('ERR_CERT') ||
      event.reason.message.includes('ERR_NAME_NOT_RESOLVED') ||
      event.reason.message.includes('ERR_BLOCKED_BY_RESPONSE') ||
      event.reason.message.includes('ERR_SSL_PROTOCOL') ||
      event.reason.message.includes('403') ||
      event.reason.message.includes('400')
    )
  )) {
    event.preventDefault();
  }
});

// console.warnとconsole.errorをオーバーライドして警告を抑制
const originalWarn = console.warn;
const originalError = console.error;

console.warn = function(...args) {
  const message = args.join(' ');
  // 特定の警告メッセージを抑制
  if (
    message.includes('Unrecognized feature') ||
    message.includes('playsinline') ||
    message.includes('allowfullscreen') ||
    message.includes('Allow attribute will take precedence') ||
    message.includes('Origin-Agent-Cluster') ||
    message.includes('Content Security Policy directive') ||
    message.includes('base-uri') ||
    message.includes('script-src') ||
    message.includes('style-src') ||
    message.includes('WebAssembly')
  ) {
    return; // 警告を抑制
  }
  originalWarn.apply(console, args);
};

console.error = function(...args) {
  const message = args.join(' ');
  // 特定のエラーメッセージを抑制
  if (
    message.includes('Unrecognized feature') ||
    message.includes('playsinline') ||
    message.includes('allowfullscreen') ||
    message.includes('Allow attribute will take precedence') ||
    message.includes('Origin-Agent-Cluster') ||
    message.includes('Content Security Policy directive') ||
    message.includes('base-uri') ||
    message.includes('script-src') ||
    message.includes('style-src') ||
    message.includes('WebAssembly') ||
    message.includes('checkDevTools is not defined') ||
    message.includes('TemplateCustomizer is not defined')
  ) {
    return; // エラーを抑制
  }
  originalError.apply(console, args);
};


// 検索機能
const searchInput = document.getElementById('search-input');
const searchBtn = document.getElementById('search-btn');
const resultsDiv = document.getElementById('results');
const loadingDiv = document.getElementById('loading');
const recentSearchesDiv = document.getElementById('recent-searches');
const recentSearchesList = document.getElementById('recent-searches-list');
const sortContainer = document.getElementById('sort-container');
const sortSelect = document.getElementById('sort-select');
const ivRandomBtn = document.getElementById('iv-random-btn');
const javRandomBtn = document.getElementById('jav-random-btn');

// 現在の検索結果を保持
let currentVideos = [];
// ページネーション用の変数
let currentPage = 1; // 現在のページ番号
const VIDEOS_PER_PAGE = 10; // 1ページに表示する動画数
let totalPages = 1; // 総ページ数

// 検索実行
async function searchVideos(query) {
  // 空のクエリや空白のみのクエリは検索しない
  if (!query || query.trim().length === 0) {
    console.log('⚠️ 空の検索クエリは無視されます');
    return;
  }
  
  // デフォルトの「動画」というワードでの検索を完全に防止（いかなる場合も実行しない）
  const trimmedQuery = query.trim();
  if (trimmedQuery === '動画') {
    console.log('⚠️ デフォルトの「動画」検索は完全に無効化されています');
    return;
  }
  
  console.log('🔍 検索実行:', trimmedQuery);

  loadingDiv.classList.remove('hidden');
  resultsDiv.innerHTML = '';

  try {
    console.log('🔍 検索開始:', query);
    
    const response = await fetch('/api/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query: query.trim() })
    });

    console.log('📡 レスポンス受信:', response.status, response.statusText);

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || 'Search failed');
    }

    const data = await response.json();
    console.log('📊 検索結果:', data.results?.length || 0, '件');
    console.log('🔍 データ構造確認:', Object.keys(data));
    console.log('🔍 デバッグ情報の有無:', data.debug ? 'あり' : 'なし');
    
    // デバッグ情報を表示
    if (data.debug) {
      console.log('🔍 デバッグ情報:', data.debug);
      console.log(`📊 各サイトの検索結果:`);
      data.debug.siteResults.forEach(site => {
        if (site.status === 'success' && site.count > 0) {
          console.log(`  ✅ ${site.site}: ${site.count}件`);
        } else if (site.status === 'success' && site.count === 0) {
          console.log(`  ℹ️ ${site.site}: 0件`);
        } else {
          console.log(`  ❌ ${site.site}: エラー (${site.error})`);
        }
      });
      console.log(`📊 サマリー: 成功${data.debug.successSites}サイト、エラー${data.debug.errorSites}サイト、0件${data.debug.zeroResultSites}サイト`);
      console.log(`📊 統合前: ${data.debug.totalBeforeDedup}件 → 重複除去後: ${data.debug.totalAfterDedup}件`);
    }
    
    if (!data.results || data.results.length === 0) {
      console.warn('⚠️ 検索結果が空です。テストデータが返されているか確認してください。');
    }
    
    const videos = data.results || [];
    currentVideos = videos;
    currentPage = 1; // 検索時にリセット
    totalPages = Math.ceil(videos.length / VIDEOS_PER_PAGE); // 総ページ数を計算
    displayResults(videos, query.trim());
    
    // ソートUIを表示
    if (videos.length > 0) {
      sortContainer.classList.remove('hidden');
    } else {
      sortContainer.classList.add('hidden');
    }
    
    // 検索実行後、検索履歴を更新
    setTimeout(() => {
      loadRecentSearches();
    }, 1000);
  } catch (error) {
    console.error('❌ 検索エラー:', error);
    resultsDiv.innerHTML = `<div class="error">検索エラー: ${error.message}</div>`;
  } finally {
    loadingDiv.classList.add('hidden');
  }
}

// 結果表示（ページネーション対応）
function displayResults(videos, searchQuery) {
  if (videos.length === 0) {
    resultsDiv.innerHTML = `
      <div class="no-results">検索結果が見つかりませんでした</div>
    `;
    // ページネーションを非表示
    const paginationDiv = document.getElementById('pagination');
    if (paginationDiv) {
      paginationDiv.innerHTML = '';
    }
    return;
  }

  // 総ページ数を再計算
  totalPages = Math.ceil(videos.length / VIDEOS_PER_PAGE);
  
  // 現在のページに表示する動画を取得
  const startIndex = (currentPage - 1) * VIDEOS_PER_PAGE;
  const endIndex = startIndex + VIDEOS_PER_PAGE;
  const videosToShow = videos.slice(startIndex, endIndex);
  
  if (videosToShow.length === 0) {
    // ページが存在しない場合は1ページ目に戻す
    currentPage = 1;
    const firstPageVideos = videos.slice(0, VIDEOS_PER_PAGE);
    if (firstPageVideos.length === 0) {
      resultsDiv.innerHTML = `
        <div class="no-results">検索結果が見つかりませんでした</div>
      `;
      return;
    }
    return displayResults(videos, searchQuery);
  }

  const html = videosToShow.map(video => {
    // サムネイルURLを正規化（相対パスを絶対URLに変換）
    let thumbnail = video.thumbnail || '';
    if (thumbnail) {
      // 相対パス（//で始まる）をhttps:に変換
      if (thumbnail.startsWith('//')) {
        thumbnail = 'https:' + thumbnail;
      }
      // 相対パス（/で始まる）を絶対URLに変換
      else if (thumbnail.startsWith('/') && !thumbnail.startsWith('http')) {
        const url = new URL(video.url || 'https://example.com');
        thumbnail = url.origin + thumbnail;
      }
      // http://で始まる場合はhttps://に変換（セキュリティのため）
      else if (thumbnail.startsWith('http://')) {
        thumbnail = thumbnail.replace('http://', 'https://');
      }
    }
    
    // サムネイルが取得されていない場合のフォールバック処理
    if (!thumbnail || thumbnail.length === 0) {
      // IVFreeの場合は、タイトルからIDを抽出してデフォルト画像を表示
      if (video.source === 'ivfree') {
        const idMatch = video.title.match(/\[([A-Z]+-\d+)\]/);
        if (idMatch) {
          const id = idMatch[1].toLowerCase();
          thumbnail = `http://ivfree.asia/images/${id}.jpg`;
        }
      }
      // その他のサイトでも、URLからサムネイルを推測
      if (!thumbnail && video.url) {
        // URLから画像パスを推測（一般的なパターン）
        const urlMatch = video.url.match(/(https?:\/\/[^\/]+)/);
        if (urlMatch) {
          const baseUrl = urlMatch[1];
          // 一般的なサムネイルパスを試す
          const possiblePaths = [
            '/thumb.jpg',
            '/thumbnail.jpg',
            '/cover.jpg',
            '/poster.jpg',
            '/image.jpg'
          ];
          // デフォルト画像として、プレースホルダー画像を使用
          thumbnail = `https://via.placeholder.com/640x360/667eea/ffffff?text=${encodeURIComponent(video.title.substring(0, 20))}`;
        }
      }
      // それでもサムネイルがない場合は、プレースホルダー画像を使用
      if (!thumbnail || thumbnail.length === 0) {
        thumbnail = `https://via.placeholder.com/640x360/667eea/ffffff?text=${encodeURIComponent(video.title.substring(0, 20))}`;
      }
    }
    
    const hasThumbnail = thumbnail && thumbnail.length > 0 && (thumbnail.startsWith('http://') || thumbnail.startsWith('https://') || thumbnail.startsWith('data:'));
    
    const duration = video.duration || '';
    const showDuration = duration && duration.trim().length > 0;
    
    // Bilibiliの動画の場合はアイコンを変更
    const isBilibili = video.source === 'bilibili';
    const playIcon = isBilibili ? '📺' : '▶';
    
    return `
    <div class="video-item" data-source="${video.source || ''}">
      <div class="video-header">
        <h3 class="video-title">${escapeHtml(video.title)}</h3>
        <div class="video-header-right">
          ${showDuration ? `<span class="video-duration">${escapeHtml(duration)}</span>` : ''}
          <span class="video-source">${getSourceName(video.source)}</span>
        </div>
      </div>
      <div class="video-player-container" id="player-${video.id}">
        ${hasThumbnail ? `
          <div class="video-thumbnail-wrapper" onclick="showPlayer('${video.id}', '${escapeHtml(video.embedUrl)}', '${escapeHtml(video.url)}', '${video.source || ''}', event)">
            <img src="${escapeHtml(thumbnail)}" alt="${escapeHtml(video.title)}" class="video-thumbnail" loading="lazy" onerror="this.onerror=null; this.style.display='none'; const overlay = this.nextElementSibling; if(overlay) { overlay.style.display='flex'; overlay.style.opacity='1'; }">
            <div class="play-overlay">
              <button class="play-btn-thumbnail ${isBilibili ? 'bilibili-icon' : ''}">${playIcon}</button>
            </div>
          </div>
        ` : `
          <button class="play-btn" onclick="showPlayer('${video.id}', '${escapeHtml(video.embedUrl)}', '${escapeHtml(video.url)}', '${video.source || ''}', event)">
            ${playIcon} 再生
          </button>
        `}
      </div>
    </div>
  `;
  }).join('');

  // HTMLを表示
  resultsDiv.innerHTML = html;
  
  // iPhoneでのタッチイベントをクリックイベントとして処理
  // 動画プレイヤーコンテナにタッチイベントリスナーを追加（新しく追加された動画のみ）
  videosToShow.forEach(video => {
    const videoElement = document.getElementById(`player-${video.id}`);
    if (videoElement) {
      const thumbnailWrapper = videoElement.querySelector('.video-thumbnail-wrapper');
      const playBtn = videoElement.querySelector('.play-btn');
      
      [thumbnailWrapper, playBtn].filter(Boolean).forEach(element => {
        // タッチイベントを検出してクリックイベントとして処理
        element.addEventListener('touchend', function(e) {
          // タッチイベントをクリックイベントとして扱う（ユーザーの直接的な操作として）
          e.preventDefault();
          // クリックイベントを発火（ユーザーの直接的な操作として扱う）
          const clickEvent = new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            view: window,
            detail: 1,
            buttons: 1
          });
          this.dispatchEvent(clickEvent);
        }, { passive: false });
      });
    }
  });
  
  // 検索結果表示後、広告を検索結果の間に挿入
  insertAdsInResults();
  
  // ページネーションを表示
  displayPagination();
}

// ページネーション表示
function displayPagination() {
  let paginationDiv = document.getElementById('pagination');
  if (!paginationDiv) {
    // ページネーション用のdivを作成
    paginationDiv = document.createElement('div');
    paginationDiv.id = 'pagination';
    paginationDiv.className = 'pagination';
    resultsDiv.parentNode.insertBefore(paginationDiv, resultsDiv.nextSibling);
  }
  
  if (totalPages <= 1) {
    // 1ページ以下の場合はページネーションを非表示
    paginationDiv.innerHTML = '';
    return;
  }
  
  let paginationHTML = '<div class="pagination-container">';
  
  // 前へボタン
  if (currentPage > 1) {
    paginationHTML += `<button class="pagination-btn" onclick="goToPage(${currentPage - 1})">‹ 前へ</button>`;
  } else {
    paginationHTML += `<button class="pagination-btn disabled" disabled>‹ 前へ</button>`;
  }
  
  // ページ番号ボタン
  const maxVisiblePages = 5; // 表示する最大ページ数
  let startPage = Math.max(1, currentPage - Math.floor(maxVisiblePages / 2));
  let endPage = Math.min(totalPages, startPage + maxVisiblePages - 1);
  
  if (endPage - startPage < maxVisiblePages - 1) {
    startPage = Math.max(1, endPage - maxVisiblePages + 1);
  }
  
  if (startPage > 1) {
    paginationHTML += `<button class="pagination-btn" onclick="goToPage(1)">1</button>`;
    if (startPage > 2) {
      paginationHTML += `<span class="pagination-ellipsis">...</span>`;
    }
  }
  
  for (let i = startPage; i <= endPage; i++) {
    if (i === currentPage) {
      paginationHTML += `<button class="pagination-btn active">${i}</button>`;
    } else {
      paginationHTML += `<button class="pagination-btn" onclick="goToPage(${i})">${i}</button>`;
    }
  }
  
  if (endPage < totalPages) {
    if (endPage < totalPages - 1) {
      paginationHTML += `<span class="pagination-ellipsis">...</span>`;
    }
    paginationHTML += `<button class="pagination-btn" onclick="goToPage(${totalPages})">${totalPages}</button>`;
  }
  
  // 次へボタン
  if (currentPage < totalPages) {
    paginationHTML += `<button class="pagination-btn" onclick="goToPage(${currentPage + 1})">次へ ›</button>`;
  } else {
    paginationHTML += `<button class="pagination-btn disabled" disabled>次へ ›</button>`;
  }
  
  paginationHTML += '</div>';
  paginationHTML += `<div class="pagination-info">ページ ${currentPage} / ${totalPages} (全 ${currentVideos.length} 件)</div>`;
  
  paginationDiv.innerHTML = paginationHTML;
}

// ページ移動関数（グローバルスコープに公開）
window.goToPage = function(page) {
  if (page < 1 || page > totalPages) return;
  currentPage = page;
  displayResults(currentVideos, '');
  // ページトップにスクロール
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// 再生時間を秒に変換する関数
function durationToSeconds(duration) {
  if (!duration || typeof duration !== 'string') return 0;
  
  // "10:30" 形式を秒に変換
  const parts = duration.trim().split(':');
  if (parts.length === 2) {
    const minutes = parseInt(parts[0], 10) || 0;
    const seconds = parseInt(parts[1], 10) || 0;
    return minutes * 60 + seconds;
  } else if (parts.length === 3) {
    // "1:10:30" 形式（時:分:秒）
    const hours = parseInt(parts[0], 10) || 0;
    const minutes = parseInt(parts[1], 10) || 0;
    const seconds = parseInt(parts[2], 10) || 0;
    return hours * 3600 + minutes * 60 + seconds;
  }
  
  // 数値のみの場合は秒として扱う
  const num = parseInt(duration, 10);
  return isNaN(num) ? 0 : num;
}

// 動画IDからタイムスタンプを抽出
function extractTimestampFromId(id) {
  if (!id) return 0;
  // ID形式: "source-timestamp-index"
  const parts = id.split('-');
  for (const part of parts) {
    const timestamp = parseInt(part, 10);
    if (!isNaN(timestamp) && timestamp > 1000000000000) {
      // タイムスタンプ（ミリ秒）として扱う
      return timestamp;
    }
  }
  return 0;
}

// ソート関数
function sortVideos(videos, sortType) {
  const sorted = [...videos];
  
  switch (sortType) {
    case 'duration-desc':
      // 再生時間が長い順
      sorted.sort((a, b) => {
        const aSeconds = durationToSeconds(a.duration);
        const bSeconds = durationToSeconds(b.duration);
        return bSeconds - aSeconds;
      });
      break;
      
    case 'duration-asc':
      // 再生時間が短い順
      sorted.sort((a, b) => {
        const aSeconds = durationToSeconds(a.duration);
        const bSeconds = durationToSeconds(b.duration);
        return aSeconds - bSeconds;
      });
      break;
      
    case 'date-desc':
      // 追加日時の新しい順
      sorted.sort((a, b) => {
        const aTimestamp = extractTimestampFromId(a.id);
        const bTimestamp = extractTimestampFromId(b.id);
        return bTimestamp - aTimestamp;
      });
      break;
      
    case 'date-asc':
      // 追加日時の古い順
      sorted.sort((a, b) => {
        const aTimestamp = extractTimestampFromId(a.id);
        const bTimestamp = extractTimestampFromId(b.id);
        return aTimestamp - bTimestamp;
      });
      break;
      
    case 'title-asc':
      // タイトル順（A-Z）
      sorted.sort((a, b) => {
        const aTitle = (a.title || '').toLowerCase();
        const bTitle = (b.title || '').toLowerCase();
        return aTitle.localeCompare(bTitle, 'ja');
      });
      break;
      
    case 'title-desc':
      // タイトル順（Z-A）
      sorted.sort((a, b) => {
        const aTitle = (a.title || '').toLowerCase();
        const bTitle = (b.title || '').toLowerCase();
        return bTitle.localeCompare(aTitle, 'ja');
      });
      break;
      
    case 'source-asc':
      // ソース順
      sorted.sort((a, b) => {
        const aSource = (a.source || '').toLowerCase();
        const bSource = (b.source || '').toLowerCase();
        return aSource.localeCompare(bSource, 'ja');
      });
      break;
      
    case 'default':
    default:
      // デフォルト（変更なし）
      break;
  }
  
  return sorted;
}

// 検索履歴を取得（自分の検索も他の人の検索も含む）
// 現在表示中の検索履歴を保持（更新失敗時も消えないように）
let currentDisplayedSearches = [];
let isLoadingRecentSearches = false; // 取得中フラグ
let lastLoadTime = 0; // 最後に取得した時刻
let hasLoadedOnce = false; // 一度でも取得に成功したか
let retryCount = 0; // リトライ回数
const LOAD_INTERVAL = 5000; // 5秒以内の再取得はスキップ
const MAX_RETRIES = 3; // 最大リトライ回数

async function loadRecentSearches(forceRetry = false) {
  // recentSearchesDivとrecentSearchesListが存在するか確認
  if (!recentSearchesDiv || !recentSearchesList) {
    console.error('❌ 検索履歴のDOM要素が見つかりません');
    // DOM要素がまだない場合は、少し待ってから再試行
    if (!forceRetry && retryCount < MAX_RETRIES) {
      setTimeout(() => {
        retryCount++;
        loadRecentSearches(true);
      }, 100);
    }
    return;
  }

  // 既に取得中の場合はスキップ（リトライ時は除く）
  if (isLoadingRecentSearches && !forceRetry) {
    console.log('ℹ️ 検索履歴の取得中です。スキップします。');
    return;
  }

  // 最近取得した場合はスキップ（5秒以内、ただし初回取得時やリトライ時は除く）
  const now = Date.now();
  if (!forceRetry && hasLoadedOnce && lastLoadTime > 0 && (now - lastLoadTime) < LOAD_INTERVAL) {
    console.log('ℹ️ 最近取得済みです。スキップします。');
    return;
  }

  // 検索履歴エリアを確実に表示（即座に表示）
  recentSearchesDiv.style.display = 'block';
  
  // 既に検索履歴が表示されている場合は、ローディング表示を上書きしない
  if (currentDisplayedSearches.length === 0) {
    // データ取得中は必ずローディング状態を表示
    recentSearchesList.innerHTML = '<p class="loading-searches">検索履歴を取得中...</p>';
  }

  // 取得中フラグを設定
  isLoadingRecentSearches = true;
  lastLoadTime = now;

  try {
    // 検索履歴を最優先で取得（最新のデータを取得するためキャッシュを無効化）
    const response = await fetch('/api/recent-searches', {
      cache: 'no-store', // キャッシュを無効化して最新のデータを取得
      priority: 'high', // 優先度を高く設定
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      }
    });
    if (!response.ok) {
      console.error('❌ 検索履歴取得エラー:', response.status, response.statusText);
      // エラー時は既存の表示を保持（取得済みの検索履歴がある場合）
      if (currentDisplayedSearches.length > 0) {
        console.log('ℹ️ エラー時は既存の検索履歴を保持します');
        displayRecentSearches(currentDisplayedSearches);
        return;
      }
      // 既存の表示がない場合はエラーメッセージを表示
      recentSearchesList.innerHTML = '<p class="no-recent-searches">Failed to retrieve search history</p>';
      return;
    }
    
    const data = await response.json();
    const searches = data.searches || [];
    console.log('📋 検索履歴取得:', searches.length, '件');
    console.log('📋 検索履歴データ:', JSON.stringify(searches.slice(0, 3)));
    
    // 取得成功フラグを設定
    hasLoadedOnce = true;
    retryCount = 0; // リトライ回数をリセット
    
    // 検索履歴を常に表示（空の場合も含む）
    if (searches.length > 0) {
      console.log('📋 検索履歴サンプル:', searches.slice(0, 5).map(s => s.query).join(', '));
      // 新しい検索履歴を表示
      currentDisplayedSearches = searches;
      displayRecentSearches(searches);
    } else {
      // 検索履歴が空の場合でも表示を更新
      console.log('ℹ️ 検索履歴が空です');
      currentDisplayedSearches = [];
      displayRecentSearches([]);
    }
    
    console.log('✅ 検索履歴エリアを表示しました');
  } catch (error) {
    console.error('❌ 検索履歴取得エラー:', error);
    
    // エラー時は既存の表示を保持（取得済みの検索履歴がある場合）
    if (currentDisplayedSearches.length > 0) {
      console.log('ℹ️ エラー時は既存の検索履歴を保持します');
      displayRecentSearches(currentDisplayedSearches);
      hasLoadedOnce = true; // 既存のデータがあるので成功とみなす
    } else {
      // 既存の表示がない場合、リトライを試みる
      if (retryCount < MAX_RETRIES) {
        console.log(`🔄 検索履歴取得をリトライします (${retryCount + 1}/${MAX_RETRIES})`);
        retryCount++;
        setTimeout(() => {
          loadRecentSearches(true);
        }, 1000 * (retryCount + 1)); // リトライ回数に応じて待機時間を増やす
      } else {
        // リトライ回数を超えた場合はエラーメッセージを表示
        recentSearchesList.innerHTML = '<p class="no-recent-searches">Failed to retrieve search history</p>';
      }
    }
  } finally {
    // 取得中フラグを解除（リトライ時は除く）
    if (!forceRetry || retryCount >= MAX_RETRIES) {
      isLoadingRecentSearches = false;
    }
  }
}

// 検索履歴を表示（検索ワードのみ羅列）
function displayRecentSearches(searches) {
  // recentSearchesListが存在するか確認
  if (!recentSearchesList) {
    console.error('❌ recentSearchesListが見つかりません');
    return;
  }

  if (!searches || searches.length === 0) {
    // 検索履歴が空の場合は何も表示しない
    recentSearchesList.innerHTML = '';
    console.log('ℹ️ 検索履歴が空です');
    return;
  }
  
  // 現在表示中の検索履歴を更新
  currentDisplayedSearches = searches;
  
  const html = searches.map((search, index) => {
    if (!search || !search.query) {
      console.warn('⚠️ 無効な検索履歴:', search);
      return '';
    }
    // 検索ワードを短縮（長すぎる場合は省略）
    const displayQuery = search.query.length > 20 ? search.query.substring(0, 20) + '...' : search.query;
    const query = escapeHtml(search.query);
    // 「動画」というワードの場合は検索を実行しない（検索入力欄に設定するだけ）
    const isDefaultQuery = query.trim() === '動画';
    return `
      <div class="recent-search-item" onclick="const q='${query}'; const input=document.getElementById('search-input'); if(input) { input.value=q; ${isDefaultQuery ? '/* 動画というワードは検索しない */' : 'searchVideos(q);'} }" title="${query}">
        <span class="recent-search-query">${escapeHtml(displayQuery)}</span>
      </div>
    `;
  }).filter(html => html !== '').join('');
  
  if (html) {
    recentSearchesList.innerHTML = html;
    console.log('✅ 検索履歴を表示:', searches.length, '件');
  } else {
    console.warn('⚠️ 検索履歴のHTMLが生成できませんでした');
    recentSearchesList.innerHTML = '<p class="no-recent-searches">検索履歴の表示に失敗しました</p>';
  }
}

// ページ読み込み時に検索履歴エリアを即座に表示（データ取得前に表示）
if (recentSearchesDiv && recentSearchesList) {
  recentSearchesDiv.style.display = 'block';
  // 初期状態でローディング表示（取得中を表示）
  recentSearchesList.innerHTML = '<p class="loading-searches">検索履歴を取得中...</p>';
}

// ページ読み込み時に他のユーザーの検索ワードを取得（検索は実行しない）
// 注意: loadRecentSearches()は検索履歴を表示するだけで、検索は実行しない
// 最優先で検索履歴を取得（即座に実行 + DOMContentLoaded + window.onloadで確実に実行）
// 即座に実行を試みる（DOM要素が準備できていれば）
(function() {
  console.log('📋 ページ読み込み: 検索履歴を取得開始');
  
  // 即座に実行を試みる（複数回試行）
  function tryLoadImmediately(attempt = 0) {
    if (recentSearchesDiv && recentSearchesList) {
      console.log('📋 即座に検索履歴を取得');
      loadRecentSearches();
      return;
    }
    
    // DOM要素がまだない場合は、少し待ってから再試行（最大5回）
    if (attempt < 5) {
      setTimeout(() => {
        tryLoadImmediately(attempt + 1);
      }, 50);
    }
  }
  
  // 即座に実行を試みる
  tryLoadImmediately();
  
  // DOMContentLoadedでも実行
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      console.log('📋 DOMContentLoaded: 検索履歴を取得');
      if (!hasLoadedOnce) {
        loadRecentSearches();
      }
    });
  } else {
    // 既にDOMContentLoadedが完了している場合は即座に実行
    console.log('📋 DOMContentLoaded完了済み: 検索履歴を取得');
    if (!hasLoadedOnce) {
      loadRecentSearches();
    }
  }
  
  // window.onloadでも実行（フォールバック）
  window.addEventListener('load', () => {
    console.log('📋 window.onload: 検索履歴を取得');
    if (!hasLoadedOnce) {
      loadRecentSearches();
    }
  });
})();

// ページ読み込み時の自動検索は完全に無効化
// URLパラメータから検索キーワードを取得して検索入力欄に設定するだけ（検索は実行しない）
(function() {
  const urlParams = new URLSearchParams(window.location.search);
  const queryParam = urlParams.get('q');
  
  // URLパラメータがある場合のみ検索入力欄に設定（検索は実行しない）
  // デフォルトの「動画」というワードでの自動検索は一切実行しない
  if (queryParam && searchInput) {
    searchInput.value = queryParam;
  }
  // 明示的に自動検索を実行しないことを確認
  console.log('ℹ️ ページ読み込み完了: 自動検索は実行されません');
})();

// 定期的に検索履歴を更新（10秒ごと、高速化のため間隔を短縮）
// エラー時や空の場合は既存の表示を保持するため、検索履歴が消えることはありません
setInterval(() => {
  console.log('🔄 検索履歴を定期更新中...');
  loadRecentSearches();
}, 10000); // 10秒ごとに更新（高速化のため30秒から短縮）

// 動画サイトごとの埋め込み対応状況を判定（緩和版）
// 基本的には埋め込みを試み、エラーが発生した場合のみ元のURLにリンク
function isEmbeddable(url, source) {
  // 明らかに埋め込みが不可能なサイトのみ除外
  // その他は埋め込みを試みる
  const definitelyNotEmbeddable = [
    // 特に問題があるサイトのみ
  ];
  
  // URLで判定
  if (url) {
    for (const site of definitelyNotEmbeddable) {
      if (url.includes(site)) return false;
    }
  }
  
  // デフォルトは埋め込み可能とみなす（試してみる）
  return true;
}

// 現在再生中の動画IDを追跡
let currentPlayingVideoId = null;

// 動画を停止する関数
function stopVideo(videoId) {
  const container = document.getElementById(`player-${videoId}`);
  if (!container) return;
  
  const iframe = container.querySelector('iframe');
  if (iframe) {
    // iframeのsrcを削除して動画を停止
    iframe.src = '';
    // コンテナをクリアして再生ボタンを表示
    container.innerHTML = `
      <button class="play-btn" onclick="showPlayer('${videoId}', '${escapeHtml(iframe.getAttribute('data-embed-url') || '')}', '${escapeHtml(iframe.getAttribute('data-original-url') || '')}', '${iframe.getAttribute('data-source') || ''}')">
        ▶ 再生
      </button>
    `;
    console.log('⏹️ 動画を停止しました:', videoId);
  }
  
  if (currentPlayingVideoId === videoId) {
    currentPlayingVideoId = null;
  }
}

// スクロール時に画面外の動画を停止
function handleScroll() {
  if (!currentPlayingVideoId) return;
  
  const container = document.getElementById(`player-${currentPlayingVideoId}`);
  if (!container) return;
  
  const rect = container.getBoundingClientRect();
  const isVisible = rect.top < window.innerHeight && rect.bottom > 0;
  
  // 画面外にスクロールされたら停止
  if (!isVisible) {
    stopVideo(currentPlayingVideoId);
  }
}

// スクロールイベントリスナーを追加（スロットリング）
let scrollTimeout;
window.addEventListener('scroll', () => {
  if (scrollTimeout) {
    clearTimeout(scrollTimeout);
  }
  scrollTimeout = setTimeout(handleScroll, 100);
}, { passive: true });

// Intersection Observerを使用してより効率的に監視
let videoObserver = null;
function initVideoObserver() {
  if (videoObserver) return;
  
  videoObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting && currentPlayingVideoId) {
        const containerId = entry.target.id;
        const videoId = containerId.replace('player-', '');
        if (videoId === currentPlayingVideoId) {
          stopVideo(videoId);
        }
      }
    });
  }, {
    threshold: 0.1,
    rootMargin: '50px'
  });
}

// iPhoneかどうかを判定する関数
function isIPhone() {
  // iPhone/iPodを検出（Braveブラウザなども含む）
  return /iPhone|iPod|iPad/.test(navigator.userAgent) && !window.MSStream;
}

// プレイヤー表示（グローバルスコープに公開）
window.showPlayer = function(videoId, embedUrl, originalUrl, source, event) {
  const container = document.getElementById(`player-${videoId}`);
  
  if (!container) {
    console.error('❌ プレイヤーコンテナが見つかりません:', `player-${videoId}`);
    return;
  }
  
  
  // iPhone Safariで動画を再生するため、ユーザーの直接的な操作として扱う
  // イベントが存在する場合（タッチ/クリックイベント）、そのコンテキスト内で処理
  if (event) {
    // イベントを保持して、ユーザーの直接的な操作として扱う
    event.preventDefault();
    event.stopPropagation();
  }
  
  // 他の動画が再生中の場合、停止する
  if (currentPlayingVideoId && currentPlayingVideoId !== videoId) {
    stopVideo(currentPlayingVideoId);
  }
  
  // 現在の動画IDを記録
  currentPlayingVideoId = videoId;
  
  // 動画プレイヤー表示時に周辺の広告を非表示にする
  const videoItem = container.closest('.video-item');
  if (videoItem) {
    // 動画アイテム内の広告を非表示
    const adsInItem = videoItem.querySelectorAll('.ad-container, .ad-in-content');
    adsInItem.forEach(ad => {
      ad.style.display = 'none';
    });
    
    // 動画アイテムの前後の広告も非表示（動画アイテムの直後/直前の広告）
    const nextSibling = videoItem.nextElementSibling;
    if (nextSibling && (nextSibling.classList.contains('ad-container') || nextSibling.classList.contains('ad-in-content'))) {
      nextSibling.style.display = 'none';
    }
    const prevSibling = videoItem.previousElementSibling;
    if (prevSibling && (prevSibling.classList.contains('ad-container') || prevSibling.classList.contains('ad-in-content'))) {
      prevSibling.style.display = 'none';
    }
  }
  
  // 埋め込み可能かどうかを判定（基本的には試してみる）
  const canEmbed = isEmbeddable(embedUrl, source);
  
  // 既に表示されている場合は閉じる
  if (container.querySelector('iframe')) {
    stopVideo(videoId);
    return;
  }

  // プレイヤーを表示
  const iframe = document.createElement('iframe');
  // URLを正規化（iOS Safari対応）
  let normalizedUrl = embedUrl.startsWith('//') ? `https:${embedUrl}` : embedUrl;
  if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
    normalizedUrl = `https://${normalizedUrl}`;
  }
  
  // Bilibiliの埋め込みURLを完全なURLに変換（iPhone Safari対応）
  if (source === 'bilibili' && normalizedUrl.includes('player.bilibili.com')) {
    // 既にhttps://で始まっている場合はそのまま、//で始まっている場合はhttps:を追加
    if (normalizedUrl.startsWith('//')) {
      normalizedUrl = 'https:' + normalizedUrl;
    }
    
    // iPhone/Braveブラウザの場合、モバイル対応パラメータを追加
    const isIOSDevice = isIPhone();
    if (isIOSDevice) {
      try {
        const urlObj = new URL(normalizedUrl);
        // モバイル対応パラメータを追加
        urlObj.searchParams.set('autoplay', '0'); // 自動再生をオフ
        urlObj.searchParams.set('high_quality', '1'); // 高画質を有効
        urlObj.searchParams.set('danmaku', '0'); // コメントをオフ（パフォーマンス向上）
        // モバイルデバイス向けの追加パラメータ
        urlObj.searchParams.set('page', '1'); // ページ番号
        urlObj.searchParams.set('as_wide', '1'); // ワイド表示
        normalizedUrl = urlObj.toString();
      } catch (e) {
        // URLパラメータ追加エラーは無視
      }
    }
  }
  
  // douga4の埋め込みURLを完全なURLに変換（iPhone Safari対応）
  if (source === 'douga4' && normalizedUrl.includes('douga4.top')) {
    // 既にhttps://で始まっている場合はそのまま、//で始まっている場合はhttps:を追加
    if (normalizedUrl.startsWith('//')) {
      normalizedUrl = 'https:' + normalizedUrl;
    }
    
    // douga4の動画ページを直接iframeで表示
    // 動画ページ自体が埋め込み可能な構造になっている可能性がある
  }
  
  // IVFreeの埋め込みURLを完全なURLに変換（iPhone Safari対応）
  if (source === 'ivfree') {
    // 既にhttps://で始まっている場合はそのまま、//で始まっている場合はhttps:を追加
    if (normalizedUrl.startsWith('//')) {
      normalizedUrl = 'https:' + normalizedUrl;
    } else if (!normalizedUrl.startsWith('http')) {
      normalizedUrl = 'http://' + normalizedUrl;
    }
    
    // 外部動画サイトのURL（vidnest.io、loadvid.comなど）の場合は、直接iframeで表示
    const isExternalVideoUrl = normalizedUrl.includes('vidnest.io') || 
                                normalizedUrl.includes('cdn.loadvid.com') || 
                                normalizedUrl.includes('loadvid.com') ||
                                normalizedUrl.includes('luluvid.com') ||
                                normalizedUrl.includes('luluvdoo.com') ||
                                normalizedUrl.includes('embed');
    
    if (isExternalVideoUrl) {
      // 外部動画サイトの場合は、直接iframeで表示（プロキシ不要）
      // プロキシ経由の処理をスキップ
      console.log('📺 IVFree外部動画URLを直接表示:', normalizedUrl);
    } else if (normalizedUrl.includes('ivfree.asia')) {
      // IVFreeの動画ページの場合は、まず動画URLを取得してからプロキシ経由で表示
      // ポップアップ広告を抑制するため、プロキシエンドポイントを使用
      // ただし、既にプロキシ経由の場合はそのまま使用
      if (!normalizedUrl.includes('/api/ivfree-proxy')) {
        // 動画URL取得処理は後で実行される（ivfree-video API呼び出し時）
        // ここでは元のURLを保持
      }
    }
  }
  
  // iPhone（Braveブラウザ含む）でデスクトップに偽装するため、プロキシ経由で読み込む
  // ただし、Bilibili、douga4の場合はプロキシ経由では動作しない可能性があるため、直接埋め込みURLを使用
  // IVFreeは既にプロキシ経由で処理されているため除外
  const isIOSDevice = isIPhone();
  if (isIOSDevice && source !== 'bilibili' && source !== 'douga4' && source !== 'ivfree') {
    // プロキシエンドポイント経由でデスクトップのUser-Agentで読み込む
    const proxyUrl = `/api/proxy-video?url=${encodeURIComponent(normalizedUrl)}`;
    normalizedUrl = proxyUrl;
  }
  
  // Bilibili、douga4、ivfreeの場合は、iPhone/Braveブラウザで特別な設定
  if ((source === 'bilibili' || source === 'douga4' || source === 'ivfree') && isIPhone()) {
    // iPhone/Braveブラウザの場合、より寛容な設定を適用
    // sandbox属性は設定しない（プレイヤーが動作しなくなる可能性があるため）
    iframe.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture; encrypted-media; playsinline; accelerometer; gyroscope; clipboard-write; clipboard-read');
    iframe.setAttribute('referrerpolicy', 'no-referrer-when-downgrade');
  } else {
    // その他の場合は通常の設定
    iframe.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture; encrypted-media; playsinline');
  }
  
  // IVFreeの場合は、sandbox属性を追加してポップアップを制限（ただし動画再生に必要な権限は許可）
  // ただし、外部動画サイトの場合はsandbox属性を設定しない（動画が再生できなくなる可能性があるため）
  // プロキシ経由で表示される外部動画サイトもサンドボックス検出を回避する必要があるため、sandbox属性を設定しない
  // プロキシ経由のURLから元のURLを抽出して判定
  let actualVideoUrl = normalizedUrl;
  if (normalizedUrl.includes('/api/ivfree-proxy')) {
    try {
      const urlParams = new URLSearchParams(normalizedUrl.split('?')[1]);
      actualVideoUrl = urlParams.get('url') || normalizedUrl;
    } catch(e) {
      actualVideoUrl = normalizedUrl;
    }
  }
  
  const isIVFreeExternalVideoForSandbox = source === 'ivfree' && (
    actualVideoUrl.includes('vidnest.io') || 
    actualVideoUrl.includes('cdn.loadvid.com') || 
    actualVideoUrl.includes('loadvid.com') ||
    actualVideoUrl.includes('luluvid.com') ||
    actualVideoUrl.includes('luluvdoo.com') ||
    actualVideoUrl.includes('embed') ||
    normalizedUrl.includes('/api/ivfree-proxy')
  );
  
  if (source === 'ivfree' && !isIVFreeExternalVideoForSandbox) {
    // sandbox属性でポップアップを制限（ただし、動画再生に必要な権限は許可）
    // allow-same-originとallow-scriptsの両方を含めるとセキュリティ警告が出るが、動画再生に必要
    iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups-to-escape-sandbox allow-presentation allow-top-navigation-by-user-activation');
    // ポップアップを完全にブロックするため、allow-popupsは含めない
    // allow-same-originは含めない（セキュリティ警告を避けるため）
  } else if (source === 'ivfree' && isIVFreeExternalVideoForSandbox) {
    // 外部動画サイトの場合は、sandbox属性を設定しない（サンドボックス検出を回避）
    // プロキシ経由で表示される外部動画サイトもサンドボックス検出を回避する必要がある
    iframe.removeAttribute('sandbox');
    // 確実に削除するため、再度削除を試みる
    if (iframe.hasAttribute('sandbox')) {
      iframe.removeAttribute('sandbox');
    }
  }
  
  // iframeのsrcを設定（douga4の場合は後で更新される可能性がある）
  iframe.src = normalizedUrl;
  
  // 外部動画サイトの場合は、src設定後にもsandbox属性を確実に削除
  if (source === 'ivfree' && isIVFreeExternalVideoForSandbox) {
    // src設定後にsandbox属性を削除（複数回試行）
    setTimeout(() => {
      iframe.removeAttribute('sandbox');
      if (iframe.hasAttribute('sandbox')) {
        iframe.removeAttribute('sandbox');
      }
    }, 0);
    setTimeout(() => {
      iframe.removeAttribute('sandbox');
      if (iframe.hasAttribute('sandbox')) {
        iframe.removeAttribute('sandbox');
      }
    }, 100);
    setTimeout(() => {
      iframe.removeAttribute('sandbox');
      if (iframe.hasAttribute('sandbox')) {
        iframe.removeAttribute('sandbox');
      }
    }, 500);
  }
  iframe.allowFullscreen = true;
  iframe.className = 'video-player';
  iframe.setAttribute('loading', 'lazy');
  iframe.setAttribute('frameborder', '0');
  iframe.setAttribute('scrolling', 'no');
  // iOS Safari対応（全画面表示を許可）
  iframe.setAttribute('webkitallowfullscreen', 'true');
  iframe.setAttribute('mozallowfullscreen', 'true');
  iframe.setAttribute('playsinline', 'false'); // iPhoneで全画面表示
  
  // douga4の場合は、動画ページから実際の動画URLを取得する準備（後でデバッグ情報を追加）
  let douga4DebugInfo = null;
  let douga4StatusText = '初期化中...';
  let douga4UpdateDebugInfo = null;
  const isDouga4 = source === 'douga4' || normalizedUrl.includes('douga4.top');
  
  if (isDouga4) {
    // デバッグ情報の更新関数を準備（後でコンテナに追加された後に使用）
    const isIOSDevice = isIPhone();
    const isBrave = navigator.userAgent.includes('Brave');
    const ua = navigator.userAgent;
    
    douga4UpdateDebugInfo = function() {
      if (!douga4DebugInfo || !douga4DebugInfo.parentNode) return;
      
      const iframeSize = `${iframe.offsetWidth}×${iframe.offsetHeight}`;
      const containerSize = `${container.offsetWidth}×${container.offsetHeight}`;
      const iframeVisible = iframe.offsetWidth > 0 && iframe.offsetHeight > 0 ? '表示中' : '非表示';
      const currentSrc = iframe.src || '未設定';
      
      douga4DebugInfo.innerHTML = `
        <div style="font-weight: bold; margin-bottom: 8px; font-size: 13px;">📺 douga4デバッグ情報</div>
        <div>source: ${source || '未設定'}</div>
        <div>ブラウザ: ${isBrave ? 'Brave' : ua.includes('Safari') ? 'Safari' : 'Other'}</div>
        <div>デバイス: ${isIOSDevice ? 'iPhone/iOS' : 'Other'}</div>
        <div>User-Agent: ${ua.substring(0, 40)}...</div>
        <div style="margin-top: 8px; border-top: 1px solid rgba(255,255,255,0.3); padding-top: 8px;">元のURL:</div>
        <div style="font-size: 10px; word-break: break-all;">${normalizedUrl}</div>
        <div style="margin-top: 8px;">現在のiframe.src:</div>
        <div style="font-size: 10px; word-break: break-all;">${currentSrc.substring(0, 80)}${currentSrc.length > 80 ? '...' : ''}</div>
        <div style="margin-top: 8px; border-top: 1px solid rgba(255,255,255,0.3); padding-top: 8px;">iframeサイズ: ${iframeSize}</div>
        <div>コンテナサイズ: ${containerSize}</div>
        <div>iframe表示: ${iframeVisible}</div>
        <div style="margin-top: 8px; border-top: 1px solid rgba(255,255,255,0.3); padding-top: 8px;">状態: ${douga4StatusText}</div>
      `;
    };
  }
  
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  iframe.style.position = 'absolute';
  iframe.style.top = '0';
  iframe.style.left = '0';
  iframe.style.border = 'none';
  
  // エラー検出用のフラグ
  let hasError = false;
  let errorTimeout;
  
  // エラーメッセージを表示する関数
  const showError = () => {
    if (hasError) return;
    hasError = true;
    if (errorTimeout) clearTimeout(errorTimeout);
    
    // iOS Safariでは、iframeにアクセスできない場合でも正常に動作している可能性があるため、
    // エラー表示の前にiframeが表示されているか確認
    setTimeout(() => {
      const iframeVisible = iframe.offsetWidth > 0 && iframe.offsetHeight > 0;
      if (iframeVisible) {
        return;
      }
      
      container.innerHTML = `
        <div class="player-error">
          <p>⚠️ 動画を読み込めませんでした</p>
          <p class="error-detail">サーバーまたはネットワークの問題、またはフォーマットがサポートされていない可能性があります。</p>
          <a href="${originalUrl}" target="_blank" class="open-original-btn">元のサイトで開く</a>
          <button class="retry-btn" onclick="showPlayer('${videoId}', '${escapeHtml(embedUrl)}', '${escapeHtml(originalUrl)}', '${source || ''}')">再試行</button>
        </div>
      `;
    }, 2000);
  };
  
  // iframeのエラーイベント
  iframe.onerror = (error) => {
    showError();
  };
  
  // 読み込み完了を検出
  iframe.onload = () => {
    // タイムアウトを短縮（読み込み完了したので）
    if (errorTimeout) clearTimeout(errorTimeout);
    
    // 既存のデバッグ情報を削除（douga4のデバッグ情報は除外）
    container.querySelectorAll('.debug-info:not(.debug-info-douga4)').forEach(el => el.remove());
    
    // Bilibiliの場合は、特別な処理を行う
    if (source === 'bilibili') {
      // BilibiliのプレイヤーはJavaScriptで動的に読み込まれるため、
      // 少し待ってからエラーチェックを行う
      setTimeout(() => {
        // 既存のデバッグ情報を削除（douga4のデバッグ情報は除外）
        container.querySelectorAll('.debug-info:not(.debug-info-douga4)').forEach(el => el.remove());
        try {
          const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
          if (iframeDoc) {
            const bodyText = iframeDoc.body?.innerText || '';
            const bodyHTML = iframeDoc.body?.innerHTML || '';
            
            // エラーメッセージを検出
            if (bodyText.includes('could not be loaded') || 
                bodyText.includes('not supported') ||
                bodyText.includes('network failed') ||
                bodyText.includes('server failed') ||
                bodyHTML.includes('could not be loaded') ||
                bodyHTML.includes('not supported')) {
              showError();
            }
          }
        } catch (e) {
          // CORSエラーは無視（iOS Safariでは正常な場合が多い）
        }
      }, 3000); // Bilibiliの場合は3秒待つ
    } else {
      // その他の動画サイトの場合
      setTimeout(() => {
        // 既存のデバッグ情報を削除（douga4のデバッグ情報は除外）
        container.querySelectorAll('.debug-info:not(.debug-info-douga4)').forEach(el => el.remove());
        try {
          const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
          if (iframeDoc) {
            const bodyText = iframeDoc.body?.innerText || '';
            const bodyHTML = iframeDoc.body?.innerHTML || '';
            // エラーメッセージを検出
            if (bodyText.includes('could not be loaded') || 
                bodyText.includes('not supported') ||
                bodyText.includes('network failed') ||
                bodyText.includes('server failed') ||
                bodyHTML.includes('could not be loaded') ||
                bodyHTML.includes('not supported')) {
              showError();
            }
          }
        } catch (e) {
          // CORSエラーは無視（iOS Safariでは正常な場合が多い）
        }
      }, 2000);
    }
  };
  
  // コンテナをクリアしてiframeを追加
  container.innerHTML = '';
  container.style.position = 'relative';
  container.style.width = '100%';
  container.style.paddingTop = '56.25%'; // 16:9
  container.style.background = '#000';
  container.style.borderRadius = '8px';
  container.style.overflow = 'hidden';
  
  container.appendChild(iframe);
  
  // douga4の場合は、デバッグ情報をコンテナクリア後に追加（常に表示）
  if (isDouga4 && douga4UpdateDebugInfo) {
    douga4DebugInfo = document.createElement('div');
    douga4DebugInfo.id = `douga4-debug-${videoId}`;
    douga4DebugInfo.className = 'debug-info-douga4';
    douga4DebugInfo.style.cssText = 'position: absolute; top: 10px; left: 10px; background: rgba(0,0,0,0.9); color: white; padding: 15px; border-radius: 8px; font-size: 11px; z-index: 10000; max-width: 95%; word-break: break-all; line-height: 1.4; box-shadow: 0 2px 10px rgba(0,0,0,0.5); pointer-events: none;';
    
    // 初回表示
    douga4UpdateDebugInfo();
    container.appendChild(douga4DebugInfo);
    
    // 定期的にサイズ情報を更新
    const debugInterval = setInterval(() => {
      if (!douga4DebugInfo || !douga4DebugInfo.parentNode) {
        clearInterval(debugInterval);
        return;
      }
      douga4UpdateDebugInfo();
    }, 1000);
    
    // サーバー側で動画URLを取得するエンドポイントを呼び出す
    douga4StatusText = 'サーバーからURL取得中...';
    douga4UpdateDebugInfo();
    
    fetch(`/api/douga4-video?url=${encodeURIComponent(normalizedUrl)}`)
      .then(response => {
        douga4StatusText = 'レスポンス受信...';
        douga4UpdateDebugInfo();
        return response.json();
      })
      .then(data => {
        douga4StatusText = `URL取得完了: ${data.embedUrl ? '成功' : '失敗'}`;
        douga4UpdateDebugInfo();
        if (data.embedUrl && data.embedUrl !== normalizedUrl) {
          // 取得した動画URLを使用
          douga4StatusText = `動画URL更新: ${data.embedUrl.substring(0, 30)}...`;
          douga4UpdateDebugInfo();
          iframe.src = data.embedUrl;
          setTimeout(douga4UpdateDebugInfo, 500);
        } else {
          douga4StatusText = '元のURLを使用';
          douga4UpdateDebugInfo();
        }
      })
      .catch(error => {
        // エラーが発生しても元のURLを使用
        douga4StatusText = `エラー: ${error.message}`;
        douga4UpdateDebugInfo();
      });
  }
  
  // IVFreeの動画URLを取得（douga4と同様の処理）
  // 外部動画サイトのURLもプロキシ経由で表示（広告ブロッカー検出を回避）
  const isIVFreeExternalVideo = source === 'ivfree' && (
    normalizedUrl.includes('vidnest.io') || 
    normalizedUrl.includes('cdn.loadvid.com') || 
    normalizedUrl.includes('loadvid.com') ||
    normalizedUrl.includes('luluvid.com') ||
    normalizedUrl.includes('luluvdoo.com') ||
    normalizedUrl.includes('embed')
  );
  
  if (source === 'ivfree' && !normalizedUrl.includes('/api/ivfree-proxy')) {
    // 外部動画サイト（luluvid.comなど）の場合は、直接iframeで表示（プロキシを使わない）
    // プロキシ経由だとHLSストリームがCORSでブロックされるため
    if (isIVFreeExternalVideo) {
      // 外部動画サイトの場合は、直接iframeで表示
      iframe.removeAttribute('sandbox');
      iframe.src = normalizedUrl;
      console.log('📺 IVFree外部動画URLを直接表示（プロキシなし）:', normalizedUrl);
    } else {
      // IVFree内部URLの場合は、プロキシ経由で表示（広告ブロッカー検出を回避）
      const proxyUrl = `/api/ivfree-proxy?url=${encodeURIComponent(normalizedUrl)}`;
      iframe.src = proxyUrl;
      console.log('📺 IVFree動画をプロキシ経由で表示開始:', normalizedUrl);
    }
    
    // バックグラウンドで動画URLを取得（成功したら更新）
    let ivfreeStatusText = 'IVFree動画URL取得中...';
    const ivfreeUpdateDebugInfo = () => {
      if (container.querySelector('.debug-info')) {
        container.querySelector('.debug-info').textContent = ivfreeStatusText;
      }
    };
    
    ivfreeUpdateDebugInfo();
    
    fetch(`/api/ivfree-video?url=${encodeURIComponent(normalizedUrl)}`)
      .then(response => {
        ivfreeStatusText = 'レスポンス受信...';
        ivfreeUpdateDebugInfo();
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return response.json();
      })
      .then(data => {
        ivfreeStatusText = `URL取得完了: ${data.embedUrl ? '成功' : '失敗'}`;
        ivfreeUpdateDebugInfo();
        if (data.embedUrl && data.embedUrl !== normalizedUrl) {
          // 外部動画サイト（luluvid.comなど）の場合は、直接iframeで表示（プロキシを使わない）
          // プロキシ経由だとHLSストリームがCORSでブロックされるため
          const isExternalEmbedUrl = data.embedUrl.includes('vidnest.io') || 
                                      data.embedUrl.includes('cdn.loadvid.com') || 
                                      data.embedUrl.includes('loadvid.com') ||
                                      data.embedUrl.includes('luluvid.com') ||
                                      data.embedUrl.includes('luluvdoo.com') ||
                                      data.embedUrl.includes('embed');
          
          if (isExternalEmbedUrl) {
            // 外部動画サイトの場合は、直接iframeで表示
            iframe.removeAttribute('sandbox');
            iframe.src = data.embedUrl;
            ivfreeStatusText = `動画URL更新（直接表示）: ${data.embedUrl.substring(0, 30)}...`;
            ivfreeUpdateDebugInfo();
            console.log('📺 IVFree外部動画URLを直接表示（プロキシなし）:', data.embedUrl);
            
            // 複数のタイミングでsandbox属性を削除（念のため）
            setTimeout(() => {
              iframe.removeAttribute('sandbox');
            }, 0);
            setTimeout(() => {
              iframe.removeAttribute('sandbox');
            }, 50);
            setTimeout(() => {
              iframe.removeAttribute('sandbox');
            }, 100);
            setTimeout(() => {
              iframe.removeAttribute('sandbox');
            }, 200);
            setTimeout(() => {
              iframe.removeAttribute('sandbox');
            }, 500);
          } else {
            // IVFree内部URLの場合は、プロキシ経由で表示
            iframe.src = `/api/ivfree-proxy?url=${encodeURIComponent(data.embedUrl)}`;
            ivfreeStatusText = `動画URL更新（プロキシ経由）: ${data.embedUrl.substring(0, 30)}...`;
            ivfreeUpdateDebugInfo();
          }
        } else {
          // 元のURLを使用（既に設定済み）
          ivfreeStatusText = '元のURLを使用（プロキシ経由）';
          ivfreeUpdateDebugInfo();
        }
      })
      .catch(error => {
        // エラーが発生しても既にプロキシ経由で表示されているので、そのまま継続
        console.log('ℹ️ IVFree動画URL取得エラー（既にプロキシ経由で表示中）:', error.message);
        ivfreeStatusText = 'プロキシ経由で表示中';
        ivfreeUpdateDebugInfo();
      });
  }
  
  // iOS Safariではiframeの読み込み確認が難しいため、タイムアウトを長めに設定
  // タイムアウトでエラー検出（Bilibiliとdouga4の場合は15秒、IVFreeは20秒、その他は10秒）
  const timeoutDuration = (source === 'bilibili' || source === 'douga4') ? 15000 : 
                          (source === 'ivfree') ? 20000 : 10000;
  errorTimeout = setTimeout(() => {
    if (hasError) return;
    
    // 既存のデバッグ情報を削除
    container.querySelectorAll('.debug-info').forEach(el => el.remove());
    
    // iOS Safariではiframeにアクセスできない場合が多いため、
    // iframeが表示されているかどうかで判断
    const iframeVisible = iframe.offsetWidth > 0 && iframe.offsetHeight > 0;
    const containerVisible = container.offsetWidth > 0 && container.offsetHeight > 0;
    
    // iframeが表示されていない場合はエラー
    if (!iframeVisible || !containerVisible) {
      // エラーメッセージを表示
      container.innerHTML = `
        <div class="player-error">
          <p>📱 動画を再生するには、元のサイトで開いてください</p>
          <a href="${originalUrl}" target="_blank" class="open-original-btn">元のサイトで開く</a>
        </div>
      `;
      return;
    }
    
    // iframeにアクセスできる場合はエラーチェック
    try {
      const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
      if (iframeDoc && iframeDoc.body?.innerText?.includes('could not be loaded')) {
        showError();
      }
    } catch (e) {
      // CORSエラーは無視（iOS Safariでは正常な場合が多い）
    }
  }, timeoutDuration);
};

// ソース名取得
function getSourceName(source) {
  const names = {
    'google': 'Google',
    'youtube': 'YouTube',
    'bilibili': 'Bilibili',
    'jpdmv': 'JPdmv',
    'douga4': 'Douga4',
    'dailymotion': 'Dailymotion',
    'vimeo': 'Vimeo',
    'spankbang': 'Spankbang',
    'x1hub': 'X1hub',
    'porntube': 'Porntube',
    'javguru': 'JavGuru',
    'akibaabv': 'AkibaAbv',
    'fc2': 'FC2',
    'sohu': 'Sohu',
    'youku': 'Youku',
    'iqiyi': 'iQiyi',
    'tencent': 'Tencent Video',
    'xigua': 'Xigua Video',
    'javdb': 'JAVDB',
    'javlibrary': 'JAVLibrary',
    'javbus': 'JAVBus',
    'javsee': 'JAVSee',
    'javhd': 'JAVHD',
    'javmost': 'JAVMost',
    'javtrailers': 'JAVTrailers',
    'javsubtitle': 'JAVSubtitle',
    'jav321': 'JAV321',
    'javjunkies': 'JAVJunkies',
    'javfinder': 'JAVFinder',
    'javfree': 'JAVFree',
    'javstreaming': 'JAVStreaming',
    'javcl': 'JAVCL',
    'javdoe': 'JAVDoe',
    'javfull': 'JAVFull',
    'javhdporn': 'JAVHDPorn',
    'javhub': 'JAVHub',
    'javleak': 'JAVLeak',
    'javmix': 'JAVMix',
    'javmodel': 'JAVModel',
    'javnew': 'JAVNew',
    'javporn': 'JAVPorn',
    'javsx': 'JAVSX',
    'javtag': 'JAVTag',
    'javtube': 'JAVTube',
    'javx': 'JAVX',
    'javzoo': 'JAVZoo',
    'jav': 'JAV',
    '91porn': '91Porn',
    '91porn2': '91Porn2',
    'thisav': 'ThisAV',
    'madou': 'Madou',
    'caoliu': 'Caoliu',
    'caoliu1024': 'CaoLiu1024',
    'sis': 'Sis',
    'sis001': 'Sis001',
    'diyihuisuo': 'Diyihuisuo',
    'diyihuisuo2': 'Diyihuisuo2',
    'xingba': 'Xingba',
    'xingba2': 'Xingba2',
    't66y': 'T66y',
    'javbus': 'Javbus',
    'javdb': 'Javdb',
    'ppp': 'PPP.Porn',
    'javmix': 'Javmix.TV',
    'ivfree': 'IVFree',
    'mat6tube': 'Mat6tube',
    'fc2video': 'FC2Video.org',
    'test': 'テスト'
  };
  return names[source] || source;
}

// HTMLエスケープ
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// イベントリスナー
searchBtn.addEventListener('click', () => {
  searchVideos(searchInput.value);
});

searchInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    searchVideos(searchInput.value);
  }
});

// IVランダム動画取得
async function getRandomIV() {
  console.log('🎲 IVランダム動画取得開始');
  if (!loadingDiv) {
    console.error('❌ loadingDivが見つかりません');
    return;
  }
  loadingDiv.classList.remove('hidden');
  if (resultsDiv) {
    resultsDiv.innerHTML = '';
  }
  
  try {
    console.log('🔍 /api/random?type=iv にリクエスト送信');
    const response = await fetch('/api/random?type=iv');
    console.log('📡 レスポンス受信:', response.status, response.statusText);
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      console.error('❌ エラーレスポンス:', errorData);
      throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    console.log('📊 ランダム動画データ受信:', data);
    const videos = data.results || [];
    console.log(`✅ ${videos.length}件のIVランダム動画を取得`);
    
    currentVideos = videos;
    currentPage = 1;
    totalPages = Math.ceil(videos.length / VIDEOS_PER_PAGE);
    
    // ランダム表示の場合はソートを「デフォルト」にリセット（ランダム順を維持）
    if (sortSelect) {
      sortSelect.value = 'default';
    }
    
    if (videos.length > 0) {
      // サーバー側でランダムにシャッフルされた順序をそのまま表示
      console.log('🎲 ランダム順で表示（ソートなし）');
      displayResults(videos, 'IV Random');
      if (sortContainer) {
        sortContainer.classList.remove('hidden');
      }
    } else {
      if (resultsDiv) {
        resultsDiv.innerHTML = `<p class="error-message">No IV random videos found. Please try again later.</p>`;
      }
      if (sortContainer) {
        sortContainer.classList.add('hidden');
      }
    }
  } catch (error) {
    console.error('❌ IVランダム動画取得エラー:', error);
    console.error('❌ エラー詳細:', error.message, error.stack);
    if (resultsDiv) {
      resultsDiv.innerHTML = `<p class="error-message">Failed to load random IV videos: ${error.message}. Please try again.</p>`;
    }
  } finally {
    if (loadingDiv) {
      loadingDiv.classList.add('hidden');
    }
  }
}

// JAVランダム動画取得
async function getRandomJAV() {
  console.log('🎲 JAVランダム動画取得開始');
  if (!loadingDiv) {
    console.error('❌ loadingDivが見つかりません');
    return;
  }
  loadingDiv.classList.remove('hidden');
  if (resultsDiv) {
    resultsDiv.innerHTML = '';
  }
  
  try {
    console.log('🔍 /api/random?type=jav にリクエスト送信');
    const response = await fetch('/api/random?type=jav');
    console.log('📡 レスポンス受信:', response.status, response.statusText);
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      console.error('❌ エラーレスポンス:', errorData);
      throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    console.log('📊 ランダム動画データ受信:', data);
    const videos = data.results || [];
    console.log(`✅ ${videos.length}件のJAVランダム動画を取得`);
    
    currentVideos = videos;
    currentPage = 1;
    totalPages = Math.ceil(videos.length / VIDEOS_PER_PAGE);
    
    // ランダム表示の場合はソートを「デフォルト」にリセット（ランダム順を維持）
    if (sortSelect) {
      sortSelect.value = 'default';
    }
    
    if (videos.length > 0) {
      // サーバー側でランダムにシャッフルされた順序をそのまま表示
      console.log('🎲 ランダム順で表示（ソートなし）');
      displayResults(videos, 'JAV Random');
      if (sortContainer) {
        sortContainer.classList.remove('hidden');
      }
    } else {
      if (resultsDiv) {
        resultsDiv.innerHTML = `<p class="error-message">No JAV random videos found. Please try again later.</p>`;
      }
      if (sortContainer) {
        sortContainer.classList.add('hidden');
      }
    }
  } catch (error) {
    console.error('❌ JAVランダム動画取得エラー:', error);
    console.error('❌ エラー詳細:', error.message, error.stack);
    if (resultsDiv) {
      resultsDiv.innerHTML = `<p class="error-message">Failed to load random JAV videos: ${error.message}. Please try again.</p>`;
    }
  } finally {
    if (loadingDiv) {
      loadingDiv.classList.add('hidden');
    }
  }
}

// IVランダムボタン
if (ivRandomBtn) {
  console.log('✅ IVランダムボタンが見つかりました');
  ivRandomBtn.addEventListener('click', () => {
    console.log('🎬 IVランダムボタンがクリックされました');
    getRandomIV();
  });
} else {
  console.error('❌ IVランダムボタンが見つかりません');
}

// JAVランダムボタン
if (javRandomBtn) {
  console.log('✅ JAVランダムボタンが見つかりました');
  javRandomBtn.addEventListener('click', () => {
    console.log('🎥 JAVランダムボタンがクリックされました');
    getRandomJAV();
  });
} else {
  console.error('❌ JAVランダムボタンが見つかりません');
}

// 広告の読み込み（環境変数または設定から）
async function loadAds() {
  // サーバーから広告設定を取得
  let adClientId = '';
  let adSlotHeader = '';
  let adSlotFooter = '';
  let adSlotInContent = '';
  
  try {
    const response = await fetch('/api/ad-config');
    if (response.ok) {
      const config = await response.json();
      adClientId = config.adClientId || '';
      adSlotHeader = config.adSlotHeader || '';
      adSlotFooter = config.adSlotFooter || '';
      adSlotInContent = config.adSlotInContent || '';
    }
  } catch (error) {
    console.log('ℹ️ 広告設定の取得に失敗:', error);
  }
  
  // フォールバック: グローバル変数から取得
  if (!adClientId) {
    adClientId = window.AD_CLIENT_ID || '';
    adSlotHeader = window.AD_SLOT_HEADER || '';
    adSlotFooter = window.AD_SLOT_FOOTER || '';
    adSlotInContent = window.AD_SLOT_IN_CONTENT || '';
  }
  
  if (!adClientId) {
    console.log('ℹ️ 広告クライアントIDが設定されていません');
    return;
  }
  
  // グローバル変数に設定（後で使用するため）
  window.AD_CLIENT_ID = adClientId;
  window.AD_SLOT_HEADER = adSlotHeader;
  window.AD_SLOT_FOOTER = adSlotFooter;
  window.AD_SLOT_IN_CONTENT = adSlotInContent;
  
  // Google AdSenseスクリプトを読み込む
  if (!document.querySelector('script[src*="adsbygoogle"]')) {
    const script = document.createElement('script');
    script.async = true;
    script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${adClientId}`;
    script.crossOrigin = 'anonymous';
    document.head.appendChild(script);
  }
  
  // ヘッダー下の広告
  if (adSlotHeader) {
    const adHeader = document.getElementById('ad-header');
    if (adHeader) {
      adHeader.innerHTML = `
        <ins class="adsbygoogle"
             style="display:block"
             data-ad-client="${adClientId}"
             data-ad-slot="${adSlotHeader}"
             data-ad-format="auto"
             data-full-width-responsive="true"></ins>
      `;
      try {
        (adsbygoogle = window.adsbygoogle || []).push({});
      } catch (e) {
        console.log('ℹ️ 広告の読み込みエラー:', e);
      }
    }
  }
  
  // フッター上の広告
  if (adSlotFooter) {
    const adFooter = document.getElementById('ad-footer');
    if (adFooter) {
      adFooter.innerHTML = `
        <ins class="adsbygoogle"
             style="display:block"
             data-ad-client="${adClientId}"
             data-ad-slot="${adSlotFooter}"
             data-ad-format="auto"
             data-full-width-responsive="true"></ins>
      `;
      try {
        (adsbygoogle = window.adsbygoogle || []).push({});
      } catch (e) {
        console.log('ℹ️ 広告の読み込みエラー:', e);
      }
    }
  }
}

// 検索結果の間に広告を挿入
function insertAdsInResults() {
  const adClientId = window.AD_CLIENT_ID || '';
  const adSlotInContent = window.AD_SLOT_IN_CONTENT || '';
  
  if (!adClientId || !adSlotInContent) {
    return;
  }
  
  const videoItems = document.querySelectorAll('.video-item');
  if (videoItems.length === 0) return;
  
  // 5件ごとに広告を挿入（最初の広告は3件目以降）
  // ただし、動画プレイヤーが表示されている動画アイテムの前後には広告を挿入しない
  for (let i = 3; i < videoItems.length; i += 5) {
    const videoItem = videoItems[i];
    
    // この動画アイテムに動画プレイヤーが表示されているかチェック
    const hasPlayer = videoItem.querySelector('.video-player-container iframe');
    if (hasPlayer) {
      // 動画プレイヤーが表示されている場合は、この位置には広告を挿入しない
      continue;
    }
    
    // 前後の動画アイテムに動画プレイヤーが表示されているかチェック
    const prevItem = videoItems[i - 1];
    const nextItem = videoItems[i + 1];
    const prevHasPlayer = prevItem && prevItem.querySelector('.video-player-container iframe');
    const nextHasPlayer = nextItem && nextItem.querySelector('.video-player-container iframe');
    
    if (prevHasPlayer || nextHasPlayer) {
      // 前後の動画アイテムに動画プレイヤーが表示されている場合は、この位置には広告を挿入しない
      continue;
    }
    
    const adDiv = document.createElement('div');
    adDiv.className = 'ad-container ad-in-content';
    adDiv.innerHTML = `
      <ins class="adsbygoogle"
           style="display:block"
           data-ad-client="${adClientId}"
           data-ad-slot="${adSlotInContent}"
           data-ad-format="auto"
           data-full-width-responsive="true"></ins>
    `;
    
    videoItems[i].parentNode.insertBefore(adDiv, videoItems[i].nextSibling);
    
    try {
      (adsbygoogle = window.adsbygoogle || []).push({});
    } catch (e) {
      console.log('ℹ️ 広告の読み込みエラー:', e);
    }
  }
}

// ページ読み込み時に広告を読み込む
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    loadAds();
  });
} else {
  loadAds();
}

// ソート選択時の処理
if (sortSelect) {
  sortSelect.addEventListener('change', (e) => {
    const sortType = e.target.value;
    console.log('🔀 ソート実行:', sortType, '動画数:', currentVideos.length);
    
    if (currentVideos.length === 0) {
      console.warn('⚠️ ソート対象の動画がありません');
      return;
    }
    
    const sortedVideos = sortVideos(currentVideos, sortType);
    console.log('✅ ソート完了:', sortedVideos.length, '件');
    currentVideos = sortedVideos; // ソート結果をcurrentVideosに保存
    currentPage = 1; // ソート時は1ページ目に戻す
    displayResults(sortedVideos, '');
  });
} else {
  console.error('❌ sortSelect要素が見つかりません');
}

