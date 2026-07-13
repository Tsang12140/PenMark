// 知著 PenMark 资料库导出 — 将 SQLite 中的文档导出为 Markdown 文件夹
// 规则：
// - 文件夹结构对应 PenMark 文件夹
// - 每篇文档导出为 .md 文件，包含 Frontmatter
// - 图片导出到 .penmark/assets/，Markdown 用相对路径引用
// - 链接卡片降级为普通链接
// - Markdown 负责通用可读，source-html 保存完全一致的原始 HTML
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 懒加载 db，避免纯函数测试时初始化数据库
let _db = null;
function getDb() {
  if (!_db) _db = require('../db');
  return _db;
}

/* ---------- 工具函数 ---------- */

// Windows 文件名非法字符过滤
function sanitizeFilename(name) {
  let value = String(name || '无标题')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\x00-\x1f]/g, '')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 100) || '无标题';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) value = '_' + value;
  return value;
}

function stableDocId(id) {
  const value = String(id == null ? '' : id).replace(/[^A-Za-z0-9_-]/g, '_');
  if (!value) throw new Error('文档缺少稳定 ID');
  return 'pm_' + value;
}

// 生成 6 位短 ID
function shortId() {
  return crypto.randomBytes(3).toString('hex');
}

// ISO 时间格式
function isoTime(ts) {
  if (!ts) return new Date().toISOString();
  return new Date(ts).toISOString();
}

/* ---------- HTML 转 Markdown ---------- */

function htmlToMarkdown(html, assetsDir, docId) {
  if (!html) return '';
  // 用正则做基础清理，不引入 cheerio/jsdom
  let md = html;

  // 移除编辑器临时元素：浮动菜单、缩放控点、尺寸标签、拖拽状态
  md = md.replace(/<div class="(?:float-menu|img-resizer|resize-handle|drag-overlay|ctx-menu)[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '');
  md = md.replace(/<span class="(?:size-label|drag-handle)[^"]*"[^>]*>[\s\S]*?<\/span>/gi, '');

  // 处理图片（base64 → 文件）
  let imgIndex = 0;
  md = md.replace(/<img[^>]*src="([^"]*)"[^>]*>/gi, (match, src) => {
    imgIndex++;
    const result = processImage(src, assetsDir, docId, imgIndex);
    // 获取 alt 文字
    const altMatch = match.match(/alt="([^"]*)"/i);
    const alt = altMatch ? altMatch[1] : '';
    // 获取宽度
    const widthMatch = match.match(/width="([^"]*)"/i) || match.match(/style="[^"]*width:\s*(\d+)px[^"]*"/i);
    if (widthMatch && result.path) {
      return `<img src="${result.path}" alt="${alt}" width="${widthMatch[1]}">`;
    }
    return `![${alt}](${result.path || src})`;
  });

  // 链接卡片 → 普通链接
  md = md.replace(/<a[^>]*class="link-card"[^>]*href="([^"]*)"[^>]*>[\s\S]*?<\/a>/gi, (match, href) => {
    // 尝试提取标题
    const titleMatch = match.match(/<span[^>]*class="lc-title"[^>]*>([\s\S]*?)<\/span>/i);
    const title = titleMatch ? titleMatch[1].trim() : href;
    return `[${title}](${href})`;
  });

  // 标题 h1-h6
  for (let i = 6; i >= 1; i--) {
    const re = new RegExp(`<h${i}[^>]*>([\\s\\S]*?)</h${i}>`, 'gi');
    md = md.replace(re, (_, content) => '\n' + '#'.repeat(i) + ' ' + cleanText(content) + '\n');
  }

  // 代码块
  md = md.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_, code) => '\n```\n' + decodeHtml(code) + '\n```\n');
  // 行内代码
  md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, code) => '`' + decodeHtml(code) + '`');

  // 引用
  md = md.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, content) => {
    const lines = cleanText(content).split('\n').map(l => '> ' + l);
    return '\n' + lines.join('\n') + '\n';
  });

  // 无序列表
  md = md.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_, content) => {
    const items = content.match(/<li[^>]*>([\s\S]*?)<\/li>/gi) || [];
    const lines = items.map(item => '- ' + cleanText(item.replace(/<\/?li[^>]*>/gi, '')));
    return '\n' + lines.join('\n') + '\n';
  });

  // 有序列表
  md = md.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, content) => {
    const items = content.match(/<li[^>]*>([\s\S]*?)<\/li>/gi) || [];
    const lines = items.map((item, i) => (i + 1) + '. ' + cleanText(item.replace(/<\/?li[^>]*>/gi, '')));
    return '\n' + lines.join('\n') + '\n';
  });

  // 表格（简单转换）
  md = md.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, content) => {
    const rows = content.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
    if (!rows.length) return '';
    const tableData = rows.map(row => {
      const cells = row.match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi) || [];
      return cells.map(c => cleanText(c.replace(/<\/?t[dh][^>]*>/gi, '')));
    });
    if (!tableData[0] || !tableData[0].length) return '';
    const header = tableData[0];
    const separator = header.map(() => '---');
    let table = '| ' + header.join(' | ') + ' |\n';
    table += '| ' + separator.join(' | ') + ' |\n';
    for (let i = 1; i < tableData.length; i++) {
      if (tableData[i] && tableData[i].length) {
        table += '| ' + tableData[i].join(' | ') + ' |\n';
      }
    }
    return '\n' + table + '\n';
  });

  // 分割线
  md = md.replace(/<hr[^>]*>/gi, '\n---\n');

  // 粗体
  md = md.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
  // 斜体
  md = md.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');
  // 删除线
  md = md.replace(/<(del|s)[^>]*>([\s\S]*?)<\/\1>/gi, '~~$2~~');
  // 下划线（Markdown 无原生支持，保留 HTML）
  md = md.replace(/<u[^>]*>([\s\S]*?)<\/u>/gi, '<u>$1</u>');

  // 普通链接
  md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => `[${cleanText(text)}](${href})`);

  // 段落和换行
  md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n');
  md = md.replace(/<br\s*\/?>/gi, '\n');
  md = md.replace(/<div[^>]*>([\s\S]*?)<\/div>/gi, '$1\n');

  // 移除剩余 HTML 标签但保留内容
  md = md.replace(/<span[^>]*>/gi, '');
  md = md.replace(/<\/span>/gi, '');

  // 解码 HTML 实体
  md = decodeHtml(md);

  // 清理多余空行
  md = md.replace(/\n{3,}/g, '\n\n\n');
  md = md.trim() + '\n';

  return md;
}

