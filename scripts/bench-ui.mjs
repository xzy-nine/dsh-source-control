/**
 * 「数据 → 界面」耗时度量：变更树、提交合并身份复用、行文本与标记、翻译判定。
 *
 * 用法：node scripts/bench-ui.mjs [轮数]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = async (...parts) => import(pathToFileURL(join(root, 'src', 'client', ...parts)).href);
const { changeRowsOf } = await load('panel', 'change-tree.ts');
const { mergeCommits } = await load('panel', 'commit-diff.ts');
const { labelsOf, titleOf } = await load('graph', 'row-model.ts');
const { needsTranslationMemo } = await load('panel', 'language.ts');
const { filterCommitsByRefs } = await load('panel', 'refs.ts');

const rounds = Math.max(1, Number.parseInt(process.argv[2] ?? '20', 10));

/** 造一段带分支、标签与贮藏标记的提交列表。 */
function makeCommits(count) {
	const commits = [];
	for (let index = 0; index < count; index += 1) {
		const parents = index + 1 < count ? [String(index + 1)] : [];
		if (index % 7 === 3 && index + 3 < count) parents.push(String(index + 3));
		commits.push({
			hash: String(index), parents,
			heads: index % 50 === 0 ? ['main', 'feature'] : [],
			tags: index % 97 === 0 ? [{ name: 'v' + index }] : [],
			remotes: index % 61 === 0 ? [{ name: 'origin/main', remote: 'origin' }] : [],
			stash: index % 211 === 0 ? { selector: 'refs/stash' } : null,
			message: index === 0 ? 'Uncommitted Changes (3)' : 'feat: 改动 ' + index,
			author: 'a', email: '1+someone@users.noreply.github.com', date: 1700000000 + index,
		});
	}
	return commits;
}

/** 造一段工作区条目。 */
function makeEntries(count) {
	const entries = [];
	for (let index = 0; index < count; index += 1) {
		const depth = index % 3;
		const prefix = depth === 0 ? 'src/' : depth === 1 ? 'src/client/' : 'src/client/panel/';
		entries.push({
			path: prefix + 'file' + index + '.ts', origPath: null,
			index: index % 4 === 0 ? 'M' : ' ', worktree: index % 4 === 0 ? ' ' : 'M',
		});
	}
	return entries;
}

/** 取一次调用的耗时（毫秒）。 */
function timeOf(run) {
	const started = process.hrtime.bigint();
	const value = run();
	return { ms: Number(process.hrtime.bigint() - started) / 1e6, value };
}

/**
 * 连跑若干轮，打印 min / mean / max。
 *
 * @param label - 行首标签。
 * @param run - 被测调用；每轮调用一次。
 * @returns 无。
 */
function report(label, run) {
	run();
	const samples = [];
	for (let round = 0; round < rounds; round += 1) samples.push(timeOf(run).ms);
	const sorted = [...samples].sort((a, b) => a - b);
	const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
	console.log(
		label.padEnd(34)
		+ 'min ' + sorted[0].toFixed(3)
		+ '  mean ' + mean.toFixed(3)
		+ '  max ' + sorted[sorted.length - 1].toFixed(3) + 'ms',
	);
}

console.log('== 变更树（changeRowsOf，冷态） ==');
for (const count of [200, 1000, 4000]) {
	const entries = makeEntries(count);
	const collapsed = new Set();
	report(count + ' 条条目', () => changeRowsOf(entries, collapsed));
}

console.log('\n== 提交合并（mergeCommits，4000 条，1% 变化） ==');
{
	const previous = makeCommits(4000);
	// 每 100 条换一个对象并改一个影响图形的字段。
	const next = previous.map((commit, index) => (index % 100 === 0
		? { ...commit, heads: [...(commit.heads ?? []), 'dev'] }
		: commit));
	let reuse = 0;
	report('4000 条（1% 变化）', () => {
		const merged = mergeCommits(previous, next);
		reuse = merged.filter((commit, index) => commit === previous[index]).length;
		return merged;
	});
	console.log('复用率：' + (reuse / previous.length * 100).toFixed(1) + '%（' + reuse + '/' + previous.length + '）');
}

console.log('\n== 提交行文本与标记（40 行窗口） ==');
{
	const window = makeCommits(40);
	const head = 'main';
	// 命中态：同一批提交对象反复取。
	report('labelsOf + titleOf（命中）', () => window.map((commit) => [labelsOf(commit, head), titleOf(commit)]));
	// 冷态：每轮换一批对象，缓存必然未命中。
	report('labelsOf + titleOf（冷态）', () => {
		const fresh = window.map((commit) => ({ ...commit, hash: commit.hash + '#cold' }));
		return fresh.map((commit) => [labelsOf(commit, head), titleOf(commit)]);
	});
}

console.log('\n== 翻译判定（needsTranslationMemo，40 行） ==');
{
	const lines = makeCommits(40).map((commit) => commit.message);
	report('命中态', () => lines.map((line) => needsTranslationMemo(line, 'zh-CN')));
	report('冷态', () => {
		const suffix = String(process.hrtime.bigint());
		return lines.map((line) => needsTranslationMemo(line + suffix, 'zh-CN'));
	});
}

console.log('\n== 引用筛选（filterCommitsByRefs，4000 条） ==');
{
	const commits = makeCommits(4000);
	const selected = new Set(['main', 'feature', 'v97']);
	report('4000 条', () => filterCommitsByRefs(commits, selected));
}
