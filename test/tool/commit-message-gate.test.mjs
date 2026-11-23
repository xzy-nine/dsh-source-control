/**
 * 提交信息门禁：`.githooks/commit-msg` 与 `scripts/verify-commit-messages.mjs`。
 *
 * 两处共用同一份格式规则：提交时校验单条信息，推送时校验待推送的全部提交。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* 本文件的用例串行执行：每个用例起 git 或 shell 子进程与临时目录 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const hook = join(root, '.githooks', 'commit-msg');
const gate = join(root, 'scripts', 'verify-commit-messages.mjs');

/**
 * 执行 shell 钩子的解释器。Windows 用 git for Windows 自带的 bash。
 *
 * @returns 解释器路径；找不到时为 null。
 */
function findShell() {
	if (process.platform !== 'win32') return 'sh';
	for (const candidate of ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe']) {
		try {
			execFileSync(candidate, ['--version'], { stdio: 'ignore' });
			return candidate;
		} catch {
			// 尝试下一个候选路径。
		}
	}
	return null;
}

const shell = findShell();
const skip = shell === null ? '未找到可用的 bash' : false;

/**
 * 用一条标题跑提交时门禁。
 *
 * @param title - 提交标题。
 * @returns 退出码与输出。
 */
function runHook(title) {
	const dir = mkdtempSync(join(tmpdir(), 'gg-msg-hook-'));
	const file = join(dir, 'MSG');
	try {
		writeFileSync(file, `${title}\n`);
		try {
			const output = execFileSync(shell, [hook, file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
			return { code: 0, output };
		} catch (error) {
			return { code: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * 建一个临时仓库，先放一条合规的基准提交。
 *
 * @returns 仓库路径、提交函数与基准提交哈希。
 */
function makeRepo() {
	const repo = mkdtempSync(join(tmpdir(), 'gg-msgs-'));
	const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
	git('init', '-q', '-b', 'main');
	git('config', 'user.email', 'm@example.com');
	git('config', 'user.name', 'M');
	git('config', 'commit.gpgsign', 'false');
	const commit = (title) => {
		writeFileSync(join(repo, 'f.txt'), `${title}\n`);
		git('add', '-A');
		const messageFile = join(repo, '.msg');
		writeFileSync(messageFile, `${title}\n`);
		git('commit', '-q', '-F', messageFile);
		rmSync(messageFile, { force: true });
		return git('rev-parse', 'HEAD').trim();
	};
	const base = commit('chore: 基准');
	return { repo, commit, base };
}

/**
 * 按 pre-push 的方式喂入推送范围并跑推送时门禁。
 *
 * @param repo - 仓库路径。
 * @param from - 远端已有的提交。
 * @param to - 本地待推送的提交。
 * @returns 退出码与输出。
 */
function runGate(repo, from, to) {
	const stdin = `refs/heads/main ${to} refs/heads/main ${from}\n`;
	try {
		const output = execFileSync('node', [gate], { cwd: repo, input: stdin, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
		return { code: 0, output };
	} catch (error) {
		return { code: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
	}
}

test('提交时：破坏性标记写在冒号后被拒绝，并给出修正写法', { skip }, () => {
	const result = runHook('feat:! 支持合并冲突的查看与简单修改');
	assert.equal(result.code, 1);
	assert.match(result.output, /feat!: 支持合并冲突的查看与简单修改/);
});

test('提交时：合规标题与 git 生成的标题放行', { skip }, () => {
	for (const title of ['feat: 支持按块暂存', 'feat(panel)!: 移除单栏差异视图', 'fix: 修复空白页', 'chore(release): 1.3.0 [skip ci]']) {
		assert.equal(runHook(title).code, 0, `应放行：${title}`);
	}
	for (const title of ["Merge branch 'dev'", 'Revert "feat: x"', 'fixup! feat: x']) {
		assert.equal(runHook(title).code, 0, `应跳过：${title}`);
	}
});

test('提交时：自由格式与冒号前空格错位被拒绝', { skip }, () => {
	assert.equal(runHook('随便写一句').code, 1);
	assert.equal(runHook('feat(scope) : 空格错位').code, 1);
});

test('推送时：范围内不合规的提交被拒绝', () => {
	const { repo, commit, base } = makeRepo();
	try {
		const bad = commit('feat:! 支持合并冲突的查看与简单修改');
		const result = runGate(repo, base, bad);
		assert.equal(result.code, 1);
		assert.match(result.output, /feat!: 支持合并冲突的查看与简单修改/);
		assert.match(result.output, /--no-verify/);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('推送时：合规标题放行，范围外的旧提交不参与校验', () => {
	const { repo, commit, base } = makeRepo();
	try {
		const bad = commit('feat:! 旧的坏提交');
		const good = commit('fix: 新的好提交');
		// 坏提交已在远端，本次范围只含最后一条。
		assert.equal(runGate(repo, bad, good).code, 0);
		assert.equal(runGate(repo, base, good).code, 1, '范围含坏提交时应拒绝');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
