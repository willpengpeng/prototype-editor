import { createServer } from 'node:http';
import { readFile, writeFile, readdir, stat, mkdir, copyFile, cp, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, extname, join, resolve, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import * as parse5 from 'parse5';

const execFileAsync = promisify(execFile);
const APP_ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = join(APP_ROOT, 'src');
const DATA_ROOT = join(os.homedir(), 'Library', 'Application Support', 'HTML Prototype Editor');
const PORT = Number(process.env.PORT || 4178);
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.html-review', '.html-prototype-editor']);
let projectRoot = process.env.HPE_PROJECT ? resolve(process.env.HPE_PROJECT) : null;
let activeEntry = process.env.HPE_ENTRY || null;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.pdf': 'application/pdf'
};

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}

function text(res, status, value, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(value), 'Cache-Control': 'no-store' });
  res.end(value);
}

async function bodyJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 5 * 1024 * 1024) throw new Error('请求内容过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function normalizeRel(value = '') {
  const decoded = decodeURIComponent(value).replaceAll('\\', '/').replace(/^\/+/, '');
  const parts = decoded.split('/').filter(Boolean);
  if (parts.some((p) => p === '..')) throw new Error('路径不安全');
  return parts.join('/');
}

function resolveIn(root, relPath) {
  const candidate = resolve(root, relPath);
  if (candidate !== root && !candidate.startsWith(root + sep)) throw new Error('路径超出项目目录');
  return candidate;
}

async function isDirectory(path) {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

async function listHtmlFiles(root) {
  const results = [];
  async function walk(dir, prefix = '') {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
      else if (/\.html?$/i.test(entry.name)) results.push(rel);
    }
  }
  await walk(root);
  return results;
}

function projectKey(root) {
  return createHash('sha256').update(root).digest('hex').slice(0, 20);
}

function statePath(root) {
  return join(DATA_ROOT, 'projects', projectKey(root), 'draft.json');
}

async function loadDraft(root) {
  try { return JSON.parse(await readFile(statePath(root), 'utf8')); }
  catch { return { entry: null, changes: [], annotations: [], updatedAt: null }; }
}

