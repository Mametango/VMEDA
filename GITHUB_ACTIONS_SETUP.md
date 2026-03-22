# GitHub ActionsとVercel自動デプロイ設定

## 現在の状況

✅ **Vercel自動デプロイ**: 既に設定済み
- GitHubリポジトリとVercelが接続されているため、GitHubにプッシュするだけで自動的にデプロイされます
- 追加の設定は不要です

✅ **GitHub Actions**: 設定済み
- `.github/workflows/deploy.yml` を作成しました
- ただし、Vercelのトークンが必要です（オプション）

## 自動デプロイの仕組み

### 方法1: Vercel自動デプロイ（推奨・既に動作中）

GitHubにプッシュするだけで自動的にデプロイされます：

```bash
git add .
git commit -m "変更内容"
git push origin main
```

これだけで、Vercelが自動的にデプロイを開始します！

### 方法2: GitHub Actions（オプション）

GitHub Actionsを使う場合は、Vercelのトークンが必要です：

1. **Vercelトークンを取得**
   - https://vercel.com/account/tokens にアクセス
   - 新しいトークンを作成

2. **GitHub Secretsに追加**
   - GitHubリポジトリの「Settings」→「Secrets and variables」→「Actions」
   - 以下のSecretsを追加：
     - `VERCEL_TOKEN`: Vercelのトークン
     - `VERCEL_ORG_ID`: Vercelの組織ID（`.vercel/project.json`の`orgId`）
     - `VERCEL_PROJECT_ID`: VercelのプロジェクトID（`.vercel/project.json`の`projectId`）

3. **自動デプロイ**
   - GitHubにプッシュすると、GitHub Actionsが自動的に実行されます
   - Vercelへのデプロイが自動的に行われます

## 推奨方法

**方法1（Vercel自動デプロイ）を推奨します**：
- ✅ 設定が簡単（既に完了）
- ✅ 追加のトークン不要
- ✅ 自動的にデプロイされる

GitHub Actionsは、より高度な制御が必要な場合のみ使用してください。

## 確認方法

1. **GitHubにプッシュ**
   ```bash
   git push origin main
   ```

2. **Vercelダッシュボードで確認**
   - https://vercel.com にアクセス
   - プロジェクト `vmeda` を開く
   - 「Deployments」タブでデプロイの進行状況を確認

3. **デプロイ完了**
   - 通常、1-2分で完了します
   - https://vmeda.vercel.app でアクセス可能になります

