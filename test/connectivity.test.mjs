/**
 * 泳道连通性测试：用本仓库的真实提交历史校验布局不产生断线。
 *
 * 与 lanes.test.mjs 的合成用例互补——这里跑的是真实分叉合并历史，
 * 覆盖「泳道在等待下游提交期间必须每行都有线」这一初版遗漏的不变量。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { layoutCommits } from '../src/client/graph/lanes.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 读取仓库历史；没有 git 或没有提交时返回 null。 */
function history(repo, limit) {
	try {
		const format = ['%H', '%P', '%s'].join('%x1f');
		const raw = execFileSync('git', [
			'-c', 'log.showSignature=false', 'log', `--max-count=${limit}`,
			`--format=${format}`, '--date-order', '--all',
		], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
		return raw.split('\n').filter((line) => line !== '').map((line) => {
			const [hash, parents] = line.split('\x1f');
			return { hash, parents: parents === '' ? [] : parents.split(' ') };
		});
	} catch {
		// 没有 git 可执行文件或该目录不是仓库：跳过真实历史用例。
		return null;
	}
}

/** 收集布局中的断线问题。 */
function connectivityProblems(commits, rows) {
	const problems = [];
	for (let row = 0; row + 1 < commits.length; row++) {
		// 本行画到行底的线，其泳道在下一行必须被接续。
		for (const segment of rows[row].segments.filter((item) => item.toBottom)) {
			const lane = segment.toLane;
			const next = rows[row + 1];
			const connected = next.lane === lane || next.segments.some((item) => item.fromTop && item.lane === lane);
			if (!connected) problems.push(`第 ${row} 行泳道 ${lane} 向下却在第 ${row + 1} 行断开`);
		}
		// 下一行从行顶进入的线，其泳道在本行必须有来源。
		for (const segment of rows[row + 1].segments.filter((item) => item.fromTop)) {
			const lane = segment.lane;
			const above = rows[row];
			const fed = above.lane === lane
				|| above.segments.some((item) => item.toBottom && (item.toLane === lane || item.lane === lane));
			if (!fed) problems.push(`第 ${row + 1} 行泳道 ${lane} 有入线但第 ${row} 行没有来源`);
		}
	}
	return problems;
}

const commits = history(root, 400);

test('真实历史的泳道图没有断线', { skip: commits === null && '当前目录不是 git 仓库' }, () => {
	assert.ok(commits !== null && commits.length > 0, '应读到至少一条提交');
	const layout = layoutCommits(commits);
	assert.deepEqual(connectivityProblems(commits, layout.rows), []);
});

test('泳道数不超过提交数且被实际使用', { skip: commits === null && '当前目录不是 git 仓库' }, () => {
	const layout = layoutCommits(commits);
	assert.ok(layout.laneCount >= 1);
	assert.ok(layout.laneCount <= commits.length);
	// 每条泳道都应有提交落点，否则是分配后未释放的泄漏。
	const used = new Set(layout.rows.map((row) => row.lane));
	assert.ok(used.size >= 1);
	for (const lane of used) assert.ok(lane < layout.laneCount, `泳道 ${lane} 超出 laneCount`);
});
