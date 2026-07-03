#!/usr/bin/env node
/**
 * sync-pricing.js
 *
 * 将 shared/model-pricing.json 同步到 backend 和 worker 的 src/data/ 目录。
 * 在 build 和 dev 前自动运行，确保两端使用同一份定价数据。
 *
 * 唯一真实来源: shared/model-pricing.json
 * 生成产物:     backend/src/data/model-pricing.json
 *               worker/src/data/model-pricing.json
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'shared', 'model-pricing.json');

const targets = [
  path.join(root, 'backend', 'src', 'data', 'model-pricing.json'),
  path.join(root, 'worker', 'src', 'data', 'model-pricing.json'),
];

if (!fs.existsSync(source)) {
  console.error('[sync-pricing] ERROR: shared/model-pricing.json not found');
  process.exit(1);
}

const content = fs.readFileSync(source, 'utf-8');

for (const target of targets) {
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  let existing = '';
  try { existing = fs.readFileSync(target, 'utf-8'); } catch {}
  if (existing !== content) {
    fs.writeFileSync(target, content, 'utf-8');
    console.log(`[sync-pricing] synced ${path.relative(root, target)}`);
  }
}

console.log('[sync-pricing] done');
