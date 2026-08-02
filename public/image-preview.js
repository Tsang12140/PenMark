// Shared Feishu-style image preview for the editor and public share page.

let preview = null;

const ICONS = {
  minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg>',
  maximize: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
  prev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>',
  next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>'
};

function createPreview() {
  const overlay = document.createElement('div');
  overlay.className = 'image-preview-overlay';
  overlay.hidden = true;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', '图片预览');
  overlay.innerHTML =
    '<div class="image-preview-toolbar">' +
      '<button type="button" class="image-preview-tool" data-action="zoom-out" title="缩小" aria-label="缩小">' + ICONS.minus + '</button>' +
      '<span class="image-preview-scale" aria-live="polite">100%</span>' +
      '<button type="button" class="image-preview-tool" data-action="zoom-in" title="放大" aria-label="放大">' + ICONS.plus + '</button>' +
      '<button type="button" class="image-preview-tool" data-action="reset" title="适应窗口" aria-label="适应窗口">' + ICONS.maximize + '</button>' +
      '<button type="button" class="image-preview-tool image-preview-close" data-action="close" title="关闭（Esc）" aria-label="关闭图片预览">' + ICONS.close + '</button>' +
    '</div>' +
    '<button type="button" class="image-preview-nav image-preview-prev" data-action="prev" title="上一张（←）" aria-label="上一张">' + ICONS.prev + '</button>' +
    '<button type="button" class="image-preview-nav image-preview-next" data-action="next" title="下一张（→）" aria-label="下一张">' + ICONS.next + '</button>' +
    '<div class="image-preview-counter" hidden></div>' +
    '<div class="image-preview-stage">' +
      '<img class="image-preview-image" alt="图片预览" draggable="false">' +
      '<div class="image-preview-error" hidden>图片加载失败</div>' +
    '</div>';
  document.body.appendChild(overlay);

  const stage = overlay.querySelector('.image-preview-stage');
  const image = overlay.querySelector('.image-preview-image');
  const error = overlay.querySelector('.image-preview-error');
  const scaleLabel = overlay.querySelector('.image-preview-scale');
  const closeButton = overlay.querySelector('[data-action="close"]');
  const state = {
    mode: 'natural',
    scale: 1,
    x: 0,
    y: 0,
    dragging: false,
    pointerId: null,
    pointerX: 0,
    pointerY: 0,
    originX: 0,
    originY: 0,
    previousFocus: null,
    root: null,
    selector: 'img',
    images: [],
    currentIndex: -1
  };

  const prevButton = overlay.querySelector('.image-preview-prev');
  const nextButton = overlay.querySelector('.image-preview-next');
  const counter = overlay.querySelector('.image-preview-counter');

  // 收集 root 内所有可预览图片，返回索引
  function collectImages(sourceImage) {
    if (!state.root) return -1;
    const imgs = Array.from(state.root.querySelectorAll(state.selector));
    state.images = imgs.filter(img => {
      const src = img.currentSrc || img.getAttribute('src') || '';
      return src && !/^(?:about:|javascript:|data:image\/svg)/i.test(src);
    });
    return state.images.indexOf(sourceImage);
  }

  function updateNavState() {
    const hasMultiple = state.images.length > 1;
    prevButton.hidden = !hasMultiple;
    nextButton.hidden = !hasMultiple;
    if (hasMultiple) {
      counter.hidden = false;
      counter.textContent = (state.currentIndex + 1) + ' / ' + state.images.length;
    } else {
      counter.hidden = true;
    }
  }

  function showImage(index) {
    if (!state.images.length) return;
    let i = index;
    if (i < 0) i = state.images.length - 1;
    if (i >= state.images.length) i = 0;
    state.currentIndex = i;
    const img = state.images[i];
    const src = img.currentSrc || img.getAttribute('src') || '';
    if (!src) return;
    setMode('natural');
    error.hidden = true;
    image.hidden = false;
    image.alt = img.getAttribute('alt') || '图片预览';
    image.src = src;
    updateNavState();
  }

  function nav(direction) {
    if (state.currentIndex < 0) return;
    showImage(state.currentIndex + direction);
  }

  function render() {
    image.style.transform = 'translate3d(' + state.x + 'px,' + state.y + 'px,0) scale(' + state.scale + ')';
    scaleLabel.textContent = Math.round(state.scale * 100) + '%';
    overlay.classList.toggle('is-zoomed', state.scale > 1 || state.mode === 'natural');
  }

  function setScale(next) {
    state.scale = Math.max(0.5, Math.min(10, Math.round(next * 10) / 10));
    if (state.scale <= 1 && state.mode !== 'natural') {
      state.x = 0;
      state.y = 0;
    }
    render();
  }

  function reset() {
    state.scale = 1;
    state.x = 0;
    state.y = 0;
    render();
  }

  // 切换模式：natural=原始尺寸（可超出窗口拖动查看），fit=适应窗口
  function setMode(mode) {
    state.mode = mode;
    state.scale = 1;
    state.x = 0;
    state.y = 0;
    image.classList.toggle('natural', mode === 'natural');
    render();
  }

  function close() {
    if (overlay.hidden) return;
    overlay.hidden = true;
    image.removeAttribute('src');
    error.hidden = true;
    counter.hidden = true;
    state.images = [];
    state.currentIndex = -1;
    document.body.classList.remove('image-preview-open');
    const previousFocus = state.previousFocus;
    state.previousFocus = null;
    if (previousFocus && previousFocus.isConnected && previousFocus.focus) {
      previousFocus.focus({ preventScroll: true });
    }
  }

  function open(sourceImage) {
    const source = sourceImage.currentSrc || sourceImage.getAttribute('src') || '';
    if (!source || /^(?:about:|javascript:|data:image\/svg)/i.test(source)) return;
    state.previousFocus = document.activeElement;
    // 收集文档内所有图片，支持左右切换
    const idx = collectImages(sourceImage);
    state.currentIndex = idx >= 0 ? idx : 0;
    // 默认原始尺寸：大图直接超出窗口可拖动查看，飞书式超大预览
    setMode('natural');
    error.hidden = true;
    image.hidden = false;
    image.alt = sourceImage.getAttribute('alt') || '图片预览';
    image.src = source;
    overlay.hidden = false;
    document.body.classList.add('image-preview-open');
    updateNavState();
    closeButton.focus({ preventScroll: true });
  }

  image.addEventListener('load', () => {
    image.hidden = false;
    error.hidden = true;
  });
  image.addEventListener('error', () => {
    image.hidden = true;
    error.hidden = false;
  });

  overlay.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]');
    if (action) {
      const name = action.getAttribute('data-action');
      if (name === 'close') close();
      else if (name === 'zoom-in') setScale(state.scale + 0.2);
      else if (name === 'zoom-out') setScale(state.scale - 0.2);
      else if (name === 'reset') setMode(state.mode === 'natural' ? 'fit' : 'natural');
      else if (name === 'prev') nav(-1);
      else if (name === 'next') nav(1);
      return;
    }
    if (event.target === stage) close();
  });

  image.addEventListener('dblclick', (event) => {
    event.preventDefault();
    event.stopPropagation();
    // 双击在原始尺寸 / 适应窗口之间切换
    setMode(state.mode === 'natural' ? 'fit' : 'natural');
  });

  stage.addEventListener('wheel', (event) => {
    if (overlay.hidden) return;
    event.preventDefault();
    setScale(state.scale + (event.deltaY < 0 ? 0.2 : -0.2));
  }, { passive: false });

  image.addEventListener('pointerdown', (event) => {
    // natural 模式下原图可能超出窗口，允许拖动查看；fit 模式仅 scale>1 可拖动
    if (state.scale <= 1 && state.mode !== 'natural') return;
    event.preventDefault();
    state.dragging = true;
    state.pointerId = event.pointerId;
    state.pointerX = event.clientX;
    state.pointerY = event.clientY;
    state.originX = state.x;
    state.originY = state.y;
    image.setPointerCapture(event.pointerId);
    overlay.classList.add('is-dragging');
  });
  image.addEventListener('pointermove', (event) => {
    if (!state.dragging || event.pointerId !== state.pointerId) return;
    state.x = state.originX + event.clientX - state.pointerX;
    state.y = state.originY + event.clientY - state.pointerY;
    render();
  });
  const stopDragging = (event) => {
    if (!state.dragging || (event && event.pointerId !== state.pointerId)) return;
    state.dragging = false;
    state.pointerId = null;
    overlay.classList.remove('is-dragging');
  };
  image.addEventListener('pointerup', stopDragging);
  image.addEventListener('pointercancel', stopDragging);

  document.addEventListener('keydown', (event) => {
    if (overlay.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      nav(-1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      nav(1);
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      setScale(state.scale + 0.2);
    } else if (event.key === '-') {
      event.preventDefault();
      setScale(state.scale - 0.2);
    } else if (event.key === '0') {
      event.preventDefault();
      setMode(state.mode === 'natural' ? 'fit' : 'natural');
    }
  });

  return { open, close, setScope: (root, selector) => { state.root = root; state.selector = selector; } };
}

