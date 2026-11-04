/**
 * 轻量提示：顶部的自动淡出横幅，用于后台刷新的计数变化这类一次性信息。
 *
 * 与 `dialog.ts` 的模态弹窗相对：模态需要用户关闭并承载可复制的失败原因；提示不打断操作、
 * 不占焦点。同一时刻只显示一条，新的一条替换旧的。
 */
import React from 'react';
import { IconInfoOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives';
import { pushToast, removeToast } from '../ui/overlay-host.ts';

/**
 * 显示一条轻量提示。
 *
 * @param text - 提示文本；空串不显示。
 * @returns 无。
 */
export function showToast(text: string): void {
	if (text === '') return;
	pushToast((id) => React.createElement(Toast, {
		text,
		icon: React.createElement(IconInfoOutlineRegular),
		onDone: () => { removeToast(id); },
	}));
}
