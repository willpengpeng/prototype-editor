const state = {
  project: null, files: [], entry: null, mode: 'preview', changes: [], annotations: [],
  undo: [], redo: [], pinsVisible: true, editSelection: null, annotationSelection: null,
  draftTimer: null, annotationSidebarVisible: true, pageSidebarVisible: localStorage.getItem('hpe-page-sidebar-visible') !== 'false', exportScope: 'page'
};

const $ = (selector) => document.querySelector(selector);
const elements = {
  projectChip: $('#project-chip'), projectPath: $('#project-path'), fileList: $('#file-list'), fileCount: $('#file-count'),
  frame: $('#preview-frame'), empty: $('#empty-state'), source: $('#source-file'), modeHelp: $('#mode-help'),
  annotationList: $('#annotation-list'), annotationCount: $('#annotation-count'), annotationSearch: $('#annotation-search'),
  saveState: $('#save-state'), draftState: $('#draft-state'), undo: $('#undo-btn'), redo: $('#redo-btn'),
  save: $('#save-btn'), export: $('#export-btn'), reload: $('#reload-btn'), togglePins: $('#toggle-pins-btn'),
  workspace: $('.workspace'), showAnnotations: $('#show-annotation-sidebar'), collapsedAnnotationCount: $('#collapsed-annotation-count'),
  showPages: $('#show-page-sidebar'),
  hoverPopover: $('#annotation-hover-popover')
};

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

function toast(message, type = '') {
  const item = document.createElement('div');
  item.className = `toast ${type}`;
  item.textContent = message;
  $('#toast-region').appendChild(item);
  setTimeout(() => item.remove(), 4200);
}

function openModal(id) { $(`#${id}`).classList.remove('hidden'); }
function closeModal(id) { $(`#${id}`).classList.add('hidden'); }

function encodeProjectPath(path) { return path.split('/').map(encodeURIComponent).join('/'); }

function postToPreview(message) {
  elements.frame.contentWindow?.postMessage({ source: 'hpe-app', ...message }, '*');
}

function broadcastState() {
  postToPreview({ type: 'set-mode', mode: state.mode });
  for (const change of state.changes) postToPreview({ type: 'apply-change', change });
  postToPreview({ type: 'set-annotations', annotations: numberedAnnotationsForPage() });
  postToPreview({ type: 'toggle-pins', visible: state.pinsVisible });
}

function normalizeAnnotations(items = []) {
  return items.map((item) => ({ ...item, page:item.page || item.entry || item.file }));
}

function annotationsForPage(page = state.entry) {
  return state.annotations.filter((item) => item.page === page);
}

function numberedAnnotationsForPage(page = state.entry) {
  return annotationsForPage(page).map((item, index) => ({ ...item, number:index + 1 }));
}

function renderFileList() {
  elements.fileList.replaceChildren();
  state.files.forEach((file) => {
    const count = annotationsForPage(file).length;
    const button = document.createElement('button');
    button.className = `file-item${file === state.entry ? ' active' : ''}`;
    button.innerHTML = `<span class="file-icon">◇</span><span class="file-name"></span><span class="file-annotation-count${count ? '' : ' hidden'}"></span>`;
    button.querySelector('.file-name').textContent = file;
    button.querySelector('.file-annotation-count').textContent = String(count);
    button.title = count ? `${file} · ${count} 条批注` : file;
    button.addEventListener('click', () => openEntry(file));
    elements.fileList.appendChild(button);
  });
}

function renderProject() {
  const ready = Boolean(state.project && state.entry);
  elements.projectChip.textContent = state.project?.name || '尚未打开项目';
  elements.projectChip.title = state.project?.path || '';
  elements.projectPath.textContent = state.project?.path || '打开包含 HTML、CSS、JS 和图片的项目文件夹';
  elements.fileCount.textContent = String(state.files.length);
  elements.source.textContent = state.entry || '未选择页面';
  elements.save.disabled = !ready;
  elements.export.disabled = !ready;
  elements.reload.disabled = !ready;
  renderFileList();
  elements.empty.hidden = ready;
  elements.frame.hidden = !ready;
  if (ready) elements.frame.src = `/project/${encodeProjectPath(state.entry)}?t=${Date.now()}`;
  renderStatus();
}

function renderStatus() {
  const dirty = state.changes.length;
  const pageCount = annotationsForPage().length;
  const totalCount = state.annotations.length;
  elements.saveState.textContent = !state.project ? '未打开项目' : dirty ? `${dirty} 处文字修改尚未写入文件` : '源文件未修改';
  elements.draftState.textContent = state.project ? `${pageCount} 条本页批注${totalCount !== pageCount ? ` · 项目共 ${totalCount} 条` : ''} · 草稿自动保存在本机` : '草稿仅保存在本机';
  elements.undo.disabled = state.undo.length === 0;
  elements.redo.disabled = state.redo.length === 0;
}