async function saveDraft(root, draft) {
  const path = statePath(root);
  await mkdir(dirname(path), { recursive: true });
  const payload = { ...draft, projectRoot: root, updatedAt: new Date().toISOString() };
  await writeFile(path, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function traverseElements(node, visit) {
  if (node.tagName && node.sourceCodeLocation?.startTag) visit(node);
  for (const child of node.childNodes || []) traverseElements(child, visit);
  if (node.content) traverseElements(node.content, visit);
}

export function indexHtml(html) {
  const doc = parse5.parse(html, { sourceCodeLocationInfo: true });
  const nodes = [];
  traverseElements(doc, (node) => {
    const nodeId = `n${nodes.length}`;
    nodes.push({ nodeId, node });
  });
  return { doc, nodes };
}

function insertBeforeDocumentEnd(html, addition) {
  const bodyIndex = html.toLowerCase().lastIndexOf('</body>');
  if (bodyIndex >= 0) return html.slice(0, bodyIndex) + addition + html.slice(bodyIndex);
  const htmlIndex = html.toLowerCase().lastIndexOf('</html>');
  if (htmlIndex >= 0) return html.slice(0, htmlIndex) + addition + html.slice(htmlIndex);
  return html + addition;
}

export function markHtml(html) {
  const { nodes } = indexHtml(html);
  const inserts = [];
  for (const { nodeId, node } of nodes) {
    if ((node.attrs || []).some((attr) => attr.name === 'data-hpe-node')) continue;
    const loc = node.sourceCodeLocation.startTag;
    let offset = loc.endOffset - 1;
    if (html[offset - 1] === '/') offset -= 1;
    inserts.push({ offset, value: ` data-hpe-node="${nodeId}"` });
  }
  inserts.sort((a, b) => b.offset - a.offset);
  let output = html;
  for (const item of inserts) output = output.slice(0, item.offset) + item.value + output.slice(item.offset);
  return output;
}

function safeInlineJson(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
}

function injectEditor(html, relPath) {
  const marked = markHtml(html);
  const payload = `<script>window.__HPE_FILE=${safeInlineJson(relPath)};</script><script src="/bridge.js"></script>`;
  return insertBeforeDocumentEnd(marked, payload);
}

function escapeTextValue(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeAttrValue(value) {
  return escapeTextValue(value).replaceAll('"', '&quot;');
}

export function applyChangesToHtml(html, changes) {
  const { nodes } = indexHtml(html);
  const map = new Map(nodes.map((item) => [item.nodeId, item.node]));
  const replacements = [];
  const seen = new Set();
  for (const change of changes) {
    const key = `${change.nodeId}|${change.kind}|${change.attribute || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const node = map.get(change.nodeId);
    if (!node) throw new Error(`无法定位组件 ${change.nodeId}`);
    if (change.kind === 'text') {
      const loc = node.sourceCodeLocation;
      if (!loc?.startTag || !loc?.endTag) throw new Error(`组件 ${change.nodeId} 不能修改文字`);
      const hasElementChild = (node.childNodes || []).some((child) => child.tagName);
      if (hasElementChild) throw new Error(`组件 ${change.nodeId} 含有嵌套结构，首版仅支持叶子文字`);
      replacements.push({ start: loc.startTag.endOffset, end: loc.endTag.startOffset, value: escapeTextValue(change.newValue) });
    } else if (change.kind === 'attr') {
      const attrName = String(change.attribute || '').toLowerCase();
      if (!['placeholder', 'value', 'title', 'alt'].includes(attrName)) throw new Error(`暂不支持属性 ${attrName}`);
      const attrLoc = node.sourceCodeLocation?.attrs?.[attrName];
      if (attrLoc) replacements.push({ start: attrLoc.startOffset, end: attrLoc.endOffset, value: `${attrName}="${escapeAttrValue(change.newValue)}"` });
      else {
        const startTag = node.sourceCodeLocation?.startTag;
        if (!startTag) throw new Error(`组件 ${change.nodeId} 缺少开始标签`);
        let offset = startTag.endOffset - 1;
        if (html[offset - 1] === '/') offset -= 1;
        replacements.push({ start: offset, end: offset, value: ` ${attrName}="${escapeAttrValue(change.newValue)}"` });
      }
    }
  }
  replacements.sort((a, b) => b.start - a.start);
  let output = html;
  for (const replacement of replacements) output = output.slice(0, replacement.start) + replacement.value + output.slice(replacement.end);
  return output;
}

async function applyChangesToProject(root, changes, backup = false) {
  const groups = new Map();
  for (const change of changes || []) {
    if (!groups.has(change.file)) groups.set(change.file, []);
    groups.get(change.file).push(change);
  }
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const changedFiles = [];
  for (const [relPath, fileChanges] of groups) {
    const sourcePath = resolveIn(root, normalizeRel(relPath));
    const source = await readFile(sourcePath, 'utf8');
    const output = applyChangesToHtml(source, fileChanges);
    if (output === source) continue;
    if (backup) {
      const backupPath = join(DATA_ROOT, 'backups', projectKey(root), stamp, relPath);
      await mkdir(dirname(backupPath), { recursive: true });
      await copyFile(sourcePath, backupPath);
    }
    const tempPath = sourcePath + `.hpe-${process.pid}.tmp`;
    await writeFile(tempPath, output, 'utf8');
    await rename(tempPath, sourcePath);
    changedFiles.push(relPath);
  }
  return changedFiles;
}

async function copyProject(sourceRoot, destinationRoot) {
  if (destinationRoot === sourceRoot || destinationRoot.startsWith(sourceRoot + sep)) throw new Error('目标文件夹不能位于原项目内部');
  if (await isDirectory(destinationRoot)) throw new Error('目标文件夹已存在，请更换名称');
  await cp(sourceRoot, destinationRoot, {
    recursive: true,
    preserveTimestamps: true,
    filter(source) {
      const name = basename(source);
      return name !== '.DS_Store' && !IGNORED_DIRS.has(name);
    }
  });
}

function localReference(value, fromFile) {
  const raw = String(value || '').trim().replace(/^['"]|['"]$/g, '');
  if (!raw || /^(?:[a-z]+:|\/\/|#)/i.test(raw)) return null;
  const clean = raw.split('#')[0].split('?')[0];
  if (!clean) return null;
  let decoded = clean;
  try { decoded = decodeURIComponent(clean); } catch {}
  const joined = decoded.startsWith('/') ? decoded.slice(1) : join(dirname(fromFile), decoded);
  return normalizeRel(joined.split(sep).join('/'));
}

function referencesFromHtml(html, relPath) {
  const { nodes } = indexHtml(html);
  const refs = [];
  const attrNames = new Set(['src', 'href', 'poster', 'data', 'action']);
  for (const { node } of nodes) {
    for (const attr of node.attrs || []) {
      if (attr.name === 'srcset') {
        for (const item of attr.value.split(',')) {
          const ref = localReference(item.trim().split(/\s+/)[0], relPath);
          if (ref) refs.push(ref);
        }
      } else if (attrNames.has(attr.name)) {
        const ref = localReference(attr.value, relPath);
        if (ref) refs.push(ref);
      } else if (attr.name === 'style') {
        for (const match of attr.value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
          const ref = localReference(match[2], relPath);
          if (ref) refs.push(ref);
        }
      }
    }
  }
  for (const match of html.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
    const ref = localReference(match[2], relPath);
    if (ref) refs.push(ref);
  }
  return refs;
}

function referencesFromCss(css, relPath) {
  const refs = [];
  for (const match of css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
    const ref = localReference(match[2], relPath);
    if (ref) refs.push(ref);
  }
  for (const match of css.matchAll(/@import\s+(?:url\()?\s*(['"])(.*?)\1\s*\)?/gi)) {
    const ref = localReference(match[2], relPath);
    if (ref) refs.push(ref);
  }
  return refs;
}

export async function collectPageFiles(root, entry) {
  const queue = [normalizeRel(entry)];
  const files = new Set();
  while (queue.length) {
    const relPath = queue.shift();
    if (!relPath || files.has(relPath)) continue;
    let filePath;
    let info;
    try { filePath = resolveIn(root, relPath); } catch { continue; }
    try { info = await stat(filePath); } catch { continue; }
    if (info.isDirectory()) {
      const indexPath = normalizeRel(`${relPath}/index.html`);
      queue.push(indexPath);
      continue;
    }
    if (!info.isFile()) continue;
    files.add(relPath);
    const extension = extname(relPath).toLowerCase();
    if (!['.html', '.htm', '.css'].includes(extension)) continue;
    const source = await readFile(filePath, 'utf8');
    const refs = extension === '.css' ? referencesFromCss(source, relPath) : referencesFromHtml(source, relPath);
    for (const ref of refs) if (!files.has(ref)) queue.push(ref);
  }
  return files;
}

async function copyPageBundle(sourceRoot, destinationRoot, entry) {
  if (destinationRoot === sourceRoot || destinationRoot.startsWith(sourceRoot + sep)) throw new Error('目标文件夹不能位于原项目内部');
  if (await isDirectory(destinationRoot)) throw new Error('目标文件夹已存在，请更换名称');
  const files = await collectPageFiles(sourceRoot, entry);
  if (!files.has(normalizeRel(entry))) throw new Error('当前页面不存在');
  await mkdir(destinationRoot, { recursive: true });
  for (const relPath of files) {
    const source = resolveIn(sourceRoot, relPath);
    const target = resolveIn(destinationRoot, relPath);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  return files;
}

async function chooseFolder(promptText) {
  const script = `POSIX path of (choose folder with prompt ${JSON.stringify(promptText)})`;
  const { stdout } = await execFileAsync('/usr/bin/osascript', ['-e', script]);
  return stdout.trim().replace(/\/$/, '');
}

function timestampName() {
  const d = new Date();
  const pad = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function sanitizeFolderName(value) {
  const cleaned = String(value || '').replace(/[\\/:*?"<>|]/g, '-').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') throw new Error('文件夹名称无效');
  return cleaned;
}

function changesByFile(changes) {
  const groups = new Map();
  for (const change of changes || []) {
    const file = normalizeRel(change.file);
    if (!groups.has(file)) groups.set(file, []);
    groups.get(file).push(change);
  }
  return groups;
}

function attrsOf(node) {
  return Object.fromEntries((node.attrs || []).map((attr) => [attr.name, attr.value]));
}

async function fileDataUrl(root, relPath) {
  try {
    const filePath = resolveIn(root, relPath);
    const info = await stat(filePath);
    if (!info.isFile()) return null;
    const type = (MIME[extname(relPath).toLowerCase()] || 'application/octet-stream').split(';')[0];
    return `data:${type};base64,${(await readFile(filePath)).toString('base64')}`;
  } catch { return null; }
}

async function inlineCssFiles(root, css, relPath) {
  const matches = [...css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)];
  const replacements = [];
  for (const match of matches) {
    const ref = localReference(match[2], relPath);
    if (!ref) continue;
    const dataUrl = await fileDataUrl(root, ref);
    if (dataUrl) replacements.push({ start:match.index, end:match.index + match[0].length, value:`url("${dataUrl}")` });
  }
  replacements.sort((a, b) => b.start - a.start);
  let output = css;
  for (const item of replacements) output = output.slice(0, item.start) + item.value + output.slice(item.end);
  return output;
}

function escapeInlineScript(value) { return String(value).replace(/<\/script/gi, '<\\/script'); }
function escapeInlineStyle(value) { return String(value).replace(/<\/style/gi, '<\\/style'); }

async function buildSelfContainedHtml(root, relPath, annotations = null, seen = new Set(), changes = null) {
  const safeRelPath = normalizeRel(relPath);
  if (seen.has(safeRelPath)) return '<!doctype html><meta charset="utf-8"><p>循环引用的页面无法再次内嵌。</p>';
  const branch = new Set(seen); branch.add(safeRelPath);
  let source = await readFile(resolveIn(root, safeRelPath), 'utf8');
  if (changes?.has(safeRelPath)) source = applyChangesToHtml(source, changes.get(safeRelPath));
  let html = annotations ? markHtml(source) : source;
  const { nodes } = indexHtml(html);
  const replacements = [];

  for (const { node } of nodes) {
    const tag = node.tagName;
    const attrs = attrsOf(node);
    const location = node.sourceCodeLocation;
    if (!location?.startTag) continue;

    if (tag === 'link' && /(?:^|\s)stylesheet(?:\s|$)/i.test(attrs.rel || '') && attrs.href) {
      const ref = localReference(attrs.href, safeRelPath);
      if (!ref) continue;
      try {
        const css = await inlineCssFiles(root, await readFile(resolveIn(root, ref), 'utf8'), ref);
        replacements.push({ start:location.startTag.startOffset, end:location.startTag.endOffset, value:`<style data-inline-source="${escapeAttrValue(ref)}">${escapeInlineStyle(css)}</style>` });
      } catch {}
      continue;
    }

    if (tag === 'script' && attrs.src && location.endTag) {
      const ref = localReference(attrs.src, safeRelPath);
      if (!ref) continue;
      try {
        const script = await readFile(resolveIn(root, ref), 'utf8');
        replacements.push({ start:location.startOffset, end:location.endOffset, value:`<script data-inline-source="${escapeAttrValue(ref)}">${escapeInlineScript(script)}</script>` });
      } catch {}
      continue;
    }

    if (tag === 'iframe' && attrs.src) {
      const ref = localReference(attrs.src, safeRelPath);
      if (!ref || !/\.html?$/i.test(ref)) continue;
      try {
        const childHtml = await buildSelfContainedHtml(root, ref, annotations, branch, changes);
        const startTag = html.slice(location.startTag.startOffset, location.startTag.endOffset);
        const withoutSrc = startTag.replace(/\s+src\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, '');
        const insertAt = withoutSrc.endsWith('/>') ? withoutSrc.length - 2 : withoutSrc.length - 1;
        const inlinedTag = `${withoutSrc.slice(0, insertAt)} srcdoc="${escapeAttrValue(childHtml)}"${withoutSrc.slice(insertAt)}`;
        replacements.push({ start:location.startTag.startOffset, end:location.startTag.endOffset, value:inlinedTag });
      } catch {}
      continue;
    }

    for (const attrName of ['src', 'poster']) {
      if (!attrs[attrName] || tag === 'iframe' || tag === 'script') continue;
      const attrLocation = location.attrs?.[attrName];
      const ref = localReference(attrs[attrName], safeRelPath);
      if (!attrLocation || !ref) continue;
      const dataUrl = await fileDataUrl(root, ref);
      if (dataUrl) replacements.push({ start:attrLocation.startOffset, end:attrLocation.endOffset, value:`${attrName}="${dataUrl}"` });
    }
  }

  replacements.sort((a, b) => b.start - a.start);
  for (const item of replacements) html = html.slice(0, item.start) + item.value + html.slice(item.end);

  if (!annotations) return html;
  const viewerCss = escapeInlineStyle(await readFile(join(PUBLIC_ROOT, 'review-viewer.css'), 'utf8'));
  const viewerJs = escapeInlineScript(await readFile(join(PUBLIC_ROOT, 'review-viewer.js'), 'utf8'));
  const payload = `<style data-hpe-review>${viewerCss}</style>` +
    `<script>window.__HPE_REVIEW_FILE=${safeInlineJson(safeRelPath)};window.__HPE_ANNOTATIONS=${safeInlineJson(annotations)};</script>` +
    `<script data-hpe-review>${viewerJs}</script>`;
  return insertBeforeDocumentEnd(html, payload);
}

async function buildAnnotatedCopy(root, entry, annotations, changes = null, outputName = `${basename(entry, extname(entry))}_带批注.html`) {
  const html = await buildSelfContainedHtml(root, entry, annotations, new Set(), changes);
  await writeFile(join(root, outputName), html, 'utf8');
  return outputName;
}

async function buildStandardCopy(root, entry, changes = null, outputName = `${basename(entry, extname(entry))}_标准版.html`) {
  const html = await buildSelfContainedHtml(root, entry, null, new Set(), changes);
  await writeFile(join(root, outputName), html, 'utf8');
  return outputName;
}

async function uniqueOutputName(folder, preferredName) {
  const extension = /\.html?$/i.test(preferredName) ? '' : '.html';
  const desired = `${preferredName}${extension}`;
  const base = basename(desired, extname(desired));
  const suffix = extname(desired) || '.html';
  for (let index = 1; index < 1000; index += 1) {
    const candidate = index === 1 ? desired : `${base}-${index}${suffix}`;
    try { await stat(join(folder, candidate)); }
    catch { return candidate; }
  }
  throw new Error('导出文件重名过多，请稍后再试');
}

async function keepOnlyFile(root, fileName) {
  for (const name of await readdir(root)) {
    if (name === fileName) continue;
    await rm(join(root, name), { recursive:true, force:true });
  }
}

async function writeRunnableEntry(root, entry) {
  const wrapper = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HTML 页面运行版</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}</style></head><body><iframe src="${escapeAttrValue(entry)}"></iframe></body></html>`;
  await writeFile(join(root, '打开页面.html'), wrapper, 'utf8');
}

function annotationPage(item) { return item.page || item.entry || item.file; }

function mergePageAnnotations(existing, current, page) {
  const normalizedExisting = (existing || []).map((item) => ({ ...item, page:annotationPage(item) }));
  const normalizedCurrent = (current || []).map((item) => ({ ...item, page:page || annotationPage(item) }));
  return normalizedExisting.filter((item) => item.page !== page).concat(normalizedCurrent);
}

async function projectInfo() {
  if (!projectRoot || !(await isDirectory(projectRoot))) return { project: null, files: [], entry: null, draft: null };
  const files = await listHtmlFiles(projectRoot);
  const draft = await loadDraft(projectRoot);
  const entry = activeEntry && files.includes(activeEntry) ? activeEntry : (draft.entry && files.includes(draft.entry) ? draft.entry : files[0] || null);
  activeEntry = entry;
  return { project: { name: basename(projectRoot), path: projectRoot }, files, entry, draft };
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, await projectInfo());
  if (req.method === 'POST' && url.pathname === '/api/select-project') {
    try {
      const selected = await chooseFolder('选择包含 HTML 原型的项目文件夹');
      if (!(await isDirectory(selected))) throw new Error('选择的目录不可用');
      projectRoot = resolve(selected); activeEntry = null;
      return json(res, 200, await projectInfo());
    } catch (error) {
      if (/User canceled/i.test(error.message)) return json(res, 409, { error: '已取消选择' });
      throw error;
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/set-project') {
    const body = await bodyJson(req);
    const selected = resolve(String(body.path || ''));
    if (!(await isDirectory(selected))) throw new Error('项目文件夹不存在');
    projectRoot = selected; activeEntry = null;
    return json(res, 200, await projectInfo());
  }
  if (req.method === 'POST' && url.pathname === '/api/entry') {
    if (!projectRoot) throw new Error('尚未打开项目');
    const body = await bodyJson(req);
    const entry = normalizeRel(body.entry);
    await stat(resolveIn(projectRoot, entry));
    activeEntry = entry;
    const draft = await loadDraft(projectRoot);
    await saveDraft(projectRoot, { ...draft, entry });
    return json(res, 200, { entry });
  }
  if (req.method === 'POST' && url.pathname === '/api/draft') {
    if (!projectRoot) throw new Error('尚未打开项目');
    const body = await bodyJson(req);
    return json(res, 200, await saveDraft(projectRoot, { entry: body.entry || activeEntry, changes: body.changes || [], annotations: body.annotations || [] }));
  }
  if (req.method === 'POST' && url.pathname === '/api/choose-destination') {
    try { return json(res, 200, { path: await chooseFolder('选择保存位置') }); }
    catch (error) {
      if (/User canceled/i.test(error.message)) return json(res, 409, { error: '已取消选择' });
      throw error;
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/save') {
    if (!projectRoot) throw new Error('尚未打开项目');
    const body = await bodyJson(req);
    if (body.mode === 'overwrite') {
      const changedFiles = await applyChangesToProject(projectRoot, body.changes || [], true);
      const draft = await loadDraft(projectRoot);
      const annotations = body.page ? mergePageAnnotations(draft.annotations, body.annotations, body.page) : (body.annotations || draft.annotations || []);
      await saveDraft(projectRoot, { entry: activeEntry, changes: [], annotations });
      return json(res, 200, { mode: 'overwrite', path: projectRoot, changedFiles });
    }
    const parent = resolve(body.destinationParent || dirname(projectRoot));
    const name = sanitizeFolderName(body.name || `${basename(projectRoot)}_修改版_${timestampName()}`);
    const destination = join(parent, name);
    await copyProject(projectRoot, destination);
    const changedFiles = await applyChangesToProject(destination, body.changes || [], false);
    return json(res, 200, { mode: 'copy', path: destination, changedFiles });
  }
  if (req.method === 'POST' && url.pathname === '/api/export') {
    if (!projectRoot) throw new Error('尚未打开项目');
    const body = await bodyJson(req);
    const kind = body.kind === 'annotated' ? 'annotated' : 'runnable';
    const scope = body.scope === 'page' ? 'page' : 'folder';
    const suffix = kind === 'annotated' ? '批注版' : '运行版';
    const entry = normalizeRel(body.entry || activeEntry);
    await stat(resolveIn(projectRoot, entry));
    if (scope === 'page') {
      const sourceFolder = dirname(resolveIn(projectRoot, entry));
      const preferredName = sanitizeFolderName(body.name || `${basename(entry, extname(entry))}_${suffix}_${timestampName()}`);
      const outputEntry = await uniqueOutputName(sourceFolder, preferredName);
      const changes = changesByFile(body.changes);
      const outputPath = join(dirname(entry), outputEntry);
      if (kind === 'annotated') await buildAnnotatedCopy(projectRoot, entry, body.annotations || [], changes, outputPath);
      else await buildStandardCopy(projectRoot, entry, changes, outputPath);
      return json(res, 200, { kind, scope, path:sourceFolder, zipPath:null, copiedFiles:null, entry:outputEntry, filePath:join(sourceFolder, outputEntry) });
    }
    const parent = resolve(body.destinationParent || dirname(projectRoot));
    const baseName = basename(projectRoot);
    const name = sanitizeFolderName(body.name || `${baseName}_${suffix}_${timestampName()}`);
    const destination = join(parent, name);
    let copiedFiles = null;
    await copyProject(projectRoot, destination);
    const applicableChanges = copiedFiles ? (body.changes || []).filter((change) => copiedFiles.has(change.file)) : (body.changes || []);
    await applyChangesToProject(destination, applicableChanges, false);
    let outputEntry = entry;
    if (kind === 'annotated') {
      outputEntry = await buildAnnotatedCopy(destination, entry, body.annotations || []);
    }
    const zipPath = `${destination}.zip`;
    await execFileAsync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', destination, zipPath]);
    return json(res, 200, { kind, scope, path: destination, zipPath, copiedFiles:copiedFiles ? [...copiedFiles] : null, entry:outputEntry, filePath:join(destination, outputEntry) });
  }
  return false;
}

async function serveProject(req, res, url) {
  if (!projectRoot) return json(res, 404, { error: '尚未打开项目' });
  const relPath = normalizeRel(url.pathname.slice('/project/'.length));
  const filePath = resolveIn(projectRoot, relPath);
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error('目标不是文件');
  const extension = extname(filePath).toLowerCase();
  const buffer = await readFile(filePath);
  if (extension === '.html' || extension === '.htm') return text(res, 200, injectEditor(buffer.toString('utf8'), relPath), MIME[extension]);
  res.writeHead(200, { 'Content-Type': MIME[extension] || 'application/octet-stream', 'Content-Length': buffer.length, 'Cache-Control': 'no-store' });
  res.end(buffer);
}

async function servePublic(res, pathname) {
  const map = { '/': 'index.html', '/app.js': 'app.js', '/styles.css': 'styles.css', '/bridge.js': 'bridge.js' };
  const name = map[pathname];
  if (!name) return false;
  const path = join(PUBLIC_ROOT, name);
  const buffer = await readFile(path);
  res.writeHead(200, { 'Content-Type': MIME[extname(name)] || 'application/octet-stream', 'Content-Length': buffer.length, 'Cache-Control': 'no-store' });
  res.end(buffer);
  return true;
}

export async function startServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || `127.0.0.1:${PORT}`}`);
    try {
      if (url.pathname.startsWith('/api/')) {
        const handled = await handleApi(req, res, url);
        if (handled === false) json(res, 404, { error: '接口不存在' });
        return;
      }
      if (url.pathname.startsWith('/project/')) return await serveProject(req, res, url);
      if (await servePublic(res, url.pathname)) return;
      json(res, 404, { error: '页面不存在' });
    } catch (error) {
      console.error(error);
      json(res, 500, { error: error.message || '处理失败' });
    }
  });

  await mkdir(DATA_ROOT, { recursive: true });
  server.listen(PORT, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${PORT}`;
    console.log(`HTML 原型审阅编辑器已启动：${url}`);
    if (process.env.HPE_NO_OPEN !== '1') execFile('/usr/bin/open', [url], () => {});
  });
  process.on('SIGINT', () => server.close(() => process.exit(0)));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
  return server;
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) await startServer();
