/**
 * 提交信息门禁：校验待推送的提交标题符合 Conventional Commits。
 *
 * 标题格式为 `type[(scope)][!]: <description>`。类型取自 feat/fix/docs/style/refactor/
 * perf/test/build/ci/chore/revert。破坏性标记 `!` 位于类型或作用域之后、冒号之前。
 * 冒号后有一个空格。合并提交、撤销提交、fixup 与 squash 提交不参与校验。
 *
 * 由 pre-push 调用，标准输入为 git 给出的
 * `<local ref> <local sha> <remote ref> <remote sha>` 行。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** 允许的提交类型。 */
const TYPES = 'feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert';

/** 合规标题：类型、(作用域)、破坏性标记、冒号、空格、描述。 */
const TITLE = new RegExp(`^(${TYPES})(\\(([^)]*)\\))?!?: .+$`);

/** 破坏性标记位于冒号之后的标题。 */
const MISPLACED_BANG = new RegExp(`^(${TYPES})(\\(([^)]*)\\))?:\\s*!\\s*(.*)$`);

/** 不参与校验的标题前缀。 */
const SKIPPABLE = /^(Merge |Revert |revert:|fixup! |squash! )/;

/**
 * 执行一条 git 命令并返回标准输出。
 *
 * @param args - git 参数。
 * @returns 标准输出。
 */
function git(...args) {
	return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

/**
 * 由推送行得出待校验的提交范围。
 *
 * 远端没有该分支时，范围取尚未推送到任何远端的提交。
 *
 * @param stdin - pre-push 的标准输入。
 * @returns 各范围的 rev-list 参数。
 */
function rangesOf(stdin) {
	const ranges = [];
	for (const line of stdin.split('\n')) {
		const parts = line.trim().split(/\s+/);
		if (parts.length < 4) continue;
		const [, localSha, , remoteSha] = parts;
		if (/^0+$/.test(localSha)) continue;
		ranges.push(/^0+$/.test(remoteSha) ? [localSha, '--not', '--remotes'] : [`${remoteSha}..${localSha}`]);
	}
	return ranges;
}

/**
 * 列出一个范围内的提交。
 *
 * @param range - rev-list 参数。
 * @returns `[哈希, 标题]` 列表。
 */
function commitsIn(range) {
	try {
		return git('rev-list', ...range, '--format=%H%x09%s')
			.split('\n')
			.filter((line) => line.includes('\t'))
			.map((line) => line.split('\t'));
	} catch {
		return [];
	}
}

/**
 * 给出修正后的标题。
 *
 * @param title - 原标题。
 * @returns 把破坏性标记移到冒号之前的写法；不适用时为空串。
 */
function suggest(title) {
	const misplaced = MISPLACED_BANG.exec(title);
	if (misplaced === null) return '';
	const description = misplaced[4].trim();
	return `${misplaced[1]}${misplaced[2] ?? ''}!${description === '' ? ':' : `: ${description}`}`;
}

/**
 * 校验待推送的提交标题。
 *
 * @returns 无。
 */
function main() {
	const failures = [];
	for (const range of rangesOf(readFileSync(0, 'utf8'))) {
		for (const [hash, title] of commitsIn(range)) {
			if (SKIPPABLE.test(title) || TITLE.test(title)) continue;
			failures.push({ hash, title });
		}
	}
	if (failures.length === 0) return;
	console.error('pre-push: 以下提交的标题不符合 Conventional Commits，拒绝推送。');
	for (const { hash, title } of failures) {
		console.error(`  ${hash.slice(0, 8)}  ${title}`);
		const fixed = suggest(title);
		if (fixed !== '') console.error(`            建议：${fixed}`);
	}
	console.error('');
	console.error('  要求：type[(scope)][!]: <description>');
	console.error('  示例：feat: 支持按块暂存 / fix(panel): 修复空白页 / feat!: 移除单栏差异视图');
	console.error('  跳过：git push --no-verify');
	process.exit(1);
}

main();
