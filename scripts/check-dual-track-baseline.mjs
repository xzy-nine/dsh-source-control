/**
 * 旧宿主兼容面退出的守卫门禁：删除旧轨与抬升 engineFloor 必须成对完成。
 *
 * 右键菜单的两条固有兼容面曾服务于还不提供它们的宿主，如今 `ctx.contextMenus`
 * 已证明在 0.2.1-rc.2 首发、CSS 锚点一代在 0.2.2-alpha.2 首发（见 deepseek-harness
 * 的 upgrade-guide），本插件把 `engines.dsh` 下限抬到两者之上的 0.2.2-alpha.2 后，
 * 旧宿主兼容就具备可判的几何形态：旧实现标识符必须删除，下限必须不低于规定的目标。
 *
 * 用法：node scripts/check-dual-track-baseline.mjs [--update]
 *   --update  按当前状态重写基线。
 *
 * @module scripts/check-dual-track-baseline
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = join(root, 'dual-track-baseline.json');
const manifestPath = join(root, 'package.json');

/** 旧轨自建浮层的实现文件，与自建路径独有的标识符。 */
const LEGACY_MENU_FILE = join(root, 'src', 'client', 'ui', 'context-menu.ts');
const LEGACY_MARKERS = ['createRoot', 'SUBMENU_FLIP_ATTR'];

/** 共享菜单与 CSS 锚点一代都就位的版本；退出后 `engines.dsh` 下限不得低于它。 */
const SHARED_MENU_ENGINE_FLOOR = [0, 2, 2, '-alpha.2'];

/** 版本片段：主次修订三段数字与可选的预发布后缀。 */
const VERSION = /(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/g;

/** 读插件清单。 */
function readManifest() {
	return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

/** 把一处匹配转成版本四元组。 */
function toVersion(match) {
	return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? ''];
}

/** 从 `engines.dsh` 区间取兼容面下限。 */
function engineFloor(range) {
	if (typeof range !== 'string') return null;
	const starts = [...range.matchAll(new RegExp('>=' + '\\s*' + VERSION.source, 'g'))];
	if (starts.length === 0) return null;
	return starts.map(toVersion).reduce((low, item) => (compareVersion(item, low) < 0 ? item : low));
}

/** 比较两个版本，遵循 semver 的预发布优先规则。 */
function compareVersion(a, b) {
	for (let index = 0; index < 3; index += 1) {
		if (a[index] !== b[index]) return a[index] - b[index];
	}
	const aPre = a[3] === '' ? [] : a[3].slice(1).split('.');
	const bPre = b[3] === '' ? [] : b[3].slice(1).split('.');
	if (aPre.length === 0 || bPre.length === 0) return bPre.length - aPre.length;
	for (let index = 0; index < Math.max(aPre.length, bPre.length); index += 1) {
		const left = aPre[index];
		const right = bPre[index];
		if (left === undefined) return -1;
		if (right === undefined) return 1;
		const leftNumeric = /^\d+$/.test(left);
		const rightNumeric = /^\d+$/.test(right);
		if (leftNumeric && rightNumeric) {
			if (Number(left) !== Number(right)) return Number(left) - Number(right);
			continue;
		}
		if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
		if (left !== right) return left < right ? -1 : 1;
	}
	return 0;
}

/** 把版本四元组还原成可读版本号。 */
function versionText(version) {
	return version.slice(0, 3).join('.') + (version[3] ?? '');
}

/** 判定旧轨实现是否仍在：文件存在且含任一独有标识符。 */
function legacyMenuPresent() {
	return LEGACY_MARKERS.some((marker) =>
		new RegExp('\\b' + marker + '\\b').test(readFileSync(LEGACY_MENU_FILE, 'utf8')));
}

/** 读取当前状态。 */
function readState(manifest) {
	const range = manifest.engines?.dsh;
	return {
		versionText: typeof manifest.version === 'string' ? manifest.version : null,
		engineRange: typeof range === 'string' ? range : null,
		engineFloor: engineFloor(range),
		legacyMenu: legacyMenuPresent(),
	};
}

const manifest = readManifest();
const state = readState(manifest);

if (process.argv.includes('--update')) {
	writeFileSync(baselinePath, JSON.stringify({
		note: '记录旧宿主兼容面退出前的基线；自建浮层删除且 engines.dsh 下限不低于 ' + versionText(SHARED_MENU_ENGINE_FLOOR) + ' 后即视为已退出。',
		legacyMenu: state.legacyMenu,
	}, null, 2) + '\n');
	console.log('[dual-track] 基线已更新：' + (state.legacyMenu ? '仍保留自建浮层' : '已退出双轨'));
	process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const failures = [];
if (state.engineFloor === null) {
	failures.push('engines.dsh 里找不到可解析的版本下限：' + String(state.engineRange));
} else if (compareVersion(state.engineFloor, SHARED_MENU_ENGINE_FLOOR) < 0) {
	failures.push('engines.dsh 下限 ' + versionText(state.engineFloor) + ' 低于共享菜单与 CSS 锚点就位的 ' + versionText(SHARED_MENU_ENGINE_FLOOR));
}
if (state.legacyMenu) {
	failures.push('自建右键浮层仍在：删除 src/client/ui/context-menu.ts 里的自建路径（createRoot / 翻转补丁）');
}
// 基线记录为已退出后：旧轨不得重新出现。
if (baseline.legacyMenu === false && state.legacyMenu) {
	failures.push('基线记录旧宿主兼容早已退出，但自建右键浮层又出现了：src/client/ui/context-menu.ts');
}

if (failures.length > 0) {
	console.error('[dual-track] 旧宿主兼容面状态与基线不符：');
	for (const line of failures) console.error('  - ' + line);
	process.exit(1);
}
console.log('[dual-track] 通过：引擎下限 ' + versionText(state.engineFloor) + '，自建浮层已删除，旧宿主兼容已退出。');
