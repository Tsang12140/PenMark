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
  '- The reader provides responsive typography. Do not add text-align, text-justify, text-align-last, letter-spacing, font-size, font-family, color, background, or spacing styles to normal paragraphs.',
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

function parseProviderJson(text) {
  const source = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!source) return { data: null, error: null, kind: 'empty' };
  try {
    return { data: JSON.parse(source), error: null, kind: 'json' };
  } catch (error) {
    // Some OpenAI-compatible gateways respond as SSE even when stream:false.
    // Reassemble their delta payloads instead of treating a valid answer as an
    // unusable HTML/text response.
    const events = source.split(/\r?\n/)
      .map(line => line.trim().replace(/^data:\s*/i, ''))
      .filter(line => line && line !== '[DONE]')
      .map(line => { try { return JSON.parse(line); } catch (_) { return null; } })
      .filter(Boolean);
    if (events.length) {
      const message = events.map(event => event && event.choices && event.choices[0] && event.choices[0].delta && event.choices[0].delta.content || '').join('');
      if (message) return { data: { choices: [{ message: { content: message } }] }, error: null, kind: 'sse' };
      return { data: events[events.length - 1], error: null, kind: 'sse' };
    }
    return { data: null, error, kind: /^</.test(source) ? 'html' : 'text' };
  }
}

function requestJson(url, payload, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    // 已取消：立即拒绝，避免无谓的 HTTP 请求
    if (signal && signal.aborted) {
      reject(new Error('AbortError'));
      return;
    }
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
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: timeoutMs || 60000
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const parsed = parseProviderJson(text);
        const data = parsed.data;
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const detail = data && data.error && (data.error.message || data.error.code || data.error.type);
          reject(new Error('AI HTTP ' + res.statusCode + (detail ? ': ' + detail : '')));
          return;
        }
        if (!data) {
          // 保留原始 parse 错误信息，便于诊断 AI 返回非 JSON 的根因
          const hint = parsed.kind === 'html'
            ? '网关返回了 HTML 页面，请检查 AI_BASE_URL'
            : parsed.error
              ? ('JSON 解析失败: ' + (parsed.error.message || '').slice(0, 80))
              : '空响应';
          reject(new Error('AI 返回无效 JSON: ' + hint));
          return;
        }
        resolve(data);
      });
    });
    req.on('timeout', () => req.destroy(new Error('AI request timeout')));
    req.on('error', reject);
    // 客户端取消：销毁底层 socket，并标注为 AbortError 以便上层区分
    if (signal) {
      const onAbort = () => {
        try { req.destroy(new Error('Request aborted')); } catch (_) {}
        reject(new Error('AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
    req.write(body);
    req.end();
  });
}

async function chat(messages, options) {
  if (!getApiKey()) {
    throw new Error('AI is not configured. Set AI_API_KEY or DEEPSEEK_API_KEY on the server.');
  }
  const endpoint = getEndpoint();
  const payload = {
    model: (options && options.model) || getModel(),
    messages,
    temperature: options && options.temperature !== undefined ? options.temperature : 0.2,
    max_tokens: options && options.maxTokens ? options.maxTokens : 4096,
    stream: false
  };
  // DeepSeek V4 enables thinking by default. For PenMark's one-shot editing
  // actions, it only adds latency/cost and can exhaust a small output budget
  // before the final `content` is produced. Keep other compatible providers
  // untouched unless the caller explicitly asks for a thinking setting.
  const isOfficialDeepSeek = /^api\.deepseek\.com$/i.test(new URL(endpoint).hostname);
  const thinking = options && Object.prototype.hasOwnProperty.call(options, 'thinking')
    ? options.thinking
    : (isOfficialDeepSeek ? 'disabled' : null);
  if (thinking) payload.thinking = { type: thinking };
  if (options && options.responseFormat) payload.response_format = options.responseFormat;

  const data = await requestJson(endpoint, payload, options && options.timeoutMs, options && options.signal);
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) throw new Error('AI response has no message content');
  return String(content).trim();
}

