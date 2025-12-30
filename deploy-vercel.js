#!/usr/bin/env node

/**
 * Vercel自動デプロイスクリプト
 * 
 * 使用方法:
 * 1. Vercel CLIでログイン: vercel login
 * 2. このスクリプトを実行: node deploy-vercel.js
 * 
 * または、環境変数でトークンを設定:
 * VERCEL_TOKEN=your_token node deploy-vercel.js
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('🚀 Vercelデプロイを開始します...\n');

// Vercel CLIがインストールされているか確認
try {
  execSync('vercel --version', { stdio: 'pipe' });
} catch (error) {
  console.error('❌ Vercel CLIがインストールされていません。');
  console.error('   インストール: npm install -g vercel');
  process.exit(1);
}

// プロジェクトの存在確認
const projectFiles = ['server.js', 'package.json', 'vercel.json'];
for (const file of projectFiles) {
  if (!fs.existsSync(path.join(process.cwd(), file))) {
    console.error(`❌ ${file} が見つかりません。`);
    process.exit(1);
  }
}

console.log('✅ プロジェクトファイルを確認しました。\n');

// デプロイ実行
try {
  console.log('📦 Vercelにデプロイ中...\n');
  
  // 本番環境にデプロイ
  const result = execSync('vercel --prod --yes', {
    stdio: 'inherit',
    cwd: process.cwd()
  });
  
  console.log('\n✅ デプロイが完了しました！');
  console.log('🌐 https://vmeda.vercel.app でアクセスできます。\n');
  
} catch (error) {
  console.error('\n❌ デプロイに失敗しました。');
  console.error('\n💡 解決方法:');
  console.error('   1. Vercel CLIでログイン: vercel login');
  console.error('   2. または、GitHubリポジトリをVercelに接続:');
  console.error('      - https://vercel.com にアクセス');
  console.error('      - 「Add New Project」をクリック');
  console.error('      - GitHubリポジトリを選択');
  console.error('      - 自動的にデプロイされます\n');
  process.exit(1);
}

