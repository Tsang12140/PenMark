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
  _editorContentWidth() { return this.editor.clientWidth - 112; }

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
          p.container.style.height = p.h + 'px';
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
    const label = container.querySelector('.img-size-label');
    if (!img) return;
    const onLoad = () => {
      const ew = this._editorContentWidth();
      if (img.naturalWidth > ew * 0.9) {
        container.style.width = Math.floor(ew * 0.8) + 'px';
      } else {
        container.style.width = img.naturalWidth + 'px';
      }
      if (label) label.textContent = img.naturalWidth + '\u00D7' + img.naturalHeight;
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
      container.style.width = (img.style.width || (img.width ? img.width + 'px' : 'auto'));

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
      if (!c.querySelector('.rs-handle')) {
        ['nw', 'ne', 'sw', 'se'].forEach(dir => {
          const h = document.createElement('span');
          h.className = 'rs-handle rs-' + dir;
          h.setAttribute('data-dir', dir);
          h.setAttribute('draggable', 'false');
          c.appendChild(h);
        });
      }
    });
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
        startW: rect.width, aspect
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
      s.container.style.width = Math.round(newW) + 'px';
      s.container.style.height = Math.round(newH) + 'px';
      const label = s.container.querySelector('.img-size-label');
      if (label) label.textContent = Math.round(newW) + '\u00D7' + Math.round(newH);
    });
    document.addEventListener('mouseup', () => {
      if (this.resizeState) {
        const s = this.resizeState;
        // 缩放前尺寸入栈，供 undo 补偿
        this.styleUndoStack.push({ container: s.container, w: s.startW, h: null });
        this.resizeState = null;
        this._afterChange();
      }
    });

    // 删除键
    this.editor.addEventListener('keydown', (e) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedImage) {
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
        const r = this._caretFromPoint(e.clientX, e.clientY);
        if (!r) return;
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        const html = container.outerHTML;
        container.parentNode.removeChild(container);
        document.execCommand('insertHTML', false, html);
        // 重新绑定 onload（外部插入的 img 可能已加载）
        const nid = this._uid();
        const inserted = this.editor.querySelector('.img-container[data-id="' + id + '"]');
        if (inserted) { inserted.removeAttribute('data-id'); this._attachImgLoad(inserted); }
        this._afterChange();
      }
    }, true);
  }

  _selectImage(container) {
    this.editor.querySelectorAll('.img-container.selected').forEach(c => c.classList.remove('selected'));
    this.selectedImage = container;
    if (container) { container.classList.add('selected'); container.setAttribute('tabindex', '-1'); container.focus(); }
    this.onImageSelect(container);
  }

  _deleteImage(container) {
    const range = document.createRange();
    range.selectNode(container);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('delete');
    this._selectImage(null);
    this._afterChange();
  }

  /* ---------- 图片浮动菜单操作 ---------- */
  // 重置为原始尺寸
  resetImageSize(container) {
    const img = container.querySelector('img');
    if (!img || !img.naturalWidth) return;
    const ew = this._editorContentWidth();
    const w = Math.min(img.naturalWidth, ew * 0.95);
    container.style.width = Math.floor(w) + 'px';
    container.style.height = '';
    const label = container.querySelector('.img-size-label');
    if (label) label.textContent = img.naturalWidth + '\u00D7' + img.naturalHeight;
    this.styleUndoStack.push({ container, w: container.offsetWidth, h: null });
    this._afterChange();
  }
  // 适应编辑器宽度
  fitImageWidth(container) {
    const ew = this._editorContentWidth();
    container.style.width = Math.floor(ew * 0.95) + 'px';
    container.style.height = '';
    const img = container.querySelector('img');
    const label = container.querySelector('.img-size-label');
    if (label && img) label.textContent = Math.floor(ew * 0.95) + '\u00D7' + Math.floor((ew * 0.95) / (img.naturalWidth / img.naturalHeight || 1));
    this.styleUndoStack.push({ container, w: container.offsetWidth, h: null });
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

  /* ---------- 粘贴：有图片转 base64 插入；富文本清理视觉样式后插入（保留结构） ---------- */
  _bindPaste() {
    this.editor.addEventListener('paste', async (e) => {
      const cd = e.clipboardData || window.clipboardData;
      if (!cd) return;
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
      // 无图片 file item：取 text/html 清理视觉样式后插入（去除背景色/字体/颜色等，保留语义结构）
      const html = cd.getData('text/html');
      if (html) {
        e.preventDefault();
        const cleaned = this._cleanPastedHTML(html);
        document.execCommand('insertHTML', false, cleaned);
        setTimeout(() => { this.fixImageContainers(); this._afterChange(); }, 60);
      } else {
        // 纯文本：放行默认
        setTimeout(() => { this.fixImageContainers(); this._afterChange(); }, 60);
      }
    });
  }

  /* 清理粘贴 HTML：删除所有内联样式与 class/id，只保留语义标签和必要属性（href/src/alt 等） */
  _cleanPastedHTML(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const keepAttrs = new Set(['href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'target']);
    const walk = (node) => {
      if (node.nodeType !== 1) return;
      // 删除非白名单属性（含 style/class/id/data-*）
      const toRemove = [];
      for (const attr of node.attributes) {
        if (!keepAttrs.has(attr.name.toLowerCase())) toRemove.push(attr.name);
      }
      toRemove.forEach(a => node.removeAttribute(a));
      // 移除空 span/font 等纯样式标签，保留内容
      const tag = node.tagName.toLowerCase();
      if (['span', 'font', 'div', 'o:p'].includes(tag) && node.attributes.length === 0) {
        while (node.firstChild) node.parentNode.insertBefore(node.firstChild, node);
        node.parentNode.removeChild(node);
        return;
      }
      // 递归子节点（注意 live 列表，先拷贝）
      Array.prototype.slice.call(node.childNodes).forEach(walk);
    };
    walk(doc.body);
    return doc.body.innerHTML;
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

  _bindKeydown() {
    this.editor.addEventListener('keydown', (e) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); this.undo(); }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); this.redo(); }
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
    const imgs = this.editor.querySelectorAll('.img-container img, .img-container');
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
    const content = this.editor.innerHTML;
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
'.doc .img-container{display:inline-block;position:relative;margin:8px 4px;max-width:100%;}.doc .img-container img{display:block;max-width:100%;height:auto;}',
'.doc .img-size-label,.doc .rs-handle{display:none;}',
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

  toWordHTML() {
    const content = this.editor.innerHTML;
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
      '.img-container{display:inline-block;margin:6pt 0;}.img-container img{max-width:100%;height:auto;}' +
      '.img-size-label,.rs-handle{display:none;}' +
      '</style></head><body><div class="WordSection1">' + content + '</div></body></html>';
  }

  loadFromHTMLString(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const ed = doc.querySelector('#editor') || doc.querySelector('.doc') || doc.body;
    this.editor.innerHTML = ed ? ed.innerHTML : (doc.body.innerHTML || html);
    this.fixImageContainers();
    this._afterChange();
  }

  _escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
