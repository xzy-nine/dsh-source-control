/**
 * 仓库发现测试共用的临时仓库夹具。
 *
 * 7 个 repo-discovery 系列文件原本各自维护同一套 helper；抽取后由本模块提供，
 * 各文件只需传入自己的临时目录登记表与状态文档路径，清理与隔离归属仍在调用方。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 建立一组仓库发现夹具。
 *
 * @param temps - 调用方的临时目录登记表；makeTemp 建出的目录登记其中，由调用方的 after 统一删除。
 * @param statePath - 状态文档产物的绝对路径，供 resetState 清内存镜像。
 * @returns 夹具函数集合。
 */
export function createRepoFixture(temps, statePath) {
	/** 建一个临时目录并登记清理。 */
	function makeTemp(prefix) {
		const dir = mkdtempSync(join(tmpdir(), prefix));
		temps.push(dir);
		return dir;
	}

	/** 在指定目录执行一次 git。 */
	function gitIn(cwd, ...args) {
		return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	}

	/** 在一个目录下建一个已提交的仓库。 */
	function makeRepoAt(parent, name) {
		const repo = join(parent, name);
		mkdirSync(repo, { recursive: true });
		gitIn(repo, 'init', '-q', '-b', 'main');
		gitIn(repo, 'config', 'user.email', 'disc@example.com');
		gitIn(repo, 'config', 'user.name', 'Disc');
		writeFileSync(join(repo, 'a.txt'), 'one\n');
		gitIn(repo, 'add', '-A');
		gitIn(repo, 'commit', '-q', '-m', 'base');
		return repo;
	}

	/** 造一个仓库目录（未提交），供已知路径快路径的节点数断言使用。 */
	function makeBareRepoAt(parent, name) {
		const repo = join(parent, name);
		mkdirSync(repo, { recursive: true });
		gitIn(repo, 'init', '-q', '-b', 'main');
		return repo;
	}

	/**
	 * 造一棵发现用目录树：两个顶层仓库（第二个在第 2 层）、一个链接工作树、一个子模块。
	 *
	 * 目录布局（root 为工作区根）：
	 *   top-repo/            顶层仓库，挂 1 个链接工作树
	 *   nested/mid-repo/     第 2 层仓库，挂 1 个子模块
	 *   nested/plain/        非仓库目录
	 *
	 * @returns 根目录、两个仓库路径与链接工作树路径。
	 */
	function makeTree() {
		const rootDir = makeTemp('gg-disc-');
		const top = makeRepoAt(rootDir, 'top-repo');

		const linked = join(rootDir, 'linked-wt');
		gitIn(top, 'worktree', 'add', '-q', linked, '-b', 'linked');

		const nested = join(rootDir, 'nested');
		mkdirSync(join(nested, 'plain'), { recursive: true });
		const mid = makeRepoAt(nested, 'mid-repo');

		const subSource = makeTemp('gg-disc-subsrc-');
		gitIn(subSource, 'init', '-q', '-b', 'main');
		gitIn(subSource, 'config', 'user.email', 'sub@example.com');
		gitIn(subSource, 'config', 'user.name', 'Sub');
		writeFileSync(join(subSource, 's.txt'), 's\n');
		gitIn(subSource, 'add', '-A');
		gitIn(subSource, 'commit', '-q', '-m', 'sub');
		const subBare = makeTemp('gg-disc-subbare-');
		gitIn(tmpdir(), 'clone', '-q', '--bare', subSource, subBare);
		gitIn(mid, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subBare, 'sub');
		gitIn(mid, 'commit', '-q', '-m', 'add submodule');

		return { root: rootDir, top, mid, linked };
	}

	/** 把路径统一成 `/` 分隔，供跨平台比较。 */
	function normalizePath(path) {
		return path.replace(/\\/g, '/');
	}

	/** 取出仓库节点上的子模块节点。 */
	function submodulesOf(node) {
		return node.children.filter((child) => child.kind === 'submodule');
	}

	/** 取出仓库节点上的工作树节点。 */
	function worktreesOf(node) {
		return node.children.filter((child) => child.kind === 'worktree');
	}

	/**
	 * 节点的比较用形状：去掉对象身份，只留可跨实现比较的字段。
	 *
	 * 顶层 depth 不参与比较：按已知路径构造的节点不经过层序遍历，depth 恒为 0，与既有
	 * `knownRepos` 快路径的已记录差异相同；子节点的 depth 照常比较。
	 */
	function shapeOf(node, top = true) {
		return {
			id: node.id, path: node.path, name: node.name, kind: node.kind,
			depth: top ? undefined : node.depth,
			branch: node.branch, head: node.head, available: node.available,
			children: (node.children ?? []).map((child) => shapeOf(child, false)),
		};
	}

	/** 清掉状态文档的内存镜像，使下一次读取重新落盘载入。 */
	async function resetState() {
		const { resetStateCache } = await import(pathToFileURL(statePath).href);
		resetStateCache();
	}

	/**
	 * 造一棵含三类仓库的发现用目录树，三类仓库都在工作区根下第 1 层：
	 *   plain-repo/   无链接工作树、无子模块
	 *   sub-repo/     挂 1 个子模块
	 *   wt-repo/      挂 1 个链接工作树
	 *
	 * @returns 根目录与三类仓库路径。
	 */
	function makeMixedTree() {
		const rootDir = makeTemp('gg-disc-mixed-');
		const plain = makeRepoAt(rootDir, 'plain-repo');
		const sub = makeRepoAt(rootDir, 'sub-repo');
		const wt = makeRepoAt(rootDir, 'wt-repo');

		gitIn(wt, 'worktree', 'add', '-q', join(rootDir, 'wt-linked'), '-b', 'linked');

		const subSource = makeTemp('gg-disc-mixed-subsrc-');
		gitIn(subSource, 'init', '-q', '-b', 'main');
		gitIn(subSource, 'config', 'user.email', 'sub@example.com');
		gitIn(subSource, 'config', 'user.name', 'Sub');
		writeFileSync(join(subSource, 's.txt'), 's\n');
		gitIn(subSource, 'add', '-A');
		gitIn(subSource, 'commit', '-q', '-m', 'sub');
		const subBare = makeTemp('gg-disc-mixed-subbare-');
		gitIn(tmpdir(), 'clone', '-q', '--bare', subSource, subBare);
		gitIn(sub, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subBare, 'sub');
		gitIn(sub, 'commit', '-q', '-m', 'add submodule');

		return { root: rootDir, plain, sub, wt };
	}

	return { makeTemp, gitIn, makeRepoAt, makeBareRepoAt, makeTree, normalizePath, submodulesOf, worktreesOf, shapeOf, resetState, makeMixedTree };
}
