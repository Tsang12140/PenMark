// Document image assets: HTML stores a short URL; bytes live in a controlled data directory.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createS4AssetMirror } = require('./s4-assets');

const MAX_BYTES = Number(process.env.PENMARK_ASSET_MAX_BYTES) || 15 * 1024 * 1024;
const MIME_EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif'
};

// 普通用户配额（管理员不限）：
// - 单用户图片总存储量 2GB
// - 单用户每月图片访问流量 500MB（仅统计成功响应的字节数）
const QUOTA_STORAGE_BYTES = 2 * 1024 * 1024 * 1024;
const QUOTA_BANDWIDTH_MONTHLY_BYTES = 500 * 1024 * 1024;

function monthStart(now) {
  const d = now instanceof Date ? now : new Date(now || Date.now());
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0).getTime();
}

function imageBufferMatchesMime(mimeType, buffer) {
  if (!buffer || buffer.length < 12) return false;
  if (mimeType === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimeType === 'image/gif') return buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a';
  if (mimeType === 'image/webp') return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  if (mimeType === 'image/avif') return buffer.subarray(4, 8).toString('ascii') === 'ftyp' && /avif|avis/.test(buffer.subarray(8, 16).toString('ascii'));
  return false;
}

function decodeInlineImage(dataUrl) {
  const match = String(dataUrl || '').match(/^data:(image\/(?:png|jpeg|gif|webp|avif));base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) throw new Error('\u56fe\u7247\u683c\u5f0f\u4e0d\u652f\u6301');
  const mimeType = match[1].toLowerCase();
  const encoded = match[2];
  if (encoded.length > Math.ceil(MAX_BYTES * 4 / 3) + 8) throw new Error('\u56fe\u7247\u4e0d\u80fd\u8d85\u8fc7 ' + Math.floor(MAX_BYTES / 1024 / 1024) + 'MB');
  const buffer = Buffer.from(encoded, 'base64');
  if (!buffer.length || buffer.length > MAX_BYTES || !imageBufferMatchesMime(mimeType, buffer)) throw new Error('\u56fe\u7247\u6570\u636e\u65e0\u6548');
  return { mimeType, buffer };
}

