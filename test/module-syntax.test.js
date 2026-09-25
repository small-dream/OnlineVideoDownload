// 每个随扩展发布的脚本都必须能作为 ES module 解析。
// 背景：MV3 service worker 是 module，只要依赖图里有任意一个文件存在
// 顶层语法错误（例如重复声明 const），整个 SW 就无法启动——表现为
// 「所有站点都探测不到视频」，而单测仍然全绿（没有用例加载过那个文件）。

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const IGNORED_DIRS = new Set(['.git', '.github', 'node_modules', 'test']);

function collectScripts(dir, collected = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) {
        continue;
      }
      collectScripts(fullPath, collected);
      continue;
    }
    if (entry.name.endsWith('.js')) {
      collected.push(fullPath);
    }
  }
  return collected;
}

// 在子进程里用 vm.SourceTextModule 逐个编译（只解析、不执行、不解析 import）。
// 单进程完成，避免为每个文件启动一次 node --check。
const PARSE_RUNNER = `
import fs from 'node:fs';
import vm from 'node:vm';

const files = JSON.parse(process.env.OVD_PARSE_FILES || '[]');
const failures = [];

for (const file of files) {
  try {
    new vm.SourceTextModule(fs.readFileSync(file, 'utf8'), { identifier: file });
  } catch (err) {
    failures.push(file + ' :: ' + err.message);
  }
}

if (failures.length) {
  process.stderr.write(failures.join('\\n'));
  process.exit(1);
}

process.stdout.write('parsed ' + files.length + ' files');
`;

test('扩展脚本都能作为 ES module 解析（避免 SW 因语法错误整体启动失败）', () => {
  const files = collectScripts(ROOT);
  assert.ok(files.length >= 50, `预期收集到扩展脚本，实际 ${files.length} 个`);

  const output = execFileSync(
    process.execPath,
    ['--experimental-vm-modules', '--input-type=module', '-e', PARSE_RUNNER],
    {
      encoding: 'utf8',
      env: { ...process.env, OVD_PARSE_FILES: JSON.stringify(files) },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  assert.match(output, /^parsed \d+ files$/);
});
