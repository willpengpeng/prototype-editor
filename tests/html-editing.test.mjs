import test from 'node:test';
import assert from 'node:assert/strict';
import { indexHtml, markHtml, applyChangesToHtml, collectPageFiles } from '../server.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sample = '<!doctype html><html><body><button class="primary">保存</button><input placeholder="请输入"><div><span>说明</span></div></body></html>';

test('为源代码元素生成稳定节点标记', () => {
  const output = markHtml(sample);
  assert.match(output, /button class="primary" data-hpe-node="n\d+"/);
  assert.match(output, /span data-hpe-node="n\d+">说明<\/span>/);
});

test('按节点编号修改叶子文字且保留标签结构', () => {
  const { nodes } = indexHtml(sample);
  const button = nodes.find((item) => item.node.tagName === 'button');
  const output = applyChangesToHtml(sample, [{ nodeId:button.nodeId, kind:'text', oldValue:'保存', newValue:'提交保存' }]);
  assert.match(output, /<button class="primary">提交保存<\/button>/);
});

test('修改输入框提示文字', () => {
  const { nodes } = indexHtml(sample);
  const input = nodes.find((item) => item.node.tagName === 'input');
  const output = applyChangesToHtml(sample, [{ nodeId:input.nodeId, kind:'attr', attribute:'placeholder', oldValue:'请输入', newValue:'请输入客户编号' }]);
  assert.match(output, /placeholder="请输入客户编号"/);
});

test('拒绝直接替换包含子元素的容器', () => {
  const { nodes } = indexHtml(sample);
  const div = nodes.find((item) => item.node.tagName === 'div');
  assert.throws(() => applyChangesToHtml(sample, [{ nodeId:div.nodeId, kind:'text', newValue:'错误替换' }]), /嵌套结构/);
});

test('当前页面导出会收集 HTML、iframe 和样式依赖', async () => {
  const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), 'fixture');
  const files = await collectPageFiles(fixtureRoot, 'index.html');
  assert.deepEqual([...files].sort(), ['child.html', 'index.html', 'style.css']);
});
