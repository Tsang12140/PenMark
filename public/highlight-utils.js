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