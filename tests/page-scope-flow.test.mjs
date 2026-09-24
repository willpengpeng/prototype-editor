import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = join(appRoot, 'tests', 'fixture');
const execFile = promisify(execFileCallback);

async function waitForServer(baseUrl) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/status`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('测试服务器启动超时');
}

async function post(baseUrl, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `请求失败：${path}`);
  return result;
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

test('保存只更新当前页批注，导出可选当前页面或整个文件夹', async (context) => {
  const sandbox = await mkdtemp(join(tmpdir(), 'hpe-page-scope-'));
  const project = join(sandbox, 'project');
  await cp(fixtureRoot, project, { recursive: true });
  await writeFile(join(project, 'unrelated.html'), '<!doctype html><title>无关页面</title>', 'utf8');

  const port = 46000 + (process.pid % 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['server.mjs'], {
    cwd: appRoot,
    env: { ...process.env, PORT:String(port), HPE_NO_OPEN:'1', HPE_PROJECT:project, HPE_ENTRY:'index.html' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  context.after(async () => {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
    await rm(sandbox, { recursive:true, force:true });
  });
  await waitForServer(baseUrl);

  const indexAnnotation = { id:'index-old', page:'index.html', file:'index.html', target:{ nodeId:'n1', tag:'h1', label:'首页' }, text:'旧首页批注' };
  const childAnnotation = { id:'child-kept', page:'child.html', file:'child.html', target:{ nodeId:'n1', tag:'p', label:'子页' }, text:'子页批注' };
  await post(baseUrl, '/api/draft', { entry:'index.html', changes:[], annotations:[indexAnnotation, childAnnotation] });

  const updatedIndexAnnotation = { ...indexAnnotation, id:'index-new', text:'新首页批注' };
  await post(baseUrl, '/api/save', { mode:'overwrite', page:'index.html', changes:[], annotations:[updatedIndexAnnotation] });
  const status = await (await fetch(`${baseUrl}/api/status`)).json();
  assert.deepEqual(status.draft.annotations.map((item) => item.id).sort(), ['child-kept', 'index-new']);

  const pageRunnable = await post(baseUrl, '/api/export', {
    kind:'runnable', scope:'page', entry:'index.html', changes:[], annotations:[],
    destinationParent:sandbox, name:'page-runnable'
  });
  assert.equal(pageRunnable.path, project);
  assert.equal(pageRunnable.entry, 'page-runnable.html');
  assert.equal(await exists(pageRunnable.filePath), true);
  assert.equal(pageRunnable.zipPath, null);
  const standardPayload = await readFile(pageRunnable.filePath, 'utf8');
  assert.match(standardPayload, /srcdoc=/);
  assert.match(standardPayload, /data-inline-source="style\.css"/);
  assert.doesNotMatch(standardPayload, /data-hpe-review/);

  const pageAnnotated = await post(baseUrl, '/api/export', {
    kind:'annotated', scope:'page', entry:'index.html', changes:[], annotations:[updatedIndexAnnotation],
    destinationParent:sandbox, name:'page-annotated'
  });
  assert.equal(pageAnnotated.path, project);
  assert.equal(pageAnnotated.entry, 'page-annotated.html');
  assert.equal(await exists(pageAnnotated.filePath), true);
  const annotationPayload = await readFile(pageAnnotated.filePath, 'utf8');
  assert.match(annotationPayload, /index-new/);
  assert.doesNotMatch(annotationPayload, /child-kept/);
  assert.match(annotationPayload, /srcdoc=/);
  assert.match(annotationPayload, /data-inline-source="style\.css"/);
  assert.match(annotationPayload, /隐藏编号/);
  assert.match(annotationPayload, /隐藏批注栏/);
  assert.match(annotationPayload, /hpe-review-target-highlight/);
  assert.equal(pageAnnotated.zipPath, null);

  const folderRunnable = await post(baseUrl, '/api/export', {
    kind:'runnable', scope:'folder', entry:'index.html', changes:[], annotations:[],
    destinationParent:sandbox, name:'folder-runnable'
  });
  assert.equal(await exists(join(folderRunnable.path, 'unrelated.html')), true);
  assert.equal((await readdir(folderRunnable.path)).includes('index.html'), true);
  assert.equal(await exists(folderRunnable.zipPath), true);
  await execFile('/usr/bin/unzip', ['-t', folderRunnable.zipPath]);

  const folderAnnotated = await post(baseUrl, '/api/export', {
    kind:'annotated', scope:'folder', entry:'index.html', changes:[], annotations:[updatedIndexAnnotation],
    destinationParent:sandbox, name:'folder-annotated'
  });
  assert.equal(await exists(join(folderAnnotated.path, 'unrelated.html')), true);
  const folderPayload = await readFile(folderAnnotated.filePath, 'utf8');
  assert.match(folderPayload, /index-new/);
  assert.doesNotMatch(folderPayload, /child-kept/);
  assert.equal(await exists(join(folderAnnotated.path, 'review-assets')), false);
  await execFile('/usr/bin/unzip', ['-t', folderAnnotated.zipPath]);
});
