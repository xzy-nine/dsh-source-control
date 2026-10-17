/**
 * 分区高度的拖拽调整。
 *
 * 两个分区（图形区与存储库区）的分界线拖拽逻辑相同，只有拖拽方向与写入回调不同：
 * 图形区的分界线在其上沿，向上拖变大；存储库区的分界线在其下沿，向下拖变大。
 */
import React from 'react';
import shared from '../css/shared.module.css';

/** 拖拽方向：`up` 表示向上拖变大，`down` 表示向下拖变大。 */
export type ResizeDirection = 'up' | 'down';

/**
 * 建立一个分界线的拖拽处理器。
 *
 * @param current - 当前高度。
 * @param direction - 拖拽方向。
 * @param commit - 写入新高度的回调；已按上下限夹取。
 * @returns 分界线的 pointerdown 处理器。
 */
export function useResizeHandler(
	current: number,
	direction: ResizeDirection,
	commit: (value: number) => void,
): (event: React.PointerEvent<HTMLDivElement>) => void {
	return React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
		event.preventDefault();
		const startY = event.clientY;
		const startHeight = current;
		const handle = event.currentTarget;
		handle.classList.add(shared.isDragging);
		const onMove = (moveEvent: PointerEvent): void => {
			const delta = moveEvent.clientY - startY;
			commit(startHeight + (direction === 'up' ? -delta : delta));
		};
		const onUp = (): void => {
			handle.classList.remove(shared.isDragging);
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
		};
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
	}, [current, direction, commit]);
}
