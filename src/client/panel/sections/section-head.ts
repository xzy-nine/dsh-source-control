/**
 * 分区标题栏：折叠箭头、标题、后台刷新指示与「上次刷新」文案，三个分区共用。
 */
import React from 'react';
import { IconChevronDownOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives';
import css from '../../css/sections.module.css';
import { cx } from '../../css/cx.ts';

/** 分区标题栏的属性。 */
export interface SectionHeadProps {
	/** 分区标题。 */
	readonly title: string;
	/** 分区当前是否展开。 */
	readonly open: boolean;
	/** 点击标题栏；省略时标题栏不可点击。 */
	readonly onToggle?: (() => void) | undefined;
	/** 工作区快照是否正在后台刷新；省略时不显示刷新指示。 */
	readonly refreshing?: boolean | undefined;
	/** 「上次刷新」文案；空串时不显示。 */
	readonly lastRefresh?: string | undefined;
	/** 标题栏右侧的动作区；省略时不渲染。 */
	readonly actions?: React.ReactNode;
	/** 标题与折叠箭头之间的附加节点。 */
	readonly before?: React.ReactNode;
}

/**
 * 分区标题栏。
 *
 * @param props - 见 {@link SectionHeadProps}。
 * @returns 标题栏元素。
 */
export function SectionHead({ title, open, onToggle, refreshing, lastRefresh, actions, before }: SectionHeadProps): React.ReactElement {
	return React.createElement('div', {
		className: cx(css.secHead, onToggle !== undefined && !open && css.collapsed),
		onClick: onToggle,
	},
		React.createElement(IconChevronDownOutlineRegular, { size: 14, className: css.chevron }),
		title,
		before,
		refreshing !== undefined && React.createElement(StateDot, { state: refreshing ? 'ongoing' : 'idle', size: 8, className: css.headDot }),
		lastRefresh !== undefined && lastRefresh !== '' && React.createElement('span', { className: css.headRefreshNote }, lastRefresh),
		actions !== undefined && React.createElement('span', { className: css.headActions }, actions),
	);
}
