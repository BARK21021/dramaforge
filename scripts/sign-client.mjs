#!/usr/bin/env node
// =============================================================================
// sign-client.mjs — 对打包好的客户端 .exe 算 Ed25519 签名 + sha256
// =============================================================================
// 每次发版在本地（持有私钥的可信机器）跑，输出供 publish-client.sh 写进
// system_configs.CLIENT_VERSIONS_MANIFEST。客户端下载后用编译进二进制的
// 公钥验签，防供应链投毒。
//
// 用法：
//   node scripts/sign-client.mjs <exe路径> <私钥PEM路径>
//
// stdout（JSON，供 publish-client.sh 消费）:
//   {"signature":"<base64>","sha256":"<hex>"}
// =============================================================================

import { sign, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const exePath = process.argv[2];
const keyPath = process.argv[3];
if (!exePath || !keyPath) {
  console.error('用法: node scripts/sign-client.mjs <exe路径> <私钥PEM路径>');
  process.exit(1);
}

let data;
try {
  data = readFileSync(exePath);
} catch (e) {
  console.error('❌ 读 .exe 失败:', e.message);
  process.exit(1);
}

let privateKey;
try {
  privateKey = readFileSync(keyPath);
} catch (e) {
  console.error('❌ 读私钥失败:', e.message);
  process.exit(1);
}

// Ed25519 一次性签名（单次签名算法，不分块）：sign(null, data, privateKey) → Buffer
let signature;
try {
  signature = sign(null, data, privateKey);
} catch (e) {
  console.error('❌ 签名失败（私钥格式错误？需 gen-update-key.mjs 生成的 PKCS8 PEM）:', e.message);
  process.exit(1);
}

const sha256 = createHash('sha256').update(data).digest('hex');

console.log(JSON.stringify({ signature: signature.toString('base64'), sha256 }));
