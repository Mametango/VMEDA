# 🚀 Vercelデプロイ手順（https://vmeda.vercel.app）

## ✅ 準備完了

- ✅ GitHubリポジトリ: https://github.com/Mametango/VMEDA
- ✅ Vercel設定ファイル: `vercel.json` 作成済み
- ✅ サーバーコード: Vercel対応済み

## 🎯 デプロイ方法（2つの選択肢）

### 方法1: GitHubリポジトリをVercelに接続（推奨・自動デプロイ）

**この方法なら、GitHubにプッシュするだけで自動的にデプロイされます！**

1. **Vercelにアクセス**
   - https://vercel.com にアクセス
   - GitHubアカウントでログイン（初回のみ）

2. **プロジェクトをインポート**
   - 「Add New Project」をクリック
   - GitHubリポジトリ `Mametango/VMEDA` を選択
   - 「Import」をクリック

3. **プロジェクト名を設定**
   - Project Name: `vmeda`（これで https://vmeda.vercel.app になります）
   - Framework Preset: **Other**
   - Root Directory: `./`（空欄のまま）
   - Build Command: （空欄のまま）
   - Output Directory: （空欄のまま）

4. **デプロイ**
   - 「Deploy」をクリック
   - 完了！

**これで、今後はGitHubにプッシュするだけで自動的にデプロイされます！**

### 方法2: Vercel CLIで直接デプロイ

1. **Vercel CLIでログイン**
   ```bash
   vercel login
   ```
   - ブラウザが開くので、認証を完了

2. **プロジェクトを作成・デプロイ**
   ```bash
   vercel --prod --yes
   ```
   - プロジェクト名を聞かれたら `vmeda` と入力

3. **完了！**
   - https://vmeda.vercel.app でアクセスできます

## 📝 注意事項

- Vercel CLIのログインはブラウザ認証が必要なため、完全自動化は難しいです
- しかし、GitHubリポジトリを接続すれば、CLIを使わずに自動デプロイできます
- この方法なら、今後は一切手動操作不要です！

## 🎉 デプロイ後の確認

デプロイが完了したら、以下でアクセスできます：
- **本番環境**: https://vmeda.vercel.app
- **プレビュー環境**: 各プッシュごとに自動生成されるURL


