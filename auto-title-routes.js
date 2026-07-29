function registerAutoTitleRoutes({ app, db, auth, ai, aiLimiter, autoTitle, stripHtml, titleMaxLength }) {
  let inFlight = false;

  // PostgreSQL binds $N by number. SQLite's compatibility adapter binds them
  // in textual order; the SELECT slice appears before the WHERE owner check.
  // Keep both backends pointed at the same document and user.
  function sliceQueryParams(docId, userId) {
    return db.isPostgres()
      ? [docId, userId, 9000, 3500]
      : [9000, 3500, docId, userId];
  }

  function titleSuggestionError(err) {
    const message = String((err && err.message) || '');
    if (/timeout/i.test(message)) return 'AI 拟标题超时，请稍后重试';
    const status = message.match(/AI HTTP\s+(\d{3})/i);
    if (status) {
      if (status[1] === '401' || status[1] === '403') return 'AI 服务鉴权失败，请检查 AI_API_KEY';
      return 'AI 服务暂时不可用（HTTP ' + status[1] + '）';
    }
    if (/网关返回了 HTML 页面/i.test(message)) return 'AI 网关返回了网页，请检查 AI_BASE_URL';
    if (/no message content|invalid json|无效 JSON/i.test(message)) return 'AI 服务返回内容无效，请重试';
    return 'AI 拟标题失败，请稍后重试';
  }

  async function isEnabled() {
    const row = await db.one(
      'SELECT setting_value FROM app_settings WHERE setting_key = $1',
      [autoTitle.SETTING_KEY]
    );
    return !!row && row.setting_value === '1';
  }

  app.get('/api/admin/auto-title-settings', auth.adminOnly, wrap(async (req, res) => {
    res.json({ enabled: await isEnabled() });
  }));

  app.put('/api/admin/auto-title-settings', auth.adminOnly, wrap(async (req, res) => {
    const enabled = !!(req.body && req.body.enabled);
    const now = Date.now();
    const existing = await db.one(
      'SELECT id FROM app_settings WHERE setting_key = $1',
      [autoTitle.SETTING_KEY]
    );
    if (existing) {
      await db.execute(
        'UPDATE app_settings SET setting_value = $1, updated_at = $2 WHERE setting_key = $3',
        [enabled ? '1' : '0', now, autoTitle.SETTING_KEY]
      );
    } else {
      await db.execute(
        'INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES ($1, $2, $3)',
        [autoTitle.SETTING_KEY, enabled ? '1' : '0', now]
      );
    }
    res.json({ enabled });
  }));

  // Manual suggestions are intentionally separate from the automatic-title flow:
  // they never consume the document's single automatic attempt and never write.
  app.post('/api/ai/suggest-title', auth.adminOnly, aiLimiter, wrap(async (req, res) => {
    const docId = Number(req.body && req.body.docId);
    const expectedVersion = Number(req.body && req.body.version);
    if (!Number.isInteger(docId) || docId <= 0 || !Number.isInteger(expectedVersion) || expectedVersion <= 0) {
      return res.status(400).json({ error: 'invalid document version' });
    }
    if (!ai.configured()) return res.status(503).json({ error: 'AI is not configured' });
    if (inFlight) return res.status(409).json({ error: 'title generation is busy', retryable: true });

    const slices = autoTitle.sliceSelectSql(db.isPostgres());
    const doc = await db.one(
      'SELECT id, version, ' + slices + ' FROM documents WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
      sliceQueryParams(docId, req.user.id)
    );
    if (!doc) return res.status(404).json({ error: 'not found' });
    if (doc.version !== expectedVersion) return res.status(409).json({ error: 'document changed' });

    const excerpt = autoTitle.buildContext(doc.content_start, doc.content_end, stripHtml);
    if (excerpt.visibleChars < autoTitle.MIN_CHARS) {
      return res.json({ status: 'below_minimum', minimumChars: autoTitle.MIN_CHARS, version: doc.version });
    }

    inFlight = true;
    const abortController = new AbortController();
    // IncomingMessage `close` also fires after a normal completed request in
    // modern Node, so it would abort title generation immediately. Only a real
    // request abort or a response socket that closes before the reply is sent
    // means the browser actually went away.
    const onRequestAborted = () => abortController.abort();
    const onResponseClose = () => { if (!res.writableEnded) abortController.abort(); };
    req.on('aborted', onRequestAborted);
    res.on('close', onResponseClose);
    try {
      const result = await ai.suggestTitle(excerpt.context, { signal: abortController.signal });
      res.json(Object.assign({ version: doc.version }, result));
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.message === 'AbortError')) {
        return res.status(499).json({ error: 'cancelled' });
      }
      console.warn('[suggest-title] generation failed:', err && err.message);
      res.status(502).json({ error: titleSuggestionError(err) });
    } finally {
      inFlight = false;
      req.removeListener('aborted', onRequestAborted);
      res.removeListener('close', onResponseClose);
    }
  }));

  app.post('/api/ai/auto-title', auth.adminOnly, aiLimiter, wrap(async (req, res) => {
    const docId = Number(req.body && req.body.docId);
    const expectedVersion = Number(req.body && req.body.version);
    if (!Number.isInteger(docId) || docId <= 0 || !Number.isInteger(expectedVersion) || expectedVersion <= 0) {
      return res.status(400).json({ error: 'invalid document version' });
    }
    if (!await isEnabled()) return res.status(403).json({ error: 'automatic titles are disabled' });
    if (!ai.configured()) return res.status(503).json({ error: 'AI is not configured' });
    if (inFlight) return res.status(409).json({ error: 'automatic title is busy', retryable: true });

    const slices = autoTitle.sliceSelectSql(db.isPostgres());
    const doc = await db.one(
      'SELECT id, title, title_origin, auto_title_attempted_at, version, ' + slices +
      ' FROM documents WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
      sliceQueryParams(docId, req.user.id)
    );
    if (!doc) return res.status(404).json({ error: 'not found' });
    if (!autoTitle.isEligible(doc)) return res.status(409).json({ error: 'automatic title is no longer eligible' });
    if (doc.version !== expectedVersion) return res.status(409).json({ error: 'document changed' });

    const excerpt = autoTitle.buildContext(doc.content_start, doc.content_end, stripHtml);
    if (excerpt.visibleChars < autoTitle.MIN_CHARS) {
      return res.json({ status: 'below_minimum', minimumChars: autoTitle.MIN_CHARS });
    }

    inFlight = true;
    const claimed = await db.execute(
      'UPDATE documents SET auto_title_attempted_at = $1 WHERE id = $2 AND user_id = $3 AND version = $4 AND title_origin = $5 AND auto_title_attempted_at IS NULL',
      [Date.now(), docId, req.user.id, expectedVersion, 'untitled']
    );
    if (!claimed.changes) {
      inFlight = false;
      return res.status(409).json({ error: 'document changed' });
    }

    const abortController = new AbortController();
    // IncomingMessage `close` also fires after a normal completed request in
    // modern Node, so it would abort title generation immediately. Only a real
    // request abort or a response socket that closes before the reply is sent
    // means the browser actually went away.
    const onRequestAborted = () => abortController.abort();
    const onResponseClose = () => { if (!res.writableEnded) abortController.abort(); };
    req.on('aborted', onRequestAborted);
    res.on('close', onResponseClose);
    try {
      const result = await ai.suggestTitle(excerpt.context, { signal: abortController.signal });
      // This endpoint never persists a title. The browser must prove that its
      // active document is still unchanged before it calls the apply endpoint.
      res.json(Object.assign({ version: doc.version }, result));
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.message === 'AbortError')) {
        return res.status(499).json({ error: 'cancelled' });
      }
      console.warn('[auto-title] generation failed:', err && err.message);
      res.status(502).json({ error: titleSuggestionError(err) });
    } finally {
      inFlight = false;
      req.removeListener('aborted', onRequestAborted);
      res.removeListener('close', onResponseClose);
    }
  }));

  app.put('/api/documents/:id/auto-title', auth.adminOnly, wrap(async (req, res) => {
    const docId = Number(req.params.id);
    const expectedVersion = Number(req.body && req.body.version);
    const title = String(req.body && req.body.title || '').replace(/\s+/g, ' ').trim().slice(0, titleMaxLength);
    if (!Number.isInteger(docId) || docId <= 0 || !Number.isInteger(expectedVersion) || expectedVersion <= 0 || !title) {
      return res.status(400).json({ error: 'invalid automatic title' });
    }

    if (!await isEnabled()) return res.status(403).json({ error: 'automatic titles are disabled' });
    const info = await db.execute(
      'UPDATE documents SET title = $1, title_origin = $2, version = version + 1 WHERE id = $3 AND user_id = $4 AND deleted_at IS NULL AND version = $5 AND title_origin = $6 AND auto_title_attempted_at IS NOT NULL',
      [title, 'auto', docId, req.user.id, expectedVersion, 'untitled']
    );
    if (!info.changes) return res.status(409).json({ error: 'document changed' });

    const doc = await db.one(
      'SELECT title, title_origin, auto_title_attempted_at, version, updated_at FROM documents WHERE id = $1 AND user_id = $2',
      [docId, req.user.id]
    );
    res.json(doc);
  }));
}

// Kept local so this module can use the same async error handling as server.js.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { registerAutoTitleRoutes };
