const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { inspectLegacyDatabase, importLegacyDatabase } = require('./importer.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'penmark-import-test-'));
const sourcePath = path.join(root, 'old.db');
const targetPath = path.join(root, 'new.db');
let passed = 0;
function check(name, value) {
  if (!value) throw new Error('失败：' + name);
  passed++;
}

try {
  const source = new Database(sourcePath);
  source.exec(`
    CREATE TABLE folders (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY, title TEXT, content TEXT, folder_id INTEGER,
      created_at INTEGER, updated_at INTEGER, deleted_at INTEGER
    );
  `);
  source.prepare('INSERT INTO folders (id,name) VALUES (?,?)').run(10, '读书');
  source.prepare('INSERT INTO documents VALUES (?,?,?,?,?,?,NULL)').run(1, '摘抄', '<p>原文</p>', 10, 100, 200);
  source.prepare('INSERT INTO documents VALUES (?,?,?,?,?,?,NULL)').run(2, '梦境', '<p>梦</p>', null, 101, 201);
  source.prepare('INSERT INTO documents VALUES (?,?,?,?,?,?,?)').run(3, '已删除', '<p>x</p>', null, 1, 1, 999);
  source.close();

  const target = new Database(targetPath);
  target.exec(`
    CREATE TABLE folders (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, parent_id INTEGER, user_id INTEGER, sort_order INTEGER, created_at INTEGER);
    CREATE TABLE documents (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, content TEXT, folder_id INTEGER, user_id INTEGER, created_at INTEGER, updated_at INTEGER);
  `);
  target.prepare('INSERT INTO folders (name,parent_id,user_id,sort_order,created_at) VALUES (?,NULL,1,0,0)').run('现有文件夹');
  target.prepare('INSERT INTO documents (title,content,folder_id,user_id,created_at,updated_at) VALUES (?,?,NULL,1,0,0)').run('现有文档','<p>不能覆盖</p>');

  const info = inspectLegacyDatabase(sourcePath, targetPath);
  check('只统计未删除文档', info.documents === 2);
  check('统计旧文件夹', info.folders === 1);
  let selfRejected = false;
  try { inspectLegacyDatabase(targetPath, targetPath); } catch (_) { selfRejected = true; }
  check('拒绝导入当前数据库自身', selfRejected);

  const stats = importLegacyDatabase(sourcePath, target, 1);
  check('导入两篇文档', stats.importedDocuments === 2);
  check('为旧文件夹和未分类各建一个隔离文件夹', stats.importedFolders === 2);
  check('原有文档仍存在', !!target.prepare('SELECT 1 FROM documents WHERE title=? AND content=?').get('现有文档','<p>不能覆盖</p>'));
  check('旧文档正文完整', !!target.prepare('SELECT 1 FROM documents WHERE title=? AND content=?').get('摘抄','<p>原文</p>'));
  check('未导入软删除文档', !target.prepare('SELECT 1 FROM documents WHERE title=?').get('已删除'));
  check('所有导入文档属于目标用户', target.prepare("SELECT COUNT(*) n FROM documents WHERE title IN ('摘抄','梦境') AND user_id=1").get().n === 2);
  target.close();
  console.log(`\n========== 旧版导入测试结果 ==========\n通过: ${passed}\n失败: 0`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}