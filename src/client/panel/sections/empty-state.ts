/**
 * 分区空态：工作区里没有仓库，或选中的节点尚未检出。
 *
 * 两个分区共用同一块内容：这种情况下没有可读的仓库数据，提交框、变更列表与提交图都不显示，
 * 由这里说明原因并给出唯一的下一步动作。
 */
import React from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import css from '../../css/sections.module.css';
import { cx } from '../../css/cx.ts';

/** 空态的内容。 */
export interface WorkspaceEmptyState {
	/** 一句话结论。 */
	readonly title: string;
	/** 说明当前为何读不到仓库数据。 */
	readonly description: string;
	/** 主按钮文案；为 null 时不显示按钮。 */
	readonly action: string | null;
}

/** 空态的属性。 */
export interface WorkspaceEmptyProps {
	readonly empty: WorkspaceEmptyState;
	/** 动作进行中：只禁用按钮。 */
	readonly busy: boolean;
	readonly onAction: () => void;
	/** 撑满父容器剩余高度；图形区按自身高度定尺寸时应为 false。 */
	readonly fill: boolean;
	/** 显式高度；给出时覆盖填充行为。 */
	readonly style?: React.CSSProperties;
}

/**
 * 渲染一块分区空态。
 *
 * @param props - 见 {@link WorkspaceEmptyProps}。
 * @returns 空态元素。
 */
export function WorkspaceEmpty({ empty, busy, onAction, fill, style }: WorkspaceEmptyProps): React.ReactElement {
	return React.createElement(
		'div',
		{ className: cx(css.workspaceEmpty, fill && css.isFill), style },
		React.createElement('div', { className: css.workspaceEmptyTitle }, empty.title),
		React.createElement('div', { className: css.workspaceEmptyText }, empty.description),
		empty.action !== null && React.createElement(Button, {
			variant: 'primary', size: 'sm', disabled: busy, onClick: onAction,
		}, empty.action),
	);
}
