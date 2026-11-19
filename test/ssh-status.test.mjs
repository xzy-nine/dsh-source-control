/**
 * SSH 状态检测的纯逻辑测试。
 *
 * 覆盖版本行提取、私钥筛选、退出码判定与未就绪说明；真实探测需要本机安装 ssh 并联网，不在此测试内。
 *
 * `ssh-status.ts` 有内部 `.js` 相对导入，无法由 `src/` 直连 `.ts`，因此从 `lib/` 产物导入；
 * `pretest` 会先重建产物。
 */
import assert from 'node:assert/strict';
import { importHostModule } from './lib-import.mjs';
import { parallel } from './harness.mjs';

const { isAuthenticated, parseSshVersion, sshFailureMessage, sshKeyNames } = await importHostModule('source-control/ssh-status.js');


/** 本文件的用例之间无共享进程级状态，因此并发执行；并发前提见 test/harness.mjs。 */
parallel('SSH 状态检测', (t) => {
	t.test('版本行取 OpenSSH 那一行', () => {
		assert.equal(
			parseSshVersion('', 'OpenSSH_for_Windows_9.5p1, LibreSSL 3.8.2\n'),
			'OpenSSH_for_Windows_9.5p1, LibreSSL 3.8.2',
		);
		assert.equal(parseSshVersion('OpenSSH_9.6p1 Ubuntu-3ubuntu13\n', ''), 'OpenSSH_9.6p1 Ubuntu-3ubuntu13');
		assert.equal(parseSshVersion('other output\n', ''), 'other output');
		assert.equal(parseSshVersion('', ''), null);
	});

	t.test('私钥筛选排除公钥、隐藏项与配置文件', () => {
		assert.deepEqual(
			sshKeyNames(['id_ed25519', 'id_ed25519.pub', 'id_rsa', 'known_hosts', 'known_hosts.old', 'config', 'authorized_keys', '.ssh_known', 'agent']),
			['id_ed25519', 'id_rsa'],
		);
		assert.deepEqual(sshKeyNames([]), []);
	});

	t.test('ssh 探测以退出码判定：255 是 ssh 自身出错，其余是远端命令的状态', () => {
		// 认证通过后远端拒绝命令，退出码由对方决定：gitee 为 0、github 为 1。
		assert.equal(isAuthenticated('ssh', 0), true);
		assert.equal(isAuthenticated('ssh', 1), true);
		assert.equal(isAuthenticated('ssh', 255), false);
	});

	t.test('git 探测以退出码判定：0 为通过', () => {
		assert.equal(isAuthenticated('git', 0), true);
		assert.equal(isAuthenticated('git', 1), false);
		assert.equal(isAuthenticated('git', 128), false);
		assert.equal(isAuthenticated('git', 255), false);
	});

	t.test('未就绪说明是探测输出原文，ANSI 转义序列原样保留', () => {
		const banner = "Hi \u001b[36;01myang(@xzy_nine)\u001b[0m! You've \u001b[32msuccessfully\u001b[0m authenticated, but GITEE.COM does not provide shell access.";
		assert.equal(sshFailureMessage('', banner, 'gitee.com'), banner);
		assert.equal(sshFailureMessage('fatal: 出错了\n', '', 'gitee.com'), 'fatal: 出错了');
	});

	t.test('没有输出时给兜底说明', () => {
		assert.equal(sshFailureMessage('', '', 'gitlab.com'), 'SSH 认证未通过（gitlab.com）。');
		assert.equal(sshFailureMessage('\n\n', '', 'gitlab.com'), 'SSH 认证未通过（gitlab.com）。');
	});
});
