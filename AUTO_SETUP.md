# 自動セットアップ手順

## 自動でできること

✅ **Vercel CLIでの設定**: コマンドで自動化可能
✅ **GitHubへのプッシュ**: 自動化済み
✅ **Vercelへのデプロイ**: 自動化済み（GitHub接続後）

## 手動で必要なこと（1回だけ）

⚠️ **VercelとGitHubの接続**: ブラウザでの認証が必要（1回だけ）

## 完全自動セットアップ手順

### ステップ1: Vercel CLIでログイン（自動）

```bash
vercel login
```

ブラウザが開くので、認証を完了してください（1回だけ）

### ステップ2: プロジェクトをリンク（自動）

```bash
vercel link --yes
```

既にプロジェクトが存在する場合は、自動的にリンクされます。

### ステップ3: GitHub接続を確認（手動・1回だけ）

1. **Vercelダッシュボードにアクセス**
   - https://vercel.com にアクセス
   - プロジェクト `vmeda` を開く

2. **Git接続を確認**
   - 「Settings」→「Git」を開く
   - 「Connected Git Repository」で、リポジトリが接続されているか確認

3. **接続が切れている場合**
   - 「Disconnect」をクリック
   - 「Connect Git Repository」をクリック
   - GitHubリポジトリ `Mametango/VMEDA` を選択
   - **「Grant access to private repositories」にチェックを入れる**（重要！）
   - 「Import」をクリック

### ステップ4: 自動デプロイの確認（自動）

これ以降は、GitHubにプッシュするだけで自動的にデプロイされます：

```bash
git add .
git commit -m "変更内容"
git push origin main
```

## トラブルシューティング

### GitHub接続ができない場合

1. **GitHubの権限を確認**
   - https://github.com/settings/applications にアクセス
   - 「Authorized OAuth Apps」→「Vercel」を確認
   - 「Private repositories」へのアクセス権限があるか確認

2. **権限がない場合**
   - Vercelダッシュボードで、プロジェクトを削除して再作成
   - 再接続時に「Grant access to private repositories」にチェックを入れる

### 自動デプロイが動作しない場合

1. **Vercelダッシュボードで確認**
   - プロジェクト `vmeda` →「Deployments」タブ
   - 最新のデプロイが表示されているか確認

2. **手動デプロイでテスト**
   ```bash
   vercel --prod
   ```

## 完了後の確認

✅ GitHubにプッシュすると、自動的にVercelにデプロイされる
✅ Vercelダッシュボードでデプロイの進行状況を確認できる
✅ https://vmeda.vercel.app でアクセス可能

