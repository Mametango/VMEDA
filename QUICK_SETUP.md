# 🚀 クイックセットアップ（自動化）

## 完全自動セットアップ（1回だけ手動操作が必要）

### 方法1: PowerShellスクリプトを実行（推奨）

```powershell
.\setup-vercel.ps1
```

このスクリプトが以下を自動で実行します：
- ✅ Vercel CLIの確認
- ✅ ログイン状態の確認（必要に応じてログイン）
- ✅ プロジェクトのリンク
- ✅ デプロイ（オプション）

### 方法2: 手動でコマンドを実行

```bash
# 1. ログイン（ブラウザが開きます）
vercel login

# 2. プロジェクトをリンク
vercel link --yes

# 3. デプロイ
vercel --prod --yes
```

## ⚠️ 手動で必要な操作（1回だけ）

**GitHub接続の設定**（Vercelダッシュボードで）：

1. https://vercel.com にアクセス
2. プロジェクト `vmeda` を開く
3. 「Settings」→「Git」を開く
4. 「Connect Git Repository」をクリック
5. GitHubリポジトリ `Mametango/VMEDA` を選択
6. **「Grant access to private repositories」にチェックを入れる**（重要！）
7. 「Import」をクリック

## ✅ 完了後

これ以降は、GitHubにプッシュするだけで自動的にデプロイされます：

```bash
git add .
git commit -m "変更内容"
git push origin main
```

## 📝 確認方法

1. **Vercelダッシュボード**
   - https://vercel.com → プロジェクト `vmeda`
   - 「Deployments」タブでデプロイの進行状況を確認

2. **サイトにアクセス**
   - https://vmeda.vercel.app でアクセス可能

