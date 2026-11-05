/**
 * 双轨菜单基线的守卫门禁：本插件主版本越过基线时，双轨必须已经退出。
 *
 * 右键菜单在过渡期有两套承载：宿主提供 `ctx.contextMenus` 时走共享菜单，否则回退自建
 * 浮层。这份兼容只是过渡手段，计划是在下一次 `!` 带来的大版本里退出它。
 *
 * 插件版本由 GitHub 上的 semantic-release 按 conventional commits 推导，`!` 即主版本
 * 加一。因此触发判据是**本插件自己的主版本**，与 dsh 引擎下限无关——引擎下限是本插件
 * 声明的兼容面，不是发布节奏。越过基线主版本后，下面两项都必须已完成：
 *
 * 1. 自建浮层删除（双轨只剩共享菜单一条路径）；
 * 2. `engines.dsh` 下限高于基线记录的下限（不再声明对没有该服务的旧宿主的兼容）。
 *
 * 只做一半会让插件在新宿主上退回没人维护的旧轨，或让旧宿主因缺服务直接失去菜单，
 * 两种都是静默降级，因此分开检查、逐项报红。
 *
 * 用法：node scripts/check-dual-track-baseline.mjs [--update]
 *   --update  按当前状态重写基线，用于退出双轨后落新基线。
 *
 * @module scripts/check-dual-track-baseline
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = join(root, 'dual-track-baseline.json');
const manifestPath = join(root, 'package.json');

/** 自建浮层的实现文件；它存在即表示旧轨还在。 */
const LEGACY_MENU_FILE = join(root, 'src', 'client', 'ui', 'context-menu.ts');

/**
 * 自建浮层独有的实现特征。
 *
 * 取实现细节而非注释：注释会随散文调整漂移，而这些标识符只在自建路径里出现。
 */
const LEGACY_MARKERS = ['createRoot', 'SUBMENU_FLIP_ATTR'];

/** 共享菜单服务首次随宿主发布的版本；退出双轨时引擎下限至少要到这里。 */
const SHARED_MENU_ENGINE_FLOOR = [0, 2, 2, '-alpha.3'];

