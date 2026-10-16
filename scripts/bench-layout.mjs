/**
 * 泳道布局耗时度量：不同提交数下 layoutCommits 的单次耗时。
 *
 * 用法：node scripts/bench-layout.mjs [轮数]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lanesPath = join(root, 'src', 'client', 'graph', 'lanes.ts');
const { layoutCommits } = await import(pathToFileURL(lanesPath).href);

const rounds = Math.max(1, Number.parseInt(process.argv[2] ?? '20', 10));

/** 造一段带合并的提交列表。 */
function makeCommits(count) {
	const commits = [];
	for (let index = 0; index < count; index += 1) {
		const parents = index + 1 < count ? [String(index + 1)] : [];
		// 每 7 条插一个合并提交，制造分叉与合流。
		if (index % 7 === 3 && index + 3 < count) parents.push(String(index + 3));
		commits.push({
			hash: String(index), parents, heads: index === 0 ? ['main'] : [], tags: [], remotes: [], stash: null,
			message: 'commit ' + index, author: 'a', email: 'a@b.c', date: 1700000000 + index,
		});
	}
	return commits;
}

const options = { head: '0', upstream: null, baseTip: null, localTip: null, remoteTip: null };
for (const count of [200, 500, 1000, 2000]) {
	const commits = makeCommits(count);
	layoutCommits(commits, options);
	const samples = [];
	for (let round = 0; round < rounds; round += 1) {
		const started = process.hrtime.bigint();
		layoutCommits(commits, options);
		samples.push(Number(process.hrtime.bigint() - started) / 1e6);
	}
	const sorted = [...samples].sort((a, b) => a - b);
	const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
	console.log(String(count).padStart(5) + ' 条提交：min ' + sorted[0].toFixed(2) + '  mean ' + mean.toFixed(2) + '  max ' + sorted[sorted.length - 1].toFixed(2) + 'ms');
}
