/**
 * 重复代码门禁：用 jscpd 扫描 `src/`，出现基线之外的克隆即失败。
 *
 * 基线记的是当前已接受的重复（文件对 + 片段长度 + 片段内容摘要）及其出现次数，只允许调低；
 * 确实无法消除的（如跨构建目标的类型镜像）才调高，并在提交信息里说明理由。
 *
 * 同一指纹在基线与当前各出现 N 次时视为未新增：jscpd 会把一处重复按相邻窗口合并成多条克隆，
 * 只比对实例存在与否会让基线随首处重复的条数变化而失效。
 *
 * 用法：node scripts/check-duplication.mjs [--update]
 *   --update  按当前扫描结果重写基线。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectClones } from 'jscpd';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = join(root, 'duplication-baseline.json');

/** 扫描参数；与历史基线一致，改动会让基线整体失效。 */
const MIN_LINES = 5;
const MIN_TOKENS = 50;

/**
 * 扫描 `src/` 下的克隆。
 *
 * 路径统一成正斜杠形式：jscpd 对 Windows 反斜杠绝对路径会静默扫不到文件（返回空结果）。
 *
 * @returns 克隆列表。
 */
async function scanClones() {
	const target = join(root, 'src').split('\\').join('/');
	return await detectClones({
		path: [target],
		minLines: MIN_LINES,
		minTokens: MIN_TOKENS,
		format: ['typescript'],
		silent: true,
		reporters: [],
	});
}

/**
 * 计算片段内容摘要。
 *
 * 摘要取两侧片段中字节序较小的一侧，使指纹与 A/B 侧归属无关（两侧片段通常不同）。
 *
 * @param a - 第一侧片段文本。
 * @param b - 第二侧片段文本。
 * @returns 摘要的前 16 位十六进制。
 */
function fragmentDigest(a, b) {
	const [first, second] = a <= b ? [a, b] : [b, a];
	return createHash('sha256').update(`${first}\u0000${second}`).digest('hex').slice(0, 16);
}

/**
 * 把克隆折成指纹。
 *
 * 指纹不含行号：行号随无关改动漂移。文件对 + 片段长度 + 片段内容摘要共同定位一处重复，
 * 因此同文件对、同长度但内容被替换时视为新的重复。
 *
 * @param clones - 克隆列表。
 * @returns 指纹数组，已排序。
 */
function fingerprints(clones) {
	return clones
		.map((clone) => {
			const a = clone.duplicationA;
			const b = clone.duplicationB;
			const pair = [a.sourceId, b.sourceId]
				.map((name) => name.slice(root.length + 1).replace(/\\/g, '/'))
				.sort()
				.join('|');
			const lines = Math.min(a.end.line - a.start.line + 1, b.end.line - b.start.line + 1);
			return `${pair}|${lines}|${fragmentDigest(a.fragment ?? '', b.fragment ?? '')}`;
		})
		.sort();
}

/**
 * 统计指纹出现次数。
 *
 * @param list - 指纹数组。
 * @returns 指纹到次数的映射。
 */
function countByFingerprint(list) {
	const counts = new Map();
	for (const item of list) counts.set(item, (counts.get(item) ?? 0) + 1);
	return counts;
}

const current = fingerprints(await scanClones());

if (process.argv.includes('--update')) {
	writeFileSync(baselinePath, `${JSON.stringify({
		note: '当前已接受的重复；只允许调低。调高须先确认无法消除，并在提交信息里说明理由。',
		minLines: MIN_LINES,
		minTokens: MIN_TOKENS,
		count: current.length,
		fingerprints: current,
	}, null, 2)}\n`);
	console.log(`[duplication] 基线已更新：${current.length} 处`);
	process.exit(0);
}

if (!existsSync(baselinePath)) {
	console.error(`[duplication] 缺少基线文件 ${baselinePath}；先执行 node scripts/check-duplication.mjs --update`);
	process.exit(1);
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const known = countByFingerprint(baseline.fingerprints ?? []);
const seen = countByFingerprint(current);
const added = [];
for (const [item, times] of seen) {
	for (let index = known.get(item) ?? 0; index < times; index += 1) added.push(item);
}

if (added.length > 0) {
	console.error(`[duplication] 新增 ${added.length} 处重复（基线 ${baseline.count} 处，当前 ${current.length} 处）：`);
	for (const item of added) console.error(`  - ${item}`);
	console.error('消除重复后重试；确需保留时用 --update 调高基线并说明理由。');
	process.exit(1);
}

console.log(`[duplication] 通过：${current.length} 处，未超出基线 ${baseline.count} 处`);
