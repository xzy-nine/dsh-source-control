/**
 * 从 DSH 会话存储解析 sessionId 对应的工作区根路径。
 *
 * 迁移旧版按 sessionId 分区的状态时用：DSH 把会话的工作区写入
 * \`$DSH_HOME/storages/session_projcache/sessions/<sessionId>.json\` 的 \`record.identity.cwd\`，
 * 这是唯一能把旧会话键还原成工作区根的来源。只在迁移时按需读取单个文件。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 解析 DSH home。
 *
 * 与 \`dsh-home-paths\` 同序，但不认 \`DSH_SOURCE_CONTROL_HOME\`：那是插件状态的测试隔离变量，
 * 会话存储属于 DSH 自身。
 *
 * @returns DSH home 绝对路径。
 */
export function resolveDshHome(): string {
	const env = process.env.DSH_HOME;
	if (env !== undefined && env.trim().length > 0) return env.trim();
	return join(homedir(), '.dsh');
}

/**
 * 取一个会话记录里的工作区根路径。
 *
 * 文件缺失、JSON 非法或字段缺失时给 null——迁移按「无法还原则丢弃该会话」处理。
 *
 * @param sessionId - 会话 id。
 * @returns 工作区根路径；无法还原时为 null。
 */
export function readSessionCwd(sessionId: string): string | null {
	if (sessionId === '') return null;
	const path = join(resolveDshHome(), 'storages', 'session_projcache', 'sessions', `${sessionId}.json`);
	try {
		const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
		const record = raw.record;
		if (record === null || typeof record !== 'object') return null;
		const identity = (record as Record<string, unknown>).identity;
		if (identity === null || typeof identity !== 'object') return null;
		const cwd = (identity as Record<string, unknown>).cwd;
		return typeof cwd === 'string' && cwd !== '' ? cwd : null;
	} catch {
		return null;
	}
}
