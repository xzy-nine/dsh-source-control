/**
 * 挂载即发起的一次读取：卸载后丢弃迟到的结果。
 *
 * 读取失败时调用方的失败回调照常执行；卸载后的迟到结果与失败都丢弃。
 *
 * @param read - 读取函数。
 * @param onData - 成功回调。
 * @param onFailure - 失败回调。
 * @returns React 的清理函数。
 */
export function useMountedRead<T>(
	read: () => Promise<T>,
	onData: (data: T) => void,
	onFailure: () => void,
): () => void {
	const cancelled = { current: false };
	void read()
		.then((data) => { if (!cancelled.current) onData(data); })
		.catch(() => { if (!cancelled.current) onFailure(); });
	return () => { cancelled.current = true; };
}
