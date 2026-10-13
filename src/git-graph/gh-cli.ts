/**
 * GitHub 集成：调用 `gh` CLI 完成发布仓库与创建 Pull Request。
 *
 * 子进程一律用数组参数直接 spawn、不经 shell，与 `working-tree.ts` 的 git 执行方式一致。
 * 需要凭据的操作在没有 `gh` 或未登录时返回可读错误，由前端提示。
 */
import { spawn } from 'node:child_process';

/** 一次 `gh` 调用的结果。 */
export interface GhResult {
	/** 退出码；子进程无法启动时为 -1。 */
	readonly code: number;
	/** 标准输出。 */
	readonly stdout: string;
	/** 标准错误。 */
	readonly stderr: string;
}

/** GitHub 账号信息。 */
export interface GhAccount {
	/** 是否已登录。 */
	readonly loggedIn: boolean;
	/** 当前登录的用户名；未登录时为 null。 */
	readonly user: string | null;
	/** 可作为仓库属主的登录名：个人账号 + 其加入的组织。 */
	readonly owners: readonly string[];
	/** 当前 token 的 scope 列表。 */
	readonly scopes: readonly string[];
	/** 缺少的功能与原因；供前端决定降级路径。 */
	readonly unavailable: readonly { readonly feature: 'create-repo' | 'create-pr'; readonly reason: GhFailureKind; readonly message: string }[];
}

/** 一个可发布的属主。 */
export interface GhOwner {
	/** 登录名以及它是否组织。 */
	readonly login: string;
	readonly isOrg: boolean;
	/** 展示名；缺省时用登录名。 */
	readonly name: string;
}

/**
 * 运行一次 `gh`。
 *
 * 与 `runGit` 同构：无法启动子进程（`gh` 不在 PATH、工作目录不存在）时不抛错，而是以
 * 退出码 -1 与错误文本返回，让调用方的失败处理与 `gh` 自身失败走同一条路径。
 *
 * @param args - 参数数组，按原样传给 `gh`。
 * @param cwd - 工作目录，必须是仓库或其子目录。
 * @returns 退出码与输出。
 */
function runGh(args: readonly string[], cwd: string): Promise<GhResult> {
	return new Promise((resolve) => {
		const child = spawn('gh', [...args], {
			cwd,
			windowsHide: true,
			// 非交互：任何需要用户输入的提示都直接失败，避免子进程挂起等待。
			env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GIT_TERMINAL_PROMPT: '0' },
		});
		let stdout = '';
		let stderr = '';
		let settled = false;
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => { stdout += chunk; });
		child.stderr.on('data', (chunk: string) => { stderr += chunk; });
		child.on('error', (error: Error) => {
			if (settled) return;
			settled = true;
			resolve({ code: -1, stdout, stderr: stderr !== '' ? stderr : error.message });
		});
		child.on('close', (code) => {
			if (settled) return;
			settled = true;
			resolve({ code: code === null ? -1 : code, stdout, stderr });
		});
	});
}

/**
 * `gh` 失败的原因分类。
 *
 * 前端据此决定降级路径：权限类可提示补授权后重试，未登录或缺 CLI 则隐藏 GitHub 功能、
 * 退回手工填写远程地址。
 */
export type GhFailureKind =
	/** 未找到 gh CLI。 */
	| 'missing-cli'
	/** gh 未登录或凭据失效。 */
	| 'not-logged-in'
	/** 缺少 token scope；`scope` 给出需补的 scope 名。 */
	| 'missing-scope'
	/** 有凭据但无权限：GitHub 对无权访问的资源常回 404。 */
	| 'forbidden'
	/** 资源不存在。 */
	| 'not-found'
	/** 参数校验失败（如仓库名为空、重名）。 */
	| 'invalid'
	/** 其他失败。 */
	| 'unknown';

/** 分类后的 `gh` 失败。 */
export interface GhFailure {
	readonly kind: GhFailureKind;
	/** 缺失的 scope 名；仅 `missing-scope` 时给出。 */
	readonly scope: string | null;
	/** 给用户看的错误文本。 */
	readonly message: string;
}

/**
 * 判断 `gh` 的失败属于哪一类。
 *
 * 依据 `gh` 的真实输出形态：缺 scope 时输出 `This API operation needs the "x" scope`；
 * 未登录时输出 `gh auth login`；GitHub 对无权访问的资源回 404，因此组织内建仓库失败
 * 也归入无权限而非「不存在」。
 *
 * @param result - `gh` 调用结果。
 * @param action - 本次动作的语义；`create-repo` 会把 404 解释为无权限。
 * @returns 分类结果。
 */
