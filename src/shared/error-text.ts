/**
 * 失败值的文本化：`Error` 取 `message`，其余值直接转成字符串。
 *
 * 宿主侧的多处失败路径把异常与 git 的 stderr 收敛成同一种可读文本，转换只保留这一份。
 *
 * @param error - 捕获到的失败值。
 * @returns 可读文本。
 */
export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
