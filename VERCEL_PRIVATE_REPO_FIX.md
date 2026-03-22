# VercelとプライベートGitHubリポジトリの接続修正

## 問題

GitHubリポジトリをプライベートにしたことで、Vercelの自動デプロイが動作しなくなった可能性があります。

## 解決方法

### 方法1: Vercelダッシュボードで接続を確認・再設定

1. **Vercelにアクセス**
   - https://vercel.com にアクセス
   - ログイン

2. **プロジェクト設定を確認**
   - プロジェクト `vmeda` を開く
   - 「Settings」→「Git」を開く
   - 「Connected Git Repository」で、リポジトリが正しく接続されているか確認

3. **接続が切れている場合**
   - 「Disconnect」をクリック
   - 「Connect Git Repository」をクリック
   - GitHubリポジトリ `Mametango/VMEDA` を選択
   - 「Import」をクリック

### 方法2: GitHubの権限設定を確認

1. **GitHubにアクセス**
   - https://github.com/settings/applications にアクセス
   - 「Authorized OAuth Apps」を開く

2. **Vercelの権限を確認**
   - 「Vercel」を検索
   - 権限が「Private repositories」を含んでいるか確認
   - 含まれていない場合は、権限を更新する必要があります

3. **権限を更新する方法**
   - Vercelダッシュボードで、プロジェクトを削除して再作成
   - または、GitHubの「Authorized OAuth Apps」でVercelを削除して、Vercelで再度認証

### 方法3: Vercel CLIで手動デプロイ（一時的な解決策）

GitHub接続が解決するまでの間、Vercel CLIで手動デプロイできます：

```bash
vercel --prod
```

## 確認方法

1. **Vercelダッシュボードで確認**
   - プロジェクト `vmeda` を開く
   - 「Deployments」タブで、最新のデプロイが表示されているか確認
   - 「Git」タブで、リポジトリが接続されているか確認

2. **GitHubにプッシュしてテスト**
   ```bash
   git push origin main
   ```
   - Vercelダッシュボードで、新しいデプロイが自動的に開始されるか確認

## 推奨手順

1. **Vercelダッシュボードで接続を確認**
   - プロジェクト `vmeda` →「Settings」→「Git」
   - リポジトリが接続されているか確認

2. **接続が切れている場合**
   - 「Disconnect」→「Connect Git Repository」
   - GitHubリポジトリを再選択

3. **GitHubの権限を確認**
   - GitHub Settings → Applications → Authorized OAuth Apps
   - Vercelが「Private repositories」へのアクセス権限を持っているか確認

4. **テスト**
   - 小さな変更をコミットしてプッシュ
   - Vercelで自動デプロイが開始されるか確認

## 注意事項

- プライベートリポジトリの場合、Vercelは有料プランが必要な場合があります
- ただし、Vercelの無料プランでもプライベートリポジトリは使用可能です
- 権限設定が正しくないと、自動デプロイが動作しません