const layoutPresetInstructions = {
  light: '轻度整理：仅在原文强烈暗示时，规范化段落、标题、列表、间距，以及引用/代码/表格结构，不做多余改动。',
  share: '分享前排版：让文章更适合分享传播。建立清晰的标题层级、简短易读的段落、统一的列表、适度的强调与间距。不改动任何文字。',
  formal: '正式文档排版：使用保守的标题、编号章节、段落、引用块与表格，仅在原文明确暗示时使用。',
  clean: '清理杂样式：去除混乱的内联包裹与冗余样式，保留语义化 HTML 和简洁的段落/标题/列表。',
  wash: '洗排版（长文阅读）：只调整 HTML 结构，绝不改变任何可见文字、标点、数字、顺序或信息；不得增删、改写、概括、纠错或合并句子。移除所有普通文字的内联样式和多余包裹；不要输出 style、class、font、color、background、字号、字距、行距或对齐属性。保留已有图片、链接、链接卡片和自定义 data 属性。保留现有标题层级；仅在原文明确信号是标题时使用 <h2>/<h3>，不使用 <h1>，不凭空新增章节。每个自然段使用一个 <p>，不要为了凑版面插入 <br>、空段、全角空格或 &nbsp;。把真正的项目符号/序号整理为 <ul>/<ol><li>，不要用字符“•”“-”“—”假装列表。只在原文已经明确强调，或确实承担结论、警示、核心标签的短语上添加 <strong>；每段最多 1 处、每节最多 4 处，绝不加粗整句、整段或连续多项。不要使用 blockquote、表格、代码块，除非原文已有相应语义。'
};

function stripCodeFence(text) {
  return String(text || '')
    .replace(/^```(?:html)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

async function layoutHtml(html, preset, customPrompt, options) {
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
  ], { temperature: 0.1, maxTokens: Number(process.env.AI_LAYOUT_MAX_TOKENS || 12000), timeoutMs: 90000, signal: options && options.signal }));
}

async function rewriteSelection(selectedText, instruction, contextText, options) {
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
  ], { temperature: 0.35, maxTokens: Number(process.env.AI_REWRITE_MAX_TOKENS || 3000), timeoutMs: 70000, signal: options && options.signal }));
}

function parseAutoTitleResult(raw) {
  let parsed;
  try { parsed = JSON.parse(String(raw || '').trim()); }
  catch (_) { return { status: 'insufficient' }; }
  if (!parsed || parsed.status !== 'ok') return { status: 'insufficient' };
  const title = String(parsed.title || '').replace(/\s+/g, ' ').trim();
  const hanCount = (title.match(/[\u3400-\u9fff]/g) || []).length;
  if (!title || title.length > 30 || /[!?\r\n]/.test(title) || (hanCount && (hanCount < 8 || hanCount > 18))) {
    return { status: 'insufficient' };
  }
  return { status: 'ok', title };
}

async function suggestTitle(context, options) {
  const system = [
    'You are a senior Chinese-language editor. Produce exactly one title for an article.',
    'The title must be accurate, natural, and measured: clear at a glance, neither casual nor stiff.',
    'Normally use 8 to 14 Chinese characters. It may be slightly longer only when needed for a complete expression.',
    'Do not use clickbait, marketing hype, internet slang, or exclamation marks. Never invent facts not present in the excerpt.',
    'Do not use academic or template phrasing such as shallow discussion, research, analysis, exploration, or thoughts on.',
    'Match the genre: technical writing should be precise; narrative writing may use fitting imagery without becoming ornate.',
    'Return strict JSON only: {"status":"ok","title":"..."} when reliable, otherwise {"status":"insufficient"}. No Markdown, code fences, or commentary.'
  ].join('\n');
  const raw = await chat([
    { role: 'system', content: system },
    { role: 'user', content: 'Article excerpt. Base the title only on this text:\n' + String(context || '') }
  ], {
    temperature: 0.35,
    maxTokens: Number(process.env.AI_TITLE_MAX_TOKENS || 128),
    timeoutMs: Number(process.env.AI_TITLE_TIMEOUT_MS || 60000),
    thinking: 'disabled',
    responseFormat: { type: 'json_object' },
    signal: options && options.signal
  });
  return parseAutoTitleResult(raw);
}

module.exports = { configured, chat, layoutHtml, rewriteSelection, suggestTitle, PENMARK_KNOWLEDGE, parseProviderJson };
