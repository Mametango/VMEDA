# Vercelで環境変数を設定する方法

## 手順

### 1. Vercelダッシュボードにアクセス

1. [Vercel Dashboard](https://vercel.com/dashboard) にログイン
2. プロジェクト（例: `vmeda`）をクリック

### 2. Settings（設定）を開く

1. プロジェクトページの上部メニューから **「Settings」** をクリック
   - または、左側のメニューから **「Settings」** を選択

### 3. Environment Variables（環境変数）を開く

1. Settingsページの左側メニューから **「Environment Variables」** をクリック
   - または、ページを下にスクロールして **「Environment Variables」** セクションを見つける

### 4. 環境変数を追加

1. **「Add New」** または **「Add」** ボタンをクリック

2. 以下の情報を入力：

   **Key（キー）:**
   ```
   MONGODB_URI
   ```

   **Value（値）:**
   ```
   mongodb+srv://username:password@cluster.mongodb.net/vmeda?retryWrites=true&w=majority
   ```
   - `username` をMongoDB Atlasのユーザー名に置き換える
   - `password` をMongoDB Atlasのパスワードに置き換える
   - `cluster` を実際のクラスター名に置き換える（例: `cluster0.xxxxx`）

3. **Environment（環境）** を選択：
   - ✅ **Production**（本番環境）
   - ✅ **Preview**（プレビュー環境）
   - ✅ **Development**（開発環境）
   - すべてにチェックを入れることを推奨

4. **「Save」** または **「Add」** をクリック

### 5. デプロイ

環境変数を追加すると、自動的に再デプロイが開始されます。
- または、手動で「Deployments」タブから再デプロイすることもできます

## 接続文字列の例

MongoDB Atlasから取得した接続文字列の例：

```
mongodb+srv://myuser:mypassword@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
```

これを以下のように変更します（`/vmeda` を追加）：

```
mongodb+srv://myuser:mypassword@cluster0.xxxxx.mongodb.net/vmeda?retryWrites=true&w=majority
                                                                  ^^^^^^
                                                                   データベース名を追加
```

## パスワードに特殊文字が含まれる場合

パスワードに `@`, `#`, `%` などの特殊文字が含まれる場合は、URLエンコードが必要です：

- `@` → `%40`
- `#` → `%23`
- `%` → `%25`
- `&` → `%26`
- `=` → `%3D`

例：
```
元のパスワード: my@pass#123
エンコード後: my%40pass%23123
```

## 確認方法

1. 環境変数が正しく設定されているか確認：
   - Settings → Environment Variables で `MONGODB_URI` が表示されているか確認

2. デプロイログを確認：
   - 「Deployments」タブを開く
   - 最新のデプロイをクリック
   - ログに「✅ MongoDB Atlasに接続しました」というメッセージが表示されれば成功

3. 動作確認：
   - サイトで検索を実行
   - MongoDB Atlasダッシュボードで確認：
     - 「Database」→「Browse Collections」
     - `vmeda` データベース → `recent_searches` コレクション
     - 検索履歴が保存されていることを確認

## トラブルシューティング

### 環境変数が反映されない場合

1. **再デプロイを実行**
   - 「Deployments」タブから最新のデプロイを「Redeploy」する

2. **環境変数の値を確認**
   - 接続文字列に `/vmeda` が含まれているか確認
   - ユーザー名とパスワードが正しいか確認

3. **ログを確認**
   - デプロイログでエラーメッセージを確認
   - 「❌ MongoDB接続エラー」が表示されていないか確認

### 接続エラーが発生する場合

1. **ネットワークアクセスを確認**
   - MongoDB Atlasの「Network Access」で `0.0.0.0/0` が追加されているか確認

2. **接続文字列を確認**
   - ユーザー名とパスワードが正しいか確認
   - クラスター名が正しいか確認

3. **データベース名を確認**
   - 接続文字列に `/vmeda` が含まれているか確認

