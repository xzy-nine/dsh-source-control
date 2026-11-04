/**
 * 轻量提示：顶部的自动淡出横幅，用于已完成的动作结果与后台刷新的计数变化。
 *
 * 与 `dialog.ts` 的模态弹窗相对：模态需要用户关闭并承载可复制的正文；提示不打断操作、
 * 不占焦点，适合读完即弃的一句话结果。同一时刻只显示一条，新的一条替换旧的。
 */
import React from 'react';
import { IconInfoOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives';
import { pushToast, removeToast } from '../ui/overlay-host.ts';

/** 提示类别：成功结果用 `success`，其余中性告知用 `info`。 */
export type ToastTone = 'success' | 'info';

/** 提示选项。 */
export interface ToastOptions {
	/** 提示类别，省略为 `info`。 */
	readonly tone?: ToastTone;
}

/** 停留时长的基数、每字增量与上限（毫秒）：阅读量随文本长度增加，长句不在一句话内消失。 */
const HOLD_BASE_MS = 3_000;
const HOLD_PER_CHAR_MS = 40;
const HOLD_CAP_MS = 8_000;

/**
 * 推算停留时长。
 *
 * @param text - 提示文本。
 * @returns 停留毫秒数。
 */
function holdFor(text: string): number {
	return Math.min(HOLD_BASE_MS + text.length * HOLD_PER_CHAR_MS, HOLD_CAP_MS);
}

/**
 * 显示一条轻量提示。
 *
 * @param text - 提示文本；空串不显示。
 * @param options - 见 {@link ToastOptions}。
 * @returns 无。
 */
export function showToast(text: string, options: ToastOptions = {}): void {
	if (text === '') return;
	const tone = options.tone ?? 'info';
	pushToast((id) => React.createElement(Toast, {
		text,
		// 成功态自带上色的对勾；中性提示用普通信息图标。
		tone: tone === 'success' ? 'success' : undefined,
		icon: tone === 'success' ? undefined : React.createElement(IconInfoOutlineRegular),
		holdMs: holdFor(text),
		onDone: () => { removeToast(id); },
	}));
}