function renderAnnotations() {
  const query = elements.annotationSearch.value.trim().toLowerCase();
  const numbered = numberedAnnotationsForPage();
  const filtered = numbered.filter((item) => !query || item.text.toLowerCase().includes(query) || item.file.toLowerCase().includes(query));
  elements.annotationCount.textContent = String(numbered.length);
  elements.collapsedAnnotationCount.textContent = String(numbered.length);
  elements.annotationList.replaceChildren();
  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'panel-empty';
    empty.textContent = numbered.length ? '当前页面没有匹配的批注。' : '当前页面暂无批注。切换到“添加批注”，单击页面组件即可记录说明。';
    elements.annotationList.appendChild(empty);
    return;
  }
  filtered.forEach((item) => {
    const card = document.createElement('article');
    card.className = 'annotation-card';
    card.innerHTML = `<span class="annotation-index"></span><div class="annotation-text"></div><div class="annotation-meta"><span class="annotation-file"></span><span class="annotation-actions"><button data-action="edit">修改</button><button data-action="delete">删除</button></span></div>`;
    card.querySelector('.annotation-index').textContent = String(item.number);
    card.querySelector('.annotation-text').textContent = item.text;
    card.querySelector('.annotation-file').textContent = item.file;
    card.addEventListener('mouseenter', () => showAnnotationPopover(item.text, card));
    card.addEventListener('mouseleave', hideAnnotationPopover);
    card.addEventListener('click', (event) => {
      if (event.target.closest('button')) return;
      postToPreview({ type:'focus-target', file:item.file, nodeId:item.target.nodeId });
    });
    card.querySelector('[data-action="edit"]').addEventListener('click', () => editAnnotation(item.id));
    card.querySelector('[data-action="delete"]').addEventListener('click', () => deleteAnnotation(item.id));
    elements.annotationList.appendChild(card);
  });
}

function showAnnotationPopover(text, anchor) {
  const box = anchor.getBoundingClientRect();
  elements.hoverPopover.textContent = text;
  elements.hoverPopover.classList.remove('hidden');
  const popoverBox = elements.hoverPopover.getBoundingClientRect();
  const left = Math.max(12, box.left - popoverBox.width - 12);
  const top = Math.min(innerHeight - popoverBox.height - 12, Math.max(72, box.top));
  elements.hoverPopover.style.left = `${left}px`;
  elements.hoverPopover.style.top = `${top}px`;
}

function hideAnnotationPopover() { elements.hoverPopover.classList.add('hidden'); }

function setAnnotationSidebar(visible) {
  state.annotationSidebarVisible = visible;
  elements.workspace.classList.toggle('annotation-collapsed', !visible);
  elements.showAnnotations.classList.toggle('hidden', visible);
  hideAnnotationPopover();
}

function setPageSidebar(visible) {
  state.pageSidebarVisible = visible;
  elements.workspace.classList.toggle('page-collapsed', !visible);
  elements.showPages.classList.toggle('hidden', visible);
  localStorage.setItem('hpe-page-sidebar-visible', String(visible));
}

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.mode-btn').forEach((button) => button.classList.toggle('active', button.dataset.mode === mode));
  const help = { preview:'预览模式：页面交互保持原样', edit:'编辑文字：单击页面中的静态文字', annotate:'添加批注：单击需要说明的组件' };
  elements.modeHelp.textContent = help[mode];
  postToPreview({ type:'set-mode', mode });
}

async function loadStatus() {
  const data = await api('/api/status');
  state.project = data.project;
  state.files = data.files || [];
  state.entry = data.entry;
  state.changes = data.draft?.changes || [];
  state.annotations = normalizeAnnotations(data.draft?.annotations);
  renderProject();
  renderAnnotations();
}

async function selectProject() {
  try {
    const data = await api('/api/select-project', { method:'POST', body:'{}' });
    state.project = data.project; state.files = data.files || []; state.entry = data.entry;
    state.changes = data.draft?.changes || []; state.annotations = normalizeAnnotations(data.draft?.annotations);
    state.undo = []; state.redo = [];
    renderProject(); renderAnnotations();
    if (!state.files.length) toast('该文件夹中没有找到 HTML 文件', 'error');
  } catch (error) { if (error.message !== '已取消选择') toast(error.message, 'error'); }
}

async function openEntry(file) {
  if (file === state.entry) return;
  clearTimeout(state.draftTimer);
  await persistDraft(false);
  state.entry = file;
  state.undo = []; state.redo = [];
  state.editSelection = null; state.annotationSelection = null;
  elements.annotationSearch.value = '';
  hideAnnotationPopover();
  await api('/api/entry', { method:'POST', body:JSON.stringify({ entry:file }) });
  renderProject();
  renderAnnotations();
  renderStatus();
}

