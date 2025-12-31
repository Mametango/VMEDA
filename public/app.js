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

// 検索機能
const searchInput = document.getElementById('search-input');
const searchBtn = document.getElementById('search-btn');
const resultsDiv = document.getElementById('results');
const loadingDiv = document.getElementById('loading');
const recentSearchesDiv = document.getElementById('recent-searches');
const recentSearchesList = document.getElementById('recent-searches-list');
const sortContainer = document.getElementById('sort-container');
const sortSelect = document.getElementById('sort-select');

// 現在の検索結果を保持
let currentVideos = [];

// 検索実行
async function searchVideos(query) {
  if (!query || query.trim().length === 0) {
    alert('検索キーワードを入力してください');
    return;
  }

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
      throw new Error(errorData.error || '検索に失敗しました');
    }

    const data = await response.json();
    console.log('📊 検索結果:', data.results?.length || 0, '件');
    console.log('📊 データ内容:', JSON.stringify(data).substring(0, 500));
    
    if (!data.results || data.results.length === 0) {
      console.warn('⚠️ 検索結果が空です。テストデータが返されているか確認してください。');
    }
    
    const videos = data.results || [];
    currentVideos = videos;
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

// 結果表示
function displayResults(videos, searchQuery) {
  if (videos.length === 0) {
    resultsDiv.innerHTML = `
      <div class="no-results">検索結果が見つかりませんでした</div>
    `;
    return;
  }

  const html = videos.map(video => {
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
    
    const hasThumbnail = thumbnail && thumbnail.length > 0 && (thumbnail.startsWith('http://') || thumbnail.startsWith('https://') || thumbnail.startsWith('data:'));
    
    const duration = video.duration || '';
    const showDuration = duration && duration.trim().length > 0;
    
    // Bilibiliの動画の場合はアイコンを変更
    const isBilibili = video.source === 'bilibili';
    const playIcon = isBilibili ? '📺' : '▶';
    
    return `
    <div class="video-item">
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

  resultsDiv.innerHTML = html;
  
  // iPhoneでのタッチイベントをクリックイベントとして処理
  // 動画プレイヤーコンテナにタッチイベントリスナーを追加
  document.querySelectorAll('.video-thumbnail-wrapper, .play-btn').forEach(element => {
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
  
  // 検索結果表示後、広告を検索結果の間に挿入
  insertAdsInResults();
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

async function loadRecentSearches() {
  // recentSearchesDivとrecentSearchesListが存在するか確認
  if (!recentSearchesDiv || !recentSearchesList) {
    console.error('❌ 検索履歴のDOM要素が見つかりません');
    return;
  }

  try {
    // キャッシュを無効化して最新のデータを取得（検索履歴が表示されない問題を解決）
    const response = await fetch('/api/recent-searches', {
      cache: 'no-cache', // キャッシュを無効化して最新データを取得
      headers: {
        'Cache-Control': 'no-cache'
      }
    });
    if (!response.ok) {
      console.error('❌ 検索履歴取得エラー:', response.status, response.statusText);
      // エラー時は既存の表示を保持
      if (currentDisplayedSearches.length > 0) {
        console.log('ℹ️ エラー時は既存の検索履歴を保持します');
        return;
      }
      // 既存の表示がない場合のみ空を表示
      displayRecentSearches([]);
      recentSearchesDiv.style.display = 'block';
      return;
    }
    
    const data = await response.json();
    const searches = data.searches || [];
    console.log('📋 検索履歴取得:', searches.length, '件');
    console.log('📋 検索履歴データ:', JSON.stringify(searches.slice(0, 3)));
    
    // 検索履歴を常に表示（空の場合も含む）
    if (searches.length > 0) {
      console.log('📋 検索履歴サンプル:', searches.slice(0, 5).map(s => s.query).join(', '));
      // 新しい検索履歴を表示
      currentDisplayedSearches = searches;
      displayRecentSearches(searches);
    } else {
      // 検索履歴が空の場合でも表示を更新
      console.log('ℹ️ 検索履歴が空です');
      displayRecentSearches([]);
    }
    
    // 検索履歴エリアを確実に表示
    recentSearchesDiv.style.display = 'block';
    console.log('✅ 検索履歴エリアを表示しました');
  } catch (error) {
    console.error('❌ 検索履歴取得エラー:', error);
    // エラー時は既存の表示を保持
    if (currentDisplayedSearches.length > 0) {
      console.log('ℹ️ エラー時は既存の検索履歴を保持します');
      return;
    }
    // 既存の表示がない場合のみ空を表示
    displayRecentSearches([]);
    recentSearchesDiv.style.display = 'block';
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
    // 検索履歴が空の場合でも表示を更新
    recentSearchesList.innerHTML = '<p class="no-recent-searches">まだ検索履歴がありません</p>';
    console.log('ℹ️ 検索履歴が空のため、空のメッセージを表示しました');
    return;
  }
  
  // 現在表示中の検索履歴を更新
  currentDisplayedSearches = searches;
  
  const html = searches.map(search => {
    if (!search || !search.query) {
      console.warn('⚠️ 無効な検索履歴:', search);
      return '';
    }
    return `
      <div class="recent-search-item" onclick="searchInput.value='${escapeHtml(search.query)}'; searchVideos('${escapeHtml(search.query)}')">
        <span class="recent-search-query">${escapeHtml(search.query)}</span>
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

// ページ読み込み時に他のユーザーの検索ワードを取得
loadRecentSearches();

// 定期的に検索履歴を更新（30秒ごと、頻繁すぎると消える可能性があるため間隔を長く）
// エラー時や空の場合は既存の表示を保持するため、検索履歴が消えることはありません
setInterval(() => {
  console.log('🔄 検索履歴を定期更新中...');
  loadRecentSearches();
}, 30000); // 30秒ごとに更新

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
  const ua = navigator.userAgent;
  const isIOS = /iPhone|iPod|iPad/.test(ua) && !window.MSStream;
  return isIOS;
}

// プレイヤー表示（グローバルスコープに公開）
window.showPlayer = function(videoId, embedUrl, originalUrl, source, event) {
  console.log('▶ プレイヤー表示:', videoId, embedUrl, 'source:', source);
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
  
  // iPhoneでもデスクトップと同じ埋め込み動画プレイヤーを使用
  // レスポンシブデザインを削除したため、iPhoneでも同じ仕様で動作
  
  // 他の動画が再生中の場合、停止する
  if (currentPlayingVideoId && currentPlayingVideoId !== videoId) {
    stopVideo(currentPlayingVideoId);
  }
  
  // 現在の動画IDを記録
  currentPlayingVideoId = videoId;
  
  // 埋め込み可能かどうかを判定（基本的には試してみる）
  const canEmbed = isEmbeddable(embedUrl, source);
  console.log('🔍 埋め込み判定:', canEmbed, 'URL:', embedUrl, 'Source:', source);
  
  // 埋め込みが明らかに不可能な場合のみ、元のURLに直接リンク
  // それ以外は埋め込みを試み、エラーが発生した場合にフォールバック
  
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
        urlObj.searchParams.set('high_quality', '1'); // 高画質
        urlObj.searchParams.set('danmaku', '0'); // コメントオフ
        normalizedUrl = urlObj.toString();
      } catch (e) {
        console.warn('⚠️ URLパラメータ追加エラー:', e);
      }
    }
    
    console.log('📺 Bilibili埋め込みURL:', normalizedUrl);
  }
  
  // iPhone（Braveブラウザ含む）でデスクトップに偽装するため、プロキシ経由で読み込む
  // ただし、Bilibiliの場合はプロキシ経由では動作しないため、直接埋め込みURLを使用
  const isIOSDevice = isIPhone();
  if (isIOSDevice && source !== 'bilibili') {
    // プロキシエンドポイント経由でデスクトップのUser-Agentで読み込む
    const proxyUrl = `/api/proxy-video?url=${encodeURIComponent(normalizedUrl)}`;
    normalizedUrl = proxyUrl;
    console.log('📱 iPhone/iOS: プロキシ経由で動画を読み込み:', proxyUrl);
  } else if (isIOSDevice && source === 'bilibili') {
    // Bilibiliの場合は直接埋め込みURLを使用（プロキシ経由では動作しない）
  }
  
  // Bilibiliの場合は、iPhone/Braveブラウザで特別な設定
  if (source === 'bilibili' && isIPhone()) {
    // iPhone/Braveブラウザの場合、より寛容な設定を適用
    // sandbox属性は設定しない（Bilibiliのプレイヤーが動作しなくなる可能性があるため）
    iframe.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture; encrypted-media; playsinline; accelerometer; gyroscope; clipboard-write; clipboard-read');
    iframe.setAttribute('referrerpolicy', 'no-referrer-when-downgrade');
    console.log('📱 iPhone/Brave: Bilibili用の特別な設定を適用');
  } else {
    // その他の場合は通常の設定
    iframe.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture; encrypted-media; playsinline');
  }
  
  iframe.src = normalizedUrl;
  iframe.allowFullscreen = true;
  iframe.className = 'video-player';
  iframe.setAttribute('loading', 'lazy');
  iframe.setAttribute('frameborder', '0');
  iframe.setAttribute('scrolling', 'no');
  // iOS Safari対応（全画面表示を許可）
  iframe.setAttribute('webkitallowfullscreen', 'true');
  iframe.setAttribute('mozallowfullscreen', 'true');
  iframe.setAttribute('playsinline', 'false'); // iPhoneで全画面表示
  
  // Bilibiliの場合は追加の属性を設定
  if (source === 'bilibili') {
    // 属性は既に設定済み
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
        console.log('ℹ️ iframeは表示されているため、エラー表示をスキップ');
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
    console.error('❌ iframeエラー:', error);
    showError();
  };
  
  // 読み込み完了を検出
  iframe.onload = () => {
    // タイムアウトを短縮（読み込み完了したので）
    if (errorTimeout) clearTimeout(errorTimeout);
    
    // Bilibiliの場合は、特別な処理を行う
    if (source === 'bilibili') {
      // BilibiliのプレイヤーはJavaScriptで動的に読み込まれるため、
      // 少し待ってからエラーチェックを行う
      setTimeout(() => {
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
            } else {
            }
          } else {
            // iOS SafariではCORSでアクセスできない場合が多いが、正常に動作している可能性がある
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
  
  
  // iOS Safariではiframeの読み込み確認が難しいため、タイムアウトを長めに設定
  // タイムアウトでエラー検出（Bilibiliの場合は15秒、その他は10秒）
  const timeoutDuration = source === 'bilibili' ? 15000 : 10000;
  errorTimeout = setTimeout(() => {
    if (hasError) return;
    
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
      console.log('ℹ️ iframeにアクセスできません（CORS）:', e.message);
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
    'japanhub': 'Japanhub',
    'tktube': 'Tktube',
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
    'missav': 'MissAV',
    'jav': 'JAV',
    '91porn': '91Porn',
    '91porn2': '91Porn2',
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
  for (let i = 3; i < videoItems.length; i += 5) {
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
    displayResults(sortedVideos, '');
  });
} else {
  console.error('❌ sortSelect要素が見つかりません');
}
