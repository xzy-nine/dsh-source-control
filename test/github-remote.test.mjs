/**
 * GitHub 远端判定测试。
 *
 * 覆盖 HTTPS / scp / `ssh://` 三种地址形态的识别、提交页地址的选取与远程分支名的拆分；
 * 判定结果决定提交菜单里是否出现 GitHub 网页入口。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	githubCommitUrl, githubRemoteNames, hasGitHubRemote, remoteNameOfBranch,
} from '../src/client/panel/github.ts';

/** 一个远端条目。 */
const remote = (name, url) => ({ name, url });

test('识别三种 GitHub 地址形态', () => {
	assert.equal(hasGitHubRemote([remote('origin', 'https://github.com/owner/repo.git')]), true);
	assert.equal(hasGitHubRemote([remote('origin', 'git@github.com:owner/repo.git')]), true);
	assert.equal(hasGitHubRemote([remote('origin', 'ssh://git@github.com/owner/repo.git')]), true);
	assert.equal(hasGitHubRemote([remote('origin', 'https://github.com/owner/repo')]), true);
});

test('非 GitHub 远端不算 GitHub 仓库', () => {
	assert.equal(hasGitHubRemote([remote('origin', 'https://gitlab.com/owner/repo.git')]), false);
	assert.equal(hasGitHubRemote([remote('origin', 'C:\\repos\\demo')]), false);
	assert.equal(hasGitHubRemote([remote('origin', undefined)]), false);
	assert.equal(hasGitHubRemote([]), false);
});

test('取指向 GitHub 的远程名', () => {
	const remotes = [
		remote('origin', 'git@github.com:owner/repo.git'),
		remote('mirror', 'https://gitlab.com/owner/repo.git'),
		remote('upstream', 'ssh://git@github.com/other/repo.git'),
	];
	assert.deepEqual([...githubRemoteNames(remotes)].sort(), ['origin', 'upstream']);
});

test('提交页地址优先 origin，并去掉 .git 后缀', () => {
	const remotes = [
		remote('upstream', 'https://github.com/other/repo.git'),
		remote('origin', 'git@github.com:owner/repo.git'),
	];
	assert.equal(githubCommitUrl(remotes, 'abc123'), 'https://github.com/owner/repo/commit/abc123');
	assert.equal(githubCommitUrl([remote('origin', 'https://gitlab.com/owner/repo.git')], 'abc123'), null);
});

test('远程分支短名拆出远程名', () => {
	assert.equal(remoteNameOfBranch('origin/main'), 'origin');
	assert.equal(remoteNameOfBranch('origin/feature/nested'), 'origin');
	assert.equal(remoteNameOfBranch('main'), '');
	assert.equal(remoteNameOfBranch('/main'), '');
});
