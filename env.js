// 知著 PenMark 极简 .env 解析器（不引入 dotenv 依赖）
// 用法：require('./env'); 之后即可通过 process.env 读取
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '.env');

function parseEnv(content) {
  const result = {};
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    // 去除两端引号
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) result[key] = val;
  }
  return result;
}

try {
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    const parsed = parseEnv(content);
    // 仅在 process.env 未设置时填充，不覆盖已存在的环境变量
    for (const k of Object.keys(parsed)) {
      if (process.env[k] === undefined) process.env[k] = parsed[k];
    }
  }
} catch (e) {
  console.warn('读取 .env 文件失败：', e.message);
}

module.exports = { parseEnv };
