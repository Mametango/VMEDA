# GitHubリポジトリをプライベートにする手順

## 1. GitHubリポジトリをプライベート化

1. GitHubにログイン: https://github.com/Mametango/VMEDA
2. リポジトリページで **Settings** をクリック
3. 左側のメニューから **General** を選択
4. ページの一番下の **Danger Zone** セクションまでスクロール
5. **Change repository visibility** をクリック
6. **Make private** を選択
7. 確認ダイアログでリポジトリ名（`Mametango/VMEDA`）を入力
8. **I understand, change repository visibility** をクリック

これで、リポジトリはプライベートになり、あなただけがアクセスできるようになります。

## 2. Vercelのデプロイを停止（推奨）

公開サイトも停止する場合は：

1. Vercelにログイン: https://vercel.com
2. プロジェクト（VMEDA）を開く
3. **Settings** → **General** に移動
4. 一番下の **Delete Project** をクリック
5. 確認して削除

または、デプロイだけを停止する場合：

1. **Deployments** タブを開く
2. 最新のデプロイを選択
3. **...** メニューから **Cancel Deployment** を選択

## 3. 確認

- GitHubリポジトリがプライベートになっているか確認
- Vercelのデプロイが停止されているか確認
- 公開URL（vmeda.vercel.appなど）にアクセスできないことを確認

## 注意事項

- プライベートリポジトリに変更しても、既存のクローンやフォークは削除されません
- Vercelのデプロイを停止しても、プロジェクト自体は残ります（再デプロイ可能）
- 完全に削除したい場合は、GitHubとVercelの両方で削除操作が必要です


