/**
 * 反馈日志的打包：把脱敏副本压成一个 zip，供用户在 issue 页手动上传。
 *
 * GitHub 的用户附件接口只接受图片与视频，文本日志无法由接口投递，因此改为本地打包 + 用户手动上传。
 * 打包用系统 `tar -a -cf`（Windows 10 起自带 bsdtar，macOS 与 Linux 亦可用）；tar 不可用时
 * 退回直接给出未压缩的日志副本。
 */
import { basename, join } from 'node:path';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { collectProcess } from './child-process.js';
import { logRoot } from './logger.js';

/** 打包结果。 */
export interface LogArchive {
	/** 压缩包的绝对路径。 */
	readonly path: string;
	/** 体积（字节）。 */
	readonly size: number;
	/** 是否是压缩包；false 表示 tar 不可用、给出的是未压缩副本。 */
	readonly compressed: boolean;
}

/**
 * 目录名：落在日志根目录下的 outbox，失败时用户可自行取用。
 *
 * @returns 绝对路径。
 */
export function outboxDir(): string {
	return join(logRoot(), 'outbox');
}

/**
 * 把一段文本写进 outbox 并打包。
 *
 * @param name - 原始日志文件名。
 * @param text - 已脱敏的日志内容。
 * @returns 打包结果。
 */
export async function archiveLog(name: string, text: string): Promise<LogArchive> {
	const dir = outboxDir();
	mkdirSync(dir, { recursive: true });
	const logName = name.replace(/\.log$/, '') + '-redacted.log';
	const logPath = join(dir, logName);
	writeFileSync(logPath, text, 'utf8');
	const zipPath = join(dir, logName.replace(/\.log$/, '') + '.zip');
	const result = await collectProcess({
		command: 'tar',
		// -a 按扩展名选压缩格式；-C 指定源目录、只打一个文件，避免把整目录打进去。
		args: ['-a', '-c', '-f', zipPath, '-C', dir, logName],
	});
	if (result.code === 0) {
		try {
			return { path: zipPath, size: statSync(zipPath).size, compressed: true };
		} catch {
			/* 读不到体积时退回未压缩副本 */
		}
	}
	return { path: logPath, size: Buffer.byteLength(text, 'utf8'), compressed: false };
}

/**
 * 压缩包的文件名，写进 issue 正文供用户对照。
 *
 * @param path - 打包后的路径。
 * @returns 文件名。
 */
export function archiveFileName(path: string): string {
	return basename(path);
}
