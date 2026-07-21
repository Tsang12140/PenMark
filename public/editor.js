// 知著 PenMark 编辑器核心模块
// 富文本编辑、图片管理（参考简编方案：放行默认粘贴 + fixImageContainers 包装裸 img + onload 自动缩放）、
// 粘贴处理、撤销重做、Markdown快捷输入、代码块/表格/目录、导出
import {
  TABLE_MIN_COL_WIDTH,
  equalizeWidths,
  normalizePixelWidths,
  resizeColumnWidth
} from './table-utils.mjs';

export class Editor {
  constructor(opts) {
    this.editor = opts.editor;
    this.onUpdate = opts.onUpdate || function(){};
    this.onToast = opts.onToast || function(){};
    this.onPrompt = opts.onPrompt || null;
    this.onImageSelect = opts.onImageSelect || function(){};
    this.dropOverlay = opts.dropOverlay;
    this.selectedImage = null;
    this.imageClipboard = null;
    this.styleUndoStack = [];
    this.resizeState = null;
    this.imageDragPreview = null;
    this.tableResizeState = null;
    this.tableResizeLayer = null;
    this.activeTableCell = null;
    this.tableSelection = null;
    this.tableUndoStack = [];
    this.tableRedoStack = [];
    this._init();
  }

  _init() {
    this._bindPaste();
    this._bindDragDrop();
    this._bindImageDelegation();
    this._bindMarkdownShortcut();
    this._bindTodoInteraction();
    this._bindInput();
    this._bindKeydown();
    this._bindTableEditing();
  }

