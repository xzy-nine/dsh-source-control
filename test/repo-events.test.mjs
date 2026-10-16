/**
 * 仓库变更事件流：帧解析、分帧与重连退避，以及事件与当前仓库的匹配。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesRepository, parseRepositoryWriteFrame, reconnectDelayMs, splitFrames } from '../src/client/api/repo-events.ts';

test('解析 repository-write 帧', () => {
	assert.deepEqual(parseRepositoryWriteFrame('event: repository-write\ndata: {"repo":"E:/repo"}'), { repo: 'E:/repo' });
	// 字段与冒号之间允许一个空格；注释行忽略。
	assert.deepEqual(parseRepositoryWriteFrame(': ping\nevent: repository-write\ndata: {"repo":"/r"}'), { repo: '/r' });
});

test('忽略保活、其它事件与坏数据', () => {
	assert.equal(parseRepositoryWriteFrame(': ping'), null);
	assert.equal(parseRepositoryWriteFrame(''), null);
	assert.equal(parseRepositoryWriteFrame('event: other\ndata: {"repo":"x"}'), null);
	assert.equal(parseRepositoryWriteFrame('event: repository-write\ndata: not json'), null);
	assert.equal(parseRepositoryWriteFrame('event: repository-write\ndata: {"repo":42}'), null);
	assert.equal(parseRepositoryWriteFrame('event: repository-write\ndata: {"repo":""}'), null);
});

test('按空行切分帧并保留不完整的尾段', () => {
	const { frames, rest } = splitFrames('a\n\nb\n\nc');
	assert.deepEqual(frames, ['a', 'b']);
	assert.equal(rest, 'c');
	// 空缓冲不产生帧。
	assert.deepEqual(splitFrames(''), { frames: [], rest: '' });
	// 帧内保留单个换行，只有空行才分帧。
	assert.deepEqual(splitFrames('event: a\ndata: 1\n\n'), { frames: ['event: a\ndata: 1'], rest: '' });
});

test('重连延迟翻倍并封顶', () => {
	assert.equal(reconnectDelayMs(1), 1000);
	assert.equal(reconnectDelayMs(2), 2000);
	assert.equal(reconnectDelayMs(3), 4000);
	assert.equal(reconnectDelayMs(99), 30000);
	// 非法次数按首次处理。
	assert.equal(reconnectDelayMs(0), 1000);
	assert.equal(reconnectDelayMs(Number.NaN), 1000);
});

test('仓库路径匹配忽略分隔符与盘符大小写', () => {
	assert.equal(matchesRepository('E:/Repo', 'e:\\Repo'), true);
	assert.equal(matchesRepository('E:/Repo/', 'E:/Repo'), true);
	// 子模块写入会让外层仓库出现改动。
	assert.equal(matchesRepository('E:/Repo', 'E:/Repo/sub/module'), true);
	assert.equal(matchesRepository('E:/Repo', 'E:/Other'), false);
	assert.equal(matchesRepository('E:/Repo', 'E:/RepoOther'), false);
	assert.equal(matchesRepository('', 'E:/Repo'), false);
	assert.equal(matchesRepository('E:/Repo', ''), false);
});
