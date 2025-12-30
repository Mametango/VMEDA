# VMEDA - 世界最大の動画検索サイト

様々なアルゴリズムで構築される世界最大の動画検索サイト

## 機能

- 複数の動画サイトから検索（中国のAVサイト、Bilibili、Youku、iQiyi、Tencent Video、Xigua Video、Sohu、Google、JPdmv、Douga4、Spankbang、X1hub、Porntube、JavGuru、Japanhub、Tktube、FC2、AkibaAbvなど）
- AIによる関連動画の自動取得
- サイト内での動画再生（埋め込みプレイヤー）
- 本日のトップ検索ワード表示
- サムネイル画像の表示

## セットアップ

```bash
npm install
npm start
```

サーバーは `http://localhost:3000` で起動します。

## ネット公開方法

### 1. Vercelで公開（クレジットカード不要・推奨）

**最も簡単な方法！無料枠あり**

1. **Vercel CLIでデプロイ**（推奨）
   ```bash
   # Vercel CLIをインストール（既にインストール済み）
   npm install -g vercel
   
   # ログイン（ブラウザが開きます）
   vercel login
   
   # デプロイ
   vercel --prod --yes
   ```

2. **GitHub経由でデプロイ**（GitHubアカウントが必要）
   - [Vercel](https://vercel.com)にアクセス
   - 「Add New Project」をクリック
   - GitHubリポジトリを選択
   - 自動的にデプロイされます

3. **手動でZIPアップロード**
   - [Vercel Dashboard](https://vercel.com/dashboard)にアクセス
   - 「Add New Project」→「Deploy」→「Upload」を選択
   - プロジェクトフォルダをZIP化してアップロード

**注意**: Vercelはサーバーレス環境なので、長時間実行される処理には制限があります。

### 2. Renderで公開（GitHub不要・推奨）

**GitHub不要で直接デプロイ可能**

1. [Render](https://render.com)にアカウントを作成
2. 「New Web Service」を選択
3. 「Public Git repository」で以下を選択：
   - **GitLab**: GitLabリポジトリを接続
   - **Bitbucket**: Bitbucketリポジトリを接続
   - **Manual Deploy**: 手動でZIPファイルをアップロード
4. 設定：
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Environment**: `Node`
5. 「Create Web Service」をクリック

### 2. Railwayで公開（GitLab/Bitbucket対応）

1. [Railway](https://railway.app)にアカウントを作成
2. 「New Project」を選択
3. リポジトリソースを選択：
   - **GitLab**: GitLabリポジトリを接続
   - **Bitbucket**: Bitbucketリポジトリを接続
   - **GitHub**: GitHubリポジトリを接続
4. 自動的にデプロイが開始されます

### 3. Fly.ioで公開（GitHub不要・無料枠あり・推奨）

**前提条件:**
- Fly.ioアカウント（[fly.io](https://fly.io)で作成）

**デプロイ手順:**

1. **Fly CLIをインストール**
   ```powershell
   # Windows (PowerShell)
   powershell -Command "iwr https://fly.io/install.ps1 -useb | iex"
   ```
   または
   ```bash
   npm install -g @fly/cli
   ```

2. **Fly.ioにログイン**
   ```bash
   fly auth login
   ```
   ブラウザが開くので、Fly.ioアカウントでログイン

3. **アプリを作成（初回のみ）**
   ```bash
   fly launch
   ```
   - アプリ名を入力（例: `vmeda` または自動生成）
   - リージョンを選択（`nrt` - 東京を推奨）
   - PostgreSQLなどの追加サービスは不要なら「No」を選択
   - 既存の`fly.toml`を使用するか聞かれたら「Yes」

4. **デプロイ**
   ```bash
   fly deploy
   ```
   初回は数分かかります（Dockerイメージのビルドとプッシュ）

5. **アプリを開く**
   ```bash
   fly open
   ```
   または、`https://your-app-name.fly.dev` にアクセス

**便利なコマンド:**
- ログを確認: `fly logs`
- アプリの状態: `fly status`
- アプリを再起動: `fly apps restart`
- 設定を確認: `fly config`

**無料枠:**
- 3つの共有CPU VM
- 3GBのストレージ
- 160GBの転送量/月

### 4. DigitalOcean App Platform（GitLab/Bitbucket対応）

1. [DigitalOcean](https://www.digitalocean.com)にアカウントを作成
2. 「Apps」→「Create App」を選択
3. GitLabまたはBitbucketリポジトリを接続
4. 自動的にデプロイが開始されます

### 5. Heroku（GitHub不要・手動デプロイ可能）

1. [Heroku](https://www.heroku.com)にアカウントを作成
2. Heroku CLIをインストール
3. ログイン: `heroku login`
4. アプリを作成: `heroku create your-app-name`
5. デプロイ: `git push heroku main` または手動でZIPをアップロード

### 6. VPS（サーバー直接デプロイ）

**おすすめVPSサービス:**
- [Vultr](https://www.vultr.com) - 月額$2.50から
- [Linode](https://www.linode.com) - 月額$5から
- [DigitalOcean Droplets](https://www.digitalocean.com/products/droplets) - 月額$4から
- [AWS Lightsail](https://aws.amazon.com/lightsail/) - 月額$3.50から

**デプロイ手順:**
```bash
# サーバーにSSH接続
ssh user@your-server-ip

# Node.jsをインストール
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# プロジェクトをアップロード（FTP/SCP/rsync）
# またはGitでクローン
git clone your-repo-url
cd Browser

# 依存関係をインストール
npm install

# PM2でプロセス管理
npm install -g pm2
pm2 start server.js
pm2 save
pm2 startup
```

### 7. Docker + Docker Hub（コンテナデプロイ）

1. Dockerfileを作成
2. Dockerイメージをビルド
3. Docker Hubにプッシュ
4. 任意のホスティングサービスでDockerコンテナとして実行

### おすすめランキング

1. **Render（手動デプロイ）** - 無料枠あり、GitHub不要
2. **Fly.io** - 無料枠あり、高速
3. **Railway（GitLab/Bitbucket）** - 簡単、無料枠あり
4. **VPS（Vultr/Linode）** - 完全制御、低コスト
5. **DigitalOcean App Platform** - スケーラブル

## 環境変数

### プロキシ設定（オプション）
```bash
PROXY_URL=http://proxy.example.com:8080
# または
PROXY_HOST=proxy.example.com
PROXY_PORT=8080
PROXY_USER=username
PROXY_PASS=password
```

### OpenAI API（オプション - AI関連動画生成用）
```bash
OPENAI_API_KEY=your_openai_api_key
```

## APIエンドポイント

### 動画検索
```
POST /api/search
Body: { "query": "検索ワード" }
```

### 本日のトップ検索ワード
```
GET /api/top-keyword
```

## 参考資料

- [Bilibili公式APIドキュメント](https://openhome.bilibili.com/doc)
- [Bilibili APIコレクション](https://github.com/SocialSisterYi/bilibili-API-collect)
