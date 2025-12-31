# MongoDB Atlas 接続文字列の取得方法

## 接続文字列の形式

```
mongodb+srv://username:password@cluster.mongodb.net/vmeda?retryWrites=true&w=majority
```

## 各部分の説明

### 1. `username`（ユーザー名）

**MongoDB Atlasで作成したデータベースユーザー名**

取得方法：
1. MongoDB Atlasダッシュボードにログイン
2. 左側のメニューから **「Database Access」** をクリック
3. 作成したユーザー名を確認
   - 例: `myuser`, `admin`, `vmeda_user` など

### 2. `password`（パスワード）

**MongoDB Atlasで作成したデータベースユーザーのパスワード**

取得方法：
1. 「Database Access」ページでユーザーを確認
2. パスワードは**作成時に設定したもの**を使用
3. パスワードを忘れた場合は：
   - ユーザー名の右側の「...」をクリック
   - 「Edit」を選択
   - 新しいパスワードを設定

**注意**: パスワードに特殊文字（`@`, `#`, `%` など）が含まれる場合は、URLエンコードが必要です。

### 3. `cluster`（クラスター名）

**MongoDB Atlasで作成したクラスターのURL**

取得方法：
1. MongoDB Atlasダッシュボードにログイン
2. 左側のメニューから **「Database」** をクリック
3. 作成したクラスターをクリック
4. **「Connect」** ボタンをクリック
5. **「Connect your application」** を選択
6. 表示される接続文字列からクラスター名をコピー
   - 例: `cluster0.xxxxx.mongodb.net`
   - または: `cluster0.abcd1.mongodb.net`
   - または: `ac-xxxxx-shard-00-00.xxxxx.mongodb.net`（シャード形式の場合）

**注意**: 
- `ac-1awighg-shard-00-02.n6dvuzf.mongodb.net:27017` のような形式を見た場合
- クラスター名は `n6dvuzf.mongodb.net` の部分です
- 接続文字列では `cluster0.n6dvuzf.mongodb.net` または `ac-1awighg-shard-00-00.n6dvuzf.mongodb.net` のような形式を使用します
- **「Connect your application」から取得した接続文字列を使用することを推奨**します（自動的に正しい形式が生成されます）

## 完全な手順

### ステップ1: 接続文字列を取得

1. MongoDB Atlasダッシュボードにログイン
2. 「Database」をクリック
3. 作成したクラスターをクリック
4. **「Connect」** ボタンをクリック
5. **「Connect your application」** を選択
6. **Driver**: `Node.js` を選択
7. **Version**: 最新バージョンを選択
8. 表示される接続文字列をコピー

例：
```
mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
```

### ステップ2: 接続文字列を編集

コピーした接続文字列を以下のように編集：

1. `<username>` を実際のユーザー名に置き換える
2. `<password>` を実際のパスワードに置き換える
3. `/?` の部分を `/vmeda?` に変更（データベース名を追加）

**編集前:**
```
mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
```

**編集後:**
```
mongodb+srv://myuser:mypassword@cluster0.xxxxx.mongodb.net/vmeda?retryWrites=true&w=majority
```

### ステップ3: 実際の例

**ユーザー名**: `vmeda_user`
**パスワード**: `MyPassword123`
**クラスター**: `cluster0.abcd1.mongodb.net`

**接続文字列:**
```
mongodb+srv://vmeda_user:MyPassword123@cluster0.abcd1.mongodb.net/vmeda?retryWrites=true&w=majority
```

## パスワードに特殊文字が含まれる場合

パスワードに `@`, `#`, `%` などの特殊文字が含まれる場合は、URLエンコードが必要です。

### URLエンコード一覧

- `@` → `%40`
- `#` → `%23`
- `%` → `%25`
- `&` → `%26`
- `=` → `%3D`
- `+` → `%2B`
- ` ` (スペース) → `%20`

### 例

**元のパスワード**: `My@Pass#123`
**エンコード後**: `My%40Pass%23123`

**接続文字列:**
```
mongodb+srv://vmeda_user:My%40Pass%23123@cluster0.abcd1.mongodb.net/vmeda?retryWrites=true&w=majority
```

## 確認方法

1. **接続文字列の形式を確認**
   - `mongodb+srv://` で始まっているか
   - `username:password@` の形式になっているか
   - `/vmeda?` が含まれているか（データベース名）

2. **MongoDB Atlasで確認**
   - 「Database Access」でユーザー名とパスワードを確認
   - 「Database」でクラスター名を確認

3. **Vercelで環境変数を設定**
   - Settings → Environment Variables
   - `MONGODB_URI` に接続文字列を設定

4. **動作確認**
   - デプロイ後、ログで「✅ MongoDB Atlasに接続しました」が表示されるか確認

## トラブルシューティング

### 接続エラーが発生する場合

1. **ユーザー名とパスワードを確認**
   - 「Database Access」で正しいユーザー名とパスワードか確認

2. **クラスター名を確認**
   - 「Database」でクラスター名が正しいか確認
   - 接続文字列のクラスター名と一致しているか確認

3. **ネットワークアクセスを確認**
   - 「Network Access」で `0.0.0.0/0` が追加されているか確認

4. **データベース名を確認**
   - 接続文字列に `/vmeda` が含まれているか確認

