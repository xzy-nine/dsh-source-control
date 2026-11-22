/**
 * 分区标题栏的刷新按钮：更改区与图形区共用。
 */
import React from 'react';
import { IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import { iconButton } from './icon-button.ts';

/**
 * 分区标题栏的刷新按钮。
 *
 * 刷新进行中时图标带 `data-refreshing` 属性，由样式给出呼吸效果；此时仍可点击——并发刷新
 * 由调用方的代数判据收敛，禁用反而会让用户以为界面卡住。
 *
 * @param disabled - 是否禁用。
 * @param refreshing - 是否正在后台刷新。
 * @param lastRefresh - 「上次刷新」文案；为空时不给。
 * @param onRefresh - 点击回调。
 * @returns 按钮元素。
 */
export function refreshButton(disabled: boolean, refreshing: boolean, lastRefresh: string, onRefresh: () => void): React.ReactElement {
	const title = lastRefresh === '' ? '刷新' : '刷新（上次刷新：' + lastRefresh + '）';
	return iconButton({
		title,
		disabled,
		onClick: onRefresh,
		extra: { 'data-refreshing': refreshing ? '1' : undefined },
		children: React.createElement(IconRefreshOutlineRegular, { size: 14 }),
	});
}