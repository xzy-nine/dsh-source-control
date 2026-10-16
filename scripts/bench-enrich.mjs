/**
 * 后台补齐代价度量：统计 enrichRepositories 的耗时与 git spawn 次数。
 *
 * 用法：node scripts/bench-enrich.mjs <工作区根>
 * 依赖宿主产物 lib/src/source-control/repo-discovery.js。
 */
import cp from 'node:child_process';
import { spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const modulePath = join(root, 'lib', 'src', 'source-control', 'repo-discovery.js');
if (!existsSync(modulePath)) { console.error('先 pnpm build:host'); process.exit(1); }
const target = process.argv[2] ?? process.cwd();
const discovery = await import(pathToFileURL(modulePath).href);

discovery.clearDiscoveryCache();
const full = await discovery.discoverRepositories(target, {});
const paths = full.nodes.filter((node) => node.kind === 'repo').map((node) => node.path);

let count = 0;
const real = spawn;
cp.spawn = (...args) => { count += 1; return real(...args); };
syncBuiltinESMExports();

// 等过宿主只读结果缓存的 200ms TTL，否则「工作树枚举」会命中前一步完整扫描留下的缓存。
await new Promise((resolve) => setTimeout(resolve, 400));

const started = process.hrtime.bigint();
const enriched = await discovery.enrichRepositories(paths);
const ms = Number(process.hrtime.bigint() - started) / 1e6;
const children = enriched.reduce((sum, node) => sum + (node.children ?? []).length, 0);
console.log('enrichRepositories：' + ms.toFixed(1) + 'ms  仓库=' + enriched.length + '  children 合计=' + children + '  git spawn=' + count);
