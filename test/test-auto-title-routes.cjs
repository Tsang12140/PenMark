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

  // A provider failure should reach the UI as a useful, safe diagnostic rather
  // than the previous unhelpful "title suggestion failed" message.
  ai.suggestTitle = async () => { throw new Error('AI HTTP 401: invalid API key'); };
  const failedReq = new EventEmitter();
  failedReq.body = { docId: 7, version: 3 };
  failedReq.user = { id: 1, isAdmin: true };
  const failedRes = new EventEmitter();
  failedRes.writableEnded = false;
  failedRes.statusCode = 200;
  failedRes.status = code => { failedRes.statusCode = code; return failedRes; };
  failedRes.json = body => { failedRes.writableEnded = true; failedRes.body = body; return failedRes; };
  await handlers[2](failedReq, failedRes, err => { throw err; });
  assert.strictEqual(failedRes.statusCode, 502);
  assert.strictEqual(failedRes.body.error, 'AI 服务鉴权失败，请检查 AI_API_KEY');

  ai.suggestTitle = async () => { throw new Error('AI 返回无效 JSON: 网关返回了 HTML 页面，请检查 AI_BASE_URL'); };
  const htmlReq = new EventEmitter();
  htmlReq.body = { docId: 7, version: 3 };
  htmlReq.user = { id: 1, isAdmin: true };
  const htmlRes = new EventEmitter();
  htmlRes.writableEnded = false;
  htmlRes.statusCode = 200;
  htmlRes.status = code => { htmlRes.statusCode = code; return htmlRes; };
  htmlRes.json = body => { htmlRes.writableEnded = true; htmlRes.body = body; return htmlRes; };
  await handlers[2](htmlReq, htmlRes, err => { throw err; });
  assert.strictEqual(htmlRes.statusCode, 502);
  assert.strictEqual(htmlRes.body.error, 'AI 网关返回了网页，请检查 AI_BASE_URL');
  console.log('auto-title route abort and error regression: passed');
}

main().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});