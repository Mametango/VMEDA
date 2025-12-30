# 🌐 カスタムドメイン設定ガイド

Vercelでカスタムドメインを設定して、`vercel.app`の部分を隠すことができます！

## 📋 手順

### 1. ドメインを取得（まだ持っていない場合）

無料でドメインを取得できるサービス：
- **Freenom** (https://www.freenom.com) - `.tk`, `.ml`, `.ga`, `.cf`, `.gq` が無料
- **Namecheap** (https://www.namecheap.com) - 有料だが安い（年間$10程度）
- **Google Domains** (https://domains.google) - 有料

### 2. Vercelでカスタムドメインを設定

1. **Vercelダッシュボードにアクセス**
   - https://vercel.com/dashboard にアクセス
   - プロジェクト `vmeda` を選択

2. **Settings → Domains を開く**
   - 左メニューから「Settings」をクリック
   - 「Domains」タブをクリック

3. **ドメインを追加**
   - 「Add Domain」ボタンをクリック
   - 取得したドメインを入力（例: `vmeda.com`）
   - 「Add」をクリック

4. **DNS設定**
   - Vercelが表示するDNSレコードをコピー
   - ドメイン管理画面（Freenom、Namecheapなど）にアクセス
   - DNS設定で以下のレコードを追加：
     ```
     タイプ: A
     名前: @
     値: 76.76.21.21
     
     タイプ: CNAME
     名前: www
     値: cname.vercel-dns.com
     ```
   - または、Vercelが表示する具体的なDNSレコードに従う

5. **DNS反映を待つ**
   - DNSの反映には数分〜24時間かかる場合があります
   - 「Verify」ボタンで確認

6. **完了！**
   - DNSが反映されると、カスタムドメインでアクセスできます
   - 例: `https://vmeda.com` または `https://www.vmeda.com`

## 🔄 自動リダイレクト設定

Vercelでは、以下のリダイレクトが自動的に設定されます：
- `vmeda.vercel.app` → カスタムドメイン（設定後）
- `www` と `non-www` の相互リダイレクト

## 📝 注意事項

- 無料プランでもカスタムドメインは使用可能
- SSL証明書は自動的に発行されます（Let's Encrypt）
- DNSの反映には時間がかかる場合があります

## 🎯 推奨ドメイン名の例

- `vmeda.com`
- `vmeda.net`
- `vmeda.org`
- `vmeda.tk` (Freenomで無料)