export function classifyGhFailure(result: GhResult, action: 'generic' | 'create-repo' = 'generic'): GhFailure {
	const text = `${result.stderr}\n${result.stdout}`.trim();
	if (result.code === -1 && /ENOENT/i.test(result.stderr)) {
		return { kind: 'missing-cli', scope: null, message: '未找到 gh CLI，请先安装 GitHub CLI（https://cli.github.com）。' };
	}
	const scope = /needs the "([^"]+)" scope/.exec(text)?.[1] ?? null;
	if (scope !== null) {
		return { kind: 'missing-scope', scope, message: `GitHub 授权缺少 ${scope} 权限，请运行 gh auth refresh -s ${scope} 后重试。` };
	}
	if (/gh auth login|not logged in|authentication required|bad credentials/i.test(text)) {
		return { kind: 'not-logged-in', scope: null, message: 'gh 未登录，请运行 gh auth login 后重试。' };
	}
	if (/HTTP 403|Must have admin rights|Resource not accessible/i.test(text)) {
		return { kind: 'forbidden', scope: null, message: '当前账号没有执行该操作的权限。' };
	}
	if (/HTTP 404|Not Found/i.test(text)) {
		// 建仓库时 404 表示无权在该属主下创建（GitHub 不区分「无权」与「不存在」）。
		return action === 'create-repo'
			? { kind: 'forbidden', scope: null, message: '当前账号没有在该属主下创建仓库的权限，或该属主不允许创建。' }
			: { kind: 'not-found', scope: null, message: '目标不存在或当前账号无权访问。' };
	}
	if (/HTTP 422/.test(text)) {
		return { kind: 'invalid', scope: null, message: 'GitHub 拒绝了该请求，请检查名称与参数。' };
	}
	return { kind: 'unknown', scope: null, message: text === '' ? 'gh 执行失败' : text };
}

/**
 * 把 `gh` 的失败整理成可读错误文本。
 *
 * @param result - `gh` 调用结果。
 * @param action - 本次动作的语义。
 * @returns 错误文本。
 */
function ghError(result: GhResult, action: 'generic' | 'create-repo' = 'generic'): string {
	const failure = classifyGhFailure(result, action);
	// 分类文本是对权限问题的转述；其余情况保留 gh 原文以便排查。
	if (failure.kind === 'unknown') return result.stderr.trim() || result.stdout.trim() || 'gh 执行失败';
	return failure.message;
}

/**
 * 读取当前 GitHub 账号与可用的仓库属主。
 *
 * 同时给出各功能是否可用：缺 `repo` scope 时建仓库与建 PR 都无法进行，前端据此隐藏
 * 对应入口并展示原因，而不是让操作到最后一刻才失败。
 *
 * @param repo - 仓库路径。
 * @returns 账号信息；未登录时 `loggedIn` 为 false。
 */
export async function ghAccount(repo: string): Promise<GhAccount> {
	const unavailable: { feature: 'create-repo' | 'create-pr'; reason: GhFailureKind; message: string }[] = [];
	const auth = await runGh(['auth', 'status'], repo);
	if (auth.code !== 0) {
		const failure = classifyGhFailure(auth);
		const reason = failure.kind === 'missing-cli' ? 'missing-cli' : 'not-logged-in';
		const message = failure.kind === 'missing-cli' ? failure.message : 'gh 未登录，请运行 gh auth login 后重试。';
		unavailable.push({ feature: 'create-repo', reason, message }, { feature: 'create-pr', reason, message });
		return { loggedIn: false, user: null, owners: [], scopes: [], unavailable };
	}

	const userResult = await runGh(['api', 'user', '--jq', '.login'], repo);
	const user = userResult.code === 0 ? userResult.stdout.trim() : '';
	const owners: string[] = user === '' ? [] : [user];

	const orgs = await runGh(['api', 'user/orgs', '--jq', '.[].login'], repo);
	if (orgs.code === 0) {
		for (const line of orgs.stdout.split('\n')) {
			const login = line.trim();
			if (login !== '' && !owners.includes(login)) owners.push(login);
		}
	}

	const scopeLine = /Token scopes:\s*(.+)/.exec(auth.stdout)?.[1] ?? '';
	const scopes = scopeLine.split(',').map((scope) => scope.trim().replace(/^'|'$/g, '')).filter((scope) => scope !== '');
	// 建仓库与建 PR 都需要 `repo`；细粒度 token 的 scope 行不含它时也按无权限处理。
	if (scopes.length > 0 && !scopes.includes('repo')) {
		const message = 'GitHub 授权缺少 repo 权限，请运行 gh auth refresh -s repo 后重试。';
		unavailable.push({ feature: 'create-repo', reason: 'missing-scope', message }, { feature: 'create-pr', reason: 'missing-scope', message });
	}

	return { loggedIn: true, user: user === '' ? null : user, owners, scopes, unavailable };
}

/**
 * 列出可作为仓库属主的账号：个人账号在前，随后是其组织。
 *
 * 组织的展示名取自 `gh api user/orgs` 的 `login`；取不到名称时退回登录名。
 *
 * @param repo - 仓库路径。
 * @returns 属主列表；未登录时为空数组。
 */
