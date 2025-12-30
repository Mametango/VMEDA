const { ipcRenderer } = require('electron');

// タブ管理
let tabs = [];
let activeTabId = 'tab-1';
let tabCounter = 1;

// DOM要素
const tabsContainer = document.getElementById('tabs-container');
const newTabBtn = document.getElementById('new-tab-btn');
const addressInput = document.getElementById('address-input');
const goBtn = document.getElementById('go-btn');
const backBtn = document.getElementById('back-btn');
const forwardBtn = document.getElementById('forward-btn');
const reloadBtn = document.getElementById('reload-btn');
const homeBtn = document.getElementById('home-btn');
const loadingIndicator = document.getElementById('loading-indicator');

// ウィンドウコントロール
document.getElementById('minimize-btn').addEventListener('click', () => {
  ipcRenderer.invoke('window-minimize');
});

document.getElementById('maximize-btn').addEventListener('click', () => {
  ipcRenderer.invoke('window-maximize');
});

document.getElementById('close-btn').addEventListener('click', () => {
  ipcRenderer.invoke('window-close');
});

// タブ作成
function createTab(url = 'about:blank') {
  const tabId = `tab-${++tabCounter}`;
  const tab = {
    id: tabId,
    url: url,
    title: '新しいタブ',
    webview: null
  };

  tabs.push(tab);

  // タブUI作成
  const tabElement = document.createElement('div');
  tabElement.className = 'tab';
  tabElement.dataset.tabId = tabId;
  tabElement.innerHTML = `
    <span class="tab-title">新しいタブ</span>
    <button class="tab-close" data-tab-id="${tabId}">×</button>
  `;

  tabsContainer.appendChild(tabElement);

  // WebView作成
  const webview = document.createElement('webview');
  webview.id = `webview-${tabId}`;
  webview.src = url;
  webview.allowpopups = false; // ポップアップをブロック
  webview.style.display = tabId === activeTabId ? 'flex' : 'none';

  document.querySelector('.webview-container').appendChild(webview);
  tab.webview = webview;

  // イベントリスナー
  setupWebViewEvents(webview, tab);

  // タブクリック
  tabElement.addEventListener('click', (e) => {
    if (e.target.classList.contains('tab-close')) {
      closeTab(tabId);
    } else {
      switchTab(tabId);
    }
  });

  switchTab(tabId);
  return tab;
}

// WebViewイベント設定
function setupWebViewEvents(webview, tab) {
  // 許可されたナビゲーションを追跡
  let allowedNavigation = tab.url || 'about:blank';
  let isUserNavigation = false;

  // リダイレクトをブロック
  webview.addEventListener('will-navigate', (e) => {
    // ユーザーが明示的にナビゲートした場合のみ許可
    if (!isUserNavigation && e.url !== allowedNavigation) {
      console.log('リダイレクトをブロック:', e.url);
      e.preventDefault();
    }
    isUserNavigation = false;
  });

  // リダイレクトをブロック
  webview.addEventListener('will-redirect', (e) => {
    console.log('リダイレクトをブロック:', e.url);
    e.preventDefault();
  });

  // ポップアップを完全にブロック
  webview.addEventListener('new-window', (e) => {
    console.log('ポップアップをブロック:', e.url);
    e.preventDefault();
  });

  webview.addEventListener('did-start-loading', () => {
    if (tab.id === activeTabId) {
      loadingIndicator.classList.add('active');
      reloadBtn.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M3 16v-5m0 5h5"/>
        </svg>
      `;
    }
  });

  webview.addEventListener('did-stop-loading', () => {
    if (tab.id === activeTabId) {
      loadingIndicator.classList.remove('active');
      reloadBtn.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 8v5m0-5h-5"/>
          <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M3 16v-5m0 5h5"/>
        </svg>
      `;
    }
  });

  webview.addEventListener('page-title-updated', (e) => {
    tab.title = e.title;
    updateTabTitle(tab.id, e.title);
    if (tab.id === activeTabId) {
      document.title = e.title + ' - オリジナルブラウザ';
    }
  });

  webview.addEventListener('did-navigate', (e) => {
    tab.url = e.url;
    allowedNavigation = e.url;
    if (tab.id === activeTabId) {
      addressInput.value = e.url;
      updateNavigationButtons(webview);
    }
  });

  webview.addEventListener('did-navigate-in-page', (e) => {
    tab.url = e.url;
    allowedNavigation = e.url;
    if (tab.id === activeTabId) {
      addressInput.value = e.url;
      updateNavigationButtons(webview);
    }
  });

  // タブにナビゲーションフラグを保存
  tab.allowedNavigation = allowedNavigation;
  tab.isUserNavigation = () => { isUserNavigation = true; };
}

