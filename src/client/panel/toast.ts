/**
 * 轻量提示：顶部的自动淡出横幅，用于「某动作无法进行」这类一次性告知。
 *
 * 与 `dialog.ts` 的模态弹窗相对：模态需要用户关闭，适合确认与输入；提示不打断操作、
 * 不占焦点，适合告知结果。同一时刻只显示一条，新提示替换上一条。
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives';

/** 当前显示的提示；新提示到来时先卸载它。 */
let current: { root: ReturnType<typeof createRoot>; container: HTMLElement } | null = null;

/** 提示选项。 */
export interface ToastOptions {
	/** 完全显示后开始淡出前的停留毫秒数；省略时按文本长度推算。 */
	readonly holdMs?: number;
}

/**
 * 按文本长度推算停留时长。
 *
 * 一行内的短句用默认窗口即可；失败原因常带多行 git 输出，需要更长的阅读时间。
 *
 * @param text - 提示文本。
 * @returns 停留毫秒数。
 */
function holdFor(text: string): number {
	return Math.min(3000 + text.length * 40, 12000);
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
	// 先卸载上一条，避免两条横幅重叠在同一位置。
	if (current !== null) {
		current.root.unmount();
		current.container.remove();
		current = null;
	}
	const container = document.createElement('div');
	document.body.appendChild(container);
	const root = createRoot(container);
	const handle = { root, container };
	current = handle;
	const done = (): void => {
		if (current === handle) current = null;
		root.unmount();
		container.remove();
	};
	root.render(React.createElement(Toast, {
		text,
		icon: React.createElement(IconWarningOutlineRegular),
		holdMs: options.holdMs ?? holdFor(text),
		onDone: done,
	}));
}
