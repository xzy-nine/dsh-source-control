/**
 * 重复代码门禁：用 jscpd 扫描 `src/`，出现基线之外的克隆即失败。
 *
 * 基线记的是当前已接受的重复（文件对 + 片段长度 + 片段内容摘要）及其出现次数，只允许调低；
 * 确实无法消除的（如跨构建目标的类型镜像）才调高，并在提交信息里说明理由。基线文件
 * 统一放在 `baselines/` 下，与 `comment-prose-baseline.json` 并列。
 *
 * 同一指纹在基线与当前各出现 N 次时视为未新增：jscpd 会把一处重复按相邻窗口合并成多条克隆，
 * 只比对实例存在与否会让基线随首处重复的条数变化而失效。
 *
 * 阈值语义与指纹算法见 `duplication-scan.mjs`。
 *
 * 用法：node scripts/check-duplication.mjs [--update]
 *   --update  按当前扫描结果重写基线。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fingerprints, MIN_LINES, MIN_TOKENS, REPO_ROOT, scanClones } from './duplication-scan.mjs';

const baselinePath = join(REPO_ROOT, 'baselines', 'duplication-baseline.json');

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
	for (const item of added.slice(0, 40)) console.error(`  - ${item}`);
	if (added.length > 40) console.error(`  …还有 ${added.length - 40} 处`);
	console.error('消除重复后重试；确需保留时用 --update 调高基线并说明理由。');
	process.exit(1);
}

console.log(`[duplication] 通过：${current.length} 处，未超出基线 ${baseline.count} 处`);
