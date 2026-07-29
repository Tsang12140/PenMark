const assert = require('assert');
const { parseProviderJson } = require('../ai');

assert.deepStrictEqual(parseProviderJson('\uFEFF {"ok":true}').data, { ok: true });
const streamed = parseProviderJson('data: {"choices":[{"delta":{"content":"标题"}}]}\n\ndata: {"choices":[{"delta":{"content":"建议"}}]}\n\ndata: [DONE]');
assert.strictEqual(streamed.kind, 'sse');
assert.strictEqual(streamed.data.choices[0].message.content, '标题建议');
const html = parseProviderJson('<html><title>Bad gateway</title></html>');
assert.strictEqual(html.data, null);
assert.strictEqual(html.kind, 'html');
console.log('AI response parser: passed');