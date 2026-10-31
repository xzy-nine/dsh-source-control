/**
 * AI 提交生成与翻译的依赖面：由插件入口注入，未装载时相关命令降级。
 */
export interface AiCommitDeps {
	getLlm?: () => unknown;
	getAgentDefaultModel?: () => unknown;
	/** 取官方 translator 服务；未装载时为 undefined，翻译入口据此降级。 */
	getTranslator?: () => unknown;
}
