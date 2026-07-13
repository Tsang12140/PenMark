// 知著 PenMark 导出端到端集成测试
// 运行：node desktop/test-export-integration.cjs
// 覆盖：创建测试数据库 → 插入测试数据 → 导出 → 验证文件结构和内容
const fs = require('fs');
const path = require('path');
const os = require('os');

// 使用专用测试数据目录
const testDir = path.join(os.tmpdir(), 'penmark-export-test-' + Date.now());
fs.mkdirSync(testDir, { recursive: true });
process.env.PENMARK_DATA_DIR = testDir;
process.env.PENMARK_DESKTOP = '1';

let pass = 0;
let fail = 0;

function check(name, cond, detail) {
  if (cond) { pass++; }
  else {
    fail++;
    console.error(`✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}


function listRelativeFiles(root) {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(path.relative(root, full).replace(/\\/g, '/'));
    }
  }
  walk(root);
  return files.sort();
}
async function main() {
  // 初始化数据库和认证
  const db = require('../db');
  require('../auth');

  // 获取桌面用户 ID
  const user = db.prepare('SELECT id FROM users WHERE username = ?').get('desktop');
  check('桌面用户已创建', !!user);

  // 创建测试文件夹
  const folderInfo = db.prepare(
    'INSERT INTO folders (name, parent_id, user_id, sort_order, created_at) VALUES (?, NULL, ?, 0, ?)'
  ).run('读书笔记', user.id, Date.now());
  const folderId = folderInfo.lastInsertRowid;

  // 创建测试文档
  const now = Date.now();
  const docs = [
    {
      title: '百年孤独摘抄',
      content: '<h1>百年孤独</h1><p>多年以后，奥雷里亚诺·布恩迪亚上校面对行刑队，将会回想起父亲带他去见识冰块的那个遥远的下午。</p><blockquote>世界太新，很多东西还没有名字，必须用手指去指。</blockquote>',
      folder_id: folderId
    },
    {
      title: '被讨厌的勇气',
      content: '<h2>第二章</h2><p>所有的烦恼都来自<strong>人际关系</strong>。</p><ul><li>课题分离</li><li>目的论</li></ul><p>代码示例：</p><pre><code>console.log("hello");</code></pre>',
      folder_id: folderId
    },
    {
      title: '未分类文档',
      content: '<p>这是一篇没有文件夹的文档。</p><a href="https://example.com">示例链接</a><hr><p>分隔线之后</p>',
      folder_id: null
    },
    {
      title: '含非法字符: 文件*名?',
      content: '<p>测试 Windows 非法字符文件名。</p>',
      folder_id: null
    },
    {
      title: '带图片的文档',
      content: '<p>图片如下：</p><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC" alt="测试图"><p>结束。</p>',
      folder_id: null
    }
  ];

  const insertDoc = db.prepare(
    'INSERT INTO documents (title, content, folder_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const docIds = [];
  for (const d of docs) {
    const info = insertDoc.run(d.title, d.content, d.folder_id, user.id, now, now);
    docIds.push(info.lastInsertRowid);
  }
  check('5 篇测试文档已创建', docIds.length === 5, `创建了 ${docIds.length} 篇`);

  // 调用导出
  const { exportLibrary } = require('./exporter.cjs');
  const exportDir = path.join(testDir, 'exported');
  fs.mkdirSync(exportDir, { recursive: true });

  const stats = exportLibrary(exportDir, user.id);
  check('导出成功数 = 5', stats.exported === 5, `exported=${stats.exported}`);
  check('导出失败数 = 0', stats.failed === 0, `failed=${stats.failed}`);
  check('总数 = 5', stats.total === 5, `total=${stats.total}`);

  // 验证文件夹结构
  const entries = fs.readdirSync(exportDir);
  check('导出目录含读书笔记文件夹', entries.includes('读书笔记'), `entries: ${entries.join(', ')}`);
  check('导出目录含 .penmark 目录', entries.includes('.penmark'), `entries: ${entries.join(', ')}`);
  check('导出目录含 README.md', entries.includes('README.md'), `entries: ${entries.join(', ')}`);
  check('导出目录含 manifest.json（在 .penmark 内）', fs.existsSync(path.join(exportDir, '.penmark', 'manifest.json')));

  // 验证读书笔记文件夹内的文档
  const folderEntries = fs.readdirSync(path.join(exportDir, '读书笔记'));
  check('读书笔记文件夹有 2 篇文档', folderEntries.length === 2, `files: ${folderEntries.join(', ')}`);
  check('百年孤独文件名正确', folderEntries.some(f => f.startsWith('百年孤独摘抄--') && f.endsWith('.md')));
  check('被讨厌的勇气文件名正确', folderEntries.some(f => f.startsWith('被讨厌的勇气--') && f.endsWith('.md')));

  // 验证根目录的未分类文档
  const rootMdFiles = entries.filter(f => f.endsWith('.md') && f !== 'README.md');
  check('根目录有 3 篇未分类文档', rootMdFiles.length === 3, `files: ${rootMdFiles.join(', ')}`);

  // 验证非法字符文件名已清理
  const cleanedFile = rootMdFiles.find(f => f.includes('含非法字符'));
  check('非法字符文件名已清理', !!cleanedFile && !cleanedFile.includes(':') && !cleanedFile.includes('*') && !cleanedFile.includes('?'),
    `file: ${cleanedFile}`);

  // 验证 Frontmatter
  const firstDocPath = path.join(exportDir, '读书笔记', folderEntries[0]);
  const firstDocContent = fs.readFileSync(firstDocPath, 'utf8');
  check('文档含 Frontmatter 起始', firstDocContent.startsWith('---'));
  check('Frontmatter 含 id 字段', firstDocContent.includes('id: pm_'));
  check('Frontmatter 含 title 字段', firstDocContent.includes('title:'));
  check('Frontmatter 含 created 字段', firstDocContent.includes('created:'));
  check('Frontmatter 含 updated 字段', firstDocContent.includes('updated:'));
  check('Frontmatter 含 format 字段', firstDocContent.includes('format: penmark-markdown'));

  // 验证 Markdown 内容
  const doc2Path = path.join(exportDir, '读书笔记', folderEntries.find(f => f.startsWith('被讨厌的勇气')));
  const doc2Content = fs.readFileSync(doc2Path, 'utf8');
  check('Markdown 含 H2', doc2Content.includes('## 第二章'));
  check('Markdown 含粗体', doc2Content.includes('**人际关系**'));
  check('Markdown 含无序列表', doc2Content.includes('- 课题分离'));
  check('Markdown 含代码块', doc2Content.includes('```'));

  // 验证图片导出
  const imgDocPath = rootMdFiles.find(f => f.includes('带图片'));
  if (imgDocPath) {
    const imgDocContent = fs.readFileSync(path.join(exportDir, imgDocPath), 'utf8');
    check('图片文档含相对路径引用', imgDocContent.includes('.penmark/assets/'));
    const assetsDir = path.join(exportDir, '.penmark', 'assets');
    const assetFiles = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : [];
    check('assets 目录有图片文件', assetFiles.length > 0, `files: ${assetFiles.join(', ')}`);
  } else {
    fail++;
    console.error('✗ 未找到带图片的文档');
  }

  // 验证 manifest.json
  const manifest = JSON.parse(fs.readFileSync(path.join(exportDir, '.penmark', 'manifest.json'), 'utf8'));
  check('manifest 含 exportedAt', !!manifest.exportedAt);
  check('manifest 含 stats', !!manifest.stats);
  check('manifest stats.totalDocuments = 5', manifest.stats.totalDocuments === 5);
  check('manifest stats.exported = 5', manifest.stats.exported === 5);

  // 验证原文档未被修改
  const originalDoc = db.prepare('SELECT title, content FROM documents WHERE id = ?').get(docIds[0]);
  check('原文档标题未被修改', originalDoc.title === '百年孤独摘抄');
  check('原文档内容未被修改', originalDoc.content === docs[0].content);
  // 重复导出必须覆盖同一批稳定文件，不能制造随机副本。
  const beforeSecondExport = listRelativeFiles(exportDir);
  const secondStats = exportLibrary(exportDir, user.id);
  const afterSecondExport = listRelativeFiles(exportDir);
  check('重复导出仍成功', secondStats.exported === 5 && secondStats.failed === 0);
  check('重复导出文件集合稳定', JSON.stringify(afterSecondExport) === JSON.stringify(beforeSecondExport),
    `before=${beforeSecondExport.join(',')} after=${afterSecondExport.join(',')}`);

  // 每篇文档都有原始 HTML 无损副本。
  const sourceHtmlDir = path.join(exportDir, '.penmark', 'source-html');
  const sourceFiles = fs.readdirSync(sourceHtmlDir).filter(f => f.endsWith('.html'));
  check('原始 HTML 副本数量 = 5', sourceFiles.length === 5, `files=${sourceFiles.join(',')}`);
  const firstSource = fs.readFileSync(path.join(sourceHtmlDir, `pm_${docIds[0]}.html`), 'utf8');
  check('原始 HTML 副本完全一致', firstSource === docs[0].content);

  // 清理
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch (_) {}

  console.log(`\n========== 集成测试结果 ==========`);
  console.log(`通过: ${pass}`);
  console.log(`失败: ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('测试异常:', err);
  process.exit(1);
});
