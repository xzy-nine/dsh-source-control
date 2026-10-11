/**
 * 排序参数测试：确认三档排序真正到达 git 并改变顺序。
 *
 * 背景：初版把 commitOrdering 硬编码为 'date'，导致面板与 VS Code 的
 * topo 视图顺序不一致、泳道分布完全不同。此测试钉住「参数确实生效」。
 *
 * 现实中的线性仓库两种排序结果相同，因此这里自建一个带分叉与合并的临时仓库，
 * 只有这种历史才能区分 date 与 topo。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 用与宿主相同的形式构造 git 参数。 */
function logWithOrdering(repo, ordering, limit = 20) {
	const args = [
		'-c', 'log.showSignature=false', 'log', `--max-count=${limit}`,
		'--format=%s', `--${ordering}-order`, '--branches', '--tags', '--remotes', 'HEAD', '--',
	];
	return execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
		.split('\n').filter((line) => line !== '');
}

/**
 * 建一个带分叉合并的仓库：主干与分支交错提交，且分支提交时间晚于主干后续提交，
 * 使 date 序与 topo 序产生可见差异。
 */
function makeBranchedRepo() {
	const repo = mkdtempSync(join(tmpdir(), 'gg-order-'));
	const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
	const commitAt = (message, isoDate) => {
		writeFileSync(join(repo, `${message}.txt`), message);
		git('add', '-A');
		execFileSync('git', ['commit', '-q', '-m', message], {
			cwd: repo,
			env: { ...process.env, GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate },
		});
	};
	git('init', '-q', '-b', 'main');
	git('config', 'user.email', 'order@example.com');
	git('config', 'user.name', 'Order');
	commitAt('base', '2026-01-01T00:00:00Z');
	// 分支：一个较早的提交，但拓扑上必须与主干交错可见。
	git('checkout', '-q', '-b', 'side');
	commitAt('side-1', '2026-01-02T00:00:00Z');
	commitAt('side-2', '2026-01-06T00:00:00Z');
	git('checkout', '-q', 'main');
	commitAt('main-2', '2026-01-03T00:00:00Z');
	commitAt('main-3', '2026-01-04T00:00:00Z');
	// 合并：日期晚于双方，形成合并点。
	execFileSync('git', ['merge', '-q', '--no-ff', '-m', 'merge-side', 'side'], {
		cwd: repo,
		env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-07T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-07T00:00:00Z' },
	});
	return repo;
}

test('三档排序参数都被 git 接受', () => {
	const repo = makeBranchedRepo();
	try {
		for (const ordering of ['date', 'author-date', 'topo']) {
			const subjects = logWithOrdering(repo, ordering);
			assert.ok(subjects.length >= 5, `${ordering} 应返回全部提交`);
		}
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('排序参数确实改变提交顺序', () => {
	const repo = makeBranchedRepo();
	try {
		const date = logWithOrdering(repo, 'date');
		const topo = logWithOrdering(repo, 'topo');
		assert.deepEqual([...date].sort(), [...topo].sort(), '两种排序应看到同一批提交');
		assert.notDeepEqual(date, topo, 'date 与 topo 的顺序应当不同，否则参数未生效');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
