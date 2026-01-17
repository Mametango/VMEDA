# VMEDAをローカルで実行する方法

## 必要な環境

- Node.js（v14以上推奨）
- npm または yarn

## 実行手順

### 1. 依存関係のインストール

```bash
npm install
```

### 2. 環境変数の設定（オプション）

MongoDBを使用する場合、`.env`ファイルを作成：

```
MONGODB_URI=your_mongodb_connection_string
```

### 3. サーバーの起動

```bash
node server.js
```

または、ポートを指定する場合：

```bash
PORT=3000 node server.js
```

### 4. ブラウザでアクセス

- http://localhost:3000 にアクセス

## 注意事項

- ローカルで実行する場合、Vercelの環境変数は使用できません
- MongoDBを使用しない場合、検索履歴はメモリ内に保存されます（再起動で消えます）
- 外部サイトへのリクエストは正常に動作します


