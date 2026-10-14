/**
 * 在侧边栏终端里执行命令：新开一个终端页，等它可写后写入命令并回车。
 *
 * 克隆交给终端而不是插件自己跑：进度、凭据提示与交互都由终端承担。
 * 与宿主服务的交互按结构化类型声明，便于用替身直接测试。
 */

/** 一个已打开的页。 */
interface OpenTab {
	readonly sessionId: string;
	readonly tabId: string;
	readonly kind: string;
	readonly contentId: string;
}

/** 侧边栏中与开页相关的部分。 */
export interface SidebarRightLike {
	readonly openTabs: {
		getSnapshot(): readonly OpenTab[];
		subscribe(listener: () => void): () => void;
	};
	openTab(kind: string): void;
}

/** 终端视图与它可写状态。 */
interface TerminalViewLike {
	readonly state: {
		getSnapshot(): { readonly writable: boolean };
		subscribe(listener: () => void): () => void;
	};
	write(data: string): void;
}

/** 终端模型服务中与开视图相关的部分。 */
export interface TerminalsLike {
	view(sessionId: string, key: string, contentId: string): TerminalViewLike;
}

/** 执行所需的两个服务；任一缺失时不执行。 */
export interface RunInTerminalDeps {
	readonly sidebarRight: SidebarRightLike | undefined;
	readonly terminals: TerminalsLike | undefined;
}

/** 等待新页出现的上限（毫秒）。 */
const TAB_TIMEOUT_MS = 5000;
/** 等待终端可写的上限（毫秒）：含创建 shell 与建立输出的时间。 */
const WRITABLE_TIMEOUT_MS = 20000;

/**
 * 订阅一个观察对象直到条件成立。
 *
 * @param store - 带快照与订阅的观察对象。
 * @param ready - 条件。
 * @param timeoutMs - 超时毫秒数。
 * @returns 条件成立时为 true；超时为 false。
 */
function waitFor(store: { getSnapshot(): unknown; subscribe(listener: () => void): () => void }, ready: () => boolean, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		if (ready()) { resolve(true); return; }
		let unsubscribe = (): void => { };
		const timer = setTimeout(() => { unsubscribe(); resolve(false); }, timeoutMs);
		unsubscribe = store.subscribe(() => {
			if (!ready()) return;
			clearTimeout(timer);
			unsubscribe();
			resolve(true);
		});
	});
}

/**
 * 在侧边栏终端里执行一条命令。
 *
 * 新开一个终端页，等它的终端可写后写入命令并回车；打开页或等待失败时返回 false，
 * 由调用方提示用户手动执行。
 *
 * @param deps - 侧边栏与终端服务；未装载时直接返回 false。
 * @param sessionId - 命令所属会话。
 * @param command - 要执行的命令。
 * @returns 命令是否已写入终端。
 */
export async function runInTerminal(deps: RunInTerminalDeps, sessionId: string, command: string): Promise<boolean> {
	const { sidebarRight, terminals } = deps;
	if (sidebarRight === undefined || terminals === undefined) return false;
	const known = new Set(sidebarRight.openTabs.getSnapshot()
		.filter((tab) => tab.kind === 'terminal' && tab.sessionId === sessionId)
		.map((tab) => tab.tabId));
	try {
		sidebarRight.openTab('terminal');
	} catch {
		return false;
	}
	const opened = await waitFor(sidebarRight.openTabs, () => sidebarRight.openTabs.getSnapshot()
		.some((tab) => tab.kind === 'terminal' && tab.sessionId === sessionId && !known.has(tab.tabId)), TAB_TIMEOUT_MS);
	if (!opened) return false;
	const tab = sidebarRight.openTabs.getSnapshot()
		.find((item) => item.kind === 'terminal' && item.sessionId === sessionId && !known.has(item.tabId));
	if (tab === undefined) return false;
	const view = terminals.view(sessionId, tab.tabId, tab.contentId);
	const writable = await waitFor(view.state, () => view.state.getSnapshot().writable, WRITABLE_TIMEOUT_MS);
	if (!writable) return false;
	view.write(`${command}\r`);
	return true;
}
