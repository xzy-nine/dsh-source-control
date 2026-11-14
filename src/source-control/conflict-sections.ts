/**
 * 冲突的分段解决：按「第几段、取哪一侧」改写工作区文件。
 *
 * 整份文件的 `采用我方 / 采用对方` 只能一刀切；冲突常常是逐段判断的，因此这里只替换
 * 指定的那一处 `<<<<<<< … >>>>>>>` 区间，其余段落与普通行原样保留。全部区间解决完后
 * 文件里不再有标记，再交给 `add` 落索引即完成。
 */
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import { splitConflict, sideLinesOf } from '../shared/conflict-sections.js';
import { worktreeText } from './conflict-ops.js';

/** 一个分段解决动作。 */
export type SectionSide = 'ours' | 'theirs' | 'both' | 'base' | 'none';

/** 一次分段解决的结果。 */
export interface SectionResolveOutcome {
	/** 处理后文件里是否还有未解决的冲突标记。 */
	readonly hasMarkers: boolean;
	/** 失败原因；成功为 null。 */
	readonly error: string | null;
}

/**
 * 取一个区间按给定动作替换后的行。
 *
 * @param section - 冲突区间。
 * @param side - 取哪一侧；`both` 先我方后对方，`none` 保留空。
 * @returns 替换后的行。
 */
function replacementOf(section: ReturnType<typeof splitConflict>['sections'][number], side: SectionSide): string[] {
	switch (side) {
		case 'ours': return [...sideLinesOf(section, 'ours')];
		case 'theirs': return [...sideLinesOf(section, 'theirs')];
		case 'both': return [...sideLinesOf(section, 'ours'), ...sideLinesOf(section, 'theirs')];
		case 'base': return [...section.base];
		case 'none': return [];
		default: return [];
	}
}

/**
 * 按分段动作改写冲突文件的一处区间。
 *
 * 行号取自同一份解析结果，因此写入前必须重新解析：调用方给出的是「当前文件里的第几段」，
 * 两次读取之间文件被外部改动时按解析不到处理，而不是写到错位置。
 *
 * @param repo - 仓库路径。
 * @param path - 文件路径，相对仓库根。
 * @param index - 区间序号，从 0 开始。
 * @param side - 取哪一侧。
 * @returns 处理结局。
 */
export async function resolveConflictSection(repo: string, path: string, index: number, side: SectionSide): Promise<SectionResolveOutcome> {
	const text = await worktreeText(repo, path);
	if (text === null) return { hasMarkers: false, error: '读不到工作区文件' };
	const split = splitConflict(text);
	const section = split.sections.find((item) => item.index === index);
	if (section === undefined) return { hasMarkers: split.hasMarkers, error: `该文件没有第 ${String(index + 1)} 处冲突` };
	const crlf = text.includes('\r\n');
	const lines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
	// 末尾换行：split 时去掉过，改写后要按原样还原。
	const trailing = text.endsWith('\n');
	if (trailing) lines.pop();
	const before = lines.slice(0, section.startLine - 1);
	const after = lines.slice(section.endLine);
	const next = [...before, ...replacementOf(section, side), ...after];
	const body = next.join(crlf ? '\r\n' : '\n') + (trailing ? (crlf ? '\r\n' : '\n') : '');
	await fs.writeFile(nodePath.join(repo, ...path.split('/')), body, 'utf8');
	return { hasMarkers: splitConflict(body).hasMarkers, error: null };
}

/**
 * 把整个文件里剩余的所有冲突区间按同一侧解决。
 *
 * @param repo - 仓库路径。
 * @param path - 文件路径，相对仓库根。
 * @param side - 取哪一侧。
 * @returns 处理结局。
 */
export async function resolveAllConflictSections(repo: string, path: string, side: SectionSide): Promise<SectionResolveOutcome> {
	const text = await worktreeText(repo, path);
	if (text === null) return { hasMarkers: false, error: '读不到工作区文件' };
	let split = splitConflict(text);
	if (!split.hasMarkers) return { hasMarkers: false, error: null };
	// 从后往前改：行号取自同一份解析结果，前面的区间不受影响。
	const crlf = text.includes('\r\n');
	let lines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
	const trailing = text.endsWith('\n');
	if (trailing) lines.pop();
	for (const section of [...split.sections].reverse()) {
		lines = [
			...lines.slice(0, section.startLine - 1),
			...replacementOf(section, side),
			...lines.slice(section.endLine),
		];
	}
	const next = lines.join(crlf ? '\r\n' : '\n') + (trailing ? (crlf ? '\r\n' : '\n') : '');
	await fs.writeFile(nodePath.join(repo, ...path.split('/')), next, 'utf8');
	split = splitConflict(next);
	return { hasMarkers: split.hasMarkers, error: null };
}