function cleanText(html) {
  return decodeHtml(String(html)
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' '))
    .trim();
}

function decodeHtml(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/* ---------- 图片处理 ---------- */

function processImage(src, assetsDir, docId, index) {
  if (!src) return { path: '' };
  // base64 图片
  const dataMatch = src.match(/^data:image\/(\w+);base64,(.+)$/i);
  if (dataMatch) {
    const ext = dataMatch[1].toLowerCase().replace('jpeg', 'jpg');
    const buf = Buffer.from(dataMatch[2], 'base64');
    const filename = `${docId}_${index}.${ext}`;
    const filepath = path.join(assetsDir, filename);
    try {
      fs.writeFileSync(filepath, buf);
      return { path: `.penmark/assets/${filename}` };
    } catch (e) {
      return { path: src };
    }
  }
  // 外部 URL 图片，保持原链接
  if (/^https?:\/\//i.test(src)) {
    return { path: src };
  }
  return { path: src };
}

/* ---------- 主导出逻辑 ---------- */

function exportLibrary(targetDir, userId) {
  const db = getDb();
  if (!userId) {
    const user = db.prepare('SELECT id FROM users WHERE username = ?').get('desktop');
    userId = user ? user.id : 1;
  }

  // 获取所有文件夹
  const folders = db.prepare('SELECT id, name, sort_order FROM folders WHERE user_id = ? ORDER BY sort_order, id').all(userId);
  // 获取所有未删除文档
  const docs = db.prepare('SELECT id, title, content, folder_id, created_at, updated_at FROM documents WHERE user_id = ? AND deleted_at IS NULL ORDER BY folder_id, updated_at DESC').all(userId);

  // 创建目录结构
  const assetsDir = path.join(targetDir, '.penmark', 'assets');
  const sourceHtmlDir = path.join(targetDir, '.penmark', 'source-html');
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.mkdirSync(sourceHtmlDir, { recursive: true });

  // 文件夹映射：folder_id → 目录路径
  const folderPaths = new Map();
  folderPaths.set(null, targetDir); // 未分类 → 根目录
  const usedFolderNames = new Set();
  for (const f of folders) {
    let dirName = sanitizeFilename(f.name);
    const folded = dirName.toLocaleLowerCase();
    if (usedFolderNames.has(folded)) dirName += '--folder-' + f.id;
    usedFolderNames.add(dirName.toLocaleLowerCase());
    const finalPath = path.join(targetDir, dirName);
    fs.mkdirSync(finalPath, { recursive: true });
    folderPaths.set(f.id, finalPath);
  }

  // 导出每篇文档
  const usedNames = new Set();
  let exported = 0;
  let failed = 0;
  const errors = [];

  for (const doc of docs) {
    try {
      const dir = folderPaths.get(doc.folder_id) || targetDir;
      const baseName = sanitizeFilename(doc.title);
      const sid = stableDocId(doc.id);
      // 文档数据库 ID 是稳定身份；重复导出会覆盖同一份导出文件，而不是制造副本。
      const filename = `${baseName}--${sid}.md`;
      const filepath = path.join(dir, filename);

      // Markdown 负责通用可读；原始 HTML 单独保存，保证复杂图文可以无损恢复。
      let markdown = htmlToMarkdown(doc.content || '', assetsDir, doc.id);
      if (dir !== targetDir) {
        markdown = markdown
          .replace(/\]\(\.penmark\/assets\//g, '](../.penmark/assets/')
          .replace(/src="\.penmark\/assets\//g, 'src="../.penmark/assets/');
      }
      const sourceHtmlName = `${sid}.html`;
      fs.writeFileSync(path.join(sourceHtmlDir, sourceHtmlName), doc.content || '', 'utf8');

      // 构建 Frontmatter
      const frontmatter = [
        '---',
        `id: ${sid}`,
        `title: ${escapeYaml(doc.title || '无标题')}`,
        `created: ${isoTime(doc.created_at)}`,
        `updated: ${isoTime(doc.updated_at)}`,
        `format: penmark-markdown`,
        `source_html: .penmark/source-html/${sid}.html`,
        '---',
        ''
      ].join('\n');

      const fullContent = frontmatter + markdown;
      fs.writeFileSync(filepath, fullContent, 'utf8');
      usedNames.add(filepath);
      exported++;
    } catch (e) {
      failed++;
      errors.push({ title: doc.title, error: e.message });
    }
  }

  // 写入 manifest.json
  const manifest = {
    exportedAt: new Date().toISOString(),
    format: 'penmark-markdown',
    version: '1.0',
    stats: {
      totalDocuments: docs.length,
      exported: exported,
      failed: failed,
      folders: folders.length
    },
    folders: folders.map(f => ({ id: f.id, name: f.name })),
    errors: errors
  };
  fs.writeFileSync(path.join(targetDir, '.penmark', 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  // 写入 README.md
  const readme = `# PenMark 资料库导出

导出时间：${manifest.exportedAt}
文档总数：${exported}（成功）/ ${failed}（失败）
文件夹数：${folders.length}

## 说明

- 每篇文档导出为 Markdown 文件，文件名格式：标题--稳定文档ID.md
- 图片保存在 .penmark/assets/ 目录
- 无损原始 HTML 保存在 .penmark/source-html/ 目录
- Frontmatter 包含文档 ID、标题、创建/更新时间
- 链接卡片已降级为普通链接
- Markdown 负责通用可读，source-html 保存完全一致的原始 HTML

## 数据结构

\`\`\`
${path.basename(targetDir)}/
├─ 文件夹名/
│  └─ 文档标题--稳定文档ID.md
├─ 未分类文档--稳定文档ID.md
├─ .penmark/
│  ├─ assets/
│  ├─ source-html/
│  └─ manifest.json
└─ README.md
\`\`\`
`;
  fs.writeFileSync(path.join(targetDir, 'README.md'), readme, 'utf8');

  return { exported, failed, total: docs.length, errors };
}

function escapeYaml(s) {
  return JSON.stringify(String(s));
}

module.exports = { exportLibrary, sanitizeFilename, stableDocId, shortId, htmlToMarkdown };
