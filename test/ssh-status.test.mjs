/**
 * SSH 状态检测的纯逻辑测试。
 *
 * 覆盖版本行提取、私钥筛选与探测输出归类；真实探测需要本机安装 ssh 并联网，不在此测试内。
 *
 * `ssh-status.ts` 有内部 `.js` 相对导入，无法由 `src/` 直连 `.ts`，因此从 `lib/` 产物导入；
 * `pretest` 会先重建产物。归类断言按 `kind` 判定，不按说明文案。
 */
import assert from 'node:assert/strict';
import { importHostModule } from './lib-import.mjs';
import { parallel } from './harness.mjs';

const { classifySshProbe, parseSshVersion, sshKeyNames, SSH_TEXT } = await importHostModule('source-control/ssh-status.js');


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

	t.test('认证成功以输出文本为准（退出码非 0 也算通过）', () => {
		const verdict = classifySshProbe('', "Hi user! You've successfully authenticated, but GitHub does not provide shell access.\n", 'github.com');
		assert.equal(verdict.authenticated, true);
		assert.equal(verdict.kind, 'authenticated');
		assert.equal(verdict.message, null);
	});

	t.test('主机指纹未确认时给出确认指引', () => {
		const verdict = classifySshProbe('', 'Host key verification failed.', 'github.com');
		assert.equal(verdict.authenticated, false);
		assert.equal(verdict.kind, 'host-key');
		assert.equal(verdict.message, SSH_TEXT.hostKey.replaceAll('{host}', 'github.com'));
	});

	t.test('公钥被拒绝时指出公钥问题', () => {
		const denied = classifySshProbe('', 'git@github.com: Permission denied (publickey).', 'github.com');
		assert.equal(denied.authenticated, false);
		assert.equal(denied.kind, 'publickey');
		assert.equal(denied.message, SSH_TEXT.publickey.replaceAll('{host}', 'github.com'));
	});

	t.test('网络不可达时指出连接问题', () => {
		const refused = classifySshProbe('', 'ssh: connect to host github.com port 22: Connection refused', 'github.com');
		assert.equal(refused.authenticated, false);
		assert.equal(refused.kind, 'network');
		assert.equal(refused.message, SSH_TEXT.network.replaceAll('{host}', 'github.com'));
	});

	t.test('空输出给出兜底说明', () => {
		const empty = classifySshProbe('', '', 'gitlab.com');
		assert.equal(empty.authenticated, false);
		assert.equal(empty.kind, 'other');
		assert.equal(empty.message, SSH_TEXT.fallback.replaceAll('{host}', 'gitlab.com'));
	});
});
