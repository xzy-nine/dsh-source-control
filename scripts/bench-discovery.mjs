/**
 * 仓库发现耗时度量：直接调用宿主发现层，输出完整扫描与已知路径快路径的耗时。
 *
 * 用法：node scripts/bench-discovery.mjs <工作区根> [轮数]
 * 依赖宿主产物 lib/src/source-control/repo-discovery.js。
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const modulePath = join(root, 'lib', 'src', 'source-control', 'repo-discovery.js');
if (!existsSync(modulePath)) {
	console.error('未找到宿主产物：' + modulePath);
	process.exit(1);
}
const target = process.argv[2] ?? process.cwd();
const rounds = Math.max(1, Number.parseInt(process.argv[3] ?? '3', 10));
const { discoverRepositories, clearDiscoveryCache } = await import(pathToFileURL(modulePath).href);

/** 度量一次调用。 */
async function time(fn) {
	const started = process.hrtime.bigint();
	const value = await fn();
	return { ms: Number(process.hrtime.bigint() - started) / 1e6, value };
}

clearDiscoveryCache();
const full = await time(() => discoverRepositories(target, {}));
console.log('完整扫描（冷）    ' + full.ms.toFixed(1) + 'ms  仓库 ' + full.value.nodes.length + ' 截断 ' + full.value.truncated);
const known = full.value.nodes.filter((node) => node.kind === 'repo').map((node) => node.path);
clearDiscoveryCache();
const quick = await time(() => discoverRepositories(target, { knownRepos: known }));
console.log('已知路径快路径（冷）' + quick.ms.toFixed(1) + 'ms  仓库 ' + quick.value.nodes.length);
clearDiscoveryCache();
for (let round = 0; round < rounds; round += 1) {
	clearDiscoveryCache();
	const sample = await time(() => discoverRepositories(target, {}));
	console.log('第 ' + (round + 1) + ' 轮完整扫描   ' + sample.ms.toFixed(1) + 'ms');
}
