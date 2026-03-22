# Vercel再構築手順

## 前提条件

- ✅ GitHubリポジトリ: https://github.com/Mametango/VMEDA
- ✅ Vercel設定ファイル: `vercel.json` 作成済み
- ✅ サーバーコード: Vercel対応済み

## 再構築手順

### 1. Vercelにログイン

1. https://vercel.com にアクセス
2. GitHubアカウントでログイン

### 2. プロジェクトをインポート

1. **「Add New Project」をクリック**
   - または、既存のプロジェクトがある場合は「Import Project」を選択

2. **GitHubリポジトリを選択**
   - `Mametango/VMEDA` を選択
   - 「Import」をクリック

3. **プロジェクト設定**
   - **Project Name**: `vmeda`（これで https://vmeda.vercel.app になります）
   - **Framework Preset**: **Other**
   - **Root Directory**: `./`（空欄のまま）
   - **Build Command**: （空欄のまま）
   - **Output Directory**: （空欄のまま）

### 3. 環境変数の設定

**Settings** → **Environment Variables** で以下を設定：

#### 必須の環境変数：

- `MONGODB_URI`（オプション）
  - MongoDB Atlasの接続文字列
  - 設定しない場合、検索履歴はメモリ内に保存されます

#### オプションの環境変数：

- `AD_CLIENT_ID`（広告用、オプション）
- `AD_SLOT_HEADER`（広告用、オプション）
- `AD_SLOT_FOOTER`（広告用、オプション）
- `AD_SLOT_IN_CONTENT`（広告用、オプション）

### 4. デプロイ

1. **「Deploy」をクリック**
2. デプロイが完了するまで待つ（通常1-2分）
3. 完了後、**https://vmeda.vercel.app** でアクセス可能

### 5. 自動デプロイの設定

GitHubリポジトリを接続すると、以下の操作で自動的にデプロイされます：

```bash
git push origin main
```

これで、GitHubにプッシュするだけで自動的にVercelにデプロイされます！

## デプロイ後の確認

- ✅ https://vmeda.vercel.app でアクセスできることを確認
- ✅ 検索機能が正常に動作することを確認
- ✅ 外出先からもアクセスできることを確認

## トラブルシューティング

### デプロイが失敗する場合

1. **ログを確認**
   - Vercelダッシュボードの「Deployments」タブでログを確認

2. **環境変数を確認**
   - 必要な環境変数が設定されているか確認

3. **ビルドエラーを確認**
   - ログにエラーメッセージが表示されているか確認

### アクセスできない場合

1. **デプロイの状態を確認**
   - Vercelダッシュボードでデプロイが成功しているか確認

2. **URLを確認**
   - 正しいURL（https://vmeda.vercel.app）を使用しているか確認

3. **ブラウザのキャッシュをクリア**
   - ブラウザのキャッシュをクリアして再試行

## 注意事項

- デプロイには数分かかる場合があります
- 初回デプロイは特に時間がかかる可能性があります
- 環境変数はデプロイ後に変更しても、再デプロイが必要な場合があります