function changeKey(change) { return `${change.file}|${change.nodeId}|${change.kind}|${change.attribute || ''}`; }

function setChangeValue(selection, value, recordHistory = true) {
  const incoming = { file:selection.file, nodeId:selection.target.nodeId, kind:selection.kind, attribute:selection.attribute || null, oldValue:selection.originalValue ?? selection.value, newValue:value };
  const key = changeKey(incoming);
  const existingIndex = state.changes.findIndex((item) => changeKey(item) === key);
  const currentValue = existingIndex >= 0 ? state.changes[existingIndex].newValue : incoming.oldValue;
  const originalValue = existingIndex >= 0 ? state.changes[existingIndex].oldValue : incoming.oldValue;
  if (recordHistory) { state.undo.push({ type:'text', selection:{...selection, originalValue}, from:currentValue, to:value }); state.redo = []; }
  incoming.oldValue = originalValue;
  if (value === originalValue) {
    if (existingIndex >= 0) state.changes.splice(existingIndex, 1);
  } else if (existingIndex >= 0) state.changes[existingIndex] = incoming;
  else state.changes.push(incoming);
  postToPreview({ type:'apply-change', change:{...incoming, newValue:value} });
  scheduleDraft(); renderStatus();
}

function pushAnnotationAction(before, after) {
  state.undo.push({ type:'annotation', before, after }); state.redo = [];
}

function commitAnnotation(before, after, recordHistory = true) {
  if (recordHistory) pushAnnotationAction(before, after);
  if (before) state.annotations = state.annotations.filter((item) => item.id !== before.id);
  if (after) state.annotations.push(after);
  renderFileList();
  renderAnnotations();
  postToPreview({ type:'set-annotations', annotations:numberedAnnotationsForPage() });
  scheduleDraft(); renderStatus();
}

function editAnnotation(id) {
  const item = state.annotations.find((annotation) => annotation.id === id);
  if (!item) return;
  state.annotationSelection = { editing:item };
  $('#annotation-modal-title').textContent = '修改说明';
  $('#annotation-target').textContent = item.target.label || item.target.tag;
  $('#annotation-source').textContent = item.file;
  $('#annotation-value').value = item.text;
  openModal('annotation-modal');
  $('#annotation-value').focus();
}

function deleteAnnotation(id) {
  const item = state.annotations.find((annotation) => annotation.id === id);
  if (item) commitAnnotation(item, null);
}

function undo() {
  const action = state.undo.pop();
  if (!action) return;
  state.redo.push(action);
  if (action.type === 'text') setChangeValue(action.selection, action.from, false);
  else commitAnnotation(action.after, action.before, false);
  renderStatus();
}

function redo() {
  const action = state.redo.pop();
  if (!action) return;
  state.undo.push(action);
  if (action.type === 'text') setChangeValue(action.selection, action.to, false);
  else commitAnnotation(action.before, action.after, false);
  renderStatus();
}

function scheduleDraft() {
  clearTimeout(state.draftTimer);
  elements.draftState.textContent = '正在保存本地草稿…';
  state.draftTimer = setTimeout(() => persistDraft(true), 450);
}

async function persistDraft(showState = true) {
  try {
    const result = await api('/api/draft', { method:'POST', body:JSON.stringify({ entry:state.entry, changes:state.changes, annotations:state.annotations }) });
    if (showState) {
      const pageCount = annotationsForPage().length;
      const totalCount = state.annotations.length;
      elements.draftState.textContent = `${pageCount} 条本页批注${totalCount !== pageCount ? ` · 项目共 ${totalCount} 条` : ''} · 草稿已保存 ${new Date(result.updatedAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}`;
    }
    return result;
  } catch (error) {
    if (showState) { elements.draftState.textContent = '草稿保存失败'; toast(error.message, 'error'); }
    throw error;
  }
}

async function save(mode) {
  closeModal('save-modal');
  try {
    const body = { mode, page:state.entry, changes:state.changes, annotations:annotationsForPage() };
    const result = await api('/api/save', { method:'POST', body:JSON.stringify(body) });
    if (mode === 'overwrite') {
      state.changes = []; state.undo = []; state.redo = [];
      elements.frame.src = `/project/${encodeProjectPath(state.entry)}?t=${Date.now()}`;
      toast(`已保存并备份：${result.changedFiles.length} 个文件`, 'success');
    } else toast(`项目副本已保存到：${result.path}`, 'success');
    renderStatus();
  } catch (error) { toast(error.message, 'error'); }
}