  /* ---------- 工具 ---------- */
  _uid() { return 'pm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  focus() { this.editor.focus(); }
  _editorContentWidth() {
    const cs = window.getComputedStyle(this.editor);
    const pl = parseFloat(cs.paddingLeft) || 0;
    const pr = parseFloat(cs.paddingRight) || 0;
    return Math.max(120, this.editor.clientWidth - pl - pr);
  }
  _imageAspect(img) {
    const nw = img && img.naturalWidth ? img.naturalWidth : 1;
    const nh = img && img.naturalHeight ? img.naturalHeight : 1;
    return nh ? nw / nh : 1;
  }
  _setImageDisplaySize(container, width) {
    const img = container.querySelector('img');
    const aspect = this._imageAspect(img);
    const maxW = this._editorContentWidth() * 0.95;
    const w = Math.max(40, Math.min(width, maxW));
    const h = Math.max(30, w / aspect);
    container.style.width = Math.round(w) + 'px';
    container.style.height = Math.round(h) + 'px';
    if (img) {
      img.style.width = '';
      img.style.height = '';
      img.removeAttribute('width');
      img.removeAttribute('height');
    }
    this._syncImageSizeLabel(container);
  }
  _readImageWidth(img) {
    if (!img) return 0;
    const rectW = img.getBoundingClientRect ? img.getBoundingClientRect().width : 0;
    if (rectW > 1) return rectW;
    const styleW = (img.style && img.style.width || '').trim();
    const pct = styleW.match(/^([\d.]+)%$/);
    if (pct) return this._editorContentWidth() * Math.min(parseFloat(pct[1]), 100) / 100;
    const px = styleW.match(/^([\d.]+)px$/);
    if (px) return parseFloat(px[1]);
    const attrW = parseFloat(img.getAttribute('width') || '');
    if (attrW > 0) return attrW;
    return img.naturalWidth || 0;
  }
  _syncImageSizeLabel(container) {
    const label = container.querySelector('.img-size-label');
    if (!label) return;
    const rect = container.getBoundingClientRect();
    label.textContent = Math.round(rect.width) + '\u00D7' + Math.round(rect.height);
  }

  /* ---------- 命令执行 ---------- */
  exec(cmd, val) {
    this.editor.focus();
    document.execCommand(cmd, false, val);
    this._afterChange();
  }
  _afterChange() { this.onUpdate(); }

  /* ---------- Input handling ---------- */
  _bindInput() {
    this.editor.addEventListener('input', (e) => {
      this._maybeAutoLink(e);
      this._afterChange();
    });
    this.editor.addEventListener('keyup', (e) => {
      if (e.key === 'Delete' || e.key === 'Backspace') this._afterChange();
    });
    this.editor.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._maybeAutoLink({ inputType: 'insertText', data: ' ' });
    });
  }

  /* ---------- 撤销/重做 ---------- */
  undo() {
    this.editor.focus();
    const tableEntry = this.tableUndoStack[this.tableUndoStack.length - 1];
    if (tableEntry && this._snapshotHTML() === tableEntry.after) {
      this.tableUndoStack.pop();
      this.tableRedoStack.push(tableEntry);
      this._restoreEditorSnapshot(tableEntry.before);
      this.onToast('已撤销表格改动');
      return true;
    }
    const before = this.editor.innerHTML;
    document.execCommand('undo');
    if (this.editor.innerHTML === before) {
      if (this.styleUndoStack.length) {
        const p = this.styleUndoStack.pop();
        if (p.container && p.container.parentNode) {
          p.container.style.width = p.w + 'px';
          p.container.style.height = p.h == null ? '' : p.h + 'px';
          this._syncImageSizeLabel(p.container);
          this._afterChange();
          return true;
        }
      }
      this.onToast('无可撤销操作');
      return false;
    }
    this._afterChange();
    return true;
  }
  redo() {
    this.editor.focus();
    const tableEntry = this.tableRedoStack[this.tableRedoStack.length - 1];
    if (tableEntry && this._snapshotHTML() === tableEntry.before) {
      this.tableRedoStack.pop();
      this.tableUndoStack.push(tableEntry);
      this._restoreEditorSnapshot(tableEntry.after);
      this.onToast('已重做表格改动');
      return true;
    }
    const before = this.editor.innerHTML;
    document.execCommand('redo');
    if (this.editor.innerHTML === before) { this.onToast('无可重做操作'); return false; }
    this._afterChange();
    return true;
  }

  /* ---------- 插入：分隔线 / 引用 / 代码 / 代码块 / 表格 / 目录 ---------- */
  insertHR() {
    this.editor.focus();
    const range = this._blockInsertionRangeFromSelection();
    this._insertHTMLAtRange(range, '<hr><p><br></p>');
    this._afterChange();
  }
  insertQuote() { this.exec('formatBlock', '<BLOCKQUOTE>'); }
  insertTodo() { this._insertTodoBlock(); this._afterChange(); }
  insertCodeInline() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (range.collapsed) document.execCommand('insertHTML', false, '<code>代码</code>');
    else document.execCommand('insertHTML', false, '<code>' + this._escapeHtml(range.toString()) + '</code>');
    this._afterChange();
  }
  insertCodeBlock() {
    this.editor.focus();
    const range = this._blockInsertionRangeFromSelection();
    this._insertHTMLAtRange(range, '<pre><code><br></code></pre><p><br></p>');
    this._afterChange();
  }
  async insertLink() {
    this.editor.focus();
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) { this.onToast('先选中文字，再插入链接'); return; }
    const selected = sel.toString().trim();
    const guess = this._normalizeUrl(selected) || 'https://';
    let url;
    if (this.onPrompt) {
      url = await this.onPrompt({ title: '插入链接', desc: '链接地址：', value: guess, placeholder: 'https://', confirmText: '插入' });
    } else {
      url = window.prompt('链接地址：', guess);
    }
    if (!url || !url.trim() || url.trim() === 'https://') return;
    // 重新选中可能被点击吞掉的选区
    this.editor.focus();
    document.execCommand('createLink', false, this._normalizeUrl(url) || url.trim());
    this._afterChange();
  }
  insertTable(rows, cols) {
    rows = rows || 3;
    cols = cols || 3;
    let html = '<table data-pm-table="1"><colgroup>';
    for (let c = 0; c < cols; c++) html += '<col style="width:' + (100 / cols).toFixed(3) + '%">';
    html += '</colgroup><thead><tr>';
    for (let c = 0; c < cols; c++) html += '<th><br></th>';
    html += '</tr></thead><tbody>';
    for (let r = 1; r < rows; r++) {
      html += '<tr>';
      for (let c = 0; c < cols; c++) html += '<td><br></td>';
      html += '</tr>';
    }
    html += '</tbody></table><p><br></p>';
    this.editor.focus();
    document.execCommand('insertHTML', false, html);
    setTimeout(() => this.normalizeTables(), 0);
    this._afterChange();
  }
  insertTOC() {
    const existing = this.editor.querySelector('.toc');
    const html = this._buildTOCHTML();
    if (!html) { this.onToast('没有可生成目录的标题'); return; }
    if (existing) {
      existing.outerHTML = html;
      this.onToast('目录已刷新');
      this._afterChange();
      return;
    }
    this.editor.focus();
    document.execCommand('insertHTML', false, html + '<p><br></p>');
    this._afterChange();
  }

  refreshTOC() {
    const html = this._buildTOCHTML();
    if (!html) { this.onToast('没有可生成目录的标题'); return false; }
    const tocs = this.editor.querySelectorAll('.toc');
    if (!tocs.length) { this.insertTOC(); return true; }
    tocs.forEach(toc => { toc.outerHTML = html; });
    this._afterChange();
    return true;
  }

  _buildTOCHTML() {
    const headings = Array.from(this.editor.querySelectorAll('h1, h2, h3')).filter(h => !h.closest('.toc'));
    if (!headings.length) return '';
    let html = '<div class="toc" data-toc="1"><div class="toc-title">Table of contents</div><ol>';
    headings.forEach((h, i) => {
      const id = h.id || (h.id = 'h-' + i + '-' + this._uid());
      const level = h.tagName.toLowerCase();
      const indent = level === 'h2' ? 'padding-left:1em;' : (level === 'h3' ? 'padding-left:2em;' : '');
      html += '<li style="' + indent + '"><a href="#' + id + '">' + this._escapeHtml(h.textContent) + '</a></li>';
    });
    html += '</ol></div>';
    return html;
  }

  insertImage(src, targetRange) {
    this.editor.focus();
    // 确保光标在编辑器内
    const sel = window.getSelection();
    if (sel.rangeCount === 0 || !this.editor.contains(sel.getRangeAt(0).commonAncestorContainer)) {
      const r = document.createRange();
      r.selectNodeContents(this.editor);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    const uid = this._uid();
    // span.img-container 包裹 img + 尺寸标签 + 四角手柄，末尾 \u200B 维持光标
    const html = '<div class="img-container" contenteditable="false" data-type="image" draggable="true" data-uid="' + uid + '">' +
      '<img src="' + src + '" alt="image" draggable="false">' +
      '<span class="img-size-label"></span>' +
      '<span class="rs-handle rs-nw" data-dir="nw" draggable="false"></span>' +
      '<span class="rs-handle rs-ne" data-dir="ne" draggable="false"></span>' +
      '<span class="rs-handle rs-sw" data-dir="sw" draggable="false"></span>' +
      '<span class="rs-handle rs-se" data-dir="se" draggable="false"></span>' +
      '</div><p><br></p>';
    const range = targetRange || this._blockInsertionRangeFromSelection();
    this._insertHTMLAtRange(range, html);

    // 找到新容器，挂 onload 自动缩放
    const container = this.editor.querySelector('[data-uid="' + uid + '"]');
    if (container) {
      container.removeAttribute('data-uid');
      this._attachImgLoad(container);
    }
    this._afterChange();
    return uid;
  }

  // 图片加载完成后按编辑器宽度自动缩放（防止突破宽度）
  _attachImgLoad(container) {
    const img = container.querySelector('img');
    if (!img) return;
    const onLoad = () => {
      const ew = this._editorContentWidth();
      const MAX_DEFAULT = 560; // 单图默认最大宽度，避免占满全文
      const styleW = (container.style.width || '').trim();
      const pct = styleW.match(/^([\d.]+)%$/);
      // currentW：用户已设的 px/% > 读取的渲染宽度 > 原始宽度 > 兜底 80%
      const currentW = pct ? ew * Math.min(parseFloat(pct[1]), 100) / 100 : (parseFloat(styleW) || this._readImageWidth(img) || img.naturalWidth || Math.min(MAX_DEFAULT, ew * 0.8));
      // 限制：不超过最大默认宽度、不超过原始宽度、不超过编辑器宽度 95%
      const w = Math.max(40, Math.min(currentW, img.naturalWidth || currentW, MAX_DEFAULT, ew * 0.95));
      this._setImageDisplaySize(container, w);
    };
    img.onload = onLoad;
    if (img.complete && img.naturalWidth) onLoad();
  }

  /* ---------- 把裸 img 包装成可编辑容器（粘贴/打开文件后调用） ---------- */
  fixImageContainers() {
    this.editor.querySelectorAll('img').forEach(img => {
      if (img.closest('.img-container, .link-card, .lc-thumb')) return;
      const container = document.createElement('div');
      container.className = 'img-container';
      container.contentEditable = 'false';
      container.setAttribute('data-type', 'image');
      container.draggable = true;
      const sourceWidth = this._readImageWidth(img);
      if (sourceWidth) container.style.width = Math.round(sourceWidth) + 'px';

      const sizeLabel = document.createElement('span');
      sizeLabel.className = 'img-size-label';

      ['nw', 'ne', 'sw', 'se'].forEach(dir => {
        const h = document.createElement('span');
        h.className = 'rs-handle rs-' + dir;
        h.setAttribute('data-dir', dir);
        h.setAttribute('draggable', 'false');
        container.appendChild(h);
      });

      // 清掉 img 自带的宽高，交给容器控制
      img.style.width = '';
      img.style.height = '';
      img.removeAttribute('width');
      img.removeAttribute('height');
      img.setAttribute('draggable', 'false');

      img.parentNode.insertBefore(container, img);
      container.appendChild(img);
      container.appendChild(sizeLabel);
      this._attachImgLoad(container);
    });

    // 确保已有容器都齐备
    this.editor.querySelectorAll('.img-container').forEach(c => {
      c.classList.remove('dragging');
      if (!c.draggable) c.draggable = true;
      c.contentEditable = 'false';
      c.setAttribute('data-type', 'image');
      const img = c.querySelector('img');
      if (img) {
        img.style.width = '';
        img.style.height = '';
        img.removeAttribute('width');
        img.removeAttribute('height');
        img.setAttribute('draggable', 'false');
      }
      if (!c.querySelector('.img-size-label')) {
        const sizeLabel = document.createElement('span');
        sizeLabel.className = 'img-size-label';
        c.appendChild(sizeLabel);
      }
      if (!c.querySelector('.rs-handle')) {
        ['nw', 'ne', 'sw', 'se'].forEach(dir => {
          const h = document.createElement('span');
          h.className = 'rs-handle rs-' + dir;
          h.setAttribute('data-dir', dir);
          h.setAttribute('draggable', 'false');
          c.appendChild(h);
        });
      }
      this._attachImgLoad(c);
    });

    this.editor.querySelectorAll('.img-grid').forEach(g => this._cleanupImageGrid(g));
  }

  /* ---------- 图片事件委托 ---------- */
  /* ---------- Table editing ---------- */
  normalizeTables() {
    this.editor.querySelectorAll('table').forEach(table => this._normalizeTable(table));
  }

  _normalizeTable(table) {
    if (!table) return;
    table.setAttribute('data-pm-table', '1');
    table.style.tableLayout = 'fixed';
    table.style.width = table.style.width || '100%';
    const rows = Array.from(table.rows || []);
    const maxCols = rows.reduce((m, tr) => Math.max(m, tr.cells.length), 0) || 1;
    let colgroup = table.querySelector(':scope > colgroup');
    if (!colgroup) {
      colgroup = document.createElement('colgroup');
      table.insertBefore(colgroup, table.firstChild);
    }
    while (colgroup.children.length < maxCols) {
      const col = document.createElement('col');
      col.style.width = (100 / maxCols).toFixed(3) + '%';
      colgroup.appendChild(col);
    }
    while (colgroup.children.length > maxCols) colgroup.removeChild(colgroup.lastChild);
    Array.from(colgroup.children).forEach(col => { if (!col.style.width) col.style.width = (100 / maxCols).toFixed(3) + '%'; });
    rows.forEach(row => Array.from(row.cells).forEach(cell => { if (!cell.innerHTML.trim()) cell.innerHTML = '<br>'; }));
  }

  currentTableCell() { return this._currentTableCell(); }

  _currentTableCell() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    let node = sel.getRangeAt(0).commonAncestorContainer;
    if (node.nodeType !== 1) node = node.parentNode;
    return node && node.closest ? node.closest('td,th') : null;
  }

  _cellColumnIndex(cell) {
    if (!cell || !cell.parentNode) return -1;
    return Array.prototype.indexOf.call(cell.parentNode.cells, cell);
  }

  tableCommand(action) {
    const cell = this._currentTableCell();
    const table = cell ? cell.closest('table') : null;
    if (!table) { this.onToast('请先把光标放进表格'); return false; }
    this._normalizeTable(table);
    const row = cell.parentNode;
    const colIndex = this._cellColumnIndex(cell);
    switch (action) {
      case 'row-before': this._insertTableRow(row, -1); break;
      case 'row-after': this._insertTableRow(row, 1); break;
      case 'col-left': this._insertTableColumn(table, colIndex); break;
      case 'col-right': this._insertTableColumn(table, colIndex + 1); break;
      case 'delete-row': this._deleteTableRow(row); break;
      case 'delete-col': this._deleteTableColumn(table, colIndex); break;
      case 'toggle-header': this._toggleTableHeader(table); break;
      case 'delete-table': this._deleteTable(table); break;
      default: return false;
    }
    this.normalizeTables();
    this._afterChange();
    return true;
  }

  _insertTableRow(row, offset) {
    const table = row.closest('table');
    const index = row.rowIndex + (offset > 0 ? 1 : 0);
    const next = table.insertRow(index);
    const cols = table.querySelectorAll(':scope > colgroup > col').length || row.cells.length || 1;
    for (let i = 0; i < cols; i++) next.insertCell(i).innerHTML = '<br>';
    this._restoreCaretInBlock(next.cells[0]);
  }

  _insertTableColumn(table, index) {
    const cols = table.querySelectorAll(':scope > colgroup > col');
    index = Math.max(0, Math.min(index, cols.length || 0));
    let colgroup = table.querySelector(':scope > colgroup');
    if (!colgroup) { colgroup = document.createElement('colgroup'); table.insertBefore(colgroup, table.firstChild); }
    const col = document.createElement('col');
    col.style.width = cols[0] && cols[0].style.width ? cols[0].style.width : '';
    colgroup.insertBefore(col, colgroup.children[index] || null);
    Array.from(table.rows).forEach((row) => {
      const sample = row.cells[Math.max(0, index - 1)] || row.cells[0];
      const cell = document.createElement(sample && sample.tagName === 'TH' ? 'th' : 'td');
      cell.innerHTML = '<br>';
      row.insertBefore(cell, row.cells[index] || null);
    });
    const target = table.rows[0] && table.rows[0].cells[index];
    if (target) this._restoreCaretInBlock(target);
  }

  _deleteTableRow(row) {
    const table = row.closest('table');
    if (table.rows.length <= 1) { this._deleteTable(table); return; }
    const next = row.nextElementSibling || row.previousElementSibling;
    row.parentNode.removeChild(row);
    if (next && next.cells[0]) this._restoreCaretInBlock(next.cells[0]);
  }

  _deleteTableColumn(table, index) {
    const cols = table.querySelectorAll(':scope > colgroup > col');
    if (cols.length <= 1) { this._deleteTable(table); return; }
    Array.from(table.rows).forEach(row => { if (row.cells[index]) row.deleteCell(index); });
    if (cols[index]) cols[index].remove();
    const target = table.rows[0] && table.rows[0].cells[Math.max(0, index - 1)];
    if (target) this._restoreCaretInBlock(target);
  }

  _deleteTable(table) {
    const p = document.createElement('p');
    p.innerHTML = '<br>';
    table.parentNode.replaceChild(p, table);
    this._restoreCaretInBlock(p);
  }

  _toggleTableHeader(table) {
    const first = table.rows[0];
    if (!first) return;
    const makeTd = first.cells.length && first.cells[0].tagName === 'TH';
    Array.from(first.cells).forEach(cell => {
      const next = document.createElement(makeTd ? 'td' : 'th');
      next.innerHTML = cell.innerHTML || '<br>';
      cell.parentNode.replaceChild(next, cell);
    });
  }

  _bindTableEditing() {
    this.editor.addEventListener('mousemove', (e) => {
      if (this.tableResizeState) return;
      const cell = e.target.closest && e.target.closest('td,th');
      if (!cell || !this.editor.contains(cell)) { this.editor.classList.remove('table-col-resize-hover'); return; }
      const rect = cell.getBoundingClientRect();
      this.editor.classList.toggle('table-col-resize-hover', Math.abs(e.clientX - rect.right) <= 5);
    });
    this.editor.addEventListener('mousedown', (e) => {
      const cell = e.target.closest && e.target.closest('td,th');
      if (!cell || !this.editor.contains(cell)) return;
      const rect = cell.getBoundingClientRect();
      if (Math.abs(e.clientX - rect.right) > 5) return;
      const table = cell.closest('table');
      this._normalizeTable(table);
      const cols = Array.from(table.querySelectorAll(':scope > colgroup > col'));
      const index = this._cellColumnIndex(cell);
      if (index < 0 || index >= cols.length) return;
      e.preventDefault();
      const tableRect = table.getBoundingClientRect();
      this.tableResizeState = { table, cols, index, startX: e.clientX, tableWidth: tableRect.width, widths: cols.map(col => {
        const raw = col.style.width || '';
        if (raw.endsWith('%')) return tableRect.width * parseFloat(raw) / 100;
        return parseFloat(raw) || tableRect.width / cols.length;
      }) };
      document.body.classList.add('table-resizing');
    });
    document.addEventListener('mousemove', (e) => {
      const st = this.tableResizeState;
      if (!st) return;
      const nextIndex = Math.min(st.index + 1, st.cols.length - 1);
      const dx = e.clientX - st.startX;
      const left = Math.max(40, st.widths[st.index] + dx);
      if (nextIndex !== st.index) {
        const right = Math.max(40, st.widths[nextIndex] - dx);
        st.cols[st.index].style.width = (left / st.tableWidth * 100).toFixed(3) + '%';
        st.cols[nextIndex].style.width = (right / st.tableWidth * 100).toFixed(3) + '%';
      } else {
        st.cols[st.index].style.width = Math.round(left) + 'px';
      }
    });
    document.addEventListener('mouseup', () => {
      if (!this.tableResizeState) return;
      this.tableResizeState = null;
      document.body.classList.remove('table-resizing');
      this.editor.classList.remove('table-col-resize-hover');
      this._afterChange();
    });
  }

  /* ---------- Table editing v2 ---------- */
  _snapshotHTML() {
    const clone = this.editor.cloneNode(true);
    clone.querySelectorAll('.pm-table-cell-active,.pm-table-cell-selected').forEach(cell => {
      cell.classList.remove('pm-table-cell-active', 'pm-table-cell-selected');
      if (!cell.getAttribute('class')) cell.removeAttribute('class');
    });
    return clone.innerHTML;
  }

  _recordTableMutation(before) {
    const after = this._snapshotHTML();
    if (!before || before === after) return false;
    this.tableUndoStack.push({ before, after });
    if (this.tableUndoStack.length > 30) this.tableUndoStack.shift();
    this.tableRedoStack.length = 0;
    return true;
  }

  _restoreEditorSnapshot(html) {
    this.activeTableCell = null;
    this.tableSelection = null;
    this.editor.innerHTML = html || '<p><br></p>';
    this.normalizeLinkCards();
    this.fixImageContainers();
    this.normalizeTables();
    this._renderTableSelection();
    this._afterChange();
  }

  _tableGrid(table) {
    const grid = [];
    const info = new Map();
    const rows = Array.from((table && table.rows) || []);
    let colCount = 0;
    rows.forEach((row, rowIndex) => {
      if (!grid[rowIndex]) grid[rowIndex] = [];
      let colIndex = 0;
      Array.from(row.cells).forEach(cell => {
        while (grid[rowIndex][colIndex]) colIndex++;
        const rowSpan = Math.max(1, Number(cell.rowSpan) || 1);
        const colSpan = Math.max(1, Number(cell.colSpan) || 1);
        info.set(cell, { row: rowIndex, col: colIndex, rowSpan, colSpan });
        for (let r = rowIndex; r < rowIndex + rowSpan; r++) {
          if (!grid[r]) grid[r] = [];
          for (let c = colIndex; c < colIndex + colSpan; c++) grid[r][c] = cell;
        }
        colIndex += colSpan;
        colCount = Math.max(colCount, colIndex);
      });
      colCount = Math.max(colCount, grid[rowIndex].length);
    });
    return { grid, info, rows, rowCount: grid.length, colCount: colCount || 1 };
  }

  _normalizeTable(table) {
    if (!table) return;
    table.setAttribute('data-pm-table', '1');
    if (!table.getAttribute('data-pm-table-id')) table.setAttribute('data-pm-table-id', this._uid());
    table.style.tableLayout = 'fixed';
    const model = this._tableGrid(table);
    let colgroup = table.querySelector(':scope > colgroup');
    if (!colgroup) {
      colgroup = document.createElement('colgroup');
      table.insertBefore(colgroup, table.firstChild);
    }
    const countChanged = colgroup.children.length !== model.colCount;
    while (colgroup.children.length < model.colCount) colgroup.appendChild(document.createElement('col'));
    while (colgroup.children.length > model.colCount) colgroup.lastChild.remove();
    const baseWidth = Math.max(1, table.getBoundingClientRect().width || this._editorContentWidth());
    if (countChanged || Array.from(colgroup.children).some(col => !col.style.width)) {
      this._applyColumnPixelWidths(table, equalizeWidths(baseWidth, model.colCount));
    } else {
      this._applyColumnPixelWidths(table, this._getColumnPixelWidths(table));
    }
    model.rows.forEach(row => Array.from(row.cells).forEach(cell => {
      if (!cell.innerHTML.trim()) cell.innerHTML = '<br>';
    }));
  }

  _getColumnPixelWidths(table) {
    const cols = Array.from(table.querySelectorAll(':scope > colgroup > col'));
    const rawTableWidth = String(table.style.width || '').trim();
    const inlineTableWidth = rawTableWidth.endsWith('px') ? parseFloat(rawTableWidth) || 0 : 0;
    const tableWidth = Math.max(1, inlineTableWidth || table.getBoundingClientRect().width || this._editorContentWidth());
    const values = cols.map(col => {
      const raw = String(col.style.width || '').trim();
      if (raw.endsWith('%')) return tableWidth * (parseFloat(raw) || 0) / 100;
      if (raw.endsWith('px')) return parseFloat(raw) || 0;
      return 0;
    });
    if (values.some(value => value <= 0)) return normalizePixelWidths(values, tableWidth, cols.length || 1);
    return values;
  }

  _applyColumnPixelWidths(table, widths) {
    const cols = Array.from(table.querySelectorAll(':scope > colgroup > col'));
    const currentWidth = Math.max(1, table.getBoundingClientRect().width || this._editorContentWidth());
    const values = widths && widths.length === cols.length ? widths : equalizeWidths(currentWidth, cols.length || 1);
    cols.forEach((col, index) => { col.style.width = Math.max(1, Number(values[index]) || 1).toFixed(2) + 'px'; });
    table.style.width = values.reduce((sum, value) => sum + Math.max(1, Number(value) || 1), 0).toFixed(2) + 'px';
  }

  _selectedTableCells() {
    if (this.tableSelection && this.tableSelection.cells && this.tableSelection.cells.length) {
      return this.tableSelection.cells.filter(cell => cell && cell.isConnected);
    }
    return this.activeTableCell && this.activeTableCell.isConnected ? [this.activeTableCell] : [];
  }

  currentTableCell() {
    if (this.activeTableCell && this.activeTableCell.isConnected) return this.activeTableCell;
    return this._currentTableCell();
  }

  _setActiveTableCell(cell, extend) {
    if (!cell || !this.editor.contains(cell)) {
      this.activeTableCell = null;
      this.tableSelection = null;
      this._renderTableSelection();
      return;
    }
    const table = cell.closest('table');
    if (extend && this.tableSelection && this.tableSelection.table === table && this.tableSelection.anchor) {
      this._selectTableRange(table, this.tableSelection.anchor, cell);
      return;
    }
    this.activeTableCell = cell;
    this.tableSelection = { table, anchor: cell, focus: cell, cells: [cell] };
    this._renderTableSelection();
  }

  _selectTableRange(table, anchor, focus) {
    const model = this._tableGrid(table);
    const a = model.info.get(anchor);
    const f = model.info.get(focus);
    if (!a || !f) return this._setActiveTableCell(focus, false);
    let top = Math.min(a.row, f.row);
    let left = Math.min(a.col, f.col);
    let bottom = Math.max(a.row + a.rowSpan - 1, f.row + f.rowSpan - 1);
    let right = Math.max(a.col + a.colSpan - 1, f.col + f.colSpan - 1);
    let changed = true;
    while (changed) {
      changed = false;
      for (let r = top; r <= bottom; r++) {
        for (let c = left; c <= right; c++) {
          const cell = model.grid[r] && model.grid[r][c];
          const meta = cell && model.info.get(cell);
          if (!meta) continue;
          const nextTop = Math.min(top, meta.row);
          const nextLeft = Math.min(left, meta.col);
          const nextBottom = Math.max(bottom, meta.row + meta.rowSpan - 1);
          const nextRight = Math.max(right, meta.col + meta.colSpan - 1);
          if (nextTop !== top || nextLeft !== left || nextBottom !== bottom || nextRight !== right) changed = true;
          top = nextTop; left = nextLeft; bottom = nextBottom; right = nextRight;
        }
      }
    }
    const cells = [];
    const seen = new Set();
    for (let r = top; r <= bottom; r++) {
      for (let c = left; c <= right; c++) {
        const cell = model.grid[r] && model.grid[r][c];
        if (cell && !seen.has(cell)) { seen.add(cell); cells.push(cell); }
      }
    }
    this.activeTableCell = focus;
    this.tableSelection = { table, anchor, focus, cells, rect: { top, left, bottom, right } };
    this._renderTableSelection();
  }

  _renderTableSelection() {
    this.editor.querySelectorAll('.pm-table-cell-active,.pm-table-cell-selected').forEach(cell => {
      cell.classList.remove('pm-table-cell-active', 'pm-table-cell-selected');
    });
    const cells = this._selectedTableCells();
    if (this.activeTableCell && this.activeTableCell.isConnected) this.activeTableCell.classList.add('pm-table-cell-active');
    if (cells.length > 1) cells.forEach(cell => cell.classList.add('pm-table-cell-selected'));
    this._emitTableState();
    requestAnimationFrame(() => this._updateTableResizeHandles());
  }

  getTableState() {
    const cell = this.currentTableCell();
    const table = cell && cell.closest('table');
    const cells = table ? this._selectedTableCells() : [];
    return {
      active: !!table,
      table,
      cell,
      selectedCount: cells.length,
      canMerge: cells.length > 1,
      canSplit: !!(cell && (cell.rowSpan > 1 || cell.colSpan > 1)),
      backgroundColor: cell && cell.style.backgroundColor ? cell.style.backgroundColor : '#ffffff'
    };
  }

  _emitTableState() {
    this.editor.dispatchEvent(new CustomEvent('penmark:table-state', { detail: this.getTableState() }));
  }

  _hasMergedCells(table) {
    return !!table.querySelector('td[rowspan]:not([rowspan="1"]),th[rowspan]:not([rowspan="1"]),td[colspan]:not([colspan="1"]),th[colspan]:not([colspan="1"])');
  }

  tableCommand(action) {
    const cell = this.currentTableCell();
    const table = cell && cell.closest('table');
    if (!table) { this.onToast('请先把光标放进表格'); return false; }
    const structural = new Set(['row-before','row-after','col-left','col-right','delete-row','delete-col','toggle-header']);
    if (structural.has(action) && this._hasMergedCells(table)) {
      this.onToast('请先拆分合并单元格，再增删行列');
      return false;
    }
    const before = this._snapshotHTML();
    const row = cell.parentNode;
    const colIndex = this._cellColumnIndex(cell);
    let ok = true;
    switch (action) {
      case 'row-before': this._insertTableRow(row, -1); break;
      case 'row-after': this._insertTableRow(row, 1); break;
      case 'col-left': this._insertTableColumn(table, colIndex); break;
      case 'col-right': this._insertTableColumn(table, colIndex + 1); break;
      case 'delete-row': this._deleteTableRow(row); break;
      case 'delete-col': this._deleteTableColumn(table, colIndex); break;
      case 'toggle-header': this._toggleTableHeader(table); break;
      case 'delete-table': this._deleteTable(table); this._setActiveTableCell(null, false); break;
      case 'equalize': this._equalizeTableColumns(table); break;
      case 'merge': ok = this._mergeSelectedTableCells(table); break;
      case 'split': ok = this._splitActiveTableCell(table, cell); break;
      case 'clear-bg': this._applyTableCellBackground(''); break;
      default: ok = false;
    }
    if (!ok) return false;
    if (table.isConnected) this._normalizeTable(table);
    this._recordTableMutation(before);
    this._afterChange();
    this._renderTableSelection();
    return true;
  }

  _equalizeTableColumns(table) {
    const count = table.querySelectorAll(':scope > colgroup > col').length || this._tableGrid(table).colCount;
    const current = this._getColumnPixelWidths(table);
    const total = current.reduce((sum, value) => sum + value, 0);
    this._applyColumnPixelWidths(table, equalizeWidths(total, count));
  }

  _mergeSelectedTableCells(table) {
    const cells = this._selectedTableCells();
    if (cells.length < 2 || !this.tableSelection || !this.tableSelection.rect) {
      this.onToast('按住 Shift 点击，先选择连续单元格');
      return false;
    }
    const model = this._tableGrid(table);
    const rect = this.tableSelection.rect;
    const keeper = model.grid[rect.top] && model.grid[rect.top][rect.left];
    if (!keeper) return false;
    const contents = cells.map(item => String(item.innerHTML || '').trim())
      .filter(value => value && value !== '<br>');
    keeper.innerHTML = contents.length ? contents.join('<br>') : '<br>';
    keeper.rowSpan = rect.bottom - rect.top + 1;
    keeper.colSpan = rect.right - rect.left + 1;
    cells.forEach(item => { if (item !== keeper) item.remove(); });
    this.activeTableCell = keeper;
    this.tableSelection = { table, anchor: keeper, focus: keeper, cells: [keeper] };
    return true;
  }

  _insertCellAtLogicalColumn(table, row, targetCol, tagName) {
    const model = this._tableGrid(table);
    let ref = null;
    for (const existing of Array.from(row.cells)) {
      const meta = model.info.get(existing);
      if (meta && meta.col >= targetCol) { ref = existing; break; }
    }
    const cell = document.createElement(tagName || 'td');
    cell.innerHTML = '<br>';
    row.insertBefore(cell, ref);
    return cell;
  }

  _splitActiveTableCell(table, cell) {
    const model = this._tableGrid(table);
    const meta = model.info.get(cell);
    if (!meta || (meta.rowSpan === 1 && meta.colSpan === 1)) {
      this.onToast('当前单元格没有合并');
      return false;
    }
    const originalTag = cell.tagName.toLowerCase();
    cell.rowSpan = 1;
    cell.colSpan = 1;
    for (let r = meta.row; r < meta.row + meta.rowSpan; r++) {
      const row = table.rows[r];
      for (let c = meta.col; c < meta.col + meta.colSpan; c++) {
        if (r === meta.row && c === meta.col) continue;
        const tag = row.parentElement && row.parentElement.tagName === 'THEAD' ? 'th' : originalTag === 'th' ? 'th' : 'td';
        this._insertCellAtLogicalColumn(table, row, c, tag);
      }
    }
    this.activeTableCell = cell;
    this.tableSelection = { table, anchor: cell, focus: cell, cells: [cell] };
    return true;
  }

  _applyTableCellBackground(color) {
    const cells = this._selectedTableCells();
    cells.forEach(cell => {
      if (color) cell.style.backgroundColor = color;
      else cell.style.removeProperty('background-color');
    });
  }

  setTableCellBackground(color) {
    if (!this.currentTableCell()) return false;
    const before = this._snapshotHTML();
    this._applyTableCellBackground(color);
    this._recordTableMutation(before);
    this._afterChange();
    this._emitTableState();
    return true;
  }

  _ensureTableResizeLayer() {
    if (this.tableResizeLayer) return this.tableResizeLayer;
    const layer = document.createElement('div');
    layer.className = 'table-resize-layer';
    layer.hidden = true;
    document.body.appendChild(layer);
    this.tableResizeLayer = layer;
    return layer;
  }

  _updateTableResizeHandles() {
    const layer = this._ensureTableResizeLayer();
    if (this.tableResizeState) return;
    const cell = this.currentTableCell();
    const table = cell && cell.closest('table');
    if (!table || !table.isConnected || this.editor.contentEditable === 'false') {
      layer.hidden = true;
      layer.replaceChildren();
      return;
    }
    const rect = table.getBoundingClientRect();
    const widths = this._getColumnPixelWidths(table);
    layer.replaceChildren();
    layer.hidden = false;
    let x = rect.left;
    for (let index = 0; index < widths.length; index++) {
      x += widths[index];
      const handle = document.createElement('button');
      handle.type = 'button';
      handle.className = 'table-col-resizer';
      handle.dataset.columnIndex = String(index);
      handle.setAttribute('aria-label', '调整列宽');
      handle.title = '拖动调整列宽；双击均分列宽';
      handle.style.left = (x - 7) + 'px';
      handle.style.top = rect.top + 'px';
      handle.style.height = rect.height + 'px';
      handle.addEventListener('pointerdown', event => this._startTableColumnResize(event, table, index));
      handle.addEventListener('dblclick', event => {
        event.preventDefault();
        const before = this._snapshotHTML();
        this._equalizeTableColumns(table);
        this._recordTableMutation(before);
        this._afterChange();
        this._updateTableResizeHandles();
      });
      layer.appendChild(handle);
    }
  }

  _startTableColumnResize(event, table, boundaryIndex) {
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const widths = this._getColumnPixelWidths(table);
    this.tableResizeState = {
      table,
      handle,
      boundaryIndex,
      startX: event.clientX,
      widths,
      before: this._snapshotHTML(),
      pointerId: event.pointerId
    };
    handle.classList.add('active');
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('table-resizing');
    const move = e => this._moveTableColumnResize(e);
    const end = e => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      this._endTableColumnResize(e);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  _positionTableResizeHandles(table, widths) {
    const rect = table.getBoundingClientRect();
    const handles = Array.from(this._ensureTableResizeLayer().querySelectorAll('.table-col-resizer'));
    let x = rect.left;
    handles.forEach((handle, index) => {
      x += widths[index] || 0;
      handle.style.left = (x - 7) + 'px';
      handle.style.top = rect.top + 'px';
      handle.style.height = rect.height + 'px';
    });
  }

  _moveTableColumnResize(event) {
    const state = this.tableResizeState;
    if (!state || event.pointerId !== state.pointerId) return;
    let resized = resizeColumnWidth(state.widths, state.boundaryIndex, event.clientX - state.startX, TABLE_MIN_COL_WIDTH);
    if (!event.altKey) {
      const width = resized[state.boundaryIndex];
      const equalCandidate = state.widths
        .filter((_value, index) => index !== state.boundaryIndex)
        .map(value => ({ value, distance: Math.abs(value - width) }))
        .sort((a, b) => a.distance - b.distance)[0];
      if (equalCandidate && equalCandidate.distance <= 6) {
        resized = resizeColumnWidth(state.widths, state.boundaryIndex,
          equalCandidate.value - state.widths[state.boundaryIndex], TABLE_MIN_COL_WIDTH);
      }
      if (state.boundaryIndex === state.widths.length - 1) {
        const editorRect = this.editor.getBoundingClientRect();
        const editorStyle = window.getComputedStyle(this.editor);
        const contentRight = editorRect.right - (parseFloat(editorStyle.paddingRight) || 0);
        const tableLeft = state.table.getBoundingClientRect().left;
        const proposedRight = tableLeft + resized.reduce((sum, value) => sum + value, 0);
        if (Math.abs(contentRight - proposedRight) <= 8) {
          resized[state.boundaryIndex] += contentRight - proposedRight;
        }
      }
    }
    this._applyColumnPixelWidths(state.table, resized);
    this._positionTableResizeHandles(state.table, resized);
    state.currentWidths = resized;
  }

  _endTableColumnResize(event) {
    const state = this.tableResizeState;
    if (!state || event.pointerId !== state.pointerId) return;
    if (state.handle.hasPointerCapture && state.handle.hasPointerCapture(event.pointerId)) state.handle.releasePointerCapture(event.pointerId);
    const finalWidths = state.currentWidths || state.widths;
    this._applyColumnPixelWidths(state.table, finalWidths);
    state.handle.classList.remove('active');
    this.tableResizeState = null;
    document.body.classList.remove('table-resizing');
    this._recordTableMutation(state.before);
    this._afterChange();
    this._updateTableResizeHandles();
  }

  _bindTableEditing() {
    this._ensureTableResizeLayer();
    this.editor.addEventListener('pointerdown', event => {
      const cell = event.target.closest && event.target.closest('td,th');
      if (cell && this.editor.contains(cell)) {
        if (event.shiftKey) event.preventDefault();
        this._setActiveTableCell(cell, event.shiftKey);
      } else if (event.target.closest && !event.target.closest('table')) {
        this._setActiveTableCell(null, false);
      }
    });
    this.editor.addEventListener('focusin', event => {
      const cell = event.target.closest && event.target.closest('td,th');
      if (cell) this._setActiveTableCell(cell, false);
    });
    this.editor.addEventListener('keydown', event => {
      if (event.key === 'Escape' && this._selectedTableCells().length > 1) {
        event.preventDefault();
        this._setActiveTableCell(this.activeTableCell, false);
      }
    });
    window.addEventListener('resize', () => this._updateTableResizeHandles());
    window.addEventListener('scroll', () => this._updateTableResizeHandles(), true);
  }

  _createImageDragPreview(img) {
    this._removeImageDragPreview();
    if (!img) return null;
    const naturalW = img.naturalWidth || img.offsetWidth || 180;
    const naturalH = img.naturalHeight || img.offsetHeight || 140;
    const scale = Math.min(180 / naturalW, 140 / naturalH, 1);
    const width = Math.max(48, Math.round(naturalW * scale));
    const height = Math.max(36, Math.round(naturalH * scale));
    const preview = document.createElement('div');
    preview.className = 'image-drag-preview';
    preview.style.width = width + 'px';
    preview.style.height = height + 'px';
    const clone = img.cloneNode(false);
    clone.removeAttribute('width');
    clone.removeAttribute('height');
    clone.style.cssText = 'display:block;width:100%;height:100%;object-fit:cover;';
    preview.appendChild(clone);
    document.body.appendChild(preview);
    this.imageDragPreview = preview;
    return preview;
  }

  _removeImageDragPreview() {
    if (this.imageDragPreview && this.imageDragPreview.parentNode) {
      this.imageDragPreview.parentNode.removeChild(this.imageDragPreview);
    }
    this.imageDragPreview = null;
  }
  _bindImageDelegation() {
    // 点击选中
    this.editor.addEventListener('click', (e) => {
      if (e.target.closest('.link-card, .lc-thumb')) return;
      const handle = e.target.closest('.rs-handle');
      if (handle) return; // 手柄交给 mousedown 处理
      const container = e.target.closest('.img-container');
      if (container) {
        e.stopPropagation();
        this._selectImage(container);
      } else {
        this._selectImage(null);
      }
    });

    // 缩放手柄 mousedown
    this.editor.addEventListener('mousedown', (e) => {
      const handle = e.target.closest('.rs-handle');
      if (!handle) return;
      e.preventDefault();
      e.stopPropagation();
      const container = handle.closest('.img-container');
      if (!container) return;
      this._selectImage(container);
      const dir = handle.getAttribute('data-dir');
      const rect = container.getBoundingClientRect();
      const grid = container.closest('.img-grid');
      if (grid) {
        const parent = grid.parentNode;
        parent.insertBefore(container, grid.nextSibling);
        container.style.width = Math.round(rect.width) + 'px';
        container.style.height = Math.round(rect.height) + 'px';
        this._cleanupImageGrid(grid);
      }
      const img = container.querySelector('img');
      const aspect = (img && img.naturalWidth) ? img.naturalWidth / img.naturalHeight : 1;
      this.resizeState = {
        container, dir,
        startX: e.clientX, startY: e.clientY,
        startW: rect.width, startH: rect.height, aspect
      };
    });

    // 缩放 mousemove / mouseup（绑 document 一次）
    document.addEventListener('mousemove', (e) => {
      if (!this.resizeState) return;
      const s = this.resizeState;
      const dx = e.clientX - s.startX;
      let newW;
      if (s.dir === 'se' || s.dir === 'ne') newW = s.startW + dx;
      else newW = s.startW - dx;
      if (newW < 40) newW = 40;
      let newH = newW / s.aspect;
      if (newH < 30) { newH = 30; newW = newH * s.aspect; }
      const maxW = this._editorContentWidth();
      if (newW > maxW * 0.95) newW = maxW * 0.95;
      this._setImageDisplaySize(s.container, newW);
    });
    document.addEventListener('mouseup', () => {
      if (this.resizeState) {
        const s = this.resizeState;
        // 缩放前尺寸入栈，供 undo 补偿
        this.styleUndoStack.push({ container: s.container, w: s.startW, h: s.startH });
        this.resizeState = null;
        this._afterChange();
      }
    });

    // 删除键
    this.editor.addEventListener('keydown', (e) => {
      if (!this.selectedImage) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (ctrl && key === 'c') {
        e.preventDefault();
        this.copyImage(this.selectedImage);
      } else if (ctrl && key === 'x') {
        e.preventDefault();
        this.cutImage(this.selectedImage);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        this._deleteImage(this.selectedImage);
      }
    });

    // 编辑器内拖拽移位
    this.editor.addEventListener('dragstart', (e) => {
      if (e.target.closest && e.target.closest('.link-card, .lc-thumb')) return;
      const container = e.target.closest && e.target.closest('.img-container');
      if (container) {
        container.classList.add('dragging');
        try {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/penmark-img', container.getAttribute('data-id') || this._uid());
          container.setAttribute('data-id', e.dataTransfer.getData('text/penmark-img'));
          const img = container.querySelector('img');
          if (img && e.dataTransfer.setDragImage) {
            const preview = this._createImageDragPreview(img);
            if (preview) e.dataTransfer.setDragImage(preview, preview.offsetWidth / 2, preview.offsetHeight / 2);
          }
        } catch (_) {}
      }
    });
    this.editor.addEventListener('dragend', (e) => {
      const container = e.target.closest && e.target.closest('.img-container');
      if (container) container.classList.remove('dragging');
      this._hideDropIndicator();
      this._removeImageDragPreview();
    });
    this.editor.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types && e.dataTransfer.types.indexOf('text/penmark-img') >= 0) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        this._showDropIndicator(e.clientX, e.clientY);
      }
    });
    this.editor.addEventListener('drop', (e) => {
      const id = e.dataTransfer.getData('text/penmark-img');
      if (id) {
        this._hideDropIndicator();
        e.preventDefault();
        e.stopPropagation();
        const container = this.editor.querySelector('.img-container[data-id="' + id + '"]');
        if (!container) return;
        const gridTarget = this._imageDropTarget(e.clientX, e.clientY, container);
        if (gridTarget) {
          this._moveImageBeside(container, gridTarget, e.clientX);
          container.removeAttribute('data-id');
          container.classList.remove('dragging');
          this._afterChange();
          return;
        }
        const r = this._blockInsertionRangeFromPoint(e.clientX, e.clientY);
        if (!r) return;
        const oldGrid = container.closest('.img-grid');
        container.classList.remove('dragging');
        const html = container.outerHTML;
        container.parentNode.removeChild(container);
        this._cleanupImageGrid(oldGrid);
        this._insertHTMLAtRange(r, html + '<p><br></p>');
        const inserted = this.editor.querySelector('.img-container[data-id="' + id + '"]');
        if (inserted) { inserted.classList.remove('dragging'); inserted.removeAttribute('data-id'); this._attachImgLoad(inserted); }
        this._afterChange();
      }
    }, true);
  }

  _imageDropTarget(x, y, dragged) {
    const hit = [];
    if (document.elementsFromPoint) hit.push(...document.elementsFromPoint(x, y));
    for (const el of hit) {
      const c = el.closest && el.closest('.img-container');
      if (c && c !== dragged && this.editor.contains(c) && !dragged.contains(c)) return c;
    }
    let best = null;
    let bestScore = Infinity;
    this.editor.querySelectorAll('.img-container').forEach(c => {
      if (c === dragged || dragged.contains(c)) return;
      const r = c.getBoundingClientRect();
      const nearY = y >= r.top - 24 && y <= r.bottom + 24;
      const nearX = x >= r.left - 48 && x <= r.right + 48;
      if (!nearY || !nearX) return;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const score = Math.abs(x - cx) + Math.abs(y - cy);
      if (score < bestScore) { best = c; bestScore = score; }
    });
    return best;
  }

  _moveImageBeside(source, target, clientX) {
    if (!source || !target || source === target) return;
    const sourceGrid = source.closest('.img-grid');
    let targetGrid = target.closest('.img-grid');
    const targetRect = target.getBoundingClientRect();
    const insertBeforeTarget = clientX < targetRect.left + targetRect.width / 2;

    source.removeAttribute('data-id');
    if (!targetGrid) {
      targetGrid = document.createElement('div');
      targetGrid.className = 'img-grid';
      targetGrid.setAttribute('data-type', 'image-grid');
      target.parentNode.insertBefore(targetGrid, target);
      if (insertBeforeTarget) {
        targetGrid.appendChild(source);
        targetGrid.appendChild(target);
      } else {
        targetGrid.appendChild(target);
        targetGrid.appendChild(source);
      }
      targetGrid.after(document.createTextNode('\u200B'));
    } else {
      source.parentNode && source.parentNode.removeChild(source);
      targetGrid.insertBefore(source, insertBeforeTarget ? target : target.nextSibling);
    }

    if (sourceGrid && sourceGrid !== targetGrid) this._cleanupImageGrid(sourceGrid);
    this._normalizeImageGrid(targetGrid);
    this._selectImage(source);
  }

  _normalizeImageGrid(grid) {
    if (!grid || !grid.classList || !grid.classList.contains('img-grid')) return;
    grid.removeAttribute('contenteditable');
    grid.setAttribute('data-type', 'image-grid');
    const items = Array.from(grid.querySelectorAll(':scope > .img-container'));
    grid.setAttribute('data-count', String(items.length));
    items.forEach(c => {
      c.style.float = '';
      c.style.display = '';
      c.style.marginLeft = '';
      c.style.marginRight = '';
      this._attachImgLoad(c);
      this._syncImageSizeLabel(c);
    });
  }

  _cleanupImageGrid(grid) {
    if (!grid || !grid.parentNode) return;
    const items = Array.from(grid.querySelectorAll(':scope > .img-container'));
    if (items.length === 0) {
      grid.parentNode.removeChild(grid);
      return;
    }
    if (items.length === 1) {
      const only = items[0];
      grid.parentNode.insertBefore(only, grid);
      grid.parentNode.removeChild(grid);
      only.style.width = only.style.width || Math.floor(this._editorContentWidth() * 0.6) + 'px';
      this._attachImgLoad(only);
      return;
    }
    this._normalizeImageGrid(grid);
  }

  _selectImage(container) {
    this.editor.querySelectorAll('.img-container.selected').forEach(c => c.classList.remove('selected'));
    this.selectedImage = container;
    if (container) { container.classList.add('selected'); container.setAttribute('tabindex', '-1'); container.focus(); }
    this.onImageSelect(container);
  }

  _deleteImage(container) {
    if (!container || !container.parentNode) return;
    const grid = container && container.closest ? container.closest('.img-grid') : null;
    container.parentNode.removeChild(container);
    this._cleanupImageGrid(grid);
    this._selectImage(null);
    this._afterChange();
  }

  _imageClipboardHTML(container) {
    if (!container) return '';
    const clone = container.cloneNode(true);
    clone.classList.remove('selected', 'dragging');
    clone.removeAttribute('data-id');
    clone.removeAttribute('tabindex');
    clone.querySelectorAll('.rs-handle, .img-size-label').forEach(n => n.remove());
    return clone.outerHTML;
  }

  async _writeImageClipboard(container) {
    const img = container && container.querySelector('img');
    if (!img) return false;
    const html = this._imageClipboardHTML(container);
    const src = img.getAttribute('src') || '';
    this.imageClipboard = { html, src };
    try {
      if (navigator.clipboard && window.ClipboardItem) {
        const items = {
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([src], { type: 'text/plain' })
        };
        if (/^data:image\/png/i.test(src)) {
          try { items['image/png'] = await (await fetch(src)).blob(); } catch (_) {}
        }
        await navigator.clipboard.write([new ClipboardItem(items)]);
        return true;
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(src);
        return true;
      }
    } catch (_) {}
    return false;
  }

  async copyImage(container) {
    container = container || this.selectedImage;
    if (!container) return false;
    await this._writeImageClipboard(container);
    this.onToast('已复制图片');
    return true;
  }

  async cutImage(container) {
    container = container || this.selectedImage;
    if (!container) return false;
    await this._writeImageClipboard(container);
    this._deleteImage(container);
    this.onToast('已剪切图片');
    return true;
  }

  /* ---------- 图片浮动菜单操作 ---------- */
  // 重置为原始尺寸
  resetImageSize(container) {
    const img = container.querySelector('img');
    if (!img || !img.naturalWidth) return;
    const before = container.getBoundingClientRect();
    const ew = this._editorContentWidth();
    const w = Math.min(img.naturalWidth, ew * 0.95);
    this._setImageDisplaySize(container, w);
    this.styleUndoStack.push({ container, w: before.width, h: before.height });
    this._afterChange();
  }
  // 适应编辑器宽度
  fitImageWidth(container) {
    const before = container.getBoundingClientRect();
    const ew = this._editorContentWidth();
    this._setImageDisplaySize(container, ew * 0.95);
    this.styleUndoStack.push({ container, w: before.width, h: before.height });
    this._afterChange();
  }
  // 对齐方式
  alignImage(container, align) {
    container.style.float = '';
    if (align === 'center') {
      container.style.display = 'block';
      container.style.marginLeft = 'auto';
      container.style.marginRight = 'auto';
    } else if (align === 'left') {
      container.style.display = 'block';
      container.style.marginLeft = '0';
      container.style.marginRight = 'auto';
    } else {
      container.style.display = 'block';
      container.style.marginLeft = '';
      container.style.marginRight = '';
    }
    this._afterChange();
  }
  deleteImage(container) { this._deleteImage(container || this.selectedImage); }

  _caretFromPoint(x, y) {
    if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
    if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y);
      if (pos) { const r = document.createRange(); r.setStart(pos.offsetNode, pos.offset); r.collapse(true); return r; }
    }
    return null;
  }

  _insertHTMLAtRange(range, html) {
    if (!range) {
      document.execCommand('insertHTML', false, html);
      return;
    }
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('insertHTML', false, html);
  }

  _blockInsertionRangeFromSelection() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return null;
    return this._blockInsertionRangeFromRange(sel.getRangeAt(0));
  }

  _blockInsertionRangeFromPoint(x, y) {
    const range = this._caretFromPoint(x, y);
    if (!range) return null;
    return this._blockInsertionRangeFromRange(range, y);
  }

  _blockInsertionRangeFromRange(range, clientY) {
    let block = this._blockFromNode(range.startContainer);
    if (!block || block === this.editor) return range;

    const out = document.createRange();
    if (block.classList && block.classList.contains('img-container')) {
      out.setStartAfter(block);
    } else if (block.classList && block.classList.contains('img-grid')) {
      out.setStartAfter(block);
    } else if (clientY != null && block.getBoundingClientRect) {
      const rect = block.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) out.setStartBefore(block);
      else out.setStartAfter(block);
    } else {
      out.setStartAfter(block);
    }
    out.collapse(true);
    return out;
  }

  _blockFromNode(node) {
    if (!node) return null;
    if (node.nodeType === 3) node = node.parentNode;
    while (node && node !== this.editor) {
      if (node.nodeType === 1) {
        const tag = node.tagName;
        if (/^(P|DIV|H[1-6]|LI|BLOCKQUOTE|PRE|TABLE|UL|OL|HR)$/.test(tag)) return node;
      }
      node = node.parentNode;
    }
    return this.editor;
  }

  _showDropIndicator(x, y) {
    const indicator = document.getElementById('dropIndicator');
    if (!indicator) return;
    const caret = this._caretFromPoint(x, y);
    if (!caret || !this.editor.contains(caret.startContainer)) {
      this._hideDropIndicator();
      return;
    }
    const block = this._blockFromNode(caret.startContainer);
    const editorRect = this.editor.getBoundingClientRect();
    const style = getComputedStyle(this.editor);
    let top;
    if (block && block !== this.editor && block.getBoundingClientRect) {
      const rect = block.getBoundingClientRect();
      top = y < rect.top + rect.height / 2 ? rect.top : rect.bottom;
    } else {
      top = Math.max(editorRect.top, Math.min(y, editorRect.bottom));
    }
    indicator.style.top = Math.round(top - 1) + 'px';
    indicator.style.left = Math.round(editorRect.left + parseFloat(style.paddingLeft || 0)) + 'px';
    indicator.style.right = Math.round(window.innerWidth - editorRect.right + parseFloat(style.paddingRight || 0)) + 'px';
    indicator.classList.add('visible');
  }

  _hideDropIndicator() {
    const indicator = document.getElementById('dropIndicator');
    if (indicator) indicator.classList.remove('visible');
  }
  /* ---------- 外部拖入图片文件 ---------- */
  _bindDragDrop() {
    let depth = 0;
    const showIndicator = (x, y) => this._showDropIndicator(x, y);
    const hideIndicator = () => this._hideDropIndicator();

    window.addEventListener('dragenter', (e) => {
      if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.indexOf('Files') >= 0) {
        depth++;
        if (this.dropOverlay) this.dropOverlay.classList.add('show');
      }
    });
    window.addEventListener('dragover', (e) => {
      if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.indexOf('Files') >= 0) {
        e.preventDefault();
        if (this.editor.contains(e.target)) showIndicator(e.clientX, e.clientY);
        else hideIndicator();
      }
    });
    window.addEventListener('dragleave', () => {
      depth--;
      if (depth <= 0) { depth = 0; if (this.dropOverlay) this.dropOverlay.classList.remove('show'); hideIndicator(); }
    });
    window.addEventListener('drop', async (e) => {
      hideIndicator();
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        const imgs = [];
        for (let i = 0; i < e.dataTransfer.files.length; i++) {
          const f = e.dataTransfer.files[i];
          if (f.type.indexOf('image/') === 0 || /\.(png|jpe?g|gif|bmp|webp)$/i.test(f.name)) imgs.push(f);
        }
        if (imgs.length) {
          e.preventDefault();
          if (this.dropOverlay) this.dropOverlay.classList.remove('show');
          depth = 0;
          const inEditor = this.editor.contains(e.target);
          let dropRange = inEditor
            ? this._blockInsertionRangeFromPoint(e.clientX, e.clientY)
            : null;
          if (!dropRange) {
            dropRange = document.createRange();
            dropRange.selectNodeContents(this.editor);
            dropRange.collapse(false);
          } else {
            dropRange = dropRange.cloneRange();
          }
          for (const f of imgs) {
            try {
              const url = await this._readAsDataURL(f);
              this.insertImage(url, dropRange);
              dropRange = this._blockInsertionRangeFromSelection() || dropRange;
            } catch (err) { this.onToast('图片插入失败：' + f.name); }
          }
          this.onToast('已插入 ' + imgs.length + ' 张图片');
        }
      }
      if (this.dropOverlay) this.dropOverlay.classList.remove('show');
      this.editor.querySelectorAll('.img-container.dragging').forEach(c => c.classList.remove('dragging'));
      this._removeImageDragPreview();
      depth = 0;
    });
  }

  _placeCaretAtEnd() {
    this.editor.focus();
    const range = document.createRange();
    range.selectNodeContents(this.editor);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  _readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
  }
  _blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }
  _compressToPNG(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth || img.width;
        c.height = img.naturalHeight || img.height;
        c.getContext('2d').drawImage(img, 0, 0);
        try { resolve(c.toDataURL('image/png')); } catch (_) { resolve(dataUrl); }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  /* ---------- 粘贴：有图片转 base64 插入；富文本保留公众号可视样式后插入 ---------- */
  _bindPaste() {
    this.editor.addEventListener('paste', async (e) => {
      const cd = e.clipboardData || window.clipboardData;
      if (!cd) return;
      this._prepareEmptyEditorForPaste();
      const html = cd.getData('text/html');
      if (html && this._shouldPasteAsHTML(html)) {
        e.preventDefault();
        const cleaned = this._cleanPastedHTML(html);
        document.execCommand('insertHTML', false, cleaned);
        setTimeout(() => this._afterPasteCleanup(), 60);
        return;
      }

      const items = cd.items || [];
      let imageItem = null;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.kind === 'file' && it.type && it.type.indexOf('image/') === 0) { imageItem = it; break; }
      }
      if (imageItem) {
        const blob = imageItem.getAsFile();
        if (blob) {
          e.preventDefault();
          let url = await this._blobToDataURL(blob);
          if (blob.type === 'image/bmp' || blob.type === '') url = await this._compressToPNG(url);
          this.insertImage(url);
          // 混合粘贴：同时追加文字
          const text = (cd.getData('text/plain') || '').trim();
          if (text) {
            setTimeout(() => {
              document.execCommand('insertHTML', false, this._escapeHtml(text).replace(/\n/g, '<br>'));
              this._afterChange();
            }, 60);
          }
          return;
        }
      }
      if (!html && this.imageClipboard && this.imageClipboard.html) {
        e.preventDefault();
        document.execCommand('insertHTML', false, this.imageClipboard.html);
        setTimeout(() => this._afterPasteCleanup(), 60);
        return;
      }
      // 无图片 file item：取 text/html，保留公众号编辑器依赖的内联样式
      if (html) {
        e.preventDefault();
        const cleaned = this._cleanPastedHTML(html);
        document.execCommand('insertHTML', false, cleaned);
        setTimeout(() => this._afterPasteCleanup(), 60);
      } else {
        // 纯文本：若含 URL 则自动转为超链接，否则放行默认
        const text = cd.getData('text/plain') || '';
        if (text && /(?:https?:\/\/|www\.|(?:[a-z0-9-]+\.)+[a-z]{2,})/i.test(text)) {
          e.preventDefault();
          const html = this._linkifyPlainText(text);
          document.execCommand('insertHTML', false, html);
          setTimeout(() => this._afterPasteCleanup(), 60);
        } else {
          setTimeout(() => this._afterPasteCleanup(), 60);
        }
      }
    });
  }

  _linkifyPlainText(text) {
    const escaped = this._escapeHtml(text).replace(/\n/g, '<br>');
    return escaped.replace(/(^|[\s([{])((?:https?:\/\/|www\.|(?:[a-z0-9-]+\.)+[a-z]{2,})[^\s<]*)/ig,
      (all, prefix, raw) => {
        const match = raw.match(/^(.*?)([.,!?;:，。！？；：)\]]*)$/);
        const url = match ? match[1] : raw;
        const trailing = match ? match[2] : '';
        const href = this._normalizeUrl(url);
        if (!href) return all;
        return prefix + '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + url + '</a>' + trailing;
      });
  }
  _prepareEmptyEditorForPaste() {
    const hasContent = (this.editor.textContent || '').trim() ||
      this.editor.querySelector('img, table, hr, video, audio, iframe');
    if (hasContent) return;
    this.editor.innerHTML = '<p><br></p>';
    const range = document.createRange();
    range.selectNodeContents(this.editor.firstElementChild);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  _shouldPasteAsHTML(html) {
    const s = String(html || '');
    if (!/<[a-z][\s\S]*>/i.test(s)) return false;
    if (/<(section|div|p|span|h[1-6]|table|ul|ol|blockquote)\b/i.test(s)) return true;
    if (/\sstyle\s*=|\sclass\s*=|\sdata-/i.test(s)) return true;
    return false;
  }

  /* 清理粘贴 HTML：保留视觉样式，移除脚本、事件属性和危险 URL */
  _cleanPastedHTML(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script, iframe, object, embed, link, meta').forEach(n => n.remove());
    const urlAttrs = new Set(['href', 'src', 'xlink:href']);
    const walk = (node) => {
      if (node.nodeType !== 1) return;
      const toRemove = [];
      for (const attr of node.attributes) {
        const name = attr.name.toLowerCase();
        const value = String(attr.value || '').trim();
        if (name.startsWith('on')) {
          toRemove.push(attr.name);
        } else if (urlAttrs.has(name) && /^javascript:/i.test(value)) {
          toRemove.push(attr.name);
        } else if (name === 'style') {
          node.setAttribute('style', this._sanitizeStyle(value));
          if (!node.getAttribute('style')) toRemove.push(attr.name);
        }
      }
      toRemove.forEach(a => node.removeAttribute(a));
      Array.prototype.slice.call(node.childNodes).forEach(walk);
    };
    walk(doc.body);
    this._postCleanPastedDOM(doc.body);
    return doc.body.innerHTML;
  }

  _sanitizeStyle(styleText) {
    return String(styleText || '')
      .split(';')
      .map(s => s.trim())
      .filter(Boolean)
      .filter(s => !/expression\s*\(/i.test(s))
      .filter(s => !/url\s*\(\s*['"]?\s*javascript:/i.test(s))
      .join('; ');
  }

  /* 粘贴 HTML 后的结构清理：去 style/svg/追踪像素/空行/超宽/懒加载兜底 */
  _postCleanPastedDOM(body) {
    // 1. 移除样式标签、SVG 图标、表单元素、noscript 等
    body.querySelectorAll('style, svg, noscript, template, form, input, button, textarea, select, link').forEach(n => n.remove());

    // 2. 懒加载兜底：公众号常用 data-src，如果 src 为空或占位，提升 data-src 为 src
    body.querySelectorAll('img').forEach(img => {
      const src = (img.getAttribute('src') || '').trim();
      const dataSrc = (img.getAttribute('data-src') || '').trim();
      if (dataSrc && /^https?:\/\//i.test(dataSrc)) {
        if (!src || /loading|placeholder|blank|data:image\/gif/i.test(src)) {
          img.setAttribute('src', dataSrc);
        }
      }
    });

    // 3. 移除追踪像素（1x1 图片或 display:none 的图片）
    body.querySelectorAll('img').forEach(img => {
      const w = parseInt(img.getAttribute('width') || '0', 10);
      const h = parseInt(img.getAttribute('height') || '0', 10);
      const style = img.getAttribute('style') || '';
      const isTiny = (w > 0 && w <= 1) || (h > 0 && h <= 1);
      const isHidden = /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style);
      if (isTiny || isHidden) img.remove();
    });

    // 4. 移除空行元素（无文字无图片的 span/div/section/p），迭代直到稳定
    let changed = true, iter = 0;
    while (changed && iter < 5) {
      changed = false; iter++;
      body.querySelectorAll('span, div, section, p').forEach(el => {
        if (el.childNodes.length === 0 || (!el.textContent.trim() && !el.querySelector('img'))) {
          // 保留 <p><br></p> 作为空行占位
          if (el.tagName === 'P' && el.querySelector('br') && !el.textContent.trim()) return;
          el.remove();
          changed = true;
        }
      });
    }

    // 5. 收敛连续空行：3+ 连续 <br> → 1 个 <br>；连续空 <p> → 最多 1 个
    body.querySelectorAll('br').forEach(br => {
      let next = br.nextSibling;
      while (next && next.nodeType === 3 && !next.textContent.trim()) next = next.nextSibling;
      if (next && next.tagName === 'BR') br.remove();
    });
    let emptyCount = 0;
    body.querySelectorAll('p, div').forEach(b => {
      if (!b.textContent.trim() && !b.querySelector('img')) {
        emptyCount++;
        if (emptyCount > 1) b.remove();
      } else {
        emptyCount = 0;
      }
    });

    // 6. 限制超宽元素：style 中 width: XXXpx 超过编辑器宽度的缩到 95%
    const maxW = this._editorContentWidth();
    body.querySelectorAll('[style]').forEach(el => {
      const s = el.getAttribute('style') || '';
      const limited = s.replace(/width\s*:\s*(\d+(?:\.\d+)?)px/g, (match, val) => {
        const v = parseFloat(val);
        return v > maxW ? 'width:' + Math.floor(maxW * 0.95) + 'px' : match;
      });
      if (limited !== s) el.setAttribute('style', limited);
    });

    // 7. 清理粘贴内容中的 data-* 追踪属性（保留 data-src 已提升，data-type 是自己的）
    body.querySelectorAll('*').forEach(el => {
      const toRemove = [];
      for (const attr of el.attributes) {
        if (attr.name.startsWith('data-') && attr.name !== 'data-type' && attr.name !== 'data-src') {
          toRemove.push(attr.name);
        }
      }
      toRemove.forEach(a => el.removeAttribute(a));
    });
  }

  /* 远程图转 base64 固化：粘贴后异步把 http(s) 图片拉回本地，防丢图 */
  async _convertRemoteImages() {
    const imgs = Array.from(this.editor.querySelectorAll('img'));
    const remote = [];
    for (const img of imgs) {
      let src = (img.getAttribute('src') || '').trim();
      // 懒加载兜底
      const dataSrc = (img.getAttribute('data-src') || '').trim();
      if (dataSrc && /^https?:\/\//i.test(dataSrc) && (!src || !/^https?:\/\//i.test(src))) {
        src = dataSrc;
        img.setAttribute('src', src);
      }
      if (/^https?:\/\//i.test(src)) remote.push({ img, src });
    }
    if (remote.length === 0) return;

    const total = remote.length;
    this.onToast('正在固化 ' + total + ' 张远程图片…');
    let done = 0, failed = 0;

    // 并发 3 张一批，避免阻塞
    const batchSize = 3;
    for (let i = 0; i < remote.length; i += batchSize) {
      const batch = remote.slice(i, i + batchSize);
      await Promise.all(batch.map(async ({ img, src }) => {
        try {
          const r = await fetch('/api/proxy-image?url=' + encodeURIComponent(src), { credentials: 'same-origin' });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const data = await r.json();
          if (data.dataUrl) {
            img.setAttribute('src', data.dataUrl);
            const container = img.closest('.img-container');
            if (container) this._attachImgLoad(container);
            done++;
          }
        } catch (err) {
          failed++;
          // 远程 URL 保留作兜底，至少在线时能看
        }
      }));
    }

    if (done > 0) {
      this.onToast('已固化 ' + done + '/' + total + ' 张图片' + (failed > 0 ? '，' + failed + '张失败' : ''));
      this._afterChange();
    } else if (failed > 0) {
      this.onToast('图片固化失败，已保留远程链接');
    }
  }

  /* 粘贴后统一清理流程 */
  _afterPasteCleanup() {
    this.normalizeLinkCards();
    this.fixImageContainers();
    this.normalizeTables();
    this._afterChange();
    this._convertRemoteImages(); // 异步 fire-and-forget，完成后会再次 _afterChange
  }

  /* ---------- Markdown 快捷输入 ---------- */
  _bindMarkdownShortcut() {
    this.editor.addEventListener('keydown', (e) => {
      if (e.key !== ' ' && e.key !== 'Enter') return;
      const block = this._currentBlock();
      if (!block) return;
      const sel = window.getSelection();
      if (!sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      const testRange = range.cloneRange();
      testRange.selectNodeContents(block);
      testRange.setEnd(range.endContainer, range.endOffset);
      const before = testRange.toString();
      const patterns = [
        { re: /^# $/, type: 'h1' }, { re: /^## $/, type: 'h2' },
        { re: /^### $/, type: 'h3' }, { re: /^#### $/, type: 'h4' },
        { re: /^- $/, type: 'ul' }, { re: /^\* $/, type: 'ul' },
        { re: /^> $/, type: 'quote' }, { re: /^``` $/, type: 'code' },
        { re: /^1\. $/, type: 'ol' },
        { re: /^\[\] $/, type: 'todo' }, { re: /^\[ \] $/, type: 'todo' }
      ];
      for (const p of patterns) {
        if (p.re.test(before)) {
          e.preventDefault();
          const delRange = document.createRange();
          const firstChild = block.firstChild || block;
          delRange.setStart(firstChild, 0);
          delRange.setEnd(range.endContainer, range.endOffset);
          sel.removeAllRanges();
          sel.addRange(delRange);
          document.execCommand('delete');
          if (p.type === 'quote') document.execCommand('formatBlock', false, '<BLOCKQUOTE>');
          else if (p.type === 'code') document.execCommand('formatBlock', false, '<PRE>');
          else if (p.type === 'ul') document.execCommand('insertUnorderedList');
          else if (p.type === 'ol') document.execCommand('insertOrderedList');
          else if (p.type === 'todo') this._insertTodoBlock();
          else document.execCommand('formatBlock', false, '<' + p.type.toUpperCase() + '>');
          this._afterChange();
          return;
        }
      }

      // Enter 键续号：中文编号「N、」与待办事项
      if (e.key === 'Enter') {
        const text = (block.textContent || '').trim();
        // 1) 中文编号续号：形如「1、内容」「12、内容」「1、」
        // 规则：
        //   - 光标在「N、」之后（段落中间或末尾）→ 在当前段后插入新段落「N+1、」
        //   - 光标在「N、」之前或中间（即光标在编号前缀范围内）→ 在当前段前插入空段落，
        //     光标停在新空段，让用户能在编号上方插入「标题/前言」等内容
        //   - 退出续号：用户用 Backspace 删除「N、」前缀即可
        // 不再用「空 N、 + Enter → 退出」的规则，因为容易与「输入内容后回车续号」混淆。
        const cnMatch = text.match(/^(\d+)、([\s\S]*)$/);
        if (cnMatch) {
          const prefixLen = (cnMatch[1] + '、').length; // 「N、」的字符长度
          const caretOffset = this._caretOffsetInBlock(block);
          // 光标在「N、」之前（包括「1」与「、」之间）：在前面插空段，不续号
          if (caretOffset >= 0 && caretOffset < prefixLen) {
            e.preventDefault();
            const emptyP = document.createElement('p');
            emptyP.innerHTML = '<br>';
            if (block.parentNode) {
              block.parentNode.insertBefore(emptyP, block);
              this._placeCaretAtStart(emptyP);
            }
            this._afterChange();
            return;
          }
          // 光标在「N、」之后（段落内容部分）：续号
          const nextNum = parseInt(cnMatch[1], 10) + 1;
          e.preventDefault();
          const newP = document.createElement('p');
          newP.innerHTML = nextNum + '、';
          if (block.parentNode) {
            block.parentNode.insertBefore(newP, block.nextSibling);
            // 光标放在「N+1、」之后，让用户直接接着输入内容
            this._placeCaretAtEnd(newP);
          }
          this._afterChange();
          return;
        }
        // 2) 待办回车续号：todo-item 里回车 → 新建空待办；空待办回车 → 转回普通段
        if (block.classList && block.classList.contains('todo-item')) {
          const inner = (block.textContent || '').trim();
          if (!inner) {
            // 空待办回车 → 转为普通段，退出续号
            e.preventDefault();
            const p = document.createElement('p');
            p.innerHTML = '<br>';
            if (block.parentNode) {
              block.parentNode.replaceChild(p, block);
              this._placeCaretAtStart(p);
            }
            this._afterChange();
            return;
          }
          e.preventDefault();
          const newItem = this._buildTodoItem('');
          if (block.parentNode) {
            block.parentNode.insertBefore(newItem, block.nextSibling);
            // 光标放进新待办的 .todo-text 里（而不是 todo-item 整体的开头，否则会在 .todo-check 左侧）
            this._placeCaretAtStart(newItem.querySelector('.todo-text') || newItem);
          }
          this._afterChange();
          return;
        }
      }
    });
  }

  // 构造一个待办事项 DOM：.todo-item > .todo-check + 文本
  _buildTodoItem(text) {
    const div = document.createElement('div');
    div.className = 'todo-item';
    div.setAttribute('data-type', 'todo');
    const check = document.createElement('span');
    check.className = 'todo-check';
    check.setAttribute('contenteditable', 'false');
    check.setAttribute('role', 'checkbox');
    check.setAttribute('aria-checked', 'false');
    div.appendChild(check);
    const txt = document.createElement('span');
    txt.className = 'todo-text';
    txt.innerHTML = text || '\u200B';
    div.appendChild(txt);
    return div;
  }

  // 在当前光标处插入一个待办事项块
  _insertTodoBlock() {
    const sel = window.getSelection();
    const item = this._buildTodoItem('\u200B');
    if (sel.rangeCount) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(item);
    } else {
      this.editor.appendChild(item);
    }
    // 后面留一个空段落，方便继续输入普通文字
    const p = document.createElement('p');
    p.innerHTML = '<br>';
    if (item.parentNode) {
      item.parentNode.insertBefore(p, item.nextSibling);
    }
    this._placeCaretAtStart(item.querySelector('.todo-text') || item);
  }

  // 把光标定位到节点开头
  _placeCaretAtStart(node) {
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // 把光标定位到节点末尾
  _placeCaretAtEnd(node) {
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // 获取光标在 block 内的字符偏移量（用于判断光标在「N、」之前/之后）
  // 返回 -1 表示光标不在 block 内
  _caretOffsetInBlock(block) {
    const sel = document.getSelection();
    if (!sel || !sel.rangeCount) return -1;
    const range = sel.getRangeAt(0);
    if (!block.contains(range.endContainer)) return -1;
    const preRange = range.cloneRange();
    preRange.selectNodeContents(block);
    preRange.setEnd(range.endContainer, range.endOffset);
    return preRange.toString().length;
  }

  // 待办勾选交互：点击 .todo-check 切换 .checked + .todo-item.done
  _bindTodoInteraction() {
    this.editor.addEventListener('click', (e) => {
      const check = e.target.closest('.todo-check');
      if (!check) return;
      const item = check.closest('.todo-item');
      const checked = check.classList.toggle('checked');
      check.setAttribute('aria-checked', checked ? 'true' : 'false');
      if (item) item.classList.toggle('done', checked);
      this._afterChange();
    });
  }

  _currentBlock() {
    const sel = document.getSelection();
    if (!sel.rangeCount) return null;
    let node = sel.anchorNode;
    // 兜底：光标在 #editor 直接子节点上（loose 文本/内联节点），没有 <p> 包裹时，
    // 把它就地包进 <p>，让后续逻辑能找到一个 block。selection 会跟随 textNode 移动。
    if (node && node.parentNode === this.editor) {
      const isLooseText = node.nodeType === 3 ||
        (node.nodeType === 1 && !/^(P|H1|H2|H3|H4|H5|H6|BLOCKQUOTE|PRE|LI|DIV|TABLE|HR|IMG)$/.test(node.tagName));
      if (isLooseText) {
        const p = document.createElement('p');
        this.editor.insertBefore(p, node);
        p.appendChild(node);
        return p;
      }
      if (node.nodeType === 1) return node;
    }
    while (node && node !== this.editor) {
      if (node.nodeType === 1) {
        const tag = node.tagName;
        if (/^(P|H1|H2|H3|H4|H5|H6|BLOCKQUOTE|PRE|LI|DIV)$/.test(tag)) return node;
      }
      node = node.parentNode;
    }
    return null;
  }

  _restoreCaretInBlock(block) {
    if (!block) return;
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(block);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  moveCurrentBlock(direction) {
    const block = this._currentBlock();
    if (!block || block === this.editor) return false;
    const parent = block.parentNode;
    if (!parent) return false;
    const target = direction < 0 ? block.previousElementSibling : block.nextElementSibling;
    if (!target) return false;
    if (direction < 0) parent.insertBefore(block, target);
    else parent.insertBefore(target, block);
    this._restoreCaretInBlock(block);
    this._afterChange();
    return true;
  }

  formatBlock(tag) {
    this.exec('formatBlock', '<' + tag + '>');
  }

  /* ---------- 块级操作（右键菜单用） ---------- */
  selectBlock(block) {
    if (!block) return;
    const range = document.createRange();
    range.selectNodeContents(block);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  deleteCurrentBlock() {
    const block = this._currentBlock();
    if (!block || block === this.editor) return;
    const p = document.createElement('p');
    p.innerHTML = '<br>';
    block.parentNode.replaceChild(p, block);
    this._restoreCaretInBlock(p);
    this._afterChange();
  }

  duplicateCurrentBlock() {
    const block = this._currentBlock();
    if (!block || block === this.editor) return;
    const clone = block.cloneNode(true);
    // 重新生成图片容器 id，避免重复
    clone.querySelectorAll('[id^="pm"]').forEach(el => { el.id = this._uid(); });
    block.parentNode.insertBefore(clone, block.nextSibling);
    this._restoreCaretInBlock(clone);
    this._afterChange();
  }

  cutCurrentBlock() {
    const block = this._currentBlock();
    if (!block || block === this.editor) return;
    this.selectBlock(block);
    try { document.execCommand('cut'); } catch (_) {}
    setTimeout(() => this._afterChange(), 30);
  }

  copyCurrentBlock() {
    const block = this._currentBlock();
    if (!block || block === this.editor) return;
    this.selectBlock(block);
    try { document.execCommand('copy'); } catch (_) {}
    // 复制后恢复光标到块内
    setTimeout(() => this._restoreCaretInBlock(block), 30);
  }

  /* ---------- 链接卡片 ---------- */
  // 将一个 <a> 链接转为富卡片：抓取 OG 元数据后替换
  _maybeAutoLink(e) {
    if (e && e.inputType && !/^insert(Text|Paragraph|LineBreak)$/.test(e.inputType)) return;
    if (e && e.inputType === 'insertText' && e.data && !/[\s\u00a0]/.test(e.data)) return;

    const sel = window.getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    let node = range.startContainer;
    let offset = range.startOffset;
    if (node.nodeType !== 3) return;
    if (this._closest(node, 'a, code, pre, .link-card')) return;

    const before = node.textContent.slice(0, offset);
    const suffixMatch = before.match(/[\s\u00a0]+$/);
    const suffix = suffixMatch ? suffixMatch[0] : '';
    const body = suffix ? before.slice(0, -suffix.length) : before;
    const match = body.match(/(?:^|[\s([{])((?:(?:https?:\/\/|www\.)[^\s<>'"]{3,}|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>'"]*)?))$/i);
    if (!match) return;

    const rawUrl = match[1].replace(/[.,!?;:]+$/g, '');
    if (!rawUrl || /^https?:\/\/$/i.test(rawUrl)) return;
    const urlStart = body.length - match[1].length;
    const urlEnd = urlStart + rawUrl.length;
    const href = this._normalizeUrl(rawUrl);
    if (!href) return;

    const linkRange = document.createRange();
    linkRange.setStart(node, urlStart);
    linkRange.setEnd(node, urlEnd);
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = rawUrl;
    linkRange.deleteContents();
    linkRange.insertNode(a);

    const after = a.nextSibling;
    const caret = document.createRange();
    if (after && after.nodeType === 3) caret.setStart(after, Math.min(suffix.length, after.textContent.length));
    else caret.setStartAfter(a);
    caret.collapse(true);
    sel.removeAllRanges();
    sel.addRange(caret);
  }

  _normalizeUrl(raw) {
    const text = String(raw || '').trim();
    if (/^https?:\/\//i.test(text)) return text;
    if (/^www\./i.test(text)) return 'https://' + text;
    if (/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/:?#].*)?$/i.test(text)) return 'https://' + text;
    return '';
  }

  _closest(node, selector) {
    if (!node) return null;
    const el = node.nodeType === 1 ? node : node.parentElement;
    return el && el.closest ? el.closest(selector) : null;
  }

  normalizeLinkCards() {
    this.editor.querySelectorAll('a[data-link-card="1"]').forEach(card => {
      const thumb = card.querySelector('.lc-thumb');
      if (thumb) {
        const wrapped = thumb.querySelector('.img-container');
        if (wrapped) {
          const img = wrapped.querySelector('img');
          if (img) {
            img.style.width = '';
            img.style.height = '';
            img.removeAttribute('width');
            img.removeAttribute('height');
            img.setAttribute('draggable', 'false');
            thumb.insertBefore(img, wrapped);
          }
          wrapped.remove();
        }
        thumb.querySelectorAll('.rs-handle, .img-size-label').forEach(n => n.remove());        thumb.title = '打开链接';
        thumb.setAttribute('role', 'button');
        thumb.setAttribute('aria-label', '打开链接');
      }
      const open = card.querySelector('.lc-open');
      if (open) {
        open.title = '打开链接';
        open.setAttribute('aria-label', '打开链接');
      }
    });
  }
  async convertLinkToCard(anchor) {
    if (!anchor || anchor.tagName !== 'A') return;
    const url = anchor.getAttribute('href');
    if (!url) return;
    this.onToast('正在生成链接卡片…');
    try {
      const r = await fetch('/api/og?url=' + encodeURIComponent(url), { credentials: 'same-origin' });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || 'HTTP ' + r.status); }
      const meta = await r.json();
      const card = this._buildLinkCard(meta);
      // 用卡片替换链接；若链接独占一个块则替换整块，否则替换链接节点
      const block = this._currentBlock();
      if (block && block.textContent.trim() === anchor.textContent.trim()) {
        block.parentNode.replaceChild(card, block);
      } else {
        anchor.parentNode.replaceChild(card, anchor);
      }
      this._afterChange();
      this.onToast('已生成卡片');
    } catch (e) {
      this.onToast('卡片生成失败：' + (e.message || e));
    }
  }

  _buildLinkCard(meta) {
    const card = document.createElement('a');
    card.className = 'link-card';
    card.href = meta.url;
    card.target = '_blank';
    card.rel = 'noopener noreferrer';
    card.setAttribute('contenteditable', 'false');
    card.setAttribute('data-link-card', '1');
    const main = document.createElement('div');
    main.className = 'lc-main';
    const title = document.createElement('div');
    title.className = 'lc-title';
    title.textContent = meta.title || meta.domain;
    main.appendChild(title);
    if (meta.description) {
      const desc = document.createElement('div');
      desc.className = 'lc-desc';
      desc.textContent = meta.description;
      main.appendChild(desc);
    }
    const dom = document.createElement('div');
    dom.className = 'lc-domain';
    dom.textContent = meta.domain;
    main.appendChild(dom);
    card.appendChild(main);
    const open = document.createElement('span');
    open.className = 'lc-open';
    open.title = '打开链接';
    open.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7,7 17,7 17,17"/></svg>';
    open.setAttribute('aria-label', '打开链接');
    card.appendChild(open);
    if (meta.image) {
      const thumb = document.createElement('div');
      thumb.className = 'lc-thumb';
      thumb.title = '打开链接';
      thumb.setAttribute('role', 'button');
      thumb.setAttribute('aria-label', '打开链接');
      const img = document.createElement('img');
      img.src = meta.image;
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.onerror = () => { thumb.remove(); if (!card.querySelector('.lc-thumb')) card.classList.add('no-thumb'); };
      thumb.appendChild(img);
      card.appendChild(thumb);
    } else {
      card.classList.add('no-thumb');
    }
    return card;
  }

  // 取消链接：保留文字，去掉 <a>
  unwrapLink(anchor) {
    if (!anchor || anchor.tagName !== 'A') return;
    const parent = anchor.parentNode;
    while (anchor.firstChild) parent.insertBefore(anchor.firstChild, anchor);
    parent.removeChild(anchor);
    this._afterChange();
  }

  // 链接卡片 → 普通链接
  convertCardToLink(card) {
    if (!card || card.getAttribute('data-link-card') !== '1') return;
    const url = card.getAttribute('href');
    if (!url) return;
    const titleEl = card.querySelector('.lc-title');
    const text = titleEl ? titleEl.textContent.trim() : url;
    const domainEl = card.querySelector('.lc-domain');
    const display = domainEl ? domainEl.textContent.trim() : text;
    // 构建普通链接 <a>
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = display;
    // 若卡片独占一个块则替换整块，否则替换卡片节点
    const block = this._currentBlock();
    if (block && block.textContent.trim() === card.textContent.trim()) {
      block.parentNode.replaceChild(a, block);
    } else {
      card.parentNode.replaceChild(a, card);
    }
    this._afterChange();
  }

  _bindKeydown() {
    this.editor.addEventListener('keydown', (e) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (e.key === 'Tab') {
        const cell = this._currentTableCell();
        if (cell) {
          e.preventDefault();
          const cells = Array.from(cell.closest('table').querySelectorAll('th,td'));
          let idx = cells.indexOf(cell) + (e.shiftKey ? -1 : 1);
          if (idx < 0) idx = 0;
          if (idx >= cells.length) { this._insertTableRow(cell.parentNode, 1); this._afterChange(); return; }
          this._restoreCaretInBlock(cells[idx]);
          return;
        }
        e.preventDefault();
        document.execCommand(e.shiftKey ? 'outdent' : 'indent');
        this._afterChange();
        return;
      }
      if (e.altKey && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        this.moveCurrentBlock(e.key === 'ArrowUp' ? -1 : 1);
        return;
      }
      if (!ctrl) return;
      const k = e.key.toLowerCase();
      const code = e.code || '';
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); this.undo(); }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); this.redo(); }
      else if (k === 'b' && !e.shiftKey && !e.altKey) { e.preventDefault(); this.exec('bold'); }
      else if (k === 'i' && !e.shiftKey && !e.altKey) { e.preventDefault(); this.exec('italic'); }
      else if (k === 'u' && !e.shiftKey && !e.altKey) { e.preventDefault(); this.exec('underline'); }
      else if (k === 'x' && e.shiftKey && !e.altKey) { e.preventDefault(); this.exec('strikeThrough'); }
      else if (k === 'k' && !e.shiftKey && !e.altKey) { e.preventDefault(); this.insertLink(); }
      else if (k === '\\' && !e.shiftKey && !e.altKey) { e.preventDefault(); this.exec('removeFormat'); }
      else if (e.altKey && /^[0-6]$/.test(k)) {
        e.preventDefault();
        const tags = { '0':'P', '1':'H1', '2':'H2', '3':'H3', '4':'H4', '5':'H5', '6':'H6' };
        this.formatBlock(tags[k]);
      }
      else if (e.altKey && k === 'q') { e.preventDefault(); this.formatBlock('BLOCKQUOTE'); }
      else if (e.altKey && k === '`') { e.preventDefault(); this.formatBlock('PRE'); }
      else if (e.shiftKey && (k === '7' || k === '&' || code === 'Digit7') && !e.altKey) { e.preventDefault(); this.exec('insertOrderedList'); }
      else if (e.shiftKey && (k === '8' || k === '*' || code === 'Digit8') && !e.altKey) { e.preventDefault(); this.exec('insertUnorderedList'); }
      else if (e.shiftKey && k === 'l' && !e.altKey) { e.preventDefault(); this.exec('justifyLeft'); }
      else if (e.shiftKey && k === 'e' && !e.altKey) { e.preventDefault(); this.exec('justifyCenter'); }
      else if (e.shiftKey && k === 'r' && !e.altKey) { e.preventDefault(); this.exec('justifyRight'); }
      else if (e.shiftKey && k === 'j' && !e.altKey) { e.preventDefault(); this.exec('justifyFull'); }
      else if (e.shiftKey && k === 'm' && !e.altKey) { e.preventDefault(); this.insertCodeInline(); }
      else if (e.altKey && k === 'c') { e.preventDefault(); this.insertCodeBlock(); }
      else if (e.altKey && k === 't') { e.preventDefault(); this.insertTable(3, 3); }
      else if (e.altKey && k === 'h') { e.preventDefault(); this.insertHR(); }
    });
  }

  /* ---------- 工具栏状态 ---------- */
  refreshToolbarState(btns, blockSel) {
    const cmds = ['bold', 'italic', 'underline', 'strikeThrough'];
    Array.prototype.forEach.call(btns, b => {
      const c = b.getAttribute('data-cmd');
      if (c && cmds.indexOf(c) >= 0) {
        try { b.classList.toggle('active', document.queryCommandState(c)); } catch (_) {}
      }
    });
    if (blockSel) {
      try {
        let bt = (document.queryCommandValue('formatBlock') || '').toUpperCase().replace(/[<>]/g, '');
        const map = { P:'P',H1:'H1',H2:'H2',H3:'H3',H4:'H4',BLOCKQUOTE:'BLOCKQUOTE',PRE:'PRE',DIV:'P','':'P' };
        blockSel.value = map[bt] || 'P';
      } catch (_) {}
    }
  }

  /* ---------- 统计 ---------- */
  getStats() {
    const text = (this.editor.innerText || '').replace(/\s/g, '');
    const imgs = this.editor.querySelectorAll('.img-container img');
    return { chars: text.length, imgs: imgs.length };
  }

  /* ---------- 内容读写 ---------- */
  getHTML() { return this._snapshotHTML(); }
  setHTML(html) {
    this.activeTableCell = null;
    this.tableSelection = null;
    this.editor.innerHTML = html || '<p><br></p>';
    this.normalizeLinkCards();
    this.fixImageContainers();
    this.normalizeTables();
    this._renderTableSelection();
    this._afterChange();
  }
  clear() {
    this.activeTableCell = null;
    this.tableSelection = null;
    this.editor.innerHTML = '<p><br></p>';
    this._selectImage(null);
    this._renderTableSelection();
    this._afterChange();
  }

  /* ---------- 导出 ---------- */
  buildSelfContainedHTML() {
    const content = this._processExportContent();
    return [
'<!DOCTYPE html>','<html lang="zh-CN"><head><meta charset="UTF-8">','<meta name="viewport" content="width=device-width, initial-scale=1.0">','<title>知著 PenMark 文档</title>','<style>',
'body{background:#faf8f3;color:#2b2a27;font-family:"Songti SC","Source Han Serif SC","SimSun",Georgia,serif;margin:0;padding:40px 0;}',
'.doc{max-width:780px;margin:0 auto;padding:50px 70px;background:#fdfbf5;border:1px solid #e6e0d4;border-radius:8px;line-height:1.85;font-size:17px;}',
'.doc h1{font-size:1.9em;margin:1.2em 0 .6em;}.doc h2{font-size:1.5em;margin:1.1em 0 .5em;}.doc h3{font-size:1.2em;margin:1em 0 .4em;}',
'.doc p{margin:.6em 0;}.doc blockquote{margin:.8em 0;padding:.4em 1.1em;border-left:3px solid #c9bc9a;background:#f5f0e3;color:#6b6660;border-radius:0 4px 4px 0;font-style:italic;}',
'.doc ul,.doc ol{margin:.6em 0;padding-left:1.8em;}.doc li{margin:.25em 0;}.doc hr{border:none;border-top:1px solid #e6e0d4;margin:1.6em 0;}',
'.doc pre{background:#f0ece0;border:1px solid #d9d2bf;border-radius:6px;padding:14px 16px;overflow-x:auto;font-family:Consolas,monospace;font-size:13.5px;}',
'.doc code{background:#f0ece0;border-radius:3px;padding:1px 5px;font-family:Consolas,monospace;}',
'.doc table{border-collapse:collapse;width:100%;margin:.8em 0;}.doc th,.doc td{border:1px solid #e6e0d4;padding:8px 12px;}.doc th{background:#efe9dc;}',
'.doc .img-container{display:block;text-align:center;margin:8px auto;max-width:100%;}.doc .img-container img{max-width:100%;height:auto;}',
'</style></head><body><div class="doc">' + content + '</div></body></html>'
    ].join('\n');
  }

  toMarkdown() {
    const lines = [];
    const innerText = n => n.textContent || '';
    const tableToMarkdown = table => this._tableToMarkdown(table);
    function walk(node) {
      let n = node.firstChild;
      while (n) {
        if (n.nodeType === 3) { lines.push(n.textContent.replace(/\n/g, ' ')); n = n.nextSibling; continue; }
        if (n.nodeType !== 1) { n = n.nextSibling; continue; }
        const tag = n.tagName.toLowerCase();
        switch (tag) {
          case 'h1': lines.push('\n# ' + innerText(n) + '\n'); break;
          case 'h2': lines.push('\n## ' + innerText(n) + '\n'); break;
          case 'h3': lines.push('\n### ' + innerText(n) + '\n'); break;
          case 'h4': lines.push('\n#### ' + innerText(n) + '\n'); break;
          case 'p': lines.push('\n' + innerText(n) + '\n'); break;
          case 'br': lines.push('\n'); break;
          case 'blockquote': lines.push('\n' + innerText(n).split('\n').map(s => '> ' + s).join('\n') + '\n'); break;
          case 'ul': lines.push(''); Array.prototype.forEach.call(n.querySelectorAll(':scope > li'), li => lines.push('- ' + innerText(li).trim())); lines.push(''); break;
          case 'ol': lines.push(''); let i = 1; Array.prototype.forEach.call(n.querySelectorAll(':scope > li'), li => lines.push((i++) + '. ' + innerText(li).trim())); lines.push(''); break;
          case 'hr': lines.push('\n---\n'); break;
          case 'pre': lines.push('\n```\n' + innerText(n) + '\n```\n'); break;
          case 'table': lines.push(tableToMarkdown(n)); break;
          case 'div':
          case 'span':
            if (n.classList.contains('img-container')) {
              const im = n.querySelector('img');
              if (im && im.getAttribute('src')) lines.push('\n![](' + im.getAttribute('src') + ')\n');
              else walk(n);
            } else walk(n);
            break;
          case 'img': if (n.getAttribute('src')) lines.push('\n![](' + n.getAttribute('src') + ')\n'); break;
          case 'b': case 'strong': lines.push('**' + innerText(n) + '**'); break;
          case 'i': case 'em': lines.push('*' + innerText(n) + '*'); break;
          case 's': case 'del': lines.push('~~' + innerText(n) + '~~'); break;
          case 'code': lines.push('`' + innerText(n) + '`'); break;
          case 'a': lines.push('[' + innerText(n) + '](' + (n.getAttribute('href') || '') + ')'); break;
          default: walk(n);
        }
        n = n.nextSibling;
      }
    }
    walk(this.editor);
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  /* 导出前处理：把图片容器的尺寸转移到 img 上，去掉手柄/标签，grid 转表格 */
  _tableToMarkdown(table) {
    const rows = Array.from(table.rows || []);
    if (!rows.length) return '';
    const matrix = rows.map(row => Array.from(row.cells).map(cell => (cell.textContent || '').trim().replace(/\|/g, '\\|')));
    const cols = matrix.reduce((m, row) => Math.max(m, row.length), 0);
    if (!cols) return '';
    const pad = row => Array.from({ length: cols }, (_, i) => row[i] || '');
    const header = pad(matrix[0]);
    const sep = header.map(() => '---');
    const body = matrix.slice(1).map(pad);
    return '\n| ' + header.join(' | ') + ' |\n| ' + sep.join(' | ') + ' |' + (body.length ? '\n' + body.map(row => '| ' + row.join(' | ') + ' |').join('\n') : '') + '\n';
  }

  _processExportContent() {
    const clone = this.editor.cloneNode(true);
    const origContainers = Array.from(this.editor.querySelectorAll('.img-container'));
    // Word A4 页面内容区宽 ≈ 415pt ≈ 553px（96 DPI），留余量后 cap 到 530px
    const MAX_IMG_W = 530;
    // img-grid → 表格（Word 不支持 CSS Grid）
    clone.querySelectorAll('.img-grid').forEach(grid => {
      const items = Array.from(grid.querySelectorAll(':scope > .img-container'));
      if (items.length === 0) { grid.remove(); return; }
      const table = clone.ownerDocument.createElement('table');
      table.setAttribute('cellspacing', '0');
      table.setAttribute('cellpadding', '4');
      table.style.width = '100%';
      const tr = clone.ownerDocument.createElement('tr');
      // 每张图最大宽度 = 总宽 / 图数，确保并排不超出页面
      const cellMax = Math.floor(MAX_IMG_W / items.length);
      items.forEach(item => {
        const td = clone.ownerDocument.createElement('td');
        td.style.verticalAlign = 'top';
        td.style.textAlign = 'center';
        td.style.padding = '4px';
        const img = item.querySelector('img');
        if (img) {
          let w = parseFloat(item.style.width) || 0;
          if (!w) { const orig = this.editor.querySelector('.img-grid .img-container img'); w = orig ? orig.naturalWidth : 300; }
          w = Math.min(w, cellMax);
          const cleanImg = img.cloneNode(true);
          cleanImg.style.width = Math.floor(w) + 'px';
          cleanImg.style.height = 'auto';
          cleanImg.style.maxWidth = '100%';
          cleanImg.removeAttribute('class');
          td.appendChild(cleanImg);
        }
        tr.appendChild(td);
      });
      table.appendChild(tr);
      grid.parentNode.replaceChild(table, grid);
    });
    // 独立 img-container：尺寸转移到 img，容器变为居中 block
    clone.querySelectorAll('.img-container').forEach((container, i) => {
      const img = container.querySelector('img');
      if (!img) { container.remove(); return; }
      let w = parseFloat(container.style.width) || 0;
      if (!w && origContainers[i]) {
        const rect = origContainers[i].getBoundingClientRect();
        w = rect.width || 0;
      }
      if (!w) w = 300;
      // cap 到 Word 页面内容区宽度，防止图片撑满整页
      w = Math.min(w, MAX_IMG_W);
      img.style.width = Math.floor(w) + 'px';
      img.style.height = 'auto';
      img.style.maxWidth = '100%';
      img.removeAttribute('class');
      container.style.width = '';
      container.style.height = '';
      container.style.display = 'block';
      container.style.textAlign = 'center';
      container.style.margin = '8px auto';
      container.querySelectorAll('.rs-handle, .img-size-label').forEach(n => n.remove());
    });
    return clone.innerHTML;
  }

  toWordHTML() {
    const content = this._processExportContent();
    return '<!DOCTYPE html><html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">' +
      '<head><meta charset="UTF-8"><title>知著 PenMark 文档</title>' +
      '<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom><w:DoNotOptimizeForBrowser/></w:WordDocument></xml><![endif]-->' +
      '<style>@page WordSection1{size:595.3pt 841.9pt;margin:72.0pt 90.0pt 72.0pt 90.0pt;}div.WordSection1{page:WordSection1;}' +
      'body{font-family:"Songti SC","SimSun",serif;font-size:12pt;line-height:1.75;color:#2b2a27;}' +
      'h1{font-size:24pt;margin:12pt 0 6pt;}h2{font-size:18pt;margin:10pt 0 5pt;}h3{font-size:14pt;margin:8pt 0 4pt;}' +
      'p{margin:6pt 0;}blockquote{margin:8pt 0;padding:4pt 11pt;border-left:3pt solid #c9bc9a;background:#f5f0e3;font-style:italic;}' +
      'ul,ol{margin:6pt 0;}hr{border:none;border-top:1pt solid #999;margin:12pt 0;}' +
      'pre{background:#f0ece0;border:1pt solid #d9d2bf;padding:8pt;font-family:Consolas,monospace;font-size:10pt;}' +
      'table{border-collapse:collapse;width:100%;}th,td{border:1pt solid #999;padding:4pt 6pt;}th{background:#efe9dc;}' +
      '.img-container{display:block;text-align:center;margin:8pt auto;}.img-container img{height:auto;}' +
      '</style></head><body><div class="WordSection1">' + content + '</div></body></html>';
  }

  loadFromHTMLString(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const ed = doc.querySelector('#editor') || doc.querySelector('.doc') || doc.body;
    const content = ed ? ed.innerHTML : (doc.body.innerHTML || html);
    // 同粘贴流程清理 + 固化远程图
    const cleaned = this._cleanPastedHTML(content);
    this.editor.innerHTML = cleaned;
    this.normalizeLinkCards();
    this.fixImageContainers();
    this._afterChange();
    this._convertRemoteImages();
  }

  _escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
