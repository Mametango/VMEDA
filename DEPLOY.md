# Vercel自動デプロイ設定ガイド

## 方法1: GitHubリポジトリをVercelに接続（最も簡単・推奨）

この方法なら、GitHubにプッシュするだけで自動的にデプロイされます！

### 手順

1. **Vercelにアクセス**
   - https://vercel.com にアクセス
   - GitHubアカウントでログイン（初回のみ）

2. **プロジェクトをインポート**
   - 「Add New Project」をクリック
   - GitHubリポジトリ `Mametango/VMEDA` を選択
   - 「Import」をクリック

3. **設定（自動検出されるはず）**
   - Framework Preset: Other
   - Root Directory: `./`
   - Build Command: （空欄のまま）
   - Output Directory: （空欄のまま）

4. **デプロイ**
   - 「Deploy」をクリック
   - 完了！

これで、今後はGitHubにプッシュするだけで自動的にデプロイされます！

## 方法2: GitHub Actionsを使う（高度）

GitHub Actionsで自動デプロイするには、Vercelのトークンが必要です。

### 必要なシークレット

GitHubリポジトリの「Settings」→「Secrets and variables」→「Actions」で以下を設定：

1. `VERCEL_TOKEN`: Vercelのアクセストークン
   - https://vercel.com/account/tokens で作成

2. `VERCEL_ORG_ID`: Vercelの組織ID
   - Vercelダッシュボードの「Settings」→「General」で確認

3. `VERCEL_PROJECT_ID`: VercelのプロジェクトID
   - プロジェクトの「Settings」→「General」で確認

### 設定後

GitHubにプッシュするだけで、GitHub Actionsが自動的にVercelにデプロイします！

## 現在の状態

✅ GitHubリポジトリ: https://github.com/Mametango/VMEDA
✅ Vercel設定ファイル: `vercel.json` 作成済み
✅ GitHub Actionsワークフロー: `.github/workflows/vercel.yml` 作成済み

次のステップ: VercelダッシュボードでGitHubリポジトリを接続するだけ！