async function exportProject(kind) {
  closeModal('export-modal');
  try {
    const exportAnnotations = kind === 'annotated' ? annotationsForPage() : [];
    const result = await api('/api/export', { method:'POST', body:JSON.stringify({ kind, scope:state.exportScope, entry:state.entry, changes:state.changes, annotations:exportAnnotations }) });
    const scopeLabel = state.exportScope === 'page' ? '当前页面' : '页面所在文件夹';
    const versionLabel = kind === 'annotated' ? '批注版' : '标准版';
    toast(result.zipPath ? `${scopeLabel}${versionLabel}已导出并打包：${result.zipPath}` : `${scopeLabel}${versionLabel}已导出：${result.filePath}`, 'success');
  } catch (error) { toast(error.message, 'error'); }
}

window.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || message.source !== 'hpe-bridge') return;
  if (message.type === 'frame-ready') return setTimeout(broadcastState, 40);
  if (message.type === 'notice') return toast(message.message);
  if (message.type === 'select-edit') {
    state.editSelection = { file:message.file, target:message.target, kind:message.kind, attribute:message.attribute, value:message.value };
    $('#edit-source').textContent = message.file;
    $('#edit-value').value = message.value;
    openModal('editor-modal');
    $('#edit-value').focus();
  }
  if (message.type === 'select-annotation') {
    state.annotationSelection = { file:message.file, target:message.target };
    $('#annotation-modal-title').textContent = '添加说明';
    $('#annotation-target').textContent = message.target.label || message.target.tag;
    $('#annotation-source').textContent = message.file;
    $('#annotation-value').value = '';
    openModal('annotation-modal');
    $('#annotation-value').focus();
  }
  if (message.type === 'focus-annotation') {
    const item = annotationsForPage().find((annotation) => annotation.id === message.id);
    if (item) postToPreview({ type:'focus-target', file:item.file, nodeId:item.target.nodeId });
  }
});

document.querySelectorAll('.mode-btn').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => closeModal(button.dataset.close)));
$('#open-project-btn').addEventListener('click', selectProject);
$('#empty-open-btn').addEventListener('click', selectProject);
elements.reload.addEventListener('click', () => { elements.frame.src = `/project/${encodeProjectPath(state.entry)}?t=${Date.now()}`; });
elements.undo.addEventListener('click', undo);
elements.redo.addEventListener('click', redo);
elements.save.addEventListener('click', () => openModal('save-modal'));
elements.export.addEventListener('click', () => openModal('export-modal'));
$('#save-copy-btn').addEventListener('click', () => save('copy'));
$('#save-overwrite-btn').addEventListener('click', () => save('overwrite'));
document.querySelectorAll('[data-export-kind]').forEach((button) => button.addEventListener('click', () => exportProject(button.dataset.exportKind)));
document.querySelectorAll('[data-export-scope]').forEach((button) => button.addEventListener('click', () => {
  state.exportScope = button.dataset.exportScope;
  document.querySelectorAll('[data-export-scope]').forEach((item) => item.classList.toggle('active', item === button));
}));
elements.annotationSearch.addEventListener('input', renderAnnotations);
$('#hide-annotation-sidebar').addEventListener('click', () => setAnnotationSidebar(false));
elements.showAnnotations.addEventListener('click', () => setAnnotationSidebar(true));
$('#hide-page-sidebar').addEventListener('click', () => setPageSidebar(false));
elements.showPages.addEventListener('click', () => setPageSidebar(true));
elements.togglePins.addEventListener('click', () => {
  state.pinsVisible = !state.pinsVisible;
  elements.togglePins.textContent = state.pinsVisible ? '隐藏编号' : '显示编号';
  postToPreview({ type:'toggle-pins', visible:state.pinsVisible });
});
$('#confirm-edit-btn').addEventListener('click', () => {
  if (!state.editSelection) return;
  setChangeValue(state.editSelection, $('#edit-value').value);
  closeModal('editor-modal');
  toast('文字修改已加入本地草稿', 'success');
});
$('#confirm-annotation-btn').addEventListener('click', () => {
  const value = $('#annotation-value').value.trim();
  if (!value) return toast('请输入批注内容', 'error');
  const editing = state.annotationSelection?.editing;
  if (editing) commitAnnotation(editing, { ...editing, text:value, updatedAt:new Date().toISOString() });
  else {
    const selection = state.annotationSelection;
    if (!selection?.target) return;
    commitAnnotation(null, { id:`a-${Date.now()}-${Math.random().toString(16).slice(2,7)}`, page:state.entry, file:selection.file, target:selection.target, text:value, createdAt:new Date().toISOString() });
  }
  closeModal('annotation-modal');
  toast('批注已保存到本地草稿', 'success');
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') document.querySelectorAll('.modal-backdrop:not(.hidden)').forEach((modal) => modal.classList.add('hidden'));
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); }
});

setPageSidebar(state.pageSidebarVisible);
loadStatus().catch((error) => toast(error.message, 'error'));
