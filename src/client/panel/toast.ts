/**
 * 轻量提示：顶部的自动淡出横幅，用于「某动作无法进行」这类一次性告知。
 *
 * 与 `dialog.ts` 的模态弹窗相对：模态需要用户关闭，适合确认与输入；提示不打断操作、
 * 不占焦点，适合告知结果。同一时刻只显示一条，同类提示新的一替换旧的；错误类提示不被信息类
 * 替换——后台刷新的结果告知可以错过，操作失败的文本只有这一次。
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { IconInfoOutlineRegular, IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives';

/** 提示类别：错误类用告警图标，信息类用普通图标。 */
export type ToastTone = 'error' | 'info';

/** 提示选项。 */
export interface ToastOptions {
	/** 完全显示后开始淡出前的停留毫秒数；省略时按类别与文本长度推算。 */
	readonly holdMs?: number;
	/** 提示类别，省略为 `error`。 */
	readonly tone?: ToastTone;
}

/** 当前显示的提示；新提示到来时先卸载它。 */
let current: { root: ReturnType<typeof createRoot>; container: HTMLElement; tone: ToastTone } | null = null;

/** 各类别的停留时长参数（毫秒）：基数、每字增量与上限。 */
const HOLD_OF: Record<ToastTone, { readonly base: number; readonly perChar: number; readonly cap: number }> = {
	// 失败原因常带多行 git 输出，需要读完；信息类只是计数变化，短一些。
	error: { base: 8_000, perChar: 40, cap: 20_000 },
	info: { base: 3_000, perChar: 40, cap: 8_000 },
};

/**
 * 推算停留时长。
 *
 * @param text - 提示文本。
 * @param tone - 提示类别。
 * @returns 停留毫秒数。
 */
function holdFor(text: string, tone: ToastTone): number {
	const { base, perChar, cap } = HOLD_OF[tone];
	return Math.min(base + text.length * perChar, cap);
}

/**
 * 显示一条轻量提示。
 *
 * 错误类提示显示期间到来的信息类提示直接丢弃：后台刷新可以稍后再报，被替换掉的错误文本
 * 无法再看到。
 *
 * @param text - 提示文本；空串不显示。
 * @param options - 见 {@link ToastOptions}。
 * @returns 无。
 */
export function showToast(text: string, options: ToastOptions = {}): void {
	if (text === '') return;
	const tone = options.tone ?? 'error';
	if (current !== null && current.tone === 'error' && tone === 'info') return;
	// 先卸载上一条，避免两条横幅重叠在同一位置。
	if (current !== null) {
		current.root.unmount();
		current.container.remove();
		current = null;
	}
	const container = document.createElement('div');
	document.body.appendChild(container);
	const root = createRoot(container);
	const handle = { root, container, tone };
	current = handle;
	const done = (): void => {
		if (current === handle) current = null;
		root.unmount();
		container.remove();
	};
	const icon = tone === 'info' ? IconInfoOutlineRegular : IconWarningOutlineRegular;
	root.render(React.createElement(Toast, {
		text,
		icon: React.createElement(icon),
		holdMs: options.holdMs ?? holdFor(text, tone),
		onDone: done,
	}));
}
