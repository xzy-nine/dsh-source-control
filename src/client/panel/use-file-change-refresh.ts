/**
 * 事件驱动的自动刷新：订阅当前会话的事件窗口，工具写入/编辑落地且目标在仓库内时重载面板。
 *
 * 连续变更受冷却时间节流；面板正忙时挂起到空闲再执行，避免与用户操作抢同一份数据。
 * 定时轮询不在此处：刷新完全由事件触发。
 */
import React from 'react';
import { AUTO_REFRESH_COOLDOWN_MS, hasRepositoryChange, settledFileChanges, type SessionEventLike } from './change-events.ts';
import { isRepoBusy } from './busy.ts';
import type { BusyEntry } from '../types.ts';

/** 事件窗口保留的事件数：一次写入的结果可能晚于调用到达。 */
const EVENT_WINDOW = 400;

/** 面板正忙时的复核间隔（毫秒）。 */
const BUSY_RETRY_MS = 1000;

/** 一条会话事件条目。 */
interface EventEntryLike {
	readonly type?: string;
	readonly event?: SessionEventLike;
}

/** 事件窗口快照。 */
interface EventWindowLike {
	readonly entries?: readonly EventEntryLike[];
	readonly change?: { readonly kind?: string; readonly entries?: readonly EventEntryLike[] };
}

/** 会话事件源。 */
interface EventSourceLike {
	getSnapshot(): EventWindowLike;
	subscribe(listener: () => void): () => void;
}

/** 会话绑定中与事件源有关的部分。 */
interface SessionBindingLike {
	readonly eventSource: EventSourceLike;
}

/** 会话服务中与绑定有关的部分。 */
export interface SessionsLike {
	binding(id: string): SessionBindingLike | undefined;
}

/** 事件驱动刷新的入参。 */
export interface UseFileChangeRefreshOptions {
	/** 会话服务；未装载时为 null，此时不订阅。 */
	readonly sessions: SessionsLike | null;
	/** 当前会话 id。 */
	readonly sessionId: string;
	/** 当前工作树路径；未选中时为 null。 */
	readonly workingTreePath: string | null;
	/** 会话工作区路径，用于解析模型给出的相对路径。 */
	readonly cwd: string | null;
	/** 是否启用；关闭时不订阅。 */
	readonly enabled: boolean;
	/** 进行中的操作记录；目标仓库忙时挂起刷新。 */
	readonly busyRef: React.MutableRefObject<readonly BusyEntry[]>;
	/** 重载选中仓库的提交图与工作区。 */
	readonly refresh: () => Promise<void>;
}

/**
 * 订阅会话事件并按落地的写入/编辑重载面板。
 *
 * @param options - 见 {@link UseFileChangeRefreshOptions}。
 * @returns 无。
 */
export function useFileChangeRefresh({
	sessions, sessionId, workingTreePath, cwd, enabled, busyRef, refresh,
}: UseFileChangeRefreshOptions): void {
	// refresh 每次渲染都是新函数（依赖 settings 等），因此经 ref 读取，订阅本身只随仓库与开关重建。
	const refreshRef = React.useRef(refresh);
	refreshRef.current = refresh;
	const targetRef = React.useRef({ path: workingTreePath, cwd });
	targetRef.current = { path: workingTreePath, cwd };

	React.useEffect(() => {
		if (!enabled || sessions === null || workingTreePath === null || sessionId === '') return undefined;
		const binding = sessions.binding(sessionId);
		if (binding === undefined) return undefined;
		const source = binding.eventSource;
		let primed = false;
		let disposed = false;
		let lastRefreshAt = 0;
		let timer: number | null = null;
		const seen = new Set<string>();
		let events: SessionEventLike[] = [];

		/** 重载一次；面板忙时挂起到空闲。 */
		const runRefresh = (): void => {
			if (disposed) return;
			if (isRepoBusy(busyRef.current, targetRef.current.path)) {
				if (timer === null) timer = window.setTimeout(() => { timer = null; runRefresh(); }, BUSY_RETRY_MS);
				return;
			}
			lastRefreshAt = Date.now();
			void refreshRef.current().catch(() => { /* 重载失败由面板自身提示 */ });
		};

		/** 冷却满后再重载；冷却未满时挂起一次收尾。 */
		const scheduleRefresh = (): void => {
			const wait = AUTO_REFRESH_COOLDOWN_MS - (Date.now() - lastRefreshAt);
			if (wait > 0) {
				if (timer === null) timer = window.setTimeout(() => { timer = null; runRefresh(); }, wait);
				return;
			}
			runRefresh();
		};

		/** 处理一批新到达的事件。 */
		const consume = (incoming: readonly SessionEventLike[]): void => {
			if (incoming.length === 0) return;
			events = events.concat(incoming);
			if (events.length > EVENT_WINDOW) events = events.slice(events.length - EVENT_WINDOW);
			const target = targetRef.current;
			if (target.path === null) return;
			const settled = settledFileChanges(events);
			const fresh = settled.filter((change) => !seen.has(change.callId));
			// 已滚出窗口的调用不会再结算，其标记随之丢弃，集合不会随会话增长。
			const present = new Set(settled.map((change) => change.callId));
			for (const callId of seen) {
				if (!present.has(callId)) seen.delete(callId);
			}
			if (fresh.length === 0) return;
			for (const change of fresh) seen.add(change.callId);
			if (!hasRepositoryChange(fresh, target.path, target.cwd)) return;
			scheduleRefresh();
		};

		/** 取事件窗口里的持久事件。 */
		const durableOf = (entries: readonly EventEntryLike[] | undefined): SessionEventLike[] => {
			const out: SessionEventLike[] = [];
			for (const entry of entries ?? []) {
				if (entry.type === 'event' && entry.event !== undefined) out.push(entry.event);
			}
			return out;
		};

		const onEvent = (): void => {
			const snapshot = source.getSnapshot();
			const change = snapshot.change;
			// 首次通知只建立基线：订阅之前的历史写入不该触发重载。
			if (!primed) { primed = true; return; }
			if (change === undefined || change.kind !== 'append') return;
			consume(durableOf(change.entries));
		};

		const unsubscribe = source.subscribe(onEvent);
		return () => {
			disposed = true;
			if (timer !== null) window.clearTimeout(timer);
			unsubscribe();
		};
	}, [sessions, sessionId, workingTreePath, enabled, busyRef]);
}
