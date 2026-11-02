/**
 * 命令处理器的上下文：把 HTTP 请求、参数取值与结果回投收敛成一个接口。
 *
 * 各命令域模块只依赖本接口，不直接接触 `http` 对象，因此可以单测与按域拆分。
 */
import type http from 'node:http';
import type { AiCommitDeps } from '../ai-deps.js';

/** 一条命令的处理上下文。 */
export interface ApiContext {
	/** 请求体。 */
	readonly msg: Record<string, unknown>;
	/** 目标仓库路径；未给出时为空串。 */
	readonly repo: string;
	/** 命令名。 */
	readonly command: string;
	/** 响应对象。 */
	readonly res: http.ServerResponse;
	/** AI 与翻译依赖面。 */
	readonly aiDeps: AiCommitDeps | undefined;
	/** 取字符串参数，缺失或类型不符时为空串。 */
	str: (key: string) => string;
	/** 取字符串参数，缺失或类型不符时为 null。 */
	strOrNull: (key: string) => string | null;
	/** 取布尔参数。 */
	bool: (key: string, dflt?: boolean) => boolean;
	/** 取数值参数。 */
	num: (key: string, dflt?: number) => number;
	/** 取数组参数。 */
	arr: <T>(key: string) => T[];
	/** 判定目标路径是否在 git 仓库内。 */
	isRepoPath: (target: string) => Promise<boolean>;
	/** 回投一条命令结果。 */
	respond: (payload: Record<string, unknown>) => void;
	/** 回投一条成功结果。 */
	respondResultSync: (cmd: string, payload: Record<string, unknown>) => void;
	/** 回投一条错误结果。 */
	respondError: (cmd: string, fn: () => Promise<unknown>) => Promise<void>;
	/** 执行一条操作并把返回值并入响应；抛错时以 `error` 回投。 */
	respondResult: (cmd: string, fn: () => Record<string, unknown> | Promise<Record<string, unknown>>) => Promise<void>;
	/** 回投 400。 */
	sendBadRequest: (message: string) => void;
}
