/**
 * 差异页的视图选择状态：从面板设置里读，改动写回设置。
 *
 * 设置由宿主持久化（见 `panel/storage.ts` 的预取），因此刷新与换浏览器都保留。预取是异步的，
 * 而 `useState` 的初值在挂载时同步取过，预取完成后要把状态按真实值重新写入一次。
 */
import React from 'react';
import { DEFAULT_DIFF_VIEW, diffViewOf, withDiffView, type DiffViewChoice } from './diff-view.ts';
import { getSettings, primeStorage, setSettings, storageReady } from '../panel/storage.ts';
import { loadSettings } from '../panel/settings-model.ts';

/** 视图选择状态：当前选择与改写一项的方法。 */
export interface DiffViewState {
	/** 当前视图选择。 */
	readonly choice: DiffViewChoice;
	/**
	 * 改一项视图选择并写回设置。
	 *
	 * @param patch - 要改的项。
	 * @returns 无。
	 */
	readonly patch: (patch: Partial<DiffViewChoice>) => void;
}

/**
 * 按工作区取差异页的视图选择。
 *
 * @param cwd - 会话工作区路径；未知时传 null。
 * @returns 视图选择与改写方法。
 */
export function useDiffView(cwd: string | null): DiffViewState {
	const [choice, setChoice] = React.useState<DiffViewChoice>(() => diffViewOf(storageReady() ? loadSettings() : null));
	React.useEffect(() => {
		if (cwd === null) return undefined;
		const cancelled = { current: false };
		void (async () => {
			await primeStorage(cwd);
			if (cancelled.current) return;
			// 预取完成后按真实设置回填：初值是在缓存为空时取的，不会自动重算。
			setChoice(diffViewOf(loadSettings()));
		})();
		return () => { cancelled.current = true; };
	}, [cwd]);
	const patch = React.useCallback((next: Partial<DiffViewChoice>) => {
		setChoice((previous) => {
			const merged = { ...previous, ...next };
			// 设置尚未预取时只改本地状态：预取完成后会用宿主值覆盖，不做半份写入。
			if (getSettings() !== null) setSettings({ ...withDiffView(loadSettings(), merged) });
			return merged;
		});
	}, []);
	return { choice, patch };
}

export { DEFAULT_DIFF_VIEW };
