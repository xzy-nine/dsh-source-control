/**
 * 插件数据目录解析：统一走 DSH 的 home 规则，测试隔离变量优先。
 *
 * 与 DSH 的 `dsh-home-paths` 同序：`DSH_SOURCE_CONTROL_HOME`（单测隔离）→ `DSH_HOME` → `~/.dsh`。
 * 状态文档、文本日志与旧会话解析三处调用方共用本模块的 `$DSH_HOME` 解析。
 */
import { join } from 'node:path';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';

/**
 * 测试隔离目录。
 *
 * `DSH_SOURCE_CONTROL_HOME` 指向插件数据的独立目录，单测用它把数据与真实 home 隔开。
 *
 * @returns 隔离目录绝对路径；未设置该变量时为 null。
 */
function isolatedHome(): string | null {
	const override = process.env.DSH_SOURCE_CONTROL_HOME;
	const trimmed = override === undefined ? '' : override.trim();
	return trimmed === '' ? null : trimmed;
}

/**
 * 取 DSH home。
 *
 * 测试隔离变量 `DSH_SOURCE_CONTROL_HOME` 优先于 `DSH_HOME`：它把插件数据整体指向隔离目录。
 *
 * @returns DSH home 绝对路径；测试隔离时即隔离目录本身。
 */
export function dshHome(): string {
	return isolatedHome() ?? resolveDshHome();
}

/**
 * 取插件数据目录。
 *
 * 测试隔离变量直接作为插件目录，其余情况是 `<DSH home>/dsh-source-control`。
 *
 * @returns 插件数据目录绝对路径。
 */
export function pluginHome(): string {
	return isolatedHome() ?? join(resolveDshHome(), 'dsh-source-control');
}
