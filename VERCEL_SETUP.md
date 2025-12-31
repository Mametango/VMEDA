# 🚀 Vercel自動デプロイ設定（GitHub Actions不要）

## ✅ 最も簡単な方法：GitHubリポジトリをVercelに接続

GitHub Actionsを使わずに、GitHubリポジトリをVercelに直接接続すれば、**GitHubにプッシュするだけで自動的にデプロイされます！**

### 手順（5分で完了）

1. **Vercelにアクセス**
   - https://vercel.com にアクセス
   - GitHubアカウントでログイン（初回のみ）

2. **プロジェクトをインポート**
   - 「Add New Project」をクリック
   - GitHubリポジトリ `Mametango/VMEDA` を選択
   - 「Import」をクリック

3. **設定（自動検出されるはず）**
   - Project Name: `vmeda`（これで https://vmeda.vercel.app になります）
   - Framework Preset: **Other**
   - Root Directory: `./`（空欄のまま）
   - Build Command: （空欄のまま）
   - Output Directory: （空欄のまま）

4. **デプロイ**
   - 「Deploy」をクリック
   - 完了！

## 🎉 これで完了！

今後は、GitHubにプッシュするだけで自動的にVercelにデプロイされます：

```bash
git push origin main
```

これだけで、Vercelが自動的にデプロイを開始します！

## 📝 注意事項

- GitHub Actionsのワークフローは無効化されています（不要なため）
- VercelにGitHubリポジトリを接続すれば、GitHub Actionsは不要です
- 無料プランでも自動デプロイが利用可能です

## 🔧 トラブルシューティング

### デプロイが失敗する場合

1. **Vercelダッシュボードでログを確認**
   - プロジェクト → 「Deployments」タブ
   - 失敗したデプロイをクリック
   - ログを確認

2. **設定を確認**
   - プロジェクト → 「Settings」タブ
   - 「General」で設定を確認

3. **再デプロイ**
   - 「Deployments」タブ → 「Redeploy」をクリック

