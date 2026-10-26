/**
 * 提交行的文本与引用标记。
 *
 * 纯模块：无 React、无 CSS。标记只给出数据与标题，样式类与图标由图形区按 `kind` 选择；
 * 行文本的两种来源（贮藏消息、未提交伪提交的英文占位）都在这里翻译成展示文本。
 *
 * 派生值按提交对象身份缓存（提交列表在刷新时对未变化的项复用对象），因此同一行的文本与标记
 * 只算一次。
 */
import type { Commit } from '../shared/types.ts';
import { forKey, forObject } from '../shared/cache.ts';

/** 引用标记的样式种类。 */
export type RefKind = 'head' | 'branch' | 'remote' | 'tag' | 'stash';

/** 一个引用标记：`refType` 与 `refName` 供右键菜单识别。 */
export interface RefLabel {
	readonly key: string;
	readonly kind: RefKind;
	readonly text: string;
	readonly title: string;
	readonly refType: string;
	readonly refName: string;
}

/** GitHub 的 noreply 邮箱，形如 `ID+用户名@users.noreply.github.com` 或 `用户名@users.noreply.github.com`。 */
const GITHUB_NOREPLY = /^(?:(\d+)\+)?([^@+]+)@users\.noreply\.github\.com$/i;

/** 未提交伪提交的 message 形如 `Uncommitted Changes (2)`；数据层给出英文，这里译成中文。 */
const UNCOMMITTED_MESSAGE = /^Uncommitted Changes(?: \((\d+)\))?$/;

/** 头像候选地址的缓存容量。 */
const AVATAR_CACHE_LIMIT = 128;

/**
 * 取正则捕获组的文本。
 *
 * 未参与匹配的捕获组读出 `undefined`，而 `RegExpExecArray` 的元素类型声明为 `string`。
 *
 * @param match - 匹配结果。
 * @param index - 捕获组序号。
 * @returns 该组文本；该组未参与匹配时为 undefined。
 */
export function groupText(match: RegExpExecArray, index: number): string | undefined {
	return match.at(index);
}

/**
 * 构造作者头像的候选地址，按优先次序排列。
 *
 * GitHub 邮箱由 GitHub 直接提供头像；其余邮箱用 Gravatar。GitHub 在前，取不到时由 Gravatar 兜底。
 *
 * @param email - 作者邮箱。
 * @param size - 请求的图片像素边长。
 * @returns 候选地址；无邮箱或邮箱不是 GitHub noreply 时为空数组。
 */
export function avatarUrls(email: unknown, size = 40): string[] {
	if (typeof email !== 'string') return [];
	const trimmed = email.trim();
	if (trimmed === '') return [];
	const urls: string[] = [];
	const noreply = GITHUB_NOREPLY.exec(trimmed);
	if (noreply !== null) {
		const id = groupText(noreply, 1);
		const username = noreply[2];
		// 带数字 id 时按 id 取；只有用户名时按用户名取。
		urls.push(id !== undefined
			? `https://avatars.githubusercontent.com/u/${id}?s=${size}&v=4`
			: `https://avatars.githubusercontent.com/${encodeURIComponent(username)}?s=${size}&v=4`);
	}
	return urls;
}

/**
 * 贮藏标记的文本：取贮藏消息。
 *
 * git 在有消息时把贮藏的 reflog 主题写成 `On <分支>: <消息>`，展示取用户写的那一段；
 * 没有消息（如自动贮藏）或取不到主题时，退回短引用名。
 *
 * @param commit - 带贮藏标记的提交。
 * @returns 展示文本。
 */
export function stashMessage(commit: Commit): string {
	const text = (commit.message ?? '').trim();
	if (text === '') {
		const selector = commit.stash?.selector ?? 'stash';
		return selector.startsWith('refs/') ? selector.slice('refs/'.length) : selector;
	}
	const match = /^On [^:]*: (.*)$/.exec(text);
	return match !== null && match[1].trim() !== '' ? match[1].trim() : text;
}

/**
 * 取一行显示的提交信息：贮藏行取贮藏消息，未提交伪提交的英文文案译成中文。
 *
 * @param commit - 提交。
 * @returns 显示用文本。
 */
