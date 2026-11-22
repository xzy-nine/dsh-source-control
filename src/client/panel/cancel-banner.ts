/**
 * 可停止操作的停止入口。
 *
 * 只覆盖插件自己的面板范围：非阻塞操作在更改区顶上一行，阻塞操作用插件自己的覆盖层弹窗，
 * 二者都不触及 DSH 本体的界面与交互。
 */
import React from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { primaryButton, showConfirmation } from '../ui/dialog.ts';
import { cancellableEntriesOf } from './busy.ts';
import type { CancellableEntry } from './busy.ts';
import type { BusyEntry } from '../shared/types.ts';
import css from '../css/dialog.module.css';

/** 停止入口的属性。 */
export interface CancelBannerProps {
	/** 当前仓库的忙碌记录。 */
	readonly busy: readonly BusyEntry[];
	/** 停止一次操作。 */
	readonly onCancel: (cancelKey: string) => void;
	/**
	 * 需要额外用行内形式呈现的停止键。
	 *
	 * 阻塞型操作收起弹窗后归到这里：它仍然在跑，不能再让它没有任何可见的停止入口。
	 */
	readonly extraRowKeys?: readonly string[];
}

/**
 * 确认后停止一次操作。
 *
 * @param entry - 待停止的可停止项。
 * @param onCancel - 停止回调。
 * @returns 无。
 */
async function confirmCancel(entry: CancellableEntry, onCancel: (cancelKey: string) => void): Promise<void> {
	const ok = await showConfirmation({
		title: '停止操作',
		message: `要停止「${entry.label}」吗？\n\n该操作起的 git 进程会被终止，已经取回的数据保留，未完成的部分需要重新执行。`,
		confirmLabel: '停止', cancelLabel: '继续等待', danger: true,
	});
	if (ok) onCancel(entry.cancelKey);
}

/**
 * 非阻塞操作的一行停止入口。
 *
 * @param props - 见 {@link CancelBannerProps}。
 * @returns 行元素；没有可停止的非阻塞操作时返回 null。
 */
export function CancelRow({ busy, onCancel, extraRowKeys = [] }: CancelBannerProps): React.ReactElement | null {
	const rows = cancellableEntriesOf(busy).filter((entry) => entry.surface === 'row' || extraRowKeys.includes(entry.cancelKey));
	if (rows.length === 0) return null;
	return React.createElement(
		React.Fragment,
		null,
		...rows.map((entry) => React.createElement(
			'div',
			{ key: entry.cancelKey, className: css.cancelRow },
			React.createElement('span', { className: css.cancelRowText }, `${entry.label} 进行中…`),
			React.createElement(Button, {
				variant: 'ghost', size: 'sm', onClick: () => { void confirmCancel(entry, onCancel); },
			}, '停止'),
		)),
	);
}

/** 阻塞操作停止弹窗的属性。 */
export interface CancelDialogProps extends CancelBannerProps {
	/** 关闭弹窗。 */
	readonly onClose: () => void;
}

/**
 * 阻塞操作的停止弹窗。
 *
 * 只在操作本身挡住其他功能时出现，说明界面为何暂时不可用，并给出停止入口。
 *
 * @param props - 见 {@link CancelDialogProps}。
 * @returns 弹窗元素；没有可停止的阻塞操作时返回 null。
 */
export function CancelDialog({ busy, onCancel, onClose }: CancelDialogProps): React.ReactElement | null {
	const entry = cancellableEntriesOf(busy).find((item) => item.surface === 'dialog');
	if (entry === undefined) return null;
	return React.createElement(
		'dialog',
		{ className: css.cancelDialog, open: true },
		React.createElement('div', { className: css.dialogTitle }, '正在执行'),
		React.createElement('div', { className: css.dialogHint }, `${entry.label} 需要一段时间，期间面板的部分功能不可用。`),
		primaryButton({ label: '停止', onClick: () => { void confirmCancel(entry, onCancel).then(onClose); } }),
		React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: onClose }, '继续等待'),
	);
}