function findInlineImageSources(html) {
  const sources = [];
  const pattern = /<img\b[^>]*?\bsrc\s*=\s*(["'])(data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/=]+)\1/gi;
  let match;
  while ((match = pattern.exec(String(html || '')))) sources.push(match[2]);
  return sources;
}

function createAssetStore(db) {
  const root = path.resolve(process.env.PENMARK_ASSET_DIR || path.join(process.env.PENMARK_DATA_DIR || path.join(__dirname, 'data'), 'assets'));
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  const remoteMirror = createS4AssetMirror(db, filePath);

  function url(id) { return '/api/assets/' + id; }

  // 配额检查：管理员不限；普通用户校验总存储量与本月流量
  // 上传时按图片字节累加预判，避免写入后再回滚
  async function checkQuota(ownerId, isAdmin, additionalBytes) {
    if (isAdmin) return { ok: true };
    const storageRow = await db.one(
      'SELECT COALESCE(SUM(byte_size), 0) AS total FROM media_assets WHERE owner_id = $1',
      [ownerId]
    );
    const totalStorage = Number(storageRow && storageRow.total || 0);
    if (totalStorage + additionalBytes > QUOTA_STORAGE_BYTES) {
      return { ok: false, reason: 'storage', used: totalStorage, quota: QUOTA_STORAGE_BYTES };
    }
    const ms = monthStart();
    const bwRow = await db.one(
      'SELECT bytes FROM user_asset_bandwidth WHERE user_id = $1 AND month_start = $2',
      [ownerId, ms]
    );
    const usedBw = Number(bwRow && bwRow.bytes || 0);
    if (usedBw + additionalBytes > QUOTA_BANDWIDTH_MONTHLY_BYTES) {
      return { ok: false, reason: 'bandwidth', used: usedBw, quota: QUOTA_BANDWIDTH_MONTHLY_BYTES };
    }
    return { ok: true };
  }

  // 记录访问流量（仅成功响应时调用；管理员同样累计，便于观测）
  // upsert 语法同时兼容 PostgreSQL 与 SQLite 3.24+
  async function recordBandwidth(ownerId, bytes) {
    if (!bytes || bytes <= 0) return;
    const ms = monthStart();
    try {
      await db.execute(
        'INSERT INTO user_asset_bandwidth (user_id, month_start, bytes) VALUES ($1, $2, $3) ' +
        'ON CONFLICT (user_id, month_start) DO UPDATE SET bytes = user_asset_bandwidth.bytes + EXCLUDED.bytes',
        [ownerId, ms, bytes]
      );
    } catch (err) {
      // 流量统计失败不应阻断图片响应
      console.warn('[assets] recordBandwidth failed:', err && err.message);
    }
  }

  async function create({ docId, ownerId, isAdmin, dataUrl, mirrorToRemote }) {
    const image = decodeInlineImage(dataUrl);
    // 配额预检：失败抛出带 code 的错误，路由层据此返回 413
    const quota = await checkQuota(ownerId, !!isAdmin, image.buffer.length);
    if (!quota.ok) {
      const err = new Error(quota.reason === 'storage'
        ? '图片存储总量超出 2GB 限制，请删除旧文档中的图片或联系管理员'
        : '本月图片访问流量超出 500MB 限制，请下月再试或联系管理员');
      err.code = 'QUOTA_EXCEEDED';
      err.quotaReason = quota.reason;
      throw err;
    }
    const id = crypto.randomUUID();
    const storageName = id + '.' + MIME_EXTENSIONS[image.mimeType];
    // S4 启用时所有用户都镜像；管理员不限，普通用户也走 S4（解决访客看不到图片的核心问题）
    const shouldMirror = mirrorToRemote !== false && remoteMirror.enabled;
    const remoteKey = shouldMirror ? remoteMirror.keyFor(id, MIME_EXTENSIONS[image.mimeType]) : null;
    const finalPath = path.join(root, storageName);
    const tempPath = finalPath + '.uploading-' + crypto.randomBytes(6).toString('hex');
    await fs.promises.writeFile(tempPath, image.buffer, { flag: 'wx' });
    try {
      await fs.promises.rename(tempPath, finalPath);
      await db.execute(
        'INSERT INTO media_assets (id, doc_id, owner_id, storage_name, mime_type, byte_size, created_at, remote_provider, remote_key, remote_status, remote_attempts) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0)',
        [id, docId, ownerId, storageName, image.mimeType, image.buffer.length, Date.now(), shouldMirror ? 's4' : 'local', remoteKey, shouldMirror ? 'pending' : 'local']
      );
    } catch (err) {
      await fs.promises.unlink(tempPath).catch(() => {});
      await fs.promises.unlink(finalPath).catch(() => {});
      throw err;
    }
    if (shouldMirror) remoteMirror.schedule(id);
    return { id, url: url(id), mime_type: image.mimeType, byte_size: image.buffer.length, remote_status: shouldMirror ? 'pending' : 'local' };
  }

  async function filePath(asset) {
    const candidate = path.resolve(root, asset.storage_name);
    if (!candidate.startsWith(root + path.sep)) return null;
    try {
      await fs.promises.access(candidate, fs.constants.R_OK);
      return candidate;
    } catch (_) {
      return null;
    }
  }

  async function externalize(doc) {
    const sources = findInlineImageSources(doc.content);
    if (!sources.length) return { optimized: 0, skipped: 0, content: doc.content };
    const replacements = new Map();
    let skipped = 0;
    for (const source of sources) {
      if (replacements.has(source)) continue;
      try {
        replacements.set(source, await create({
          docId: doc.id,
          ownerId: doc.user_id,
          isAdmin: !!doc.ownerIsAdmin,
          dataUrl: source,
          mirrorToRemote: doc.mirrorToRemote !== false
        }));
      } catch (err) {
        skipped++;
        console.warn('[assets] skipped an inline image:', err && err.message);
      }
    }
    if (!replacements.size) return { optimized: 0, skipped, content: doc.content };
    const content = String(doc.content || '').replace(/<img\b[^>]*?\bsrc\s*=\s*(["'])(data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/=]+)\1/gi, (tag, quote, source) => {
      const asset = replacements.get(source);
      return asset ? tag.replace(source, asset.url) : tag;
    });
    return { optimized: replacements.size, skipped, content };
  }

  return {
    create, externalize, filePath, url,
    checkQuota, recordBandwidth,
    waitRemoteReady: remoteMirror.waitReady,
    signedRemoteUrl: remoteMirror.signedUrl,
    publicRemoteUrl: remoteMirror.publicUrl,
    startRemoteMirrorWorker: remoteMirror.start,
    s4Enabled: remoteMirror.enabled
  };
}

module.exports = { createAssetStore };