export function setupImagePreview(root, selector) {
  if (!root) return () => {};
  if (!preview) preview = createPreview();
  preview.setScope(root, selector || 'img');
  const imageSelector = selector || 'img';
  // 编辑器内 img 设了 pointer-events:none，click 命中的是 .img-container 容器；
  // 且容器 draggable="true" 会吞掉原生 dblclick，editor.js 的 click 还会 stopPropagation。
  // 方案：在捕获阶段监听 mousedown（早于 click，不受 stopPropagation 影响），
  // target 在容器内时取容器里的 img，350ms 内同一图第二次 mousedown → 弹预览。
  let lastClickTime = 0;
  let lastClickSrc = '';
  const findImage = (target) => {
    if (!target || !target.closest) return null;
    let img = target.closest(imageSelector);
    if (img) return img;
    const container = target.closest('.img-container');
    if (container) {
      img = container.querySelector('img');
      if (img) return img;
    }
    return null;
  };
  const onMouseDown = (event) => {
    if (event.button !== 0) return; // 只响应左键
    const image = findImage(event.target);
    if (!image || !root.contains(image)) return;
    const src = image.currentSrc || image.getAttribute('src') || '';
    if (!src) return;
    const now = Date.now();
    if (now - lastClickTime < 350 && src === lastClickSrc) {
      // 命中第二次：阻止后续 click 选中/拖拽，弹预览
      event.preventDefault();
      event.stopPropagation();
      lastClickTime = 0;
      lastClickSrc = '';
      // 异步打开，避免破坏当前事件循环
      setTimeout(() => preview.open(image), 0);
    } else {
      lastClickTime = now;
      lastClickSrc = src;
    }
  };
  root.addEventListener('mousedown', onMouseDown, true);
  return () => root.removeEventListener('mousedown', onMouseDown, true);
}
