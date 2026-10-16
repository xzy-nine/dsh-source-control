/**
 * SSH 状态检测的纯逻辑测试。
 *
 * 覆盖版本行提取、私钥筛选与探测输出归类；真实探测需要本机安装 ssh 并联网，不在此测试内。
 *
 * `ssh-status.ts` 有内部 `.js` 相对导入，无法由 `src/` 直连 `.ts`，因此从 `lib/` 产物导入；
 * `pretest` 会先重建产物。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { importHostModule } from './lib-import.mjs';

const { classifySshProbe, parseSshVersion, sshKeyNames } = await importHostModule('source-control/ssh-status.js');

test('版本行取 OpenSSH 那一行', () => {
	assert.equal(
		parseSshVersion('', 'OpenSSH_for_Windows_9.5p1, LibreSSL 3.8.2\n'),
		'OpenSSH_for_Windows_9.5p1, LibreSSL 3.8.2',
	);
	assert.equal(parseSshVersion('OpenSSH_9.6p1 Ubuntu-3ubuntu13\n', ''), 'OpenSSH_9.6p1 Ubuntu-3ubuntu13');
	assert.equal(parseSshVersion('other output\n', ''), 'other output');
	assert.equal(parseSshVersion('', ''), null);
});

test('私钥筛选排除公钥、隐藏项与配置文件', () => {
	assert.deepEqual(
		sshKeyNames(['id_ed25519', 'id_ed25519.pub', 'id_rsa', 'known_hosts', 'known_hosts.old', 'config', 'authorized_keys', '.ssh_known', 'agent']),
		['id_ed25519', 'id_rsa'],
	);
	assert.deepEqual(sshKeyNames([]), []);
});

test('认证成功以输出文本为准（退出码非 0 也算通过）', () => {
	const verdict = classifySshProbe('', "Hi user! You've successfully authenticated, but GitHub does not provide shell access.\n", 'github.com');
	assert.equal(verdict.authenticated, true);
	assert.equal(verdict.message, null);
});

test('主机指纹未确认时给出确认指引', () => {
	const verdict = classifySshProbe('', 'Host key verification failed.', 'github.com');
	assert.equal(verdict.authenticated, false);
	assert.match(verdict.message, /指纹/);
	assert.match(verdict.message, /github\.com/);
});

test('公钥被拒绝时指出公钥问题', () => {
	const denied = classifySshProbe('', 'git@github.com: Permission denied (publickey).', 'github.com');
	assert.equal(denied.authenticated, false);
	assert.match(denied.message, /公钥/);
});

test('网络不可达时指出连接问题', () => {
	const refused = classifySshProbe('', 'ssh: connect to host github.com port 22: Connection refused', 'github.com');
	assert.equal(refused.authenticated, false);
	assert.match(refused.message, /无法连接/);
});

test('空输出给出兜底说明', () => {
	const empty = classifySshProbe('', '', 'gitlab.com');
	assert.equal(empty.authenticated, false);
	assert.match(empty.message, /gitlab\.com/);
});
