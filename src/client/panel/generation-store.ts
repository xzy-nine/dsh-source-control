/**
 * AI 生成任务登记：生成按发起时的仓库归属，结果不随当前活跃仓库漂移。
 *
 * 任务活在模块级而不是组件实例里：切换仓库、切换会话、关闭侧栏页都会让面板重新挂载或换仓库，
 * 实例级状态随之丢失，生成中的文本就会落到下一个活跃仓库的提交框里。按仓库键登记后，
 * 生成只写它自己那一份，上屏时机由调用方按「当前仓库 + 侧栏页可见」判定。
 *
 * 每份登记是一个快照 store，订阅与发布由 store 承担；登记另记订阅者数，空闲（不在生成）且
 * 无人订阅时随最后一个订阅者退订一并删除。
 *
 * 不中断生成：切换仓库只是让结果暂存，请求自然跑完。
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store';
import { normalizePath } from '../shared/path-key.ts';

/** 一份生成任务的状态。 */
export interface GenerationState {
	/** 已产出的文本。 */
	readonly text: string;
	/** 是否仍在生成。 */
	readonly busy: boolean;
	/** 告警或错误文本；无告警时为空串。 */
	readonly warning: string;
	/** 用量统计；尚未收到时为空。 */
	readonly stats: unknown;
}

/** 登记状态的可写形状：store 的草稿写在这上面。 */
type GenerationDraft = { -readonly [Key in keyof GenerationState]: GenerationState[Key] };

/** 一份登记：状态快照与订阅者数。 */
interface Entry {
	/** 该仓库的状态快照。 */
	readonly store: SnapshotStore<GenerationDraft>;
	/** 当前订阅者数；归零且空闲时删除这份登记。 */
	subscribers: number;
}

const EMPTY: GenerationState = { text: '', busy: false, warning: '', stats: null };

/** 按仓库键登记的任务。 */
const entries = new Map<string, Entry>();

/**
 * 取一个仓库键的登记，没有时创建。
 *
 * @param key - 归一化后的仓库键。
 * @returns 该仓库的登记。
 */
function entryOf(key: string): Entry {
	let entry = entries.get(key);
	if (entry === undefined) {
		entry = { store: createSnapshotStore<GenerationDraft>(EMPTY), subscribers: 0 };
		entries.set(key, entry);
	}
	return entry;
}

/**
 * 取一个仓库键的生成状态。
 *
 * @param repo - 仓库路径；null 时返回空状态。
 * @returns 该仓库当前的生成状态。
 */
export function generationStateOf(repo: string | null): GenerationState {
	if (repo === null) return EMPTY;
	return entries.get(normalizePath(repo))?.store.getSnapshot() ?? EMPTY;
}

/**
 * 订阅某个仓库的生成状态变化。
 *
 * @param repo - 仓库路径。
 * @param listener - 状态变化时调用。
 * @returns 取消订阅。
 */
export function subscribeGeneration(repo: string, listener: () => void): () => void {
	const key = normalizePath(repo);
	const entry = entryOf(key);
	entry.subscribers += 1;
	const unsubscribe = entry.store.subscribe(listener);
	/** 取消订阅只结算一次：重复调用不再扣减订阅者数。 */
	let released = false;
	return () => {
		if (released) return;
		released = true;
		unsubscribe();
		entry.subscribers -= 1;
		// 已结束且无人订阅：删掉，避免按仓库无限累积。
		if (entry.subscribers === 0 && !entry.store.getSnapshot().busy && entries.get(key) === entry) entries.delete(key);
	};
}

/**
 * 写一份登记的状态。
 *
 * @param repo - 仓库路径。
 * @param mutate - 在草稿上写入要改的字段。
 * @returns 无。
 */
function patch(repo: string, mutate: (draft: GenerationDraft) => void): void {
	entryOf(normalizePath(repo)).store.update(mutate);
}

/**
 * 开始一次生成：清空文本与告警，置为进行中。
 *
 * @param repo - 发起生成的仓库路径。
 * @returns 无。
 */
export function beginGeneration(repo: string): void {
	patch(repo, (draft) => {
		draft.text = '';
		draft.busy = true;
		draft.warning = '';
		draft.stats = null;
	});
}

/**
 * 追加一段生成文本。
 *
 * @param repo - 发起生成的仓库路径。
 * @param chunk - 新文本。
 * @returns 无。
 */
export function appendGeneration(repo: string, chunk: string): void {
	patch(repo, (draft) => { draft.text += chunk; });
}

/**
 * 记一条生成告警。
 *
 * @param repo - 发起生成的仓库路径。
 * @param warning - 告警文本。
 * @returns 无。
 */
export function warnGeneration(repo: string, warning: string): void {
	patch(repo, (draft) => { draft.warning = warning; });
}

/**
 * 记一次用量统计。
 *
 * @param repo - 发起生成的仓库路径。
 * @param stats - 统计载荷。
 * @returns 无。
 */
export function noteGenerationStats(repo: string, stats: unknown): void {
	patch(repo, (draft) => { draft.stats = stats; });
}

/**
 * 结束一次生成：置为不忙，保留已产出的文本供上屏。
 *
 * @param repo - 发起生成的仓库路径。
 * @returns 无。
 */
export function endGeneration(repo: string): void {
	patch(repo, (draft) => { draft.busy = false; });
}

/**
 * 取走并清空一份已完成的文本。
 *
 * 上屏用它：文本只交付一次，避免同一段结果被重复写进提交框。进行中的任务不交付。
 *
 * @param repo - 仓库路径。
 * @returns 已完成且非空的文本；无内容或仍在生成时为 null。
 */
export function takeGenerationText(repo: string): string | null {
	const current = generationStateOf(repo);
	if (current.busy || current.text === '') return null;
	patch(repo, (draft) => {
		draft.text = '';
		draft.warning = '';
	});
	return current.text;
}

/**
 * 清掉一个仓库的生成状态。
 *
 * @param repo - 仓库路径。
 * @returns 无。
 */
export function clearGeneration(repo: string): void {
	const key = normalizePath(repo);
	const entry = entries.get(key);
	if (entry === undefined) return;
	entries.delete(key);
	// 订阅者仍挂在这份快照上：发布一份空状态，让它们看到清空。
	entry.store.set({ ...EMPTY });
}

/**
 * 测试用：清空全部登记。
 *
 * @returns 无。
 */
export function resetGenerationsForTests(): void {
	entries.clear();
}
