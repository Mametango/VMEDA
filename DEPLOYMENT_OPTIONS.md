# Vercel削除後のデプロイ方法

Vercelを削除した場合、外出先からアクセスする方法は以下の通りです。

## 方法1: ngrok（最も簡単・推奨）

自宅のPCでサーバーを起動し、ngrokで外部からアクセス可能にします。

### 手順：

1. **ngrokをインストール**
   - https://ngrok.com/download からダウンロード
   - Windows版をダウンロードして解凍

2. **ngrokアカウントを作成（無料）**
   - https://ngrok.com でアカウント作成
   - 認証トークンを取得

3. **ngrokを認証**
   ```bash
   ngrok config add-authtoken YOUR_AUTH_TOKEN
   ```

4. **ローカルでサーバーを起動**
   ```bash
   node server.js
   ```

5. **ngrokでトンネルを作成**
   ```bash
   ngrok http 3000
   ```

6. **ngrokのURLをメモ**
   - 例：`https://xxxx-xxxx-xxxx.ngrok-free.app`
   - このURLを外出先からアクセス

### メリット：
- ✅ 完全にプライベート（URLを知っている人だけがアクセス可能）
- ✅ 自宅のPCで完全にコントロール可能
- ✅ 無料プランあり
- ✅ セットアップが簡単

### デメリット：
- ⚠️ 自宅のPCが起動している必要がある
- ⚠️ インターネット接続が必要
- ⚠️ 無料プランはURLが変わる可能性がある（再起動時）

---

## 方法2: Cloudflare Tunnel（よりセキュア）

Cloudflareの無料サービスで、ローカルサーバーを外部公開できます。

### 手順：

1. **Cloudflareアカウントを作成**
   - https://one.dash.cloudflare.com にアクセス

2. **Cloudflare Tunnelをセットアップ**
   - Cloudflareダッシュボードで「Zero Trust」を開く
   - 「Networks」→「Tunnels」でトンネルを作成
   - ローカルサーバー（localhost:3000）を公開

3. **アクセス**
   - Cloudflareが提供するURLでアクセス
   - 例：`https://vmeda.your-domain.com` または `https://xxxx.trycloudflare.com`

### メリット：
- ✅ 完全にプライベート
- ✅ 無料で利用可能
- ✅ セキュア（Cloudflareの保護）
- ✅ URLが固定される可能性がある

### デメリット：
- ⚠️ セットアップがやや複雑
- ⚠️ 自宅のPCが起動している必要がある

---

## 方法3: Render（無料ホスティング）

Renderは無料でNode.jsアプリをホスティングできます。

### 手順：

1. **Renderアカウントを作成**
   - https://render.com にアクセス
   - GitHubアカウントでログイン

2. **新しいWebサービスを作成**
   - 「New」→「Web Service」を選択
   - GitHubリポジトリ `Mametango/VMEDA` を接続

3. **設定**
   - Build Command: （空欄のまま）
   - Start Command: `node server.js`
   - Environment: Node

4. **デプロイ**
   - 「Create Web Service」をクリック
   - デプロイが完了したら、提供されるURLでアクセス

### メリット：
- ✅ 無料プランあり
- ✅ 自宅のPCが起動している必要がない
- ✅ 自動デプロイ（GitHubにプッシュするだけで）

### デメリット：
- ⚠️ 無料プランはスリープする可能性がある（アクセス時に起動）
- ⚠️ 公開状態（URLを知っている人は誰でもアクセス可能）

---

## 方法4: Fly.io（無料ホスティング）

Fly.ioも無料でNode.jsアプリをホスティングできます。

### 手順：

1. **Fly.ioアカウントを作成**
   - https://fly.io にアクセス
   - アカウント作成

2. **Fly CLIをインストール**
   ```bash
   # Windowsの場合
   # https://fly.io/docs/hands-on/install-flyctl/
   ```

3. **デプロイ**
   ```bash
   fly launch
   fly deploy
   ```

### メリット：
- ✅ 無料プランあり
- ✅ 自宅のPCが起動している必要がない
- ✅ グローバルにデプロイ可能

### デメリット：
- ⚠️ セットアップがやや複雑
- ⚠️ 公開状態（URLを知っている人は誰でもアクセス可能）

---

## 推奨方法

**プライベートを重視し、自宅のPCを使える場合：**
- **方法1（ngrok）** - 最も簡単でセットアップが早い

**よりセキュアにしたい場合：**
- **方法2（Cloudflare Tunnel）** - セキュリティが高い

**自宅のPCを使いたくない場合：**
- **方法3（Render）** または **方法4（Fly.io）** - ただし、公開状態になる

---

## セキュリティの注意事項

- URLを他人に共有しない
- ブックマークやメモアプリに保存する際は、パスワード保護を推奨
- 定期的にURLを変更することを推奨（ngrokの場合）


