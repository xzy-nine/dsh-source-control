/**
 * ANSI 配色渲染：把 ssh 与 git 的输出按它自己的颜色显示。
 *
 * 只解释 SGR 序列（`ESC[<参数>m`：前景 / 背景色、加粗、暗淡、斜体、下划线），其余转义序列
 * 与未识别的参数忽略；文本一字不改地保留。
 */
import React from 'react';

/** 一段带样式的文本。 */
export interface AnsiChunk {
	/** 文本内容。 */
	readonly text: string;
	/** 该段生效的样式；无样式时为空对象。 */
	readonly style: React.CSSProperties;
}

/** 基础 8 色。 */
const BASIC_COLORS = ['#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5'];

/** 高亮 8 色。 */
const BRIGHT_COLORS = ['#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff'];

/** 生效中的 SGR 状态。 */
interface SgrState {
	color: string | null;
	background: string | null;
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
}

/**
 * 取调色板里的一项。
 *
 * @param palette - 调色板。
 * @param index - 下标。
 * @returns 颜色；下标越界时为 null。
 */
function paletteColor(palette: readonly string[], index: number): string | null {
	return palette[index] ?? null;
}

/**
 * 套用一次 SGR 参数。
 *
 * @param state - 生效中的状态，就地修改。
 * @param params - 分号分隔的参数。
 * @returns 无。
 */
function applySgr(state: SgrState, params: readonly number[]): void {
	for (const code of params) {
		if (!Number.isInteger(code)) continue;
		if (code === 0) {
			state.color = null; state.background = null;
			state.bold = false; state.dim = false; state.italic = false; state.underline = false;
		} else if (code === 1) state.bold = true;
		else if (code === 2) state.dim = true;
		else if (code === 3) state.italic = true;
		else if (code === 4) state.underline = true;
		else if (code === 22) { state.bold = false; state.dim = false; }
		else if (code === 23) state.italic = false;
		else if (code === 24) state.underline = false;
		else if (code >= 30 && code <= 37) state.color = paletteColor(BASIC_COLORS, code - 30);
		else if (code === 39) state.color = null;
		else if (code >= 40 && code <= 47) state.background = paletteColor(BASIC_COLORS, code - 40);
		else if (code === 49) state.background = null;
		else if (code >= 90 && code <= 97) state.color = paletteColor(BRIGHT_COLORS, code - 90);
		else if (code >= 100 && code <= 107) state.background = paletteColor(BRIGHT_COLORS, code - 100);
	}
}

/**
 * 状态对应的样式。
 *
 * @param state - 生效中的状态。
 * @returns 样式对象；无样式时为空对象。
 */
function styleOf(state: SgrState): React.CSSProperties {
	const style: React.CSSProperties = {};
	if (state.color !== null) style.color = state.color;
	if (state.background !== null) style.background = state.background;
	if (state.bold) style.fontWeight = 600;
	if (state.dim) style.opacity = 0.7;
	if (state.italic) style.fontStyle = 'italic';
	if (state.underline) style.textDecoration = 'underline';
	return style;
}

/**
 * 解析 SGR 的参数。
 *
 * `ESC[m` 与 `ESC[0m` 同义，因此空参数按 0 处理；非数字参数交给调用方忽略。
 *
 * @param body - `ESC[` 与结束字母之间的内容。
 * @returns 参数列表。
 */
function parseSgrParams(body: string): number[] {
	return body.split(';').map((item) => (item === '' ? 0 : Number.parseInt(item, 10)));
}

/**
 * 把带 ANSI 转义序列的文本切成带样式的片段。
 *
 * @param text - 原文。
 * @returns 片段列表；没有转义序列时是一段无样式文本。
 */
export function parseAnsi(text: string): AnsiChunk[] {
	const chunks: AnsiChunk[] = [];
	const state: SgrState = { color: null, background: null, bold: false, dim: false, italic: false, underline: false };
	// CSI 序列整体匹配：以 m 结束的是 SGR，其余（光标、擦除等）只丢弃，不影响文本。
	const pattern = /\u001b\[[0-9;?]*[A-Za-z]/g;
	let from = 0;
	for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
		if (match.index > from) chunks.push({ text: text.slice(from, match.index), style: styleOf(state) });
		from = match.index + match[0].length;
		if (match[0].endsWith('m')) applySgr(state, parseSgrParams(match[0].slice(2, -1)));
	}
	if (from < text.length) chunks.push({ text: text.slice(from), style: styleOf(state) });
	return chunks;
}

/**
 * 按 ANSI 颜色渲染文本。
 *
 * @param props.text - 原文。
 * @returns 彩色文本。
 */
export function AnsiText({ text }: { readonly text: string }): React.ReactElement {
	return React.createElement(
		React.Fragment,
		null,
		...parseAnsi(text).map((chunk, index) => React.createElement('span', { key: String(index), style: chunk.style }, chunk.text)),
	);
}
