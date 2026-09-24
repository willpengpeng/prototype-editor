(() => {
  if (window.__HPE_REVIEW_ACTIVE) return;
  window.__HPE_REVIEW_ACTIVE = true;
  const FILE = window.__HPE_REVIEW_FILE || '';
  const annotations = (window.__HPE_ANNOTATIONS || []).map((item, index) => ({ ...item, number:index + 1 }));
  const pins = [];
  let pinsVisible = true;

  function findTarget(nodeId) { try { return document.querySelector(`[data-hpe-node="${CSS.escape(nodeId)}"]`); } catch { return null; } }
  function updatePins() {
    for (const { pin, target } of pins) {
      const box = target.getBoundingClientRect();
      pin.style.left = `${Math.max(4, Math.min(innerWidth - 29, box.right - 12))}px`;
      pin.style.top = `${Math.max(4, Math.min(innerHeight - 29, box.top - 12))}px`;
      pin.style.display = !pinsVisible || box.bottom < 0 || box.top > innerHeight ? 'none' : 'grid';
    }
  }
  function showTooltip(anchor, text) {
    document.querySelector('.hpe-review-tooltip')?.remove();
    const tooltip = document.createElement('div'); tooltip.className = 'hpe-review-tooltip'; tooltip.textContent = text;
    document.body.appendChild(tooltip);
    const anchorBox = anchor.getBoundingClientRect(); const tooltipBox = tooltip.getBoundingClientRect();
    const preferLeft = anchorBox.left > innerWidth / 2;
    const left = preferLeft ? anchorBox.left - tooltipBox.width - 10 : anchorBox.right + 10;
    tooltip.style.left = `${Math.max(8, Math.min(innerWidth - tooltipBox.width - 8, left))}px`;
    tooltip.style.top = `${Math.max(8, Math.min(innerHeight - tooltipBox.height - 8, anchorBox.top))}px`;
  }
  function hideTooltip() { document.querySelector('.hpe-review-tooltip')?.remove(); }
  function setTargetHighlight(target, visible) {
    target.classList.toggle('hpe-review-target-highlight', visible);
  }
  function scrollWithinDocument(target) {
    let parent = target.parentElement;
    while (parent && parent !== document.body && parent !== document.documentElement) {
      const style = getComputedStyle(parent);
      if (/(auto|scroll)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight) {
        const targetBox = target.getBoundingClientRect(); const parentBox = parent.getBoundingClientRect();
        parent.scrollTop += targetBox.top - parentBox.top - (parent.clientHeight - targetBox.height) / 2;
      }
      parent = parent.parentElement;
    }
    const box = target.getBoundingClientRect(); const scrolling = document.scrollingElement;
    if (scrolling) scrolling.scrollBy({top:box.top - (innerHeight - box.height) / 2,behavior:'smooth'});
  }
  function renderPins() {
    annotations.filter((item) => item.file === FILE).forEach((item) => {
      const target = findTarget(item.target.nodeId);
      if (!target) return;
      const pin = document.createElement('button');
      pin.className = 'hpe-review-pin'; pin.textContent = item.number; pin.setAttribute('aria-label',`批注 ${item.number}：${item.text}`);
      pin.addEventListener('mouseenter',()=>{ setTargetHighlight(target, true); showTooltip(pin,item.text); });
      pin.addEventListener('mouseleave',()=>{ setTargetHighlight(target, false); hideTooltip(); });
      pin.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); window.top.postMessage({source:'hpe-review',type:'open',id:item.id},'*'); });
      document.body.appendChild(pin); pins.push({ pin, target });
    });
    updatePins();
  }
  function forward(message) { for (const frame of document.querySelectorAll('iframe')) { try { frame.contentWindow?.postMessage(message,'*'); } catch {} } }
  function setPinsVisible(visible) {
    pinsVisible = visible;
    updatePins();
    forward({ source:'hpe-review', type:'toggle-pins', visible });
  }
  function focus(message) {
    const item = annotations.find((annotation) => annotation.id === message.id);
    if (item?.file === FILE) {
      const target = findTarget(item.target.nodeId);
      if (target) scrollWithinDocument(target);
      if (target) target.animate([{outline:'3px solid #1677ff'},{outline:'0 solid transparent'}],{duration:1300});
    }
    forward(message);
  }
  function createCoordinator() {
    const fab = document.createElement('button'); fab.className = 'hpe-review-fab'; fab.textContent = `批注 ${annotations.length}`;
    const drawer = document.createElement('aside'); drawer.className = 'hpe-review-drawer';
    drawer.innerHTML = '<div class="hpe-review-head"><span>页面批注</span><div class="hpe-review-actions"><button type="button" class="hpe-review-pin-toggle">隐藏编号</button><button type="button" class="hpe-review-close" aria-label="隐藏批注栏">×</button></div></div><div class="hpe-review-list"></div>';
    const list = drawer.querySelector('.hpe-review-list');

    // Source prototypes often use fixed-position floating controls.  The review
    // drawer occupies the viewport's right edge, so move those controls into
    // the remaining document area while the drawer is open.
    const reviewUiSelector = '.hpe-review-pin, .hpe-review-tooltip, .hpe-review-fab, .hpe-review-drawer';
    function shiftSourceFixedControls(open) {
      const shift = Math.ceil(drawer.getBoundingClientRect().width);
      document.querySelectorAll('*').forEach((element) => {
        if (element.matches(reviewUiSelector) || getComputedStyle(element).position !== 'fixed') return;

        let parent = element.parentElement;
        while (parent && parent !== document.body) {
          if (getComputedStyle(parent).position === 'fixed') return;
          parent = parent.parentElement;
        }

        if (open) {
          // Leave fixed elements already inside the visible document area alone.
          if (element.getBoundingClientRect().right <= innerWidth - shift) return;
          if (!element.hasAttribute('data-hpe-review-original-translate')) {
            element.setAttribute('data-hpe-review-original-translate', element.style.translate);
            element.style.translate = `-${shift}px 0`;
          }
        } else if (element.hasAttribute('data-hpe-review-original-translate')) {
          element.style.translate = element.getAttribute('data-hpe-review-original-translate');
          element.removeAttribute('data-hpe-review-original-translate');
        }
      });
    }
    if (!annotations.length) list.innerHTML = '<div class="hpe-review-empty">暂无批注</div>';
    annotations.forEach((item) => {
      const card = document.createElement('div'); card.className = 'hpe-review-item';
      card.innerHTML = '<span class="hpe-review-num"></span><div class="hpe-review-text hpe-review-text-truncated"></div><button type="button" class="hpe-review-expand">查看全文</button><div class="hpe-review-file"></div>';
      card.querySelector('.hpe-review-num').textContent = item.number;
      const text = card.querySelector('.hpe-review-text');
      const expand = card.querySelector('.hpe-review-expand');
      text.textContent = item.text;
      card.querySelector('.hpe-review-file').textContent = item.file;
      card.addEventListener('mouseenter',()=>showTooltip(card,item.text)); card.addEventListener('mouseleave',hideTooltip);
      card.addEventListener('click', () => focus({source:'hpe-review',type:'focus',id:item.id}));
      expand.addEventListener('click', (event) => {
        event.stopPropagation();
        const expanded = card.classList.toggle('hpe-review-expanded');
        text.classList.toggle('hpe-review-text-truncated', !expanded);
        expand.textContent = expanded ? '收起全文' : '查看全文';
      });
      list.appendChild(card);
      requestAnimationFrame(() => {
        if (text.scrollHeight > text.clientHeight + 1) card.classList.add('hpe-review-overflow');
        else text.classList.remove('hpe-review-text-truncated');
      });
    });
    function setDrawerOpen(open) {
      drawer.classList.toggle('open', open);
      document.documentElement.classList.toggle('hpe-review-drawer-open', open);
      shiftSourceFixedControls(open);
      setTimeout(updatePins, 220);
    }
    fab.addEventListener('click', () => setDrawerOpen(!drawer.classList.contains('open')));
    const pinToggle = drawer.querySelector('.hpe-review-pin-toggle');
    pinToggle.addEventListener('click', () => {
      setPinsVisible(!pinsVisible);
      pinToggle.textContent = pinsVisible ? '隐藏编号' : '显示编号';
    });
    drawer.querySelector('.hpe-review-close').addEventListener('click', () => setDrawerOpen(false));
    document.body.append(fab, drawer);
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || message.source !== 'hpe-review') return;
      if (message.type === 'open') { setDrawerOpen(true); focus({ ...message, type:'focus' }); }
      if (message.type === 'focus') focus(message);
      if (message.type === 'toggle-pins') { pinsVisible = message.visible; updatePins(); }
    });
  }
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message?.source !== 'hpe-review') return;
    if (message.type === 'focus') focus(message);
    if (message.type === 'toggle-pins') { pinsVisible = message.visible; updatePins(); forward(message); }
  });
  window.addEventListener('scroll', updatePins, true); window.addEventListener('resize', updatePins);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { renderPins(); if (window === window.top) createCoordinator(); });
  else { renderPins(); if (window === window.top) createCoordinator(); }
})();
