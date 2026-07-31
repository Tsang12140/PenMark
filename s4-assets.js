// Durable background mirror for optional administrator-only S4 image storage.
const { createS4Client } = require('./s4');

function createS4AssetMirror(db, getLocalFilePath) {
  const s4 = createS4Client();
  const inFlight = new Map();
  const retryMs = Math.max(60000, Number(process.env.PENMARK_S4_RETRY_MS) || 5 * 60 * 1000);
  let retryTimer = null;

  function keyFor(id, extension) {
    return 'penmark/admin/' + id + '.' + extension;
  }

  function schedule(assetId) {
    if (!s4.enabled) return null;
    if (inFlight.has(assetId)) return inFlight.get(assetId);
    const task = Promise.resolve()
      .then(() => mirror(assetId))
      .catch(err => console.warn('[assets] S4 mirror failed:', err && err.message))
      .finally(() => inFlight.delete(assetId));
    inFlight.set(assetId, task);
    return task;
  }

  // 访客访问分享图片时使用：若 S4 启用但资源仍 pending，主动触发并等待上传完成。
  // 这解决了"管理员刚上传图片就分享，访客打开时 S4 还没就绪"的核心问题。
  // task 完成（成功或失败）后查一次状态：ready 返回 true，否则返回 false 让路由回退本地兜底。
  // 不做无限轮询，因为 task 完成后状态不会再变。
  async function waitReady(assetId, timeoutMs) {
    if (!s4.enabled) return false;
    const task = inFlight.get(assetId) || schedule(assetId);
    if (task) {
      const timeout = new Promise(resolve => setTimeout(resolve, Math.max(1000, Number(timeoutMs) || 5000), false));
      try { await Promise.race([task, timeout]); } catch (_) { /* schedule 已吞错，此处仅等待 */ }
    }
    const row = await db.one('SELECT remote_status FROM media_assets WHERE id = $1', [assetId]);
    return !!(row && row.remote_status === 'ready');
  }

  async function mirror(assetId) {
    if (!s4.enabled) return false;
    const asset = await db.one(
      "SELECT * FROM media_assets WHERE id = $1 AND remote_provider = 's4' AND remote_status = 'pending'",
      [assetId]
    );
    if (!asset) return false;
    const localPath = await getLocalFilePath(asset);
    const attemptedAt = Date.now();
    if (!localPath) {
      await db.execute(
        "UPDATE media_assets SET remote_attempted_at = $1, remote_attempts = remote_attempts + 1, remote_error = $2 WHERE id = $3 AND remote_status = 'pending'",
        [attemptedAt, 'local image file is missing', assetId]
      );
      return false;
    }
    await db.execute(
      "UPDATE media_assets SET remote_attempted_at = $1, remote_attempts = remote_attempts + 1, remote_error = NULL WHERE id = $2 AND remote_status = 'pending'",
      [attemptedAt, assetId]
    );
    try {
      await s4.putFile(asset.remote_key, localPath, asset.mime_type);
      await db.execute(
        "UPDATE media_assets SET remote_status = 'ready', remote_synced_at = $1, remote_error = NULL WHERE id = $2 AND remote_provider = 's4'",
        [Date.now(), assetId]
      );
      return true;
    } catch (err) {
      const message = String(err && err.message || 'S4 upload failed').slice(0, 500);
      await db.execute(
        "UPDATE media_assets SET remote_status = 'pending', remote_error = $1 WHERE id = $2 AND remote_provider = 's4'",
        [message, assetId]
      );
      throw err;
    }
  }

  async function flush() {
    if (!s4.enabled) return 0;
    const retryBefore = Date.now() - retryMs;
    const rows = await db.query(
      "SELECT id FROM media_assets WHERE remote_provider = 's4' AND remote_status = 'pending' AND (remote_attempted_at IS NULL OR remote_attempted_at <= $1) ORDER BY created_at ASC LIMIT $2",
      [retryBefore, 12]
    );
    for (const row of rows) schedule(row.id);
    return rows.length;
  }

  function start() {
    if (!s4.enabled || retryTimer) return false;
    Promise.resolve().then(flush).catch(err => console.warn('[assets] S4 queue scan failed:', err && err.message));
    retryTimer = setInterval(() => {
      flush().catch(err => console.warn('[assets] S4 queue scan failed:', err && err.message));
    }, retryMs);
    if (retryTimer.unref) retryTimer.unref();
    return true;
  }

  function signedUrl(asset) {
    if (!s4.enabled || !asset || asset.remote_provider !== 's4' || asset.remote_status !== 'ready' || !asset.remote_key) return null;
    return s4.signGet(asset.remote_key);
  }

  return { enabled: s4.enabled, keyFor, schedule, waitReady, start, flush, signedUrl };
}

module.exports = { createS4AssetMirror };
