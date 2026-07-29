const assert = require('assert');
const { EventEmitter } = require('events');
const { registerAutoTitleRoutes } = require('../auto-title-routes');
const autoTitle = require('../auto-title');

function stripHtml(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ');
}

async function main() {
  const routes = new Map();
  const app = {
    get() {},
    put() {},
    post(path, ...handlers) { routes.set(path, handlers); }
  };
  let capturedSignal = null;
  let resolveModel;
  const db = {
    isPostgres: () => true,
    one: async (sql) => sql.includes('FROM documents')
      ? { id: 7, version: 3, content_start: '<p>' + '正文'.repeat(30) + '</p>', content_end: '' }
      : null,
    execute: async () => ({ changes: 1 })
  };
  const ai = {
    configured: () => true,
    suggestTitle: async (_context, { signal }) => {
      capturedSignal = signal;
      return new Promise(resolve => { resolveModel = resolve; });
    }
  };
  registerAutoTitleRoutes({
    app,
    db,
    auth: { adminOnly: (_req, _res, next) => next() },
    ai,
    aiLimiter: (_req, _res, next) => next(),
    autoTitle,
    stripHtml,
    titleMaxLength: 100
  });

  const handlers = routes.get('/api/ai/suggest-title');
  assert(handlers && handlers.length === 3, 'manual title route is registered');
  const req = new EventEmitter();
  req.body = { docId: 7, version: 3 };
  req.user = { id: 1, isAdmin: true };
  const res = new EventEmitter();
  res.writableEnded = false;
  res.statusCode = 200;
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.writableEnded = true; res.body = body; return res; };

  // In modern Node, IncomingMessage emits close after a normal request body is
  // complete. That event must not cancel an in-flight model request.
  const pending = handlers[2](req, res, err => { throw err; });
  for (let i = 0; i < 8 && !capturedSignal; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert(capturedSignal, 'model received an abort signal');
  req.emit('close');
  assert.strictEqual(capturedSignal.aborted, false, 'normal request close does not abort title generation');
  resolveModel({ status: 'ok', title: '稳定生成的标题' });
  await pending;
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body, { version: 3, status: 'ok', title: '稳定生成的标题' });
  console.log('auto-title route abort regression: passed');
}

main().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});