/**
 * 面板的布局状态：分区展开态、分区高度、拖拽手柄，以及「上次刷新」文案的时钟。
 *
 * 这几项只服务界面布局，与仓库数据无关；展开态与高度跨会话持久化。
 */
import React from 'react';
import { loadValue, saveValue } from './storage.ts';
import { useResizeHandler } from './use-resize.ts';

/** 图形区高度的取值区间（像素）。 */
const GRAPH_HEIGHT_MIN = 120;
const GRAPH_HEIGHT_MAX = 720;
const GRAPH_HEIGHT_DEFAULT = 320;

/** 存储库区高度的取值区间（像素）。 */
const REPO_HEIGHT_MIN = 80;
const REPO_HEIGHT_MAX = 600;
const REPO_HEIGHT_DEFAULT = 200;

/** 布局持久化用的键。 */
const REPO_OPEN_KEY = 'dsh-source-control-repo-open';
const GRAPH_OPEN_KEY = 'dsh-source-control-graph-open';
const GRAPH_HEIGHT_KEY = 'dsh-source-control-graph-height';
const REPO_HEIGHT_KEY = 'dsh-source-control-repo-height';

/** 布局状态与操作。 */
export interface PanelLayout {
	/** 存储库区是否展开。 */
	readonly repoSecOpen: boolean;
	/** 图形区是否展开。 */
	readonly graphSecOpen: boolean;
	/** 图形区高度（像素）。 */
	readonly graphHeight: number;
	/** 存储库区高度（像素）。 */
	readonly repoHeight: number;
	/** 切换存储库区展开态。 */
	readonly toggleRepoSec: () => void;
	/** 切换图形区展开态。 */
	readonly toggleGraphSec: () => void;
	/** 拖拽图形区上沿的手柄。 */
	readonly startGraphResize: (event: React.PointerEvent<HTMLDivElement>) => void;
	/** 拖拽存储库区下沿的手柄。 */
	readonly startRepoResize: (event: React.PointerEvent<HTMLDivElement>) => void;
	/** 按持久化值回填布局；宿主预取完成后调用。 */
	readonly reload: () => void;
}

/**
 * 读取并维护面板布局。
 *
 * @returns 布局状态与操作。
 */
export function usePanelLayout(): PanelLayout {
	const [repoSecOpen, setRepoSecOpen] = React.useState<boolean>(() => loadValue(REPO_OPEN_KEY, true));
	const [graphSecOpen, setGraphSecOpen] = React.useState<boolean>(() => loadValue(GRAPH_OPEN_KEY, true));
	const [graphHeight, setGraphHeight] = React.useState<number>(() => loadValue(GRAPH_HEIGHT_KEY, GRAPH_HEIGHT_DEFAULT));
	const [repoHeight, setRepoHeight] = React.useState<number>(() => loadValue(REPO_HEIGHT_KEY, REPO_HEIGHT_DEFAULT));

	const toggleRepoSec = React.useCallback(() => {
		setRepoSecOpen((previous) => { const next = !previous; saveValue(REPO_OPEN_KEY, next); return next; });
	}, []);
	const toggleGraphSec = React.useCallback(() => {
		setGraphSecOpen((previous) => { const next = !previous; saveValue(GRAPH_OPEN_KEY, next); return next; });
	}, []);
	const commitGraphHeight = React.useCallback((value: number) => {
		const clamped = Math.max(GRAPH_HEIGHT_MIN, Math.min(value, GRAPH_HEIGHT_MAX));
		setGraphHeight(clamped);
		saveValue(GRAPH_HEIGHT_KEY, clamped);
	}, []);
	const commitRepoHeight = React.useCallback((value: number) => {
		const clamped = Math.max(REPO_HEIGHT_MIN, Math.min(value, REPO_HEIGHT_MAX));
		setRepoHeight(clamped);
		saveValue(REPO_HEIGHT_KEY, clamped);
	}, []);
	// 拖拽图形区上沿（工作区与图形的分界线）：向上拖＝图形变高。
	const startGraphResize = useResizeHandler(graphHeight, 'up', commitGraphHeight);
	// 拖拽存储库区下沿（存储库与更改的分界线）：向下拖＝存储库变高。
	const startRepoResize = useResizeHandler(repoHeight, 'down', commitRepoHeight);

	const reload = React.useCallback(() => {
		setRepoSecOpen(loadValue(REPO_OPEN_KEY, true));
		setGraphSecOpen(loadValue(GRAPH_OPEN_KEY, true));
		setGraphHeight(loadValue(GRAPH_HEIGHT_KEY, GRAPH_HEIGHT_DEFAULT));
		setRepoHeight(loadValue(REPO_HEIGHT_KEY, REPO_HEIGHT_DEFAULT));
	}, []);

	return {
		repoSecOpen, graphSecOpen, graphHeight, repoHeight,
		toggleRepoSec, toggleGraphSec, startGraphResize, startRepoResize, reload,
	};
}

/**
 * 「上次刷新」文案的时钟。
 *
 * 按固定间隔推进，让相对时间从「刚刚」变成「n 分钟前」。只在面板可见时跑——不可见时无人看，
 * 推进只会触发无意义的重渲染。页签重新可见时立即推进一次，切回时文案不必等到下一个周期才更新。
 *
 * @returns 当前时刻（毫秒）。
 */
export function useRefreshClock(): number {
	const [refreshClock, setRefreshClock] = React.useState<number>(() => Date.now());
	React.useEffect(() => {
		let timer: number | undefined;
		/** 开始推进；已在推进时保持原定时器。 */
		const start = (): void => {
			if (timer !== undefined) return;
			timer = window.setInterval(() => { setRefreshClock(Date.now()); }, 30_000);
		};
		/** 停止推进。 */
		const stop = (): void => {
			if (timer === undefined) return;
			window.clearInterval(timer);
			timer = undefined;
		};
		/** 按当前可见性启停。 */
		const sync = (): void => {
			if (document.visibilityState !== 'visible') { stop(); return; }
			setRefreshClock(Date.now());
			start();
		};
		sync();
		document.addEventListener('visibilitychange', sync);
		return () => {
			document.removeEventListener('visibilitychange', sync);
			stop();
		};
	}, []);
	return refreshClock;
}
