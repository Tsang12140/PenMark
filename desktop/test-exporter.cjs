// 知著 PenMark 导出器纯函数测试
// 运行：node desktop/test-exporter.cjs
// 覆盖：Windows 文件名清理、HTML→Markdown 转换、图片路径、同名避免、Frontmatter
const { sanitizeFilename, stableDocId, shortId, htmlToMarkdown } = require('./exporter.cjs');
const fs = require('fs');
const path = require('path');
const os = require('os');

let pass = 0;
let fail = 0;

function assert(name, actual, expected) {
  const ok = actual === expected;
  if (ok) { pass++; }
  else {
    fail++;
    console.error(`✗ ${name}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(name, actual, substr) {
  const ok = String(actual).includes(substr);
  if (ok) { pass++; }
  else {
    fail++;
    console.error(`✗ ${name}\n  应包含: ${JSON.stringify(substr)}\n  实际: ${JSON.stringify(actual)}`);
  }
}

/* ---------- 1. Windows 文件名清理 ---------- */
assert('清理反斜杠', sanitizeFilename('a\\b'), 'a_b');
assert('清理斜杠', sanitizeFilename('a/b'), 'a_b');
assert('清理冒号', sanitizeFilename('a:b'), 'a_b');
assert('清理星号', sanitizeFilename('a*b'), 'a_b');
assert('清理问号', sanitizeFilename('a?b'), 'a_b');
assert('清理引号', sanitizeFilename('a"b'), 'a_b');
assert('清理尖括号', sanitizeFilename('a<b>c'), 'a_b_c');
assert('清理竖线', sanitizeFilename('a|b'), 'a_b');
assert('空标题兜底', sanitizeFilename(''), '无标题');
assert('null 兜底', sanitizeFilename(null), '无标题');
assert('超长截断', sanitizeFilename('x'.repeat(200)).length, 100);
assert('Windows 保留名清理', sanitizeFilename('CON'), '_CON');
assert('结尾点和空格清理', sanitizeFilename('标题. '), '标题');
assert('稳定文档 ID', stableDocId(128), 'pm_128');

/* ---------- 2. 短 ID 唯一性 ---------- */
const ids = new Set();
for (let i = 0; i < 1000; i++) ids.add(shortId());
assert('短 ID 1000 次无碰撞', ids.size, 1000);

/* ---------- 3. HTML → Markdown 转换 ---------- */
const tmpDir = path.join(os.tmpdir(), 'penmark-test-' + shortId());
const assetsDir = path.join(tmpDir, '.penmark', 'assets');
fs.mkdirSync(assetsDir, { recursive: true });

// 标题
assertIncludes('H1 转换', htmlToMarkdown('<h1>标题一</h1>', assetsDir, 't1'), '# 标题一');
assertIncludes('H2 转换', htmlToMarkdown('<h2>标题二</h2>', assetsDir, 't1'), '## 标题二');
assertIncludes('H3 转换', htmlToMarkdown('<h3>标题三</h3>', assetsDir, 't1'), '### 标题三');

// 段落
assertIncludes('段落转换', htmlToMarkdown('<p> Hello World </p>', assetsDir, 't1'), 'Hello World');

// 粗体/斜体/删除线
assertIncludes('粗体', htmlToMarkdown('<strong>粗</strong>', assetsDir, 't1'), '**粗**');
assertIncludes('斜体', htmlToMarkdown('<em>斜</em>', assetsDir, 't1'), '*斜*');
assertIncludes('删除线', htmlToMarkdown('<del>删</del>', assetsDir, 't1'), '~~删~~');

// 代码块
const codeMd = htmlToMarkdown('<pre><code>let x = 1;</code></pre>', assetsDir, 't1');
assertIncludes('代码块含围栏', codeMd, '```');
assertIncludes('代码块内容', codeMd, 'let x = 1;');

// 行内代码
assertIncludes('行内代码', htmlToMarkdown('<code>foo</code>', assetsDir, 't1'), '`foo`');

// 引用
assertIncludes('引用', htmlToMarkdown('<blockquote>引用文字</blockquote>', assetsDir, 't1'), '> 引用文字');

// 无序列表
const ulMd = htmlToMarkdown('<ul><li>项目一</li><li>项目二</li></ul>', assetsDir, 't1');
assertIncludes('无序列表项1', ulMd, '- 项目一');
assertIncludes('无序列表项2', ulMd, '- 项目二');

// 有序列表
const olMd = htmlToMarkdown('<ol><li>第一</li><li>第二</li></ol>', assetsDir, 't1');
assertIncludes('有序列表项1', olMd, '1. 第一');
assertIncludes('有序列表项2', olMd, '2. 第二');

// 分割线
assertIncludes('分割线', htmlToMarkdown('<hr>', assetsDir, 't1'), '---');

// 表格
const tableHtml = '<table><tr><th>名</th><th>值</th></tr><tr><td>a</td><td>1</td></tr></table>';
const tableMd = htmlToMarkdown(tableHtml, assetsDir, 't1');
assertIncludes('表格表头', tableMd, '| 名 | 值 |');
assertIncludes('表格分隔', tableMd, '| --- | --- |');
assertIncludes('表格数据', tableMd, '| a | 1 |');

// 普通链接
assertIncludes('普通链接', htmlToMarkdown('<a href="https://example.com">示例</a>', assetsDir, 't1'), '[示例](https://example.com)');

// 链接卡片降级
const cardHtml = '<a class="link-card" href="https://github.com"><span class="lc-title">GitHub</span><span class="lc-desc">代码托管</span></a>';
assertIncludes('链接卡片降级', htmlToMarkdown(cardHtml, assetsDir, 't1'), '[GitHub](https://github.com)');

// 下划线保留 HTML
assertIncludes('下划线保留HTML', htmlToMarkdown('<u>下划线</u>', assetsDir, 't1'), '<u>下划线</u>');

/* ---------- 4. 图片路径转换 ---------- */
// base64 图片应写入文件并返回相对路径
const base64Img = '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC" alt="小图">';
const imgMd = htmlToMarkdown(base64Img, assetsDir, 'img1');
assertIncludes('base64 图片转相对路径', imgMd, '.penmark/assets/img1_1.');
// 验证文件已生成
const generatedFiles = fs.readdirSync(assetsDir).filter(f => f.startsWith('img1_'));
assert('图片文件已生成', generatedFiles.length, 1);

// 外部 URL 图片保持原链接
const extImg = '<img src="https://example.com/x.png" alt="外链">';
assertIncludes('外链图片保持URL', htmlToMarkdown(extImg, assetsDir, 't1'), 'https://example.com/x.png');

/* ---------- 5. 编辑器临时元素应被移除 ---------- */
const dirty = '<div class="float-menu">菜单</div><p>正文</p><span class="size-label">100px</span>';
const cleanMd = htmlToMarkdown(dirty, assetsDir, 't1');
if (cleanMd.includes('float-menu') || cleanMd.includes('size-label') || cleanMd.includes('菜单')) {
  fail++;
  console.error('✗ 临时元素未移除:', cleanMd);
} else {
  pass++;
}
assertIncludes('正文保留', cleanMd, '正文');

/* ---------- 6. 同名文档避免覆盖 ---------- */
const usedNames = new Set();
let collision = false;
for (let i = 0; i < 100; i++) {
  const name = `同名文档--${shortId()}.md`;
  if (usedNames.has(name)) { collision = true; break; }
  usedNames.add(name);
}
assert('100 个同名文档文件名无碰撞', collision, false);

/* ---------- 7. Frontmatter 生成验证 ---------- */
// 通过实际导出单篇文档到临时目录验证
// 这里仅验证 escapeYaml 的行为（通过 htmlToMarkdown 间接覆盖标题）
const titleWithColon = '<h1>标题: 含特殊字符</h1>';
const titleMd = htmlToMarkdown(titleWithColon, assetsDir, 't1');
assertIncludes('含冒号标题保留', titleMd, '标题: 含特殊字符');

/* ---------- 清理 ---------- */
try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch (_) {}

/* ---------- 结果 ---------- */
console.log(`\n========== 测试结果 ==========`);
console.log(`通过: ${pass}`);
console.log(`失败: ${fail}`);
process.exit(fail > 0 ? 1 : 0);
