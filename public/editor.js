// 知著 PenMark 编辑器核心模块
// 富文本编辑、图片管理（参考简编方案：放行默认粘贴 + fixImageContainers 包装裸 img + onload 自动缩放）、
// 粘贴处理、撤销重做、Markdown快捷输入、代码块/表格/目录、导出
export class Editor {
  constructor(opts) {
    this.editor = opts.editor;
    this.onUpdate = opts.onUpdate || function(){};
    this.onToast = opts.onToast || function(){};
    this.onImageSelect = opts.onImageSelect || function(){};
    this.dropOverlay = opts.dropOverlay;
    this.selectedImage = null;
    this.imageClipboard = null;
    this.styleUndoStack = [];
    this.resizeState = null;
    this._init();
  }

  _init() {
    this._bindPaste();
    this._bindDragDrop();
    this._bindImageDelegation();
    this._bindMarkdownShortcut();
    this._bindInput();
    this._bindKeydown();
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

  /* ---------- 输入监听 ---------- */
  _bindInput() {
    this.editor.addEventListener('input', () => this._afterChange());
    this.editor.addEventListener('keyup', (e) => {
      if (e.key === 'Delete' || e.key === 'Backspace') this._afterChange();
    });
  }

  /* ---------- 撤销/重做 ---------- */
  undo() {
    this.editor.focus();
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
    const before = this.editor.innerHTML;
    document.execCommand('redo');
    if (this.editor.innerHTML === before) { this.onToast('无可重做操作'); return false; }
    this._afterChange();
    return true;
  }

  /* ---------- 插入：分隔线 / 引用 / 代码 / 代码块 / 表格 / 目录 ---------- */
  insertHR() { this.editor.focus(); document.execCommand('insertHTML', false, '<hr>'); this._afterChange(); }
  insertQuote() { this.exec('formatBlock', '<BLOCKQUOTE>'); }
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
    document.execCommand('insertHTML', false, '<pre><code><br></code></pre><p><br></p>');
    this._afterChange();
  }
  insertLink() {
    this.editor.focus();
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) { this.onToast('先选中文字，再插入链接'); return; }
    const selected = sel.toString().trim();
    const guess = /^https?:\/\//i.test(selected) ? selected : 'https://';
    const url = window.prompt('链接地址：', guess);
    if (!url || !url.trim() || url.trim() === 'https://') return;
    document.execCommand('createLink', false, url.trim());
    this._afterChange();
  }
  insertTable(rows, cols) {
    rows = rows || 3; cols = cols || 3;
    let html = '<table><thead><tr>';
    for (let c = 0; c < cols; c++) html += '<th>列' + (c + 1) + '</th>';
    html += '</tr></thead><tbody>';
    for (let r = 0; r < rows - 1; r++) { html += '<tr>'; for (let c = 0; c < cols; c++) html += '<td>&nbsp;</td>'; html += '</tr>'; }
    html += '</tbody></table><p><br></p>';
    this.editor.focus();
    document.execCommand('insertHTML', false, html);
    this._afterChange();
  }
  insertTOC() {
    const headings = this.editor.querySelectorAll('h1, h2, h3');
    if (!headings.length) { this.onToast('文档中没有标题，无法生成目录'); return; }
    let html = '<div class="toc"><div class="toc-title">目录</div><ol>';
    headings.forEach((h, i) => {
      const id = h.id || (h.id = 'h-' + i + '-' + this._uid());
      const level = h.tagName.toLowerCase();
      const indent = level === 'h2' ? 'padding-left:1em;' : (level === 'h3' ? 'padding-left:2em;' : '');
      html += '<li style="' + indent + '"><a href="#' + id + '">' + this._escapeHtml(h.textContent) + '</a></li>';
    });
    html += '</ol></div><p><br></p>';
    this.editor.focus();
    document.execCommand('insertHTML', false, html);
    this._afterChange();
  }

  /* ---------- 图片插入（span.img-container + onload 自动缩放） ---------- */
  insertImage(src) {
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
    const html = '<span class="img-container" contenteditable="false" data-type="image" draggable="true" data-uid="' + uid + '">' +
      '<img src="' + src + '" alt="图片" draggable="false">' +
      '<span class="img-size-label"></span>' +
      '<span class="rs-handle rs-nw" data-dir="nw" draggable="false"></span>' +
      '<span class="rs-handle rs-ne" data-dir="ne" draggable="false"></span>' +
      '<span class="rs-handle rs-sw" data-dir="sw" draggable="false"></span>' +
      '<span class="rs-handle rs-se" data-dir="se" draggable="false"></span>' +
      '</span>\u200B';
    document.execCommand('insertHTML', false, html);

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
      const styleW = (container.style.width || '').trim();
      const pct = styleW.match(/^([\d.]+)%$/);
      const currentW = pct ? ew * Math.min(parseFloat(pct[1]), 100) / 100 : (parseFloat(styleW) || this._readImageWidth(img) || img.naturalWidth || ew * 0.8);
      const w = Math.min(currentW, img.naturalWidth || currentW, ew * 0.95);
      this._setImageDisplaySize(container, w);
    };
    img.onload = onLoad;
    if (img.complete && img.naturalWidth) onLoad();
  }

  /* ---------- 把裸 img 包装成可编辑容器（粘贴/打开文件后调用） ---------- */
  fixImageContainers() {
    this.editor.querySelectorAll('img').forEach(img => {
      if (img.closest('.img-container')) return;
      const container = document.createElement('span');
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
  _bindImageDelegation() {
    // 点击选中
    this.editor.addEventListener('click', (e) => {
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
      const container = e.target.closest && e.target.closest('.img-container');
      if (container) {
        container.classList.add('dragging');
        try {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/penmark-img', container.getAttribute('data-id') || this._uid());
          container.setAttribute('data-id', e.dataTransfer.getData('text/penmark-img'));
          const img = container.querySelector('img');
          if (img && e.dataTransfer.setDragImage) e.dataTransfer.setDragImage(img, img.offsetWidth / 2, img.offsetHeight / 2);
        } catch (_) {}
      }
    });
    this.editor.addEventListener('dragend', (e) => {
      const container = e.target.closest && e.target.closest('.img-container');
      if (container) container.classList.remove('dragging');
    });
    this.editor.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types && e.dataTransfer.types.indexOf('text/penmark-img') >= 0) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }
    });
    this.editor.addEventListener('drop', (e) => {
      const id = e.dataTransfer.getData('text/penmark-img');
      if (id) {
        e.preventDefault();
        e.stopPropagation();
        const container = this.editor.querySelector('.img-container[data-id="' + id + '"]');
        if (!container) return;
        const gridTarget = this._imageDropTarget(e.clientX, e.clientY, container);
        if (gridTarget) {
          this._moveImageBeside(container, gridTarget, e.clientX);
          this._afterChange();
          return;
        }
        const r = this._caretFromPoint(e.clientX, e.clientY);
        if (!r) return;
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        const oldGrid = container.closest('.img-grid');
        const html = container.outerHTML;
        container.parentNode.removeChild(container);
        this._cleanupImageGrid(oldGrid);
        document.execCommand('insertHTML', false, html);
        // 重新绑定 onload（外部插入的 img 可能已加载）
        const nid = this._uid();
        const inserted = this.editor.querySelector('.img-container[data-id="' + id + '"]');
        if (inserted) { inserted.removeAttribute('data-id'); this._attachImgLoad(inserted); }
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
      container.style.display = 'inline-block';
      container.style.marginLeft = '0';
      container.style.marginRight = 'auto';
    } else {
      container.style.display = 'inline-block';
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

  /* ---------- 外部拖入图片文件 ---------- */
  _bindDragDrop() {
    let depth = 0;
    window.addEventListener('dragenter', (e) => {
      if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.indexOf('Files') >= 0) {
        depth++;
        if (this.dropOverlay) this.dropOverlay.classList.add('show');
      }
    });
    window.addEventListener('dragover', (e) => {
      if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.indexOf('Files') >= 0) e.preventDefault();
    });
    window.addEventListener('dragleave', () => {
      depth--;
      if (depth <= 0) { depth = 0; if (this.dropOverlay) this.dropOverlay.classList.remove('show'); }
    });
    window.addEventListener('drop', async (e) => {
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
          if (inEditor) {
            const r = this._caretFromPoint(e.clientX, e.clientY);
            if (r) { const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r); }
          } else this._placeCaretAtEnd();
          for (const f of imgs) {
            try { const url = await this._readAsDataURL(f); this.insertImage(url); }
            catch (err) { this.onToast('图片插入失败：' + f.name); }
          }
          this.onToast('已插入 ' + imgs.length + ' 张图片');
        }
      }
      if (this.dropOverlay) this.dropOverlay.classList.remove('show');
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
        // 纯文本：放行默认
        setTimeout(() => this._afterPasteCleanup(), 60);
      }
    });
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
    this.fixImageContainers();
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
        { re: /^1\. $/, type: 'ol' }
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
          else document.execCommand('formatBlock', false, '<' + p.type.toUpperCase() + '>');
          this._afterChange();
          return;
        }
      }
    });
  }

  _currentBlock() {
    const sel = document.getSelection();
    if (!sel.rangeCount) return null;
    let node = sel.anchorNode;
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

  _bindKeydown() {
    this.editor.addEventListener('keydown', (e) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (e.key === 'Tab') {
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
  getHTML() { return this.editor.innerHTML; }
  setHTML(html) {
    this.editor.innerHTML = html || '<p><br></p>';
    this.fixImageContainers();
    this._afterChange();
  }
  clear() {
    this.editor.innerHTML = '<p><br></p>';
    this._selectImage(null);
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
    this.fixImageContainers();
    this._afterChange();
    this._convertRemoteImages();
  }

  _escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
