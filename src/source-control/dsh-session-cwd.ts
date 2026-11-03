/**
 * 会话工作区根：按 sessionId 从 DSH 会话持久化服务取会话 header 的 `cwd`。
 *
 * 迁移旧版按会话分区的状态时用：会话的工作区根就是 `SessionHeader.cwd`，宿主侧经
 * `ctx.sessionPersistence.list()` 读出已存会话的 header。
 */

/** 会话持久化服务在迁移里用到的最小读面：列出已存会话。 */
export interface SessionHeaderReader {
	list(): Promise<readonly unknown[]>;
}

/**
 * 把会话持久化服务收窄成迁移用的读面。
 *
 * @param source - `ctx.sessionPersistence`；未装载时为 undefined。
 * @returns 读面；服务缺失或不提供 `list` 时为 null。
 */
export function sessionHeaderReader(source: unknown): SessionHeaderReader | null {
	if (source === null || typeof source !== 'object') return null;
	const list = (source as { list?: unknown }).list;
	if (typeof list !== 'function') return null;
	return source as SessionHeaderReader;
}

/**
 * 读出全部已存会话的工作区根。
 *
 * 会话没有 header、header 缺 `id` 或 `cwd`、列表读取失败时不给该会话的结果——迁移按
 * 「无法还原则丢弃该会话」处理。列表只读一次，失败按空表处理。
 *
 * @param reader - 会话 header 读面；服务缺失时为 null。
 * @returns 会话 id 到工作区根路径的表。
 */
export async function readSessionCwdMap(reader: SessionHeaderReader | null): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	if (reader === null) return out;
	let snapshots: readonly unknown[];
	try {
		snapshots = await reader.list();
	} catch {
		return out;
	}
	for (const snapshot of snapshots) {
		if (snapshot === null || typeof snapshot !== 'object') continue;
		const header = (snapshot as { header?: unknown }).header;
		if (header === null || typeof header !== 'object') continue;
		const id = (header as { id?: unknown }).id;
		const cwd = (header as { cwd?: unknown }).cwd;
		if (typeof id === 'string' && id !== '' && typeof cwd === 'string' && cwd !== '') out.set(id, cwd);
	}
	return out;
}
