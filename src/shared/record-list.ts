/**
 * 未类型化响应载荷里的记录读取：按字段形状过滤宿主返回的条目。
 *
 * 运行时无平台依赖，宿主与客户端各自打包。
 */

/**
 * 从数组里取出对象记录，跳过非对象条目。
 *
 * @param value - 载荷里的取值；非数组时按空数组处理。
 * @returns 对象记录，保持原顺序。
 */
export function recordListOf(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) return [];
	const records: Record<string, unknown>[] = [];
	for (const item of value as unknown[]) {
		if (item !== null && typeof item === 'object') records.push(item as Record<string, unknown>);
	}
	return records;
}
