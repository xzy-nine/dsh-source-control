/**
 * 分区标题栏与行内的图标按钮：点击不冒泡到所在行也不会被行级手势抢走。
 *
 * 面板里的按钮形态一致：`<button type="button">` 加一个图标，点击不冒泡到所在行。
 * 行与分组本身也带点击与右键手势，不阻止冒泡会让一次点击同时触发按钮与行的动作。
 */
import React from 'react';
import css from '../../css/sections.module.css';

/**
 * 阻止冒泡后执行。
 *
 * @param act - 点击后执行的动作。
 * @returns 点击处理函数。
 */
export function stopThen(act: () => void): (event: React.MouseEvent<HTMLElement>) => void {
	return (event) => {
		event.stopPropagation();
		act();
	};
}

/** 一个图标按钮的属性。 */
export interface IconButtonProps {
	/** 无可见文案时的说明与悬停提示。 */
	readonly title: string;
	/** 是否禁用。 */
	readonly disabled?: boolean;
	/** 点击回调。 */
	readonly onClick: () => void;
	/** 按钮内容，通常是图标。 */
	readonly children: React.ReactNode;
	/** 附加的数据属性。 */
	readonly extra?: Record<string, string | undefined>;
}

/**
 * 分区标题栏与行内的图标按钮。
 *
 * @param props - 见 {@link IconButtonProps}。
 * @returns 按钮元素。
 */
export function iconButton({ title, disabled = false, onClick, children, extra }: IconButtonProps): React.ReactElement {
	return React.createElement('button', {
		type: 'button',
		className: css.iconBtn,
		title,
		'aria-label': title,
		disabled,
		...extra,
		onClick: stopThen(onClick),
	}, children);
}
