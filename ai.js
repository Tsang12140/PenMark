require('./env');
const http = require('http');
const https = require('https');

const DEFAULT_DEEPSEEK_BASE = 'https://api.deepseek.com';

// PenMark 编辑器内部知识：让 AI 理解"设成 H2""加粗"等指代的是本编辑器的元素，
// 注入到排版与对话系统提示词中，使 AI 的指令可被编辑器直接落地。
const PENMARK_KNOWLEDGE = [
  'PenMark editor knowledge (this is the editor the user is writing in):',
  '- The document is editable HTML. Supported block elements: h1-h6, p, blockquote, pre, ul, ol, li, table, hr.',
  '- Supported inline elements: strong (bold), em (italic), u (underline), s/strike (strikethrough), code (inline code), a (links).',
  '- Heading hierarchy: H1 is the top-level heading but is rarely used in articles; H2 is the standard major section heading; H3 is a subheading under H2; H4-H6 are deeper nested headings. Do not overuse H1.',
  '- Paragraphs default to justified alignment (text-align:justify).',
  '- Custom atomic blocks that MUST be preserved exactly as-is: .link-card (link cards), .img-container (single image wrappers), .img-grid (image grids). Never strip their data attributes, classes, or inner structure.',
  '- When a user says "设成 H2" / "改成二级标题" / "make it H2", it means wrap the text in an <h2> element in this editor. "设成 H3" means <h3>, and so on.',
  '- "加粗" / "bold" means wrap in <strong>; "斜体"/"italic" means <em>; "设成引用"/"blockquote" means format as <blockquote>; "代码块"/"code block" means <pre>; "列表" means <ul>/<ol>.',
  '- Image placeholders look like <div class="img-container">...<img>...</div> or <div class="img-grid">...</div>; preserve them untouched.'
].join('\n');

function configured() {
  return !!getApiKey();
}

function getApiKey() {
  return process.env.AI_API_KEY || process.env.DEEPSEEK_API_KEY || '';
}

function getModel() {
  return process.env.AI_MODEL || 'deepseek-chat';
}

function getBaseUrl() {
  return (process.env.AI_BASE_URL || DEFAULT_DEEPSEEK_BASE).replace(/\/+$/, '');
}

function getEndpoint() {
  const base = getBaseUrl();
  if (/\/chat\/completions$/i.test(base)) return base;
  return base + '/chat/completions';
}

function requestJson(url, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'http:' ? http : https;
    const body = JSON.stringify(payload);
    const req = transport.request({
      method: 'POST',
      hostname: target.hostname,
      port: target.port || undefined,
      path: target.pathname + target.search,
      headers: {
        'Authorization': 'Bearer ' + getApiKey(),
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: timeoutMs || 60000
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) {}
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const detail = data && data.error && (data.error.message || data.error.code || data.error.type);
          reject(new Error('AI HTTP ' + res.statusCode + (detail ? ': ' + detail : '')));
          return;
        }
        if (!data) {
          reject(new Error('AI returned an empty response'));
          return;
        }
        resolve(data);
      });
    });
    req.on('timeout', () => req.destroy(new Error('AI request timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function chat(messages, options) {
  if (!getApiKey()) {
    throw new Error('AI is not configured. Set AI_API_KEY or DEEPSEEK_API_KEY on the server.');
  }
  const data = await requestJson(getEndpoint(), {
    model: (options && options.model) || getModel(),
    messages,
    temperature: options && options.temperature !== undefined ? options.temperature : 0.2,
    max_tokens: options && options.maxTokens ? options.maxTokens : 4096
  }, options && options.timeoutMs);
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) throw new Error('AI response has no message content');
  return String(content).trim();
}

const layoutPresetInstructions = {
  light: 'Light cleanup: normalize paragraphs, headings, lists, spacing, and quote/code/table structure only when strongly implied by the original text.',
  share: 'Publish polish: make the article pleasant to share. Build clear title hierarchy, short readable paragraphs, consistent lists, tasteful emphasis, and spacing. Do not change wording.',
  formal: 'Formal document layout: use conservative headings, numbered sections, paragraphs, blockquotes, and tables only when the source clearly implies them.',
  clean: 'Clean plain layout: remove messy inline wrappers and redundant styles, keep semantic HTML and simple paragraphs/headings/lists.',
  wash: 'Wash layout (deep format cleanup). Strip ALL inline styles from every element (background, font-family, color, font-size, text-decoration, margins, etc.) so only clean semantic HTML remains. Build a clear outline: use <h2> for major section headings and <h3> for subheadings; NEVER use <h1>. Identify the key phrases the author likely wants to emphasize and wrap each in <strong> (use sparingly, only for genuinely important points). Wrap every paragraph in <p> with style="text-align:justify". Normalize lists into <ul>/<ol> where the text implies them. Do not delete, summarize, rewrite, or reorder any words.'
};

function stripCodeFence(text) {
  return String(text || '')
    .replace(/^```(?:html)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

async function layoutHtml(html, preset, customPrompt) {
  let mode;
  if (preset === 'custom') {
    // 用户自定义预设：完全以用户输入的提示词为准
    mode = 'Custom user preset. Follow the user instructions below to lay out the HTML.';
    if (customPrompt && customPrompt.trim()) mode += '\nUser instructions: ' + customPrompt.trim();
  } else {
    mode = layoutPresetInstructions[preset] || layoutPresetInstructions.share;
  }
  const system = [
    'You are a strict Chinese article HTML layout assistant.',
    'Your job is layout only. Never delete, summarize, translate, rewrite, invent, or soften any words.',
    'Preserve every visible character from the input in the same order, except whitespace normalization and HTML entity normalization.',
    'You may change HTML structure to paragraphs, headings, lists, blockquotes, tables, and inline emphasis when the original clearly supports it.',
    'Preserve image placeholders, links, link-card blocks, and custom data attributes exactly.',
    PENMARK_KNOWLEDGE,
    'Return only the final HTML fragment. No markdown fence, no commentary.'
  ].join(' ');
  const user = 'Preset: ' + mode + '\n\nHTML fragment:\n' + html;
  return stripCodeFence(await chat([
    { role: 'system', content: system },
    { role: 'user', content: user }
  ], { temperature: 0.1, maxTokens: Number(process.env.AI_LAYOUT_MAX_TOKENS || 12000), timeoutMs: 90000 }));
}

async function rewriteSelection(selectedText, instruction, contextText) {
  const system = [
    'You are a careful Chinese writing assistant embedded in an editor.',
    'Only produce the replacement for the selected text.',
    'Use the full-document context only to understand names, tone, and facts.',
    'Do not mention that you used context. Do not wrap the answer in quotes or markdown unless the user explicitly asks for markdown.'
  ].join(' ');
  const user = [
    'User instruction:', instruction || 'Polish the selected text while preserving meaning.',
    '',
    'Full document context (reference only):', contextText || '',
    '',
    'Selected text to replace:', selectedText || ''
  ].join('\n');
  return stripCodeFence(await chat([
    { role: 'system', content: system },
    { role: 'user', content: user }
  ], { temperature: 0.35, maxTokens: Number(process.env.AI_REWRITE_MAX_TOKENS || 3000), timeoutMs: 70000 }));
}

module.exports = { configured, chat, layoutHtml, rewriteSelection, PENMARK_KNOWLEDGE };
