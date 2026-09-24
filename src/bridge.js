(() => {
  if (window.__HPE_BRIDGE_ACTIVE) return;
  window.__HPE_BRIDGE_ACTIVE = true;
  const FILE = window.__HPE_FILE || '';
  let mode = 'preview';
  let currentHover = null;
  let pinsVisible = true;
  let annotations = [];

  const style = document.createElement('style');
  style.textContent = `
    .hpe-hover-target{outline:2px solid #1677ff!important;outline-offset:2px!important;cursor:crosshair!important}
    .hpe-edit-target{outline-color:#f59e0b!important;cursor:text!important}
    .hpe-annotation-pin{position:fixed;z-index:2147483646;width:24px;height:24px;border:2px solid #fff;border-radius:50%;background:#1677ff;color:#fff;display:grid;place-items:center;font:700 11px/1 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.28);cursor:pointer}
    .hpe-pin-tooltip{position:fixed;z-index:2147483647;width:max-content;max-width:340px;padding:9px 11px;border-radius:6px;background:rgba(23,33,43,.96);color:#fff;font:400 12px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;white-space:pre-wrap;word-break:break-word;box-shadow:0 7px 20px rgba(0,0,0,.24);pointer-events:none}
    .hpe-pin-hidden{display:none!important}
  `;
  document.documentElement.appendChild(style);

  function post(type, payload = {}) {
    window.top.postMessage({ source: 'hpe-bridge', type, file: FILE, ...payload }, '*');
  }

  function nodeId(element) { return element?.getAttribute?.('data-hpe-node') || ''; }
  function isEditorNode(element) { return element?.classList?.contains('hpe-annotation-pin'); }

  function nearestMarked(element) {
    if (!element || element === document.documentElement || element === document.body) return null;
    return element.closest?.('[data-hpe-node]') || null;
  }

  function componentTarget(element) {
    const component = element.closest?.('button,a,input,textarea,select,option,table,th,td,tr,li,[role="button"],[role="dialog"],.menu-item,.card,.modal,.panel');
    return nearestMarked(component || element);
  }

  function editableTarget(element) {
    const marked = nearestMarked(element);
    if (!marked) return null;
    if (/^(INPUT)$/i.test(marked.tagName)) {
      const attribute = marked.hasAttribute('placeholder') ? 'placeholder' : 'value';
      return { element: marked, kind: 'attr', attribute, value: marked.getAttribute(attribute) || '' };
    }
    if (/^(IMG)$/i.test(marked.tagName)) return { element: marked, kind: 'attr', attribute: 'alt', value: marked.getAttribute('alt') || '' };
    if (/^(SCRIPT|STYLE|HTML|BODY|IFRAME|VIDEO|AUDIO|CANVAS)$/i.test(marked.tagName)) return null;
    const hasElementChild = Array.from(marked.children || []).some((child) => !child.classList.contains('hpe-annotation-pin'));
    if (hasElementChild) {
      const leaf = Array.from(marked.querySelectorAll('[data-hpe-node]')).find((node) => node.contains(element) && !node.children.length && (node.textContent || '').trim());
      if (leaf) return { element: leaf, kind: 'text', value: leaf.textContent || '' };
      return null;
    }
    if (!(marked.textContent || '').trim() && !/^(TEXTAREA|OPTION)$/i.test(marked.tagName)) return null;
    return { element: marked, kind: 'text', value: marked.textContent || '' };
  }

  function clearHover() {
    if (currentHover) currentHover.classList.remove('hpe-hover-target', 'hpe-edit-target');
    currentHover = null;
  }

  function onMove(event) {
    if (mode === 'preview' || isEditorNode(event.target)) return clearHover();
    const target = mode === 'edit' ? editableTarget(event.target)?.element : componentTarget(event.target);
    if (target === currentHover) return;
    clearHover();
    if (target) {
      currentHover = target;
      target.classList.add('hpe-hover-target');
      if (mode === 'edit') target.classList.add('hpe-edit-target');
    }
  }

  function onClick(event) {
    if (mode === 'preview' || isEditorNode(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (mode === 'edit') {
      const info = editableTarget(event.target);
      if (!info) return post('notice', { message: '该区域不是可直接保存的静态文字' });
      post('select-edit', {
        target: { nodeId: nodeId(info.element), tag: info.element.tagName.toLowerCase(), label: (info.element.textContent || info.value || info.element.tagName).trim().slice(0, 80) },
        kind: info.kind, attribute: info.attribute || null, value: info.value
      });
    } else {
      const target = componentTarget(event.target);
      if (!target) return;
      post('select-annotation', { target: { nodeId: nodeId(target), tag: target.tagName.toLowerCase(), label: (target.innerText || target.getAttribute('aria-label') || target.tagName).trim().replace(/\s+/g, ' ').slice(0, 90) } });
    }
  }

  function findTarget(node) { return document.querySelector(`[data-hpe-node="${CSS.escape(node)}"]`); }

  function scrollWithinDocument(target) {
    let parent = target.parentElement;
    while (parent && parent !== document.body && parent !== document.documentElement) {
      const style = getComputedStyle(parent);
      if (/(auto|scroll)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight) {
        const targetBox = target.getBoundingClientRect(); const parentBox = parent.getBoundingClientRect();
        parent.scrollTop += targetBox.top - parentBox.top - (parent.clientHeight - targetBox.height) / 2;
      }
      if (/(auto|scroll)/.test(style.overflowX) && parent.scrollWidth > parent.clientWidth) {
        const targetBox = target.getBoundingClientRect(); const parentBox = parent.getBoundingClientRect();
        parent.scrollLeft += targetBox.left - parentBox.left - (parent.clientWidth - targetBox.width) / 2;
      }
      parent = parent.parentElement;
    }
    const box = target.getBoundingClientRect();
    const scrolling = document.scrollingElement;
    if (scrolling) scrolling.scrollBy({ top:box.top - (innerHeight - box.height) / 2, left:box.left - (innerWidth - box.width) / 2, behavior:'smooth' });
  }

  function showPinTooltip(pin, text) {
    document.querySelector('.hpe-pin-tooltip')?.remove();
    const tooltip = document.createElement('div'); tooltip.className = 'hpe-pin-tooltip'; tooltip.textContent = text;
    document.body.appendChild(tooltip);
    const pinBox = pin.getBoundingClientRect(); const tipBox = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.max(8, Math.min(innerWidth - tipBox.width - 8, pinBox.left - tipBox.width - 8))}px`;
    tooltip.style.top = `${Math.max(8, Math.min(innerHeight - tipBox.height - 8, pinBox.top))}px`;
  }

  function applyChange(change) {
    if (change.file !== FILE) return;
    const target = findTarget(change.nodeId);
    if (!target) return;
    if (change.kind === 'attr') target.setAttribute(change.attribute, change.newValue);
    else target.textContent = change.newValue;
    updatePins();
  }

  function pinElements() { return Array.from(document.querySelectorAll('.hpe-annotation-pin')); }

  function updatePins() {
    for (const pin of pinElements()) {
      const target = findTarget(pin.dataset.nodeId);
      if (!target) { pin.style.display = 'none'; continue; }
      const box = target.getBoundingClientRect();
      pin.style.display = pinsVisible ? 'grid' : 'none';
      pin.style.left = `${Math.max(4, Math.min(window.innerWidth - 28, box.right - 12))}px`;
      pin.style.top = `${Math.max(4, Math.min(window.innerHeight - 28, box.top - 12))}px`;
    }
  }

  function renderPins() {
    for (const pin of pinElements()) pin.remove();
    const own = annotations.filter((item) => item.file === FILE);
    own.forEach((annotation) => {
      if (!findTarget(annotation.target.nodeId)) return;
      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = 'hpe-annotation-pin';
      pin.dataset.nodeId = annotation.target.nodeId;
      pin.dataset.annotationId = annotation.id;
      pin.textContent = String(annotation.number || annotations.indexOf(annotation) + 1);
      pin.setAttribute('aria-label', `批注 ${pin.textContent}：${annotation.text}`);
      pin.addEventListener('mouseenter', () => showPinTooltip(pin, annotation.text));
      pin.addEventListener('mouseleave', () => document.querySelector('.hpe-pin-tooltip')?.remove());
      pin.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); post('focus-annotation', { id: annotation.id }); });
      document.body.appendChild(pin);
    });
    updatePins();
  }

  function forward(message) {
    for (const frame of document.querySelectorAll('iframe')) {
      try { frame.contentWindow?.postMessage(message, '*'); } catch {}
    }
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || message.source !== 'hpe-app') return;
    if (message.type === 'set-mode') { mode = message.mode; clearHover(); }
    if (message.type === 'apply-change') applyChange(message.change);
    if (message.type === 'set-annotations') { annotations = message.annotations || []; renderPins(); }
    if (message.type === 'toggle-pins') { pinsVisible = Boolean(message.visible); updatePins(); }
    if (message.type === 'focus-target' && message.file === FILE) {
      const target = findTarget(message.nodeId);
      if (target) scrollWithinDocument(target);
      if (target) { target.animate([{ outline:'3px solid #1677ff' },{ outline:'0 solid transparent' }], { duration:1200 }); }
    }
    forward(message);
  });

  document.addEventListener('pointermove', onMove, true);
  document.addEventListener('click', onClick, true);
  window.addEventListener('scroll', updatePins, true);
  window.addEventListener('resize', updatePins);
  new MutationObserver(() => requestAnimationFrame(updatePins)).observe(document.documentElement, { childList:true, subtree:true, attributes:true });
  post('frame-ready', { title: document.title });
})();
