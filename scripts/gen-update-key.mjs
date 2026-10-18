#!/usr/bin/env node
// =============================================================================
// gen-update-key.mjs — 一次性离线生成 Ed25519 客户端更新签名密钥对
// =============================================================================
// 建立客户端更新链的信任根：私钥离线保管，公钥贴进客户端编译期常量。
// 客户端下载更新后用公钥验签，服务器沦陷也改不了公钥（编进二进制）。
//
// ⚠ 私钥永不进服务器 / git / 他人手。泄露 = 签名链失效（能签出客户端认可
// 的恶意 .exe，等同服务器沦陷的投毒能力）。
//
// 用法：
//   node scripts/gen-update-key.mjs <私钥输出路径>
//     <私钥输出路径> — Ed25519 PKCS8 PEM 写入位置（建议加密保管）
//
// 例：
//   node scripts/gen-update-key.mjs ~/dramaforge-update-ed25519.pem
// =============================================================================

import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const outPath = process.argv[2];
if (!outPath) {
  console.error('用法: node scripts/gen-update-key.mjs <私钥输出路径>');
  console.error('例: node scripts/gen-update-key.mjs ~/dramaforge-update-ed25519.pem');
  process.exit(1);
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519');

// 私钥：PKCS8 PEM（含头尾，离线保管）
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
writeFileSync(outPath, privateKeyPem, { mode: 0o600 });

// 公钥：SPKI DER → base64（紧凑，贴进客户端常量）
const publicKeyB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

console.log('=== Ed25519 客户端更新签名密钥对已生成 ===\n');
console.log('🔒 私钥（离线保管，勿进服务器/git）:', outPath);
console.log('   建议加密: gpg -c ' + outPath + '  或存密码管理器\n');
console.log('公钥 base64（贴进 packages/client/main/index.ts 的 UPDATE_SIGNING_PUBLIC_KEY）:\n');
console.log(publicKeyB64);
console.log('\n✅ 下一步:');
console.log('   1. 把上面公钥 base64 贴进 UPDATE_SIGNING_PUBLIC_KEY 常量');
console.log('   2. 妥善保管私钥文件（加密 USB / 密码管理器 / 离线机器）');
console.log('   3. pnpm --filter @dramaforge/client package  打包 .exe');
console.log('   4. bash scripts/publish-client.sh <version> <私钥路径> --force  发布');