export function displayMessage(commit: Commit): string {
	if (commit.stash !== null && commit.stash !== undefined) return stashMessage(commit);
	const message = commit.message ?? '';
	if (commit.hash !== '*') return message;
	const match = UNCOMMITTED_MESSAGE.exec(message);
	if (match === null) return message;
	return groupText(match, 1) === undefined ? '未提交的更改' : `未提交的更改（${match[1]}）`;
}

/**
 * 取提交的引用标记，并附上用于右键识别的类型与名称。
 *
 * 本地分支与远程分支各自成标记：同名的一对分别显示，便于确认远程分支的存在。
 *
 * @param commit - 提交。
 * @param head - 当前 HEAD 指向的分支。
 * @returns 标记列表，顺序为本地分支、远程分支、标签、贮藏。
 */
export function refLabels(commit: Commit, head: string | null): RefLabel[] {
	const labels: RefLabel[] = [];
	for (const name of commit.heads ?? []) {
		const isHead = head !== null && name === head;
		labels.push({
			key: `h:${name}`,
			kind: isHead ? 'head' : 'branch',
			text: name,
			title: isHead ? `当前分支 ${name}` : `分支 ${name}`,
			refType: 'head',
			refName: name,
		});
	}
	for (const remote of commit.remotes ?? []) {
		labels.push({
			key: `r:${remote.name}`, kind: 'remote', text: remote.name,
			title: `远程分支 ${remote.name}`, refType: 'remote', refName: remote.name,
		});
	}
	for (const tag of commit.tags ?? []) {
		labels.push({
			key: `t:${tag.name}`, kind: 'tag', text: tag.name,
			title: `标签 ${tag.name}`, refType: 'tag', refName: tag.name,
		});
	}
	if (commit.stash !== null && commit.stash !== undefined) {
		const selector = commit.stash.selector ?? 'stash';
		const message = stashMessage(commit);
		labels.push({
			key: 'stash', kind: 'stash', text: message,
			title: `贮藏 ${message}`, refType: 'stash', refName: selector,
		});
	}
	return labels;
}

/** 行文本缓存：只依赖提交本身。 */
const titleCache = forObject((commit: Commit): string => displayMessage(commit));

/**
 * 取一行显示的提交信息（按提交对象缓存）。
 *
 * @param commit - 提交。
 * @returns 显示用文本。
 */
export function titleOf(commit: Commit): string {
	return titleCache(commit);
}

/** 引用标记缓存：提交对象 -> 上次计算时的 HEAD 与结果。 */
const labelCache = new WeakMap<Commit, { readonly head: string | null; readonly labels: RefLabel[] }>();

/**
 * 取提交的引用标记（按提交对象与 HEAD 缓存）。
 *
 * 标记含「当前分支」判定，HEAD 变化时重算。
 *
 * @param commit - 提交。
 * @param head - 当前 HEAD 指向的分支。
 * @returns 标记列表；同一提交与同一 HEAD 返回同一引用。
 */
export function labelsOf(commit: Commit, head: string | null): RefLabel[] {
	const cached = labelCache.get(commit);
	if (cached !== undefined && cached.head === head) return cached.labels;
	const labels = refLabels(commit, head);
	labelCache.set(commit, { head, labels });
	return labels;
}

/** 头像候选地址缓存：键为「邮箱|边长」。 */
const avatarCache = forKey((key: string): string[] => {
	const split = key.lastIndexOf('|');
	const email = key.slice(0, split);
	const size = Number.parseInt(key.slice(split + 1), 10);
	return avatarUrls(email, size);
}, { limit: AVATAR_CACHE_LIMIT });

/**
 * 取作者头像的候选地址（按邮箱与边长缓存）。
 *
 * @param email - 作者邮箱。
 * @param size - 请求的图片像素边长。
 * @returns 候选地址；无可用候选时为空数组。
 */
export function avatarUrlsOf(email: unknown, size = 40): string[] {
	if (typeof email !== 'string') return [];
	return avatarCache(`${email}|${size}`);
}