// タブ切り替え
function switchTab(tabId) {
  activeTabId = tabId;
  const tab = tabs.find(t => t.id === tabId);
  if (!tab) return;

  // タブUI更新
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.remove('active');
  });
  document.querySelector(`[data-tab-id="${tabId}"]`).classList.add('active');

  // WebView表示切り替え
  document.querySelectorAll('webview').forEach(w => {
    w.style.display = 'none';
  });
  if (tab.webview) {
    tab.webview.style.display = 'flex';
    addressInput.value = tab.url;
    updateNavigationButtons(tab.webview);
  }
}

// タブ閉じる
function closeTab(tabId) {
  if (tabs.length === 1) {
    // 最後のタブは閉じない
    return;
  }

  const tabIndex = tabs.findIndex(t => t.id === tabId);
  if (tabIndex === -1) return;

  tabs.splice(tabIndex, 1);
  document.querySelector(`[data-tab-id="${tabId}"]`).remove();
  document.getElementById(`webview-${tabId}`).remove();

  if (activeTabId === tabId) {
    // 閉じたタブがアクティブだった場合、前のタブに切り替え
    const newActiveTab = tabs[Math.max(0, tabIndex - 1)];
    if (newActiveTab) {
      switchTab(newActiveTab.id);
    }
  }
}

// タブタイトル更新
function updateTabTitle(tabId, title) {
  const tabElement = document.querySelector(`[data-tab-id="${tabId}"] .tab-title`);
  if (tabElement) {
    tabElement.textContent = title || '新しいタブ';
  }
}

// ナビゲーションボタン更新
function updateNavigationButtons(webview) {
  webview.canGoBack().then(canGoBack => {
    backBtn.disabled = !canGoBack;
  });
  webview.canGoForward().then(canGoForward => {
    forwardBtn.disabled = !canGoForward;
  });
}

// URL正規化
function normalizeURL(input) {
  input = input.trim();
  if (!input) return 'about:blank';

  // 既にURL形式の場合
  if (input.startsWith('http://') || input.startsWith('https://') || input.startsWith('file://') || input.startsWith('about:')) {
    return input;
  }

  // 検索クエリかURLか判定（簡易版）
  if (input.includes('.') && !input.includes(' ')) {
    // URLっぽい
    return 'https://' + input;
  } else {
    // 検索クエリ
    return `https://yandex.com/search/?text=${encodeURIComponent(input)}`;
  }
}

// ナビゲーション
function navigate(url) {
  const tab = tabs.find(t => t.id === activeTabId);
  if (tab && tab.webview) {
    const normalizedURL = normalizeURL(url);
    // ユーザーによるナビゲーションとしてマーク
    if (tab.isUserNavigation) {
      tab.isUserNavigation();
    }
    tab.allowedNavigation = normalizedURL;
    tab.webview.src = normalizedURL;
    tab.url = normalizedURL;
  }
}

// イベントリスナー
newTabBtn.addEventListener('click', () => {
  createTab();
});

goBtn.addEventListener('click', () => {
  navigate(addressInput.value);
});

addressInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    navigate(addressInput.value);
  }
});

backBtn.addEventListener('click', () => {
  const tab = tabs.find(t => t.id === activeTabId);
  if (tab && tab.webview) {
    if (tab.isUserNavigation) {
      tab.isUserNavigation();
    }
    tab.webview.goBack();
  }
});

forwardBtn.addEventListener('click', () => {
  const tab = tabs.find(t => t.id === activeTabId);
  if (tab && tab.webview) {
    if (tab.isUserNavigation) {
      tab.isUserNavigation();
    }
    tab.webview.goForward();
  }
});

reloadBtn.addEventListener('click', () => {
  const tab = tabs.find(t => t.id === activeTabId);
  if (tab && tab.webview) {
    if (tab.isUserNavigation) {
      tab.isUserNavigation();
    }
    tab.allowedNavigation = tab.url;
    tab.webview.reload();
  }
});

homeBtn.addEventListener('click', () => {
  navigate('about:blank');
});

// 初期タブ作成
createTab('about:blank');

