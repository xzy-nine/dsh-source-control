/**
 * 从 `lib/` 宿主产物导入被测模块。
 *
 * 宿主侧模块普遍带内部 `.js` 相对导入，无法由 `src/` 直连 `.ts`（Node 解析不到 `.js` 实体），
 * 因此测试一律导入 `lib/` 产物；`pretest` 会先重建产物，产物缺失即导入失败并让测试报错。
 *
 * 客户端模块没有逐模块产物（只有打包后的 `lib/client.js`），仍由 `src/` 直连 `.ts` 导入。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 导入一个宿主产物模块。
 *
 * @param relativePath - 相对 `lib/src/` 的产物路径，如 `source-control/git-parse.js`。
 * @returns 模块命名空间。
 */
export async function importHostModule(relativePath) {
	return await import(pathToFileURL(join(root, 'lib', 'src', relativePath)).href);
}
