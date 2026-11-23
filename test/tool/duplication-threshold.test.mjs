/**
 * 重复代码门禁的阈值边界。
 *
 * jscpd 用 `end.line - start.line` 比阈值，而跨 n 行的片段该差值为 n-1：只验证
 * 「恰好三行会被检出、两行不会」，配置值的推导由 `EXPECTED_MIN_LINES` 一处给出。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXPECTED_MIN_LINES, MIN_LINES, scanClones } from '../../scripts/duplication-scan.mjs';

/* 本文件串行：每个用例建临时目录并起一次 jscpd 扫描。 */

/** 临时目录登记表。 */
const temps = [];

test.after(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/**
 * 造一对只差函数名的 TypeScript 文件。
 *
 * @param unique - 目录名后缀，避免并发用例撞目录。
 * @param lines - 函数体总行数。
 * @returns 扫描目录。
 */
function makePair(unique, lines) {
	const dir = mkdtempSync(join(tmpdir(), `gg-dup-${unique}-`));
	temps.push(dir);
	mkdirSync(dir, { recursive: true });
	const body = ['export function alpha(a: number, b: number, c: number): number {'];
	const inner = ['\tconst first = a + b + c;', '\tconst second = first * c - a;', '\treturn second + b - first;'];
	for (let index = 0; index < Math.max(0, lines - 2); index += 1) body.push(inner[index % inner.length]);
	body.push('}');
	const source = `${body.join('\n')}\n`;
	writeFileSync(join(dir, 'a.ts'), source, 'utf8');
	writeFileSync(join(dir, 'b.ts'), source.replace('alpha', 'gamma'), 'utf8');
	return dir;
}

test('配置阈值比期望行数小一档', () => {
	assert.equal(MIN_LINES, EXPECTED_MIN_LINES - 1, 'jscpd 比较的是 end-start，故要减一档');
});

test('恰好三行的重复会被检出', async () => {
	const dir = makePair('three', EXPECTED_MIN_LINES);
	const clones = await scanClones(dir);
	assert.ok(clones.length > 0, '恰好三行的重复必须被检出');
});

test('不足三行的重复不会检出', async () => {
	const dir = makePair('two', EXPECTED_MIN_LINES - 1);
	const clones = await scanClones(dir);
	assert.equal(clones.length, 0, '两行重复低于阈值，不应检出');
});
