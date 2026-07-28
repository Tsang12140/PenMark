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

  async function create({ docId, ownerId, dataUrl, mirrorToRemote }) {
    const image = decodeInlineImage(dataUrl);
    const id = crypto.randomUUID();
    const storageName = id + '.' + MIME_EXTENSIONS[image.mimeType];
    const shouldMirror = !!mirrorToRemote && remoteMirror.enabled;
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
      try { replacements.set(source, await create({ docId: doc.id, ownerId: doc.user_id, dataUrl: source, mirrorToRemote: doc.mirrorToRemote })); }
      catch (err) { skipped++; console.warn('[assets] skipped an inline image:', err && err.message); }
    }
    if (!replacements.size) return { optimized: 0, skipped, content: doc.content };
    const content = String(doc.content || '').replace(/<img\b[^>]*?\bsrc\s*=\s*(["'])(data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/=]+)\1/gi, (tag, quote, source) => {
      const asset = replacements.get(source);
      return asset ? tag.replace(source, asset.url) : tag;
    });
    return { optimized: replacements.size, skipped, content };
  }

  return { create, externalize, filePath, url, signedRemoteUrl: remoteMirror.signedUrl, startRemoteMirrorWorker: remoteMirror.start, s4Enabled: remoteMirror.enabled };
}

module.exports = { createAssetStore };
