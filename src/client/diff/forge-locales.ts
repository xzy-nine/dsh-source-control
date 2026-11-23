/**
 * forge 变更视图的文案适配：把它的 `t` 契约接到它的字典上。
 *
 * `DiffFile` 要求一个 `t(key, params?)`，键是 `forgePanel` 命名空间的
 * `ForgePanelKey`。本插件不复用 forge 面板的 slot 席位，因此直接绑定 forge 发布的字典：
 * 文案与 forge 面板本身完全一致，键名也随 forge 字典唯一确定。
 */

import { zh, type ForgePanelKey } from '@deepseek-ai/dsh-experimental-client-ui-forge/src/client/locales.ts';

/** `DiffFile` 期望的翻译函数形状。 */
export type ForgeTranslate = (key: ForgePanelKey, params?: Readonly<Record<string, string | number>>) => string;

/**
 * 取当前应使用的字典。
 *
 * 差异页沿用本插件既有做法（文案固定中文），因此这里只用中文表。`zh` 是
 * `ForgePanelKey` 的全量映射，任一键都能取到文案；代入占位符后返回。
 *
 * @returns 翻译函数。
 */
export function forgePanelCopy(): ForgeTranslate {
	return (key, params) => {
		let text: string = zh[key];
		if (params !== undefined) {
			for (const [name, value] of Object.entries(params)) {
				text = text.replaceAll(`{${name}}`, String(value));
			}
		}
		return text;
	};
}
