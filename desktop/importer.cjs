// PenMark 旧版数据库安全导入：只新增数据，不覆盖现有文档。
const path = require('path');
const Database = require('better-sqlite3');

function hasTable(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function columnsOf(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
}

function inspectLegacyDatabase(sourcePath, currentDbPath) {
  if (!sourcePath) throw new Error('未选择数据库');
  if (currentDbPath && path.resolve(sourcePath).toLowerCase() === path.resolve(currentDbPath).toLowerCase()) {
    throw new Error('不能导入当前正在使用的数据库');
  }
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    if (!hasTable(source, 'documents')) throw new Error('所选文件不是 PenMark 数据库：缺少 documents 表');
    const docCols = columnsOf(source, 'documents');
    if (!docCols.has('title') || !docCols.has('content')) throw new Error('旧数据库文档结构不兼容');
    const deletedWhere = docCols.has('deleted_at') ? ' WHERE deleted_at IS NULL' : '';
    const documents = source.prepare('SELECT COUNT(*) AS n FROM documents' + deletedWhere).get().n;
    const folders = hasTable(source, 'folders') ? source.prepare('SELECT COUNT(*) AS n FROM folders').get().n : 0;
    return { documents, folders };
  } finally {
    source.close();
  }
}

function importLegacyDatabase(sourcePath, targetDb, targetUserId) {
  if (!targetDb || !targetUserId) throw new Error('目标数据库或本地用户无效');
  const currentPath = targetDb.name;
  const summary = inspectLegacyDatabase(sourcePath, currentPath);
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    const docCols = columnsOf(source, 'documents');
    const folderCols = hasTable(source, 'folders') ? columnsOf(source, 'folders') : new Set();
    const docSelect = [
      'id', 'title', 'content',
      docCols.has('folder_id') ? 'folder_id' : 'NULL AS folder_id',
      docCols.has('created_at') ? 'created_at' : '0 AS created_at',
      docCols.has('updated_at') ? 'updated_at' : '0 AS updated_at'
    ].join(', ');
    const deletedWhere = docCols.has('deleted_at') ? ' WHERE deleted_at IS NULL' : '';
    const docs = source.prepare(`SELECT ${docSelect} FROM documents${deletedWhere} ORDER BY id`).all();
    const folders = folderCols.has('id') && folderCols.has('name')
      ? source.prepare('SELECT id, name FROM folders ORDER BY id').all()
      : [];

    const now = Date.now();
    const stamp = new Date(now).toLocaleString('zh-CN', { hour12: false }).replace(/[/:]/g, '-');
    const existingNames = new Set(targetDb.prepare('SELECT name FROM folders WHERE user_id = ?').all(targetUserId)
      .map(r => String(r.name).toLocaleLowerCase()));
    const uniqueName = base => {
      let name = String(base || '旧版导入').slice(0, 40);
      let i = 2;
      while (existingNames.has(name.toLocaleLowerCase())) {
        const suffix = ` (${i++})`;
        name = String(base || '旧版导入').slice(0, 40 - suffix.length) + suffix;
      }
      existingNames.add(name.toLocaleLowerCase());
      return name;
    };

    const insertFolder = targetDb.prepare(
      'INSERT INTO folders (name, parent_id, user_id, sort_order, created_at) VALUES (?, NULL, ?, ?, ?)'
    );
    const insertDoc = targetDb.prepare(
      'INSERT INTO documents (title, content, folder_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    );

    const run = targetDb.transaction(() => {
      const folderMap = new Map();
      let sortOrder = targetDb.prepare('SELECT COALESCE(MAX(sort_order), 0) AS n FROM folders WHERE user_id = ?').get(targetUserId).n + 1;
      for (const folder of folders) {
        const name = uniqueName(`${folder.name || '未命名文件夹'}（旧版导入）`);
        const info = insertFolder.run(name, targetUserId, sortOrder++, now);
        folderMap.set(String(folder.id), info.lastInsertRowid);
      }
      let unfiledFolderId = null;
      if (docs.some(d => d.folder_id == null || !folderMap.has(String(d.folder_id)))) {
        const info = insertFolder.run(uniqueName(`旧版导入 ${stamp}`), targetUserId, sortOrder++, now);
        unfiledFolderId = info.lastInsertRowid;
      }
      for (const doc of docs) {
        const folderId = folderMap.get(String(doc.folder_id)) || unfiledFolderId;
        insertDoc.run(
          doc.title || '无标题', doc.content || '', folderId, targetUserId,
          Number(doc.created_at) || now, Number(doc.updated_at) || now
        );
      }
      return { importedDocuments: docs.length, importedFolders: folderMap.size + (unfiledFolderId ? 1 : 0) };
    });
    return Object.assign(summary, run());
  } finally {
    source.close();
  }
}

module.exports = { inspectLegacyDatabase, importLegacyDatabase };