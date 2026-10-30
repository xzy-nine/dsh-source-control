/**
 * 日志脱敏：URL 凭据、令牌串、系统用户名替换为可分辨用途的占位符；
 * 本地路径不处理；登记的豁免原样保留。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	PLACEHOLDER_CREDENTIAL, PLACEHOLDER_TOKEN, PLACEHOLDER_USER, redactSummary, redactText,
} from '../lib/src/source-control/log-redact.js';

test('URL 里的账号口令被屏蔽，scheme 与主机保留', () => {
	const result = redactText('clone https://alice:s3cret@github.com/o/r.git now');
	assert.equal(result.text, `clone https://${PLACEHOLDER_CREDENTIAL}github.com/o/r.git now`);
	assert.equal(result.counts.credential, 1);
});

test('令牌串按前缀识别', () => {
	const result = redactText('token ghp_abcdefghijklmnopqrstu and github_pat_abcdefghijklmnopqrstuvwx');
	assert.ok(!result.text.includes('ghp_'));
	assert.ok(!result.text.includes('github_pat_'));
	assert.equal(result.counts.token, 2);
	assert.equal(result.text.split(PLACEHOLDER_TOKEN).length - 1, 2);
});

test('系统用户名被屏蔽，本地路径原样保留', () => {
	const result = redactText('user=alice path=C:\\Users\\alice\\repo\\a.ts home=/home/alice', { username: 'alice' });
	// 路径里的用户名属于路径成分，保留；独立出现的替换。
	assert.equal(result.text, `user=${PLACEHOLDER_USER} path=C:\\Users\\alice\\repo\\a.ts home=/home/alice`);
	assert.equal(result.counts.user, 1);
});

test('豁免字符串原样保留，其余照常屏蔽', () => {
	const result = redactText('keep abc123 here and ghp_abcdefghijklmnopqrstu', { exemptions: ['abc123'] });
	assert.ok(result.text.includes('abc123'));
	assert.ok(!result.text.includes('ghp_'));
});

test('脱敏摘要只列出发生过的替换', () => {
	assert.equal(redactSummary({ credential: 0, token: 0, user: 0 }), '');
	const summary = redactSummary({ credential: 1, token: 2, user: 0 });
	assert.ok(summary.includes('URL 凭据'));
	assert.ok(summary.includes('令牌'));
	assert.ok(!summary.includes('用户名'));
});

test('多次脱敏结果稳定：占位符不会被后续规则再次替换', () => {
	const once = redactText('https://u:p@h/x ghp_abcdefghijklmnopqrstu', {}).text;
	const twice = redactText(once, {}).text;
	assert.equal(twice, once);
});
