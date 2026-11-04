/**
 * 插件数据目录解析：统一走 DSH 的 home 规则，测试隔离变量优先。
 *
 * 与 DSH 的 `dsh-home-paths` 同序：`DSH_SOURCE_CONTROL_HOME`（单测隔离）→ `DSH_HOME` → `~/.dsh`。
 * 三处调用方（状态文档、文本日志、旧会话解析）共用本模块，不再各自展开环境变量。
 */
import { join } from 'node:path';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';

/**
 * 取 DSH home。
 *
 * 测试隔离变量 `DSH_SOURCE_CONTROL_HOME` 优先于 `DSH_HOME`：它把插件数据整体挪到临时目录。
 *
 * @returns DSH home 绝对路径；测试隔离时即隔离目录本身。
 */
export function dshHome(): string {
	const override = process.env.DSH_SOURCE_CONTROL_HOME;
	if (override !== undefined && override.trim().length > 0) return override.trim();
	return resolveDshHome();
}

/**
 * 取插件数据目录。
 *
 * 测试隔离变量直接作为插件目录，其余情况是 `<DSH home>/dsh-source-control`。
 *
 * @returns 插件数据目录绝对路径。
 */
export function pluginHome(): string {
	const override = process.env.DSH_SOURCE_CONTROL_HOME;
	if (override !== undefined && override.trim().length > 0) return override.trim();
	return join(resolveDshHome(), 'dsh-source-control');
}
