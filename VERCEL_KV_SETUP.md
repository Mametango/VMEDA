# Vercel KV セットアップガイド

## 概要
検索履歴を永続化するために、Vercel KV（Redis）を使用します。

## セットアップ手順

### 1. VercelダッシュボードでKVデータベースを作成

**方法1: Marketplace経由（推奨・最新）**

1. [Vercel Dashboard](https://vercel.com/dashboard) にログイン
2. プロジェクトを選択
3. 「Marketplace」タブをクリック
4. 「KV」または「Redis」を検索
5. 「Add Integration」をクリック
6. データベース名を入力（例: `vmeda-kv`）
7. リージョンを選択（推奨: `nrt` - 東京）
8. 「Create」をクリック

**方法2: Storageタブ経由（従来の方法）**

1. [Vercel Dashboard](https://vercel.com/dashboard) にログイン
2. プロジェクトを選択
3. 「Storage」タブをクリック
4. 「Create Database」をクリック
5. 「KV」を選択
6. データベース名を入力（例: `vmeda-kv`）
7. リージョンを選択（推奨: `nrt` - 東京）
8. 「Create」をクリック

**方法3: Vercel CLI経由**

```bash
vercel kv create vmeda-kv
```

### 2. 環境変数の設定

**Marketplace経由で作成した場合：**
- 環境変数は自動的に設定されます
- プロジェクトの「Settings」→「Environment Variables」で確認できます

**手動で設定する場合：**

1. プロジェクトの「Settings」→「Environment Variables」を開く
2. 以下の環境変数を追加：

```
KV_REST_API_URL=https://your-kv-database-url.vercel-storage.com
KV_REST_API_TOKEN=your-kv-token
KV_REST_API_READ_ONLY_TOKEN=your-read-only-token (オプション)
```

これらの値は、KVデータベース作成時に自動的に生成されます。

### 3. 環境変数の確認

KVデータベースのページ（MarketplaceまたはStorageタブ）で、以下の情報が表示されます：
- **REST API URL**: `KV_REST_API_URL` に設定
- **REST API Token**: `KV_REST_API_TOKEN` に設定

Marketplace経由で作成した場合、これらの環境変数は自動的に設定されているはずです。

### 4. デプロイ

環境変数を設定したら、自動的に再デプロイされます。または、手動で再デプロイすることもできます。

## 動作確認

1. サイトで検索を実行
2. ブラウザをリロード
3. 検索履歴が保持されていることを確認

## フォールバック

Vercel KVが設定されていない場合、自動的にファイルシステム（`data/recent-searches.json`）に保存されます。

## 無料プランの制限

- 1つのデータベース
- 月間30,000リクエスト
- 256MBの総ストレージ
- 256MBのデータ転送

検索履歴の保存には十分な制限です。

