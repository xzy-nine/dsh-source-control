/**
 * 目录上溯的公共形态：从给定目录起逐级取父目录，交给回调判断。
 *
 * 调用方各自的判据不同（git 目录、`.gitmodules` 声明），上溯本身共用这一处。
 */
import { dirname } from 'node:path';

/**
 * 从 `start` 起逐级向上调用 `visit`，直到访问器给出答案或到达文件系统根。
 *
 * 每个目录只访问一次；根目录同样访问，到达根（`dirname` 返回自身）时上溯结束。
 *
 * @param start - 起始目录的绝对路径。
 * @param visit - 访问器；返回非 undefined 的值即结束上溯。
 * @returns 访问器给出的值；上溯到根仍未给出时为 undefined。
 */
export async function walkUp<T>(
	start: string,
	visit: (dir: string) => Promise<T | undefined> | T | undefined,
): Promise<T | undefined> {
	let dir = start;
	for (;;) {
		const found = await visit(dir);
		if (found !== undefined) return found;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}
