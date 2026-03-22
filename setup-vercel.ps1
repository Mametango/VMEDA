# Vercel自動セットアップスクリプト

Write-Host "🚀 Vercel自動セットアップを開始します..." -ForegroundColor Green

# ステップ1: Vercel CLIがインストールされているか確認
Write-Host "`n📦 ステップ1: Vercel CLIの確認..." -ForegroundColor Yellow
$vercelVersion = vercel --version 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Vercel CLIがインストールされていません" -ForegroundColor Red
    Write-Host "インストール: npm install -g vercel" -ForegroundColor Yellow
    exit 1
}
Write-Host "✅ Vercel CLI: $vercelVersion" -ForegroundColor Green

# ステップ2: ログイン状態を確認
Write-Host "`n🔐 ステップ2: ログイン状態の確認..." -ForegroundColor Yellow
$whoami = vercel whoami 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "⚠️ ログインが必要です" -ForegroundColor Yellow
    Write-Host "ブラウザが開きます。認証を完了してください..." -ForegroundColor Yellow
    vercel login
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ ログインに失敗しました" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "✅ ログイン済み: $whoami" -ForegroundColor Green
}

# ステップ3: プロジェクトをリンク
Write-Host "`n🔗 ステップ3: プロジェクトのリンク..." -ForegroundColor Yellow
if (Test-Path ".vercel\project.json") {
    Write-Host "✅ プロジェクトは既にリンクされています" -ForegroundColor Green
    $projectJson = Get-Content ".vercel\project.json" | ConvertFrom-Json
    Write-Host "   プロジェクトID: $($projectJson.projectId)" -ForegroundColor Cyan
    Write-Host "   プロジェクト名: $($projectJson.projectName)" -ForegroundColor Cyan
} else {
    Write-Host "プロジェクトをリンクします..." -ForegroundColor Yellow
    vercel link --yes
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ プロジェクトのリンクに失敗しました" -ForegroundColor Red
        exit 1
    }
    Write-Host "✅ プロジェクトをリンクしました" -ForegroundColor Green
}

# ステップ4: デプロイ
Write-Host "`n🚀 ステップ4: デプロイ..." -ForegroundColor Yellow
Write-Host "本番環境にデプロイしますか？ (Y/N)" -ForegroundColor Yellow
$deploy = Read-Host
if ($deploy -eq "Y" -or $deploy -eq "y") {
    vercel --prod --yes
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✅ デプロイが完了しました！" -ForegroundColor Green
    } else {
        Write-Host "❌ デプロイに失敗しました" -ForegroundColor Red
    }
} else {
    Write-Host "⏭️ デプロイをスキップしました" -ForegroundColor Yellow
}

Write-Host "`n✨ セットアップが完了しました！" -ForegroundColor Green
Write-Host "`n📝 次のステップ:" -ForegroundColor Cyan
Write-Host "1. VercelダッシュボードでGit接続を確認: https://vercel.com" -ForegroundColor White
Write-Host "2. Settings → Git → Connected Git Repository を確認" -ForegroundColor White
Write-Host "3. 接続が切れている場合は、再接続してください" -ForegroundColor White
Write-Host "4. プライベートリポジトリの場合、「Grant access to private repositories」にチェックを入れてください" -ForegroundColor White