export async function ghOwners(repo: string): Promise<GhOwner[]> {
	const account = await ghAccount(repo);
	if (!account.loggedIn || account.user === null) return [];
	const owners: GhOwner[] = [{ login: account.user, isOrg: false, name: account.user }];
	for (const login of account.owners.slice(1)) owners.push({ login, isOrg: true, name: login });
	return owners;
}

/** 在 GitHub 上新建仓库并入参。 */
export interface GhCreateRepoOptions {
	/** 仓库名。 */
	readonly name: string;
	/** 属主登录名；个人账号或组织。 */
	readonly owner: string;
	/** 是否私有。 */
	readonly private: boolean;
	/** 简介；空串表示不设置。 */
	readonly description: string;
	/** 本地远程名。 */
	readonly remote: string;
}

/**
 * 用 `gh repo create` 在 GitHub 上新建仓库，并把它设为本地仓库的远程后推送。
 *
 * `--source` 指向本地仓库、`--remote` 指定远程名、`--push` 推送现有提交；`--public` /
 * `--private` 二选一。返回新建仓库的地址。
 *
 * @param repo - 本地仓库路径。
 * @param options - 见 {@link GhCreateRepoOptions}。
 * @returns 新仓库地址；失败时抛出错误文本。
 */
export async function ghCreateRepo(repo: string, options: GhCreateRepoOptions): Promise<string> {
	const slug = `${options.owner}/${options.name}`;
	const args = [
		'repo', 'create', slug,
		'--source', repo,
		'--remote', options.remote,
		'--push',
		options.private ? '--private' : '--public',
	];
	if (options.description !== '') args.push('--description', options.description);
	const result = await runGh(args, repo);
	if (result.code !== 0) throw new Error(ghError(result, 'create-repo'));
	// `gh repo create` 输出的是仓库地址；取不到时按属主与仓库名拼出。
	const url = result.stdout.trim().split('\n').filter((line) => line.trim() !== '').pop() ?? '';
	return url.startsWith('http') ? url : `https://github.com/${slug}`;
}

/** 创建 Pull Request 的入参。 */
export interface GhCreatePullRequestOptions {
	/** 源分支（当前分支）。 */
	readonly head: string;
	/** 目标分支。 */
	readonly base: string;
	/** 标题。 */
	readonly title: string;
	/** 正文。 */
	readonly body: string;
	/** 是否草稿。 */
	readonly draft: boolean;
}

/**
 * 用 `gh pr create` 创建 Pull Request。
 *
 * 非交互：标题与正文由调用方给出，`--head` 为当前分支、`--base` 为目标分支。返回 PR 地址。
 *
 * @param repo - 本地仓库路径。
 * @param options - 见 {@link GhCreatePullRequestOptions}。
 * @returns Pull Request 地址；失败时抛出错误文本。
 */
export async function ghCreatePullRequest(repo: string, options: GhCreatePullRequestOptions): Promise<string> {
	const args = [
		'pr', 'create',
		'--head', options.head,
		'--base', options.base,
		'--title', options.title,
		'--body', options.body,
	];
	if (options.draft) args.push('--draft');
	const result = await runGh(args, repo);
	if (result.code !== 0) throw new Error(ghError(result));
	return result.stdout.trim().split('\n').filter((line) => line.trim() !== '').pop() ?? '';
}

/** 仓库的默认分支。 */
export interface GhRepoInfo {
	/** 默认分支名；取不到时为 null。 */
	readonly defaultBranch: string | null;
	/** 当前分支对应的 PR 目标分支候选：默认分支与远程上的其他分支。 */
	readonly branches: readonly string[];
}

/**
 * 读取远程仓库的默认分支与分支列表，作为创建 PR 时的目标候选。
 *
 * `gh repo view` 与 `gh api repos/{owner}/{repo}/…` 都在当前仓库上下文中解析远程，
 * 因此不需要显式指名 remote。
 *
 * @param repo - 本地仓库路径。
 * @returns 默认分支与分支候选；取不到时两者为空。
 */
export async function ghRepoInfo(repo: string): Promise<GhRepoInfo> {
	const view = await runGh(['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], repo);
	const defaultBranch = view.code === 0 ? view.stdout.trim() : '';
	const branches: string[] = [];
	if (defaultBranch !== '') branches.push(defaultBranch);
	const list = await runGh(['api', 'repos/{owner}/{repo}/branches', '--jq', '.[].name'], repo);
	if (list.code === 0) {
		for (const line of list.stdout.split('\n')) {
			const name = line.trim();
			if (name !== '' && !branches.includes(name)) branches.push(name);
		}
	}
	return { defaultBranch: defaultBranch === '' ? null : defaultBranch, branches };
}
