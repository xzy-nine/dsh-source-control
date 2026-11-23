/**
 * 重复代码门禁的扫描参数与指纹计算。
 *
 * 从 `check-duplication.mjs` 抽出来供测试直接导入：阈值与指纹算法都要能单独验证。
 */
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectClones } from 'jscpd';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 期望的最小重复行数。
 *
 * jscpd 用 `end.line - start.line` 比较阈值，而跨 n 行的片段该差值为 n-1，因此传给它的
 * 配置值要比期望值小一档，恰好 n 行的重复才不会被漏掉。
 */
export const EXPECTED_MIN_LINES = 3;

/** 传给 jscpd 的行数阈值。 */
export const MIN_LINES = EXPECTED_MIN_LINES - 1;

/** 传给 jscpd 的 token 阈值。 */
export const MIN_TOKENS = 20;

/** 扫描范围的绝对路径，正斜杠形式。 */
export const SCAN_TARGET = join(root, 'src').split('\\').join('/');

/** 仓库根。 */
export const REPO_ROOT = root;

/**
 * 计算片段内容摘要。
 *
 * 先归一化行尾再摘要：同一份片段在检出为 CRLF 与 LF 的机器上文本不同，不归一化会让基线
 * 只在某一侧通过。摘要取两侧片段中字节序较小的一侧，使指纹与 A/B 侧归属无关（两侧片段通常不同）。
 *
 * @param a - 第一侧片段文本。
 * @param b - 第二侧片段文本。
 * @returns 摘要的前 16 位十六进制。
 */
export function fragmentDigest(a, b) {
	const normalize = (text) => text.replace(/\r\n?/g, '\n');
	const first = normalize(a);
	const second = normalize(b);
	const [head, tail] = first <= second ? [first, second] : [second, first];
	return createHash('sha256').update(`${head}\u0000${tail}`).digest('hex').slice(0, 16);
}

/**
 * 把克隆折成指纹。
 *
 * 指纹不含行号：行号随无关改动漂移。文件对 + 片段长度 + 片段内容摘要共同定位一处重复，
 * 因此同文件对、同长度但内容被替换时视为新的重复。
 *
 * 长度取两侧行数的较小值，两侧各自取绝对值：jscpd 合并相邻窗口时给出一侧起止行反向的区间，
 * 其 `end - start + 1` 为负数。
 *
 * @param clones - 克隆列表。
 * @param repoRoot - 仓库根，用于把绝对路径截成相对路径。
 * @returns 指纹数组，已排序。
 */
export function fingerprints(clones, repoRoot = root) {
	return clones
		.map((clone) => {
			const a = clone.duplicationA;
			const b = clone.duplicationB;
			const pair = [a.sourceId, b.sourceId]
				.map((name) => name.slice(repoRoot.length + 1).replace(/\\/g, '/'))
				.sort()
				.join('|');
			const lines = Math.max(1, Math.min(
				Math.abs(a.end.line - a.start.line + 1),
				Math.abs(b.end.line - b.start.line + 1),
			));
			return `${pair}|${lines}|${fragmentDigest(a.fragment ?? '', b.fragment ?? '')}`;
		})
		.sort();
}

/**
 * 扫描给定目录下的克隆。
 *
 * 路径统一成正斜杠形式：jscpd 对 Windows 反斜杠绝对路径会静默扫不到文件（返回空结果）。
 *
 * @param target - 扫描目录的绝对路径。
 * @returns 克隆列表。
 */
export async function scanClones(target = SCAN_TARGET) {
	return await detectClones({
		path: [target.split('\\').join('/')],
		minLines: MIN_LINES,
		minTokens: MIN_TOKENS,
		format: ['typescript', 'tsx'],
		silent: true,
		reporters: [],
	});
}
