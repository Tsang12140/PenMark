// 知著 PenMark 代码块语法高亮工具
// 依赖 window.hljs（public/vendor/highlight.min.js）。
// 只用于只读渲染场景（阅读模式 / 分享页 / 版本预览），不侵入可编辑的 contenteditable。
// highlightElement 会改写 code 的 innerHTML，因此记录原始 HTML 以便退出阅读模式时恢复。

const savedOriginals = new WeakMap();

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 按括号嵌套深度对代码块内的括号着色（模拟 VS Code bracket colorizer）
function colorizeBrackets(codeEl) {
  const stack = [];
  const colors = ['bd-1', 'bd-2', 'bd-3', 'bd-4'];
  const walker = document.createTreeWalker(codeEl, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  for (const tn of textNodes) {
    const text = tn.nodeValue;
    if (!/[()[\]{}]/.test(text)) continue;
    let html = '';
    for (const ch of text) {
      if (ch === '(' || ch === '[' || ch === '{') {
        stack.push(ch);
        html += '<span class="' + colors[(stack.length - 1) % colors.length] + '">' + ch + '</span>';
      } else if (ch === ')' || ch === ']' || ch === '}') {
        html += '<span class="' + colors[Math.max(stack.length - 1, 0) % colors.length] + '">' + ch + '</span>';
        if (stack.length) stack.pop();
      } else {
        html += escHtml(ch);
      }
    }
    const holder = document.createElement('span');
    holder.innerHTML = html;
    const frag = document.createDocumentFragment();
    while (holder.firstChild) frag.appendChild(holder.firstChild);
    tn.parentNode.replaceChild(frag, tn);
  }
}

// 对 root 内所有代码块（pre > code）做语法高亮 + 括号着色，并记录原始 HTML
export function highlightCodeBlocks(root) {
  if (!root || !window.hljs || typeof window.hljs.highlightElement !== 'function') return;
  root.querySelectorAll('pre > code').forEach((code) => {
    // 若已高亮过（阅读模式重复进入），先从原始内容重新高亮，避免嵌套 span
    if (savedOriginals.has(code)) code.innerHTML = savedOriginals.get(code);
    else savedOriginals.set(code, code.innerHTML);
    try { window.hljs.highlightElement(code); } catch (_) {}
    try { colorizeBrackets(code); } catch (_) {}
  });
}

// 恢复代码块为原始（未高亮）内容，供退出阅读模式时使用
export function restoreHighlightedCode(root) {
  if (!root) return;
  root.querySelectorAll('pre > code').forEach((code) => {
    if (savedOriginals.has(code)) {
      code.innerHTML = savedOriginals.get(code);
      savedOriginals.delete(code);
    }
  });
}

// 复制文本到剪贴板（现代 API 优先，降级 execCommand）
async function copyTextToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (_) { return false; }
}

// 复制按钮短暂变为对勾，提示已复制
function flashCopyButton(btn) {
  if (btn.dataset.flashing) return;
  btn.dataset.flashing = '1';
  const orig = btn.innerHTML;
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
  btn.classList.add('cb-copied');
  setTimeout(() => {
    btn.innerHTML = orig;
    btn.classList.remove('cb-copied');
    delete btn.dataset.flashing;
  }, 1200);
}

// 一次性挂载"点代码块外关闭工具栏"的全局监听（移动端）
let tapListenerBound = false;
function bindCodeBlockTapHide() {
  if (tapListenerBound) return;
  tapListenerBound = true;
  document.addEventListener('click', (e) => {
    if (e.target.closest('.code-block')) return;
    document.querySelectorAll('.code-block.tapped').forEach((cb) => cb.classList.remove('tapped'));
  });
}

// 给 root 内所有代码块加飞书式工具栏：左上角折叠三角、右上角复制按钮。
// 桌面悬停显示，移动端点按（.tapped）显示；折叠后 pre 隐藏，仅剩一条细条。
// 仅用于只读视图（阅读模式 / 分享页 / 版本预览），不侵入可编辑的 contenteditable。
export function enhanceCodeBlocks(root) {
  if (!root) return;
  bindCodeBlockTapHide();
  root.querySelectorAll('pre').forEach((pre) => {
    if (pre.closest('.code-block')) return; // 已包装过
    const wrap = document.createElement('div');
    wrap.className = 'code-block';
    pre.parentNode.insertBefore(wrap, pre);

    // 头部工具栏条：始终占位，上折叠下右复制，不重叠代码
    const bar = document.createElement('div');
    bar.className = 'cb-bar';

    const collapse = document.createElement('button');
    collapse.type = 'button';
    collapse.className = 'cb-collapse';
    collapse.title = '折叠代码块';
    collapse.setAttribute('aria-label', '折叠代码块');
    collapse.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'cb-copy';
    copy.title = '复制代码';
    copy.setAttribute('aria-label', '复制代码');
    copy.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';

    bar.appendChild(collapse);
    bar.appendChild(copy);
    wrap.appendChild(bar);
    wrap.appendChild(pre);

    const setCollapsed = (collapsed) => {
      wrap.classList.toggle('collapsed', collapsed);
      collapse.title = collapsed ? '展开代码块' : '折叠代码块';
      collapse.setAttribute('aria-label', collapse.title);
    };

    collapse.addEventListener('click', (e) => {
      e.stopPropagation();
      setCollapsed(!wrap.classList.contains('collapsed'));
    });

    copy.addEventListener('click', async (e) => {
      e.stopPropagation();
      const text = pre.innerText || pre.textContent || '';
      if (await copyTextToClipboard(text)) flashCopyButton(copy);
    });

    // 点按：折叠态点击黑条展开；展开态显示工具栏（移动端）；点按钮不触发展开标记
    wrap.addEventListener('click', (e) => {
      if (e.target.closest('.cb-collapse, .cb-copy')) return;
      if (wrap.classList.contains('collapsed')) setCollapsed(false);
      else wrap.classList.add('tapped');
    });
  });
}

// 还原：把 .code-block 解包回裸 <pre>，供退出只读视图 / 编辑前使用，避免结构写入文档
export function unwrapCodeBlocks(root) {
  if (!root) return;
  root.querySelectorAll('.code-block').forEach((wrap) => {
    const pre = wrap.querySelector(':scope > pre');
    if (pre) wrap.replaceWith(pre);
    else wrap.remove();
  });
}

// 清洗内容里的段落级内联底色：只作用于块级元素，去掉粘贴残留的近白/近黑背景，
// 让段落始终跟随当前主题，避免切换主题后留一块难看的浅色/深色底。
// 不触碰 inline span/mark 高亮与代码块（它们有专门样式或需保真的内联样式）。
export function stripBlockBackgrounds(root) {
  if (!root) return;
  root.querySelectorAll('p, div, li, article, section, h1, h2, h3, h4, h5, h6, blockquote, td, th').forEach((el) => {
    const s = el.style;
    if (s && s.backgroundColor) {
      s.removeProperty('background-color');
      s.removeProperty('background');
    }
    if (el.getAttribute('style') === '') el.removeAttribute('style');
  });
}