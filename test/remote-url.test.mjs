/**
 * 远程地址换算测试。
 *
 * 覆盖 HTTP(S) / SSH / scp / 本地路径四类输入的解析与互转；`.git` 后缀与路径原样保留，
 * 不可换算的地址必须返回 null，避免把本地路径或 `file://` 当成远程地址改写。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	isSshRemoteUrl, parseRemoteAddress, remoteHostOf, remoteProtocolSlot, toHttpsRemoteUrl, toSshRemoteUrl,
} from '../src/client/git/remote-url.ts';

test('HTTPS 地址换算为 scp 形态的 SSH 地址', () => {
	assert.equal(toSshRemoteUrl('https://github.com/owner/repo.git'), 'git@github.com:owner/repo.git');
	assert.equal(toSshRemoteUrl('http://gitlab.com/group/sub/repo.git'), 'git@gitlab.com:group/sub/repo.git');
});

test('换算保留原有的 .git 后缀写法', () => {
	assert.equal(toSshRemoteUrl('https://github.com/owner/repo'), 'git@github.com:owner/repo');
	assert.equal(toSshRemoteUrl('https://github.com/owner/repo.git/'), 'git@github.com:owner/repo.git/');
});

test('ssh:// 形态归一为 scp 形态', () => {
	assert.equal(toSshRemoteUrl('ssh://git@github.com/owner/repo.git'), 'git@github.com:owner/repo.git');
	assert.equal(toSshRemoteUrl('ssh://git@github.com:22/owner/repo.git'), 'git@github.com:owner/repo.git');
});

test('已是 scp 形态的 SSH 地址原样返回', () => {
	assert.equal(toSshRemoteUrl('git@github.com:owner/repo.git'), 'git@github.com:owner/repo.git');
	assert.equal(toSshRemoteUrl('  git@github.com:owner/repo.git  '), 'git@github.com:owner/repo.git');
});

test('git:// 地址换算为 SSH 地址', () => {
	assert.equal(toSshRemoteUrl('git://github.com/owner/repo.git'), 'git@github.com:owner/repo.git');
});

test('本地路径与未知 scheme 不可换算', () => {
	assert.equal(toSshRemoteUrl('C:\\repos\\demo'), null);
	assert.equal(toSshRemoteUrl('/home/user/repo'), null);
	assert.equal(toSshRemoteUrl('file:///home/user/repo'), null);
	assert.equal(toSshRemoteUrl('https://github.com'), null);
	assert.equal(toSshRemoteUrl(''), null);
});

test('SSH 可换回 HTTPS', () => {
	assert.equal(toHttpsRemoteUrl('git@github.com:owner/repo.git'), 'https://github.com/owner/repo.git');
	assert.equal(toHttpsRemoteUrl('ssh://git@github.com/owner/repo.git'), 'https://github.com/owner/repo.git');
	assert.equal(toHttpsRemoteUrl('https://github.com/owner/repo.git'), 'https://github.com/owner/repo.git');
	assert.equal(toHttpsRemoteUrl('C:\\repos\\demo'), null);
});

test('解析结果给出协议、形态、主机与路径', () => {
	assert.deepEqual(parseRemoteAddress('git@github.com:owner/repo.git'), {
		protocol: 'ssh', form: 'scp', host: 'github.com', path: 'owner/repo.git',
	});
	assert.deepEqual(parseRemoteAddress('https://github.com/owner/repo.git'), {
		protocol: 'https', form: 'url', host: 'github.com', path: 'owner/repo.git',
	});
	assert.deepEqual(parseRemoteAddress('C:\\repos\\demo'), {
		protocol: 'file', form: 'path', host: '', path: 'C:\\repos\\demo',
	});
	assert.equal(parseRemoteAddress(''), null);
});

test('识别 SSH 形态并取主机名', () => {
	assert.equal(isSshRemoteUrl('git@github.com:owner/repo.git'), true);
	assert.equal(isSshRemoteUrl('ssh://git@github.com/owner/repo.git'), true);
	assert.equal(isSshRemoteUrl('https://github.com/owner/repo.git'), false);
	assert.equal(remoteHostOf('git@github.com:owner/repo.git'), 'github.com');
	assert.equal(remoteHostOf('https://github.com/owner/repo.git'), 'github.com');
	assert.equal(remoteHostOf('C:\\repos\\demo'), '');
});

test('协议档位把 HTTP(S) 与 git:// 归入 HTTPS，本地路径不可判定', () => {
	assert.equal(remoteProtocolSlot('https://github.com/owner/repo.git'), 'https');
	assert.equal(remoteProtocolSlot('http://github.com/owner/repo.git'), 'https');
	assert.equal(remoteProtocolSlot('git://github.com/owner/repo.git'), 'https');
	assert.equal(remoteProtocolSlot('git@github.com:owner/repo.git'), 'ssh');
	assert.equal(remoteProtocolSlot('ssh://git@github.com/owner/repo.git'), 'ssh');
	assert.equal(remoteProtocolSlot('C:\\repos\\demo'), null);
	assert.equal(remoteProtocolSlot(''), null);
});
