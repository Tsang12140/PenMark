// Shared Feishu-style image preview for the editor and public share page.

let preview = null;

const ICONS = {
  minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg>',
  maximize: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>'
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
    scale: 1,
    x: 0,
    y: 0,
    dragging: false,
    pointerId: null,
    pointerX: 0,
    pointerY: 0,
    originX: 0,
    originY: 0,
    previousFocus: null
  };

  function render() {
    image.style.transform = 'translate3d(' + state.x + 'px,' + state.y + 'px,0) scale(' + state.scale + ')';
    scaleLabel.textContent = Math.round(state.scale * 100) + '%';
    overlay.classList.toggle('is-zoomed', state.scale > 1);
  }

  function setScale(next) {
    state.scale = Math.max(0.5, Math.min(4, Math.round(next * 10) / 10));
    if (state.scale <= 1) {
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

  function close() {
    if (overlay.hidden) return;
    overlay.hidden = true;
    image.removeAttribute('src');
    error.hidden = true;
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
    reset();
    error.hidden = true;
    image.hidden = false;
    image.alt = sourceImage.getAttribute('alt') || '图片预览';
    image.src = source;
    overlay.hidden = false;
    document.body.classList.add('image-preview-open');
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
      else if (name === 'reset') reset();
      return;
    }
    if (event.target === stage) close();
  });

  image.addEventListener('dblclick', (event) => {
    event.preventDefault();
    event.stopPropagation();
    setScale(state.scale === 1 ? 2 : 1);
  });

  stage.addEventListener('wheel', (event) => {
    if (overlay.hidden) return;
    event.preventDefault();
    setScale(state.scale + (event.deltaY < 0 ? 0.2 : -0.2));
  }, { passive: false });

  image.addEventListener('pointerdown', (event) => {
    if (state.scale <= 1) return;
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
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      setScale(state.scale + 0.2);
    } else if (event.key === '-') {
      event.preventDefault();
      setScale(state.scale - 0.2);
    } else if (event.key === '0') {
      event.preventDefault();
      reset();
    }
  });

  return { open, close };
}

export function setupImagePreview(root, selector) {
  if (!root) return () => {};
  if (!preview) preview = createPreview();
  const imageSelector = selector || 'img';
  const onDoubleClick = (event) => {
    const image = event.target.closest && event.target.closest(imageSelector);
    if (!image || !root.contains(image)) return;
    event.preventDefault();
    event.stopPropagation();
    preview.open(image);
  };
  root.addEventListener('dblclick', onDoubleClick);
  return () => root.removeEventListener('dblclick', onDoubleClick);
}
