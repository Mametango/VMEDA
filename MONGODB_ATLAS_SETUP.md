# MongoDB Atlas セットアップガイド

## 概要
検索履歴を永続化するために、MongoDB Atlas（無料クラウドデータベース）を使用します。

## MongoDB Atlasの無料プラン

- **ストレージ**: 512MB（検索履歴の保存には十分）
- **RAM**: 512MB
- **データ転送**: 無制限
- **コレクション数**: 無制限

## セットアップ手順

### 1. MongoDB Atlasアカウントを作成

1. [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) にアクセス
2. 「Try Free」をクリック
3. アカウントを作成（Googleアカウントでも可）

### 2. クラスターを作成

1. 「Build a Database」をクリック
2. **Free (M0)** プランを選択
3. クラウドプロバイダーを選択（AWS推奨）
4. リージョンを選択：
   - **推奨**: `ap-northeast-1` - 東京（日本からのアクセスが速い）
   - **その他**: `us-east-1` - Washington, D.C., USA (East) など、どのリージョンでも問題ありません
   - 検索履歴の保存用途であれば、リージョンによる差はほとんどありません
5. クラスター名を入力（例: `vmeda-cluster`）
6. 「Create」をクリック

### 3. データベースユーザーを作成

1. 「Database Access」をクリック
2. 「Add New Database User」をクリック
3. 認証方法を選択：
   - **Password**: パスワードを設定
   - または **Certificate**: 証明書を使用
4. ユーザー名とパスワードを設定（メモしておく）
5. 「Add User」をクリック

### 4. ネットワークアクセスを設定

1. 「Network Access」をクリック
2. 「Add IP Address」をクリック
3. **「Allow Access from Anywhere」**を選択（`0.0.0.0/0`）
   - または、VercelのIPアドレスを追加
4. 「Confirm」をクリック

### 5. 接続文字列を取得

1. 「Database」をクリック
2. 「Connect」をクリック
3. 「Connect your application」を選択
4. **Driver**: `Node.js`
5. **Version**: 最新バージョン
6. 接続文字列をコピー（例: `mongodb+srv://username:password@cluster.mongodb.net/?retryWrites=true&w=majority`）

### 6. 環境変数を設定

Vercelダッシュボードで環境変数を設定：

1. プロジェクトの「Settings」→「Environment Variables」を開く
2. 以下の環境変数を追加：

```
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/vmeda?retryWrites=true&w=majority
```

**重要**: 
- `username` と `password` を実際の値に置き換える
- パスワードに特殊文字が含まれる場合は、URLエンコードが必要（例: `@` → `%40`）
- **データベース名（`vmeda`）**: 接続文字列の `/vmeda` の部分です。この名前は**適当でも問題ありません**（例: `mydb`, `vmeda`, `search_history` など）。MongoDB Atlasは自動的にデータベースを作成します。

### 7. デプロイ

環境変数を設定したら、自動的に再デプロイされます。または、手動で再デプロイすることもできます。

## 動作確認

1. サイトで検索を実行
2. MongoDB Atlasダッシュボードで確認：
   - 「Database」→「Browse Collections」
   - `vmeda` データベース → `recent_searches` コレクション
   - 検索履歴が保存されていることを確認
3. ブラウザをリロード
4. 検索履歴が保持されていることを確認

## トラブルシューティング

### 接続エラーが発生する場合

1. **ネットワークアクセスを確認**
   - 「Network Access」で `0.0.0.0/0` が追加されているか確認

2. **接続文字列を確認**
   - ユーザー名とパスワードが正しいか確認
   - パスワードに特殊文字が含まれる場合は、URLエンコードが必要

3. **データベース名を確認**
   - 接続文字列にデータベース名（`vmeda`）が含まれているか確認

4. **ログを確認**
   - Vercelのログでエラーメッセージを確認
   - 「✅ MongoDB Atlasに接続しました」というメッセージが表示されるか確認

## 無料プランの制限

- **ストレージ**: 512MB（検索履歴の保存には十分）
- **RAM**: 512MB
- **データ転送**: 無制限
- **コレクション数**: 無制限

検索履歴の保存には十分な制限です。

## セキュリティ

- データベースユーザーのパスワードは強力なものを使用
- ネットワークアクセスは必要最小限に設定（本番環境では特定のIPのみ許可）
- 環境変数はVercelの環境変数として管理（GitHubにコミットしない）

