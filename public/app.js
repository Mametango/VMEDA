/**
 * VMEDA: あらゆるサイトを VMEDA のフィルター（プロキシ）を通して表示し、
 * 広告などを排除して動画を視聴できるようにする。
 * サイト表示・動画再生は原則としてプロキシ経由（site-proxy / ivfree-proxy 等）を利用する。
 */
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
    // event.messageが存在する場合のみチェック
    if (event.message && (
      event.message.includes('ERR_CERT') ||
      event.message.includes('ERR_NAME_NOT_RESOLVED') ||
      event.message.includes('ERR_BLOCKED_BY_RESPONSE') ||
      event.message.includes('ERR_SSL_PROTOCOL') ||
      event.message.includes('ERR_HTTP2_PROTOCOL') ||
      event.message.includes('NotSameOrigin') ||
      event.message.includes('403') ||
      event.message.includes('400')
    )) {
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
const sortContainer = document.getElementById('sort-container');
const sortSelect = document.getElementById('sort-select');

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

  const html = videosToShow.map((video, index) => {
    // 表示に必要な最小限のフィールドを補完（JAVランダム等で欠損時も正常表示）
    const vid = video.id || `video-${startIndex + index}`;
    const title = (video.title && String(video.title).trim()) ? String(video.title) : '動画';
    const url = video.url || '';
    const embedUrl = video.embedUrl || url;
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
        const idMatch = title.match(/\[([A-Z]+-\d+)\]/);
        if (idMatch) {
          const id = idMatch[1].toLowerCase();
          thumbnail = `http://ivfree.asia/images/${id}.jpg`;
        }
      }
      // その他のサイトでも、URLからサムネイルを推測
      if (!thumbnail && url) {
        // URLから画像パスを推測（一般的なパターン）
        const urlMatch = url.match(/(https?:\/\/[^\/]+)/);
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
          thumbnail = `https://via.placeholder.com/640x360/667eea/ffffff?text=${encodeURIComponent(title.substring(0, 20))}`;
        }
      }
      // それでもサムネイルがない場合は、プレースホルダー画像を使用
      if (!thumbnail || thumbnail.length === 0) {
        thumbnail = `https://via.placeholder.com/640x360/667eea/ffffff?text=${encodeURIComponent(title.substring(0, 20))}`;
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
        <h3 class="video-title">${escapeHtml(title)}</h3>
        <div class="video-header-right">
          ${showDuration ? `<span class="video-duration">${escapeHtml(duration)}</span>` : ''}
          <span class="video-source">${getSourceName(video.source)}</span>
        </div>
      </div>
      <div class="video-player-container" id="player-${vid}">
        ${hasThumbnail ? `
          <div class="video-thumbnail-wrapper" onclick="showPlayer('${escapeHtml(vid)}', '${escapeHtml(embedUrl)}', '${escapeHtml(url)}', '${video.source || ''}', event)">
            <img src="${escapeHtml(thumbnail)}" alt="${escapeHtml(title)}" class="video-thumbnail" loading="lazy" onerror="this.onerror=null; this.style.display='none'; const overlay = this.nextElementSibling; if(overlay) { overlay.style.display='flex'; overlay.style.opacity='1'; }">
            <div class="play-overlay">
              <button class="play-btn-thumbnail ${isBilibili ? 'bilibili-icon' : ''}">${playIcon}</button>
            </div>
          </div>
        ` : `
          <button class="play-btn" onclick="showPlayer('${escapeHtml(vid)}', '${escapeHtml(embedUrl)}', '${escapeHtml(url)}', '${video.source || ''}', event)">
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
  videosToShow.forEach((video, idx) => {
    const vid = video.id || `video-${startIndex + idx}`;
    const videoElement = document.getElementById(`player-${vid}`);
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
  // /api/... のような相対URLはそのまま使う（https:// を付けない）
  if (!normalizedUrl.startsWith('/') && !normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
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
  
  // JPdmvはプロキシが502/500になりやすいため、まず元のページを直接表示する
  if (source === 'jpdmv' && originalUrl && String(originalUrl).includes('jpdmv.com')) {
    const jpdmvDirect = originalUrl.startsWith('http') ? originalUrl : `https:${originalUrl}`;
    normalizedUrl = jpdmvDirect;
    console.log('📺 JPdmv: 元のページを直接表示で試します:', jpdmvDirect);
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
    
    // 外部動画サイトのURL（vidnest.io、lulustream、loadvid.comなど）の場合は、直接iframeで表示
    const isExternalVideoUrl = normalizedUrl.includes('vidnest.io') || 
                                normalizedUrl.includes('lulustream.com') ||
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
      // IVFreeの動画ページは常にプロキシ経由で表示（混合コンテンツ防止・広告除去・再生安定）
      if (!normalizedUrl.includes('/api/ivfree-proxy')) {
        const ivfreePageUrl = normalizedUrl.startsWith('http') ? normalizedUrl : `http://${normalizedUrl}`;
        normalizedUrl = `/api/ivfree-proxy?url=${encodeURIComponent(ivfreePageUrl)}`;
        console.log('📺 IVFree動画をプロキシ経由で表示:', normalizedUrl);
      }
    }
  }
  
  // PizjavはVMEDA内でプロキシ経由表示（広告・ポップアップを除去して快適に視聴）
  if (source === 'pizjav' && normalizedUrl.includes('pizjav.com')) {
    const pizjavUrl = normalizedUrl.startsWith('http') ? normalizedUrl : `https:${normalizedUrl}`;
    normalizedUrl = `/api/pizjav-proxy?url=${encodeURIComponent(pizjavUrl)}`;
    console.log('📺 Pizjav動画をプロキシ経由で表示（広告なし）:', normalizedUrl);
  }
  
  // iPhone（Braveブラウザ含む）でデスクトップに偽装するため、プロキシ経由で読み込む
  // ただし、Bilibili、douga4、ivfree、pizjavの場合は既に処理されているため除外
  const isIOSDevice = isIPhone();
  if (isIOSDevice && source !== 'bilibili' && source !== 'douga4' && source !== 'ivfree' && source !== 'pizjav' && source !== 'jpdmv') {
    // プロキシエンドポイント経由でデスクトップのUser-Agentで読み込む
    const proxyUrl = `/api/proxy-video?url=${encodeURIComponent(normalizedUrl)}`;
    normalizedUrl = proxyUrl;
  }
  
  // 登録ソースはすべて sandbox なし・再生に必要な allow を付与（動画が再生できるようにする）
  const playbackSources = ['bilibili', 'douga4', 'ivfree', 'jpdmv', 'pizjav', 'javmix', 'japanhub', 'fc2video', 'jable', 'x1hub', 'airav'];
  if (playbackSources.includes(source)) {
    iframe.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture; encrypted-media; playsinline; accelerometer; gyroscope; clipboard-write; clipboard-read');
    iframe.setAttribute('referrerpolicy', 'no-referrer-when-downgrade');
    iframe.removeAttribute('sandbox');
  } else {
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
    actualVideoUrl.includes('lulustream.com') ||
    actualVideoUrl.includes('cdn.loadvid.com') || 
    actualVideoUrl.includes('loadvid.com') ||
    actualVideoUrl.includes('luluvid.com') ||
    actualVideoUrl.includes('luluvdoo.com') ||
    actualVideoUrl.includes('embed') ||
    normalizedUrl.includes('/api/ivfree-proxy')
  );
  
  if (source === 'pizjav' && normalizedUrl.includes('/api/pizjav-proxy')) {
    iframe.removeAttribute('sandbox');
  }
  if (source === 'ivfree' && normalizedUrl.includes('/api/ivfree-proxy')) {
    // ivfree-proxy経由の場合はsandboxを付けない（cookie/localStorageでvidnest等が再生に必要）
    iframe.removeAttribute('sandbox');
  } else if (source === 'ivfree' && !isIVFreeExternalVideoForSandbox) {
    // sandbox属性でポップアップを制限（ただし、動画再生に必要な権限は許可）
    iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups-to-escape-sandbox allow-presentation allow-top-navigation-by-user-activation');
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
  
  // 外部動画サイト・Pizjavプロキシの場合は、src設定後にもsandbox属性を確実に削除
  if ((source === 'ivfree' && isIVFreeExternalVideoForSandbox) || (source === 'pizjav' && normalizedUrl.includes('/api/pizjav-proxy'))) {
    setTimeout(() => { iframe.removeAttribute('sandbox'); }, 0);
    setTimeout(() => { iframe.removeAttribute('sandbox'); }, 100);
    setTimeout(() => { iframe.removeAttribute('sandbox'); }, 500);
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
  
  // iframe内の広告ブロッカー検出メッセージを削除（iframe読み込み後に実行）
  iframe.addEventListener('load', function() {
    try {
      // iframe内のドキュメントにアクセス（同一オリジンの場合のみ）
      const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
      if (iframeDoc) {
        // 広告ブロッカー検出メッセージを削除
        const adBlockMessages = iframeDoc.querySelectorAll('*');
        adBlockMessages.forEach(function(elem) {
          const text = elem.textContent || elem.innerText || '';
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
            text.includes('click ADS to continue')
          )) {
            elem.remove();
          }
        });
        
        // MutationObserverで広告ブロッカー検出メッセージを監視して削除
        const observer = new MutationObserver(function(mutations) {
          mutations.forEach(function(mutation) {
            mutation.addedNodes.forEach(function(node) {
              if (node.nodeType === 1) {
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
                  text.includes('click ADS to continue')
                )) {
                  node.remove();
                }
              }
            });
          });
        });
        
        if (iframeDoc.body) {
          observer.observe(iframeDoc.body, {
            childList: true,
            subtree: true
          });
        }
      }
    } catch (e) {
      // クロスオリジンの場合はアクセスできない（エラーは無視）
    }
  });
  
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
  // Pizjavはページ内にヘッダーがあり動画が下にずれるため、表示を高くして動画が入りやすくする
  container.style.paddingTop = source === 'pizjav' ? '90%' : '56.25%'; // 16:9
  container.style.background = '#000';
  container.style.borderRadius = '8px';
  container.style.overflow = 'hidden';
  
  container.appendChild(iframe);
  
  // JPdmvの場合は「jpdmv.comで開く」リンクを常に表示（プロキシが失敗しやすくiframeもブロックされやすいため）
  if (source === 'jpdmv' && originalUrl) {
    const jpdmvOpenUrl = originalUrl.startsWith('http') ? originalUrl : `https:${originalUrl}`;
    const openLink = document.createElement('a');
    openLink.href = jpdmvOpenUrl;
    openLink.target = '_blank';
    openLink.rel = 'noopener noreferrer';
    openLink.className = 'jpdmv-open-original';
    openLink.textContent = 'jpdmv.comで開く';
    openLink.style.cssText = 'position: absolute; bottom: 0; left: 0; right: 0; display: block; text-align: center; padding: 8px 12px; background: rgba(0,0,0,0.85); color: #fff; font-size: 13px; text-decoration: none; z-index: 1000; border-radius: 0 0 8px 8px;';
    container.appendChild(openLink);
  }
  
  // Pizjavの場合は「v.pizjav.comで開く」リンクと位置ずれデバッグ用の案内を表示
  if (source === 'pizjav' && originalUrl) {
    const pizjavOpenUrl = originalUrl.startsWith('http') ? originalUrl : `https:${originalUrl}`;
    const openLink = document.createElement('a');
    openLink.href = pizjavOpenUrl;
    openLink.target = '_blank';
    openLink.rel = 'noopener noreferrer';
    openLink.className = 'pizjav-open-original';
    openLink.textContent = 'v.pizjav.comで開く';
    openLink.style.cssText = 'position: absolute; bottom: 0; left: 0; right: 0; display: block; text-align: center; padding: 8px 12px; background: rgba(0,0,0,0.85); color: #fff; font-size: 13px; text-decoration: none; z-index: 1000; border-radius: 0 0 8px 8px;';
    container.appendChild(openLink);
    // 位置ずれデバッグ: コンテナ・iframe寸法と案内（Pizjavはページ内にヘッダーがあり動画が下にずれることがある）
    const debugWrap = document.createElement('div');
    debugWrap.id = `pizjav-debug-${videoId}`;
    debugWrap.className = 'pizjav-debug';
    debugWrap.style.cssText = 'position: absolute; top: 0; left: 0; right: 0; padding: 6px 8px; background: rgba(0,0,0,0.75); color: #ccc; font-size: 11px; z-index: 1001; line-height: 1.3; pointer-events: none;';
    const updatePizjavDebug = () => {
      if (!debugWrap.parentNode || !container.parentNode) return;
      const rect = container.getBoundingClientRect();
      const ifr = container.querySelector('iframe');
      const iframeSize = ifr ? `${ifr.offsetWidth}×${ifr.offsetHeight}` : '—';
      debugWrap.innerHTML = `[Pizjav] コンテナ: ${Math.round(rect.width)}×${Math.round(rect.height)}px / iframe: ${iframeSize} — 動画の位置が合わない場合は「v.pizjav.comで開く」で別タブで視聴`;
    };
    updatePizjavDebug();
    container.appendChild(debugWrap);
    const debugInterval = setInterval(() => {
      if (!debugWrap.parentNode) { clearInterval(debugInterval); return; }
      updatePizjavDebug();
    }, 1500);
  }
  
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
    normalizedUrl.includes('lulustream.com') ||
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
    const ivfreeFetchUrl = (originalUrl && originalUrl.includes('ivfree.asia')) ? originalUrl : normalizedUrl;
    fetch(`/api/ivfree-video?url=${encodeURIComponent(ivfreeFetchUrl)}`)
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
                                      data.embedUrl.includes('lulustream.com') ||
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
        console.log('ℹ️ IVFree動画URL取得エラー（既にプロキシ経由で表示中）:', error.message);
        ivfreeStatusText = 'プロキシ経由で表示中';
        ivfreeUpdateDebugInfo();
      });
  }

  // IVFreeをプロキシで表示している場合も、バックグラウンドで動画URL取得して再生できれば差し替え
  if (source === 'ivfree' && normalizedUrl.includes('/api/ivfree-proxy') && originalUrl && originalUrl.includes('ivfree.asia')) {
    fetch(`/api/ivfree-video?url=${encodeURIComponent(originalUrl)}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data && data.embedUrl && container.querySelector('iframe')) {
          const ifr = container.querySelector('iframe');
          const isExternal = /vidnest|lulustream|loadvid|luluvid|embed/i.test(data.embedUrl);
          if (isExternal) {
            ifr.removeAttribute('sandbox');
            ifr.src = data.embedUrl;
          } else {
            ifr.src = `/api/ivfree-proxy?url=${encodeURIComponent(data.embedUrl)}`;
          }
        }
      })
      .catch(() => {});
  }

  // JPdmvの動画URLを取得（ページ内プレイヤーが読み込めない場合に備えて差し替え）
  if (source === 'jpdmv') {
    let jpdmvStatusText = 'JPdmv: URL取得中...';
    let jpdmvEmbedUrl = '';
    const ensureJpdmvDebug = () => {
      let el = container.querySelector('.debug-info');
      if (!el) {
        el = document.createElement('div');
        el.className = 'debug-info';
        el.style.cssText = 'position: absolute; top: 10px; left: 10px; background: rgba(0,0,0,0.85); color: white; padding: 10px 12px; border-radius: 8px; font-size: 11px; z-index: 9999; max-width: 95%; word-break: break-all; line-height: 1.35;';
        container.appendChild(el);
      }
      const currentSrc = iframe.src || '未設定';
      el.innerHTML = `
        <div style="font-weight:bold; margin-bottom:6px;">📺 JPdmv デバッグ</div>
        <div>状態: ${escapeHtml(jpdmvStatusText)}</div>
        <div style="margin-top:6px;">originalUrl:</div>
        <div style="font-size:10px;">${escapeHtml(originalUrl || '')}</div>
        <div style="margin-top:6px;">embedUrl(取得):</div>
        <div style="font-size:10px;">${escapeHtml(jpdmvEmbedUrl || '')}</div>
        <div style="margin-top:6px;">iframe.src(現在):</div>
        <div style="font-size:10px;">${escapeHtml(currentSrc)}</div>
      `;
    };

    ensureJpdmvDebug();
    console.log('📺 JPdmv動画URLをサーバーから取得中...', originalUrl);
    fetch(`/api/jpdmv-video?url=${encodeURIComponent(originalUrl)}`)
      .then(response => {
        jpdmvStatusText = `JPdmv: レスポンス受信 (HTTP ${response.status})`;
        ensureJpdmvDebug();
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then(data => {
        if (data?.embedUrl && typeof data.embedUrl === 'string') {
          jpdmvEmbedUrl = data.embedUrl;
          jpdmvStatusText = 'JPdmv: embedUrl取得OK';
          ensureJpdmvDebug();

          const directUrl = data.embedUrl.startsWith('http') ? data.embedUrl : `https:${data.embedUrl}`;
          const norm = (u) => (u || '').replace(/\/$/, '');
          // 既に元のページを直接表示している場合はそのまま（プロキシで上書きしない）
          if (norm(iframe.src) === norm(directUrl)) {
            jpdmvStatusText = 'JPdmv: 直接表示のまま';
            ensureJpdmvDebug();
            console.log('✅ JPdmv: 直接表示のまま維持');
            return;
          }

          // 二重エンコード防止: 1回デコードしてからクエリに渡す
          let urlForProxy = data.embedUrl;
          try {
            urlForProxy = decodeURIComponent(String(data.embedUrl));
          } catch (e) { /* そのまま使用 */ }
          const nextSrc = `/api/proxy-video?url=${encodeURIComponent(urlForProxy)}`;
          // プロキシで表示を試す
          iframe.removeAttribute('sandbox');
          iframe.src = nextSrc;
          jpdmvStatusText = 'JPdmv: iframe.src を更新（proxy-video）';
          ensureJpdmvDebug();
          console.log('✅ JPdmv動画URLへ切り替え（proxy-video）:', data.embedUrl);
          // プロキシが502/500のときだけ元のページを直接表示に切り替え
          fetch(nextSrc, { method: 'GET', mode: 'same-origin' })
            .then(r => {
              if (!r.ok && (r.status === 502 || r.status === 500)) {
                if (container.parentNode && iframe.parentNode && iframe.src === nextSrc) {
                  iframe.removeAttribute('sandbox');
                  iframe.src = directUrl;
                  jpdmvStatusText = 'JPdmv: プロキシ失敗のため元のページを直接表示';
                  ensureJpdmvDebug();
                  console.log('🔄 JPdmv: フォールバックで元のページを直接表示:', directUrl);
                }
              }
            })
            .catch(() => {
              if (container.parentNode && iframe.parentNode && iframe.src === nextSrc) {
                iframe.removeAttribute('sandbox');
                iframe.src = directUrl;
                jpdmvStatusText = 'JPdmv: プロキシ失敗のため元のページを直接表示';
                ensureJpdmvDebug();
                console.log('🔄 JPdmv: フォールバックで元のページを直接表示:', directUrl);
              }
            });
        }
      })
      .catch(error => {
        // 失敗しても、既にjpdmv-proxy等で表示は試みているため、そのまま継続
        jpdmvStatusText = `JPdmv: 取得エラー（表示継続）: ${error.message}`;
        ensureJpdmvDebug();
        console.log('ℹ️ JPdmv動画URL取得エラー（表示継続）:', error.message);
      });
  }
  
  // iOS Safariではiframeの読み込み確認が難しいため、タイムアウトを長めに設定
  // タイムアウトでエラー検出（Bilibiliとdouga4の場合は15秒、IVFreeは20秒、その他は10秒）
  const timeoutDuration = (source === 'bilibili' || source === 'douga4') ? 15000 :
                          (source === 'ivfree' || source === 'jpdmv') ? 20000 : 10000;
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
    'pizjav': 'Pizjav',
    'mat6tube': 'Mat6tube',
    'fc2video': 'FC2Video.org',
    'japanhub': 'Japanhub',
    'jable': 'Jable',
    'airav': 'Airav',
    'test': 'テスト'
  };
  return names[source] || (source ? String(source) : '');
}

// HTMLエスケープ
function escapeHtml(text) {
  if (text == null || text === '') return '';
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

// 登録サイトのトップURL（サイト全体をVMEDA内で広告除去表示）
const SITE_BASE_URLS = {
  ivfree: 'http://ivfree.asia/',
  aivfree: 'http://aivfree.com/',
  jpdmv: 'https://jpdmv.com/',
  pizjav: 'https://v.pizjav.com/',
  javmix: 'https://javmix.tv/',
  japanhub: 'https://japanhub.net/',
  douga4: 'https://douga4.top/',
  fc2video: 'https://fc2video.org/',
  jable: 'https://jable.tv/',
  x1hub: 'https://x1hub.com/',
  airav: 'https://airav.io/'
};

// サイト攻略デバッグ（localStorage）
function vmedaDebugEnabled() {
  try { return localStorage.getItem('vmeda_debug') === '1'; } catch (e) { return false; }
}
function setVmedaDebug(on) {
  try { localStorage.setItem('vmeda_debug', on ? '1' : '0'); } catch (e) {}
}

// VMEDAフィルター経由でサイト全体を表示（あらゆるサイトをフィルター通過→広告除去）
function openSiteInFrame(source) {
  if (!source) return;
  const baseUrl = SITE_BASE_URLS[source];
  if (!baseUrl) {
    console.warn('Unknown source:', source);
    return;
  }
  const wrap = document.getElementById('site-frame-wrap');
  const frame = document.getElementById('site-frame');
  if (!wrap || !frame) return;
  let proxyUrl = '/api/site-proxy?url=' + encodeURIComponent(baseUrl);
  if (vmedaDebugEnabled()) proxyUrl += '&vmeda_debug=1';
  frame.src = proxyUrl;
  wrap.classList.remove('hidden');
  const results = document.getElementById('results');
  const sortContainer = document.getElementById('sort-container');
  if (results) results.classList.add('hidden');
  if (sortContainer) sortContainer.classList.add('hidden');
  console.log('📄 サイトをVMEDAフィルター経由で表示:', baseUrl);
  if (vmedaDebugEnabled()) console.log('🐛 デバッグON プロキシURL:', proxyUrl);
}

function closeSiteFrame() {
  const wrap = document.getElementById('site-frame-wrap');
  const frame = document.getElementById('site-frame');
  if (wrap) wrap.classList.add('hidden');
  if (frame) frame.src = '';
  const results = document.getElementById('results');
  const sortContainer = document.getElementById('sort-container');
  if (results) results.classList.remove('hidden');
  if (sortContainer) sortContainer.classList.remove('hidden');
}

// 登録サイトボタン（VMEDAフィルター経由でサイト全体を表示）
document.querySelectorAll('.site-btn').forEach(btn => {
  const source = btn.getAttribute('data-source');
  if (source) {
    btn.addEventListener('click', () => openSiteInFrame(source));
  }
});

document.getElementById('site-frame-back')?.addEventListener('click', closeSiteFrame);

const siteFrameEl = document.getElementById('site-frame');
document.getElementById('site-frame-history-back')?.addEventListener('click', () => {
  try {
    if (siteFrameEl && siteFrameEl.contentWindow) {
      siteFrameEl.contentWindow.history.back();
    }
  } catch (e) {}
});
document.getElementById('site-frame-history-forward')?.addEventListener('click', () => {
  try {
    if (siteFrameEl && siteFrameEl.contentWindow) {
      siteFrameEl.contentWindow.history.forward();
    }
  } catch (e) {}
});

// サイト攻略デバッグパネル
(function() {
  const panel = document.getElementById('vmeda-debug-panel');
  const toggleBtn = document.getElementById('vmeda-debug-toggle');
  const proxyUrlInput = document.getElementById('vmeda-debug-proxy-url');
  const realUrlInput = document.getElementById('vmeda-debug-real-url');
  const statsEl = document.getElementById('vmeda-debug-stats');
  const copyBtn = document.getElementById('vmeda-debug-copy-url');
  const copyAllBtn = document.getElementById('vmeda-debug-copy-all');
  const openTabBtn = document.getElementById('vmeda-debug-open-tab');
  let lastDebugData = null;
  let lastClientDebug = null;

  function updatePanelFromFrame() {
    if (!siteFrameEl || !proxyUrlInput) return;
    try {
      const src = siteFrameEl.src || '';
      proxyUrlInput.value = src;
      const m = src.match(/url=([^&]+)/);
      if (m) try { realUrlInput.value = decodeURIComponent(m[1]); } catch (e) { realUrlInput.value = m[1]; }
    } catch (e) {}
  }

  function renderDebugStats() {
    if (!statsEl) return;
    const merged = lastDebugData ? { ...lastDebugData } : {};
    if (lastClientDebug) {
      merged.clientRemovedTotal = lastClientDebug.clientRemovedTotal;
      merged.clientCandidatesThisRun = lastClientDebug.clientCandidatesThisRun;
      merged.clientRemovedThisRun = lastClientDebug.clientRemovedThisRun;
      merged.clientSkippedCount = lastClientDebug.clientSkippedCount;
      merged.clientLastSnippets = lastClientDebug.lastSnippets;
      if (lastClientDebug.clientSkipped && lastClientDebug.clientSkipped.length) merged.clientSkipped = lastClientDebug.clientSkipped;
      if (lastClientDebug.bottomOverlayCandidatesThisRun != null) merged.bottomOverlayCandidatesThisRun = lastClientDebug.bottomOverlayCandidatesThisRun;
      if (lastClientDebug.bottomOverlayRemovedThisRun != null) merged.bottomOverlayRemovedThisRun = lastClientDebug.bottomOverlayRemovedThisRun;
      if (lastClientDebug.bottomOverlayRemovedTotal != null) merged.bottomOverlayRemovedTotal = lastClientDebug.bottomOverlayRemovedTotal;
      if (lastClientDebug.bottomOverlayRemovedSnippets && lastClientDebug.bottomOverlayRemovedSnippets.length) merged.bottomOverlayRemovedSnippets = lastClientDebug.bottomOverlayRemovedSnippets;
      if (lastClientDebug.bottomOverlaySkipped && lastClientDebug.bottomOverlaySkipped.length) merged.bottomOverlaySkipped = lastClientDebug.bottomOverlaySkipped;
    }
    var summary = '';
    if (merged.scriptsRemoved != null) summary += 'サーバー: スクリプト除去 ' + merged.scriptsRemoved + ', アドブロック候補チェック ' + (merged.adblockCandidatesChecked != null ? merged.adblockCandidatesChecked : '?') + ', 除去 ' + (merged.adblockElementsRemoved != null ? merged.adblockElementsRemoved : '?') + ', URL書き換え ' + (merged.resourcesRewritten != null ? merged.resourcesRewritten : '?');
    if (merged.clientRemovedTotal != null || merged.clientCandidatesThisRun != null) summary += (summary ? ' | ' : '') + 'クライアント: 候補 ' + (merged.clientCandidatesThisRun != null ? merged.clientCandidatesThisRun : '?') + ', 除去合計 ' + (merged.clientRemovedTotal != null ? merged.clientRemovedTotal : '?') + ', スキップ ' + (merged.clientSkippedCount != null ? merged.clientSkippedCount : '?');
    if (merged.bottomOverlayCandidatesThisRun != null || merged.bottomOverlayRemovedTotal != null) summary += (summary ? ' | ' : '') + '動画下部バナー: 候補 ' + (merged.bottomOverlayCandidatesThisRun != null ? merged.bottomOverlayCandidatesThisRun : '?') + ', 今回除去 ' + (merged.bottomOverlayRemovedThisRun != null ? merged.bottomOverlayRemovedThisRun : '?') + ', 除去合計 ' + (merged.bottomOverlayRemovedTotal != null ? merged.bottomOverlayRemovedTotal : '?');
    var body = Object.keys(merged).length ? JSON.stringify(merged, null, 2) : '(データなし)';
    statsEl.textContent = summary ? summary + '\n\n' + body : body;
  }

  window.addEventListener('message', function(e) {
    if (!e.data) return;
    if (e.data.type === 'vmeda-debug' && e.data.data) {
      lastDebugData = e.data.data;
      if (realUrlInput) realUrlInput.value = lastDebugData.decodedUrl || '';
      renderDebugStats();
    } else if (e.data.type === 'vmeda-debug-client') {
      lastClientDebug = {
        clientRemovedTotal: e.data.clientRemovedTotal,
        clientCandidatesThisRun: e.data.clientCandidatesThisRun,
        clientRemovedThisRun: e.data.clientRemovedThisRun,
        clientSkippedCount: e.data.clientSkippedCount,
        lastSnippets: e.data.lastSnippets || [],
        clientSkipped: e.data.clientSkipped || [],
        bottomOverlayCandidatesThisRun: e.data.bottomOverlayCandidatesThisRun,
        bottomOverlayRemovedThisRun: e.data.bottomOverlayRemovedThisRun,
        bottomOverlayRemovedTotal: e.data.bottomOverlayRemovedTotal,
        bottomOverlayRemovedSnippets: e.data.bottomOverlayRemovedSnippets || [],
        bottomOverlaySkipped: e.data.bottomOverlaySkipped || []
      };
      renderDebugStats();
    }
  });

  siteFrameEl?.addEventListener('load', function() {
    if (vmedaDebugEnabled()) updatePanelFromFrame();
  });

  if (toggleBtn && panel) {
    if (vmedaDebugEnabled()) { panel.classList.remove('hidden'); toggleBtn.classList.add('active'); }
    toggleBtn.addEventListener('click', function() {
      const on = panel.classList.toggle('hidden');
      const debugNowOn = !on;
      setVmedaDebug(debugNowOn);
      toggleBtn.classList.toggle('active', !on);
      if (!on) updatePanelFromFrame();
      if (debugNowOn && siteFrameEl && siteFrameEl.src && siteFrameEl.src.indexOf('site-proxy') !== -1 && siteFrameEl.src.indexOf('vmeda_debug=1') === -1) {
        var newSrc = siteFrameEl.src + (siteFrameEl.src.indexOf('?') === -1 ? '?' : '&') + 'vmeda_debug=1';
        siteFrameEl.src = newSrc;
        if (proxyUrlInput) proxyUrlInput.value = newSrc;
        if (realUrlInput) {
          var match = newSrc.match(/url=([^&]+)/);
          if (match) try { realUrlInput.value = decodeURIComponent(match[1]); } catch (er) { realUrlInput.value = match[1]; }
        }
      }
    });
  }
  document.addEventListener('keydown', function(e) {
    if (e.ctrlKey && e.shiftKey && e.key === 'D') {
      e.preventDefault();
      if (panel && toggleBtn) { panel.classList.toggle('hidden'); setVmedaDebug(!panel.classList.contains('hidden')); toggleBtn.classList.toggle('active', !panel.classList.contains('hidden')); if (!panel.classList.contains('hidden')) updatePanelFromFrame(); }
    }
  });

  if (copyBtn && proxyUrlInput) copyBtn.addEventListener('click', function() {
    const url = proxyUrlInput.value;
    if (!url) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function() { copyBtn.textContent = 'コピー済'; setTimeout(function() { copyBtn.textContent = 'URLコピー'; }, 1500); });
    } else {
      proxyUrlInput.select();
      document.execCommand('copy');
      copyBtn.textContent = 'コピー済';
      setTimeout(function() { copyBtn.textContent = 'URLコピー'; }, 1500);
    }
  });
  if (copyAllBtn) copyAllBtn.addEventListener('click', function() {
    var lines = [];
    if (proxyUrlInput && proxyUrlInput.value) lines.push('プロキシURL: ' + proxyUrlInput.value);
    if (realUrlInput && realUrlInput.value) lines.push('実URL: ' + realUrlInput.value);
    if (statsEl && statsEl.textContent) lines.push('統計 (最終ページ):\n' + statsEl.textContent);
    var text = lines.join('\n\n');
    if (!text) text = '(データなし)';
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function() { copyAllBtn.textContent = 'コピー済'; setTimeout(function() { copyAllBtn.textContent = 'デバッグ一括コピー'; }, 1500); });
    } else {
      var ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
      copyAllBtn.textContent = 'コピー済';
      setTimeout(function() { copyAllBtn.textContent = 'デバッグ一括コピー'; }, 1500);
    }
  });
  if (openTabBtn && proxyUrlInput) openTabBtn.addEventListener('click', function() {
    const url = proxyUrlInput.value;
    if (url) window.open(url, '_blank');
  });
})();

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

