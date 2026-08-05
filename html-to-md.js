// HTML → Markdown 转换器（服务端，导出用）
// 用 linkedom 提供 DOM，递归遍历编辑器生成的受控 HTML。
// 设计目标：覆盖编辑器白名单标签（h1-h6/p/strong/em/s/u/code/pre/a/img/ul/ol/li/blockquote/table/hr/br/todo-item），
// 不追求通用性，只处理产品编辑器能产出的结构。
const { parseHTML } = require('linkedom');

function htmlToMarkdown(html) {
  const { document } = parseHTML('<div id="__root">' + String(html || '') + '</div>');
  const root = document.getElementById('__root');
  const md = blockChildrenToMd(root);
  // 折叠多余空行，首尾去空白
  return md.replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '');
}

// 块级容器：遍历子节点拼接
function blockChildrenToMd(node) {
  let out = '';
  for (const child of node.childNodes) out += nodeToMd(child);
  return out;
}

// 行内容器：遍历子节点拼接（不额外加换行）
function inlineChildrenToMd(node) {
  let out = '';
  for (const child of node.childNodes) out += nodeToMd(child);
  return out;
}

function nodeToMd(node) {
  if (!node) return '';
  if (node.nodeType === 3) return node.textContent; // 文本节点
  if (node.nodeType === 8) return ''; // 注释
  if (node.nodeType !== 1) return ''; // 只处理元素

  const tag = node.tagName.toLowerCase();
  const cls = (node.getAttribute && node.getAttribute('class')) || '';

  // ---------- 行内元素 ----------
  if (tag === 'strong' || tag === 'b') {
    const t = inlineChildrenToMd(node).trim();
    return t ? '**' + t + '**' : '';
  }
  if (tag === 'em' || tag === 'i') {
    const t = inlineChildrenToMd(node).trim();
    return t ? '*' + t + '*' : '';
  }
  if (tag === 's' || tag === 'strike' || tag === 'del') {
    const t = inlineChildrenToMd(node).trim();
    return t ? '~~' + t + '~~' : '';
  }
  if (tag === 'u') return inlineChildrenToMd(node); // MD 无下划线语法
  if (tag === 'code') return '`' + node.textContent + '`';
  if (tag === 'a') {
    const href = node.getAttribute('href') || '';
    const text = inlineChildrenToMd(node).trim() || href;
    if (!href || href === '#') return text;
    return '[' + text + '](' + href + ')';
  }
  if (tag === 'img') {
    const src = node.getAttribute('src') || '';
    const alt = node.getAttribute('alt') || '';
    if (!src) return '';
    return '![' + alt + '](' + src + ')';
  }
  if (tag === 'br') return '\n';
  if (['span', 'font', 'sub', 'sup', 'mark', 'small', 'abbr', 'cite', 'q', 'time'].includes(tag)) {
    return inlineChildrenToMd(node);
  }

  // ---------- 待办事项 ----------
  // 编辑器结构：.todo-item.done > .todo-check.checked + .todo-text
  if (cls.includes('todo-item')) {
    const isChecked = cls.includes('done') ||
      (node.querySelector && node.querySelector('.todo-check.checked'));
    // 取 todo-text 内容，没有则取整段文本
    let textNode = node.querySelector && node.querySelector('.todo-text');
    let text;
    if (textNode) {
      text = inlineChildrenToMd(textNode).trim();
    } else {
      // 去掉 check 部分，取剩余文本
      text = inlineChildrenToMd(node).trim();
    }
    return '\n- [' + (isChecked ? 'x' : ' ') + '] ' + text + '\n';
  }

  // ---------- 标题 ----------
  if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) {
    const level = Number(tag[1]);
    const text = inlineChildrenToMd(node).replace(/\s+/g, ' ').trim();
    return '\n\n' + '#'.repeat(level) + ' ' + text + '\n\n';
  }

  // ---------- 段落 ----------
  if (tag === 'p') {
    const text = inlineChildrenToMd(node).trim();
    return text ? '\n\n' + text + '\n\n' : '';
  }

  // ---------- 引用 ----------
  if (tag === 'blockquote') {
    const inner = blockChildrenToMd(node).trim();
    if (!inner) return '';
    return '\n\n' + inner.split('\n').map(l => '> ' + l).join('\n') + '\n\n';
  }

  // ---------- 代码块 ----------
  if (tag === 'pre') {
    const codeEl = node.querySelector('code');
    const code = codeEl ? codeEl.textContent : node.textContent;
    // 去掉首尾换行，保留内部缩进
    const cleaned = code.replace(/^\n+|\n+$/g, '');
    return '\n\n```\n' + cleaned + '\n```\n\n';
  }

  // ---------- 列表 ----------
  if (tag === 'ul' || tag === 'ol') {
    return '\n\n' + listToMd(node, tag === 'ol') + '\n\n';
  }

  // ---------- 表格 ----------
  if (tag === 'table') return '\n\n' + tableToMd(node) + '\n\n';

  // ---------- 分割线 ----------
  if (tag === 'hr') return '\n\n---\n\n';

  // ---------- 块级容器（div/section 等）----------
  return blockChildrenToMd(node);
}

function listToMd(node, ordered) {
  let out = '';
  let i = 1;
  for (const child of node.childNodes) {
    if (child.nodeType !== 1) continue;
    const t = child.tagName.toLowerCase();
    if (t === 'li') {
      const prefix = ordered ? (i + '. ') : '- ';
      const content = blockChildrenToMd(child).trim();
      // 嵌套列表缩进：子列表行前加 2 空格
      const indented = content.replace(/\n/g, '\n  ');
      out += prefix + indented + '\n';
      i++;
    } else if (t === 'ul' || t === 'ol') {
      // 直接子级列表（非 li 包裹）— 缩进续接
      out += listToMd(child, t === 'ol').replace(/^/gm, '  ') + '\n';
    }
  }
  return out.replace(/\n$/, '');
}

function tableToMd(node) {
  const rows = node.querySelectorAll('tr');
  if (!rows.length) return '';
  let out = '';
  let headerDone = false;
  let colCount = 0;
  for (const row of rows) {
    const cells = row.querySelectorAll('th, td');
    if (!cells.length) continue;
    colCount = Math.max(colCount, cells.length);
    const cellTexts = Array.from(cells).map(c => inlineChildrenToMd(c).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|'));
    out += '| ' + cellTexts.join(' | ') + ' |\n';
    if (!headerDone) {
      out += '| ' + Array(colCount).fill('---').join(' | ') + ' |\n';
      headerDone = true;
    }
  }
  return out.trim();
}

module.exports = { htmlToMarkdown };
