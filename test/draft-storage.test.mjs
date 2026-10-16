/**
 * 会话级存储的测试：`panel/storage.ts` 的 draftKeyOf 与三个会话读写导出。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	clearSessionValue, draftKeyOf, loadSessionValue, migrateLegacyDrafts, saveSessionValue,
} from '../src/client/panel/storage.ts';

/** 最小存储桩：Map 实现 Storage 的读、写、删、枚举。 */
function makeStore() {
	const data = new Map();
	return {
		getItem: (key) => (data.has(key) ? data.get(key) : null),
		setItem: (key, value) => { data.set(key, String(value)); },
		removeItem: (key) => { data.delete(key); },
		clear: () => { data.clear(); },
		key: (index) => [...data.keys()][index] ?? null,
		get length() { return data.size; },
		keys: () => [...data.keys()],
		/** 直接查看底层条目数，用于断言删除。 */
		size: () => data.size,
		/** 直接查看原始文本，用于断言写入形状。 */
		raw: (key) => (data.has(key) ? data.get(key) : null),
	};
}

/** 装上 sessionStorage 桩，返回卸载函数。 */
function install(store) {
	globalThis.sessionStorage = store;
	return () => { delete globalThis.sessionStorage; };
}

/** 装上 localStorage 桩，返回卸载函数。 */
function installLocal(store) {
	globalThis.localStorage = store;
	return () => { delete globalThis.localStorage; };
}

test('字符串读写往返', () => {
	const store = makeStore();
	const uninstall = install(store);
	try {
		saveSessionValue('k', '草稿内容');
		assert.equal(loadSessionValue('k', ''), '草稿内容');
		assert.equal(store.raw('k'), JSON.stringify('草稿内容'));
	} finally {
		uninstall();
	}
});

test('缺失的键给回退值', () => {
	const store = makeStore();
	const uninstall = install(store);
	try {
		assert.equal(loadSessionValue('missing', 'fallback'), 'fallback');
		assert.deepEqual(loadSessionValue('missing', []), []);
	} finally {
		uninstall();
	}
});

test('值不是合法 JSON 时给回退值', () => {
	const store = makeStore();
	const uninstall = install(store);
	try {
		store.setItem('bad', '{not json');
		assert.equal(loadSessionValue('bad', 'fallback'), 'fallback');
	} finally {
		uninstall();
	}
});

test('写入 null 或 undefined 删除键', () => {
	const store = makeStore();
	const uninstall = install(store);
	try {
		saveSessionValue('k', 'v');
		saveSessionValue('k', null);
		assert.equal(store.size(), 0);
		saveSessionValue('k2', 'v');
		saveSessionValue('k2', undefined);
		assert.equal(store.size(), 0);
		assert.equal(loadSessionValue('k2', 'fallback'), 'fallback');
	} finally {
		uninstall();
	}
});

test('clearSessionValue 删除键', () => {
	const store = makeStore();
	const uninstall = install(store);
	try {
		saveSessionValue('k', 'v');
		clearSessionValue('k');
		assert.equal(store.size(), 0);
		assert.equal(loadSessionValue('k', 'fallback'), 'fallback');
	} finally {
		uninstall();
	}
});

test('sessionStorage 缺失时读写清都不抛错', () => {
	delete globalThis.sessionStorage;
	assert.equal(loadSessionValue('k', 'fallback'), 'fallback');
	assert.doesNotThrow(() => saveSessionValue('k', 'v'));
	assert.doesNotThrow(() => clearSessionValue('k'));
});

test('sessionStorage 抛错时读给回退、写清静默', () => {
	const throwing = {
		getItem: () => { throw new Error('denied'); },
		setItem: () => { throw new Error('denied'); },
		removeItem: () => { throw new Error('denied'); },
	};
	const uninstall = install(throwing);
	try {
		assert.equal(loadSessionValue('k', 'fallback'), 'fallback');
		assert.doesNotThrow(() => saveSessionValue('k', 'v'));
		assert.doesNotThrow(() => clearSessionValue('k'));
	} finally {
		uninstall();
	}
});

