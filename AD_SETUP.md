# 広告収入の設定ガイド

## 広告ネットワークの選択

### 1. Google AdSense（一般的なサイト向け）

**メリット:**
- 最も一般的で信頼性が高い
- 自動的に最適な広告を表示
- 収益化が比較的簡単

**デメリット:**
- アダルトコンテンツがある場合は承認されない可能性がある
- 審査が必要（数日〜数週間）

**申請方法:**
1. [Google AdSense](https://www.google.com/adsense) にアクセス
2. アカウントを作成
3. サイトを登録
4. 審査を待つ（通常1-2週間）
5. 承認後、広告コードを取得

### 2. アダルト向け広告ネットワーク（アダルトコンテンツがある場合）

アダルトコンテンツがある場合は、以下の広告ネットワークを検討してください：

- **ExoClick**: アダルト向け広告ネットワーク
- **JuicyAds**: アダルト向け広告ネットワーク
- **TrafficJunky**: アダルト向け広告ネットワーク

## 広告の配置場所

推奨される広告の配置場所：

1. **ヘッダー下**: 検索バーの上または下
2. **検索結果の間**: 検索結果の間に広告を挿入
3. **サイドバー**: デスクトップ版のサイドバー（現在はサイドバーなし）
4. **フッター上**: ページ下部

## 実装方法

### Google AdSenseの場合

1. **広告コードを取得**
   - Google AdSenseダッシュボードで広告ユニットを作成
   - 広告コードをコピー

2. **HTMLに追加**
   - 適切な場所に広告コードを追加
   - レスポンシブ広告を使用

3. **プライバシーポリシーを更新**
   - 広告について記載
   - Google AdSenseのポリシーに準拠

## 注意事項

1. **コンテンツポリシー**
   - Google AdSenseはアダルトコンテンツを許可していません
   - アダルトコンテンツがある場合は、アダルト向け広告ネットワークを使用してください

2. **ユーザー体験**
   - 広告が多すぎるとユーザー体験が悪化します
   - 適切なバランスを保つことが重要です

3. **プライバシー**
   - 広告ネットワークはトラッキングクッキーを使用する場合があります
   - プライバシーポリシーを更新する必要があります

## 実装例

Google AdSenseの広告コード例：

```html
<!-- ヘッダー下の広告 -->
<div class="ad-container ad-header">
  <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-XXXXXXXXXX"
     crossorigin="anonymous"></script>
  <ins class="adsbygoogle"
       style="display:block"
       data-ad-client="ca-pub-XXXXXXXXXX"
       data-ad-slot="XXXXXXXXXX"
       data-ad-format="auto"
       data-full-width-responsive="true"></ins>
  <script>
     (adsbygoogle = window.adsbygoogle || []).push({});
  </script>
</div>
```


