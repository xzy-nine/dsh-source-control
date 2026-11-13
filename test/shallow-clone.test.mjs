/**
 * 浅克隆的恢复契约：仓库树标记浅克隆、`unshallow` 命令补全历史并还原分支与标签跟随。
 *
 * 被测模块有内部 `.js` 相对导入，无法由 `src/` 直连 `.ts`，因此从 `lib/` 产物导入；
 * `pretest` 会先重建产物。用例起真实 git 子进程，文件内串行执行。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const discoveryPath = join(root, 'lib', 'src', 'source-control', 'repo-discovery.js');
const routesPath = join(root, 'lib', 'src', 'source-control', 'routes.js');

/** 临时目录登记表；文件级 after 统一删除。 */
const temps = [];
test.after(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/**
 * 建一个临时目录并登记清理。
 *
 * @param prefix - 目录名前缀。
 * @returns 目录绝对路径。
 */
function makeTemp(prefix) {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	temps.push(dir);
	return dir;
}

/**
 * 在指定目录跑一次 git。
 *
 * @param cwd - 工作目录。
 * @param args - git 参数。
 * @returns 标准输出。
 */
function gitIn(cwd, ...args) {
	return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/**
 * 把本地路径写成 git 可克隆的 URL。
 *
 * 本地路径形式会让 git 忽略 `--depth`（`--depth is ignored in local clones`），
 * 因此必须用 `file://` 协议，否则造不出真正截断历史的浅克隆。
 *
 * @param path - 绝对路径。
 * @returns 文件协议 URL。
 */
function fileUrlOf(path) {
	return 'file:///' + path.replace(/\\/g, '/');
}

/**
 * 造一个带分支与标签的裸仓库，作为克隆来源。
 *
 * @param parent - 父目录。
 * @returns 裸仓库绝对路径与该仓库主分支名。
 */
function makeOrigin(parent) {
	const origin = join(parent, 'origin.git');
	gitIn(parent, 'init', '--bare', '-q', origin);
	const work = join(parent, 'origin-work');
	gitIn(parent, 'clone', '-q', origin, work);
	gitIn(work, 'config', 'user.email', 'shallow@example.com');
	gitIn(work, 'config', 'user.name', 'Shallow');
	writeFileSync(join(work, 'a.txt'), 'one\n');
	gitIn(work, 'add', '-A');
	gitIn(work, 'commit', '-q', '-m', 'first');
	gitIn(work, 'branch', 'feature');
	writeFileSync(join(work, 'b.txt'), 'two\n');
	gitIn(work, 'add', '-A');
	gitIn(work, 'commit', '-q', '-m', 'second');
	gitIn(work, 'tag', 'v1');
	const branch = gitIn(work, 'symbolic-ref', '--short', 'HEAD').trim();
	gitIn(work, 'push', '-q', 'origin', branch, 'feature', '--tags');
	return { origin, branch };
}

/**
 * 按本插件的克隆参数造一个浅克隆。
 *
 * @param parent - 父目录。
 * @param origin - 来源裸仓库路径。
 * @param name - 克隆目录名。
 * @returns 克隆出的仓库路径。
 */
function makeShallowClone(parent, origin, name = 'clone') {
	const target = join(parent, name);
	gitIn(parent, 'clone', '--depth=1', '--single-branch', '--no-tags', '--', fileUrlOf(origin), target);
	return target;
}

/**
 * 取一条经真实路由 handler 发请求的调用函数。
 *
 * @param repo - 仓库路径。
 * @returns 发送命令并解析响应的函数。
 */
async function makeCaller(repo) {
	const { registerGgRoutes } = await import(pathToFileURL(routesPath).href);
	const routes = new Map();
	registerGgRoutes({
		register(spec) {
			routes.set(spec.path, spec.handler);
			return () => {};
		},
	});
	const handler = routes.get('/dsh-source-control/gg/api');
	return (message) => new Promise((resolve, reject) => {
		const body = JSON.stringify({ repo, ...message });
		const req = {
			method: 'POST',
			on(event, callback) {
				if (event === 'data') callback(Buffer.from(body, 'utf8'));
				if (event === 'end') callback();
				return req;
			},
		};
		const res = {
			writeHead() {},
			end(text) {
				try { resolve(JSON.parse(text)); } catch (error) { reject(error); }
			},
		};
		Promise.resolve(handler(req, res)).catch(reject);
	});
}

/**
 * 读一条本地配置；未配置时返回空串。
 *
 * `git config --get` 在键不存在时以退出码 1 结束，execFileSync 会抛错，因此单独包一层。
 *
 * @param repo - 仓库路径。
 * @param key - 配置键。
 * @returns 配置值；未配置时为空串。
 */
function configOf(repo, key) {
	try {
		return gitIn(repo, 'config', '--get', key).trim();
	} catch {
		return '';
	}
}

/**
 * 读仓库当前是否仍为浅克隆。
 *
 * @param repo - 仓库路径。
 * @returns 是浅克隆时为 true。
 */
function isShallow(repo) {
	return gitIn(repo, 'rev-parse', '--is-shallow-repository').trim() === 'true';
}

test('仓库树把浅克隆的仓库标出来，完整克隆不标', async () => {
	const { enrichRepositories } = await import(pathToFileURL(discoveryPath).href);
	const parent = makeTemp('gg-shallow-tree-');
	const { origin } = makeOrigin(parent);
	const shallow = makeShallowClone(parent, origin, 'shallow');
	const full = join(parent, 'full');
	gitIn(parent, 'clone', '-q', '--', fileUrlOf(origin), full);

	const nodes = await enrichRepositories([shallow, full]);
	const byPath = new Map(nodes.map((node) => [node.path, node]));
	assert.equal(byPath.get(shallow).shallowClone, true, '浅克隆的仓库应带标记');
	assert.equal(byPath.get(full).shallowClone, false, '完整克隆不带标记');
});

test('链接工作树沿用所属仓库的浅克隆状态', async () => {
	const { enrichRepositories } = await import(pathToFileURL(discoveryPath).href);
	const parent = makeTemp('gg-shallow-wt-');
	const { origin } = makeOrigin(parent);
	const shallow = makeShallowClone(parent, origin, 'shallow');
	const linked = join(parent, 'linked');
	gitIn(shallow, 'worktree', 'add', '-q', linked, '-b', 'linked');

	const [node] = await enrichRepositories([shallow]);
	const worktrees = node.children.filter((child) => child.kind === 'worktree');
	assert.equal(worktrees.length, 1);
	assert.equal(worktrees[0].shallowClone, true, '工作树与主仓库共用同一公共目录');
});

test('unshallow 命令补全历史并还原分支与标签跟随', async () => {
	const parent = makeTemp('gg-shallow-cmd-');
	const { origin } = makeOrigin(parent);
	const clone = makeShallowClone(parent, origin);
	assert.equal(isShallow(clone), true, '先确认造出的是浅克隆');
	assert.deepEqual(gitIn(clone, 'tag').trim().split('\n').filter(Boolean), [], '浅克隆按 --no-tags 不带标签');

	const call = await makeCaller(clone);
	const result = await call({ command: 'unshallow' });
	assert.equal(result.error, null);
	assert.equal(result.shallowClone, false, '回投恢复后的状态');

	assert.equal(isShallow(clone), false, 'shallow 文件已消失');
	assert.ok(gitIn(clone, 'tag').trim().split('\n').includes('v1'), '标签取回');
	assert.match(gitIn(clone, 'branch', '-a'), /origin\/feature/, '被 --single-branch 关掉的分支取回');
	assert.equal(gitIn(clone, 'config', '--get-all', 'remote.origin.fetch').trim(), '+refs/heads/*:refs/remotes/origin/*', 'refspec 还原为全部分支');
	assert.equal(configOf(clone, 'remote.origin.tagopt'), '', 'remote.origin.tagopt 已清除');
	assert.ok(Number(gitIn(clone, 'rev-list', '--count', 'HEAD').trim()) >= 2, '截断的历史补齐');
});

test('unshallow 在完整仓库上不动配置，重复调用也不报错', async () => {
	const parent = makeTemp('gg-shallow-noop-');
	const { origin } = makeOrigin(parent);
	const clone = makeShallowClone(parent, origin);
	const call = await makeCaller(clone);
	assert.equal((await call({ command: 'unshallow' })).error, null);
	assert.equal((await call({ command: 'unshallow' })).error, null, '已成完整仓库时再次恢复仍成功');
	assert.equal(isShallow(clone), false);
});

test('没有远程时 unshallow 回投可读失败而不是静默成功', async () => {
	const parent = makeTemp('gg-shallow-noremote-');
	const { origin } = makeOrigin(parent);
	const clone = makeShallowClone(parent, origin);
	gitIn(clone, 'remote', 'remove', 'origin');

	const call = await makeCaller(clone);
	const result = await call({ command: 'unshallow' });
	assert.equal(typeof result.error, 'string');
	assert.ok(result.error.length > 0, '应说明缺少远程');
	assert.equal(isShallow(clone), true, '历史无从取回，浅克隆保持不变');
});

test('非仓库路径上的 unshallow 直接回未变化，不起 git 子进程', async () => {
	const parent = makeTemp('gg-shallow-plain-');
	mkdirSync(join(parent, 'plain'), { recursive: true });
	const call = await makeCaller(join(parent, 'plain'));
	const result = await call({ command: 'unshallow' });
	assert.equal(result.error, null);
	assert.equal(result.shallowClone, false);
});