test('draftKeyOf 以固定前缀加仓库根路径为键', () => {
	assert.equal(draftKeyOf('E:\\GitHubCode\\repo'), 'ggg-commit-msg:E:\\GitHubCode\\repo');
	assert.equal(draftKeyOf('/home/user/repo'), 'ggg-commit-msg:/home/user/repo');
});

test('draftKeyOf 原样保留中文路径', () => {
	const repoPath = 'E:\\仓库\\我的项目';
	assert.equal(draftKeyOf(repoPath), 'ggg-commit-msg:' + repoPath);
});

test('草稿按仓库根分别存取', () => {
	const store = makeStore();
	const uninstall = install(store);
	try {
		saveSessionValue(draftKeyOf('E:\\a'), '仓库 a 的草稿');
		saveSessionValue(draftKeyOf('E:\\b'), '仓库 b 的草稿');
		assert.equal(loadSessionValue(draftKeyOf('E:\\a'), ''), '仓库 a 的草稿');
		assert.equal(loadSessionValue(draftKeyOf('E:\\b'), ''), '仓库 b 的草稿');
		clearSessionValue(draftKeyOf('E:\\a'));
		assert.equal(loadSessionValue(draftKeyOf('E:\\a'), ''), '');
		assert.equal(loadSessionValue(draftKeyOf('E:\\b'), ''), '仓库 b 的草稿');
	} finally {
		uninstall();
	}
});

test('存储里是非字符串 JSON 时给回退值', () => {
	const store = makeStore();
	const uninstall = install(store);
	try {
		store.setItem('num', '123');
		store.setItem('obj', JSON.stringify({ a: 1 }));
		store.setItem('nil', 'null');
		store.setItem('str', JSON.stringify('草稿'));
		assert.equal(loadSessionValue('num', 'fallback'), 'fallback');
		assert.equal(loadSessionValue('obj', 'fallback'), 'fallback');
		assert.equal(loadSessionValue('nil', 'fallback'), 'fallback');
		assert.equal(loadSessionValue('str', 'fallback'), '草稿');
	} finally {
		uninstall();
	}
});

test('migrateLegacyDrafts 把两个 store 里的旧草稿转入会话键并清掉旧键', () => {
	const session = makeStore();
	const local = makeStore();
	const uninstallSession = install(session);
	const uninstallLocal = installLocal(local);
	try {
		const keyA = draftKeyOf('E:\\a');
		const keyB = draftKeyOf('E:\\b');
		local.setItem(keyA, 'local-draft');
		local.setItem('dsh-source-control-repo-open', 'true');
		session.setItem(keyB, 'session-draft');

		let hostCalls = 0;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => { hostCalls += 1; throw new Error('不应发起宿主请求'); };
		try {
			migrateLegacyDrafts();
		} finally {
			globalThis.fetch = originalFetch;
		}

		// 转入：旧值出现在会话键上。
		assert.equal(session.getItem(keyA), 'local-draft');
		assert.equal(session.getItem(keyB), 'session-draft');
		// 清掉 localStorage 残留；会话键是转入目标，值保留。
		assert.equal(local.getItem(keyA), null);
		assert.equal(session.getItem(keyA), 'local-draft');
		assert.equal(session.getItem(keyB), 'session-draft');
		// 非草稿键不动。
		assert.equal(local.getItem('dsh-source-control-repo-open'), 'true');
		// 草稿不经过宿主。
		assert.equal(hostCalls, 0);
	} finally {
		uninstallLocal();
		uninstallSession();
	}
});

test('migrateLegacyDrafts 在 sessionStorage 缺失时保留旧键', () => {
	const local = makeStore();
	const uninstallLocal = installLocal(local);
	delete globalThis.sessionStorage;
	try {
		local.setItem(draftKeyOf('E:\\a'), 'local-draft');
		assert.doesNotThrow(() => migrateLegacyDrafts());
		assert.equal(local.getItem(draftKeyOf('E:\\a')), 'local-draft');
	} finally {
		uninstallLocal();
	}
});
