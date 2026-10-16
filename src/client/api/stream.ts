/**
 * 流式响应的读取：按 UTF-8 增量解码并把新增文本交给调用方切分。
 *
 * 事件流与流式提交信息都是 `text/event-stream`：读取方式相同，切帧规则不同，因此这里只负责
 * 解码与增量投递，帧的切分留在各自的调用方。
 */

/**
 * 逐段读取一个流式响应体。
 *
 * 每读到一段就解码并交给 `onText`；调用方自行维护跨段缓冲。`shouldStop` 为 true 时提前结束读取。
 *
 * @param body - 响应体。
 * @param onText - 收到新增文本。
 * @param shouldStop - 是否提前结束；省略时读到流结束。
 * @returns 无。
 */
export async function readStreamText(
	body: ReadableStream<Uint8Array>,
	onText: (text: string) => void,
	shouldStop?: () => boolean,
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		onText(decoder.decode(value, { stream: true }));
		if (shouldStop?.() === true) break;
	}
}
