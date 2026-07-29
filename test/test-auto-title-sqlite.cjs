const assert = require('assert');
const { EventEmitter } = require('events');
const { registerAutoTitleRoutes } = require('../auto-title-routes');
const autoTitle = require('../auto-title');

const routes = new Map();
let documentParams = null;
const app = { get() {}, put() {}, post(path, ...handlers) { routes.set(path, handlers); } };
const db = {
  isPostgres: () => false,
  one: async (sql, params) => {
    if (!sql.includes('FROM documents')) return null;
    documentParams = params;
    return { id: 7, version: 3, content_start: '<p>' + '正文'.repeat(30) + '</p>', content_end: '' };
  },
  execute: async () => ({ changes: 1 })
};
const ai = { configured: () => true, suggestTitle: async () => ({ status: 'insufficient' }) };
registerAutoTitleRoutes({ app, db, auth: { adminOnly: (_req, _res, next) => next() }, ai, aiLimiter: (_req, _res, next) => next(), autoTitle, stripHtml: html => String(html || '').replace(/<[^>]*>/g, ' '), titleMaxLength: 100 });

const req = new EventEmitter();
req.body = { docId: 7, version: 3 };
req.user = { id: 1, isAdmin: true };
const res = new EventEmitter();
res.writableEnded = false;
res.statusCode = 200;
res.status = code => { res.statusCode = code; return res; };
res.json = body => { res.writableEnded = true; res.body = body; return res; };

(async () => {
  await routes.get('/api/ai/suggest-title')[2](req, res, err => { throw err; });
  assert.deepStrictEqual(documentParams, [9000, 3500, 7, 1]);
  assert.strictEqual(res.statusCode, 200);
  console.log('SQLite auto-title parameter order: passed');
})().catch(err => { console.error(err && err.stack || err); process.exit(1); });