/** 版本片段：主次修订三段数字与可选的预发布后缀。 */
const VERSION = /(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/g;

/**
 * 读插件清单。
 *
 * @returns 解析后的 package.json。
 */
function readManifest() {
	return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

/**
 * 把一处匹配转成版本四元组。
 *
 * @param match - 正则匹配。
 * @returns 前三项为数字，第四项为预发布后缀（含前导连字符，无后缀为空串）。
 */
function toVersion(match) {
	return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? ''];
}

/**
 * 解析一个版本字符串。
 *
 * @param text - 版本或区间文本。
 * @returns 首个版本四元组；无法解析时为 null。
 */
function parseVersion(text) {
	if (typeof text !== 'string') return null;
	const match = new RegExp(VERSION.source).exec(text);
	return match === null ? null : toVersion(match);
}

/**
 * 从 `engines.dsh` 的区间里取兼容面的下限。
 *
 * 区间写成 `>=A <=B` 时，可支持的最旧宿主由 A 决定；上界不参与判定，它随发布批次抬升，
 * 拿它做判据会在每次放宽上界时误报。没有 `>=` 起点时返回 null，门禁按不可判定失败。
 *
 * @param range - `engines.dsh` 区间字符串。
 * @returns 版本四元组；无 `>=` 起点时返回 null。
 */
function engineFloor(range) {
	if (typeof range !== 'string') return null;
	const starts = [...range.matchAll(new RegExp('>=' + '\\s*' + VERSION.source, 'g'))];
	if (starts.length === 0) return null;
	// 一个区间里出现多处 >= 时取最低的那个：那才是仍支持的宿主的边界。
	return starts.map(toVersion).reduce((low, item) => (compareVersion(item, low) < 0 ? item : low));
}

/**
 * 比较两个版本，遵循 semver 的预发布优先规则。
 *
 * 预发布标识逐段比较：数字段按数值比，其余按字典序，且数字段低于字母段。直接用字符串
 * 比较会把 `rc.1` 排在 `alpha.3` 之前，与 semver 相反。
 *
 * @param a - 版本四元组。
 * @param b - 版本四元组。
 * @returns 负数为 a 更低，正数为 a 更高。
 */
function compareVersion(a, b) {
	for (let index = 0; index < 3; index += 1) {
		if (a[index] !== b[index]) return a[index] - b[index];
	}
	const aPre = a[3] === '' ? [] : a[3].slice(1).split('.');
	const bPre = b[3] === '' ? [] : b[3].slice(1).split('.');
	// 正式版高于其同号预发布。
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

/**
 * 把版本四元组还原成可读的版本号。
 *
 * @param version - 版本四元组。
 * @returns 形如 `0.2.2-alpha.3` 的文本。
 */
function versionText(version) {
	// 第四项自带前导连字符；无后缀时就是空串。
	return version.slice(0, 3).join('.') + (version[3] ?? '');
}

/**
 * 判定旧轨是否仍在。
 *
 * 文件存在且含任一独有特征才算保留：只剩文件但实现已搬走时，视为已退出双轨。
 *
 * @returns 旧轨仍在时为 true。
 */
function legacyMenuPresent() {
	if (!existsSync(LEGACY_MENU_FILE)) return false;
	const source = readFileSync(LEGACY_MENU_FILE, 'utf8');
	// 按标识符边界匹配：子串匹配会把改名后的残留（如 `createRootUnused`）也算作旧轨。
	return LEGACY_MARKERS.some((marker) => new RegExp('\\b' + marker + '\\b').test(source));
}

/**
 * 读取当前状态。
 *
 * @param manifest - 插件清单。
 * @returns 版本、引擎下限与双轨状态。
 */
function readState(manifest) {
	const range = manifest.engines?.dsh;
	return {
		version: parseVersion(manifest.version),
		versionText: typeof manifest.version === 'string' ? manifest.version : null,
		engineRange: typeof range === 'string' ? range : null,
		engineFloor: engineFloor(range),
		legacyMenu: legacyMenuPresent(),
	};
}

const manifest = readManifest();
const state = readState(manifest);

if (process.argv.includes('--update')) {
	writeFileSync(baselinePath, `${JSON.stringify({
		note: '记录双轨退出前的基线；本插件主版本越过 pluginMajor 后，自建浮层必须删除且 engines.dsh 下限必须高于 engineFloor。',
		pluginMajor: state.version === null ? null : state.version[0],
		pluginVersion: state.versionText,
		engineFloor: state.engineFloor === null ? null : versionText(state.engineFloor),
		legacyMenu: state.legacyMenu,
	}, null, 2)}\n`);
	console.log('[dual-track] 基线已更新：版本 ' + String(state.versionText) + '，引擎下限 ' + (state.engineFloor === null ? '不可解析' : versionText(state.engineFloor)) + '，' + (state.legacyMenu ? '仍保留自建浮层' : '已退出双轨'));
	process.exit(0);
}

if (!existsSync(baselinePath)) {
	console.error('[dual-track] 缺少基线文件 ' + baselinePath + '；先执行 node scripts/check-dual-track-baseline.mjs --update');
	process.exit(1);
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const failures = [];
const legacyPath = LEGACY_MENU_FILE.slice(root.length + 1).split('\\').join('/');

if (state.version === null) {
	failures.push('package.json 的 version 无法解析：' + String(state.versionText) + '，无法判定是否已进入退出双轨的大版本');
} else if (typeof baseline.pluginMajor !== 'number') {
	failures.push('基线缺少 pluginMajor；先执行 node scripts/check-dual-track-baseline.mjs --update');
} else if (state.version[0] > baseline.pluginMajor) {
	/*
	 * 已进入大版本：双轨的两项退出条件都要完成。逐项报出，避免修好一项后才发现另一项。
	 */
	if (state.legacyMenu) {
		failures.push(
			'插件主版本已从基线记录的 ' + String(baseline.pluginMajor) + '.x 升到 ' + String(state.version[0]) + '.x，'
			+ '但自建右键浮层仍在：删除 ' + legacyPath + ' 的自建路径，只保留共享菜单',
		);
	}
	if (state.engineFloor === null) {
		failures.push('engines.dsh 里找不到可解析的版本下限：' + String(state.engineRange) + '，无法确认已放弃旧宿主兼容');
	} else if (baseline.engineFloor !== null) {
		const baselineFloor = parseVersion(baseline.engineFloor);
		if (baselineFloor !== null && compareVersion(state.engineFloor, baselineFloor) <= 0) {
			failures.push(
				'插件主版本已升到 ' + String(state.version[0]) + '.x，但 engines.dsh 下限仍是 ' + versionText(state.engineFloor)
				+ '：退出双轨后旧宿主没有右键菜单，下限至少要抬到共享菜单服务首发的 ' + versionText(SHARED_MENU_ENGINE_FLOOR),
			);
		}
	}
}

// 基线记录为已退出双轨：旧轨不得重新出现，与当前主版本无关。
if (baseline.legacyMenu === false && state.legacyMenu) {
	failures.push('基线记录双轨已退出，但自建右键浮层又出现了：' + legacyPath);
}

if (failures.length > 0) {
	console.error('[dual-track] 双轨菜单状态与基线不符：');
	for (const line of failures) console.error('  - ' + line);
	console.error('');
	console.error('请先阅读对应规则再修改：');
	console.error('  .agents/notes/implemented/architecture/2026-11-05-dual-track-context-menu.md');
	process.exit(1);
}

const majorCrossed = typeof baseline.pluginMajor === 'number' && state.version !== null && state.version[0] > baseline.pluginMajor;
console.log('[dual-track] 通过：版本 ' + String(state.versionText) + '，引擎下限 ' + (state.engineFloor === null ? '不可解析' : versionText(state.engineFloor)) + '，' + (state.legacyMenu ? '双轨仍在（基线主版本 ' + String(baseline.pluginMajor) + '.x 内）' : '已退出双轨') + (majorCrossed ? '' : ''));
