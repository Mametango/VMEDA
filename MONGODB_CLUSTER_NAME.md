# MongoDB Atlas クラスター名の見つけ方

## クラスター名について

`ac-1awighg-shard-00-02.n6dvuzf.mongodb.net:27017` のような形式を見た場合：

- **`n6dvuzf.mongodb.net`**: これがクラスターのベースドメイン（クラスター名の一部）
- **`ac-1awighg-shard-00-02`**: これはシャード（データの分割単位）の名前
- **`:27017`**: これはポート番号（通常は接続文字列に含めません）

## 正しい接続文字列の取得方法

### 方法1: 「Connect your application」から取得（推奨）

1. MongoDB Atlasダッシュボードにログイン
2. 「Database」をクリック
3. クラスターをクリック
4. **「Connect」** ボタンをクリック
5. **「Connect your application」** を選択
6. **Driver**: `Node.js` を選択
7. **Version**: 最新バージョンを選択
8. 表示される接続文字列をコピー

**表示される接続文字列の例:**
```
mongodb+srv://<username>:<password>@cluster0.n6dvuzf.mongodb.net/?retryWrites=true&w=majority
```

この接続文字列の `cluster0.n6dvuzf.mongodb.net` の部分がクラスター名です。

### 方法2: クラスター名を手動で確認

もし `ac-1awighg-shard-00-02.n6dvuzf.mongodb.net:27017` のような形式を見た場合：

1. **クラスターのベースドメインを確認**: `n6dvuzf.mongodb.net`
2. **接続文字列では以下のいずれかの形式を使用**:
   - `cluster0.n6dvuzf.mongodb.net`（推奨）
   - `ac-1awighg-shard-00-00.n6dvuzf.mongodb.net`（最初のシャードを使用）

## 完全な接続文字列の例

あなたの場合、クラスター名が `n6dvuzf.mongodb.net` の場合：

**接続文字列:**
```
mongodb+srv://username:password@cluster0.n6dvuzf.mongodb.net/vmeda?retryWrites=true&w=majority
```

または、シャード形式を使用する場合：
```
mongodb+srv://username:password@ac-1awighg-shard-00-00.n6dvuzf.mongodb.net/vmeda?retryWrites=true&w=majority
```

**推奨**: `cluster0.n6dvuzf.mongodb.net` の形式を使用してください（MongoDB Atlasが自動的に適切なシャードに接続します）。

## 確認方法

1. **「Connect your application」から取得した接続文字列を使用**
   - これが最も確実な方法です
   - MongoDB Atlasが自動的に正しい形式を生成します

2. **接続文字列の形式を確認**
   - `mongodb+srv://` で始まっているか
   - `@` の後にクラスター名が続いているか
   - `/vmeda?` が含まれているか（データベース名）

## トラブルシューティング

### 接続エラーが発生する場合

1. **「Connect your application」から取得した接続文字列を使用**
   - 手動で作成するよりも、MongoDB Atlasから取得した接続文字列を使用することを推奨

2. **クラスター名を確認**
   - 「Database」ページでクラスター名を確認
   - 「Connect」→「Connect your application」から取得した接続文字列を使用

3. **ネットワークアクセスを確認**
   - 「Network Access」で `0.0.0.0/0` が追加されているか確認

