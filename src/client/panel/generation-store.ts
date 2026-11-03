/**
 * AI 生成任务登记：生成按发起时的仓库归属，结果不随当前活跃仓库漂移。
 *
 * 任务活在模块级而不是组件实例里：切换仓库、切换会话、关闭侧栏页都会让面板重新挂载或换仓库，
 * 实例级状态随之丢失，生成中的文本就会落到下一个活跃仓库的提交框里。按仓库键登记后，
 * 生成只写它自己那一份，上屏时机由调用方按「当前仓库 + 侧栏页可见」判定。
 *
 * 不中断生成：切换仓库只是让结果暂存，请求自然跑完。
 */
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

/** 一份登记：状态与变更通知。 */
interface Entry extends GenerationState {
	/** 订阅者。 */
	readonly listeners: Set<() => void>;
}

const EMPTY: GenerationState = { text: '', busy: false, warning: '', stats: null };

/** 按仓库键登记的任务。 */
const entries = new Map<string, Entry>();

/**
 * 取一个仓库键的生成状态。
 *
 * @param repo - 仓库路径；null 时返回空状态。
 * @returns 该仓库当前的生成状态。
 */
export function generationStateOf(repo: string | null): GenerationState {
	if (repo === null) return EMPTY;
	return entries.get(normalizePath(repo)) ?? EMPTY;
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
	let entry = entries.get(key);
	if (entry === undefined) {
		entry = { ...EMPTY, listeners: new Set() };
		entries.set(key, entry);
	}
	entry.listeners.add(listener);
	return () => {
		const current = entries.get(key);
		if (current === undefined) return;
		current.listeners.delete(listener);
		// 已结束且无人订阅：删掉，避免按仓库无限累积。
		if (current.listeners.size === 0 && !current.busy) entries.delete(key);
	};
}

/**
 * 就地更新一份登记并通知订阅者。
 *
 * @param repo - 仓库路径。
 * @param patch - 要改的字段。
 * @returns 无。
 */
function patch(repo: string, patchOf: Partial<GenerationState>): void {
	const key = normalizePath(repo);
	const current = entries.get(key);
	const next: Entry = { ...(current ?? { ...EMPTY, listeners: new Set() }), ...patchOf, listeners: current?.listeners ?? new Set() };
	entries.set(key, next);
	for (const listener of [...next.listeners]) listener();
}

/**
 * 开始一次生成：清空文本与告警，置为进行中。
 *
 * @param repo - 发起生成的仓库路径。
 * @returns 无。
 */
export function beginGeneration(repo: string): void {
	patch(repo, { text: '', busy: true, warning: '', stats: null });
}

/**
 * 追加一段生成文本。
 *
 * @param repo - 发起生成的仓库路径。
 * @param chunk - 新文本。
 * @returns 无。
 */
export function appendGeneration(repo: string, chunk: string): void {
	const current = generationStateOf(repo);
	patch(repo, { text: current.text + chunk });
}

/**
 * 记一条生成告警。
 *
 * @param repo - 发起生成的仓库路径。
 * @param warning - 告警文本。
 * @returns 无。
 */
export function warnGeneration(repo: string, warning: string): void {
	patch(repo, { warning });
}

/**
 * 记一次用量统计。
 *
 * @param repo - 发起生成的仓库路径。
 * @param stats - 统计载荷。
 * @returns 无。
 */
export function noteGenerationStats(repo: string, stats: unknown): void {
	patch(repo, { stats });
}

/**
 * 结束一次生成：置为不忙，保留已产出的文本供上屏。
 *
 * @param repo - 发起生成的仓库路径。
 * @returns 无。
 */
export function endGeneration(repo: string): void {
	patch(repo, { busy: false });
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
	patch(repo, { text: '', warning: '' });
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
	const current = entries.get(key);
	entries.delete(key);
	if (current !== undefined) for (const listener of [...current.listeners]) listener();
}

/**
 * 测试用：清空全部登记。
 *
 * @returns 无。
 */
export function resetGenerationsForTests(): void {
	entries.clear();
}
