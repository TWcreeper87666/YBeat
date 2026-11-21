// 跑 tests/*.test.ts：用 esbuild 打包成 node 可以直接跑的檔案，再一個一個執行
// npm test              → 全部
// npm test -- snap tr   → 檔名含 snap 或 tr 的
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const filters = process.argv.slice(2);
const files = readdirSync('tests')
  .filter((f) => f.endsWith('.test.ts'))
  .filter((f) => !filters.length || filters.some((k) => f.includes(k)))
  .sort();
if (!files.length) {
  console.error('沒有符合的測試');
  process.exit(1);
}

const outdir = 'node_modules/.cache/tests';
await build({
  entryPoints: files.map((f) => join('tests', f)),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outdir,
  outExtension: { '.js': '.cjs' },
  logLevel: 'error',
  define: { 'import.meta.env': JSON.stringify({ BASE_URL: '/' }) },
});

const failed = [];
for (const f of files) {
  const r = spawnSync(process.execPath, [join(outdir, f.replace(/\.ts$/, '.cjs'))], { stdio: 'inherit' });
  if (r.status !== 0) failed.push(f);
}
console.log(failed.length ? `\nFAIL ${failed.length} / ${files.length}：${failed.join(', ')}` : `\n全部通過（${files.length} 個檔案）`);
process.exit(failed.length ? 1 : 0);
